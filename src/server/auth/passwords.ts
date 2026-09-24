/**
 * Password hashing with scrypt (node:crypto — no native dependency).
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet minimum for scrypt
 * (N=2^17, r=8, p=1). They are stored in each hash so they can be raised later
 * without invalidating existing hashes (`needsRehash`).
 *
 * Format: scrypt$<log2N>$<r>$<p>$<salt b64url>$<hash b64url>
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
export const CURRENT_PARAMS = { log2N: 17, r: 8, p: 1 } as const;

export const PASSWORD_MIN_LENGTH = 12;
// scrypt accepts any length, but capping input bounds the work per request.
export const PASSWORD_MAX_LENGTH = 256;

function scryptAsync(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

function options(log2N: number, r: number, p: number): ScryptOptions {
  const N = 2 ** log2N;
  // Memory needed is ~128 * N * r bytes; allow headroom above Node's 32 MiB default.
  return { N, r, p, maxmem: 256 * N * r + 1024 * 1024 };
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const { log2N, r, p } = CURRENT_PARAMS;
  const key = await scryptAsync(password, salt, options(log2N, r, p));
  return ['scrypt', log2N, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

interface ParsedHash {
  log2N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [log2N, r, p] = parts.slice(1, 4).map((v) => Number.parseInt(v ?? '', 10));
  if (
    log2N === undefined ||
    r === undefined ||
    p === undefined ||
    !Number.isInteger(log2N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    log2N < 10 ||
    log2N > 20 ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16
  ) {
    return null;
  }
  const salt = Buffer.from(parts[4] ?? '', 'base64url');
  const key = Buffer.from(parts[5] ?? '', 'base64url');
  if (salt.length < 8 || key.length !== KEY_LENGTH) return null;
  return { log2N, r, p, salt, key };
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (password.length > PASSWORD_MAX_LENGTH) return false;
  const parsed = stored ? parseHash(stored) : null;
  if (!parsed) {
    // Burn comparable time so unknown/unset accounts are not distinguishable by timing.
    await hashPassword(password);
    return false;
  }
  const candidate = await scryptAsync(
    password,
    parsed.salt,
    options(parsed.log2N, parsed.r, parsed.p),
  );
  return timingSafeEqual(candidate, parsed.key);
}

export function needsRehash(stored: string): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return true;
  return (
    parsed.log2N < CURRENT_PARAMS.log2N ||
    parsed.r < CURRENT_PARAMS.r ||
    parsed.p < CURRENT_PARAMS.p
  );
}

// A short denylist of passwords that satisfy the length rule but are trivially guessed.
const COMMON_PASSWORDS = new Set([
  'password1234',
  'password12345',
  'password123456',
  '123456789012',
  '1234567890123',
  'qwertyuiop12',
  'qwertyuiopasdf',
  'iloveyou1234',
  'administrator',
  'administrator1',
  'letmein12345',
  'welcome12345',
  'changeme1234',
  'minecraft1234',
  'minecraft123456',
  'basedproductions',
  'basedproductions1',
  'based-productions',
]);

/** Returns an error message, or null when the password is acceptable. */
export function checkPasswordPolicy(
  password: string,
  context: { email?: string } = {},
): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
  }
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower) || /^(.)\1+$/.test(password)) {
    return 'This password is too easy to guess. Choose something less common.';
  }
  const email = context.email?.toLowerCase();
  if (email && (lower === email || lower === email.split('@')[0])) {
    return 'Your password must not match your email address.';
  }
  return null;
}
