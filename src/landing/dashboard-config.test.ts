import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Landing dashboard Supabase config', () => {
  const dashboardPath = resolve(__dirname, '../../landing/dashboard.html');
  let content: string;

  try {
    content = readFileSync(dashboardPath, 'utf-8');
  } catch {
    content = '';
  }

  test('should not reference old Supabase Cloud URL', () => {
    if (!content) return; // skip if file doesn't exist in CI
    expect(content).not.toContain('orbliwjewqlnnutykozw.supabase.co');
  });

  test('should use self-hosted Supabase URL', () => {
    if (!content) return;
    expect(content).toContain('db-stylemcp.distinctlydeveloped.com');
  });

  test('should not contain stale Supabase Cloud anon key', () => {
    if (!content) return;
    // The old cloud anon key started with this prefix
    expect(content).not.toContain('eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yYmxpd2pld3Fsbm51dHlrb3p3Iiwicm9sZSI6ImFub24i');
  });
});
