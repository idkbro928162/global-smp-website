/**
 * Products: the catalogue shown on the public site.
 *
 * Public functions (no actor) return published products only. Staff functions
 * take a MutationContext / Actor and assert permissions themselves, so they
 * are safe even if a page forgets its own check.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { NotFoundError, assertCan, type Actor } from '../auth/authorization.ts';
import { nowIso, type Db } from '../db/client.ts';
import {
  docPages,
  productMedia,
  products,
  releases,
  type Availability,
  type ReleaseChannel,
  type Visibility,
} from '../db/schema.ts';
import {
  ACCENTS,
  PLATFORMS,
  isAccentKey,
  isPlatformKey,
  type AccentKey,
  type PlatformKey,
} from '../../lib/catalog.ts';
import {
  BUILTBYBIT_HOSTS,
  LIMITS,
  MINECRAFT_VERSION,
  optionalIsoDateSchema,
  optionalText,
  optionalUrl,
  parseJsonArray,
  requiredText,
  slugSchema,
  validate,
  type Result,
} from '../../lib/validation.ts';
import { recordAudit } from './audit.ts';
import { assertCanAny, changedFields, isUniqueViolation, type MutationContext } from './common.ts';
import { getMediaItems, isMediaId, type MediaItem } from './media.ts';

export interface ProductFeature {
  title: string;
  body: string;
}

export interface ReleaseSummary {
  version: string;
  channel: ReleaseChannel;
  releasedOn: string;
}

export interface Product {
  id: number;
  slug: string;
  name: string;
  tagline: string;
  description: string;
  visibility: Visibility;
  availability: Availability;
  featured: boolean;
  sortOrder: number;
  accent: AccentKey;
  artwork: MediaItem | null;
  features: ProductFeature[];
  minecraftVersions: string[];
  platforms: PlatformKey[];
  javaVersion: string;
  builtbybitUrl: string;
  externalDocsUrl: string;
  supportUrl: string;
  launchedOn: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductListing extends Product {
  latestRelease: ReleaseSummary | null;
  docPageCount: number;
}

export interface ProductDetail extends ProductListing {
  screenshots: MediaItem[];
}

type ProductRow = typeof products.$inferSelect;

const featureShape = z.object({ title: z.string(), body: z.string() });

/** Row → domain object. JSON columns are parsed defensively: bad data yields empty lists. */
function toProduct(row: ProductRow, mediaById: Map<string, MediaItem>): Product {
  const features = parseJsonArray(row.features).flatMap((f) => {
    const parsed = featureShape.safeParse(f);
    return parsed.success && parsed.data.title.trim() ? [parsed.data] : [];
  });
  const minecraftVersions = parseJsonArray(row.minecraftVersions).filter(
    (v): v is string => typeof v === 'string' && MINECRAFT_VERSION.test(v),
  );
  const platforms = parseJsonArray(row.platforms).filter(isPlatformKey);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    visibility: row.visibility,
    availability: row.availability,
    featured: row.featured,
    sortOrder: row.sortOrder,
    accent: isAccentKey(row.accent) ? row.accent : 'neutral',
    artwork: row.artworkId ? (mediaById.get(row.artworkId) ?? null) : null,
    features,
    minecraftVersions,
    platforms,
    javaVersion: row.javaVersion,
    builtbybitUrl: row.builtbybitUrl,
    externalDocsUrl: row.externalDocsUrl,
    supportUrl: row.supportUrl,
    launchedOn: row.launchedOn,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const CHANNEL_RANK: Record<ReleaseChannel, number> = { stable: 0, beta: 1, alpha: 2 };

/**
 * Latest published release per product: the newest stable release if one
 * exists, otherwise the newest pre-release.
 */
function latestReleases(db: Db, productIds: number[]): Map<number, ReleaseSummary> {
  if (productIds.length === 0) return new Map();
  const rows = db
    .select({
      productId: releases.productId,
      version: releases.version,
      channel: releases.channel,
      releasedOn: releases.releasedOn,
    })
    .from(releases)
    .where(and(inArray(releases.productId, productIds), eq(releases.visibility, 'published')))
    .orderBy(desc(releases.releasedOn), desc(releases.id))
    .all();
  const best = new Map<number, ReleaseSummary>();
  for (const row of rows) {
    const current = best.get(row.productId);
    if (!current || CHANNEL_RANK[row.channel] < CHANNEL_RANK[current.channel]) {
      best.set(row.productId, {
        version: row.version,
        channel: row.channel,
        releasedOn: row.releasedOn,
      });
    }
  }
  return best;
}

function publishedDocCounts(db: Db, productIds: number[]): Map<number, number> {
  if (productIds.length === 0) return new Map();
  const rows = db
    .select({ productId: docPages.productId, n: sql<number>`count(*)` })
    .from(docPages)
    .where(and(inArray(docPages.productId, productIds), eq(docPages.visibility, 'published')))
    .groupBy(docPages.productId)
    .all();
  return new Map(rows.map((r) => [r.productId ?? 0, r.n]));
}

function toListings(db: Db, rows: ProductRow[]): ProductListing[] {
  const mediaById = getMediaItems(
    db,
    rows.flatMap((r) => (r.artworkId ? [r.artworkId] : [])),
  );
  const ids = rows.map((r) => r.id);
  const latest = latestReleases(db, ids);
  const docs = publishedDocCounts(db, ids);
  return rows.map((row) => ({
    ...toProduct(row, mediaById),
    latestRelease: latest.get(row.id) ?? null,
    docPageCount: docs.get(row.id) ?? 0,
  }));
}

const catalogueOrder = [desc(products.featured), asc(products.sortOrder), asc(products.name)];

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

export function listPublishedProducts(db: Db): ProductListing[] {
  const rows = db
    .select()
    .from(products)
    .where(eq(products.visibility, 'published'))
    .orderBy(...catalogueOrder)
    .all();
  return toListings(db, rows);
}

export function getPublishedProduct(db: Db, slug: string): ProductDetail | null {
  const row = db
    .select()
    .from(products)
    .where(and(eq(products.slug, slug), eq(products.visibility, 'published')))
    .get();
  if (!row) return null;
  const [listing] = toListings(db, [row]);
  return listing ? { ...listing, screenshots: screenshotsFor(db, row.id) } : null;
}

function screenshotsFor(db: Db, productId: number): MediaItem[] {
  const links = db
    .select()
    .from(productMedia)
    .where(eq(productMedia.productId, productId))
    .orderBy(asc(productMedia.position))
    .all();
  const items = getMediaItems(
    db,
    links.map((l) => l.mediaId),
  );
  return links.flatMap((l) => {
    const item = items.get(l.mediaId);
    return item ? [item] : [];
  });
}

// ---------------------------------------------------------------------------
// Staff queries
// ---------------------------------------------------------------------------

export function listProductsForStaff(db: Db, actor: Actor): ProductListing[] {
  assertCan(actor, 'products.manage');
  const rows = db
    .select()
    .from(products)
    .orderBy(...catalogueOrder)
    .all();
  return toListings(db, rows);
}

/** Minimal product list for pickers in the releases and docs editors. */
export function listProductOptions(
  db: Db,
  actor: Actor,
): { id: number; name: string; slug: string; visibility: Visibility }[] {
  assertCanAny(actor, ['products.manage', 'releases.manage', 'docs.manage']);
  return db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      visibility: products.visibility,
    })
    .from(products)
    .orderBy(asc(products.name))
    .all();
}

