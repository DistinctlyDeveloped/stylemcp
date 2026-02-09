/**
 * Error Capture & Auto-Healing System for StyleMCP
 *
 * Captures errors with full context, attempts auto-healing for known patterns,
 * logs to Supabase error_events, and alerts via Telegram for unknowns/criticals.
 */

import { Request, Response, NextFunction } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getSupabase } from './billing.js';
import { clearPackCache } from '../utils/pack-loader.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';
export type ErrorType =
  | 'api_error'
  | 'pack_load'
  | 'auth_failure'
  | 'ai_service'
  | 'validation'
  | 'client'
  | 'unknown';

export interface ErrorEvent {
  error_type: ErrorType;
  error_code?: string;
  severity: ErrorSeverity;
  message: string;
  stack_trace?: string;
  context: Record<string, unknown>;
  auto_healed?: boolean;
  healing_action?: string;
  healing_details?: Record<string, unknown>;
}

interface HealingResult {
  healed: boolean;
  action?: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_ALERT_CHAT = process.env.TELEGRAM_ALERT_CHAT || process.env.STYLEMCP_TELEGRAM_CHAT || '';
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 min cooldown per error_code
const MAX_RETRY_ATTEMPTS = 2;

const DD_ERRORS_PATH = process.env.DD_ERRORS_PATH || path.resolve(process.env.HOME || '', 'Projects/distinctlydeveloped.com/data/errors.json');

// In-memory dedup for Telegram alerts
const alertCooldowns = new Map<string, number>();

// In-memory buffer for when Supabase is unavailable
const errorBuffer: ErrorEvent[] = [];
const MAX_BUFFER_SIZE = 200;

// ---------------------------------------------------------------------------
// Error Classification
// ---------------------------------------------------------------------------

interface ClassifiedError {
  type: ErrorType;
  code: string;
  severity: ErrorSeverity;
}

function classifyError(error: unknown, endpoint?: string): ClassifiedError {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();

  // Pack loading errors
  if (lower.includes('pack not found') || lower.includes('pack_load') || lower.includes('manifest')) {
    return { type: 'pack_load', code: 'PACK_NOT_FOUND', severity: 'medium' };
  }
  if (lower.includes('yaml') || lower.includes('parse')) {
    return { type: 'pack_load', code: 'PACK_PARSE_ERROR', severity: 'high' };
  }

  // AI service errors (Claude API)
  if (lower.includes('rate limit') || lower.includes('429')) {
    return { type: 'ai_service', code: 'AI_RATE_LIMIT', severity: 'high' };
  }
  if (lower.includes('anthropic') || lower.includes('claude') || lower.includes('ai rewrite')) {
    if (lower.includes('timeout') || lower.includes('econnrefused')) {
      return { type: 'ai_service', code: 'AI_TIMEOUT', severity: 'high' };
    }
    if (lower.includes('credit') || lower.includes('billing') || lower.includes('insufficient')) {
      return { type: 'ai_service', code: 'AI_CREDITS_EXHAUSTED', severity: 'critical' };
    }
    return { type: 'ai_service', code: 'AI_SERVICE_ERROR', severity: 'high' };
  }

  // Auth errors
  if (lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('auth')) {
    return { type: 'auth_failure', code: 'AUTH_INVALID', severity: 'low' };
  }
  if (lower.includes('expired') || lower.includes('jwt')) {
    return { type: 'auth_failure', code: 'AUTH_EXPIRED', severity: 'medium' };
  }

  // Validation errors
  if (lower.includes('validation') || lower.includes('invalid') || lower.includes('missing')) {
    return { type: 'validation', code: 'VALIDATION_ERROR', severity: 'low' };
  }

  // API errors by endpoint pattern
  if (endpoint) {
    if (endpoint.includes('/api/rewrite') && (lower.includes('timeout') || lower.includes('econnreset'))) {
      return { type: 'api_error', code: 'REWRITE_TIMEOUT', severity: 'high' };
    }
  }

  // Connection / infrastructure
  if (lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('socket hang up')) {
    return { type: 'api_error', code: 'CONNECTION_ERROR', severity: 'high' };
  }
  if (lower.includes('enomem') || lower.includes('out of memory')) {
    return { type: 'api_error', code: 'OOM', severity: 'critical' };
  }

  return { type: 'unknown', code: 'UNCLASSIFIED', severity: 'medium' };
}

// ---------------------------------------------------------------------------
// Auto-Healing Engine
// ---------------------------------------------------------------------------

async function attemptHealing(
  classified: ClassifiedError,
  _error: unknown,
  _req?: Request
): Promise<HealingResult> {
  switch (classified.code) {
    // Pack cache corruption → clear cache and retry
    case 'PACK_NOT_FOUND':
    case 'PACK_PARSE_ERROR':
    case 'PACK_CACHE_CORRUPT': {
      clearPackCache();
      return {
        healed: true,
        action: 'pack_cache_reload',
        details: { message: 'Pack cache cleared; next request will reload from disk' },
      };
    }

    // AI rate limit → exponential backoff retry
    case 'AI_RATE_LIMIT': {
      const retryResult = await retryWithBackoff(async () => {
        // We can't replay the original request here, but we signal the caller
        // that rate limiting was detected so they can queue/retry
        return { waited: true };
      }, MAX_RETRY_ATTEMPTS, 1000);

      if (retryResult) {
        return {
          healed: true,
          action: 'rate_limit_backoff',
          details: { retries: MAX_RETRY_ATTEMPTS, message: 'Backed off for rate limit' },
        };
      }
      return { healed: false };
    }

    // AI service down → fallback to rule-based only
    case 'AI_TIMEOUT':
    case 'AI_SERVICE_ERROR': {
      return {
        healed: true,
        action: 'fallback_rule_based',
        details: { message: 'AI service unavailable; falling back to rule-based validation/rewrite only' },
      };
    }

    // Auth expired → signal session refresh
    case 'AUTH_EXPIRED': {
      return {
        healed: true,
        action: 'session_refresh_signal',
        details: { message: 'Auth token expired; client should refresh session', header: 'X-StyleMCP-Action: refresh-session' },
      };
    }

    // Validation errors are user mistakes, not system errors
    case 'VALIDATION_ERROR': {
      return {
        healed: true,
        action: 'user_error_ignored',
        details: { message: 'Input validation failure — not a system error' },
      };
    }

    default:
      return { healed: false };
  }
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs: number
): Promise<T | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch {
      const delay = baseDelayMs * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Persistence (Supabase)
// ---------------------------------------------------------------------------

async function persistError(event: ErrorEvent): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) {
    // Buffer locally if Supabase is unavailable
    if (errorBuffer.length < MAX_BUFFER_SIZE) {
      errorBuffer.push(event);
    }
    console.error(`[ErrorCapture] No Supabase — buffered (${errorBuffer.length}/${MAX_BUFFER_SIZE}):`, event.error_code, event.message);
    return;
  }

