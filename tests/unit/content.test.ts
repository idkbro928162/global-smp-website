import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../src/server/auth/authorization.ts';
import { resetConfigForTests } from '../../src/server/config.ts';
import type { Db } from '../../src/server/db/client.ts';
import { contentBlocks, products, settings as settingsTable } from '../../src/server/db/schema.ts';
import {
  createDocPage,
  getPublishedDocPage,
  listDocCollections,
} from '../../src/server/services/docs.ts';
import { deleteMedia, readMediaFile, uploadImage } from '../../src/server/services/media.ts';
import {
  createProduct,
  getPublishedProduct,
  listPublishedProducts,
  updateProduct,
} from '../../src/server/services/products.ts';
import { createRelease } from '../../src/server/services/releases.ts';
import {
  getContent,
  getSettings,
  updateContent,
  updateSettings,
} from '../../src/server/services/site.ts';
import { CONTENT_BLOCKS } from '../../src/lib/site-registry.ts';
import { ctx, freshDb, makeActor } from '../helpers/db.ts';

function product(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Test Plugin',
    slug: 'test-plugin',
    tagline: 'A tagline',
    description: '',
    visibility: 'published',
    availability: 'available',
    featured: false,
    sortOrder: 0,
    accent: 'emerald',
    artworkId: '',
    features: [],
    minecraftVersions: ['1.21.x'],
    platforms: ['paper'],
    javaVersion: '21',
    builtbybitUrl: '',
    externalDocsUrl: '',
    supportUrl: '',
    launchedOn: '',
    screenshotIds: [],
    ...overrides,
  };
}

function created(result: { ok: boolean; value?: { id: number }; errors?: unknown }): number {
  if (!result.ok || !result.value)
    throw new Error(`Expected success: ${JSON.stringify(result.errors)}`);
  return result.value.id;
}

