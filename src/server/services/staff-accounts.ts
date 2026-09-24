/**
 * Staff accounts (people who can sign in to the staff panel).
 *
 * Escalation rules (enforced here, not in the UI):
 *   - Nobody manages their own account through these functions (use the
 *     Account page, which cannot change role or status).
 *   - You can only manage accounts whose permissions you also hold.
 *   - Only owners can manage owner accounts or grant the Owner role.
 *   - You can only assign roles whose permissions you hold.
 *   - The last active owner can never be demoted or disabled.
 */
import { and, asc, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  ForbiddenError,
  NotFoundError,
  assertCan,
  holdsAll,
  type Actor,
} from '../auth/authorization.ts';
import type { Permission } from '../auth/permissions.ts';
import { liveSessionCondition, revokeUserSessions } from '../auth/sessions.ts';
import { nowIso, type Db } from '../db/client.ts';
import { accountTokens, roles, sessions, users, type UserStatus } from '../db/schema.ts';
import { LIMITS, emailSchema, requiredText, validate, type Result } from '../../lib/validation.ts';
import { recordAudit } from './audit.ts';
import { issueAccountToken, type IssuedToken } from './auth.ts';
import type { MutationContext } from './common.ts';
import { rolePermissions } from './roles.ts';

export interface StaffAccount {
  id: number;
  email: string;
  displayName: string;
  status: UserStatus;
  role: { id: number; name: string; isOwner: boolean; permissions: Permission[] };
  lastLoginAt: string | null;
  createdAt: string;
  activeSessions: number;
  hasPendingLink: boolean;
}

function loadAccounts(db: Db, where?: SQL): StaffAccount[] {
  const rows = db
    .select({ user: users, role: roles })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(where)
    .orderBy(asc(users.displayName))
    .all();
  const sessionCounts = new Map(
    db
      .select({ userId: sessions.userId, n: sql<number>`count(*)` })
      .from(sessions)
      .where(liveSessionCondition())
      .groupBy(sessions.userId)
      .all()
      .map((r) => [r.userId, r.n]),
  );
  const pending = new Set(
    db
      .select({ userId: accountTokens.userId })
      .from(accountTokens)
      .where(and(isNull(accountTokens.usedAt), sql`${accountTokens.expiresAt} > ${nowIso()}`))
      .all()
      .map((r) => r.userId),
  );
  return rows.map(({ user, role }) => ({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    role: {
      id: role.id,
      name: role.name,
      isOwner: role.isOwner,
      permissions: rolePermissions(role),
    },
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    activeSessions: sessionCounts.get(user.id) ?? 0,
    hasPendingLink: pending.has(user.id),
  }));
}

export function listStaffAccounts(db: Db, actor: Actor): StaffAccount[] {
  assertCan(actor, 'staff.manage');
  return loadAccounts(db);
}

export function getStaffAccount(db: Db, actor: Actor, id: number): StaffAccount {
  assertCan(actor, 'staff.manage');
  const account = loadAccounts(db, eq(users.id, id))[0];
  if (!account) throw new NotFoundError();
  return account;
}

/** Why the actor may not manage this account, or null if they may. */
export function accountManageBlocker(actor: Actor, target: StaffAccount): string | null {
  if (target.id === actor.id)
    return 'You cannot change your own account here. Use Account settings.';
  if (target.role.isOwner && !actor.role.isOwner) return 'Only owners can manage owner accounts.';
  if (!holdsAll(actor, target.role.permissions)) {
    return 'This account has permissions you do not hold, so you cannot manage it.';
  }
  return null;
}

/** Why the actor may not assign this role, or null if they may. */
export function roleAssignBlocker(
  actor: Actor,
  role: { isOwner: boolean; permissions: readonly Permission[] },
): string | null {
  if (role.isOwner && !actor.role.isOwner) return 'Only owners can grant the Owner role.';
  if (!holdsAll(actor, role.permissions))
    return 'You can only assign roles whose permissions you hold.';
  return null;
}

function loadRole(db: Db, roleId: number) {
  const row = db.select().from(roles).where(eq(roles.id, roleId)).get();
  return row ? { ...row, permissions: rolePermissions(row) } : null;
}

