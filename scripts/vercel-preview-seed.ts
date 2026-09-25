/**
 * VERCEL PREVIEW BUILDS ONLY (see astro.config.mjs and "vercel-build" in
 * package.json). Creates a throwaway database containing only the clearly
 * labelled demo content from scripts/seed-demo.ts — no staff accounts — in
 * .vercel-preview-seed/, which is bundled into the preview function and copied
 * into DATA_DIR when an instance starts without a database.
 *
 * The demo seed refuses https or production environments to protect real
 * databases. This script runs it only against a new, empty build-time
 * directory, so it passes a local development environment explicitly.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

if (process.env.VERCEL !== '1') {
  console.error('vercel-preview-seed only runs inside a Vercel build (VERCEL=1).');
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, '..');
const seedDir = path.join(root, '.vercel-preview-seed');
rmSync(seedDir, { recursive: true, force: true });

const seed = spawnSync(process.execPath, ['scripts/seed-demo.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    PATH: process.env.PATH,
    NODE_ENV: 'development',
    SITE_URL: 'http://localhost:4321',
    DATA_DIR: seedDir,
  },
});
if (seed.status !== 0) throw new Error('Demo seed failed');

// Fold the write-ahead log into the main file so the snapshot is one file.
const db = new Database(path.join(seedDir, 'based-productions.db'));
db.pragma('wal_checkpoint(TRUNCATE)');
db.pragma('journal_mode = DELETE');
db.close();

const files = readdirSync(seedDir, { recursive: true, encoding: 'utf8' });
console.info(`Preview seed ready: ${files.length} entries in .vercel-preview-seed/`);
