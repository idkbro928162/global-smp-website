/**
 * Server-side authorization primitives.
 *
 * An `Actor` is only ever constructed from a validated session (sessions.ts)
 * with its role and permissions loaded from the database on every request.
 * Nothing supplied by the client — form fields, headers, query parameters —
 * is ever used as an authorization input.
 */
import { ALL_PERMISSIONS, type Permission } from './permissions.ts';

export interface Actor {
  id: number;
  email: string;
  displayName: string;
  role: { id: number; name: string; isOwner: boolean };
  permissions: ReadonlySet<Permission>;
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(message = 'You do not have permission to do that.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(message = 'Not found.') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export function effectivePermissions(
  isOwner: boolean,
  stored: readonly Permission[],
): ReadonlySet<Permission> {
  return new Set(isOwner ? ALL_PERMISSIONS : stored);
}

/** True when the actor may use `permission`. Every permission also requires panel access. */
export function can(actor: Actor | null | undefined, permission: Permission): boolean {
  if (!actor) return false;
  if (!actor.permissions.has('panel.access')) return false;
  return actor.permissions.has(permission);
}

export function assertCan(
  actor: Actor | null | undefined,
  permission: Permission,
): asserts actor is Actor {
  if (!can(actor, permission)) throw new ForbiddenError();
}

/** True when the actor holds every permission in `required` (owners hold all). */
export function holdsAll(actor: Actor, required: Iterable<Permission>): boolean {
  for (const permission of required) {
    if (!actor.permissions.has(permission)) return false;
  }
  return true;
}
