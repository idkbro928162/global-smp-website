import Database from 'better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseSiteUrl, resetConfigForTests } from '../../src/server/config.ts';
import {
  sessionCookieDeleteOptions,
  sessionCookieName,
  sessionCookieOptions,
} from '../../src/server/auth/sessions.ts';
import { applyMigrations } from '../../src/server/db/client.ts';
import { schema } from '../../src/server/db/schema.ts';
import { productValuesFromForm, splitList } from '../../src/server/staff/forms.ts';

describe('database schema', () => {
  it('matches the SQL migrations exactly (tables and columns)', () => {
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite);
    for (const table of Object.values(schema)) {
      const config = getTableConfig(table);
      const columns = sqlite
        .prepare(`PRAGMA table_info(${config.name})`)
        .all()
        .map((c) => (c as { name: string }).name)
        .sort();
      expect(columns, `table ${config.name}`).toEqual(config.columns.map((c) => c.name).sort());
    }
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .pluck()
      .all() as string[];
    expect(tables.sort()).toEqual(
      [...Object.values(schema).map((t) => getTableConfig(t).name), 'schema_migrations'].sort(),
    );
  });

  it('applies migrations idempotently and refuses a database from a newer build', () => {
    const sqlite = new Database(':memory:');
    expect(applyMigrations(sqlite)).toEqual(['0001_initial', '0002_demo_content_flags']);
    expect(applyMigrations(sqlite)).toEqual([]);
    sqlite.prepare("INSERT INTO schema_migrations VALUES ('9999_future', 'x')").run();
    expect(() => applyMigrations(sqlite)).toThrow(/unknown to this build/);
  });
});

describe('configuration', () => {
  it('requires SITE_URL to be a bare origin', () => {
    expect(parseSiteUrl('https://basedproductions.xyz').origin).toBe(
      'https://basedproductions.xyz',
    );
    expect(() => parseSiteUrl('https://basedproductions.xyz/path')).toThrow();
    expect(() => parseSiteUrl('ftp://basedproductions.xyz')).toThrow();
    expect(() => parseSiteUrl('nonsense')).toThrow();
  });

  it('derives secure cookies from the site URL and ignores TRUST_PROXY unless exactly "true"', () => {
    const https = loadConfig({ SITE_URL: 'https://basedproductions.xyz', TRUST_PROXY: 'yes' });
    expect(https.secure).toBe(true);
    expect(https.trustProxy).toBe(false);
    const dev = loadConfig({ SITE_URL: 'http://localhost:4321', TRUST_PROXY: 'TRUE' });
    expect(dev.secure).toBe(false);
    expect(dev.trustProxy).toBe(true);
  });
});

describe('staff form parsing', () => {
  it('drops blank feature rows and splits version lists', () => {
    const form = new FormData();
    form.set('features.0.title', 'Fast');
    form.set('features.0.body', '');
    form.set('features.1.title', '   ');
    form.set('features.1.body', '');
    form.set('features.2.title', 'Safe');
    form.set('features.2.body', 'Very');
    form.set('featured', 'on');
    const values = productValuesFromForm(form);
    expect(values.features).toEqual([
      { title: 'Fast', body: '' },
      { title: 'Safe', body: 'Very' },
    ]);
    expect(values.featured).toBe(true);
    expect(splitList(' 1.20.4, 1.21.x  26.1,, ')).toEqual(['1.20.4', '1.21.x', '26.1']);
  });
});

describe('session cookie attributes', () => {
  it('uses a __Host- cookie over HTTPS and deletes it with matching attributes', () => {
    // Regression: deleting without Secure left the __Host- cookie in the browser.
    process.env.SITE_URL = 'https://basedproductions.xyz';
    resetConfigForTests();
    try {
      expect(sessionCookieName()).toBe('__Host-bp_session');
      const set = sessionCookieOptions(new Date());
      const del = sessionCookieDeleteOptions();
      for (const options of [set, del]) {
        expect(options).toMatchObject({ secure: true, path: '/', httpOnly: true, sameSite: 'lax' });
      }
    } finally {
      delete process.env.SITE_URL;
      resetConfigForTests();
    }
  });
});
