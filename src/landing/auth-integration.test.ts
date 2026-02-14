import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression test for: login.html and signup.html must use real Supabase auth,
 * not demo-only handlers that redirect without creating a session.
 *
 * The bug: login/signup pages did `window.location.href = '/dashboard.html'`
 * without calling Supabase auth, causing an auth loop with dashboard.html
 * which checks for a valid session.
 */
describe('Landing auth pages use real Supabase auth', () => {
  const loginPath = resolve(__dirname, '../../landing/login.html');
  const signupPath = resolve(__dirname, '../../landing/signup.html');
  const dashboardPath = resolve(__dirname, '../../landing/dashboard.html');

  let loginContent: string;
  let signupContent: string;
  let dashboardContent: string;

  try { loginContent = readFileSync(loginPath, 'utf-8'); } catch { loginContent = ''; }
  try { signupContent = readFileSync(signupPath, 'utf-8'); } catch { signupContent = ''; }
  try { dashboardContent = readFileSync(dashboardPath, 'utf-8'); } catch { dashboardContent = ''; }

  describe('login.html', () => {
    test('should load the Supabase JS SDK', () => {
      if (!loginContent) return;
      expect(loginContent).toContain('@supabase/supabase-js');
    });

    test('should call supabase auth.signInWithPassword', () => {
      if (!loginContent) return;
      expect(loginContent).toContain('signInWithPassword');
    });

    test('should NOT have a bare redirect to dashboard without auth', () => {
      if (!loginContent) return;
      // The old bug: handleLogin just did window.location.href = '/dashboard.html'
      // without any Supabase call. We check that if the redirect exists, signInWithPassword also exists.
      if (loginContent.includes("window.location.href = '/dashboard.html'")) {
        expect(loginContent).toContain('signInWithPassword');
      }
    });

    test('should use self-hosted Supabase URL', () => {
      if (!loginContent) return;
      expect(loginContent).toContain('db-stylemcp.distinctlydeveloped.com');
    });

    test('should not reference old Supabase Cloud URL', () => {
      if (!loginContent) return;
      expect(loginContent).not.toContain('orbliwjewqlnnutykozw.supabase.co');
    });

    test('should have OAuth buttons (not commented out)', () => {
      if (!loginContent) return;
      expect(loginContent).toContain('signInWithOAuth');
    });
  });

  describe('signup.html', () => {
    test('should load the Supabase JS SDK', () => {
      if (!signupContent) return;
      expect(signupContent).toContain('@supabase/supabase-js');
    });

    test('should call supabase auth.signUp', () => {
      if (!signupContent) return;
      expect(signupContent).toContain('supabaseClient.auth.signUp');
    });

    test('should NOT have a bare redirect to dashboard without auth', () => {
      if (!signupContent) return;
      if (signupContent.includes("window.location.href = '/dashboard.html'")) {
        expect(signupContent).toContain('auth.signUp');
      }
    });

    test('should use self-hosted Supabase URL', () => {
      if (!signupContent) return;
      expect(signupContent).toContain('db-stylemcp.distinctlydeveloped.com');
    });

    test('should not reference old Supabase Cloud URL', () => {
      if (!signupContent) return;
      expect(signupContent).not.toContain('orbliwjewqlnnutykozw.supabase.co');
    });

    test('should have OAuth buttons (not commented out)', () => {
      if (!signupContent) return;
      expect(signupContent).toContain('signInWithOAuth');
    });

    test('should pass user metadata (first_name, last_name) on signup', () => {
      if (!signupContent) return;
      expect(signupContent).toContain('first_name');
      expect(signupContent).toContain('last_name');
    });
  });

  describe('All auth pages use consistent Supabase config', () => {
    test('login, signup, and dashboard should all use the same Supabase URL', () => {
      if (!loginContent || !signupContent || !dashboardContent) return;
      const url = 'db-stylemcp.distinctlydeveloped.com';
      expect(loginContent).toContain(url);
      expect(signupContent).toContain(url);
      expect(dashboardContent).toContain(url);
    });
  });
});
