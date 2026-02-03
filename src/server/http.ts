#!/usr/bin/env node

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { loadPack, getPacksDirectory, listAvailablePacks } from '../utils/pack-loader.js';
import { validate } from '../validator/index.js';
import { rewrite, rewriteMinimal, rewriteAggressive, formatChanges, aiRewrite, isAIRewriteAvailable, estimateAIRewriteCost } from '../rewriter/index.js';
import { learnVoice, generatePackFiles, isLearnVoiceAvailable } from '../learn/index.js';
import { AIOutputValidator } from './ai-output-validator.js';
import { Pack } from '../schema/index.js';
import { join } from 'path';
import crypto from 'crypto';
import { verifyGitHubWebhookSignature } from './webhooks/verify-github.js';
import {
  createCheckoutSession,
  handleStripeWebhook,
  createPortalSession,
  isBillingEnabled
} from './billing.js';

const app = express();

// Behind nginx in production: respect X-Forwarded-* headers
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security headers (API is proxied; disable CSP to avoid breaking downstream assets)
app.use(helmet({
  contentSecurityPolicy: false,
}));

function requireHttps(req: Request, res: Response, next: NextFunction): void {
  if (process.env.NODE_ENV !== 'production') {
    next();
    return;
  }

  // With trust proxy enabled, req.secure is based on X-Forwarded-Proto
  if (req.secure) {
    next();
    return;
  }

  const host = req.get('host');
  const url = req.originalUrl || '/';

  // Redirect safe methods; reject others (webhooks, etc.)
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.redirect(308, `https://${host}${url}`);
    return;
  }

  res.status(400).json({ error: 'HTTPS required' });
}

app.use(requireHttps);

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.STYLEMCP_API_KEY || '';
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';

// IMPORTANT: Webhook routes with raw body parsing must be registered BEFORE express.json()

// Global rate limiting (defense in depth).
// Note: production nginx can/should also enforce rate limits at the edge.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.API_RATE_LIMIT || 300), // 300 requests / 15 min / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded' },
  skip: (req) => {
    // Don’t double-limit demo (it has its own limiter), and don’t block webhooks/SSE
    return (
      req.path.startsWith('/demo/') ||
      req.path.startsWith('/webhook/') ||
      req.path === '/mcp/sse'
    );
  },
});

app.use('/api', apiLimiter);
// Otherwise the JSON middleware will consume the raw body needed for signature verification

// Stripe webhook endpoint (needs raw body for signature verification)
app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  try {
    const signature = req.headers['stripe-signature'] as string;
    if (!signature) {
      res.status(400).json({ error: 'Missing stripe-signature header' });
      return;
    }

    const result = await handleStripeWebhook(req.body, signature);

    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// GitHub webhook endpoint (needs raw body for signature verification)
app.post('/api/webhook/github', express.raw({ type: 'application/json' }), async (req: Request, res: Response) => {
  try {
    // Verify webhook signature if secret is configured
    if (GITHUB_WEBHOOK_SECRET) {
      const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;
      const body = req.body as Buffer;

      const ok = verifyGitHubWebhookSignature({
        secret: GITHUB_WEBHOOK_SECRET,
        body,
        signatureHeader,
      });

      if (!ok) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    }

    const event = req.headers['x-github-event'] as string;
    const payload = JSON.parse(req.body.toString());

    console.log(`Received GitHub webhook: ${event}`);

    // Handle PR events
    if (event === 'pull_request' && ['opened', 'synchronize'].includes(payload.action)) {
      // TODO: Trigger validation on PR files
      console.log(`PR ${payload.action}: ${payload.pull_request.html_url}`);
    }

    res.json({ received: true, event });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// CORS configuration - restrict origins in production
const PROD_ORIGINS = ['https://stylemcp.com', 'https://www.stylemcp.com'];
const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:5173'];

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : (process.env.NODE_ENV === 'production' ? PROD_ORIGINS : [...DEV_ORIGINS, ...PROD_ORIGINS]);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) return callback(null, true);
    
    if (ALLOWED_ORIGINS.includes(origin) || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      callback(new Error('CORS policy: Origin not allowed'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization'],
}));
app.use(express.json({ limit: '1mb' }));

// Pack cache with warnings tracking
interface CachedPack {
  pack: Pack;
  warnings: string[];
}

const packCache = new Map<string, CachedPack>();

async function getPack(packName: string): Promise<Pack> {
  if (packCache.has(packName)) {
    return packCache.get(packName)!.pack;
  }

  // Security: Validate pack name against whitelist to prevent path traversal
  const availablePacks = await listAvailablePacks();
  if (!availablePacks.includes(packName)) {
    throw new Error(`Pack not found: ${packName}`);
  }

  const packPath = join(getPacksDirectory(), packName);
  const result = await loadPack({ packPath });
  
  // Log warnings for visibility
  if (result.errors.length > 0) {
    console.warn(`[StyleMCP] Pack '${packName}' loaded with warnings:`, result.errors);
  }
  
  packCache.set(packName, { pack: result.pack, warnings: result.errors });
  return result.pack;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function getPackWithWarnings(packName: string): Promise<CachedPack> {
  if (packCache.has(packName)) {
    return packCache.get(packName)!;
  }
  
  await getPack(packName); // This will populate the cache
  return packCache.get(packName)!;
}

// Optional API key authentication with timing-safe comparison
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) {
    // No API key configured, allow all requests
    next();
    return;
  }

  const providedKey = req.headers['x-api-key'] || req.query.api_key;
  if (!providedKey || typeof providedKey !== 'string') {
    res.status(401).json({ error: 'Invalid or missing API key' });
    return;
  }
  
  // Use constant-time comparison to prevent timing attacks
  const providedBuffer = Buffer.from(providedKey);
  const expectedBuffer = Buffer.from(API_KEY);
  
  // Length mismatch handled separately to avoid timing oracle
  if (providedBuffer.length !== expectedBuffer.length || 
      !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    res.status(401).json({ error: 'Invalid or missing API key' });
    return;
  }
  next();
}

// Health check (no auth required)
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', version: '0.1.4' });
});

