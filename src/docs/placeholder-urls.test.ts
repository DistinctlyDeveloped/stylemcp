import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Regression test: ensures documentation and scripts reference the correct
 * self-hosted Supabase URL (db-stylemcp.distinctlydeveloped.com) and do NOT
 * contain stale Supabase Cloud placeholders (xxxxx.supabase.co).
 */
describe('placeholder URLs in docs and scripts', () => {
  const repoRoot = join(import.meta.dirname, '..', '..');

  it('should not contain stale Supabase Cloud placeholder (xxxxx.supabase.co) in BILLING_SETUP.md', () => {
    const content = readFileSync(join(repoRoot, 'BILLING_SETUP.md'), 'utf-8');
    expect(content).not.toContain('xxxxx.supabase.co');
    expect(content).toContain('db-stylemcp.distinctlydeveloped.com');
  });

  it('should not contain stale Supabase Cloud placeholder (xxxxx.supabase.co) in deploy-billing.sh', () => {
    const content = readFileSync(join(repoRoot, 'deploy-billing.sh'), 'utf-8');
    expect(content).not.toContain('xxxxx.supabase.co');
    expect(content).toContain('db-stylemcp.distinctlydeveloped.com');
  });
});
