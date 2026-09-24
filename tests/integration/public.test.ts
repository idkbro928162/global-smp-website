import { describe, expect, it } from 'vitest';
import { base, get, post } from './client.ts';

describe('public site', () => {
  it.each(['/', '/products', '/docs', '/services', '/support', '/about', '/changelog'])(
    'renders %s with the site chrome',
    async (path) => {
      const response = await get(path);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toMatch(/<a class="skip-link" href="#main-content"[^>]*>Skip to content<\/a>/);
      expect(html).toContain('id="main-content"');
      expect(html).toMatch(/<h1[\s>]/);
      expect(html).not.toMatch(/global\s*smp/i);
    },
  );

  it('shows honest empty states and never invents contact links', async () => {
    const support = await (await get('/support')).text();
    expect(support).toContain('The Discord invite link has not been published yet');
    // Other test files publish products, so check pages no test populates.
    const services = await (await get('/services')).text();
    expect(services).toContain('No services are listed right now');
    const home = await (await get('/')).text();
    expect(home).toContain('Store link coming soon.');
    expect(home).not.toMatch(/discord\.gg/);
  });

  it('returns real 404s for unknown content', async () => {
    for (const path of [
      '/products/nope',
      '/products/nope/changelog',
      '/docs/nope',
      '/docs/general/nope',
      '/nope',
    ]) {
      const response = await get(path);
      expect(response.status, path).toBe(404);
    }
  });

  it('sends security headers with a strict CSP', async () => {
    const response = await get('/');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('rejects state-changing methods on public pages', async () => {
    expect((await post('/', { a: 'b' })).status).toBe(405);
    expect((await post('/products', { a: 'b' })).status).toBe(405);
  });

  it('publishes robots.txt and a sitemap using the configured origin', async () => {
    const robots = await (await get('/robots.txt')).text();
    expect(robots).toContain('Disallow: /staff');
    const sitemap = await (await get('/sitemap.xml')).text();
    expect(sitemap).toContain(`<loc>${base}/products</loc>`);
    expect(sitemap).not.toContain('/staff');
  });

  it('only serves media files that exist in the library', async () => {
    for (const path of [
      '/media/..%2Fbased-productions.db',
      '/media/aaaaaaaaaaaaaaaaaaaaaa-lg.webp',
      '/media/x.png',
    ]) {
      expect((await get(path)).status, path).toBe(404);
    }
  });
});
