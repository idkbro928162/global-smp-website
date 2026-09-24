/**
 * Documentation pages, grouped into collections: one per product plus a
 * "general" collection for pages not tied to a product.
 *
 * URL scheme: /docs/<collection>/<page>, where <collection> is a product slug
 * or "general" (reserved, so no product can take it).
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { NotFoundError, assertCan, type Actor } from '../auth/authorization.ts';
import { nowIso, type Db } from '../db/client.ts';
import { docPages, products, type Visibility } from '../db/schema.ts';
import {
  LIMITS,
  optionalText,
  requiredText,
  slugSchema,
  validate,
  type Result,
} from '../../lib/validation.ts';
import { recordAudit } from './audit.ts';
import { changedFields, isUniqueViolation, type MutationContext } from './common.ts';

export const GENERAL_COLLECTION = 'general';

export interface DocPageSummary {
  id: number;
  slug: string;
  title: string;
  summary: string;
  section: string;
  sortOrder: number;
}

export interface DocCollection {
  key: string;
  title: string;
  description: string;
  productId: number | null;
  /** Set when the product's documentation lives on another site. */
  externalUrl: string;
  pages: DocPageSummary[];
}

export interface DocSection {
  title: string;
  pages: DocPageSummary[];
}

export interface DocPageView extends DocPageSummary {
  body: string;
  updatedAt: string;
  collection: DocCollection;
  sections: DocSection[];
  previous: DocPageSummary | null;
  next: DocPageSummary | null;
}

const summaryColumns = {
  id: docPages.id,
  slug: docPages.slug,
  title: docPages.title,
  summary: docPages.summary,
  section: docPages.section,
  sortOrder: docPages.sortOrder,
};

const pageOrder = [asc(docPages.sortOrder), asc(docPages.title)];

function publishedPages(db: Db, productId: number | null): DocPageSummary[] {
  return db
    .select(summaryColumns)
    .from(docPages)
    .where(
      and(
        eq(docPages.visibility, 'published'),
        productId === null ? isNull(docPages.productId) : eq(docPages.productId, productId),
      ),
    )
    .orderBy(...pageOrder)
    .all();
}

/** Groups pages by section, preserving the order in which sections first appear. */
export function groupIntoSections(pages: DocPageSummary[]): DocSection[] {
  const sections = new Map<string, DocPageSummary[]>();
  for (const page of pages) {
    const title = page.section.trim();
    sections.set(title, [...(sections.get(title) ?? []), page]);
  }
  return [...sections].map(([title, list]) => ({ title, pages: list }));
}

/**
 * Public collections: general docs (if any pages exist) followed by each
 * published product that has published pages or external documentation.
 */
export function listDocCollections(db: Db): DocCollection[] {
  const collections: DocCollection[] = [];
  const general = publishedPages(db, null);
  if (general.length > 0) {
    collections.push({
      key: GENERAL_COLLECTION,
      title: 'General',
      description: 'Guides that apply across Based Productions products.',
      productId: null,
      externalUrl: '',
      pages: general,
    });
  }
  const productRows = db
    .select({
      id: products.id,
      slug: products.slug,
      name: products.name,
      tagline: products.tagline,
      externalDocsUrl: products.externalDocsUrl,
    })
    .from(products)
    .where(eq(products.visibility, 'published'))
    .orderBy(asc(products.sortOrder), asc(products.name))
    .all();
  for (const product of productRows) {
    const pages = publishedPages(db, product.id);
    if (pages.length === 0 && !product.externalDocsUrl) continue;
    collections.push({
      key: product.slug,
      title: product.name,
      description: product.tagline,
      productId: product.id,
      externalUrl: product.externalDocsUrl,
      pages,
    });
  }
  return collections;
}

export function getDocCollection(db: Db, key: string): DocCollection | null {
  return listDocCollections(db).find((c) => c.key === key) ?? null;
}

