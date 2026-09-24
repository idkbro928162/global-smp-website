/**
 * Sliding-window rate limiting backed by SQLite, so limits survive restarts.
 * Suitable for the low-volume, security-sensitive endpoints it guards (login,
 * account setup). Not intended for high-throughput public traffic — put a
 * CDN/reverse-proxy limit in front of the public site if that is needed.
 */
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { rateLimitHits } from '../db/schema.ts';

export interface RateLimitRule {
  windowMs: number;
  max: number;
}

export const RULES = {
  loginPerIp: { windowMs: 15 * 60 * 1000, max: 20 },
  loginPerEmail: { windowMs: 15 * 60 * 1000, max: 8 },
  accountTokenPerIp: { windowMs: 15 * 60 * 1000, max: 20 },
  passwordChangePerUser: { windowMs: 15 * 60 * 1000, max: 8 },
  uploadsPerUser: { windowMs: 60 * 60 * 1000, max: 120 },
} as const satisfies Record<string, RateLimitRule>;

export function countHits(db: Db, bucket: string, rule: RateLimitRule, now = Date.now()): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(rateLimitHits)
    .where(and(eq(rateLimitHits.bucket, bucket), gt(rateLimitHits.at, now - rule.windowMs)))
    .get();
  return row?.n ?? 0;
}

export function isRateLimited(db: Db, bucket: string, rule: RateLimitRule, now = Date.now()) {
  return countHits(db, bucket, rule, now) >= rule.max;
}

export function recordHit(db: Db, bucket: string, now = Date.now()): void {
  db.insert(rateLimitHits).values({ bucket, at: now }).run();
  // Opportunistic cleanup keeps the table small without a background job.
  if (Math.random() < 0.02) pruneRateLimits(db, now);
}

export function clearBucket(db: Db, bucket: string): void {
  db.delete(rateLimitHits).where(eq(rateLimitHits.bucket, bucket)).run();
}

export function pruneRateLimits(db: Db, now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000): void {
  db.delete(rateLimitHits)
    .where(lt(rateLimitHits.at, now - maxAgeMs))
    .run();
}
