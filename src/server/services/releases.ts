/**
 * Product releases / changelog entries. A release is public only when both
 * the release and its product are published.
 */
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { NotFoundError, assertCan, type Actor } from '../auth/authorization.ts';
import { nowIso, type Db } from '../db/client.ts';
import { products, releases, type ReleaseChannel, type Visibility } from '../db/schema.ts';
import {
  LIMITS,
  isoDateSchema,
  optionalText,
  releaseVersionSchema,
  validate,
  type Result,
} from '../../lib/validation.ts';
import { recordAudit } from './audit.ts';
import { changedFields, isUniqueViolation, type MutationContext } from './common.ts';

export interface Release {
  id: number;
  productId: number;
  productName: string;
  productSlug: string;
  version: string;
  channel: ReleaseChannel;
  title: string;
  notes: string;
  releasedOn: string;
  visibility: Visibility;
  updatedAt: string;
}

const releaseColumns = {
  id: releases.id,
  productId: releases.productId,
  productName: products.name,
  productSlug: products.slug,
  version: releases.version,
  channel: releases.channel,
  title: releases.title,
  notes: releases.notes,
  releasedOn: releases.releasedOn,
  visibility: releases.visibility,
  updatedAt: releases.updatedAt,
};

const newestFirst = [desc(releases.releasedOn), desc(releases.id)];

const publiclyVisible = and(
  eq(releases.visibility, 'published'),
  eq(products.visibility, 'published'),
);

export function listPublishedReleasesForProduct(db: Db, productId: number): Release[] {
  return db
    .select(releaseColumns)
    .from(releases)
    .innerJoin(products, eq(products.id, releases.productId))
    .where(and(publiclyVisible, eq(releases.productId, productId)))
    .orderBy(...newestFirst)
    .all();
}

export function listRecentPublishedReleases(db: Db, limit = 20): Release[] {
  return db
    .select(releaseColumns)
    .from(releases)
    .innerJoin(products, eq(products.id, releases.productId))
    .where(publiclyVisible)
    .orderBy(...newestFirst)
    .limit(limit)
    .all();
}

export function listReleasesForStaff(
  db: Db,
  actor: Actor,
  filter: { productId?: number } = {},
): Release[] {
  assertCan(actor, 'releases.manage');
  return db
    .select(releaseColumns)
    .from(releases)
    .innerJoin(products, eq(products.id, releases.productId))
    .where(filter.productId ? eq(releases.productId, filter.productId) : undefined)
    .orderBy(...newestFirst)
    .all();
}

export function getReleaseForStaff(db: Db, actor: Actor, id: number): Release {
  assertCan(actor, 'releases.manage');
  const row = db
    .select(releaseColumns)
    .from(releases)
    .innerJoin(products, eq(products.id, releases.productId))
    .where(eq(releases.id, id))
    .get();
  if (!row) throw new NotFoundError();
  return row;
}

export const releaseInputSchema = z.object({
  productId: z.coerce
    .number('Choose a product.')
    .int('Choose a product.')
    .positive('Choose a product.'),
  version: releaseVersionSchema,
  channel: z.enum(['stable', 'beta', 'alpha'], 'Choose a channel.'),
  title: optionalText(LIMITS.shortText),
  notes: optionalText(LIMITS.markdown),
  releasedOn: isoDateSchema,
  visibility: z.enum(['draft', 'published'], 'Choose a visibility.'),
});

const VERSION_TAKEN = { version: 'This product already has a release with this version.' };

function productExists(db: Db, id: number): string | null {
  return (
    db.select({ name: products.name }).from(products).where(eq(products.id, id)).get()?.name ?? null
  );
}

export function createRelease(
  db: Db,
  ctx: MutationContext,
  input: unknown,
): Result<{ id: number }> {
  assertCan(ctx.actor, 'releases.manage');
  const parsed = validate(releaseInputSchema, input);
  if (!parsed.ok) return parsed;
  const productName = productExists(db, parsed.value.productId);
  if (!productName) return { ok: false, errors: { productId: 'Choose a product.' } };
  const at = nowIso();
  try {
    const row = db
      .insert(releases)
      .values({ ...parsed.value, createdAt: at, updatedAt: at })
      .returning({ id: releases.id })
      .get();
    recordAudit(db, {
      actor: ctx.actor,
      action: 'release.create',
      target: { type: 'release', id: row.id, label: `${productName} ${parsed.value.version}` },
      details: { visibility: parsed.value.visibility },
      ip: ctx.ip,
    });
    return { ok: true, value: { id: row.id } };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, errors: VERSION_TAKEN };
    throw error;
  }
}

export function updateRelease(
  db: Db,
  ctx: MutationContext,
  id: number,
  input: unknown,
): Result<{ id: number }> {
  assertCan(ctx.actor, 'releases.manage');
  const existing = db.select().from(releases).where(eq(releases.id, id)).get();
  if (!existing) throw new NotFoundError();
  const parsed = validate(releaseInputSchema, input);
  if (!parsed.ok) return parsed;
  const productName = productExists(db, parsed.value.productId);
  if (!productName) return { ok: false, errors: { productId: 'Choose a product.' } };
  try {
    db.update(releases)
      .set({ ...parsed.value, updatedAt: nowIso() })
      .where(eq(releases.id, id))
      .run();
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, errors: VERSION_TAKEN };
    throw error;
  }
  recordAudit(db, {
    actor: ctx.actor,
    action: 'release.update',
    target: { type: 'release', id, label: `${productName} ${parsed.value.version}` },
    details: { fields: changedFields(existing, parsed.value) },
    ip: ctx.ip,
  });
  return { ok: true, value: { id } };
}

export function deleteRelease(db: Db, ctx: MutationContext, id: number): void {
  assertCan(ctx.actor, 'releases.manage');
  const existing = getReleaseForStaff(db, ctx.actor, id);
  db.delete(releases).where(eq(releases.id, id)).run();
  recordAudit(db, {
    actor: ctx.actor,
    action: 'release.delete',
    target: { type: 'release', id, label: `${existing.productName} ${existing.version}` },
    ip: ctx.ip,
  });
}
