/**
 * Drizzle table definitions used for typed queries. The database itself is
 * created by the SQL in migrations.ts; tests/unit/schema-drift.test.ts keeps
 * the two in agreement.
 *
 * Conventions: timestamps are ISO-8601 strings, calendar dates are
 * "YYYY-MM-DD", booleans are 0/1 integers, and list-valued fields are JSON
 * text parsed defensively in the services layer.
 */
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export type Visibility = 'draft' | 'published';
export type Availability = 'in_development' | 'available' | 'discontinued';
export type ReleaseChannel = 'stable' | 'beta' | 'alpha';
export type UserStatus = 'invited' | 'active' | 'disabled';
export type TokenPurpose = 'setup' | 'reset';

const timestamps = {
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
};

export const roles = sqliteTable('roles', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  permissions: text('permissions').notNull().default('[]'),
  isOwner: integer('is_owner', { mode: 'boolean' }).notNull().default(false),
  ...timestamps,
});

export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash'),
  roleId: integer('role_id')
    .notNull()
    .references(() => roles.id),
  status: text('status').$type<UserStatus>().notNull(),
  ...timestamps,
  lastLoginAt: text('last_login_at'),
  passwordChangedAt: text('password_changed_at'),
});

export const sessions = sqliteTable('sessions', {
  /** SHA-256 of the session token. The raw token exists only in the user's cookie. */
  id: text('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  csrfToken: text('csrf_token').notNull(),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
});

export const accountTokens = sqliteTable('account_tokens', {
  /** SHA-256 of the one-time token. */
  id: text('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  purpose: text('purpose').$type<TokenPurpose>().notNull(),
  createdBy: integer('created_by'),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
});

export const rateLimitHits = sqliteTable('rate_limit_hits', {
  id: integer('id').primaryKey(),
  bucket: text('bucket').notNull(),
  at: integer('at').notNull(),
});

export const auditEvents = sqliteTable('audit_events', {
  id: integer('id').primaryKey(),
  at: text('at').notNull(),
  actorId: integer('actor_id'),
  actorLabel: text('actor_label').notNull(),
  action: text('action').notNull(),
  targetType: text('target_type'),
  targetId: text('target_id'),
  targetLabel: text('target_label'),
  details: text('details'),
  ip: text('ip'),
});

export const media = sqliteTable('media', {
  id: text('id').primaryKey(),
  originalName: text('original_name').notNull(),
  alt: text('alt').notNull().default(''),
  width: integer('width').notNull(),
  height: integer('height').notNull(),
  bytes: integer('bytes').notNull(),
  createdBy: integer('created_by'),
  createdAt: text('created_at').notNull(),
  /** Created by `npm run demo:seed`. Never offered for, or shown on, real content. */
  isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
});

export const products = sqliteTable('products', {
  id: integer('id').primaryKey(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  tagline: text('tagline').notNull().default(''),
  description: text('description').notNull().default(''),
  visibility: text('visibility').$type<Visibility>().notNull().default('draft'),
  availability: text('availability').$type<Availability>().notNull().default('in_development'),
  featured: integer('featured', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  accent: text('accent').notNull().default('neutral'),
  artworkId: text('artwork_id'),
  features: text('features').notNull().default('[]'),
  minecraftVersions: text('minecraft_versions').notNull().default('[]'),
  platforms: text('platforms').notNull().default('[]'),
  javaVersion: text('java_version').notNull().default(''),
  builtbybitUrl: text('builtbybit_url').notNull().default(''),
  externalDocsUrl: text('external_docs_url').notNull().default(''),
  supportUrl: text('support_url').notNull().default(''),
  launchedOn: text('launched_on'),
  ...timestamps,
  /** Created by `npm run demo:seed`. Staff cannot set this. */
  isDemo: integer('is_demo', { mode: 'boolean' }).notNull().default(false),
});

export const productMedia = sqliteTable(
  'product_media',
  {
    productId: integer('product_id').notNull(),
    mediaId: text('media_id').notNull(),
    position: integer('position').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.productId, t.mediaId] })],
);

export const releases = sqliteTable('releases', {
  id: integer('id').primaryKey(),
  productId: integer('product_id').notNull(),
  version: text('version').notNull(),
  channel: text('channel').$type<ReleaseChannel>().notNull().default('stable'),
  title: text('title').notNull().default(''),
  notes: text('notes').notNull().default(''),
  releasedOn: text('released_on').notNull(),
  visibility: text('visibility').$type<Visibility>().notNull().default('draft'),
  ...timestamps,
});

export const docPages = sqliteTable('doc_pages', {
  id: integer('id').primaryKey(),
  productId: integer('product_id'),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull().default(''),
  section: text('section').notNull().default(''),
  body: text('body').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
  visibility: text('visibility').$type<Visibility>().notNull().default('draft'),
  ...timestamps,
});

export const teamMembers = sqliteTable('team_members', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  roleTitle: text('role_title').notNull().default(''),
  bio: text('bio').notNull().default(''),
  avatarId: text('avatar_id'),
  links: text('links').notNull().default('[]'),
  sortOrder: integer('sort_order').notNull().default(0),
  visibility: text('visibility').$type<Visibility>().notNull().default('draft'),
  ...timestamps,
});

export const services = sqliteTable('services', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  summary: text('summary').notNull().default(''),
  body: text('body').notNull().default(''),
  sortOrder: integer('sort_order').notNull().default(0),
  visibility: text('visibility').$type<Visibility>().notNull().default('draft'),
  ...timestamps,
});

export const contentBlocks = sqliteTable('content_blocks', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedBy: integer('updated_by'),
  updatedAt: text('updated_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedBy: integer('updated_by'),
  updatedAt: text('updated_at').notNull(),
});

export const schema = {
  roles,
  users,
  sessions,
  accountTokens,
  rateLimitHits,
  auditEvents,
  media,
  products,
  productMedia,
  releases,
  docPages,
  teamMembers,
  services,
  contentBlocks,
  settings,
};