export function getPublishedDocPage(
  db: Db,
  collectionKey: string,
  slug: string,
): DocPageView | null {
  const collection = getDocCollection(db, collectionKey);
  if (!collection) return null;
  const summary = collection.pages.find((p) => p.slug === slug);
  if (!summary) return null;
  const row = db.select().from(docPages).where(eq(docPages.id, summary.id)).get();
  if (!row) return null;
  const sections = groupIntoSections(collection.pages);
  // Reading order follows the sidebar (grouped by section), not raw sort order.
  const ordered = sections.flatMap((s) => s.pages);
  const index = ordered.findIndex((p) => p.id === row.id);
  return {
    ...summary,
    body: row.body,
    updatedAt: row.updatedAt,
    collection,
    sections,
    previous: index > 0 ? (ordered[index - 1] ?? null) : null,
    next: ordered[index + 1] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

export interface StaffDocPage extends DocPageSummary {
  productId: number | null;
  productName: string | null;
  productSlug: string | null;
  body: string;
  visibility: Visibility;
  updatedAt: string;
}

const staffColumns = {
  ...summaryColumns,
  productId: docPages.productId,
  productName: products.name,
  productSlug: products.slug,
  body: docPages.body,
  visibility: docPages.visibility,
  updatedAt: docPages.updatedAt,
};

export function listDocPagesForStaff(db: Db, actor: Actor): StaffDocPage[] {
  assertCan(actor, 'docs.manage');
  return db
    .select(staffColumns)
    .from(docPages)
    .leftJoin(products, eq(products.id, docPages.productId))
    .orderBy(sql`${products.name} IS NOT NULL`, asc(products.name), ...pageOrder)
    .all();
}

export function getDocPageForStaff(db: Db, actor: Actor, id: number): StaffDocPage {
  assertCan(actor, 'docs.manage');
  const row = db
    .select(staffColumns)
    .from(docPages)
    .leftJoin(products, eq(products.id, docPages.productId))
    .where(eq(docPages.id, id))
    .get();
  if (!row) throw new NotFoundError();
  return row;
}

export const docPageInputSchema = z.object({
  /** Empty string = general documentation. */
  productId: z
    .string()
    .trim()
    .regex(/^\d*$/, 'Choose a product.')
    .transform((v) => (v === '' ? null : Number(v))),
  title: requiredText(LIMITS.shortText, 'Title'),
  slug: slugSchema,
  summary: optionalText(LIMITS.summary),
  section: optionalText(LIMITS.section),
  body: optionalText(LIMITS.docBody),
  sortOrder: z.coerce
    .number('Enter a whole number.')
    .int('Enter a whole number.')
    .min(-999, 'Use a number from -999 to 999.')
    .max(999, 'Use a number from -999 to 999.'),
  visibility: z.enum(['draft', 'published'], 'Choose a visibility.'),
});

const SLUG_TAKEN = { slug: 'Another page in this collection already uses this slug.' };

function checkProduct(db: Db, productId: number | null): Result<null> {
  if (productId === null) return { ok: true, value: null };
  const exists = db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, productId))
    .get();
  return exists
    ? { ok: true, value: null }
    : { ok: false, errors: { productId: 'Choose a product.' } };
}

export function createDocPage(
  db: Db,
  ctx: MutationContext,
  input: unknown,
): Result<{ id: number }> {
  assertCan(ctx.actor, 'docs.manage');
  const parsed = validate(docPageInputSchema, input);
  if (!parsed.ok) return parsed;
  const product = checkProduct(db, parsed.value.productId);
  if (!product.ok) return product;
  const at = nowIso();
  try {
    const row = db
      .insert(docPages)
      .values({ ...parsed.value, createdAt: at, updatedAt: at })
      .returning({ id: docPages.id })
      .get();
    recordAudit(db, {
      actor: ctx.actor,
      action: 'doc.create',
      target: { type: 'doc_page', id: row.id, label: parsed.value.title },
      details: { visibility: parsed.value.visibility },
      ip: ctx.ip,
    });
    return { ok: true, value: { id: row.id } };
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, errors: SLUG_TAKEN };
    throw error;
  }
}

export function updateDocPage(
  db: Db,
  ctx: MutationContext,
  id: number,
  input: unknown,
): Result<{ id: number }> {
  assertCan(ctx.actor, 'docs.manage');
  const existing = db.select().from(docPages).where(eq(docPages.id, id)).get();
  if (!existing) throw new NotFoundError();
  const parsed = validate(docPageInputSchema, input);
  if (!parsed.ok) return parsed;
  const product = checkProduct(db, parsed.value.productId);
  if (!product.ok) return product;
  try {
    db.update(docPages)
      .set({ ...parsed.value, updatedAt: nowIso() })
      .where(eq(docPages.id, id))
      .run();
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, errors: SLUG_TAKEN };
    throw error;
  }
  recordAudit(db, {
    actor: ctx.actor,
    action: 'doc.update',
    target: { type: 'doc_page', id, label: parsed.value.title },
    details: { fields: changedFields(existing, parsed.value) },
    ip: ctx.ip,
  });
  return { ok: true, value: { id } };
}

export function deleteDocPage(db: Db, ctx: MutationContext, id: number): void {
  assertCan(ctx.actor, 'docs.manage');
  const existing = db.select().from(docPages).where(eq(docPages.id, id)).get();
  if (!existing) throw new NotFoundError();
  db.delete(docPages).where(eq(docPages.id, id)).run();
  recordAudit(db, {
    actor: ctx.actor,
    action: 'doc.delete',
    target: { type: 'doc_page', id, label: existing.title },
    ip: ctx.ip,
  });
}
