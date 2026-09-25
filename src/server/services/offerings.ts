/**
 * Development service offerings listed on the public Services page
 * (e.g. custom plugin development). Managed with `content.manage`.
 * No prices, guarantees or turnaround promises are modelled: staff describe
 * each offering in their own words.
 */
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { NotFoundError, assertCan, type Actor } from '../auth/authorization.ts';
import { nowIso, type Db } from '../db/client.ts';
import { services, type Visibility } from '../db/schema.ts';
import { LIMITS, optionalText, requiredText, validate, type Result } from '../../lib/validation.ts';
import { recordAudit } from './audit.ts';
import { changedFields, type MutationContext } from './common.ts';

export interface Offering {
  id: number;
  title: string;
  summary: string;
  body: string;
  sortOrder: number;
  visibility: Visibility;
}

const columns = {
  id: services.id,
  title: services.title,
  summary: services.summary,
  body: services.body,
  sortOrder: services.sortOrder,
  visibility: services.visibility,
};

const order = [asc(services.sortOrder), asc(services.title)];

export function listPublishedOfferings(db: Db): Offering[] {
  return db
    .select(columns)
    .from(services)
    .where(eq(services.visibility, 'published'))
    .orderBy(...order)
    .all();
}

export function listOfferingsForStaff(db: Db, actor: Actor): Offering[] {
  assertCan(actor, 'content.manage');
  return db
    .select(columns)
    .from(services)
    .orderBy(...order)
    .all();
}

export function getOfferingForStaff(db: Db, actor: Actor, id: number): Offering {
  assertCan(actor, 'content.manage');
  const row = db.select(columns).from(services).where(eq(services.id, id)).get();
  if (!row) throw new NotFoundError();
  return row;
}

export const offeringInputSchema = z.object({
  title: requiredText(LIMITS.shortText, 'Title'),
  summary: optionalText(LIMITS.summary),
  body: optionalText(LIMITS.markdown),
  sortOrder: z.coerce
    .number('Enter a whole number.')
    .int('Enter a whole number.')
    .min(-999, 'Use a number from -999 to 999.')
    .max(999, 'Use a number from -999 to 999.'),
  visibility: z.enum(['draft', 'published'], 'Choose a visibility.'),
});

export function createOffering(
  db: Db,
  ctx: MutationContext,
  input: unknown,
): Result<{ id: number }> {
  assertCan(ctx.actor, 'content.manage');
  const parsed = validate(offeringInputSchema, input);
  if (!parsed.ok) return parsed;
  const at = nowIso();
  const row = db
    .insert(services)
    .values({ ...parsed.value, createdAt: at, updatedAt: at })
    .returning({ id: services.id })
    .get();
  recordAudit(db, {
    actor: ctx.actor,
    action: 'service.create',
    target: { type: 'service', id: row.id, label: parsed.value.title },
    ip: ctx.ip,
  });
  return { ok: true, value: { id: row.id } };
}

export function updateOffering(
  db: Db,
  ctx: MutationContext,
  id: number,
  input: unknown,
): Result<{ id: number }> {
  assertCan(ctx.actor, 'content.manage');
  const existing = db.select().from(services).where(eq(services.id, id)).get();
  if (!existing) throw new NotFoundError();
  const parsed = validate(offeringInputSchema, input);
  if (!parsed.ok) return parsed;
  db.update(services)
    .set({ ...parsed.value, updatedAt: nowIso() })
    .where(eq(services.id, id))
    .run();
  recordAudit(db, {
    actor: ctx.actor,
    action: 'service.update',
    target: { type: 'service', id, label: parsed.value.title },
    details: { fields: changedFields(existing, parsed.value) },
    ip: ctx.ip,
  });
  return { ok: true, value: { id } };
}

export function deleteOffering(db: Db, ctx: MutationContext, id: number): void {
  assertCan(ctx.actor, 'content.manage');
  const existing = db.select().from(services).where(eq(services.id, id)).get();
  if (!existing) throw new NotFoundError();
  db.delete(services).where(eq(services.id, id)).run();
  recordAudit(db, {
    actor: ctx.actor,
    action: 'service.delete',
    target: { type: 'service', id, label: existing.title },
    ip: ctx.ip,
  });
}
