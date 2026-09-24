/**
 * Append-only audit log of administrative actions. There is deliberately no
 * UI or service function to edit or delete audit events.
 *
 * Details must never contain secrets (passwords, tokens, setup links) or full
 * content bodies — record which fields changed, not their values.
 */
import { desc, like, sql } from 'drizzle-orm';
import { assertCan, type Actor } from '../auth/authorization.ts';
import { nowIso, type Db } from '../db/client.ts';
import { auditEvents } from '../db/schema.ts';

export interface AuditInput {
  /** The acting staff member, or a label for non-staff actors (e.g. "system (CLI)"). */
  actor: Actor | { label: string };
  action: string;
  target?: { type: string; id?: string | number | null; label?: string | null };
  details?: Record<string, unknown>;
  ip?: string | null;
}

export function recordAudit(db: Db, input: AuditInput, now: Date = new Date()): void {
  const actor = input.actor;
  const isStaff = 'id' in actor;
  db.insert(auditEvents)
    .values({
      at: nowIso(now),
      actorId: isStaff ? actor.id : null,
      actorLabel: (isStaff ? actor.email : actor.label).slice(0, 254),
      action: input.action,
      targetType: input.target?.type ?? null,
      targetId: input.target?.id != null ? String(input.target.id) : null,
      targetLabel: input.target?.label?.slice(0, 200) ?? null,
      details: input.details ? JSON.stringify(input.details).slice(0, 4000) : null,
      ip: input.ip ?? null,
    })
    .run();
}

export interface AuditEventView {
  id: number;
  at: string;
  actorLabel: string;
  action: string;
  targetType: string | null;
  targetLabel: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
}

export const AUDIT_PAGE_SIZE = 50;

function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function listAuditEvents(
  db: Db,
  actor: Actor,
  options: { page?: number; actionPrefix?: string } = {},
): { events: AuditEventView[]; page: number; hasMore: boolean; total: number } {
  assertCan(actor, 'audit.view');
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const prefix = options.actionPrefix?.replace(/[^a-z_.]/g, '') ?? '';
  const where = prefix ? like(auditEvents.action, `${prefix}%`) : undefined;
  const rows = db
    .select()
    .from(auditEvents)
    .where(where)
    .orderBy(desc(auditEvents.id))
    .limit(AUDIT_PAGE_SIZE + 1)
    .offset((page - 1) * AUDIT_PAGE_SIZE)
    .all();
  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(auditEvents)
      .where(where)
      .get()?.n ?? 0;
  return {
    page,
    total,
    hasMore: rows.length > AUDIT_PAGE_SIZE,
    events: rows.slice(0, AUDIT_PAGE_SIZE).map((row) => ({
      id: row.id,
      at: row.at,
      actorLabel: row.actorLabel,
      action: row.action,
      targetType: row.targetType,
      targetLabel: row.targetLabel,
      details: parseDetails(row.details),
      ip: row.ip,
    })),
  };
}

/** Recent events for the dashboard (requires audit.view). */
export function recentAuditEvents(db: Db, actor: Actor, limit = 8): AuditEventView[] {
  return listAuditEvents(db, actor).events.slice(0, limit);
}
