/** End-to-end staff workflows over HTTP against the production build. */
import sharp from 'sharp';
import { inject } from 'vitest';
import { describe, expect, it } from 'vitest';
import { Staff, cookieFrom, get, password, post, postMultipart, signIn } from './client.ts';

const IP = '203.0.113.20';

function productFields(overrides: Record<string, string | string[]> = {}) {
  return {
    intent: 'save',
    name: 'Integration Plugin',
    slug: 'integration-plugin',
    tagline: 'Built by the integration tests.',
    description: '## Hello\n\n<script>alert("xss")</script>\n\n[bad](javascript:alert(1))',
    visibility: 'draft',
    availability: 'available',
    sortOrder: '0',
    accent: 'lapis',
    artworkId: '',
    minecraftVersions: '1.21.x, 26.1',
    platforms: ['paper', 'folia'],
    javaVersion: '21',
    builtbybitUrl: 'https://builtbybit.com/resources/integration.1/',
    externalDocsUrl: '',
    supportUrl: '',
    launchedOn: '',
    'features.0.title': 'Fast',
    'features.0.body': 'Very fast.',
    ...overrides,
  };
}

describe('content workflow', () => {
  it('creates a draft product that stays private until published', async () => {
    const editor = await signIn('editor@example.test', IP);
    const create = await editor.post('/staff/products/new', productFields());
    expect(create.status).toBe(303);
    const location = create.headers.get('location') ?? '';
    expect(location).toMatch(/^\/staff\/products\/\d+\?notice=created$/);
    const id = /\/staff\/products\/(\d+)/.exec(location)![1];

    expect((await get('/products/integration-plugin')).status).toBe(404);

    const publish = await editor.post(
      `/staff/products/${id}`,
      productFields({ visibility: 'published' }),
    );
    expect(publish.status).toBe(303);

    const page = await get('/products/integration-plugin');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Buy on BuiltByBit');
    expect(html).toContain('href="https://builtbybit.com/resources/integration.1/"');
    // Staff-authored markup is escaped, and unsafe links are not rendered.
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/href="javascript:/i);
    expect(await (await get('/sitemap.xml')).text()).toContain('/products/integration-plugin');
  });

  it('returns field errors for invalid input without saving', async () => {
    const editor = await signIn('editor@example.test', IP);
    const response = await editor.post(
      '/staff/products/new',
      productFields({
        slug: 'Bad Slug!',
        builtbybitUrl: 'https://evil.example/listing',
        minecraftVersions: 'latest',
      }),
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain('Use lowercase letters, numbers and single hyphens.');
    expect(html).toContain('The link must point to builtbybit.com.');
    expect(html).toContain('aria-invalid="true"');
    // What the user typed is preserved.
    expect(html).toContain('value="Bad Slug!"');
  });

  it('records changes in the audit log', async () => {
    const owner = await signIn('owner@example.test', IP);
    const audit = await (await owner.get('/staff/audit?action=product.')).text();
    expect(audit).toContain('product.create');
    expect(audit).toContain('editor@example.test');
    // The filter shows only matching actions (third column of each row).
    const actions = [
      ...audit.matchAll(
        /<tr[^>]*>\s*<td[^>]*>[^<]*<\/td>\s*<td[^>]*>[^<]*<\/td>\s*<td class="mono"[^>]*>([^<]+)<\/td>/g,
      ),
    ].map((m) => m[1]);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a?.startsWith('product.'))).toBe(true);
    // Filter input is sanitised rather than interpolated into SQL.
    expect((await owner.get('/staff/audit?action=%27%20OR%201%3D1--')).status).toBe(200);
  });
});