export function getProductForStaff(db: Db, actor: Actor, id: number): ProductDetail {
  assertCan(actor, 'products.manage');
  const row = db.select().from(products).where(eq(products.id, id)).get();
  if (!row) throw new NotFoundError();
  const [listing] = toListings(db, [row]);
  if (!listing) throw new NotFoundError();
  return { ...listing, screenshots: screenshotsFor(db, id) };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const ACCENT_KEYS = ACCENTS.map((a) => a.key) as [AccentKey, ...AccentKey[]];
const PLATFORM_KEYS = PLATFORMS.map((p) => p.key) as [PlatformKey, ...PlatformKey[]];

export const productInputSchema = z.object({
  name: requiredText(LIMITS.name, 'Name'),
  slug: slugSchema,
  tagline: optionalText(LIMITS.tagline),
  description: optionalText(LIMITS.markdown),
  visibility: z.enum(['draft', 'published'], 'Choose a visibility.'),
  availability: z.enum(['in_development', 'available', 'discontinued'], 'Choose an availability.'),
  featured: z.boolean(),
  sortOrder: z.coerce
    .number('Enter a whole number.')
    .int('Enter a whole number.')
    .min(-999, 'Use a number from -999 to 999.')
    .max(999, 'Use a number from -999 to 999.'),
  accent: z.enum(ACCENT_KEYS, 'Choose an accent colour.'),
  artworkId: z
    .string()
    .trim()
    .refine((v) => v === '' || isMediaId(v), 'Choose an image from the media library.'),
  features: z
    .array(
      z.object({
        title: requiredText(LIMITS.featureTitle, 'Feature title'),
        body: optionalText(LIMITS.featureBody),
      }),
    )
    .max(LIMITS.maxFeatures, `Add at most ${LIMITS.maxFeatures} features.`),
  minecraftVersions: z
    .array(
      z
        .string()
        .regex(
          MINECRAFT_VERSION,
          'Use Minecraft versions like 1.20.4, 1.21.x, 1.21+ or 26.1, separated by commas.',
        ),
    )
    .max(LIMITS.maxMinecraftVersions, `List at most ${LIMITS.maxMinecraftVersions} versions.`),
  platforms: z.array(z.enum(PLATFORM_KEYS, 'Unknown platform.')),
  javaVersion: z
    .string()
    .trim()
    .regex(/^(\d{1,2}\+?)?$/, 'Enter a Java version such as 21 or 17+.'),
  builtbybitUrl: optionalUrl(BUILTBYBIT_HOSTS),
  externalDocsUrl: optionalUrl(),
  supportUrl: optionalUrl(),
  launchedOn: optionalIsoDateSchema,
  screenshotIds: z
    .array(z.string().refine(isMediaId, 'Unknown image.'))
    .max(LIMITS.maxScreenshots, `Choose at most ${LIMITS.maxScreenshots} screenshots.`),
});

export type ProductInput = z.input<typeof productInputSchema>;

type ValidProductInput = z.output<typeof productInputSchema>;

function checkMediaExists(db: Db, input: ValidProductInput): Record<string, string> {
  const ids = [...(input.artworkId ? [input.artworkId] : []), ...input.screenshotIds];
  const found = getMediaItems(db, ids);
  const errors: Record<string, string> = {};
  if (input.artworkId && !found.has(input.artworkId)) {
    errors.artworkId = 'The selected artwork no longer exists.';
  }
  if (input.screenshotIds.some((id) => !found.has(id))) {
    errors.screenshotIds = 'A selected screenshot no longer exists.';
  }
  return errors;
}

function toColumns(input: ValidProductInput) {
  return {
    name: input.name,
    slug: input.slug,
    tagline: input.tagline,
    description: input.description,
    visibility: input.visibility,
    availability: input.availability,
    featured: input.featured,
    sortOrder: input.sortOrder,
    accent: input.accent,
    artworkId: input.artworkId || null,
    features: JSON.stringify(input.features),
    minecraftVersions: JSON.stringify([...new Set(input.minecraftVersions)]),
    platforms: JSON.stringify([...new Set(input.platforms)]),
    javaVersion: input.javaVersion,
    builtbybitUrl: input.builtbybitUrl,
    externalDocsUrl: input.externalDocsUrl,
    supportUrl: input.supportUrl,
    launchedOn: input.launchedOn || null,
  };
}

function replaceScreenshots(db: Db, productId: number, ids: string[]): void {
  db.delete(productMedia).where(eq(productMedia.productId, productId)).run();
  const unique = [...new Set(ids)];
  if (unique.length > 0) {
    db.insert(productMedia)
      .values(unique.map((mediaId, position) => ({ productId, mediaId, position })))
      .run();
  }
}

const SLUG_TAKEN = { slug: 'Another product already uses this slug.' };

export function createProduct(
  db: Db,
  ctx: MutationContext,
  input: unknown,
): Result<{ id: number }> {
  assertCan(ctx.actor, 'products.manage');
  const parsed = validate(productInputSchema, input);
  if (!parsed.ok) return parsed;
  const mediaErrors = checkMediaExists(db, parsed.value);
  if (Object.keys(mediaErrors).length > 0) return { ok: false, errors: mediaErrors };
  const at = nowIso();
  try {
    const id = db.transaction((tx) => {
      const row = tx
        .insert(products)
        .values({ ...toColumns(parsed.value), createdAt: at, updatedAt: at })
        .returning({ id: products.id })
        .get();
      replaceScreenshots(tx, row.id, parsed.value.screenshotIds);
      return row.id;
    });
    recordAudit(db, {
      actor: ctx.actor,
      action: 'product.create',
      target: { type: 'product', id, label: parsed.value.name },
      details: { visibility: parsed.value.visibility },
      ip: ctx.ip,
    });
    return { ok: true, value: { id } };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, errors: SLUG_TAKEN };
    throw error;
  }
}

