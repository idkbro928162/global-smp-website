/**
 * Derives web-ready logo files from the official raster logo.
 *
 * Source: brand/source/based-productions-logo-original.webp
 *   (1254×1254 sRGB, black wordmark on a near-white background, no alpha).
 *
 * The letterforms are NOT redrawn or traced. Every output is produced by
 * converting luminance to alpha (dark ink → opaque, paper → transparent) and
 * recolouring the ink, so the geometry is exactly the original raster's.
 *
 * Limitations (see README "Brand assets"): the wordmark is only 859px wide in
 * the source, so very large renders are slightly soft, and the official logo
 * has no small-size icon mark. A vector (SVG) master and a dedicated icon
 * mark should replace these derivatives when available.
 *
 * Usage: node scripts/brand/process-logo.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(import.meta.dirname, '../..');
const SOURCE = path.join(root, 'brand/source/based-productions-logo-original.webp');
const OUT = path.join(root, 'public/brand');
const PUBLIC = path.join(root, 'public');

// Must match --color-text / --color-bg in src/styles/tokens.css.
const OFF_WHITE = { r: 0xf2, g: 0xf1, b: 0xec };
const INK = { r: 0x0a, g: 0x0a, b: 0x0b };

// Luminance at or above PAPER is fully transparent; at or below SOLID is fully
// opaque. Measured source background is ≥ 251, ink is ≈ 0.
const PAPER = 248;
const SOLID = 12;

type Rgb = { r: number; g: number; b: number };

async function loadGrey() {
  const { data, info } = await sharp(SOURCE)
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 1) throw new Error(`Expected 1 channel, got ${info.channels}`);
  return { data, width: info.width, height: info.height };
}

function inkBounds(grey: Buffer, width: number, height: number) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((grey[y * width + x] ?? 255) < PAPER) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) throw new Error('No ink found in source logo');
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Converts the greyscale crop into RGBA with the given ink colour. */
function toAlpha(grey: Buffer, color: Rgb): Buffer {
  const out = Buffer.alloc(grey.length * 4);
  for (let i = 0; i < grey.length; i++) {
    const l = grey[i] ?? 255;
    const a = Math.round(Math.min(1, Math.max(0, (PAPER - l) / (PAPER - SOLID))) * 255);
    out[i * 4] = color.r;
    out[i * 4 + 1] = color.g;
    out[i * 4 + 2] = color.b;
    out[i * 4 + 3] = a;
  }
  return out;
}

/** Minimal ICO container holding PNG-encoded images (supported by all modern browsers). */
function buildIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + images.length * 16;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const { data, width, height } = await loadGrey();
  const box = inkBounds(data, width, height);
  // Crop in JS: re-encoding a 1-channel raw buffer through sharp().extract()
  // returns 3 channels, which silently scrambles the per-pixel mapping below.
  const crop = Buffer.alloc(box.width * box.height);
  for (let y = 0; y < box.height; y++) {
    const start = (box.top + y) * width + box.left;
    data.copy(crop, y * box.width, start, start + box.width);
  }

  const rgba = (color: Rgb) =>
    sharp(toAlpha(crop, color), { raw: { width: box.width, height: box.height, channels: 4 } });

  // Wordmark for dark surfaces (primary site use) and for light surfaces.
  await rgba(OFF_WHITE).png({ compressionLevel: 9 }).toFile(path.join(OUT, 'wordmark-light.png'));
  await rgba(OFF_WHITE).webp({ lossless: true }).toFile(path.join(OUT, 'wordmark-light.webp'));
  await rgba(INK).png({ compressionLevel: 9 }).toFile(path.join(OUT, 'wordmark-dark.png'));

  // Icons: the unaltered wordmark on the logo's own paper-white square.
  const iconPng = async (size: number, padRatio: number) => {
    const inner = Math.round(size * (1 - padRatio * 2));
    const mark = await rgba(INK).resize({ width: inner, fit: 'inside' }).png().toBuffer();
    return sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .composite([{ input: mark, gravity: 'center' }])
      .png({ compressionLevel: 9 })
      .toBuffer();
  };
  const icon32 = await iconPng(32, 0.03);
  const icon48 = await iconPng(48, 0.04);
  const icon16 = await iconPng(16, 0.02);
  await writeFile(path.join(PUBLIC, 'favicon-32.png'), icon32);
  await writeFile(
    path.join(PUBLIC, 'favicon.ico'),
    buildIco([
      { size: 16, png: icon16 },
      { size: 32, png: icon32 },
      { size: 48, png: icon48 },
    ]),
  );
  // Apple touch icon: the original square composition, downscaled.
  await sharp(SOURCE)
    .resize(180, 180)
    .png({ compressionLevel: 9 })
    .toFile(path.join(PUBLIC, 'apple-touch-icon.png'));

  // Default social preview (Open Graph): light wordmark centred on the site background.
  const ogMark = await rgba(OFF_WHITE).resize({ width: 640 }).png().toBuffer();
  await sharp({
    create: { width: 1200, height: 630, channels: 4, background: { ...INK, alpha: 1 } },
  })
    .composite([{ input: ogMark, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toFile(path.join(OUT, 'og-default.png'));

  console.info(`Wordmark ${box.width}×${box.height} extracted at (${box.left}, ${box.top}).`);
}

await main();
