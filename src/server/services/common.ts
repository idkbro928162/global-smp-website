import { ForbiddenError, can, type Actor } from '../auth/authorization.ts';
import type { Permission } from '../auth/permissions.ts';

export function assertCanAny(
  actor: Actor | null | undefined,
  permissions: readonly Permission[],
): asserts actor is Actor {
  if (!permissions.some((p) => can(actor, p))) throw new ForbiddenError();
}

/** Names of keys whose values differ (compared as JSON) — for audit details. */
export function changedFields<T extends object>(before: T, after: Partial<T>): string[] {
  return (Object.keys(after) as (keyof T)[])
    .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map(String);
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY')
  );
}

/** Today's date as YYYY-MM-DD (UTC). */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface MutationContext {
  actor: Actor;
  ip?: string | null;
}
