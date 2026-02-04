#!/usr/bin/env node

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { loadPack, getPacksDirectory, listAvailablePacks } from '../utils/pack-loader.js';
import { validate } from '../validator/index.js';
import { rewrite, rewriteMinimal, rewriteAggressive, formatChanges, aiRewrite, isAIRewriteAvailable, estimateAIRewriteCost } from '../rewriter/index.js';
import { learnVoice, generatePackFiles, isLearnVoiceAvailable } from '../learn/index.js';
import type { LearnedVoice } from '../learn/index.js';
import type { VoiceSample } from '../learn/voice-analyzer.js';
import { AIOutputValidator } from './ai-output-validator.js';
import { Pack } from '../schema/index.js';
import { join } from 'path';
import { verifyGitHubWebhookSignature } from './webhooks/verify-github.js';
import {
  createCheckoutSession,
  handleStripeWebhook,
  createPortalSession,
  isBillingEnabled,
  tierHasAIAccess
} from './billing.js';
import type { VoiceContext } from '../utils/voice-context.js';
// FIXED: Import proper billing-aware auth middleware
import { authMiddleware as authMiddleware, usageLogger } from './middleware/auth.js';

const app = express();

// Behind nginx in production: respect X-Forwarded-* headers
const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback';
app.set('trust proxy', TRUST_PROXY);
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

  // Prefer explicit proxy signal over req.secure (which can be finicky across proxy configs)
  const xfProtoRaw = req.headers['x-forwarded-proto'];
  const xfProto = Array.isArray(xfProtoRaw) ? xfProtoRaw[0] : xfProtoRaw;
  if (typeof xfProto === 'string' && xfProto.split(',')[0].trim().toLowerCase() === 'https') {
    next();
    return;
  }

  if (req.secure) {
    next();
    return;
  }

  const xfHostRaw = req.headers['x-forwarded-host'];
  const xfHost = Array.isArray(xfHostRaw) ? xfHostRaw[0] : xfHostRaw;
  const host = (typeof xfHost === 'string' && xfHost.length > 0) ? xfHost : req.get('host');
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

const MAX_TEXT_LENGTH = Number.parseInt(process.env.MAX_TEXT_LENGTH || '20000', 10);
const MAX_CONTEXT_LENGTH = Number.parseInt(process.env.MAX_CONTEXT_LENGTH || '4000', 10);
const MAX_SAMPLES_PER_REQUEST = Number.parseInt(process.env.MAX_SAMPLES_PER_REQUEST || '20', 10);
const MAX_BATCH_ITEMS = Number.parseInt(process.env.MAX_BATCH_ITEMS || '50', 10);
const MAX_PACK_NAME_LENGTH = Number.parseInt(process.env.MAX_PACK_NAME_LENGTH || '64', 10);
const PACK_WRITE_TIERS = (process.env.PACK_WRITE_TIERS || 'team,business,enterprise')
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);
const PACK_OVERWRITE_TIERS = (process.env.PACK_OVERWRITE_TIERS || 'business,enterprise')
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);

function sanitizeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function sanitizeOptionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  return trimmed;
}

function sanitizePackName(value: unknown, fallback?: string): string | null {
  if (typeof value !== 'string') return fallback ?? null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PACK_NAME_LENGTH) return fallback ?? null;
  return trimmed;
}

function sanitizeValidationContext(value: unknown): { type?: 'ui-copy' | 'marketing' | 'docs' | 'support' | 'general'; component?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const context = value as { type?: unknown; component?: unknown };
  const type = typeof context.type === 'string' ? context.type : undefined;
  const component = sanitizeOptionalString(context.component, 200);
  if (type && ['ui-copy', 'marketing', 'docs', 'support', 'general'].includes(type)) {
    return { type: type as 'ui-copy' | 'marketing' | 'docs' | 'support' | 'general', component };
  }
  return component ? { component } : undefined;
}

function sanitizeVoiceSampleContext(value: unknown): VoiceSample['context'] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['email', 'blog', 'social', 'marketing', 'support', 'other'].includes(normalized)) {
    return normalized as VoiceSample['context'];
  }
  return undefined;
}

function isVoiceContext(value: string): value is VoiceContext {
  return ['email', 'blog', 'social', 'marketing', 'support', 'legal', 'internal', 'product', 'sales'].includes(value);
}

function logError(context: string, error: unknown, req?: Request): void {
  const message = error instanceof Error ? error.message : String(error);
  const meta = req ? `${req.method} ${req.originalUrl}` : 'no-request';
  console.error(`[StyleMCP] ${context} (${meta}): ${message}`);
}

