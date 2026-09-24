/**
 * Editable website copy (content blocks) and site settings (external links).
 * Keys are defined in src/lib/site-registry.ts; unknown keys are rejected.
 */
import { eq } from 'drizzle-orm';
import { assertCan } from '../auth/authorization.ts';
import { nowIso, type Db } from '../db/client.ts';
import { contentBlocks, settings } from '../db/schema.ts';
import {
  CONTENT_BLOCKS,
  SETTINGS,
  isContentKey,
  isSettingKey,
  type ContentKey,
  type SettingKey,
} from '../../lib/site-registry.ts';
import { emailSchema, type FieldErrors, type Result, urlProblem } from '../../lib/validation.ts';
import { recordAudit } from './audit.ts';
import type { MutationContext } from './common.ts';

export type ContentValues = Record<ContentKey, string>;
export type SettingValues = Record<SettingKey, string>;

const CONTENT_KEYS = Object.keys(CONTENT_BLOCKS) as ContentKey[];
const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

/** Every content block, with registry defaults for blocks never edited. */
export function getContent(db: Db): ContentValues {
  const stored = new Map(
    db
      .select()
      .from(contentBlocks)
      .all()
      .filter((row) => isContentKey(row.key))
      .map((row) => [row.key, row.value]),
  );
  return Object.fromEntries(
    CONTENT_KEYS.map((key) => [key, stored.get(key) ?? CONTENT_BLOCKS[key].defaultValue]),
  ) as ContentValues;
}

/** Keys whose stored value differs from the registry default. */
export function customisedContentKeys(db: Db): Set<ContentKey> {
  return new Set(
    db
      .select({ key: contentBlocks.key })
      .from(contentBlocks)
      .all()
      .map((r) => r.key)
      .filter(isContentKey),
  );
}

export function updateContent(
  db: Db,
  ctx: MutationContext,
  input: Record<string, unknown>,
): Result<null> {
  assertCan(ctx.actor, 'content.manage');
  const errors: FieldErrors = {};
  const values = new Map<ContentKey, string>();
  for (const key of CONTENT_KEYS) {
    const raw = input[key];
    if (raw === undefined) continue;
    const value = typeof raw === 'string' ? raw.replace(/\r\n/g, '\n').trim() : '';
    const definition = CONTENT_BLOCKS[key];
    if (value.length > definition.maxLength) {
      errors[key] = `Use at most ${definition.maxLength} characters.`;
    } else if (key === 'home.hero.title' && value === '') {
      errors[key] = 'The homepage needs a headline.';
    } else {
      values.set(key, value);
    }
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const current = getContent(db);
  const changed: ContentKey[] = [];
  const at = nowIso();
  db.transaction((tx) => {
    for (const [key, value] of values) {
      if (value === current[key]) continue;
      changed.push(key);
      if (value === CONTENT_BLOCKS[key].defaultValue) {
        // Storing nothing means future improvements to the default apply.
        tx.delete(contentBlocks).where(eq(contentBlocks.key, key)).run();
      } else {
        tx.insert(contentBlocks)
          .values({ key, value, updatedBy: ctx.actor.id, updatedAt: at })
          .onConflictDoUpdate({
            target: contentBlocks.key,
            set: { value, updatedBy: ctx.actor.id, updatedAt: at },
          })
          .run();
      }
    }
  });
  if (changed.length > 0) {
    recordAudit(db, {
      actor: ctx.actor,
      action: 'content.update',
      target: { type: 'content' },
      details: { keys: changed },
      ip: ctx.ip,
    });
  }
  return { ok: true, value: null };
}

export function resetContentBlock(db: Db, ctx: MutationContext, key: string): void {
  assertCan(ctx.actor, 'content.manage');
  if (!isContentKey(key)) return;
  const removed = db.delete(contentBlocks).where(eq(contentBlocks.key, key)).run().changes;
  if (removed > 0) {
    recordAudit(db, {
      actor: ctx.actor,
      action: 'content.reset',
      target: { type: 'content', id: key, label: CONTENT_BLOCKS[key].label },
      ip: ctx.ip,
    });
  }
}

/** All settings; unset values are empty strings (never substituted). */
export function getSettings(db: Db): SettingValues {
  const stored = new Map(
    db
      .select()
      .from(settings)
      .all()
      .filter((row) => isSettingKey(row.key))
      .map((row) => [row.key, row.value]),
  );
  // Stored values are re-checked so a corrupted row is treated as "not set".
  return Object.fromEntries(
    SETTING_KEYS.map((key) => {
      const value = stored.get(key) ?? '';
      return [key, settingProblem(key, value) === null ? value : ''];
    }),
  ) as SettingValues;
}

function settingProblem(key: SettingKey, value: string): string | null {
  if (value === '') return null;
  const definition: { kind: string; hosts?: readonly string[] } = SETTINGS[key];
  if (definition.kind === 'email') {
    return emailSchema.safeParse(value).success ? null : 'Enter a valid email address.';
  }
  return value.length > 500 ? 'Use at most 500 characters.' : urlProblem(value, definition.hosts);
}

export function updateSettings(
  db: Db,
  ctx: MutationContext,
  input: Record<string, unknown>,
): Result<null> {
  assertCan(ctx.actor, 'settings.manage');
  const errors: FieldErrors = {};
  const values = new Map<SettingKey, string>();
  for (const key of SETTING_KEYS) {
    const raw = input[key];
    if (raw === undefined) continue;
    let value = typeof raw === 'string' ? raw.trim() : '';
    if (SETTINGS[key].kind === 'email') value = value.toLowerCase();
    const problem = settingProblem(key, value);
    if (problem) errors[key] = problem;
    else values.set(key, value);
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const current = getSettings(db);
  const changed: SettingKey[] = [];
  const at = nowIso();
  db.transaction((tx) => {
    for (const [key, value] of values) {
      if (value === current[key]) continue;
      changed.push(key);
      if (value === '') {
        tx.delete(settings).where(eq(settings.key, key)).run();
      } else {
        tx.insert(settings)
          .values({ key, value, updatedBy: ctx.actor.id, updatedAt: at })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedBy: ctx.actor.id, updatedAt: at },
          })
          .run();
      }
    }
  });
  if (changed.length > 0) {
    recordAudit(db, {
      actor: ctx.actor,
      action: 'settings.update',
      target: { type: 'settings' },
      // Setting values are public links, but record keys only for consistency.
      details: { keys: changed },
      ip: ctx.ip,
    });
  }
  return { ok: true, value: null };
}