describe('products', () => {
  let db: Db;
  let editor: Actor;
  beforeEach(() => {
    db = freshDb();
    editor = makeActor(db, ['panel.access', 'products.manage', 'releases.manage', 'docs.manage']);
  });

  it('shows only published products publicly', () => {
    created(createProduct(db, ctx(editor), product()));
    created(
      createProduct(
        db,
        ctx(editor),
        product({ slug: 'secret', name: 'Secret', visibility: 'draft' }),
      ),
    );
    expect(listPublishedProducts(db).map((p) => p.slug)).toEqual(['test-plugin']);
    expect(getPublishedProduct(db, 'secret')).toBeNull();
    expect(getPublishedProduct(db, 'does-not-exist')).toBeNull();
  });

  it('validates marketplace links, slugs and versions', () => {
    const result = createProduct(
      db,
      ctx(editor),
      product({
        builtbybitUrl: 'https://builtbybit.com.evil.example/x',
        slug: 'Bad Slug',
        minecraftVersions: ['1.21.x', 'latest'],
        platforms: ['paper', 'bedrock'],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors)).toEqual(
      expect.arrayContaining(['builtbybitUrl', 'slug', 'minecraftVersions.1', 'platforms.1']),
    );
  });

  it('rejects duplicate slugs with a field error instead of crashing', () => {
    created(createProduct(db, ctx(editor), product()));
    const again = createProduct(db, ctx(editor), product({ name: 'Other' }));
    expect(again).toEqual({
      ok: false,
      errors: { slug: 'Another product already uses this slug.' },
    });
  });

  it('survives malformed or tampered data in stored columns', () => {
    const id = created(createProduct(db, ctx(editor), product()));
    db.update(products)
      .set({
        builtbybitUrl: 'javascript:alert(1)',
        supportUrl: 'http://insecure.example',
        features: '{not json',
        platforms: '["paper","bedrock",7]',
        minecraftVersions: '"1.21"',
        accent: 'hotpink',
      })
      .where(eq(products.id, id))
      .run();
    const p = getPublishedProduct(db, 'test-plugin')!;
    expect(p.builtbybitUrl).toBe('');
    expect(p.supportUrl).toBe('');
    expect(p.features).toEqual([]);
    expect(p.platforms).toEqual(['paper']);
    expect(p.minecraftVersions).toEqual([]);
    expect(p.accent).toBe('neutral');
    expect(p.artwork).toBeNull();
  });

  it('prefers the newest stable release as the latest version', () => {
    const productId = created(createProduct(db, ctx(editor), product()));
    const release = (
      version: string,
      channel: string,
      releasedOn: string,
      visibility = 'published',
    ) =>
      created(
        createRelease(db, ctx(editor), {
          productId,
          version,
          channel,
          title: '',
          notes: '',
          releasedOn,
          visibility,
        }),
      );
    release('1.0.0', 'stable', '2026-01-01');
    release('1.1.0-beta.1', 'beta', '2026-03-01');
    release('1.1.0', 'stable', '2026-04-01', 'draft');
    expect(getPublishedProduct(db, 'test-plugin')?.latestRelease?.version).toBe('1.0.0');
  });

  it('long names and missing optional data are stored and returned intact', () => {
    const name = 'A'.repeat(80);
    const id = created(
      createProduct(
        db,
        ctx(editor),
        product({ name, tagline: '', minecraftVersions: [], platforms: [] }),
      ),
    );
    expect(updateProduct(db, ctx(editor), id, product({ name: 'B'.repeat(81) })).ok).toBe(false);
    const p = getPublishedProduct(db, 'test-plugin')!;
    expect(p.name).toBe(name);
    expect(p.latestRelease).toBeNull();
    expect(p.docPageCount).toBe(0);
  });
});

describe('documentation', () => {
  let db: Db;
  let writer: Actor;
  beforeEach(() => {
    db = freshDb();
    writer = makeActor(db, ['panel.access', 'products.manage', 'docs.manage']);
  });

  const page = (overrides: Record<string, unknown>) => ({
    productId: '',
    title: 'Page',
    slug: 'page',
    summary: '',
    section: '',
    body: 'Body',
    sortOrder: '0',
    visibility: 'published',
    ...overrides,
  });

  it('groups published pages into collections and orders reading by section', () => {
    const productId = created(createProduct(db, ctx(writer), product()));
    created(
      createDocPage(
        db,
        ctx(writer),
        page({
          productId: String(productId),
          slug: 'install',
          title: 'Install',
          section: 'Start',
          sortOrder: '1',
        }),
      ),
    );
    created(
      createDocPage(
        db,
        ctx(writer),
        page({
          productId: String(productId),
          slug: 'commands',
          title: 'Commands',
          section: 'Reference',
          sortOrder: '0',
        }),
      ),
    );
    created(
      createDocPage(
        db,
        ctx(writer),
        page({
          productId: String(productId),
          slug: 'config',
          title: 'Config',
          section: 'Start',
          sortOrder: '2',
        }),
      ),
    );
    created(
      createDocPage(
        db,
        ctx(writer),
        page({ productId: String(productId), slug: 'draft', visibility: 'draft' }),
      ),
    );

    const collections = listDocCollections(db);
    expect(collections.map((c) => c.key)).toEqual(['test-plugin']);
    const view = getPublishedDocPage(db, 'test-plugin', 'config')!;
    expect(view.sections.map((s) => s.title)).toEqual(['Reference', 'Start']);
    expect(view.previous?.slug).toBe('install');
    expect(view.next).toBeNull();
    expect(getPublishedDocPage(db, 'test-plugin', 'draft')).toBeNull();
  });

  it('allows the same slug in different collections but not within one', () => {
    const productId = created(createProduct(db, ctx(writer), product()));
    created(createDocPage(db, ctx(writer), page({ slug: 'intro' })));
    created(createDocPage(db, ctx(writer), page({ productId: String(productId), slug: 'intro' })));
    const dup = createDocPage(db, ctx(writer), page({ slug: 'intro' }));
    expect(dup.ok).toBe(false);
  });

  it('hides docs of unpublished products', () => {
    const productId = created(createProduct(db, ctx(writer), product({ visibility: 'draft' })));
    created(createDocPage(db, ctx(writer), page({ productId: String(productId) })));
    expect(listDocCollections(db)).toEqual([]);
    expect(getPublishedDocPage(db, 'test-plugin', 'page')).toBeNull();
  });
});

describe('site content and settings', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it('falls back to defaults and stores nothing when a block is set back to its default', () => {
    const editor = makeActor(db, ['panel.access', 'content.manage']);
    expect(getContent(db)['home.hero.title']).toBe(CONTENT_BLOCKS['home.hero.title'].defaultValue);
    expect(updateContent(db, ctx(editor), { 'home.hero.title': 'New headline' }).ok).toBe(true);
    expect(getContent(db)['home.hero.title']).toBe('New headline');
    updateContent(db, ctx(editor), {
      'home.hero.title': CONTENT_BLOCKS['home.hero.title'].defaultValue,
    });
    expect(db.select().from(contentBlocks).all()).toHaveLength(0);
    expect(updateContent(db, ctx(editor), { 'home.hero.title': '   ' }).ok).toBe(false);
  });

  it('leaves settings empty (never a fake link) until configured, and validates hosts', () => {
    const admin = makeActor(db, ['panel.access', 'settings.manage']);
    expect(getSettings(db)['links.discord']).toBe('');
    const bad = updateSettings(db, ctx(admin), {
      'links.discord': 'https://discord.evil.example/invite',
      'links.builtbybit': 'http://builtbybit.com/x',
      'contact.email': 'not-an-email',
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok)
      expect(Object.keys(bad.errors).sort()).toEqual([
        'contact.email',
        'links.builtbybit',
        'links.discord',
      ]);
    expect(
      updateSettings(db, ctx(admin), { 'links.discord': 'https://discord.gg/abc123', unknown: 'x' })
        .ok,
    ).toBe(true);
    expect(getSettings(db)['links.discord']).toBe('https://discord.gg/abc123');
    expect(updateSettings(db, ctx(admin), { 'links.discord': '' }).ok).toBe(true);
    expect(getSettings(db)['links.discord']).toBe('');
    // A tampered stored value is treated as unset rather than rendered.
    db.insert(settingsTable)
      .values({ key: 'links.discord', value: 'javascript:alert(1)', updatedAt: 'x' })
      .run();
    expect(getSettings(db)['links.discord']).toBe('');
  });
});

describe('media uploads', () => {
  let dataDir: string;
  let db: Db;
  let actor: Actor;

  beforeAll(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'bp-media-'));
    process.env.DATA_DIR = dataDir;
    resetConfigForTests();
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
    resetConfigForTests();
  });
  beforeEach(() => {
    db = freshDb();
    actor = makeActor(db, ['panel.access', 'media.manage', 'products.manage']);
  });

  const png = () =>
    sharp({ create: { width: 800, height: 450, channels: 3, background: '#336699' } })
      .png()
      .toBuffer();

  it('re-encodes images to WebP renditions and serves only known files', async () => {
    const file = new File([new Uint8Array(await png())], 'shot.png', { type: 'image/png' });
    const result = await uploadImage(db, ctx(actor), file, 'A screenshot');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const files = readdirSync(path.join(dataDir, 'uploads'));
    expect(files).toEqual(
      expect.arrayContaining([`${result.value.id}-lg.webp`, `${result.value.id}-sm.webp`]),
    );
    const served = await readMediaFile(db, `${result.value.id}-sm.webp`);
    expect(served?.subarray(8, 12).toString()).toBe('WEBP');
    for (const name of [
      '../based-productions.db',
      `${result.value.id}-lg.png`,
      `..%2F${result.value.id}-lg.webp`,
      'x'.repeat(22) + '-lg.webp',
    ]) {
      expect(await readMediaFile(db, name)).toBeNull();
    }
  });

  it('rejects files that are not images, whatever their name or declared type', async () => {
    const fake = new File(['<svg onload="alert(1)"></svg>'], 'image.png', { type: 'image/png' });
    const result = await uploadImage(db, ctx(actor), fake, '');
    expect(result).toMatchObject({ ok: false });
    const svg = new File(
      ['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'],
      'a.svg',
      { type: 'image/svg+xml' },
    );
    expect((await uploadImage(db, ctx(actor), svg, '')).ok).toBe(false);
  });

  it('returns a form error (not a crash) for a truncated image and leaves no files', async () => {
    // Regression: decoding errors used to escape as a server error.
    const noisy = await sharp({
      create: {
        width: 800,
        height: 800,
        channels: 3,
        background: '#000000',
        noise: { type: 'gaussian', mean: 128, sigma: 30 },
      },
    })
      .png()
      .toBuffer();
    const truncated = noisy.subarray(0, Math.floor(noisy.length / 3));
    const before = readdirSync(path.join(dataDir, 'uploads')).length;
    const result = await uploadImage(
      db,
      ctx(actor),
      new File([new Uint8Array(truncated)], 'broken.png', { type: 'image/png' }),
      '',
    );
    expect(result).toEqual({
      ok: false,
      errors: { file: 'This image could not be processed. It may be damaged or incomplete.' },
    });
    expect(readdirSync(path.join(dataDir, 'uploads'))).toHaveLength(before);
  });

  it('refuses to delete an image that a product uses', async () => {
    const file = new File([new Uint8Array(await png())], 'art.png', { type: 'image/png' });
    const upload = await uploadImage(db, ctx(actor), file, 'Art');
    if (!upload.ok) throw new Error('upload failed');
    created(createProduct(db, ctx(actor), product({ artworkId: upload.value.id })));
    const result = await deleteMedia(db, ctx(actor), upload.value.id);
    expect(result.ok).toBe(false);
  });
});
