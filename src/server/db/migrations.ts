/**
 * Ordered SQL migrations. Applied automatically on startup (see client.ts) and
 * by `npm run db:migrate`. Never edit a migration that has shipped — append a
 * new one. `tests/unit/schema-drift.test.ts` fails if these migrations and the
 * Drizzle schema in schema.ts disagree about tables or columns.
 *
 * Migrations are TypeScript strings (not .sql files) so they are bundled into
 * the server build and need no filesystem path resolution at runtime.
 */
export interface Migration {
  name: string;
  sql: string;
}

const VISIBILITY = `TEXT NOT NULL DEFAULT 'draft' CHECK (visibility IN ('draft', 'published'))`;

export const MIGRATIONS: Migration[] = [
  {
    name: '0001_initial',
    sql: /* sql */ `
      CREATE TABLE roles (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        permissions TEXT NOT NULL DEFAULT '[]',
        is_owner INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        password_hash TEXT,
        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT,
        password_changed_at TEXT
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT
      );
      CREATE INDEX sessions_user_idx ON sessions(user_id);

      CREATE TABLE account_tokens (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('setup', 'reset')),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE INDEX account_tokens_user_idx ON account_tokens(user_id);

      CREATE TABLE rate_limit_hits (
        id INTEGER PRIMARY KEY,
        bucket TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX rate_limit_hits_bucket_idx ON rate_limit_hits(bucket, at);

      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY,
        at TEXT NOT NULL,
        actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        actor_label TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        target_label TEXT,
        details TEXT,
        ip TEXT
      );
      CREATE INDEX audit_events_at_idx ON audit_events(at);

      CREATE TABLE media (
        id TEXT PRIMARY KEY,
        original_name TEXT NOT NULL,
        alt TEXT NOT NULL DEFAULT '',
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        bytes INTEGER NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        tagline TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        visibility ${VISIBILITY},
        availability TEXT NOT NULL DEFAULT 'in_development'
          CHECK (availability IN ('in_development', 'available', 'discontinued')),
        featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        accent TEXT NOT NULL DEFAULT 'neutral',
        artwork_id TEXT REFERENCES media(id) ON DELETE SET NULL,
        features TEXT NOT NULL DEFAULT '[]',
        minecraft_versions TEXT NOT NULL DEFAULT '[]',
        platforms TEXT NOT NULL DEFAULT '[]',
        java_version TEXT NOT NULL DEFAULT '',
        builtbybit_url TEXT NOT NULL DEFAULT '',
        external_docs_url TEXT NOT NULL DEFAULT '',
        support_url TEXT NOT NULL DEFAULT '',
        launched_on TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE product_media (
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (product_id, media_id)
      );

      CREATE TABLE releases (
        id INTEGER PRIMARY KEY,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'beta', 'alpha')),
        title TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        released_on TEXT NOT NULL,
        visibility ${VISIBILITY},
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (product_id, version)
      );

      CREATE TABLE doc_pages (
        id INTEGER PRIMARY KEY,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        section TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        visibility ${VISIBILITY},
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      -- One slug per collection; general docs (product_id NULL) share collection 0.
      CREATE UNIQUE INDEX doc_pages_collection_slug_idx ON doc_pages(COALESCE(product_id, 0), slug);

      CREATE TABLE team_members (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        role_title TEXT NOT NULL DEFAULT '',
        bio TEXT NOT NULL DEFAULT '',
        avatar_id TEXT REFERENCES media(id) ON DELETE SET NULL,
        links TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0,
        visibility ${VISIBILITY},
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE services (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        visibility ${VISIBILITY},
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE content_blocks (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
];
