/**
 * Public team profiles (About page). These are NOT staff accounts — a team
 * member shown publicly need not have a login, and staff accounts are never
 * listed publicly.
 */
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { NotFoundError, assertCan, type Actor } from '../auth/authorization.ts';
import { nowIso, type Db } from '../db/client.ts';
import { teamMembers, type Visibility } from '../db/schema.ts';
import {
  LIMITS,
  optionalText,
  parseJsonArray,
  requiredText,
  urlProblem,
  validate,
  type Result,
} from '../../lib/validation.ts';
import { recordAudit } from './audit.ts';
import { changedFields, type MutationContext } from './common.ts';
import { getMediaItems, isMediaId, type MediaItem } from './media.ts';

export interface TeamLink {
  label: string;
  url: string;
}

export interface TeamMember {
  id: number;
  name: string;
  roleTitle: string;
  bio: string;
  avatar: MediaItem | null;
  links: TeamLink[];
  sortOrder: number;
  visibility: Visibility;
}

const linkShape = z.object({ label: z.string().min(1), url: z.string() });

function toMembers(db: Db, rows: (typeof teamMembers.$inferSelect)[]): TeamMember[] {
  const avatars = getMediaItems(
    db,
    rows.flatMap((r) => (r.avatarId ? [r.avatarId] : [])),
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    roleTitle: row.roleTitle,
    bio: row.bio,
    avatar: row.avatarId ? (avatars.get(row.avatarId) ?? null) : null,
    links: parseJsonArray(row.links).flatMap((l) => {
      const parsed = linkShape.safeParse(l);
      return parsed.success && urlProblem(parsed.data.url) === null ? [parsed.data] : [];
    }),
    sortOrder: row.sortOrder,
    visibility: row.visibility,
  }));
}

const order = [asc(teamMembers.sortOrder), asc(teamMembers.name)];

export function listPublishedTeam(db: Db): TeamMember[] {
  return toMembers(
    db,
    db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.visibility, 'published'))
      .orderBy(...order)
      .all(),
  );
}

export function listTeamForStaff(db: Db, actor: Actor): TeamMember[] {
  assertCan(actor, 'team.manage');
  return toMembers(
    db,
    db
      .select()
      .from(teamMembers)
      .orderBy(...order)
      .all(),
  );
}

export function getTeamMemberForStaff(db: Db, actor: Actor, id: number): TeamMember {
  assertCan(actor, 'team.manage');
  const row = db.select().from(teamMembers).where(eq(teamMembers.id, id)).get();
  if (!row) throw new NotFoundError();
  return toMembers(db, [row])[0]!;
}

export const teamInputSchema = z.object({
  name: requiredText(LIMITS.name, 'Name'),
  roleTitle: optionalText(LIMITS.name),
  bio: optionalText(1000),
  avatarId: z
    .string()
    .trim()
    .refine((v) => v === '' || isMediaId(v), 'Choose an image from the media library.'),
  links: z
    .array(
      z.object({
        label: requiredText(40, 'Link label'),
        url: z
          .string()
          .trim()
          .max(LIMITS.url)
          .superRefine((value, ctx) => {
            const problem = urlProblem(value);
            if (problem) ctx.addIssue({ code: 'custom', message: problem });
          }),
      }),
    )
    .max(LIMITS.maxLinks, `Add at most ${LIMITS.maxLinks} links.`),
  sortOrder: z.coerce
    .number('Enter a whole number.')
    .int('Enter a whole number.')
    .min(-999, 'Use a number from -999 to 999.')
    .max(999, 'Use a number from -999 to 999.'),
  visibility: z.enum(['draft', 'published'], 'Choose a visibility.'),
});

function toColumns(input: z.output<typeof teamInputSchema>) {
  return {
    name: input.name,
    roleTitle: input.roleTitle,
    bio: input.bio,
    avatarId: input.avatarId || null,
    links: JSON.stringify(input.links),
    sortOrder: input.sortOrder,
    visibility: input.visibility,
  };
}

function checkAvatar(db: Db, avatarId: string): Result<null> {
  if (!avatarId || getMediaItems(db, [avatarId]).has(avatarId)) return { ok: true, value: null };
  return { ok: false, errors: { avatarId: 'The selected image no longer exists.' } };
}

export function createTeamMember(
  db: Db,
  ctx: MutationContext,
  input: unknown,
): Result<{ id: number }> {
  assertCan(ctx.actor, 'team.manage');
  const parsed = validate(teamInputSchema, input);
  if (!parsed.ok) return parsed;
  const avatar = checkAvatar(db, parsed.value.avatarId);
  if (!avatar.ok) return avatar;
  const at = nowIso();
  const row = db
    .insert(teamMembers)
    .values({ ...toColumns(parsed.value), createdAt: at, updatedAt: at })
    .returning({ id: teamMembers.id })
    .get();
  recordAudit(db, {
    actor: ctx.actor,
    action: 'team.create',
    target: { type: 'team_member', id: row.id, label: parsed.value.name },
    ip: ctx.ip,
  });
  return { ok: true, value: { id: row.id } };
}

export function updateTeamMember(
  db: Db,
  ctx: MutationContext,
  id: number,
  input: unknown,
): Result<{ id: number }> {
  assertCan(ctx.actor, 'team.manage');
  const existing = db.select().from(teamMembers).where(eq(teamMembers.id, id)).get();
  if (!existing) throw new NotFoundError();
  const parsed = validate(teamInputSchema, input);
  if (!parsed.ok) return parsed;
  const avatar = checkAvatar(db, parsed.value.avatarId);
  if (!avatar.ok) return avatar;
  const columns = toColumns(parsed.value);
  db.update(teamMembers)
    .set({ ...columns, updatedAt: nowIso() })
    .where(eq(teamMembers.id, id))
    .run();
  recordAudit(db, {
    actor: ctx.actor,
    action: 'team.update',
    target: { type: 'team_member', id, label: columns.name },
    details: { fields: changedFields(existing, columns) },
    ip: ctx.ip,
  });
  return { ok: true, value: { id } };
}

export function deleteTeamMember(db: Db, ctx: MutationContext, id: number): void {
  assertCan(ctx.actor, 'team.manage');
  const existing = db.select().from(teamMembers).where(eq(teamMembers.id, id)).get();
  if (!existing) throw new NotFoundError();
  db.delete(teamMembers).where(eq(teamMembers.id, id)).run();
  recordAudit(db, {
    actor: ctx.actor,
    action: 'team.delete',
    target: { type: 'team_member', id, label: existing.name },
    ip: ctx.ip,
  });
}
