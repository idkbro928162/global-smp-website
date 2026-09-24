import { describe, expect, it } from 'vitest';
import { safeStaffRedirect } from '../../src/server/security/redirects.ts';
import {
  RequestRejectedError,
  hasAllowedOrigin,
  readFormData,
  resolveClientIp,
  verifyCsrfToken,
} from '../../src/server/security/request-guard.ts';
import { contentSecurityPolicy } from '../../src/server/security/headers.ts';

const SITE = 'https://basedproductions.xyz';

function request(headers: Record<string, string>, body?: BodyInit) {
  return new Request(`${SITE}/staff/x`, { method: 'POST', headers, body });
}

describe('safeStaffRedirect (open-redirect protection)', () => {
  it.each([
    ['/staff/products?x=1', '/staff/products?x=1'],
    ['/staff', '/staff'],
  ])('keeps %s', (input, expected) => {
    expect(safeStaffRedirect(input)).toBe(expected);
  });

  it.each([
    null,
    '',
    'https://evil.example/staff',
    '//evil.example/staff',
    '/\\evil.example',
    '/\\/evil.example',
    '/staff\n/x',
    '/staff/../admin',
    '/products',
    '/staff/login',
    '/staff/logout',
    `/staff/${'a'.repeat(600)}`,
  ])('falls back to the dashboard for %j', (input) => {
    expect(safeStaffRedirect(input)).toBe('/staff');
  });
});

describe('hasAllowedOrigin', () => {
  it('accepts an exact origin match', () => {
    expect(hasAllowedOrigin(request({ origin: SITE }), [SITE])).toBe(true);
  });

  it.each([
    'https://evil.example',
    'http://basedproductions.xyz',
    'https://basedproductions.xyz:8443',
    'https://sub.basedproductions.xyz',
    'null',
  ])('rejects Origin %s', (origin) => {
    expect(hasAllowedOrigin(request({ origin }), [SITE])).toBe(false);
  });

  it('falls back to Referer only when Origin is absent', () => {
    expect(hasAllowedOrigin(request({ referer: `${SITE}/staff/a` }), [SITE])).toBe(true);
    expect(hasAllowedOrigin(request({ referer: 'https://evil.example/' }), [SITE])).toBe(false);
    expect(hasAllowedOrigin(request({}), [SITE])).toBe(false);
  });
});

describe('readFormData', () => {
  const form = 'application/x-www-form-urlencoded';

  it('parses urlencoded bodies within the limit', async () => {
    const data = await readFormData(request({ 'content-type': form }, 'a=1&b=two'), 100);
    expect(data.get('b')).toBe('two');
  });

  it('rejects bodies over the limit even without a Content-Length header', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`a=${'x'.repeat(200)}`));
        controller.close();
      },
    });
    const req = new Request(`${SITE}/staff/x`, {
      method: 'POST',
      headers: { 'content-type': form },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    await expect(readFormData(req, 100)).rejects.toMatchObject({ status: 413 });
  });

  it('rejects a declared Content-Length over the limit before reading', async () => {
    const req = request({ 'content-type': form, 'content-length': '5000' }, 'a=1');
    await expect(readFormData(req, 100)).rejects.toBeInstanceOf(RequestRejectedError);
  });

  it('rejects non-form content types (e.g. JSON)', async () => {
    const req = request({ 'content-type': 'application/json' }, '{}');
    await expect(readFormData(req, 100)).rejects.toMatchObject({ status: 415 });
  });
});

describe('verifyCsrfToken', () => {
  it('requires the exact session token', () => {
    const data = new FormData();
    data.set('_csrf', 'abc');
    expect(verifyCsrfToken(data, 'abc')).toBe(true);
    expect(verifyCsrfToken(data, 'abd')).toBe(false);
    expect(verifyCsrfToken(new FormData(), 'abc')).toBe(false);
  });
});

describe('resolveClientIp', () => {
  const withXff = (xff: string) => new Request(SITE, { headers: { 'x-forwarded-for': xff } });

  it('ignores X-Forwarded-For unless a trusted proxy is configured', () => {
    expect(resolveClientIp(withXff('1.2.3.4'), '10.0.0.5', false)).toBe('10.0.0.5');
  });

  it('uses the right-most (proxy-appended) address when trusting the proxy', () => {
    expect(resolveClientIp(withXff('6.6.6.6, 203.0.113.9'), '10.0.0.5', true)).toBe('203.0.113.9');
  });

  it('falls back to the socket address when the header is malformed', () => {
    expect(resolveClientIp(withXff('not-an-ip'), '10.0.0.5', true)).toBe('10.0.0.5');
  });
});

describe('contentSecurityPolicy', () => {
  it('allows no inline script/style and blocks framing', () => {
    const csp = contentSecurityPolicy(true);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });
});
