/**
 * DEVELOPMENT ONLY: fills an empty local database with clearly labelled demo
 * content so layouts can be reviewed. Every item is named "Demo …" and says it
 * is not a real product. It creates no staff accounts or credentials.
 *
 * Refuses to run when NODE_ENV=production, when SITE_URL is https, or when the
 * database already contains products.
 *
 * Usage: npm run demo:seed
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { getConfig } from '../src/server/config.ts';
import { getDb, nowIso } from '../src/server/db/client.ts';
import {
  docPages,
  media,
  productMedia,
  products,
  releases,
  services,
  teamMembers,
} from '../src/server/db/schema.ts';
import { docPageInputSchema } from '../src/server/services/docs.ts';
import { productInputSchema } from '../src/server/services/products.ts';
import { releaseInputSchema } from '../src/server/services/releases.ts';

const config = getConfig();
if (process.env.NODE_ENV === 'production' || config.secure) {
  console.error('Refusing to seed demo data into a production-like environment.');
  process.exit(1);
}
const db = getDb();
if (db.select({ id: products.id }).from(products).limit(1).all().length > 0) {
  console.error('The database already contains products; demo data was not added.');
  process.exit(1);
}

const DEMO_NOTE =
  'Placeholder product used to preview layouts. Not a real Based Productions product.';

async function demoImage(label: string, hue: number, width = 1600, height = 900): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},55%,22%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},60%,9%)"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <g fill="hsl(${hue},70%,60%)" opacity="0.18">${Array.from({ length: 24 }, (_, i) => `<rect x="${(i * 97) % width}" y="${(i * 53) % height}" width="64" height="64"/>`).join('')}</g>
    <text x="64" y="${height - 72}" font-family="monospace" font-size="44" fill="#f2f1ec" opacity="0.85">DEMO ARTWORK · ${label}</text>
  </svg>`;
  const id = randomBytes(16).toString('base64url');
  await mkdir(config.uploadsDir, { recursive: true });
  const source = Buffer.from(svg);
  let lg = { width, height, size: 0 };
  for (const [rendition, max] of [
    ['lg', 1920],
    ['sm', 640],
  ] as const) {
    const { data, info } = await sharp(source)
      .resize({ width: max, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    await writeFile(path.join(config.uploadsDir, `${id}-${rendition}.webp`), data);
    if (rendition === 'lg') lg = { width: info.width, height: info.height, size: info.size };
  }
  db.insert(media)
    .values({
      id,
      originalName: `demo-${label.toLowerCase().replace(/\W+/g, '-')}.webp`,
      alt: `Demo artwork for ${label}`,
      width: lg.width,
      height: lg.height,
      bytes: lg.size,
      createdAt: nowIso(),
    })
    .run();
  return id;
}

const at = nowIso();

const demoProducts = [
  {
    name: 'Demo Warps',
    slug: 'demo-warps',
    accent: 'emerald',
    availability: 'available',
    featured: true,
    hue: 150,
    platforms: ['paper', 'purpur', 'folia'],
    minecraftVersions: ['1.20.4', '1.21.x', '26.1'],
    screenshots: 3,
  },
  {
    name: 'Demo Economy Suite',
    slug: 'demo-economy-suite',
    accent: 'gold',
    availability: 'in_development',
    featured: false,
    hue: 40,
    platforms: ['paper', 'spigot'],
    minecraftVersions: ['1.21.x'],
    screenshots: 0,
  },
  {
    name: 'Demo Product With An Unusually Long Name To Test Wrapping Behaviour',
    slug: 'demo-long-name',
    accent: 'lapis',
    availability: 'available',
    featured: false,
    hue: 225,
    platforms: ['velocity', 'bungeecord', 'paper', 'spigot', 'folia'],
    minecraftVersions: ['1.19.4', '1.20.x', '1.21.x', '26.1', '26.2'],
    screenshots: 0,
    noArtwork: true,
  },
] as const;

for (const [index, demo] of demoProducts.entries()) {
  const artworkId = 'noArtwork' in demo ? '' : await demoImage(demo.name, demo.hue);
  const screenshotIds: string[] = [];
  for (let i = 0; i < demo.screenshots; i++) {
    screenshotIds.push(await demoImage(`${demo.name} screen ${i + 1}`, (demo.hue + i * 25) % 360));
  }
  const input = productInputSchema.parse({
    name: demo.name,
    slug: demo.slug,
    tagline: DEMO_NOTE,
    description: [
      `**${demo.name}** is demo content created by \`npm run demo:seed\`.`,
      '',
      'It exists so the product page layout can be reviewed with realistic structure: headings, lists, links and code.',
      '',
      '### Example configuration',
      '',
      '```yaml',
      '# config.yml (example only)',
      'enabled: true',
      'messages:',
      '  prefix: "<gray>[Demo]</gray>"',
      '```',
      '',
      '- Replace this text in the staff panel',
      '- Or delete the demo database before real content is added',
    ].join('\n'),
    visibility: 'published',
    availability: demo.availability,
    featured: demo.featured,
    sortOrder: index,
    accent: demo.accent,
    artworkId,
    features: [
      { title: 'Demo feature one', body: 'Placeholder description of a feature.' },
      { title: 'Demo feature two', body: 'Placeholder description of another feature.' },
      { title: 'Demo feature three', body: '' },
    ],
    minecraftVersions: [...demo.minecraftVersions],
    platforms: [...demo.platforms],
    javaVersion: '21',
    builtbybitUrl: demo.availability === 'available' ? 'https://builtbybit.com/' : '',
    externalDocsUrl: '',
    supportUrl: '',
    launchedOn: demo.availability === 'available' ? '2026-01-15' : '',
    screenshotIds,
  });
  const row = db
    .insert(products)
    .values({
      ...input,
      artworkId: input.artworkId || null,
      launchedOn: input.launchedOn || null,
      features: JSON.stringify(input.features),
      minecraftVersions: JSON.stringify(input.minecraftVersions),
      platforms: JSON.stringify(input.platforms),
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: products.id })
    .get();
  screenshotIds.forEach((mediaId, position) =>
    db.insert(productMedia).values({ productId: row.id, mediaId, position }).run(),
  );

  if (demo.availability === 'available') {
    for (const [i, version] of ['1.0.0', '1.1.0', '1.2.0-beta.1'].entries()) {
      const release = releaseInputSchema.parse({
        productId: row.id,
        version,
        channel: version.includes('beta') ? 'beta' : 'stable',
        title: i === 0 ? 'Demo initial release' : `Demo update ${i}`,
        notes: `- Demo change for ${version}\n- Another demo change\n\n\`\`\`properties\nexample.setting=true\n\`\`\``,
        releasedOn: `2026-0${i + 2}-10`,
        visibility: 'published',
      });
      db.insert(releases)
        .values({ ...release, createdAt: at, updatedAt: at })
        .run();
    }
    const pages = [
      ['Installation', 'getting-started', 'Getting started'],
      ['Configuration', 'configuration', 'Getting started'],
      ['Commands and permissions', 'commands', 'Reference'],
    ] as const;
    for (const [i, [title, slug, section]] of pages.entries()) {
      const page = docPageInputSchema.parse({
        productId: String(row.id),
        title: `Demo: ${title}`,
        slug,
        summary: 'Demo documentation page used to preview the docs layout.',
        section,
        body: [
          '## Overview',
          '',
          'This is demo documentation text. Replace it with real guides.',
          '',
          '## Steps',
          '',
          '1. Download the plugin from BuiltByBit.',
          '2. Place the jar in your `plugins/` folder.',
          '3. Restart the server.',
          '',
          '### Example',
          '',
          '```yaml',
          'demo:',
          '  a-very-long-line-to-test-horizontal-scrolling-of-code-blocks-on-narrow-screens: "value value value value value"',
          '```',
          '',
          '| Command | Permission | Description |',
          '| --- | --- | --- |',
          '| `/demo reload` | `demo.admin.reload` | Reloads the demo configuration |',
          '| `/demo info` | `demo.info` | Shows demo information |',
          '',
          '> Demo note: this block is a quotation.',
        ].join('\n'),
        sortOrder: i,
        visibility: 'published',
      });
      db.insert(docPages)
        .values({ ...page, createdAt: at, updatedAt: at })
        .run();
    }
  }
}

db.insert(services)
  .values({
    title: 'Demo service',
    summary: 'Placeholder service used to preview the Services page.',
    body: 'Demo description. **Replace or delete** this in the staff panel.',
    sortOrder: 0,
    visibility: 'published',
    createdAt: at,
    updatedAt: at,
  })
  .run();

db.insert(teamMembers)
  .values([
    {
      name: 'Demo Person',
      roleTitle: 'Demo role',
      bio: 'Placeholder team profile used to preview the About page.',
      links: JSON.stringify([{ label: 'Website', url: 'https://example.com' }]),
      sortOrder: 0,
      visibility: 'published',
      createdAt: at,
      updatedAt: at,
    },
    {
      name: 'Another Demo',
      roleTitle: 'Demo role',
      bio: '',
      links: '[]',
      sortOrder: 1,
      visibility: 'published',
      createdAt: at,
      updatedAt: at,
    },
  ])
  .run();

console.info(`Demo content added to ${config.databasePath}.`);
