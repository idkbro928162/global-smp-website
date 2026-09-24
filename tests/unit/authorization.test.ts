/**
 * Server-side authorization invariants: permission checks in services and
 * the escalation rules for roles and staff accounts.
 */
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError, can } from '../../src/server/auth/authorization.ts';
import { ALL_PERMISSIONS, parsePermissionList } from '../../src/server/auth/permissions.ts';
import { createSession, resolveSession } from '../../src/server/auth/sessions.ts';
import type { Db } from '../../src/server/db/client.ts';
import { auditEvents, products, roles, users } from '../../src/server/db/schema.ts';
import { createProduct, listProductsForStaff } from '../../src/server/services/products.ts';
import { createRole, deleteRole, updateRole } from '../../src/server/services/roles.ts';
import { updateSettings } from '../../src/server/services/site.ts';
import {
  changeStaffRole,
  inviteStaff,
  issueStaffLink,
  revokeStaffSessions,
  setStaffDisabled,
} from '../../src/server/services/staff-accounts.ts';
import { listAuditEvents } from '../../src/server/services/audit.ts';
import { ctx, freshDb, makeActor } from '../helpers/db.ts';

const ownerRoleId = (db: Db) => db.select().from(roles).where(eq(roles.isOwner, true)).get()!.id;
const roleId = (db: Db, name: string) =>
  db.select().from(roles).where(eq(roles.name, name)).get()!.id;

const validProduct = {
  name: 'Test Plugin',
  slug: 'test-plugin',
  tagline: '',
  description: '',
  visibility: 'draft',
  availability: 'in_development',
  featured: false,
  sortOrder: 0,
  accent: 'neutral',
  artworkId: '',
  features: [],
  minecraftVersions: [],
  platforms: [],
  javaVersion: '',
  builtbybitUrl: '',
  externalDocsUrl: '',
  supportUrl: '',
  launchedOn: '',
  screenshotIds: [],
};

describe('permission primitives', () => {
  it('requires panel access for every permission', () => {
    const db = freshDb();
    const noPanel = makeActor(db, ['products.manage']);
    expect(can(noPanel, 'products.manage')).toBe(false);
    expect(can(null, 'panel.access')).toBe(false);
  });

  it('gives owners every permission', () => {
    const db = freshDb();
    const owner = makeActor(db, 'owner');
    expect(can(owner, 'roles.manage')).toBe(true);
    expect(can(owner, 'settings.manage')).toBe(true);
  });

  it('ignores unknown permission names stored in the database', () => {
    expect(parsePermissionList('["panel.access","isAdmin","*",42]')).toEqual(['panel.access']);
    expect(parsePermissionList('not json')).toEqual([]);
  });
});

describe('services enforce permissions themselves', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it('rejects content changes from staff without the matching permission', () => {
    const docsWriter = makeActor(db, ['panel.access', 'docs.manage']);
    expect(() => createProduct(db, ctx(docsWriter), validProduct)).toThrow(ForbiddenError);
    expect(() => listProductsForStaff(db, docsWriter)).toThrow(ForbiddenError);
    expect(() =>
      updateSettings(db, ctx(docsWriter), { 'links.discord': 'https://discord.gg/x' }),
    ).toThrow(ForbiddenError);
    expect(db.select().from(products).all()).toHaveLength(0);
  });

  it('records permitted changes in the audit log', () => {
    const editor = makeActor(db, ['panel.access', 'products.manage']);
    expect(createProduct(db, ctx(editor), validProduct).ok).toBe(true);
    const events = db.select().from(auditEvents).all();
    expect(events.map((e) => e.action)).toContain('product.create');
    expect(events[0]?.actorId).toBe(editor.id);
  });

  it('keeps the audit log readable only with audit.view', () => {
    const editor = makeActor(db, ['panel.access', 'products.manage']);
    expect(() => listAuditEvents(db, editor)).toThrow(ForbiddenError);
  });
});

