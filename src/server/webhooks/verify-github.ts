import crypto from 'crypto';

export function verifyGitHubWebhookSignature(args: {
  secret: string;
  body: Buffer;
  signatureHeader: string | undefined;
}): boolean {
  const { secret, body, signatureHeader } = args;

  // If no secret is configured, skip verification (useful for dev/self-hosted)
  if (!secret) return true;

  if (!signatureHeader) return false;

  const [prefix, hex] = signatureHeader.split('=');
  if (prefix !== 'sha256' || !hex) return false;

  // GitHub uses 32-byte HMAC SHA-256 -> 64 hex chars
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;

  const received = Buffer.from(hex, 'hex');
  const computed = crypto.createHmac('sha256', secret).update(body).digest();

  // timingSafeEqual requires equal lengths
  if (received.length !== computed.length) return false;

  return crypto.timingSafeEqual(received, computed);
}