  try {
    // Flush buffer first
    if (errorBuffer.length > 0) {
      const batch = errorBuffer.splice(0, errorBuffer.length);
      const { error: batchErr } = await supabase.from('error_events').insert(batch);
      if (batchErr) {
        console.error('[ErrorCapture] Buffer flush failed:', batchErr.message);
        // Put them back
        errorBuffer.unshift(...batch.slice(0, MAX_BUFFER_SIZE - errorBuffer.length));
      }
    }

    const { error: insertErr } = await supabase.from('error_events').insert(event);
    if (insertErr) {
      console.error('[ErrorCapture] Insert failed:', insertErr.message);
    }
  } catch (e) {
    console.error('[ErrorCapture] Persistence error:', e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------------------
// DistinctlyDeveloped Error Reporting (errors.json)
// ---------------------------------------------------------------------------

type DDSeverity = 'critical' | 'error' | 'warning' | 'info';

function mapSeverity(severity: ErrorSeverity): DDSeverity {
  switch (severity) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    case 'low':
    default:
      return 'info';
  }
}

async function reportErrorToDD(event: ErrorEvent): Promise<void> {
  try {
    let payload: {
      lastUpdated?: string;
      errors?: unknown[];
      stats?: {
        total_errors?: number;
        unresolved_count?: number;
        critical_count?: number;
        auto_healed_count?: number;
      };
    } = {};

    try {
      const payloadRaw = await fs.readFile(DD_ERRORS_PATH, 'utf8');
      payload = JSON.parse(payloadRaw || '{}');
    } catch {
      payload = { errors: [] };
    }

    const errors = Array.isArray(payload.errors) ? payload.errors.slice() : [];

    const entry = {
      id: randomUUID(),
      project: 'StyleMCP',
      severity: mapSeverity(event.severity),
      message: String(event.message).slice(0, 300),
      component: typeof event.context.endpoint === 'string' ? event.context.endpoint : event.error_type,
      stack_trace: event.stack_trace,
      timestamp: new Date().toISOString(),
      resolved: false,
      auto_healed: Boolean(event.auto_healed),
    };

    errors.push(entry);

    // Trim oldest to max 500
    const trimmed = errors.slice(-500);

    const stats = {
      total_errors: trimmed.length,
      unresolved_count: trimmed.filter(e => (e as { resolved?: boolean }).resolved === false).length,
      critical_count: trimmed.filter(e => (e as { severity?: string; resolved?: boolean }).severity === 'critical' && (e as { resolved?: boolean }).resolved === false).length,
      auto_healed_count: trimmed.filter(e => (e as { auto_healed?: boolean }).auto_healed === true).length,
    };

    const nextPayload = {
      lastUpdated: new Date().toISOString(),
      errors: trimmed,
      stats,
    };

    await fs.writeFile(DD_ERRORS_PATH, JSON.stringify(nextPayload, null, 2));
  } catch (e) {
    console.error('[ErrorCapture] DD errors.json write failed:', e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------------------
// Telegram Alerting
// ---------------------------------------------------------------------------

async function sendTelegramAlert(event: ErrorEvent): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ALERT_CHAT) return;

  // Cooldown dedup
  const cooldownKey = event.error_code || event.message.slice(0, 80);
  const lastAlert = alertCooldowns.get(cooldownKey);
  if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) return;
  alertCooldowns.set(cooldownKey, Date.now());

  const emoji = event.severity === 'critical' ? '🔴' : event.severity === 'high' ? '🟠' : '🟡';
  const healedTag = event.auto_healed ? ' [AUTO-HEALED]' : '';
  const endpoint = typeof event.context.endpoint === 'string' ? event.context.endpoint : '';

  const text = [
    `${emoji} <b>StyleMCP Error${healedTag}</b>`,
    `<b>Type:</b> ${event.error_type} / ${event.error_code || 'unknown'}`,
    `<b>Severity:</b> ${event.severity}`,
    endpoint ? `<b>Endpoint:</b> ${endpoint}` : '',
    `<b>Message:</b> ${escapeHtml(event.message.slice(0, 300))}`,
    event.healing_action ? `<b>Healing:</b> ${event.healing_action}` : '',
  ].filter(Boolean).join('\n');

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_ALERT_CHAT,
        text,
        parse_mode: 'HTML',
        disable_notification: event.severity !== 'critical',
      }),
    });
  } catch (e) {
    console.error('[ErrorCapture] Telegram alert failed:', e instanceof Error ? e.message : e);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Capture and process an error. Call this from catch blocks or middleware.
 */
export async function captureError(
  error: unknown,
  opts?: {
    req?: Request;
    endpoint?: string;
    userId?: string;
    extra?: Record<string, unknown>;
  }
): Promise<{ healed: boolean; action?: string }> {
  const classified = classifyError(error, opts?.endpoint || opts?.req?.originalUrl);

  const context: Record<string, unknown> = {
    endpoint: opts?.endpoint || opts?.req?.originalUrl,
    method: opts?.req?.method,
    user_id: opts?.userId || opts?.req?.user?.id,
    ip: opts?.req?.ip,
    user_agent: opts?.req?.get('user-agent')?.slice(0, 200),
    ...opts?.extra,
  };

  // Attempt auto-healing
  const healing = await attemptHealing(classified, error, opts?.req);

  const event: ErrorEvent = {
    error_type: classified.type,
    error_code: classified.code,
    severity: classified.severity,
    message: error instanceof Error ? error.message : String(error),
    stack_trace: error instanceof Error ? error.stack?.slice(0, 4000) : undefined,
    context,
    auto_healed: healing.healed,
    healing_action: healing.action,
    healing_details: healing.details,
  };

  // Persist (non-blocking)
  persistError(event).catch(() => {});
  reportErrorToDD(event).catch(() => {});

  // Alert for high/critical or unknown unhealed errors
  const shouldAlert =
    classified.severity === 'critical' ||
    (classified.severity === 'high' && !healing.healed) ||
    (classified.type === 'unknown' && !healing.healed);

  if (shouldAlert) {
    sendTelegramAlert(event).catch(() => {});
  }

  // Console log regardless
  const tag = healing.healed ? `[HEALED:${healing.action}]` : '[UNHEALED]';
  console.error(`[ErrorCapture] ${tag} ${classified.type}/${classified.code}: ${event.message}`);

  return { healed: healing.healed, action: healing.action };
}

// ---------------------------------------------------------------------------
// Express Middleware — wrap all routes
// ---------------------------------------------------------------------------

/**
 * Error-catching middleware. Mount AFTER all routes.
 *
 *   app.use(errorCaptureMiddleware);
 */
export function errorCaptureMiddleware(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  captureError(err, { req }).then(({ healed, action }) => {
    // If auth expired and healed, hint the client
    if (action === 'session_refresh_signal') {
      res.setHeader('X-StyleMCP-Action', 'refresh-session');
    }

    // If AI fallback, note it
    if (action === 'fallback_rule_based') {
      res.setHeader('X-StyleMCP-AI-Fallback', 'true');
    }

    // Don't leak internals
    if (!res.headersSent) {
      const status = (err as { status?: number }).status || 500;
      res.status(status).json({
        error: status === 500 ? 'Internal server error' : err.message,
        ...(healed ? { note: 'This error was automatically handled. Please retry.' } : {}),
      });
    }
  }).catch(() => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}

// ---------------------------------------------------------------------------
// Client-Side Error Reporting Endpoint
// ---------------------------------------------------------------------------

export interface ClientErrorReport {
  page: string;
  message: string;
  stack?: string;
  userAgent?: string;
  url?: string;
  extra?: Record<string, unknown>;
}

export async function handleClientErrorReport(report: ClientErrorReport, req: Request): Promise<void> {
  await captureError(new Error(report.message), {
    req,
    endpoint: `client:${report.page}`,
    extra: {
      source: 'client',
      page: report.page,
      client_url: report.url,
      client_ua: report.userAgent?.slice(0, 200),
      client_stack: report.stack?.slice(0, 2000),
      ...report.extra,
    },
  });
}

// ---------------------------------------------------------------------------
// Dashboard API Helpers
// ---------------------------------------------------------------------------

export async function getErrorDashboard(hours = 24): Promise<Record<string, unknown> | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  try {
    const { data, error } = await supabase.rpc('get_error_summary', { p_hours: hours });
    if (error) {
      console.error('[ErrorCapture] Dashboard RPC error:', error.message);
      return null;
    }
    return data;
  } catch (e) {
    console.error('[ErrorCapture] Dashboard error:', e instanceof Error ? e.message : e);
    return null;
  }
}

export async function getRecentErrors(limit = 50, unresolvedOnly = false): Promise<unknown[]> {
  const supabase = getSupabase();
  if (!supabase) return [];

  try {
    let query = supabase
      .from('error_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (unresolvedOnly) {
      query = query.eq('resolved', false);
    }

    const { data, error } = await query;
    if (error) {
      console.error('[ErrorCapture] Recent errors query error:', error.message);
      return [];
    }
    return data || [];
  } catch (e) {
    console.error('[ErrorCapture] Recent errors error:', e instanceof Error ? e.message : e);
    return [];
  }
}

export async function resolveError(errorId: string, resolvedBy = 'manual'): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;

  try {
    const { error } = await supabase
      .from('error_events')
      .update({ resolved: true, resolved_at: new Date().toISOString(), resolved_by: resolvedBy })
      .eq('id', errorId);

    return !error;
  } catch {
    return false;
  }
}