function enforceAIAccess(req: Request, res: Response): boolean {
  if (!isBillingEnabled()) return true;
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  if (!tierHasAIAccess(req.user.tier)) {
    res.status(403).json({
      error: 'AI features require Pro tier or higher',
      upgrade_url: 'https://stylemcp.com/pricing'
    });
    return false;
  }
  return true;
}

async function enforcePackWriteAccess(req: Request, res: Response, packName: string, allowOverwrite: boolean): Promise<boolean> {
  if (!isBillingEnabled()) {
    return true;
  }
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  if (!PACK_WRITE_TIERS.includes(req.user.tier)) {
    res.status(403).json({ error: 'Pack write access requires Team tier or higher' });
    return false;
  }
  const availablePacks = await listAvailablePacks();
  if (availablePacks.includes(packName) && !allowOverwrite) {
    res.status(409).json({ error: `Pack '${packName}' already exists` });
    return false;
  }
  if (availablePacks.includes(packName) && allowOverwrite && !PACK_OVERWRITE_TIERS.includes(req.user.tier)) {
    res.status(403).json({ error: 'Overwriting packs requires Business tier or higher' });
    return false;
  }
  return true;
}

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
app.use(usageLogger);

// Pack loading
// NOTE: Do NOT cache packs indefinitely at the server layer.
// `loadPack()` already provides a TTL+invalidation cache, and we want pack edits
// (especially writes via Learn/Generate) to show up without restarting the API.
async function getPackWithWarnings(
  packName: string,
  opts?: { noCache?: boolean }
): Promise<{ pack: Pack; warnings: string[] }> {
  // Security: validate pack name against whitelist to prevent path traversal
  const availablePacks = await listAvailablePacks();
  if (!availablePacks.includes(packName)) {
    throw new Error(`Pack not found: ${packName}`);
  }

  const packPath = join(getPacksDirectory(), packName);
  const result = await loadPack({ packPath, noCache: opts?.noCache === true });

  // Log warnings for visibility
  if (result.errors.length > 0) {
    console.warn(`[StyleMCP] Pack '${packName}' loaded with warnings:`, result.errors);
  }

  return { pack: result.pack, warnings: result.errors };
}

// Optional API key authentication with timing-safe comparison
// FIXED: Proxy-aware base URL construction
function getBaseUrl(req: Request): string {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${protocol}://${host}`;
}
// legacyAuthMiddleware removed (replaced by billing-aware auth middleware)

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

// Input limits (defense in depth)
// MAX_TEXT_LENGTH is the canonical limit; MAX_TEXT_CHARS is a backwards-compatible alias.
const MAX_TEXT_CHARS = Number(process.env.MAX_TEXT_CHARS || MAX_TEXT_LENGTH);

function enforceMaxLen(args: {
  value: string;
  field: string;
  max: number;
  res: Response;
}): boolean {
  const { value, field, max, res } = args;
  if (value.length > max) {
    res.status(400).json({ error: `${field} too long (max ${max} characters)` });
    return false;
  }
  return true;
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
    
    const text = sanitizeString(req.body?.text, 500);
    const packName = sanitizePackName(req.body?.pack, 'saas');

    if (!text) {
      res.status(400).json({ error: 'Missing or invalid "text" field' });
      return;
    }

    if (!packName) {
      res.status(400).json({ error: 'Missing or invalid "pack" field' });
      return;
    }

    const { pack, warnings } = await getPackWithWarnings(packName, {
      noCache: req.query.noCache === '1',
    });
    const result = validate({ pack, text });

    const response: Record<string, unknown> = {
      ...result,
      demo: true,
      requestsRemaining: rateLimit.remaining,
      upgradeMessage: 'Sign up free for 5,000 requests/month → stylemcp.com/signup',
    };
    if (warnings.length > 0) {
      response.packWarnings = warnings;
    }

    res.json(response);
  } catch (error) {
    logError('Demo validation failed', error, req);
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
    const packName = sanitizePackName(req.params.pack);
    if (!packName) {
      res.status(400).json({ error: 'Invalid pack name' });
      return;
    }
    const { pack, warnings } = await getPackWithWarnings(packName);
    const response: Record<string, unknown> = {
      name: pack.manifest.name,
      version: pack.manifest.version,
      description: pack.manifest.description,
      config: pack.manifest.config,
    };
    if (warnings.length > 0) {
      response.packWarnings = warnings;
    }
    res.json(response);
  } catch (error) {
    logError('Pack details failed', error, req);
    res.status(404).json({ error: `Pack not found: ${req.params.pack}` });
  }
});