export function updateProduct(
  db: Db,
  ctx: MutationContext,
  id: number,
  input: unknown,
): Result<{ id: number }> {
  assertCan(ctx.actor, 'products.manage');
  const existing = db.select().from(products).where(eq(products.id, id)).get();
  if (!existing) throw new NotFoundError();
  const parsed = validate(productInputSchema, input);
  if (!parsed.ok) return parsed;
  const mediaErrors = checkMediaExists(db, parsed.value);
  if (Object.keys(mediaErrors).length > 0) return { ok: false, errors: mediaErrors };
  const columns = toColumns(parsed.value);
  const previousScreens = screenshotsFor(db, id).map((m) => m.id);
  try {
    db.transaction((tx) => {
      tx.update(products)
        .set({ ...columns, updatedAt: nowIso() })
        .where(eq(products.id, id))
        .run();
      replaceScreenshots(tx, id, parsed.value.screenshotIds);
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, errors: SLUG_TAKEN };
    throw error;
  }
  const fields = changedFields(existing, columns);
  if (JSON.stringify(previousScreens) !== JSON.stringify(parsed.value.screenshotIds)) {
    fields.push('screenshots');
  }
  const action =
    existing.visibility !== columns.visibility
      ? columns.visibility === 'published'
        ? 'product.publish'
        : 'product.unpublish'
      : 'product.update';
  recordAudit(db, {
    actor: ctx.actor,
    action,
    target: { type: 'product', id, label: columns.name },
    details: { fields },
    ip: ctx.ip,
  });
  return { ok: true, value: { id } };
}

export function deleteProduct(db: Db, ctx: MutationContext, id: number): void {
  assertCan(ctx.actor, 'products.manage');
  const existing = db.select().from(products).where(eq(products.id, id)).get();
  if (!existing) throw new NotFoundError();
  // Releases, doc pages and screenshot links cascade via foreign keys.
  db.delete(products).where(eq(products.id, id)).run();
  recordAudit(db, {
    actor: ctx.actor,
    action: 'product.delete',
    target: { type: 'product', id, label: existing.name },
    ip: ctx.ip,
  });
}

/** Counts of dependent records, shown on the delete confirmation page. */
export function productDependents(db: Db, actor: Actor, id: number) {
  assertCan(actor, 'products.manage');
  const releaseCount =
    db
      .select({ n: sql<number>`count(*)` })
      .from(releases)
      .where(eq(releases.productId, id))
      .get()?.n ?? 0;
  const docCount =
    db
      .select({ n: sql<number>`count(*)` })
      .from(docPages)
      .where(eq(docPages.productId, id))
      .get()?.n ?? 0;
  return { releases: releaseCount, docPages: docCount };
}
