/**
 * Helpers shared by staff pages (src/pages/staff/**).
 *
 * Pages still check their own permission before doing anything; services
 * check again. These helpers only remove boilerplate.
 */
import type { AstroGlobal } from 'astro';
import { ForbiddenError, can, type Actor } from '../auth/authorization.ts';
import type { Permission } from '../auth/permissions.ts';
import type { MutationContext } from '../services/common.ts';

type StaffAstro = Pick<AstroGlobal, 'locals'>;

/** The signed-in actor. The middleware guarantees one on every protected staff route. */
export function requireActor(astro: StaffAstro): Actor {
  const actor = astro.locals.actor;
  if (!actor) throw new ForbiddenError();
  return actor;
}

/** Throws ForbiddenError (rendered as the 403 page by the middleware) unless permitted. */
export function requirePermission(astro: StaffAstro, permission: Permission): Actor {
  const actor = requireActor(astro);
  if (!can(actor, permission)) throw new ForbiddenError();
  return actor;
}

export function mutationContext(astro: StaffAstro): MutationContext {
  return { actor: requireActor(astro), ip: astro.locals.clientIp };
}

/** The submitted form (already size-limited and CSRF-checked by the middleware). */
export function submittedForm(astro: StaffAstro): FormData {
  return astro.locals.form ?? new FormData();
}

export function parseId(value: string | undefined): number | null {
  if (!value || !/^\d{1,9}$/.test(value)) return null;
  const id = Number(value);
  return id > 0 ? id : null;
}

// ---------------------------------------------------------------- form reading

export function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export function fields(form: FormData, name: string): string[] {
  return form.getAll(name).filter((v): v is string => typeof v === 'string');
}

export function checked(form: FormData, name: string): boolean {
  return form.get(name) === 'on';
}

/**
 * Collapses nested validation keys ("minecraftVersions.2") onto the form
 * field that displays them ("minecraftVersions"), keeping the first message.
 */
export function errorsForFields(
  errors: Record<string, string>,
  collapse: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, message] of Object.entries(errors)) {
    const target = collapse.find((name) => key === name || key.startsWith(`${name}.`)) ?? key;
    result[target] ??= message;
  }
  return result;
}

// ------------------------------------------------------------------- notices

/** Fixed notice messages shown after a redirect (`?notice=<key>`). Unknown keys show nothing. */
export const NOTICES = {
  saved: 'Changes saved.',
  created: 'Created.',
  deleted: 'Deleted.',
  uploaded: 'Image uploaded.',
  'signed-out': 'You have been signed out.',
  'password-set': 'Your password has been set. You can now sign in.',
  'password-changed': 'Your password has been changed. Your other sessions were signed out.',
  'sessions-revoked': 'Your other sessions have been signed out.',
} as const;

export function noticeFor(url: URL): string | null {
  const key = url.searchParams.get('notice');
  return key && Object.hasOwn(NOTICES, key) ? NOTICES[key as keyof typeof NOTICES] : null;
}