function activeOwnerCount(db: Db, excludingUserId?: number): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(
        and(
          eq(roles.isOwner, true),
          eq(users.status, 'active'),
          excludingUserId ? ne(users.id, excludingUserId) : undefined,
        ),
      )
      .get()?.n ?? 0
  );
}

function manageable(db: Db, ctx: MutationContext, id: number): StaffAccount {
  assertCan(ctx.actor, 'staff.manage');
  const target = getStaffAccount(db, ctx.actor, id);
  const blocker = accountManageBlocker(ctx.actor, target);
  if (blocker) throw new ForbiddenError(blocker);
  return target;
}

export const inviteSchema = z.object({
  email: emailSchema,
  displayName: requiredText(LIMITS.name, 'Display name'),
  roleId: z.coerce.number('Choose a role.').int('Choose a role.').positive('Choose a role.'),
});

export function inviteStaff(
  db: Db,
  ctx: MutationContext,
  input: unknown,
): Result<{ userId: number; link: IssuedToken }> {
  assertCan(ctx.actor, 'staff.manage');
  const parsed = validate(inviteSchema, input);
  if (!parsed.ok) return parsed;
  const role = loadRole(db, parsed.value.roleId);
  if (!role) return { ok: false, errors: { roleId: 'Choose a role.' } };
  const blocker = roleAssignBlocker(ctx.actor, role);
  if (blocker) return { ok: false, errors: { roleId: blocker } };
  const exists = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, parsed.value.email))
    .get();
  if (exists)
    return { ok: false, errors: { email: 'A staff account with this email already exists.' } };

  const at = nowIso();
  const user = db
    .insert(users)
    .values({
      email: parsed.value.email,
      displayName: parsed.value.displayName,
      passwordHash: null,
      roleId: role.id,
      status: 'invited',
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: users.id })
    .get();
  const link = issueAccountToken(db, user.id, 'setup', ctx.actor.id);
  recordAudit(db, {
    actor: ctx.actor,
    action: 'staff.invite',
    target: { type: 'user', id: user.id, label: parsed.value.email },
    details: { role: role.name },
    ip: ctx.ip,
  });
  return { ok: true, value: { userId: user.id, link } };
}

export function changeStaffRole(
  db: Db,
  ctx: MutationContext,
  userId: number,
  roleIdInput: unknown,
): Result<null> {
  const target = manageable(db, ctx, userId);
  const roleId = Number(roleIdInput);
  const role = Number.isInteger(roleId) ? loadRole(db, roleId) : null;
  if (!role) return { ok: false, errors: { roleId: 'Choose a role.' } };
  if (role.id === target.role.id) return { ok: true, value: null };
  const blocker = roleAssignBlocker(ctx.actor, role);
  if (blocker) return { ok: false, errors: { roleId: blocker } };
  if (
    target.role.isOwner &&
    !role.isOwner &&
    target.status === 'active' &&
    activeOwnerCount(db, target.id) === 0
  ) {
    return {
      ok: false,
      errors: { roleId: 'The last active owner cannot be moved to another role.' },
    };
  }
  db.update(users).set({ roleId: role.id, updatedAt: nowIso() }).where(eq(users.id, userId)).run();
  recordAudit(db, {
    actor: ctx.actor,
    action: 'staff.role_change',
    target: { type: 'user', id: userId, label: target.email },
    details: { from: target.role.name, to: role.name },
    ip: ctx.ip,
  });
  return { ok: true, value: null };
}

