/**
 * Shared input validation. Every write path in src/server/services validates
 * its input with these schemas; nothing trusts form data directly.
 */
import { z } from 'zod';

export const LIMITS = {
  name: 80,
  shortText: 120,
  tagline: 180,
  summary: 300,
  section: 60,
  email: 254,
  url: 500,
  version: 40,
  markdown: 100_000,
  docBody: 200_000,
  featureTitle: 80,
  featureBody: 300,
  maxFeatures: 16,
  maxMinecraftVersions: 40,
  maxLinks: 6,
  maxScreenshots: 12,
} as const;

/** Slugs that would collide with fixed routes or reserved collection names. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'new',
  'edit',
  'delete',
  'general',
  'index',
  'staff',
  'media',
  'api',
]);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'Use at least 2 characters.')
  .max(64, 'Use at most 64 characters.')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens.')
  .refine((slug) => !RESERVED_SLUGS.has(slug), 'This slug is reserved. Choose another.');

/**
 * A URL slug derived from a name, e.g. "Anti ESP" → "anti-esp". Returns an
 * empty string when the name has no usable characters.
 */
export function slugFromName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
}

export function requiredText(max: number, label = 'This field') {
  return z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `Use at most ${max} characters.`);
}

export function optionalText(max: number) {
  return z.string().trim().max(max, `Use at most ${max} characters.`);
}

/**
 * Returns a human-readable problem with an external link, or null if valid.
 * Only https links without embedded credentials are accepted; `hosts`
 * restricts the link to those domains (and their subdomains).
 */
export function urlProblem(value: string, hosts?: readonly string[]): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Enter a full link starting with https://';
  }
  if (url.protocol !== 'https:') return 'Use a secure https:// link.';
  if (url.username || url.password) return 'Links must not contain a username or password.';
  if (hosts && hosts.length > 0) {
    const host = url.hostname.toLowerCase();
    const allowed = hosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!allowed) return `The link must point to ${hosts.join(' or ')}.`;
  }
  return null;
}

/** Optional https URL: the empty string means "not set". */
export function optionalUrl(hosts?: readonly string[]) {
  return z
    .string()
    .trim()
    .max(LIMITS.url, `Use at most ${LIMITS.url} characters.`)
    .superRefine((value, ctx) => {
      if (!value) return;
      const problem = urlProblem(value, hosts);
      if (problem) ctx.addIssue({ code: 'custom', message: problem });
    });
}

/**
 * Read-side guard for stored links: returns the URL only if it still passes
 * `urlProblem`, otherwise ''. Writes are validated already; this keeps a
 * hand-edited or corrupted row from ever reaching an href as e.g. javascript:.
 */
export function safeStoredUrl(value: string | null | undefined, hosts?: readonly string[]): string {
  return value && urlProblem(value, hosts) === null ? value : '';
}

export const BUILTBYBIT_HOSTS = ['builtbybit.com'] as const;
export const DISCORD_HOSTS = ['discord.gg', 'discord.com'] as const;

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const isoDateSchema = z
  .string()
  .trim()
  .refine(isValidIsoDate, 'Enter a valid date (YYYY-MM-DD).');

export const optionalIsoDateSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || isValidIsoDate(v), 'Enter a valid date (YYYY-MM-DD).');

/**
 * Minecraft Java Edition version tokens: "1.20.4", "1.21.x", "1.21+" and the
 * year-based scheme introduced in 2026 ("26.1", "26.1.2").
 */
export const MINECRAFT_VERSION = /^\d{1,3}\.\d{1,3}(?:\.(?:\d{1,3}|x))?\+?$/;

/** Release versions: semver-like, e.g. "1.4.0", "2.0.0-beta.2", "v3". */
export const releaseVersionSchema = z
  .string()
  .trim()
  .min(1, 'Version is required.')
  .max(LIMITS.version, `Use at most ${LIMITS.version} characters.`)
  .regex(
    /^[0-9A-Za-z](?:[0-9A-Za-z.+_-]*[0-9A-Za-z])?$/,
    'Use letters, numbers, dots, hyphens, plus signs or underscores.',
  );

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(LIMITS.email, 'Email address is too long.')
  .pipe(z.email('Enter a valid email address.'));

export type FieldErrors = Record<string, string>;
export type Result<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

export function toFieldErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || '_form';
    errors[key] ??= issue.message;
  }
  return errors;
}

export function validate<T>(schema: z.ZodType<T>, input: unknown): Result<T> {
  const parsed = schema.safeParse(input);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: toFieldErrors(parsed.error) };
}

/** Parses JSON text that should hold an array, returning [] for anything malformed. */
export function parseJsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
