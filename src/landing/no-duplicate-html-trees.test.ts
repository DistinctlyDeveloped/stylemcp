import { describe, expect, test } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression test for: Dual HTML trees causing deployment drift.
 *
 * The bug: Root-level HTML files (login.html, signup.html, dashboard.html, etc.)
 * duplicated the landing/ directory pages with divergent auth configs, CSS, and
 * meta tags. Since Vercel deploys from landing/ (per vercel.json outputDirectory),
 * the root files were dead code that caused confusion and recurring config drift.
 *
 * Auth state was NOT shared between trees because root pages used a shared auth.js
 * with `window.sbClient` while landing pages inlined their own `supabaseClient`.
 *
 * Fix: Delete the root-level duplicates. The landing/ tree is the single source of truth.
 */
describe('No duplicate HTML trees (root vs landing)', () => {
  const rootDir = resolve(__dirname, '../..');

  const duplicateFiles = [
    'login.html',
    'signup.html',
    'dashboard.html',
    'docs.html',
    'pricing.html',
    'status.html',
  ];

  for (const file of duplicateFiles) {
    test(`root-level ${file} should not exist (deployed from landing/ only)`, () => {
      const rootPath = resolve(rootDir, file);
      expect(
        existsSync(rootPath),
        `${file} exists at project root — this creates a dual HTML tree with landing/${file} and causes auth config drift`
      ).toBe(false);
    });
  }

  test('root-level auth.js should not exist (was only used by deleted root HTML files)', () => {
    expect(existsSync(resolve(rootDir, 'auth.js'))).toBe(false);
  });

  test('root-level auth-debug.html should not exist (debug tool for deleted root tree)', () => {
    expect(existsSync(resolve(rootDir, 'auth-debug.html'))).toBe(false);
  });

  test('landing/ directory should contain the canonical auth pages', () => {
    expect(existsSync(resolve(rootDir, 'landing/login.html'))).toBe(true);
    expect(existsSync(resolve(rootDir, 'landing/signup.html'))).toBe(true);
    expect(existsSync(resolve(rootDir, 'landing/dashboard.html'))).toBe(true);
  });
});
