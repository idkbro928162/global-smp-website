/**
 * Database-backed staff sessions.
 *
 * - The cookie holds a random 256-bit token; the database stores only its
 *   SHA-256 digest, so a leaked database cannot be replayed as sessions.
 * - Sessions have an idle timeout and an absolute lifetime.
 * - The user's status, role and permissions are re-read on every request, so
 *   disabling an account or changing a role takes effect immediately.
 * - Each session carries its own CSRF token (see security/request-guard.ts).
 */
import { and, eq, gt, lt, ne, or } from 'drizzle-orm';
import { getConfig } from '../config.ts';
import { nowIso, type Db } from '../db/client.ts';
import { roles, sessions, users } from '../db/schema.ts';
import { effectivePermissions, type Actor } from './authorization.ts';
import { parsePermissionList } from './permissions.ts';
import { generateToken, hashToken, isWellFormedToken } from './tokens.ts';

export const SESSION_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function sessionCookieName(): string {
  // __Host- cookies must be Secure, host-only and Path=/, which prevents
  // subdomains or plain-HTTP responses from planting or overwriting them.
  return getConfig().secure ? '__Host-bp_session' : 'bp_session';
}

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    secure: getConfig().secure,
    sameSite: 'lax' as const,
    path: '/',
    expires,
  };
}

/**
 * Attributes for deleting the session cookie. They must match the ones it was
 * set with: browsers ignore a `__Host-` cookie (even an expired one) that is
 * not `Secure` with `Path=/`, so deleting without them leaves it in place.
 */
export function sessionCookieDeleteOptions() {
  return {
    httpOnly: true,
    secure: getConfig().secure,
    sameSite: 'lax' as const,
    path: '/',
  };
}

export interface NewSession {
  token: string;
  sessionId: string;
  csrfToken: string;
  expiresAt: Date;
}

export function createSession(
  db: Db,
  userId: number,
  meta: { ip?: string | null; userAgent?: string | null },
  now: Date = new Date(),
): NewSession {
  const token = generateToken();
  const sessionId = hashToken(token);
  const csrfToken = generateToken();
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_TIMEOUT_MS);
  db.insert(sessions)
    .values({
      id: sessionId,
      userId,
      csrfToken,
      createdAt: nowIso(now),
      lastSeenAt: nowIso(now),
      expiresAt: nowIso(expiresAt),
      ip: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
    })
    .run();
  return { token, sessionId, csrfToken, expiresAt };
}

export interface ResolvedSession {
  sessionId: string;
  csrfToken: string;
  expiresAt: Date;
  actor: Actor;
}

export function resolveSession(
  db: Db,
  token: string | undefined | null,
  now: Date = new Date(),
): ResolvedSession | null {
  if (!isWellFormedToken(token)) return null;
  const sessionId = hashToken(token);
  const row = db
    .select({
      session: sessions,
      user: users,
      role: roles,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(sessions.id, sessionId))
    .get();
  if (!row) return null;

  const nowMs = now.getTime();
  const expired = Date.parse(row.session.expiresAt) <= nowMs;
  const idle = Date.parse(row.session.lastSeenAt) + SESSION_IDLE_TIMEOUT_MS <= nowMs;
  const unusable = row.user.status !== 'active' || !row.user.passwordHash;
  if (expired || idle || unusable) {
    db.delete(sessions).where(eq(sessions.id, sessionId)).run();
    return null;
  }

  if (Date.parse(row.session.lastSeenAt) + TOUCH_INTERVAL_MS <= nowMs) {
    db.update(sessions)
      .set({ lastSeenAt: nowIso(now) })
      .where(eq(sessions.id, sessionId))
      .run();
  }

  return {
    sessionId,
    csrfToken: row.session.csrfToken,
    expiresAt: new Date(row.session.expiresAt),
    actor: {
      id: row.user.id,
      email: row.user.email,
      displayName: row.user.displayName,
      role: { id: row.role.id, name: row.role.name, isOwner: row.role.isOwner },
      permissions: effectivePermissions(
        row.role.isOwner,
        parsePermissionList(row.role.permissions),
      ),
    },
  };
}

export function revokeSessionById(db: Db, sessionId: string): void {
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

/** Revokes all of a user's sessions, optionally keeping one (e.g. the current session). */
export function revokeUserSessions(db: Db, userId: number, exceptSessionId?: string): number {
  const where = exceptSessionId
    ? and(eq(sessions.userId, userId), ne(sessions.id, exceptSessionId))
    : eq(sessions.userId, userId);
  return db.delete(sessions).where(where).run().changes;
}

/** SQL condition matching sessions that are still usable at `now` (not expired, not idle). */
export function liveSessionCondition(now: Date = new Date()) {
  return and(
    gt(sessions.expiresAt, nowIso(now)),
    gt(sessions.lastSeenAt, nowIso(new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS))),
  );
}

export function countUserSessions(db: Db, userId: number, now: Date = new Date()): number {
  return db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), liveSessionCondition(now)))
    .all().length;
}

export function purgeExpiredSessions(db: Db, now: Date = new Date()): void {
  const idleCutoff = nowIso(new Date(now.getTime() - SESSION_IDLE_TIMEOUT_MS));
  db.delete(sessions)
    .where(or(lt(sessions.expiresAt, nowIso(now)), lt(sessions.lastSeenAt, idleCutoff)))
    .run();
}
