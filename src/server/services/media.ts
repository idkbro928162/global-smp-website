/**
 * Image uploads.
 *
 * Every upload is decoded and re-encoded by sharp into two WebP renditions
 * (large and small). Nothing the client sent is stored verbatim: metadata is
 * stripped, polyglot payloads do not survive re-encoding, and the client's
 * declared content type and filename are never trusted. SVG is not accepted.
 *
 * Uploaded images are public: anyone with the URL can load them.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { desc, eq, like, or, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { z } from 'zod';
import { NotFoundError, assertCan } from '../auth/authorization.ts';
import { getConfig } from '../config.ts';
import { nowIso, type Db } from '../db/client.ts';
import {
  docPages,
  media,
  productMedia,
  products,
  releases,
  services,
  teamMembers,
} from '../db/schema.ts';
import { RULES, isRateLimited, recordHit } from '../security/rate-limit.ts';
import { validate, type Result } from '../../lib/validation.ts';
import { recordAudit } from './audit.ts';
import { assertCanAny, type MutationContext } from './common.ts';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_PIXELS = 50_000_000;
const ACCEPTED_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'avif']);
const RENDITIONS = { lg: 1920, sm: 640 } as const;
export type Rendition = keyof typeof RENDITIONS;

const MEDIA_ID = /^[A-Za-z0-9_-]{22}$/;
const FILE_NAME = /^([A-Za-z0-9_-]{22})-(sm|lg)\.webp$/;

export interface MediaItem {
  id: string;
  originalName: string;
  alt: string;
  width: number;
  height: number;
  bytes: number;
  createdAt: string;
  url: string;
  smallUrl: string;
}

export function mediaUrl(id: string, rendition: Rendition = 'lg'): string {
  return `/media/${id}-${rendition}.webp`;
}

function toItem(row: typeof media.$inferSelect): MediaItem {
  return {
    id: row.id,
    originalName: row.originalName,
    alt: row.alt,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    createdAt: row.createdAt,
    url: mediaUrl(row.id, 'lg'),
    smallUrl: mediaUrl(row.id, 'sm'),
  };
}

export function isMediaId(value: unknown): value is string {
  return typeof value === 'string' && MEDIA_ID.test(value);
}

export function getMediaItems(db: Db, ids: readonly string[]): Map<string, MediaItem> {
  const valid = ids.filter(isMediaId);
  if (valid.length === 0) return new Map();
  const rows = db
    .select()
    .from(media)
    .where(or(...valid.map((id) => eq(media.id, id))))
    .all();
  return new Map(rows.map((row) => [row.id, toItem(row)]));
}

/** Media listing for pickers and the media library. */
export function listMedia(db: Db, actor: MutationContext['actor']): MediaItem[] {
  assertCanAny(actor, ['media.manage', 'products.manage', 'team.manage', 'docs.manage']);
  return db.select().from(media).orderBy(desc(media.createdAt)).all().map(toItem);
}

const altSchema = z.string().trim().max(300, 'Use at most 300 characters.');

export async function uploadImage(
  db: Db,
  ctx: MutationContext,
  file: unknown,
  altInput: unknown,
): Promise<Result<MediaItem>> {
  assertCan(ctx.actor, 'media.manage');
  const alt = validate(altSchema, altInput ?? '');
  if (!alt.ok) return { ok: false, errors: { alt: alt.errors._form ?? 'Invalid alt text.' } };
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, errors: { file: 'Choose an image to upload.' } };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, errors: { file: 'Images must be 10 MB or smaller.' } };
  }
  const bucket = `upload:user:${ctx.actor.id}`;
  if (isRateLimited(db, bucket, RULES.uploadsPerUser)) {
    return { ok: false, errors: { file: 'Too many uploads. Try again later.' } };
  }
  recordHit(db, bucket);

  const input = Buffer.from(await file.arrayBuffer());
  let format: string | undefined;
  try {
    format = (await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()).format;
  } catch {
    format = undefined;
  }
  if (!format || !ACCEPTED_FORMATS.has(format)) {
    return { ok: false, errors: { file: 'Upload a PNG, JPEG, WebP, GIF or AVIF image.' } };
  }

  const id = randomBytes(16).toString('base64url');
  const dir = getConfig().uploadsDir;
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  try {
    let large: { width: number; height: number; size: number } | undefined;
    for (const [rendition, maxWidth] of Object.entries(RENDITIONS) as [Rendition, number][]) {
      const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate() // apply EXIF orientation before metadata is stripped
        .resize({ width: maxWidth, withoutEnlargement: true })
        .webp({ quality: rendition === 'lg' ? 82 : 78 })
        .toBuffer({ resolveWithObject: true });
      const target = path.join(dir, `${id}-${rendition}.webp`);
      await writeFile(target, data, { flag: 'wx' });
      written.push(target);
      if (rendition === 'lg') large = { width: info.width, height: info.height, size: info.size };
    }
    if (!large) throw new Error('Large rendition missing');
    const originalName = file.name.replace(/[^\w.\- ()]+/g, '_').slice(0, 120) || 'image';
    const row = {
      id,
      originalName,
      alt: alt.value,
      width: large.width,
      height: large.height,
      bytes: large.size,
      createdBy: ctx.actor.id,
      createdAt: nowIso(),
    };
    db.insert(media).values(row).run();
    recordAudit(db, {
      actor: ctx.actor,
      action: 'media.upload',
      target: { type: 'media', id, label: originalName },
      ip: ctx.ip,
    });
    return { ok: true, value: toItem(row) };
  } catch (error) {
    await Promise.all(written.map((file) => rm(file, { force: true })));
    if (error instanceof Error && /unsupported image format|Input buffer/i.test(error.message)) {
      return { ok: false, errors: { file: 'This image could not be processed.' } };
    }
    throw error;
  }
}

