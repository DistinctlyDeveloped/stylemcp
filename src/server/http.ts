#!/usr/bin/env node

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { loadPack, getPacksDirectory, listAvailablePacks } from '../utils/pack-loader.js';
import { validate } from '../validator/index.js';
import { rewrite, rewriteMinimal, rewriteAggressive, formatChanges } from '../rewriter/index.js';
import { Pack } from '../schema/index.js';
import { join } from 'path';
import crypto from 'crypto';
import {
  createCheckoutSession,
  handleStripeWebhook,
  createPortalSession,
  getSupabase,
  isBillingEnabled
} from './billing.js';

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.STYLEMCP_API_KEY || '';
const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || '';

// IMPORTANT: Webhook routes with raw body parsing must be registered BEFORE express.json()
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
      const signature = req.headers['x-hub-signature-256'] as string;
      if (!signature) {
        res.status(401).json({ error: 'Missing signature' });
        return;
      }

      const body = req.body;
      const hmac = crypto.createHmac('sha256', GITHUB_WEBHOOK_SECRET);
      const digest = 'sha256=' + hmac.update(body).digest('hex');

      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))) {
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

// Now apply JSON middleware for remaining routes
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Pack cache
const packCache = new Map<string, Pack>();

async function getPack(packName: string): Promise<Pack> {
  if (packCache.has(packName)) {
    return packCache.get(packName)!;
  }

  const packPath = join(getPacksDirectory(), packName);
  const result = await loadPack({ packPath });
  packCache.set(packName, result.pack);
  return result.pack;
}

// Optional API key authentication
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) {
    // No API key configured, allow all requests
    next();
    return;
  }

  const providedKey = req.headers['x-api-key'] || req.query.api_key;
  if (providedKey !== API_KEY) {
    res.status(401).json({ error: 'Invalid or missing API key' });
    return;
  }
  next();
}

// Health check (no auth required)
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', version: '0.1.4' });
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
    const { text, pack: packName = 'saas', context } = req.body;

    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'Missing or invalid "text" field' });
      return;
    }

    const pack = await getPack(packName);
    const result = validate({ pack, text, context });

    res.json(result);
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
    const { text, pack: packName = 'saas', mode = 'normal', context } = req.body;

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

    res.json({
      ...result,
      summary: formatChanges(result),
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
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
// The userId should be validated against the authenticated session in production.
app.post('/api/checkout', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!isBillingEnabled()) {
      res.status(503).json({ error: 'Billing not configured' });
      return;
    }

    const { userId, tier } = req.body;

    if (!userId || !tier) {
      res.status(400).json({ error: 'Missing userId or tier' });
      return;
    }

    // Validate userId format (UUID)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      res.status(400).json({ error: 'Invalid userId format' });
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
// The userId should be validated against the authenticated session in production.
app.post('/api/billing/portal', authMiddleware, async (req: Request, res: Response) => {
  try {
    if (!isBillingEnabled()) {
      res.status(503).json({ error: 'Billing not configured' });
      return;
    }

    const { userId } = req.body;

    if (!userId) {
      res.status(400).json({ error: 'Missing userId' });
      return;
    }

    // Validate userId format (UUID)
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(userId)) {
      res.status(400).json({ error: 'Invalid userId format' });
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