export function setStaffDisabled(
  db: Db,
  ctx: MutationContext,
  userId: number,
  disabled: boolean,
): Result<null> {
  const target = manageable(db, ctx, userId);
  if (disabled) {
    if (target.status === 'disabled') return { ok: true, value: null };
    if (
      target.role.isOwner &&
      target.status === 'active' &&
      activeOwnerCount(db, target.id) === 0
    ) {
      return { ok: false, errors: { _form: 'The last active owner cannot be disabled.' } };
    }
    db.transaction((tx) => {
      tx.update(users)
        .set({ status: 'disabled', updatedAt: nowIso() })
        .where(eq(users.id, userId))
        .run();
      tx.delete(accountTokens).where(eq(accountTokens.userId, userId)).run();
    });
    revokeUserSessions(db, userId);
  } else {
    if (target.status !== 'disabled') return { ok: true, value: null };
    const hasPassword = db
      .select({ hash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .get()?.hash;
    const status: UserStatus = hasPassword ? 'active' : 'invited';
    db.update(users).set({ status, updatedAt: nowIso() }).where(eq(users.id, userId)).run();
  }
  recordAudit(db, {
    actor: ctx.actor,
    action: disabled ? 'staff.disable' : 'staff.enable',
    target: { type: 'user', id: userId, label: target.email },
    ip: ctx.ip,
  });
  return { ok: true, value: null };
}

/**
 * Issues a one-time link: an account setup link for invited accounts, a
 * password reset link otherwise. The raw link is returned once to be shared
 * privately; it is never stored or written to the audit log.
 */
export function issueStaffLink(db: Db, ctx: MutationContext, userId: number): Result<IssuedToken> {
  const target = manageable(db, ctx, userId);
  if (target.status === 'disabled') {
    return { ok: false, errors: { _form: 'Enable this account before issuing a link.' } };
  }
  const link = issueAccountToken(
    db,
    userId,
    target.status === 'invited' ? 'setup' : 'reset',
    ctx.actor.id,
  );
  recordAudit(db, {
    actor: ctx.actor,
    action: link.purpose === 'setup' ? 'staff.setup_link' : 'staff.reset_link',
    target: { type: 'user', id: userId, label: target.email },
    ip: ctx.ip,
  });
  return { ok: true, value: link };
}

export function revokeStaffSessions(db: Db, ctx: MutationContext, userId: number): number {
  const target = manageable(db, ctx, userId);
  const revoked = revokeUserSessions(db, userId);
  recordAudit(db, {
    actor: ctx.actor,
    action: 'staff.sessions_revoked',
    target: { type: 'user', id: userId, label: target.email },
    details: { revoked },
    ip: ctx.ip,
  });
  return revoked;
}

/** Deletes an invitation that was never accepted (e.g. a mistyped email). */
export function deleteInvitedAccount(db: Db, ctx: MutationContext, userId: number): Result<null> {
  const target = manageable(db, ctx, userId);
  if (target.status !== 'invited') {
    return {
      ok: false,
      errors: {
        _form: 'Only unaccepted invitations can be deleted. Disable active accounts instead.',
      },
    };
  }
  db.delete(users).where(eq(users.id, userId)).run();
  recordAudit(db, {
    actor: ctx.actor,
    action: 'staff.invite_deleted',
    target: { type: 'user', id: userId, label: target.email },
    ip: ctx.ip,
  });
  return { ok: true, value: null };
}

/**
 * Bootstrap: creates an invited Owner account from the server command line.
 * Server shell access is the root of trust for the staff platform.
 */
export function createOwnerInvite(
  db: Db,
  input: { email: unknown; displayName: unknown },
): Result<{ userId: number; link: IssuedToken; existingOwners: number }> {
  const parsed = validate(inviteSchema.omit({ roleId: true }), input);
  if (!parsed.ok) return parsed;
  const ownerRole = db.select().from(roles).where(eq(roles.isOwner, true)).get();
  if (!ownerRole) throw new Error('Owner role is missing from the database.');
  const exists = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, parsed.value.email))
    .get();
  if (exists)
    return { ok: false, errors: { email: 'A staff account with this email already exists.' } };
  const existingOwners = activeOwnerCount(db);
  const at = nowIso();
  const user = db
    .insert(users)
    .values({
      email: parsed.value.email,
      displayName: parsed.value.displayName,
      passwordHash: null,
      roleId: ownerRole.id,
      status: 'invited',
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: users.id })
    .get();
  const link = issueAccountToken(db, user.id, 'setup', null);
  recordAudit(db, {
    actor: { label: 'system (command line)' },
    action: 'staff.owner_bootstrap',
    target: { type: 'user', id: user.id, label: parsed.value.email },
  });
  return { ok: true, value: { userId: user.id, link, existingOwners } };
}