export function updateMediaAlt(
  db: Db,
  ctx: MutationContext,
  id: string,
  altInput: unknown,
): Result<null> {
  assertCan(ctx.actor, 'media.manage');
  const alt = validate(altSchema, altInput ?? '');
  if (!alt.ok) return { ok: false, errors: { alt: alt.errors._form ?? 'Invalid alt text.' } };
  const row = isMediaId(id) ? db.select().from(media).where(eq(media.id, id)).get() : undefined;
  if (!row) throw new NotFoundError();
  db.update(media).set({ alt: alt.value }).where(eq(media.id, id)).run();
  recordAudit(db, {
    actor: ctx.actor,
    action: 'media.update',
    target: { type: 'media', id, label: row.originalName },
    details: { fields: ['alt'] },
    ip: ctx.ip,
  });
  return { ok: true, value: null };
}

/** Where an image is used. Deleting a used image is refused. */
export function findMediaUsage(db: Db, id: string): string[] {
  const usage: string[] = [];
  const ref = `%/media/${id}-%`;
  for (const p of db
    .select({ name: products.name })
    .from(products)
    .where(or(eq(products.artworkId, id), like(products.description, ref)))
    .all()) {
    usage.push(`Product: ${p.name}`);
  }
  for (const p of db
    .select({ name: products.name })
    .from(productMedia)
    .innerJoin(products, eq(products.id, productMedia.productId))
    .where(eq(productMedia.mediaId, id))
    .all()) {
    usage.push(`Screenshot: ${p.name}`);
  }
  for (const t of db
    .select({ name: teamMembers.name })
    .from(teamMembers)
    .where(eq(teamMembers.avatarId, id))
    .all()) {
    usage.push(`Team member: ${t.name}`);
  }
  for (const d of db
    .select({ title: docPages.title })
    .from(docPages)
    .where(like(docPages.body, ref))
    .all()) {
    usage.push(`Doc page: ${d.title}`);
  }
  for (const r of db
    .select({ version: releases.version })
    .from(releases)
    .where(like(releases.notes, ref))
    .all()) {
    usage.push(`Release: ${r.version}`);
  }
  for (const s of db
    .select({ title: services.title })
    .from(services)
    .where(like(services.body, ref))
    .all()) {
    usage.push(`Service: ${s.title}`);
  }
  return [...new Set(usage)];
}

export async function deleteMedia(db: Db, ctx: MutationContext, id: string): Promise<Result<null>> {
  assertCan(ctx.actor, 'media.manage');
  const row = isMediaId(id) ? db.select().from(media).where(eq(media.id, id)).get() : undefined;
  if (!row) throw new NotFoundError();
  const usage = findMediaUsage(db, id);
  if (usage.length > 0) {
    return {
      ok: false,
      errors: { _form: `This image is still in use (${usage.join('; ')}). Remove it there first.` },
    };
  }
  db.delete(media).where(eq(media.id, id)).run();
  const dir = getConfig().uploadsDir;
  await Promise.all(
    (Object.keys(RENDITIONS) as Rendition[]).map((r) =>
      rm(path.join(dir, `${id}-${r}.webp`), { force: true }),
    ),
  );
  recordAudit(db, {
    actor: ctx.actor,
    action: 'media.delete',
    target: { type: 'media', id, label: row.originalName },
    ip: ctx.ip,
  });
  return { ok: true, value: null };
}

/**
 * Reads a rendition for the public /media route. Only files that match the
 * strict naming pattern AND belong to a media record are served, so the
 * route can never read arbitrary paths.
 */
export async function readMediaFile(db: Db, fileName: string): Promise<Buffer | null> {
  const match = FILE_NAME.exec(fileName);
  if (!match) return null;
  const id = match[1]!;
  const exists = db
    .select({ n: sql<number>`1` })
    .from(media)
    .where(eq(media.id, id))
    .get();
  if (!exists) return null;
  try {
    return await readFile(path.join(getConfig().uploadsDir, fileName));
  } catch {
    return null;
  }
}
