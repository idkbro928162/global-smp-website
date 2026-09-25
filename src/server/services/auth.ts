/**
 * Staff authentication flows: sign-in, sign-out, one-time account links
 * (initial setup / password reset) and changing your own password.
 *
 * There is no self-registration and no default account. The first owner is
 * created from the server command line (scripts/create-owner.ts), which prints
 * a one-time setup link; every later account is invited from the staff panel.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  checkPasswordPolicy,
  hashPassword,
  needsRehash,
  PASSWORD_MAX_LENGTH,
  verifyPassword,
} from '../auth/passwords.ts';
import {
  createSession,
  purgeExpiredSessions,
  revokeSessionById,
  revokeUserSessions,
  type NewSession,
} from '../auth/sessions.ts';
import { generateToken, hashToken, isWellFormedToken } from '../auth/tokens.ts';
import { nowIso, type Db } from '../db/client.ts';
import { accountTokens, users, type TokenPurpose } from '../db/schema.ts';
import { RULES, clearBucket, isRateLimited, recordHit } from '../security/rate-limit.ts';
import { LIMITS, requiredText, validate, type Result } from '../../lib/validation.ts';
import { recordAudit } from './audit.ts';
import type { MutationContext } from './common.ts';

export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  setup: 72 * 60 * 60 * 1000,
  reset: 24 * 60 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Sign in / out
// ---------------------------------------------------------------------------

export type LoginResult =
  { ok: true; session: NewSession } | { ok: false; reason: 'invalid' | 'rate_limited' };

export async function login(
  db: Db,
  input: { email: unknown; password: unknown; ip: string; userAgent?: string | null },
  now: Date = new Date(),
): Promise<LoginResult> {
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  const ipBucket = `login:ip:${input.ip}`;
  const emailBucket = `login:email:${email.slice(0, LIMITS.email)}`;
  const nowMs = now.getTime();

  if (
    isRateLimited(db, ipBucket, RULES.loginPerIp, nowMs) ||
    isRateLimited(db, emailBucket, RULES.loginPerEmail, nowMs)
  ) {
    return { ok: false, reason: 'rate_limited' };
  }

  const user =
    email && email.length <= LIMITS.email
      ? db.select().from(users).where(eq(users.email, email)).get()
      : undefined;
  // verifyPassword does equivalent work for missing users/hashes (timing parity).
  const passwordOk =
    password.length > 0 && password.length <= PASSWORD_MAX_LENGTH
      ? await verifyPassword(password, user?.passwordHash ?? null)
      : false;

  if (!user || !passwordOk || user.status !== 'active') {
    recordHit(db, ipBucket, nowMs);
    recordHit(db, emailBucket, nowMs);
    if (user) {
      // Only attempts against real accounts are audited, to keep noise bounded.
      recordAudit(
        db,
        {
          actor: { label: user.email },
          action: 'auth.login_failed',
          target: { type: 'user', id: user.id, label: user.email },
          details: user.status !== 'active' ? { status: user.status } : undefined,
          ip: input.ip,
        },
        now,
      );
    }
    return { ok: false, reason: 'invalid' };
  }

  clearBucket(db, emailBucket);
  purgeExpiredSessions(db, now);
  const session = createSession(db, user.id, { ip: input.ip, userAgent: input.userAgent }, now);
  const updates: Partial<typeof users.$inferInsert> = { lastLoginAt: nowIso(now) };
  if (user.passwordHash && needsRehash(user.passwordHash)) {
    updates.passwordHash = await hashPassword(password);
  }
  db.update(users).set(updates).where(eq(users.id, user.id)).run();
  recordAudit(
    db,
    {
      actor: { label: user.email },
      action: 'auth.login',
      target: { type: 'user', id: user.id, label: user.email },
      ip: input.ip,
    },
    now,
  );
  return { ok: true, session };
}

export function logout(db: Db, ctx: MutationContext, sessionId: string): void {
  revokeSessionById(db, sessionId);
  recordAudit(db, {
    actor: ctx.actor,
    action: 'auth.logout',
    target: { type: 'user', id: ctx.actor.id, label: ctx.actor.email },
    ip: ctx.ip,
  });
}

// ---------------------------------------------------------------------------
// One-time account links (setup + reset)
// ---------------------------------------------------------------------------

export interface IssuedToken {
  token: string;
  purpose: TokenPurpose;
  expiresAt: Date;
}

/**
 * Issues a one-time link token for a user. Any earlier unused tokens for the
 * user are invalidated, so only the most recent link works.
 */
export function issueAccountToken(
  db: Db,
  userId: number,
  purpose: TokenPurpose,
  createdBy: number | null,
  now: Date = new Date(),
): IssuedToken {
  const token = generateToken();
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS[purpose]);
  db.transaction((tx) => {
    tx.delete(accountTokens)
      .where(and(eq(accountTokens.userId, userId), isNull(accountTokens.usedAt)))
      .run();
    tx.insert(accountTokens)
      .values({
        id: hashToken(token),
        userId,
        purpose,
        createdBy,
        createdAt: nowIso(now),
        expiresAt: nowIso(expiresAt),
      })
      .run();
  });
  return { token, purpose, expiresAt };
}

export interface TokenTarget {
  tokenId: string;
  userId: number;
  email: string;
  displayName: string;
  purpose: TokenPurpose;
}