// Simple in-memory rate limiter for demo endpoint with automatic cleanup
const demoRateLimiter = new Map<string, { count: number; resetAt: number }>();
const DEMO_LIMIT = 10; // 10 requests per hour
const DEMO_WINDOW = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL = 5 * 60 * 1000; // Clean up every 5 minutes

// Periodic cleanup of expired rate limit entries to prevent memory bloat
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [ip, record] of demoRateLimiter) {
    if (record.resetAt < now) {
      demoRateLimiter.delete(ip);
      cleaned++;
    }
  }
  if (cleaned > 0 && process.env.NODE_ENV !== 'production') {
    console.log(`[RateLimit] Cleaned ${cleaned} expired entries, ${demoRateLimiter.size} active`);
  }
}, CLEANUP_INTERVAL).unref(); // unref() allows process to exit cleanly

function checkDemoRateLimit(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let record = demoRateLimiter.get(ip);
  
  if (!record || record.resetAt < now) {
    record = { count: 0, resetAt: now + DEMO_WINDOW };
    demoRateLimiter.set(ip, record);
  }
  
  if (record.count >= DEMO_LIMIT) {
    return { allowed: false, remaining: 0, resetAt: record.resetAt };
  }
  
  record.count++;
  return { allowed: true, remaining: DEMO_LIMIT - record.count, resetAt: record.resetAt };
}

