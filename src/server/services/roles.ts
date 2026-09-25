/**
 * Roles: named permission sets.
 *
 * Escalation rules (enforced here, not in the UI):
 *   - You can only create or edit a role to contain permissions you hold.
 *   - You cannot edit or delete a role that holds permissions you lack.
 *   - You cannot edit or delete your own role (prevents self-escalation and
 *     accidental self-lockout).
 *   - The Owner role cannot be edited or deleted by anyone.
 *   - A role with members cannot be deleted.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ForbiddenError,
  NotFoundError,
  assertCan,
  holdsAll,
  type Actor,
} from '../auth/authorization.ts';
import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  parsePermissionList,
  type Permission,
} from '../auth/permissions.ts';
import { nowIso, type Db } from '../db/client.ts';
import { roles, users } from '../db/schema.ts';
import { optionalText, requiredText, validate, type Result } from '../../lib/validation.ts';
import { recordAudit } from './audit.ts';
import { assertCanAny, isUniqueViolation, type MutationContext } from './common.ts';

export interface RoleView {
  id: number;
  name: string;
  description: string;
  isOwner: boolean;
  permissions: Permission[];
  memberCount: number;
}

type RoleRow = typeof roles.$inferSelect;

export function rolePermissions(role: Pick<RoleRow, 'isOwner' | 'permissions'>): Permission[] {
  return role.isOwner ? [...ALL_PERMISSIONS] : parsePermissionList(role.permissions);
}

function memberCounts(db: Db): Map<number, number> {
  const rows = db
    .select({ roleId: users.roleId, n: sql<number>`count(*)` })
    .from(users)
    .groupBy(users.roleId)
    .all();
  return new Map(rows.map((r) => [r.roleId, r.n]));
}

function toView(row: RoleRow, counts: Map<number, number>): RoleView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isOwner: row.isOwner,
    permissions: rolePermissions(row),
    memberCount: counts.get(row.id) ?? 0,
  };
}

/** Roles are listed for role management and for choosing a role when managing staff. */
export function listRoles(db: Db, actor: Actor): RoleView[] {
  assertCanAny(actor, ['roles.manage', 'staff.manage']);
  const counts = memberCounts(db);
  return db
    .select()
    .from(roles)
    .orderBy(sql`${roles.isOwner} DESC`, asc(roles.name))
    .all()
    .map((row) => toView(row, counts));
}

export function getRole(db: Db, actor: Actor, id: number): RoleView {
  assertCan(actor, 'roles.manage');
  const row = db.select().from(roles).where(eq(roles.id, id)).get();
  if (!row) throw new NotFoundError();
  return toView(row, memberCounts(db));
}

/** Why the actor may not edit/delete this role, or null if they may. */
export function roleEditBlocker(
  actor: Actor,
  role: Pick<RoleView, 'id' | 'isOwner' | 'permissions'>,
) {
  if (role.isOwner) return 'The Owner role cannot be changed.';
  if (role.id === actor.role.id) return 'You cannot change your own role.';
  if (!holdsAll(actor, role.permissions)) {
    return 'This role has permissions you do not hold, so you cannot change it.';
  }
  return null;
}

const PERMISSION_KEYS = ALL_PERMISSIONS as [Permission, ...Permission[]];

export const roleInputSchema = z.object({
  name: requiredText(40, 'Name'),
  description: optionalText(200),
  permissions: z.array(z.enum(PERMISSION_KEYS, 'Unknown permission.')),
});

function grantProblem(actor: Actor, permissions: Permission[]): string | null {
  const missing = permissions.filter((p) => !actor.permissions.has(p));
  if (missing.length === 0) return null;
  return `You can only grant permissions you hold. Remove: ${missing
    .map((p) => PERMISSIONS[p].label)
    .join(', ')}.`;
}

const NAME_TAKEN = { name: 'Another role already has this name.' };

export function createRole(db: Db, ctx: MutationContext, input: unknown): Result<{ id: number }> {
  assertCan(ctx.actor, 'roles.manage');
  const parsed = validate(roleInputSchema, input);
  if (!parsed.ok) return parsed;
  const permissions = [...new Set(parsed.value.permissions)];
  const problem = grantProblem(ctx.actor, permissions);
  if (problem) return { ok: false, errors: { permissions: problem } };
  const at = nowIso();
  try {
    const row = db
      .insert(roles)
      .values({
        name: parsed.value.name,
        description: parsed.value.description,
        permissions: JSON.stringify(permissions),
        isOwner: false,
        createdAt: at,
        updatedAt: at,
      })
      .returning({ id: roles.id })
      .get();
    recordAudit(db, {
      actor: ctx.actor,
      action: 'role.create',
      target: { type: 'role', id: row.id, label: parsed.value.name },
      details: { permissions },
      ip: ctx.ip,
    });
    return { ok: true, value: { id: row.id } };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, errors: NAME_TAKEN };
    throw error;
  }
}

export function updateRole(
  db: Db,
  ctx: MutationContext,
  id: number,
  input: unknown,
): Result<{ id: number }> {
  assertCan(ctx.actor, 'roles.manage');
  const existing = getRole(db, ctx.actor, id);
  const blocker = roleEditBlocker(ctx.actor, existing);
  if (blocker) throw new ForbiddenError(blocker);
  const parsed = validate(roleInputSchema, input);
  if (!parsed.ok) return parsed;
  const permissions = [...new Set(parsed.value.permissions)];
  const problem = grantProblem(ctx.actor, permissions);
  if (problem) return { ok: false, errors: { permissions: problem } };
  try {
    db.update(roles)
      .set({
        name: parsed.value.name,
        description: parsed.value.description,
        permissions: JSON.stringify(permissions),
        updatedAt: nowIso(),
      })
      .where(eq(roles.id, id))
      .run();
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, errors: NAME_TAKEN };
    throw error;
  }
  recordAudit(db, {
    actor: ctx.actor,
    action: 'role.update',
    target: { type: 'role', id, label: parsed.value.name },
    details: {
      added: permissions.filter((p) => !existing.permissions.includes(p)),
      removed: existing.permissions.filter((p) => !permissions.includes(p)),
      renamed: existing.name !== parsed.value.name ? true : undefined,
    },
    ip: ctx.ip,
  });
  return { ok: true, value: { id } };
}

export function deleteRole(db: Db, ctx: MutationContext, id: number): Result<null> {
  assertCan(ctx.actor, 'roles.manage');
  const existing = getRole(db, ctx.actor, id);
  const blocker = roleEditBlocker(ctx.actor, existing);
  if (blocker) throw new ForbiddenError(blocker);
  if (existing.memberCount > 0) {
    return {
      ok: false,
      errors: { _form: 'Move every member to another role before deleting this role.' },
    };
  }
  db.delete(roles).where(eq(roles.id, id)).run();
  recordAudit(db, {
    actor: ctx.actor,
    action: 'role.delete',
    target: { type: 'role', id, label: existing.name },
    ip: ctx.ip,
  });
  return { ok: true, value: null };
}