/** Resolves a raw token to its (valid, unused, unexpired) target, or null. */
export function inspectAccountToken(
  db: Db,
  token: unknown,
  now: Date = new Date(),
): TokenTarget | null {
  if (!isWellFormedToken(token)) return null;
  const row = db
    .select({ token: accountTokens, user: users })
    .from(accountTokens)
    .innerJoin(users, eq(users.id, accountTokens.userId))
    .where(eq(accountTokens.id, hashToken(token)))
    .get();
  if (!row) return null;
  if (row.token.usedAt || Date.parse(row.token.expiresAt) <= now.getTime()) return null;
  if (row.user.status === 'disabled') return null;
  return {
    tokenId: row.token.id,
    userId: row.user.id,
    email: row.user.email,
    displayName: row.user.displayName,
    purpose: row.token.purpose,
  };
}

export type CompleteTokenResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'invalid_token' | 'rate_limited' }
  | { ok: false; reason: 'invalid_input'; errors: Record<string, string> };

export async function completeAccountToken(
  db: Db,
  input: { token: unknown; password: unknown; confirm: unknown; ip: string },
  now: Date = new Date(),
): Promise<CompleteTokenResult> {
  const bucket = `account-token:ip:${input.ip}`;
  if (isRateLimited(db, bucket, RULES.accountTokenPerIp, now.getTime())) {
    return { ok: false, reason: 'rate_limited' };
  }
  recordHit(db, bucket, now.getTime());
  const target = inspectAccountToken(db, input.token, now);
  if (!target) return { ok: false, reason: 'invalid_token' };

  const password = typeof input.password === 'string' ? input.password : '';
  const confirm = typeof input.confirm === 'string' ? input.confirm : '';
  const problem = checkPasswordPolicy(password, { email: target.email });
  if (problem) return { ok: false, reason: 'invalid_input', errors: { password: problem } };
  if (password !== confirm) {
    return {
      ok: false,
      reason: 'invalid_input',
      errors: { confirm: 'The passwords do not match.' },
    };
  }

  const passwordHash = await hashPassword(password);
  const at = nowIso(now);
  const consumed = db.transaction((tx) => {
    // Mark used only if still unused: a concurrent submission cannot reuse it.
    const marked = tx
      .update(accountTokens)
      .set({ usedAt: at })
      .where(and(eq(accountTokens.id, target.tokenId), isNull(accountTokens.usedAt)))
      .run().changes;
    if (marked !== 1) return false;
    tx.update(users)
      .set({ passwordHash, status: 'active', passwordChangedAt: at, updatedAt: at })
      .where(eq(users.id, target.userId))
      .run();
    return true;
  });
  if (!consumed) return { ok: false, reason: 'invalid_token' };

  revokeUserSessions(db, target.userId);
  recordAudit(
    db,
    {
      actor: { label: target.email },
      action: target.purpose === 'setup' ? 'auth.account_setup' : 'auth.password_reset',
      target: { type: 'user', id: target.userId, label: target.email },
      ip: input.ip,
    },
    now,
  );
  return { ok: true, email: target.email };
}

// ---------------------------------------------------------------------------
// Own account
// ---------------------------------------------------------------------------

export async function changeOwnPassword(
  db: Db,
  ctx: MutationContext & { sessionId: string },
  input: { current: unknown; next: unknown; confirm: unknown },
): Promise<Result<null>> {
  const bucket = `password-change:user:${ctx.actor.id}`;
  if (isRateLimited(db, bucket, RULES.passwordChangePerUser)) {
    return { ok: false, errors: { current: 'Too many attempts. Try again in a few minutes.' } };
  }
  recordHit(db, bucket);
  const current = typeof input.current === 'string' ? input.current : '';
  const next = typeof input.next === 'string' ? input.next : '';
  const confirm = typeof input.confirm === 'string' ? input.confirm : '';
  const user = db.select().from(users).where(eq(users.id, ctx.actor.id)).get();
  if (!user || !(await verifyPassword(current, user.passwordHash))) {
    return { ok: false, errors: { current: 'Your current password is incorrect.' } };
  }
  const problem = checkPasswordPolicy(next, { email: user.email });
  if (problem) return { ok: false, errors: { next: problem } };
  if (next === current) {
    return { ok: false, errors: { next: 'Choose a password different from your current one.' } };
  }
  if (next !== confirm) return { ok: false, errors: { confirm: 'The passwords do not match.' } };

  const at = nowIso();
  db.update(users)
    .set({ passwordHash: await hashPassword(next), passwordChangedAt: at, updatedAt: at })
    .where(eq(users.id, user.id))
    .run();
  const revoked = revokeUserSessions(db, user.id, ctx.sessionId);
  recordAudit(db, {
    actor: ctx.actor,
    action: 'auth.password_change',
    target: { type: 'user', id: user.id, label: user.email },
    details: { otherSessionsRevoked: revoked },
    ip: ctx.ip,
  });
  return { ok: true, value: null };
}

const profileSchema = z.object({ displayName: requiredText(LIMITS.name, 'Display name') });

export function updateOwnProfile(db: Db, ctx: MutationContext, input: unknown): Result<null> {
  const parsed = validate(profileSchema, input);
  if (!parsed.ok) return parsed;
  db.update(users)
    .set({ displayName: parsed.value.displayName, updatedAt: nowIso() })
    .where(eq(users.id, ctx.actor.id))
    .run();
  recordAudit(db, {
    actor: ctx.actor,
    action: 'account.profile_update',
    target: { type: 'user', id: ctx.actor.id, label: ctx.actor.email },
    ip: ctx.ip,
  });
  return { ok: true, value: null };
}

export function signOutOtherSessions(db: Db, ctx: MutationContext & { sessionId: string }): number {
  const revoked = revokeUserSessions(db, ctx.actor.id, ctx.sessionId);
  recordAudit(db, {
    actor: ctx.actor,
    action: 'account.sessions_revoked',
    target: { type: 'user', id: ctx.actor.id, label: ctx.actor.email },
    details: { revoked },
    ip: ctx.ip,
  });
  return revoked;
}
