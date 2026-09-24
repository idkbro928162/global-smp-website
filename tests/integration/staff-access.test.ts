/**
 * Trust-boundary tests against the running server: every protected route and
 * operation must be enforced server-side, whatever the client sends.
 */
import { describe, expect, it } from 'vitest';
import { Staff, cookieFrom, get, password, post, signIn } from './client.ts';

const IP = '198.51.100.10';

const STAFF_PAGES = [
  '/staff',
  '/staff/account',
  '/staff/products',
  '/staff/products/new',
  '/staff/releases',
  '/staff/releases/new',
  '/staff/docs',
  '/staff/docs/new',
  '/staff/services',
  '/staff/team',
  '/staff/content',
  '/staff/media',
  '/staff/settings',
  '/staff/users',
  '/staff/users/new',
  '/staff/roles',
  '/staff/roles/new',
  '/staff/audit',
];

describe('unauthenticated access', () => {
  it.each(STAFF_PAGES)('redirects GET %s to sign-in', async (path) => {
    const response = await get(path, { ip: IP });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`/staff/login?next=${encodeURIComponent(path)}`);
  });

  it.each([
    '/staff/products/new',
    '/staff/settings',
    '/staff/users/new',
    '/staff/roles/new',
    '/staff/logout',
  ])('refuses POST %s without a session', async (path) => {
    const response = await post(path, { name: 'x' }, { ip: IP });
    expect(response.status).toBe(401);
  });

  it('rejects unauthenticated POSTs before reading their bodies', async () => {
    // Regression: bodies (up to 11 MB on /staff/media) used to be buffered
    // before the session check, and oversized ones answered 413, not 401.
    const big = 'x'.repeat(2 * 1024 * 1024);
    for (const path of ['/staff/products/new', '/staff/media']) {
      const response = await post(path, { name: big }, { ip: IP });
      expect(response.status, path).toBe(401);
    }
  });

  it('still enforces the body size limit for signed-in staff', async () => {
    const owner = await signIn('owner@example.test', IP);
    const response = await owner.post('/staff/settings', {
      'links.github': 'x'.repeat(2 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
  });

  it('ignores forged session cookies and client-side "admin" flags', async () => {
    const forged = await get('/staff', {
      ip: IP,
      cookie: `bp_session=${'A'.repeat(43)}; isAdmin=true; role=owner`,
    });
    expect(forged.status).toBe(302);
    const response = await post(
      '/staff/settings?isAdmin=true',
      { isAdmin: 'true', role: 'owner' },
      {
        ip: IP,
        cookie: 'isAdmin=true',
      },
    );
    expect(response.status).toBe(401);
  });

  it('marks staff responses as private and non-indexable', async () => {
    const response = await get('/staff/login', { ip: IP });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
  });
});

describe('sign-in', () => {
  it('sets an HttpOnly, SameSite=Lax session cookie and honours only safe "next" targets', async () => {
    const ok = await post(
      '/staff/login',
      { email: 'editor@example.test', password, next: '/staff/docs' },
      { ip: IP },
    );
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/staff/docs');
    const cookie = ok.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    for (const next of [
      '//evil.example',
      'https://evil.example/',
      '/\\evil.example',
      '/products',
    ]) {
      const response = await post(
        '/staff/login',
        { email: 'editor@example.test', password, next },
        { ip: IP },
      );
      expect(response.headers.get('location'), next).toBe('/staff');
    }
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const wrong = await post(
      '/staff/login',
      { email: 'editor@example.test', password: 'wrong wrong wrong' },
      { ip: '198.51.100.11' },
    );
    const unknown = await post(
      '/staff/login',
      { email: 'nobody@example.test', password: 'wrong wrong wrong' },
      { ip: '198.51.100.11' },
    );
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toContain('The email or password is incorrect.');
    expect(await unknown.text()).toContain('The email or password is incorrect.');
  });

  it('does not let a disabled account sign in', async () => {
    const response = await post(
      '/staff/login',
      { email: 'disabled@example.test', password },
      { ip: '198.51.100.12' },
    );
    expect(response.status).toBe(401);
  });

  it('rejects a login form posted from another site', async () => {
    const response = await post(
      '/staff/login',
      { email: 'editor@example.test', password },
      { ip: IP, origin: 'https://evil.example' },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

describe('CSRF protection', () => {
  it('requires the session CSRF token on every staff POST', async () => {
    const owner = await signIn('owner@example.test', IP);
    const missing = await owner.post(
      '/staff/settings',
      { 'links.discord': 'https://discord.gg/csrf' },
      { csrf: false },
    );
    expect(missing.status).toBe(403);
    const wrong = await owner.post(
      '/staff/settings',
      { _csrf: 'x'.repeat(43), 'links.discord': 'https://discord.gg/csrf' },
      { csrf: false },
    );
    expect(wrong.status).toBe(403);
    expect(await (await get('/support')).text()).not.toContain('discord.gg/csrf');
  });

  it('rejects cross-origin POSTs even with a valid token', async () => {
    const owner = await signIn('owner@example.test', IP);
    const token = await owner.csrf();
    const response = await post(
      '/staff/settings',
      { _csrf: token, 'links.discord': 'https://discord.gg/csrf' },
      {
        ip: IP,
        cookie: owner.cookie,
        origin: 'https://evil.example',
      },
    );
    expect(response.status).toBe(403);
  });

  it('does not accept a token from a different session', async () => {
    const a = await signIn('owner@example.test', IP);
    const b = await signIn('owner@example.test', IP);
    const response = await post(
      '/staff/settings',
      { _csrf: await a.csrf(), 'links.discord': 'https://discord.gg/csrf' },
      {
        ip: IP,
        cookie: b.cookie,
      },
    );
    expect(response.status).toBe(403);
  });
});

describe('permission matrix', () => {
  const expectForbidden = async (staff: Staff, path: string) => {
    const response = await staff.get(path);
    expect(response.status, path).toBe(403);
  };

  it('limits a documentation writer to docs and media', async () => {
    const writer = await signIn('writer@example.test', IP);
    for (const path of [
      '/staff',
      '/staff/docs',
      '/staff/docs/new',
      '/staff/media',
      '/staff/account',
    ]) {
      expect((await writer.get(path)).status, path).toBe(200);
    }
    for (const path of [
      '/staff/products',
      '/staff/products/new',
      '/staff/releases',
      '/staff/settings',
      '/staff/users',
      '/staff/roles',
      '/staff/audit',
      '/staff/content',
    ]) {
      await expectForbidden(writer, path);
    }
    const dashboard = await (await writer.get('/staff')).text();
    expect(dashboard).not.toContain('href="/staff/settings"');
  });

  it('blocks direct POSTs to operations the role cannot perform', async () => {
    const writer = await signIn('writer@example.test', IP);
    const create = await writer.post('/staff/products/new', {
      name: 'Forbidden',
      slug: 'forbidden',
      visibility: 'published',
    });
    expect(create.status).toBe(403);
    const settings = await writer.post('/staff/settings', {
      'links.discord': 'https://discord.gg/nope',
    });
    expect(settings.status).toBe(403);
    expect((await get('/products/forbidden')).status).toBe(404);
  });

  it('shows the no-access page to accounts without panel access', async () => {
    const response = await post(
      '/staff/login',
      { email: 'nopanel@example.test', password },
      { ip: IP },
    );
    const staff = new Staff(cookieFrom(response), IP);
    const dashboard = await staff.get('/staff');
    expect(dashboard.status).toBe(403);
    expect(await dashboard.text()).toContain('does not currently have access');
    expect((await staff.get('/staff/docs')).status).toBe(403);
  });

  it('prevents privilege escalation through roles and staff accounts', async () => {
    const editor = await signIn('editor@example.test', IP);
    expect(
      (
        await editor.post('/staff/roles/new', {
          name: 'Escalate',
          permissions: ['panel.access', 'roles.manage'],
        })
      ).status,
    ).toBe(403);

    const manager = await signIn('staffmanager@example.test', IP);
    const users = await (await manager.get('/staff/users')).text();
    const ownerId = /href="\/staff\/users\/(\d+)">Owner</.exec(users)?.[1];
    const editorId = /href="\/staff\/users\/(\d+)">editor</.exec(users)?.[1];
    expect(ownerId && editorId).toBeTruthy();
    // Cannot touch the owner or an account with permissions the manager lacks.
    expect((await manager.post(`/staff/users/${ownerId}`, { intent: 'disable' })).status).toBe(403);
    expect((await manager.post(`/staff/users/${editorId}`, { intent: 'link' })).status).toBe(403);
    // Cannot invite someone into a more powerful role.
    const roles = await (await manager.get('/staff/users/new')).text();
    expect(roles).not.toContain('>Owner<');
    expect(roles).not.toContain('>Administrator<');
    const invite = await manager.post('/staff/users/new', {
      email: 'x@example.test',
      displayName: 'X',
      roleId: '1',
    });
    expect(await invite.text()).toContain('Only owners can grant the Owner role.');

    const admin = await signIn('admin@example.test', IP);
    expect(
      (await admin.post(`/staff/users/${ownerId}`, { intent: 'role', roleId: '3' })).status,
    ).toBe(403);
  });
});
