/**
 * Applies pending database migrations. The server also applies them on
 * startup; this script lets you migrate explicitly (e.g. before a deploy).
 *
 * Usage: npm run db:migrate
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { getConfig } from '../src/server/config.ts';
import { applyMigrations } from '../src/server/db/client.ts';

const { databasePath } = getConfig();
mkdirSync(path.dirname(databasePath), { recursive: true });
const sqlite = new Database(databasePath);
sqlite.pragma('foreign_keys = ON');
const ran = applyMigrations(sqlite);
sqlite.close();
console.info(
  ran.length > 0
    ? `Applied ${ran.length} migration(s) to ${databasePath}: ${ran.join(', ')}`
    : `Database at ${databasePath} is up to date.`,
);