// Validate text
app.post('/api/validate', authMiddleware, async (req: Request, res: Response) => {
  try {
    const text = sanitizeString(req.body?.text, MAX_TEXT_LENGTH);
    const packName = sanitizePackName(req.body?.pack, 'saas');
    const context = sanitizeValidationContext(req.body?.context);
    const channel = sanitizeOptionalString(req.body?.channel, MAX_CONTEXT_LENGTH);
    const subject = sanitizeOptionalString(req.body?.subject, MAX_CONTEXT_LENGTH);
    const audience = sanitizeOptionalString(req.body?.audience, MAX_CONTEXT_LENGTH);
    const contentType = sanitizeOptionalString(req.body?.contentType, MAX_CONTEXT_LENGTH);
    const useMultiVoice = req.body?.useMultiVoice === true;

    if (!text) {
      res.status(400).json({ error: 'Missing or invalid "text" field' });
      return;
    }
    if (!packName) {
      res.status(400).json({ error: 'Missing or invalid "pack" field' });
      return;
    }

    if (!enforceMaxLen({ value: text, field: 'text', max: MAX_TEXT_CHARS, res })) {
      return;
    }

    let selectedPack = packName;
    const validationContext = context;
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
      selectionInfo = {
        selectedPack: selection.packName,
        detectedContext: selection.context,
        confidence: selection.confidence,
        reason: selection.reason,
        contextualTips: voiceManager.getContextualTips(selection.context)
      };
    }

    const { pack, warnings } = await getPackWithWarnings(selectedPack);
    const result = validate({ pack, text, context: validationContext });

    // Include voice selection info in response
    const response: Record<string, unknown> = selectionInfo ? { ...result, voiceSelection: selectionInfo } : result;
    if (warnings.length > 0) {
      response.packWarnings = warnings;
    }
    res.json(response);
  } catch (error) {
    logError('Validation failed', error, req);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Batch validate
app.post('/api/validate/batch', authMiddleware, async (req: Request, res: Response) => {
  try {
    const items = req.body?.items as Array<{ text?: unknown; id?: unknown; context?: unknown }> | undefined;
    const packName = sanitizePackName(req.body?.pack, 'saas');

    if (!Array.isArray(items)) {
      res.status(400).json({ error: 'Missing or invalid "items" array' });
      return;
    }
    if (!packName) {
      res.status(400).json({ error: 'Missing or invalid "pack" field' });
      return;
    }
    if (items.length > MAX_BATCH_ITEMS) {
      res.status(400).json({ error: `Too many items (max ${MAX_BATCH_ITEMS})` });
      return;
    }

    const invalidIndex = items.findIndex((item) => !item || typeof item.text !== 'string' || (item.text as string).trim().length === 0);
    if (invalidIndex !== -1) {
      res.status(400).json({ error: `Invalid item at index ${invalidIndex}: missing or invalid "text"` });
      return;
    }

    const tooLongIndex = items.findIndex((item: { text?: unknown }) => typeof item?.text === 'string' && item.text.length > MAX_TEXT_CHARS);
    if (tooLongIndex !== -1) {
      res.status(400).json({ error: `Item at index ${tooLongIndex} exceeds max length (${MAX_TEXT_CHARS} characters)` });
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

    const { pack, warnings } = await getPackWithWarnings(packName);
    const results = items.map((item) => ({
      id: typeof item.id === 'string' ? item.id : undefined,
      result: validate({
        pack,
        text: String(item.text),
        context: sanitizeValidationContext(item.context),
      }),
    }));

    const totalScore = results.reduce((sum, r) => sum + r.result.score, 0);
    const avgScore = Math.round(totalScore / results.length);

    const response: Record<string, unknown> = {
      averageScore: avgScore,
      totalItems: results.length,
      passedItems: results.filter(r => r.result.valid).length,
      results,
    };
    if (warnings.length > 0) {
      response.packWarnings = warnings;
    }
    res.json(response);
  } catch (error) {
    logError('Batch validation failed', error, req);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Rewrite text
app.post('/api/rewrite', authMiddleware, async (req: Request, res: Response) => {
  try {
    const text = sanitizeString(req.body?.text, MAX_TEXT_LENGTH);
    const packName = sanitizePackName(req.body?.pack, 'saas');
    const mode = sanitizeOptionalString(req.body?.mode, 20) || 'normal';
    const context = sanitizeValidationContext(req.body?.context);
    const useAI = req.body?.useAI === true;

    if (!text) {
      res.status(400).json({ error: 'Missing or invalid "text" field' });
      return;
    }
    if (!packName) {
      res.status(400).json({ error: 'Missing or invalid "pack" field' });
      return;
    }
    if (!['normal', 'minimal', 'aggressive'].includes(mode)) {
      res.status(400).json({ error: 'Invalid "mode" field' });
      return;
    }
    if (useAI && !enforceAIAccess(req, res)) {
      return;
    }

    if (!enforceMaxLen({ value: text, field: 'text', max: MAX_TEXT_CHARS, res })) {
      return;
    }

    const { pack, warnings } = await getPackWithWarnings(packName);
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
        
        const response: Record<string, unknown> = {
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
        };
        if (warnings.length > 0) {
          response.packWarnings = warnings;
        }
        res.json(response);
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

    if (warnings.length > 0) {
      response.packWarnings = warnings;
    }
    res.json(response);
  } catch (error) {
    logError('Rewrite failed', error, req);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// AI-powered rewrite (requires paid tier)
app.post('/api/rewrite/ai', authMiddleware, async (req: Request, res: Response) => {
  try {
    const text = sanitizeString(req.body?.text, MAX_TEXT_LENGTH);
    const packName = sanitizePackName(req.body?.pack, 'saas');
    const context = sanitizeValidationContext(req.body?.context);

    if (!text) {
      res.status(400).json({ error: 'Missing or invalid "text" field' });
      return;
    }
    if (!packName) {
      res.status(400).json({ error: 'Missing or invalid "pack" field' });
      return;
    }
    if (!enforceAIAccess(req, res)) {
      return;
    }

    if (!enforceMaxLen({ value: text, field: 'text', max: MAX_TEXT_CHARS, res })) {
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

    const { pack, warnings } = await getPackWithWarnings(packName);
    
    // First validate to get violations
    const validation = validate({ pack, text, context });

    // If no violations, return original text
    if (validation.violations.length === 0) {
      const response: Record<string, unknown> = {
        original: text,
        rewritten: text,
        explanation: 'No violations found - text already matches brand voice',
        score: { before: validation.score, after: validation.score },
        tokensUsed: { input: 0, output: 0 },
        estimatedCost: 0,
      };
      if (warnings.length > 0) {
        response.packWarnings = warnings;
      }
      res.json(response);
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

    const response: Record<string, unknown> = {
      ...result,
      score: {
        before: validation.score,
        after: afterValidation.score,
      },
      violationsFixed: validation.violations.length,
      estimatedCost: estimateAIRewriteCost(result.tokensUsed.input, result.tokensUsed.output),
    };
    if (warnings.length > 0) {
      response.packWarnings = warnings;
    }
    res.json(response);
  } catch (error) {
    logError('AI rewrite failed', error, req);
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
    const content = sanitizeString(req.body?.content, MAX_TEXT_LENGTH);
    const pack = sanitizePackName(req.body?.pack);
    const context = req.body?.context && typeof req.body.context === 'object' ? req.body.context : undefined;
    const includeRewrite = req.body?.includeRewrite === true;

    if (!content) {
      res.status(400).json({ error: 'Missing or invalid "content" field' });
      return;
    }
    if (pack === null) {
      res.status(400).json({ error: 'Invalid "pack" field' });
      return;
    }
    if (!enforceAIAccess(req, res)) {
      return;
    }

    if (!enforceMaxLen({ value: content, field: 'content', max: MAX_TEXT_CHARS, res })) {
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
    logError('AI output validation failed', error, req);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Learn My Voice - analyze samples to generate custom style pack (Pro+ feature)
app.post('/api/learn', authMiddleware, async (req: Request, res: Response) => {
  try {
    const samples = Array.isArray(req.body?.samples) ? (req.body.samples as Array<unknown>) : null;
    const brandName = sanitizeString(req.body?.brandName, 100);
    const industry = sanitizeOptionalString(req.body?.industry, 100);
    const context = sanitizeOptionalString(req.body?.context, MAX_CONTEXT_LENGTH);

    if (!samples || samples.length === 0) {
      res.status(400).json({ error: 'Missing or invalid "samples" array - provide at least one text sample' });
      return;
    }

    if (!brandName) {
      res.status(400).json({ error: 'Missing or invalid "brandName" field' });
      return;
    }
    if (samples.length > MAX_SAMPLES_PER_REQUEST) {
      res.status(400).json({ error: `Too many samples (max ${MAX_SAMPLES_PER_REQUEST})` });
      return;
    }
    if (!enforceAIAccess(req, res)) {
      return;
    }

    // Validate samples
    const trimmedSamples = samples
      .filter((s: unknown) => typeof s === 'string')
      .map((s: string) => s.trim())
      .filter((s: string) => s.length > 0);

    const sampleTooLongIndex = trimmedSamples.findIndex(s => s.length > MAX_TEXT_CHARS);
    if (sampleTooLongIndex !== -1) {
      res.status(400).json({ error: `Sample at index ${sampleTooLongIndex} exceeds max length (${MAX_TEXT_CHARS} characters)` });
      return;
    }

    const validSamples = trimmedSamples;
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
    logError('Learn voice failed', error, req);
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
    const packName = sanitizePackName(req.params.pack);
    const section = sanitizeOptionalString(req.query.section, 50);
    if (!packName) {
      res.status(400).json({ error: 'Invalid pack name' });
      return;
    }
    const { pack, warnings } = await getPackWithWarnings(packName);
    if (section && section !== 'all') {
      const voice = pack.voice as Record<string, unknown>;
      if (warnings.length > 0) {
        res.setHeader('X-Pack-Warnings', warnings.join(' | '));
      }
      res.json(voice[section]);
    } else {
      if (warnings.length > 0) {
        res.setHeader('X-Pack-Warnings', warnings.join(' | '));
      }
      res.json(pack.voice);
    }
  } catch (error) {
    logError('Pack voice failed', error, req);
    res.status(404).json({ error: `Pack not found: ${req.params.pack}` });
  }
});

// Get copy patterns
app.get('/api/packs/:pack/patterns', authMiddleware, async (req: Request, res: Response) => {
  try {
    const packName = sanitizePackName(req.params.pack);
    const category = sanitizeOptionalString(req.query.category, 50);
    if (!packName) {
      res.status(400).json({ error: 'Invalid pack name' });
      return;
    }
    const { pack, warnings } = await getPackWithWarnings(packName);

    let patterns = pack.copyPatterns.patterns;
    if (category && category !== 'all') {
      patterns = patterns.filter(p => p.category === category);
    }

    const response: Record<string, unknown> = { patterns };
    if (warnings.length > 0) {
      response.packWarnings = warnings;
    }
    res.json(response);
  } catch (error) {
    logError('Pack patterns failed', error, req);
    res.status(404).json({ error: `Pack not found: ${req.params.pack}` });
  }
});

// Get CTA rules
app.get('/api/packs/:pack/ctas', authMiddleware, async (req: Request, res: Response) => {
  try {
    const packName = sanitizePackName(req.params.pack);
    if (!packName) {
      res.status(400).json({ error: 'Invalid pack name' });
      return;
    }
    const { pack, warnings } = await getPackWithWarnings(packName);
    const response: Record<string, unknown> = {
      guidelines: pack.ctaRules.guidelines,
      categories: pack.ctaRules.categories,
      antiPatterns: pack.ctaRules.antiPatterns,
    };
    if (warnings.length > 0) {
      response.packWarnings = warnings;
    }
    res.json(response);
  } catch (error) {
    logError('Pack ctas failed', error, req);
    res.status(404).json({ error: `Pack not found: ${req.params.pack}` });
  }
});

// Get design tokens
app.get('/api/packs/:pack/tokens', authMiddleware, async (req: Request, res: Response) => {
  try {
    const packName = sanitizePackName(req.params.pack);
    const type = sanitizeOptionalString(req.query.type, 50);
    if (!packName) {
      res.status(400).json({ error: 'Invalid pack name' });
      return;
    }
    const { pack, warnings } = await getPackWithWarnings(packName);
    if (type && type !== 'all') {
      const tokens = pack.tokens as Record<string, unknown>;
      if (warnings.length > 0) {
        res.setHeader('X-Pack-Warnings', warnings.join(' | '));
      }
      res.json(tokens[type]);
    } else {
      if (warnings.length > 0) {
        res.setHeader('X-Pack-Warnings', warnings.join(' | '));
      }
      res.json(pack.tokens);
    }
  } catch (error) {
    logError('Pack tokens failed', error, req);
    res.status(404).json({ error: `Pack not found: ${req.params.pack}` });
  }
});

// Suggest CTAs
app.post('/api/suggest-ctas', authMiddleware, async (req: Request, res: Response) => {
  try {
    const context = sanitizeString(req.body?.context, MAX_CONTEXT_LENGTH);
    const packName = sanitizePackName(req.body?.pack, 'saas');

    if (!context) {
      res.status(400).json({ error: 'Missing or invalid "context" field' });
      return;
    }
    if (!packName) {
      res.status(400).json({ error: 'Missing or invalid "pack" field' });
      return;
    }

    const { pack, warnings } = await getPackWithWarnings(packName);
    const lowerContext = context.toLowerCase();
    const suggestions: Array<{ text: string; category: string; priority: string; contexts: string[] }> = [];

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

    const response: Record<string, unknown> = {
      context,
      suggestions: suggestions.slice(0, 10),
      guidelines: pack.ctaRules.guidelines,
    };
    if (warnings.length > 0) {
      response.packWarnings = warnings;
    }
    res.json(response);
  } catch (error) {
    logError('CTA suggestions failed', error, req);
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

    const successUrl = `${getBaseUrl(req)}/dashboard.html?checkout=success`;
    const cancelUrl = `${getBaseUrl(req)}/pricing.html?checkout=cancelled`;

    const checkoutUrl = await createCheckoutSession(userId, tier, successUrl, cancelUrl);

    if (!checkoutUrl) {
      res.status(500).json({ error: 'Failed to create checkout session' });
      return;
    }

    res.json({ url: checkoutUrl });
  } catch (error) {
    logError('Checkout failed', error, req);
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

    const returnUrl = `${getBaseUrl(req)}/dashboard.html`;
    const portalUrl = await createPortalSession(userId, returnUrl);

    if (!portalUrl) {
      res.status(500).json({ error: 'Failed to create portal session. User may not have an active subscription.' });
      return;
    }

    res.json({ url: portalUrl });
  } catch (error) {
    logError('Portal failed', error, req);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

// Voice learning endpoint - analyze samples and generate pack
app.post('/api/learn/analyze', authMiddleware, async (req: Request, res: Response) => {
  try {
    const samples = Array.isArray(req.body?.samples) ? req.body.samples : null;
    const packName = sanitizePackName(req.body?.packName);
    const method = sanitizeOptionalString(req.body?.method, 20) || 'rule-based';
    
    if (!samples || samples.length === 0) {
      res.status(400).json({ error: 'samples array is required with at least one item' });
      return;
    }
    
    if (!packName) {
      res.status(400).json({ error: 'packName is required' });
      return;
    }
    if (samples.length > MAX_SAMPLES_PER_REQUEST) {
      res.status(400).json({ error: `Too many samples (max ${MAX_SAMPLES_PER_REQUEST})` });
      return;
    }
    
    // Validate pack name (prevent path traversal)
    if (!/^[a-z0-9-]+$/.test(packName)) {
      res.status(400).json({ error: 'packName must contain only lowercase letters, numbers, and hyphens' });
      return;
    }
    
    if (!['ai', 'rule-based'].includes(method)) {
      res.status(400).json({ error: 'Invalid method' });
      return;
    }

    if (method === 'ai') {
      if (!enforceAIAccess(req, res)) {
        return;
      }
      // Use AI-based analysis
      const { learnVoice } = await import('../learn/index.js');
      const result = await learnVoice({
        samples: samples.map((s: unknown) => typeof s === 'string' ? s : (s as { text?: unknown }).text).filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0),
        brandName: packName,
        industry: sanitizeOptionalString(req.body?.industry, 100),
        context: sanitizeOptionalString(req.body?.context, MAX_CONTEXT_LENGTH)
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
      
      const voiceSamples: VoiceSample[] = samples.map((s: unknown) => ({
        text: typeof s === 'string' ? s : String((s as { text?: unknown }).text || ''),
        source: typeof s === 'object' ? (s as { source?: unknown }).source as string | undefined : undefined,
        context: typeof s === 'object' ? sanitizeVoiceSampleContext((s as { context?: unknown }).context) : undefined
      })).filter((sample: VoiceSample) => sample.text.trim().length > 0 && sample.text.length <= MAX_TEXT_LENGTH);
      
      if (voiceSamples.length === 0) {
        res.status(400).json({ error: 'No valid samples provided' });
        return;
      }
      
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
    logError('Voice learning analyze failed', error, req);
    res.status(500).json({ 
      error: error instanceof Error ? error.message : 'Voice learning failed' 
    });
  }
});

// Generate pack files from analysis
app.post('/api/learn/generate', authMiddleware, async (req: Request, res: Response) => {
  try {
    const packName = sanitizePackName(req.body?.packName);
    const analysis = req.body?.analysis as { voice?: unknown; analysis?: unknown } | undefined;
    const method = sanitizeOptionalString(req.body?.method, 20) || 'rule-based';
    const allowOverwrite = req.body?.allowOverwrite === true;
    
    if (!packName || !analysis) {
      res.status(400).json({ error: 'packName and analysis are required' });
      return;
    }
    
    // Validate pack name
    if (!/^[a-z0-9-]+$/.test(packName)) {
      res.status(400).json({ error: 'packName must contain only lowercase letters, numbers, and hyphens' });
      return;
    }
    if (!(await enforcePackWriteAccess(req, res, packName, allowOverwrite))) {
      return;
    }
    if (!['ai', 'rule-based'].includes(method)) {
      res.status(400).json({ error: 'Invalid method' });
      return;
    }
    
    if (method === 'ai') {
      if (!enforceAIAccess(req, res)) {
        return;
      }
      if (!analysis.voice || typeof analysis.voice !== 'object') {
        res.status(400).json({ error: 'Invalid analysis format' });
        return;
      }
      const analysisInput = (analysis.analysis || {}) as Partial<LearnedVoice['analysis']>;
      const normalizedAnalysis: LearnedVoice['analysis'] = {
        samplesAnalyzed: typeof analysisInput.samplesAnalyzed === 'number' ? analysisInput.samplesAnalyzed : 0,
        totalWords: typeof analysisInput.totalWords === 'number' ? analysisInput.totalWords : 0,
        tokensUsed: {
          input: typeof analysisInput.tokensUsed?.input === 'number' ? analysisInput.tokensUsed.input : 0,
          output: typeof analysisInput.tokensUsed?.output === 'number' ? analysisInput.tokensUsed.output : 0,
        },
        confidence: typeof analysisInput.confidence === 'number' ? analysisInput.confidence : 0.7,
      };
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
        voice: analysis.voice as LearnedVoice['voice'],
        analysis: normalizedAnalysis
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
    logError('Pack generation failed', error, req);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Pack generation failed'
    });
  }
});

// Streaming validation for real-time feedback
app.post('/api/validate/stream', authMiddleware, async (req: Request, res: Response) => {
  try {
    const text = sanitizeString(req.body?.text, MAX_TEXT_LENGTH);
    const packName = sanitizePackName(req.body?.pack, 'saas');
    const context = sanitizeValidationContext(req.body?.context);
    const useMultiVoice = req.body?.useMultiVoice === true;

    if (!text) {
      res.status(400).json({ error: 'text is required' });
      return;
    }
    if (!packName) {
      res.status(400).json({ error: 'Invalid pack name' });
      return;
    }

    if (!enforceMaxLen({ value: text, field: 'text', max: MAX_TEXT_CHARS, res })) {
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial event
    res.write(`data: ${JSON.stringify({ type: 'start', message: 'Starting validation...' })}\n\n`);

    let selectedPack = packName;
    const validationContext = context;
    let selectedVoiceContext: VoiceContext | undefined;

    // Multi-voice selection with progress
    if (useMultiVoice) {
      res.write(`data: ${JSON.stringify({ type: 'progress', message: 'Analyzing context...' })}\n\n`);
      
      const { VoiceContextManager } = await import('../utils/voice-context.js');
      const voiceManager = new VoiceContextManager();
      
      const selection = await voiceManager.selectVoice(text, {});
      selectedPack = selection.packName;
      selectedVoiceContext = selection.context;

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
    
    const { pack, warnings } = await getPackWithWarnings(selectedPack);

    // Validate with progress
    res.write(`data: ${JSON.stringify({ type: 'progress', message: 'Validating content...' })}\n\n`);
    
    const result = validate({ pack, text, context: validationContext });

    // Send final result
    res.write(`data: ${JSON.stringify({ 
      type: 'complete', 
      result: result,
      pack: selectedPack,
      context: selectedVoiceContext,
      packWarnings: warnings.length > 0 ? warnings : undefined
    })}\n\n`);

    res.end();
  } catch (error) {
    logError('Stream validation failed', error, req);
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
    logError('Voice context listing failed', error, req);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to list voice contexts'
    });
  }
});

app.post('/api/voices/contexts', authMiddleware, async (req: Request, res: Response) => {
  try {
    const context = sanitizeOptionalString(req.body?.context, 50);
    const packName = sanitizePackName(req.body?.packName);
    const description = sanitizeOptionalString(req.body?.description, 200);
    
    if (!context || !packName) {
      res.status(400).json({ error: 'context and packName are required' });
      return;
    }
    if (!isVoiceContext(context)) {
      res.status(400).json({ error: 'Invalid context' });
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
    logError('Voice context add failed', error, req);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to add voice context'
    });
  }
});

app.delete('/api/voices/contexts/:context', authMiddleware, async (req: Request, res: Response) => {
  try {
    const context = sanitizeOptionalString(req.params.context, 50);
    if (!context || !isVoiceContext(context)) {
      res.status(400).json({ error: 'Invalid context' });
      return;
    }
    
    const { VoiceContextManager } = await import('../utils/voice-context.js');
    const voiceManager = new VoiceContextManager();
    
    voiceManager.removeContextVoice(context);
    
    res.json({
      success: true,
      message: `Context '${context}' removed`
    });
  } catch (error) {
    logError('Voice context removal failed', error, req);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to remove voice context'
    });
  }
});

// Detect context from text (useful for testing)
app.post('/api/voices/detect', authMiddleware, async (req: Request, res: Response) => {
  try {
    const text = sanitizeString(req.body?.text, MAX_TEXT_LENGTH);
    const channel = sanitizeOptionalString(req.body?.channel, MAX_CONTEXT_LENGTH);
    const subject = sanitizeOptionalString(req.body?.subject, MAX_CONTEXT_LENGTH);
    const audience = sanitizeOptionalString(req.body?.audience, MAX_CONTEXT_LENGTH);
    const contentType = sanitizeOptionalString(req.body?.contentType, MAX_CONTEXT_LENGTH);
    
    if (!text) {
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
    logError('Context detection failed', error, req);
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
        const text = sanitizeString(args?.text, MAX_TEXT_LENGTH);
        const packName = sanitizePackName(args?.pack, 'saas');
        if (!text) {
          res.status(400).json({ error: 'Missing or invalid "text" field' });
          return;
        }
        if (!packName) {
          res.status(400).json({ error: 'Invalid "pack" field' });
          return;
        }
        const { pack, warnings } = await getPackWithWarnings(packName);
        const result = validate({
          pack,
          text,
          context: typeof args?.context_type === 'string' ? { type: args.context_type } : undefined,
        });
        const response: Record<string, unknown> = { result };
        if (warnings.length > 0) {
          response.packWarnings = warnings;
        }
        res.json(response);
        break;
      }

      case 'rewrite_to_style': {
        const text = sanitizeString(args?.text, MAX_TEXT_LENGTH);
        const packName = sanitizePackName(args?.pack, 'saas');
        if (!text) {
          res.status(400).json({ error: 'Missing or invalid "text" field' });
          return;
        }
        if (!packName) {
          res.status(400).json({ error: 'Invalid "pack" field' });
          return;
        }
        const { pack, warnings } = await getPackWithWarnings(packName);
        const mode = typeof args?.mode === 'string' ? args.mode : 'normal';
        const options = {
          pack,
          text,
          context: typeof args?.context_type === 'string' ? { type: args.context_type } : undefined,
        };

        let result;
        if (mode === 'minimal') {
          result = rewriteMinimal(options);
        } else if (mode === 'aggressive') {
          result = rewriteAggressive(options);
        } else {
          result = rewrite(options);
        }

        const response: Record<string, unknown> = { result: { ...result, summary: formatChanges(result) } };
        if (warnings.length > 0) {
          response.packWarnings = warnings;
        }
        res.json(response);
        break;
      }

      case 'get_voice_rules': {
        const packName = sanitizePackName(args?.pack, 'saas');
        const section = typeof args?.section === 'string' ? args.section : 'all';
        if (!packName) {
          res.status(400).json({ error: 'Invalid "pack" field' });
          return;
        }
        const { pack, warnings } = await getPackWithWarnings(packName);
        const voice = pack.voice as Record<string, unknown>;
        const data = section === 'all' ? pack.voice : voice[section];
        const response: Record<string, unknown> = { result: data };
        if (warnings.length > 0) {
          response.packWarnings = warnings;
        }
        res.json(response);
        break;
      }

      case 'get_copy_patterns': {
        const packName = sanitizePackName(args?.pack, 'saas');
        if (!packName) {
          res.status(400).json({ error: 'Invalid "pack" field' });
          return;
        }
        const { pack, warnings } = await getPackWithWarnings(packName);
        let patterns = pack.copyPatterns.patterns;
        if (args?.category && args.category !== 'all') {
          patterns = patterns.filter(p => p.category === args.category);
        }
        const response: Record<string, unknown> = { result: patterns };
        if (warnings.length > 0) {
          response.packWarnings = warnings;
        }
        res.json(response);
        break;
      }

      case 'get_cta_rules': {
        const packName = sanitizePackName(args?.pack, 'saas');
        if (!packName) {
          res.status(400).json({ error: 'Invalid "pack" field' });
          return;
        }
        const { pack, warnings } = await getPackWithWarnings(packName);
        const response: Record<string, unknown> = {
          result: {
            guidelines: pack.ctaRules.guidelines,
            categories: pack.ctaRules.categories,
            antiPatterns: pack.ctaRules.antiPatterns,
          },
        };
        if (warnings.length > 0) {
          response.packWarnings = warnings;
        }
        res.json(response);
        break;
      }

      case 'get_tokens': {
        const packName = sanitizePackName(args?.pack, 'saas');
        const type = typeof args?.type === 'string' ? args.type : 'all';
        if (!packName) {
          res.status(400).json({ error: 'Invalid "pack" field' });
          return;
        }
        const { pack, warnings } = await getPackWithWarnings(packName);
        const tokens = pack.tokens as Record<string, unknown>;
        const data = type === 'all' ? pack.tokens : tokens[type];
        const response: Record<string, unknown> = { result: data };
        if (warnings.length > 0) {
          response.packWarnings = warnings;
        }
        res.json(response);
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
