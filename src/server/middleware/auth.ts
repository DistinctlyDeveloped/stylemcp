import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { validateApiKey, checkQuota, recordUsage, isBillingEnabled, UserProfile, UsageStats } from '../billing.js';

// Extend Express Request to include user info
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserProfile;
      usageStats?: UsageStats;
      requestStart?: number;
    }
  }
}

const LEGACY_API_KEY = process.env.STYLEMCP_API_KEY || '';

const RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const LEGACY_RATE_LIMIT_PER_MINUTE = Number.parseInt(process.env.LEGACY_RATE_LIMIT_PER_MINUTE || '120', 10);

const RATE_LIMITS_PER_MINUTE: Record<string, number> = {
  free: Number.parseInt(process.env.RATE_LIMIT_FREE_PER_MINUTE || '60', 10),
  pro: Number.parseInt(process.env.RATE_LIMIT_PRO_PER_MINUTE || '300', 10),
  team: Number.parseInt(process.env.RATE_LIMIT_TEAM_PER_MINUTE || '600', 10),
  business: Number.parseInt(process.env.RATE_LIMIT_BUSINESS_PER_MINUTE || '1200', 10),
  enterprise: Number.parseInt(process.env.RATE_LIMIT_ENTERPRISE_PER_MINUTE || '3000', 10),
};

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const apiRateLimiter = new Map<string, RateLimitRecord>();

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of apiRateLimiter) {
    if (record.resetAt <= now) {
      apiRateLimiter.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

function checkApiRateLimit(apiKey: string, limit: number): { allowed: boolean; remaining: number; resetAt: number } {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, remaining: 0, resetAt: Date.now() + RATE_LIMIT_WINDOW_MS };
  }

  const now = Date.now();
  let record = apiRateLimiter.get(apiKey);
  if (!record || record.resetAt <= now) {
    record = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    apiRateLimiter.set(apiKey, record);
  }

  if (record.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: record.resetAt };
  }

  record.count += 1;
  return { allowed: true, remaining: Math.max(0, limit - record.count), resetAt: record.resetAt };
}

// Authentication middleware
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  req.requestStart = Date.now();

  // If billing is not enabled, fall back to legacy API key
  if (!isBillingEnabled()) {
    if (LEGACY_API_KEY) {
      const providedKey = req.headers['x-api-key'];
      if (!providedKey || typeof providedKey !== 'string') {
        res.status(401).json({ error: 'Invalid or missing API key' });
        return;
      }

      const providedBuffer = Buffer.from(providedKey);
      const expectedBuffer = Buffer.from(LEGACY_API_KEY);

      // Length mismatch handled separately to avoid timing oracle
      if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
        res.status(401).json({ error: 'Invalid or missing API key' });
        return;
      }
    }
    const legacyKey = String(req.headers['x-api-key'] || '');
    if (legacyKey) {
      const limit = LEGACY_RATE_LIMIT_PER_MINUTE;
      const rateLimit = checkApiRateLimit(legacyKey, limit);
      res.setHeader('X-RateLimit-Window', Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
      res.setHeader('X-RateLimit-Limit-Window', limit);
      res.setHeader('X-RateLimit-Remaining-Window', rateLimit.remaining);
      res.setHeader('X-RateLimit-Reset-Window', Math.ceil(rateLimit.resetAt / 1000));
      if (!rateLimit.allowed) {
        res.status(429).json({
          error: 'Rate limit exceeded',
          resetAt: new Date(rateLimit.resetAt).toISOString(),
        });
        return;
      }
    }
    next();
    return;
  }

  // Get API key from header or query
  const apiKey = req.headers['x-api-key'] as string | undefined;

  if (!apiKey) {
    res.status(401).json({
      error: 'API key required',
      docs: 'https://stylemcp.com/docs#authentication'
    });
    return;
  }

  // Validate API key
  const user = await validateApiKey(apiKey);

  if (!user) {
    res.status(401).json({
      error: 'Invalid API key',
      docs: 'https://stylemcp.com/docs#authentication'
    });
    return;
  }

  const perMinuteLimit = RATE_LIMITS_PER_MINUTE[user.tier] ?? RATE_LIMITS_PER_MINUTE.free;
  const rateLimit = checkApiRateLimit(apiKey, perMinuteLimit);
  res.setHeader('X-RateLimit-Window', Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
  res.setHeader('X-RateLimit-Limit-Window', perMinuteLimit);
  res.setHeader('X-RateLimit-Remaining-Window', rateLimit.remaining);
  res.setHeader('X-RateLimit-Reset-Window', Math.ceil(rateLimit.resetAt / 1000));
  if (!rateLimit.allowed) {
    res.status(429).json({
      error: 'Rate limit exceeded',
      resetAt: new Date(rateLimit.resetAt).toISOString(),
    });
    return;
  }

  // Check quota
  const { allowed, stats } = await checkQuota(user.id);

  if (!allowed) {
    res.status(429).json({
      error: 'Monthly request limit exceeded',
      usage: stats,
      upgrade_url: 'https://stylemcp.com/pricing',
    });
    return;
  }

  // Attach user and stats to request
  req.user = user;
  req.usageStats = stats;

  // Add usage headers
  res.setHeader('X-RateLimit-Limit', stats.limit);
  res.setHeader('X-RateLimit-Remaining', stats.remaining - 1);
  res.setHeader('X-RateLimit-Reset', stats.reset_date);

  next();
}

// Response logging middleware (call after response is sent)
export function usageLogger(req: Request, res: Response, next: NextFunction): void {
  // Hook into response finish to log usage
  res.on('finish', async () => {
    if (req.user && isBillingEnabled()) {
      const responseTime = req.requestStart ? Date.now() - req.requestStart : 0;

      await recordUsage(
        req.user.id,
        req.path,
        req.method,
        res.statusCode,
        responseTime
      );
    }
  });

  next();
}

// Optional auth - doesn't require key but attaches user if provided
export async function optionalAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isBillingEnabled()) {
    next();
    return;
  }

  const apiKey = req.headers['x-api-key'] as string | undefined;

  if (apiKey) {
    const user = await validateApiKey(apiKey);
    if (user) {
      const { stats } = await checkQuota(user.id);
      req.user = user;
      req.usageStats = stats;
    }
  }

  next();
}
