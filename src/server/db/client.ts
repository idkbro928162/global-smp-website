import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database, { type RunResult } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import { DEFAULT_ROLES } from '../auth/permissions.ts';
import { getConfig } from '../config.ts';
import { MIGRATIONS } from './migrations.ts';
import { roles, schema } from './schema.ts';

if (typeof window !== 'undefined') {
  throw new Error('The database client must never be imported into browser code.');
}

/**
 * The synchronous SQLite database type shared by the connection and by
 * transactions (`db.transaction((tx) => ...)`), so helpers accept either.
 */
export type Db = BaseSQLiteDatabase<'sync', RunResult, typeof schema>;

export interface DatabaseHandle {
  sqlite: Database.Database;
  db: Db;
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}

export function applyMigrations(sqlite: Database.Database): string[] {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  const applied = new Set(
    sqlite.prepare('SELECT name FROM schema_migrations').pluck().all() as string[],
  );
  const known = new Set(MIGRATIONS.map((m) => m.name));
  const unknown = [...applied].filter((name) => !known.has(name));
  if (unknown.length > 0) {
    // The database was migrated by a newer version of the code. Refuse to run
    // rather than read or write a schema this build does not understand.
    throw new Error(`Database has migrations unknown to this build: ${unknown.join(', ')}`);
  }
  const ran: string[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      sqlite
        .prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')
        .run(migration.name, nowIso());
    })();
    ran.push(migration.name);
  }
  return ran;
}

function seedDefaultRoles(db: Db): void {
  const existing = db.select({ id: roles.id }).from(roles).limit(1).all();
  if (existing.length > 0) return;
  const at = nowIso();
  db.insert(roles)
    .values(
      DEFAULT_ROLES.map((role) => ({
        name: role.name,
        description: role.description,
        isOwner: role.isOwner,
        permissions: JSON.stringify(role.permissions),
        createdAt: at,
        updatedAt: at,
      })),
    )
    .run();
}

export function openDatabase(file: string): DatabaseHandle {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  applyMigrations(sqlite);
  const db = drizzle({ client: sqlite, schema });
  seedDefaultRoles(db);
  return { sqlite, db };
}

let handle: DatabaseHandle | undefined;

/** Process-wide database handle, opened lazily from DATA_DIR. */
export function getDb(): Db {
  handle ??= openDatabase(getConfig().databasePath);
  return handle.db;
}

/** Test hook: use a specific database (e.g. in-memory) for subsequent getDb() calls. */
export function setDatabaseForTests(next: DatabaseHandle | undefined): void {
  if (handle && handle !== next) handle.sqlite.close();
  handle = next;
}