describe('role escalation rules', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it('only lets you grant permissions you hold', () => {
    const roleManager = makeActor(db, ['panel.access', 'roles.manage']);
    const result = createRole(db, ctx(roleManager), {
      name: 'Sneaky',
      description: '',
      permissions: ['panel.access', 'staff.manage'],
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.errors.permissions).toMatch(/only grant permissions you hold/);
  });

  it('never allows editing or deleting the Owner role', () => {
    const owner = makeActor(db, 'owner');
    expect(() =>
      updateRole(db, ctx(owner), ownerRoleId(db), {
        name: 'Owner',
        description: '',
        permissions: [],
      }),
    ).toThrow(ForbiddenError);
    expect(() => deleteRole(db, ctx(owner), ownerRoleId(db))).toThrow(ForbiddenError);
  });

  it('does not let you edit your own role or a role more powerful than yours', () => {
    const roleManager = makeActor(db, ['panel.access', 'roles.manage']);
    expect(() =>
      updateRole(db, ctx(roleManager), roleManager.role.id, {
        name: 'Mine',
        description: '',
        permissions: ['panel.access', 'roles.manage'],
      }),
    ).toThrow(ForbiddenError);
    expect(() =>
      updateRole(db, ctx(roleManager), roleId(db, 'Administrator'), {
        name: 'Administrator',
        description: '',
        permissions: ['panel.access'],
      }),
    ).toThrow(ForbiddenError);
  });

  it('refuses to delete a role that still has members', () => {
    const admin = makeActor(db, [
      'panel.access',
      'roles.manage',
      'staff.manage',
      'products.manage',
    ]);
    const member = makeActor(db, ['panel.access']);
    const result = deleteRole(db, ctx(admin), member.role.id);
    expect(result.ok).toBe(false);
  });
});

describe('staff account escalation rules', () => {
  let db: Db;
  beforeEach(() => {
    db = freshDb();
  });

  it('only owners can grant the Owner role', () => {
    // A non-owner holding every permission (like the default Administrator role).
    const admin = makeActor(db, ALL_PERMISSIONS);
    const result = inviteStaff(db, ctx(admin), {
      email: 'new@example.test',
      displayName: 'New',
      roleId: ownerRoleId(db),
    });
    expect(result.ok).toBe(false);
    const owner = makeActor(db, 'owner');
    expect(
      inviteStaff(db, ctx(owner), {
        email: 'new@example.test',
        displayName: 'New',
        roleId: ownerRoleId(db),
      }).ok,
    ).toBe(true);
  });

  it('cannot assign a role with permissions you lack', () => {
    const staffManager = makeActor(db, ['panel.access', 'staff.manage']);
    const target = makeActor(db, ['panel.access']);
    const result = changeStaffRole(db, ctx(staffManager), target.id, roleId(db, 'Editor'));
    expect(result.ok).toBe(false);
  });

  it('cannot manage an account that holds permissions you lack, or an owner', () => {
    const staffManager = makeActor(db, ['panel.access', 'staff.manage']);
    const moreTrusted = makeActor(db, ['panel.access', 'settings.manage']);
    const owner = makeActor(db, 'owner');
    for (const target of [moreTrusted, owner]) {
      expect(() => setStaffDisabled(db, ctx(staffManager), target.id, true)).toThrow(
        ForbiddenError,
      );
      expect(() => issueStaffLink(db, ctx(staffManager), target.id)).toThrow(ForbiddenError);
      expect(() => revokeStaffSessions(db, ctx(staffManager), target.id)).toThrow(ForbiddenError);
      expect(() => changeStaffRole(db, ctx(staffManager), target.id, staffManager.role.id)).toThrow(
        ForbiddenError,
      );
    }
    expect(db.select().from(users).where(eq(users.id, owner.id)).get()?.status).toBe('active');
  });

  it('cannot manage your own account through staff management', () => {
    const owner = makeActor(db, 'owner');
    expect(() => setStaffDisabled(db, ctx(owner), owner.id, true)).toThrow(ForbiddenError);
    expect(() => changeStaffRole(db, ctx(owner), owner.id, roleId(db, 'Editor'))).toThrow(
      ForbiddenError,
    );
  });

  it('disabling an account ends its sessions immediately', () => {
    const owner = makeActor(db, 'owner');
    const target = makeActor(db, ['panel.access']);
    const { token } = createSession(db, target.id, {});
    expect(setStaffDisabled(db, ctx(owner), target.id, true).ok).toBe(true);
    expect(resolveSession(db, token)).toBeNull();
  });
});
