import { describe, expect, test } from 'vitest';
import crypto from 'crypto';
import { verifyGitHubWebhookSignature } from './verify-github.js';

describe('verifyGitHubWebhookSignature', () => {
  test('returns true when secret is empty (verification disabled)', () => {
    const ok = verifyGitHubWebhookSignature({
      secret: '',
      body: Buffer.from('hello'),
      signatureHeader: undefined,
    });
    expect(ok).toBe(true);
  });

  test('accepts a valid sha256 signature', () => {
    const secret = 'topsecret';
    const body = Buffer.from('{"ok":true}');
    const digest = crypto.createHmac('sha256', secret).update(body).digest('hex');

    const ok = verifyGitHubWebhookSignature({
      secret,
      body,
      signatureHeader: `sha256=${digest}`,
    });
    expect(ok).toBe(true);
  });

  test('rejects invalid signatures', () => {
    const secret = 'topsecret';
    const body = Buffer.from('{"ok":true}');

    const ok = verifyGitHubWebhookSignature({
      secret,
      body,
      signatureHeader: 'sha256=' + '0'.repeat(64),
    });
    expect(ok).toBe(false);
  });

  test('rejects malformed header', () => {
    const secret = 'topsecret';
    const body = Buffer.from('x');

    expect(
      verifyGitHubWebhookSignature({ secret, body, signatureHeader: 'nope' })
    ).toBe(false);

    expect(
      verifyGitHubWebhookSignature({ secret, body, signatureHeader: 'sha1=' + '0'.repeat(40) })
    ).toBe(false);

    expect(
      verifyGitHubWebhookSignature({ secret, body, signatureHeader: 'sha256=xyz' })
    ).toBe(false);
  });
});
