/**
 * Staff dashboard data: real content counts and a configuration checklist.
 * Deliberately no charts, traffic or sales figures — the site has no such
 * data (purchases happen on BuiltByBit, support on Discord).
 */
import { and, eq, sql } from 'drizzle-orm';
import { can, type Actor } from '../auth/authorization.ts';
import type { Db } from '../db/client.ts';
import { docPages, products, releases, services, teamMembers } from '../db/schema.ts';
import { SETTINGS, type SettingKey } from '../../lib/site-registry.ts';
import { recentAuditEvents, type AuditEventView } from './audit.ts';
import { listRecentPublishedReleases, type Release } from './releases.ts';
import { getSettings } from './site.ts';

export interface ChecklistItem {
  tone: 'warning' | 'info';
  message: string;
  href?: string;
  linkLabel?: string;
}

export interface CountPair {
  published: number;
  draft: number;
}

export interface DashboardData {
  counts: {
    label: string;
    href: string;
    value: CountPair;
  }[];
  checklist: ChecklistItem[];
  recentReleases: Release[] | null;
  recentActivity: AuditEventView[] | null;
}

type CountableTable =
  typeof products | typeof releases | typeof docPages | typeof teamMembers | typeof services;

function countByVisibility(db: Db, table: CountableTable): CountPair {
  const rows = db
    .select({ visibility: table.visibility, n: sql<number>`count(*)` })
    .from(table)
    .groupBy(table.visibility)
    .all();
  return {
    published: rows.find((r) => r.visibility === 'published')?.n ?? 0,
    draft: rows.find((r) => r.visibility === 'draft')?.n ?? 0,
  };
}

function productNames(db: Db, condition: ReturnType<typeof and>): string[] {
  return db
    .select({ name: products.name })
    .from(products)
    .where(condition)
    .all()
    .map((r) => r.name);
}

function listNames(names: string[]): string {
  return names.length <= 3
    ? names.join(', ')
    : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

export function getDashboard(db: Db, actor: Actor): DashboardData {
  const counts: DashboardData['counts'] = [];
  if (can(actor, 'products.manage')) {
    counts.push({
      label: 'Products',
      href: '/staff/products',
      value: countByVisibility(db, products),
    });
  }
  if (can(actor, 'releases.manage')) {
    counts.push({
      label: 'Releases',
      href: '/staff/releases',
      value: countByVisibility(db, releases),
    });
  }
  if (can(actor, 'docs.manage')) {
    counts.push({
      label: 'Doc pages',
      href: '/staff/docs',
      value: countByVisibility(db, docPages),
    });
  }
  if (can(actor, 'team.manage')) {
    counts.push({
      label: 'Team profiles',
      href: '/staff/team',
      value: countByVisibility(db, teamMembers),
    });
  }
  if (can(actor, 'content.manage')) {
    counts.push({
      label: 'Services',
      href: '/staff/services',
      value: countByVisibility(db, services),
    });
  }

  const checklist: ChecklistItem[] = [];
  const settings = getSettings(db);
  const canSettings = can(actor, 'settings.manage');
  for (const key of Object.keys(SETTINGS) as SettingKey[]) {
    if (!SETTINGS[key].recommended || settings[key]) continue;
    checklist.push({
      tone: 'warning',
      message: `${SETTINGS[key].label} is not set. The public site shows a "not yet available" note instead.`,
      ...(canSettings ? { href: '/staff/settings', linkLabel: 'Open settings' } : {}),
    });
  }

  if (can(actor, 'products.manage')) {
    const published = eq(products.visibility, 'published');
    const publishedCount = countByVisibility(db, products).published;
    if (publishedCount === 0) {
      checklist.push({
        tone: 'info',
        message: 'No products are published yet. The Products page shows an empty state.',
        href: '/staff/products',
        linkLabel: 'Manage products',
      });
    }
    const noListing = productNames(
      db,
      and(published, eq(products.availability, 'available'), eq(products.builtbybitUrl, '')),
    );
    if (noListing.length > 0) {
      checklist.push({
        tone: 'warning',
        message: `Marked available but missing a BuiltByBit listing link: ${listNames(noListing)}.`,
        href: '/staff/products',
        linkLabel: 'Manage products',
      });
    }
    // Demo-seed artwork on a real product is not shown, so it counts as none.
    const noArtwork = productNames(
      db,
      and(
        published,
        sql`(${products.artworkId} IS NULL OR (${products.isDemo} = 0 AND ${products.artworkId} IN (SELECT id FROM media WHERE is_demo = 1)))`,
      ),
    );
    if (noArtwork.length > 0) {
      checklist.push({
        tone: 'info',
        message: `Published without artwork (a neutral placeholder is shown): ${listNames(noArtwork)}.`,
        href: '/staff/products',
        linkLabel: 'Manage products',
      });
    }
    const noDocs = productNames(
      db,
      and(
        published,
        eq(products.externalDocsUrl, ''),
        sql`NOT EXISTS (SELECT 1 FROM doc_pages d WHERE d.product_id = ${products.id} AND d.visibility = 'published')`,
      ),
    );
    if (noDocs.length > 0) {
      checklist.push({
        tone: 'info',
        message: `Published without documentation: ${listNames(noDocs)}.`,
        ...(can(actor, 'docs.manage') ? { href: '/staff/docs', linkLabel: 'Manage docs' } : {}),
      });
    }
    const demo = productNames(db, eq(products.isDemo, true));
    if (demo.length > 0) {
      checklist.push({
        tone: 'warning',
        message: `This database contains demo content from the demo seed (${listNames(demo)}, plus demo releases, docs, services, team entries and images). Delete it before launch.`,
        href: '/staff/products',
        linkLabel: 'Manage products',
      });
    }
  }

  const canSeeReleases = can(actor, 'releases.manage') || can(actor, 'products.manage');
  return {
    counts,
    checklist,
    recentReleases: canSeeReleases ? listRecentPublishedReleases(db, 5) : null,
    recentActivity: can(actor, 'audit.view') ? recentAuditEvents(db, actor, 8) : null,
  };
}
