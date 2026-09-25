import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random token, URL-safe. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Tokens are stored as SHA-256 digests so a database leak does not expose
 * usable session or setup tokens. A fast hash is appropriate here because the
 * tokens are 256-bit random values, not guessable secrets.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Accepts only strings shaped like tokens from generateToken(). */
export function isWellFormedToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}