describe('media uploads', () => {
  it('accepts a real image and serves it re-encoded as WebP', async () => {
    const editor = await signIn('editor@example.test', IP);
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#224466' },
    })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set('_csrf', await editor.csrf('/staff/media'));
    form.set('alt', 'Blue square');
    form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'square.png');
    const response = await postMultipart('/staff/media', form, { cookie: editor.cookie, ip: IP });
    expect(response.status).toBe(303);
    const id = /\/staff\/media\/([A-Za-z0-9_-]{22})/.exec(
      response.headers.get('location') ?? '',
    )![1];
    const image = await get(`/media/${id}-sm.webp`);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/webp');
    expect(image.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('rejects non-images and oversized uploads', async () => {
    const editor = await signIn('editor@example.test', IP);
    const token = await editor.csrf('/staff/media');
    const fake = new FormData();
    fake.set('_csrf', token);
    fake.set(
      'file',
      new Blob(['<html><script>alert(1)</script></html>'], { type: 'image/png' }),
      'evil.png',
    );
    const fakeResponse = await postMultipart('/staff/media', fake, {
      cookie: editor.cookie,
      ip: IP,
    });
    expect(fakeResponse.status).toBe(422);

    const huge = new FormData();
    huge.set('_csrf', token);
    huge.set(
      'file',
      new Blob([new Uint8Array(12 * 1024 * 1024)], { type: 'image/png' }),
      'huge.png',
    );
    const hugeResponse = await postMultipart('/staff/media', huge, {
      cookie: editor.cookie,
      ip: IP,
    });
    expect([413, 400]).toContain(hugeResponse.status);
  });
});

describe('sessions and accounts', () => {
  it('signs out and invalidates the session server-side', async () => {
    const editor = await signIn('editor@example.test', IP);
    expect((await editor.get('/staff')).status).toBe(200);
    const logout = await editor.post('/staff/logout', {});
    expect(logout.status).toBe(303);
    // Re-using the old cookie no longer works.
    expect((await editor.get('/staff')).status).toBe(302);
  });

  it('lets an invited person set a password once via their setup link', async () => {
    const token = inject('setupToken');
    const form = await get(`/staff/setup/${token}`, { ip: IP });
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('pending@example.test');
    const weak = await post(
      `/staff/setup/${token}`,
      { password: 'short', confirm: 'short' },
      { ip: IP },
    );
    expect(await weak.text()).toContain('Use at least 12 characters.');
    const done = await post(`/staff/setup/${token}`, { password, confirm: password }, { ip: IP });
    expect(done.status).toBe(303);
    expect((await get(`/staff/setup/${token}`, { ip: IP })).status).toBe(404);
    await signIn('pending@example.test', IP);
  });

  it('ends existing sessions immediately when an account is disabled', async () => {
    const target = await signIn('pending@example.test', IP);
    const owner = await signIn('owner@example.test', IP);
    const users = await (await owner.get('/staff/users')).text();
    const id = /href="\/staff\/users\/(\d+)">Pending</.exec(users)![1];
    expect((await owner.post(`/staff/users/${id}`, { intent: 'disable' })).status).toBe(303);
    expect((await target.get('/staff')).status).toBe(302);
  });

  it('rate-limits repeated failed sign-ins for an account', async () => {
    const ip = '203.0.113.99';
    for (let i = 0; i < 8; i++) {
      const r = await post(
        '/staff/login',
        { email: 'ratelimited@example.test', password: `wrong password ${i}` },
        { ip },
      );
      expect(r.status).toBe(401);
    }
    const limited = await post(
      '/staff/login',
      { email: 'ratelimited@example.test', password },
      { ip: '203.0.113.100' },
    );
    expect(limited.status).toBe(429);
  });

  it('shows a one-time reset link only in the response that created it', async () => {
    const owner = await signIn('owner@example.test', IP);
    const users = await (await owner.get('/staff/users')).text();
    const id = /href="\/staff\/users\/(\d+)">admin</.exec(users)![1];
    const response = await owner.post(`/staff/users/${id}`, { intent: 'link' });
    const html = await response.text();
    const link = /\/staff\/setup\/([A-Za-z0-9_-]{43})/.exec(html)?.[1];
    expect(link).toBeTruthy();
    expect(await (await owner.get(`/staff/users/${id}`)).text()).not.toContain(link!);
    expect(await (await owner.get('/staff/audit')).text()).not.toContain(link!);
    // The reset link works for the admin account.
    expect((await get(`/staff/setup/${link}`, { ip: IP })).status).toBe(200);
    const staff = new Staff(
      cookieFrom(await post('/staff/login', { email: 'admin@example.test', password }, { ip: IP })),
      IP,
    );
    expect((await staff.get('/staff')).status).toBe(200);
  });
});