// Public demo endpoint - try without signup (rate limited)
app.post('/api/demo/validate', async (req: Request, res: Response) => {
  try {
    const clientIp = req.headers['x-forwarded-for']?.toString().split(',')[0] || req.socket.remoteAddress || 'unknown';
    const rateLimit = checkDemoRateLimit(clientIp);
    
    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', DEMO_LIMIT);
    res.setHeader('X-RateLimit-Remaining', rateLimit.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(rateLimit.resetAt / 1000));
    
    if (!rateLimit.allowed) {
      res.status(429).json({ 
        error: 'Demo rate limit exceeded',
        message: 'Sign up for free to get 5,000 requests/month',
        resetAt: new Date(rateLimit.resetAt).toISOString(),
      });
      return;
    }
    
    const { text, pack: packName = 'saas' } = req.body;

    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "text" field' });
      return;
    }

    // Limit text length for demo
    if (text.length > 500) {
      res.status(400).json({ 
        error: 'Demo text limited to 500 characters',
        message: 'Sign up for free to validate longer text',
      });
      return;
    }

    const pack = await getPack(packName);
    const result = validate({ pack, text });

    res.json({
      ...result,
      demo: true,
      requestsRemaining: rateLimit.remaining,
      upgradeMessage: 'Sign up free for 5,000 requests/month → stylemcp.com/signup',
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// List available packs
app.get('/api/packs', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const packs = await listAvailablePacks();
    res.json({ packs });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Get pack details
app.get('/api/packs/:pack', authMiddleware, async (req: Request, res: Response) => {
  try {
    const packName = String(req.params.pack);
    const pack = await getPack(packName);
    res.json({
      name: pack.manifest.name,
      version: pack.manifest.version,
      description: pack.manifest.description,
      config: pack.manifest.config,
    });
  } catch (error) {
    res.status(404).json({ error: `Pack not found: ${req.params.pack}` });
  }
});

// Validate text
app.post('/api/validate', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { 
      text, 
      pack: packName = 'saas',
      context,
      channel,
      subject,
      audience,
      contentType,
      useMultiVoice = false
    } = req.body;

    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "text" field' });
      return;
    }

    let selectedPack = packName;
    let voiceContext = context;
    let selectionInfo = null;

    // Use multi-voice context selection if enabled
    if (useMultiVoice) {
      const { VoiceContextManager } = await import('../utils/voice-context.js');
      const voiceManager = new VoiceContextManager();
      
      const selection = await voiceManager.selectVoice(text, {
        channel,
        subject,
        audience,
        contentType,
        preferredPack: packName !== 'saas' ? packName : undefined
      });
      
      selectedPack = selection.packName;
      voiceContext = selection.context;
      selectionInfo = {
        selectedPack: selection.packName,
        detectedContext: selection.context,
        confidence: selection.confidence,
        reason: selection.reason,
        contextualTips: voiceManager.getContextualTips(selection.context)
      };
    }

    const pack = await getPack(selectedPack);
    const result = validate({ pack, text, context: voiceContext });

    // Include voice selection info in response
    const response = selectionInfo ? { ...result, voiceSelection: selectionInfo } : result;
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Batch validate
app.post('/api/validate/batch', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { items, pack: packName = 'saas' } = req.body;

    if (!Array.isArray(items)) {
      res.status(400).json({ error: 'Missing or invalid "items" array' });
      return;
    }

    const invalidIndex = items.findIndex((item: { text?: unknown }) => !item || typeof item.text !== 'string');
    if (invalidIndex !== -1) {
      res.status(400).json({ error: `Invalid item at index ${invalidIndex}: missing or invalid "text"` });
      return;
    }

    if (items.length === 0) {
      res.json({
        averageScore: 100,
        totalItems: 0,
        passedItems: 0,
        results: [],
      });
      return;
    }

    const pack = await getPack(packName);
    const results = items.map((item: { text: string; id?: string; context?: any }) => ({
      id: item.id,
      result: validate({ pack, text: item.text, context: item.context }),
    }));

    const totalScore = results.reduce((sum, r) => sum + r.result.score, 0);
    const avgScore = Math.round(totalScore / results.length);

    res.json({
      averageScore: avgScore,
      totalItems: results.length,
      passedItems: results.filter(r => r.result.valid).length,
      results,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Rewrite text
app.post('/api/rewrite', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { text, pack: packName = 'saas', mode = 'normal', context, useAI = false } = req.body;

    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "text" field' });
      return;
    }

    const pack = await getPack(packName);
    let result;

    const options = { pack, text, context };
    if (mode === 'minimal') {
      result = rewriteMinimal(options);
    } else if (mode === 'aggressive') {
      result = rewriteAggressive(options);
    } else {
      result = rewrite(options);
    }

    // Check if rule-based rewrite made no changes but there are violations
    const hasUnfixedViolations = result.changes.length === 0 && result.score.before < 100;
    
    // If useAI is requested (Pro+ feature) and there are unfixed violations, use AI
    if (useAI && hasUnfixedViolations && isAIRewriteAvailable()) {
      const validation = validate({ pack, text, context });
      
      if (validation.violations.length > 0) {
        const aiResult = await aiRewrite({
          pack,
          text,
          violations: validation.violations,
          context,
        });
        
        // Re-validate the AI-rewritten text
        const afterValidation = validate({ pack, text: aiResult.rewritten, context });
        
        res.json({
          original: text,
          rewritten: aiResult.rewritten,
          changes: [{
            type: 'ai-rewrite' as const,
            original: text,
            replacement: aiResult.rewritten,
            reason: aiResult.explanation,
            position: { start: 0, end: text.length },
          }],
          score: {
            before: validation.score,
            after: afterValidation.score,
          },
          summary: `AI rewrite: ${validation.score} → ${afterValidation.score}`,
          aiUsed: true,
          tokensUsed: aiResult.tokensUsed,
          estimatedCost: estimateAIRewriteCost(aiResult.tokensUsed.input, aiResult.tokensUsed.output),
        });
        return;
      }
    }

    // Return rule-based result (with hint if AI could help)
    const response: Record<string, unknown> = {
      ...result,
      summary: formatChanges(result),
      aiUsed: false,
    };
    
    // Add hint if rule-based made no changes but violations exist
    if (hasUnfixedViolations && !useAI) {
      response.hint = 'Rule-based rewrite could not fix these violations. Use useAI:true for AI-powered fixes (Pro+ feature).';
    }

    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// AI-powered rewrite (requires paid tier)
app.post('/api/rewrite/ai', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { text, pack: packName = 'saas', context } = req.body;

    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "text" field' });
      return;
    }

    // Check if AI rewriting is available
    if (!isAIRewriteAvailable()) {
      res.status(503).json({ 
        error: 'AI rewriting is not configured on this server',
        hint: 'Set ANTHROPIC_API_KEY environment variable to enable AI rewrites'
      });
      return;
    }

    const pack = await getPack(packName);
    
    // First validate to get violations
    const validation = validate({ pack, text, context });

    // If no violations, return original text
    if (validation.violations.length === 0) {
      res.json({
        original: text,
        rewritten: text,
        explanation: 'No violations found - text already matches brand voice',
        score: { before: validation.score, after: validation.score },
        tokensUsed: { input: 0, output: 0 },
        estimatedCost: 0,
      });
      return;
    }

    // Perform AI rewrite
    const result = await aiRewrite({
      pack,
      text,
      violations: validation.violations,
      context,
    });

    // Re-validate the rewritten text
    const afterValidation = validate({ pack, text: result.rewritten, context });

    res.json({
      ...result,
      score: {
        before: validation.score,
        after: afterValidation.score,
      },
      violationsFixed: validation.violations.length,
      estimatedCost: estimateAIRewriteCost(result.tokensUsed.input, result.tokensUsed.output),
    });
  } catch (error) {
    console.error('AI rewrite error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Check AI rewrite availability
app.get('/api/rewrite/ai/status', authMiddleware, (_req: Request, res: Response) => {
  res.json({
    available: isAIRewriteAvailable(),
    model: 'claude-3-5-haiku-20241022',
    pricing: {
      inputPer1M: 0.25,
      outputPer1M: 1.25,
      currency: 'USD',
    },
  });
});

// AI Output Validation - validate AI-generated content for brand compliance
app.post('/api/ai-output/validate', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { content, pack, context, includeRewrite } = req.body;

    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "content" field' });
      return;
    }

    const validator = new AIOutputValidator();
    const result = await validator.validate({
      content,
      pack,
      context,
      includeRewrite: includeRewrite === true
    });

    res.json(result);
  } catch (error) {
    console.error('AI output validation error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Learn My Voice - analyze samples to generate custom style pack (Pro+ feature)
app.post('/api/learn', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { samples, brandName, industry, context } = req.body;

    if (!samples || !Array.isArray(samples) || samples.length === 0) {
      res.status(400).json({ error: 'Missing or invalid "samples" array - provide at least one text sample' });
      return;
    }

    if (!brandName || typeof brandName !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "brandName" field' });
      return;
    }

    // Validate samples
    const validSamples = samples.filter(s => typeof s === 'string' && s.trim().length > 0);
    if (validSamples.length === 0) {
      res.status(400).json({ error: 'No valid text samples provided' });
      return;
    }

    if (!isLearnVoiceAvailable()) {
      res.status(503).json({
        error: 'Voice learning is not configured on this server',
        hint: 'Set ANTHROPIC_API_KEY environment variable to enable voice learning'
      });
      return;
    }

    // Learn voice from samples
    const learned = await learnVoice({
      samples: validSamples,
      brandName,
      industry,
      context,
    });

    // Generate YAML files
    const files = generatePackFiles(learned);

    res.json({
      packName: learned.packName,
      displayName: learned.displayName,
      manifest: learned.manifest,
      voice: learned.voice,
      analysis: learned.analysis,
      files: {
        manifestYaml: files.manifest,
        voiceYaml: files.voice,
      },
    });
  } catch (error) {
    console.error('Learn voice error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Check learn availability
app.get('/api/learn/status', authMiddleware, (_req: Request, res: Response) => {
  res.json({
    available: isLearnVoiceAvailable(),
    model: 'claude-3-5-sonnet-20241022',
    minSamples: 1,
    recommendedSamples: 5,
    maxSamplesPerRequest: 20,
  });
});

// Get voice rules
app.get('/api/packs/:pack/voice', authMiddleware, async (req: Request, res: Response) => {
  try {
    const pack = await getPack(String(req.params.pack));
    const section = req.query.section as string;

    if (section && section !== 'all') {
      res.json((pack.voice as any)[section]);
    } else {
      res.json(pack.voice);
    }
  } catch (error) {
    res.status(404).json({ error: `Pack not found: ${req.params.pack}` });
  }
});

// Get copy patterns
app.get('/api/packs/:pack/patterns', authMiddleware, async (req: Request, res: Response) => {
  try {
    const pack = await getPack(String(req.params.pack));
    const category = req.query.category as string;

    let patterns = pack.copyPatterns.patterns;
    if (category && category !== 'all') {
      patterns = patterns.filter(p => p.category === category);
    }

    res.json({ patterns });
  } catch (error) {
    res.status(404).json({ error: `Pack not found: ${req.params.pack}` });
  }
});

// Get CTA rules
app.get('/api/packs/:pack/ctas', authMiddleware, async (req: Request, res: Response) => {
  try {
    const pack = await getPack(String(req.params.pack));
    res.json({
      guidelines: pack.ctaRules.guidelines,
      categories: pack.ctaRules.categories,
      antiPatterns: pack.ctaRules.antiPatterns,
    });
  } catch (error) {
    res.status(404).json({ error: `Pack not found: ${req.params.pack}` });
  }
});

// Get design tokens
app.get('/api/packs/:pack/tokens', authMiddleware, async (req: Request, res: Response) => {
  try {
    const pack = await getPack(String(req.params.pack));
    const type = req.query.type as string;

    if (type && type !== 'all') {
      res.json((pack.tokens as any)[type]);
    } else {
      res.json(pack.tokens);
    }
  } catch (error) {
    res.status(404).json({ error: `Pack not found: ${req.params.pack}` });
  }
});

// Suggest CTAs
app.post('/api/suggest-ctas', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { context, pack: packName = 'saas' } = req.body;

    if (!context || typeof context !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "context" field' });
      return;
    }

    const pack = await getPack(packName);
    const lowerContext = context.toLowerCase();
    const suggestions: any[] = [];

    for (const category of pack.ctaRules.categories) {
      for (const cta of category.ctas) {
        const matchesContext = cta.context.some(c =>
          c.toLowerCase().includes(lowerContext) || lowerContext.includes(c.toLowerCase())
        );

        if (matchesContext) {
          suggestions.push({
            text: cta.text,
            category: category.name,
            priority: cta.priority,
            contexts: cta.context,
          });
        }
      }
    }

    res.json({
      context,
      suggestions: suggestions.slice(0, 10),
      guidelines: pack.ctaRules.guidelines,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Create Stripe checkout session
// NOTE: This endpoint requires authMiddleware to prevent unauthorized access.
app.post('/api/checkout', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!isBillingEnabled()) {
      res.status(503).json({ error: 'Billing not configured' });
      return;
    }

    // SECURITY: Use authenticated user's ID, not client-provided userId
    const userId = req.user?.id;
    const { tier } = req.body;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    if (!tier) {
      res.status(400).json({ error: 'Missing tier' });
      return;
    }

    if (!['pro', 'team'].includes(tier)) {
      res.status(400).json({ error: 'Invalid tier. Must be "pro" or "team"' });
      return;
    }

    const successUrl = `${req.protocol}://${req.get('host')}/dashboard.html?checkout=success`;
    const cancelUrl = `${req.protocol}://${req.get('host')}/pricing.html?checkout=cancelled`;

    const checkoutUrl = await createCheckoutSession(userId, tier, successUrl, cancelUrl);

    if (!checkoutUrl) {
      res.status(500).json({ error: 'Failed to create checkout session' });
      return;
    }

    res.json({ url: checkoutUrl });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Create Stripe customer portal session
// NOTE: This endpoint requires authMiddleware to prevent unauthorized access.
app.post('/api/billing/portal', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!isBillingEnabled()) {
      res.status(503).json({ error: 'Billing not configured' });
      return;
    }

    // SECURITY: Use authenticated user's ID, not client-provided userId
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const returnUrl = `${req.protocol}://${req.get('host')}/dashboard.html`;
    const portalUrl = await createPortalSession(userId, returnUrl);

    if (!portalUrl) {
      res.status(500).json({ error: 'Failed to create portal session. User may not have an active subscription.' });
      return;
    }

    res.json({ url: portalUrl });
  } catch (error) {
    console.error('Portal error:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// Voice learning endpoint - analyze samples and generate pack
app.post('/api/learn/analyze', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { samples, packName, method = 'rule-based' } = req.body;
    
    if (!samples || !Array.isArray(samples) || samples.length === 0) {
      res.status(400).json({ error: 'samples array is required with at least one item' });
      return;
    }
    
    if (!packName || typeof packName !== 'string') {
      res.status(400).json({ error: 'packName is required' });
      return;
    }
    
    // Validate pack name (prevent path traversal)
    if (!/^[a-z0-9-]+$/.test(packName)) {
      res.status(400).json({ error: 'packName must contain only lowercase letters, numbers, and hyphens' });
      return;
    }
    
    if (method === 'ai') {
      // Use AI-based analysis
      const { learnVoice } = await import('../learn/index.js');
      const result = await learnVoice({
        samples: samples.map((s: any) => typeof s === 'string' ? s : s.text),
        brandName: packName,
        industry: req.body.industry,
        context: req.body.context
      });
      
      res.json({
        method: 'ai',
        packName: result.packName,
        analysis: result.analysis,
        voice: result.voice,
        recommendations: [`Generated with ${result.analysis.confidence * 100}% confidence from ${result.analysis.samplesAnalyzed} samples`]
      });
    } else {
      // Use rule-based analysis  
      const { VoiceAnalyzer } = await import('../learn/voice-analyzer.js');
      const analyzer = new VoiceAnalyzer();
      
      const voiceSamples = samples.map((s: any) => ({
        text: typeof s === 'string' ? s : s.text,
        source: typeof s === 'object' ? s.source : undefined,
        context: typeof s === 'object' ? s.context : undefined
      }));
      
      const result = await analyzer.analyze(voiceSamples);
      
      res.json({
        method: 'rule-based',
        packName,
        analysis: {
          confidence: result.confidence,
          sampleCount: result.sampleCount
        },
        voice: result.profile,
        recommendations: result.recommendations
      });
    }
  } catch (error) {
    console.error('Voice learning error:', error);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Voice learning failed' 
    });
  }
});

// Generate pack files from analysis
app.post('/api/learn/generate', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { packName, analysis, method = 'rule-based' } = req.body;
    
    if (!packName || !analysis) {
      res.status(400).json({ error: 'packName and analysis are required' });
      return;
    }
    
    // Validate pack name
    if (!/^[a-z0-9-]+$/.test(packName)) {
      res.status(400).json({ error: 'packName must contain only lowercase letters, numbers, and hyphens' });
      return;
    }
    
    if (method === 'ai') {
      // Generate using AI analysis format
      const { generatePackFiles } = await import('../learn/index.js');
      const files = generatePackFiles({
        packName,
        displayName: packName,
        manifest: {
          name: packName,
          version: '1.0.0',
          description: `Custom style pack for ${packName}`,
          industry: 'general'
        },
        voice: analysis.voice,
        analysis: analysis.analysis || { samplesAnalyzed: 0, totalWords: 0, tokensUsed: { input: 0, output: 0 }, confidence: 0.7 }
      });
      
      res.json({
        packName,
        files: {
          'manifest.yaml': files.manifest,
          'voice.yaml': files.voice
        },
        generated: true
      });
    } else {
      // Generate using rule-based format
      const { VoiceAnalyzer } = await import('../learn/voice-analyzer.js');
      const analyzer = new VoiceAnalyzer();
      
      // Create mock samples for pack generation
      const mockSamples = [{ text: 'Sample text', source: 'generated' }];
      
      await analyzer.generatePack({
        samples: mockSamples,
        packName,
        outputPath: undefined // Will use default path
      });
      
      res.json({
        packName,
        generated: true,
        message: `Pack '${packName}' generated successfully`
      });
    }
  } catch (error) {
    console.error('Pack generation error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Pack generation failed'
    });
  }
});

// Streaming validation for real-time feedback
app.post('/api/validate/stream', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { 
      text, 
      pack: packName = 'saas',
      context,
      useMultiVoice = false
    } = req.body;

    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial event
    res.write(`data: ${JSON.stringify({ type: 'start', message: 'Starting validation...' })}\n\n`);

    let selectedPack = packName;
    let voiceContext = context;

    // Multi-voice selection with progress
    if (useMultiVoice) {
      res.write(`data: ${JSON.stringify({ type: 'progress', message: 'Analyzing context...' })}\n\n`);
      
      const { VoiceContextManager } = await import('../utils/voice-context.js');
      const voiceManager = new VoiceContextManager();
      
      const selection = await voiceManager.selectVoice(text, {});
      selectedPack = selection.packName;
      voiceContext = selection.context;

      res.write(`data: ${JSON.stringify({ 
        type: 'voice-selected', 
        selectedPack: selection.packName,
        context: selection.context,
        confidence: selection.confidence,
        reason: selection.reason
      })}\n\n`);
    }

    // Load pack with progress
    res.write(`data: ${JSON.stringify({ type: 'progress', message: 'Loading style pack...' })}\n\n`);
    
    const pack = await getPack(selectedPack);

    // Validate with progress
    res.write(`data: ${JSON.stringify({ type: 'progress', message: 'Validating content...' })}\n\n`);
    
    const result = validate({ pack, text, context: voiceContext });

    // Send final result
    res.write(`data: ${JSON.stringify({ 
      type: 'complete', 
      result: result,
      pack: selectedPack,
      context: voiceContext
    })}\n\n`);

    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ 
      type: 'error', 
      error: error instanceof Error ? error.message : 'Validation failed' 
    })}\n\n`);
    res.end();
  }
});

// Multi-voice context management endpoints
app.get('/api/voices/contexts', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { VoiceContextManager } = await import('../utils/voice-context.js');
    const voiceManager = new VoiceContextManager();
    
    const mappings = voiceManager.listContextMappings();
    const availablePacks = await listAvailablePacks();
    
    res.json({
      contextMappings: mappings,
      availablePacks,
      config: voiceManager.getConfig()
    });
  } catch (error) {
    console.error('Voice context listing error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to list voice contexts'
    });
  }
});

app.post('/api/voices/contexts', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { context, packName, description } = req.body;
    
    if (!context || !packName) {
      res.status(400).json({ error: 'context and packName are required' });
      return;
    }
    
    // Validate pack exists
    const availablePacks = await listAvailablePacks();
    if (!availablePacks.includes(packName)) {
      res.status(400).json({ error: `Pack '${packName}' not found` });
      return;
    }
    
    const { VoiceContextManager } = await import('../utils/voice-context.js');
    const voiceManager = new VoiceContextManager();
    
    voiceManager.addContextVoice({ context, packName, description });
    
    res.json({
      success: true,
      message: `Context '${context}' mapped to pack '${packName}'`,
      mapping: { context, packName, description }
    });
  } catch (error) {
    console.error('Voice context add error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to add voice context'
    });
  }
});

app.delete('/api/voices/contexts/:context', authMiddleware, async (req: Request, res: Response) => {
  try {
    const context = req.params.context;
    
    const { VoiceContextManager } = await import('../utils/voice-context.js');
    const voiceManager = new VoiceContextManager();
    
    voiceManager.removeContextVoice(context as any);
    
    res.json({
      success: true,
      message: `Context '${context}' removed`
    });
  } catch (error) {
    console.error('Voice context removal error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to remove voice context'
    });
  }
});

// Detect context from text (useful for testing)
app.post('/api/voices/detect', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { text, channel, subject, audience, contentType } = req.body;
    
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    
    const { VoiceContextManager } = await import('../utils/voice-context.js');
    const voiceManager = new VoiceContextManager();
    
    const selection = await voiceManager.selectVoice(text, {
      channel,
      subject,
      audience,
      contentType
    });
    
    res.json({
      detectedContext: selection.context,
      selectedPack: selection.packName,
      confidence: selection.confidence,
      reason: selection.reason,
      contextualTips: voiceManager.getContextualTips(selection.context)
    });
  } catch (error) {
    console.error('Context detection error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Context detection failed'
    });
  }
});

// SSE endpoint for MCP over HTTP
app.get('/api/mcp/sse', authMiddleware, (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', version: '0.1.4' })}\n\n`);

  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

// MCP tool call endpoint (for SSE-based MCP)
app.post('/api/mcp/call', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { tool, arguments: args } = req.body;

    if (!tool) {
      res.status(400).json({ error: 'Missing "tool" field' });
      return;
    }

    // Route to appropriate handler
    switch (tool) {
      case 'validate_text': {
        if (!args || typeof args.text !== 'string') {
          res.status(400).json({ error: 'Missing or invalid "text" field' });
          return;
        }
        const pack = await getPack(args?.pack || 'saas');
        const result = validate({
          pack,
          text: args?.text,
          context: args?.context_type ? { type: args.context_type } : undefined,
        });
        res.json({ result });
        break;
      }

      case 'rewrite_to_style': {
        if (!args || typeof args.text !== 'string') {
          res.status(400).json({ error: 'Missing or invalid "text" field' });
          return;
        }
        const pack = await getPack(args?.pack || 'saas');
        const mode = args?.mode || 'normal';
        const options = {
          pack,
          text: args?.text,
          context: args?.context_type ? { type: args.context_type } : undefined,
        };

        let result;
        if (mode === 'minimal') {
          result = rewriteMinimal(options);
        } else if (mode === 'aggressive') {
          result = rewriteAggressive(options);
        } else {
          result = rewrite(options);
        }

        res.json({ result: { ...result, summary: formatChanges(result) } });
        break;
      }

      case 'get_voice_rules': {
        const pack = await getPack(args?.pack || 'saas');
        const section = args?.section || 'all';
        const data = section === 'all' ? pack.voice : (pack.voice as any)[section];
        res.json({ result: data });
        break;
      }

      case 'get_copy_patterns': {
        const pack = await getPack(args?.pack || 'saas');
        let patterns = pack.copyPatterns.patterns;
        if (args?.category && args.category !== 'all') {
          patterns = patterns.filter(p => p.category === args.category);
        }
        res.json({ result: patterns });
        break;
      }

      case 'get_cta_rules': {
        const pack = await getPack(args?.pack || 'saas');
        res.json({
          result: {
            guidelines: pack.ctaRules.guidelines,
            categories: pack.ctaRules.categories,
            antiPatterns: pack.ctaRules.antiPatterns,
          },
        });
        break;
      }

      case 'get_tokens': {
        const pack = await getPack(args?.pack || 'saas');
        const type = args?.type || 'all';
        const data = type === 'all' ? pack.tokens : (pack.tokens as any)[type];
        res.json({ result: data });
        break;
      }

      case 'list_packs': {
        const packs = await listAvailablePacks();
        res.json({ result: { available_packs: packs } });
        break;
      }

      default:
        res.status(400).json({ error: `Unknown tool: ${tool}` });
    }
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Simple analytics endpoint - basic usage tracking
app.get('/api/analytics/usage', authMiddleware, async (_req: Request, res: Response) => {
  try {
    // Return basic usage statistics
    // In a real implementation, this would query a database
    const mockStats = {
      totalValidations: 1247,
      averageScore: 84,
      topPacks: [
        { name: 'saas', usage: 45 },
        { name: 'healthcare', usage: 23 },
        { name: 'finance', usage: 18 },
        { name: 'ecommerce', usage: 14 }
      ],
      topViolations: [
        { type: 'tone', count: 127 },
        { type: 'vocabulary', count: 89 },
        { type: 'clarity', count: 67 }
      ],
      dailyTrend: [78, 82, 79, 84, 88, 85, 87], // Last 7 days average scores
      lastUpdated: new Date().toISOString()
    };
    
    res.json(mockStats);
  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Start server
export function startServer(port?: number): void {
  const listenPort = port || PORT;
  app.listen(listenPort, () => {
    console.log(`StyleMCP HTTP server running on port ${listenPort}`);
    console.log(`  Health: http://localhost:${listenPort}/health`);
    console.log(`  API:    http://localhost:${listenPort}/api/validate`);
    console.log(`  MCP:    http://localhost:${listenPort}/api/mcp/sse`);
    if (API_KEY) {
      console.log(`  Auth:   API key required (X-Api-Key header)`);
    } else {
      console.log(`  Auth:   None (set STYLEMCP_API_KEY to enable)`);
    }
  });
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}

export default app;
