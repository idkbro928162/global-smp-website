/** Minimal HTTP client for integration tests (cookies, CSRF tokens, forms). */
import { inject } from 'vitest';

export const base = inject('baseUrl');
export const password = inject('password');

export interface Options {
  /** Client IP presented via X-Forwarded-For (the test server trusts its proxy header). */
  ip?: string;
  origin?: string | null;
  cookie?: string;
}

function headers(options: Options, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  if (options.ip) h['x-forwarded-for'] = options.ip;
  if (options.cookie) h.cookie = options.cookie;
  if (options.origin !== null) h.origin = options.origin ?? base;
  return h;
}

export function get(path: string, options: Options = {}) {
  return fetch(base + path, { redirect: 'manual', headers: headers({ ...options, origin: null }) });
}

export function post(
  path: string,
  fields: Record<string, string | string[]>,
  options: Options = {},
) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) body.append(key, v);
  }
  return fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: headers(options, { 'content-type': 'application/x-www-form-urlencoded' }),
    body,
  });
}

export function postMultipart(path: string, form: FormData, options: Options = {}) {
  return fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: headers(options),
    body: form,
  });
}

export function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const match = /(bp_session|__Host-bp_session)=([^;]+)/.exec(header);
  if (!match) throw new Error(`No session cookie in: ${header}`);
  return `${match[1]}=${match[2]}`;
}

export class Staff {
  readonly cookie: string;
  readonly ip: string;

  constructor(cookie: string, ip: string) {
    this.cookie = cookie;
    this.ip = ip;
  }

  get(path: string) {
    return get(path, { cookie: this.cookie, ip: this.ip });
  }

  async csrf(path = '/staff/account'): Promise<string> {
    const html = await (await this.get(path)).text();
    const match = /name="_csrf" value="([^"]+)"/.exec(html);
    if (!match) throw new Error(`No CSRF token on ${path}`);
    return match[1]!;
  }

  async post(
    path: string,
    fields: Record<string, string | string[]>,
    options: { csrf?: boolean } = {},
  ) {
    const withToken = options.csrf === false ? fields : { _csrf: await this.csrf(), ...fields };
    return post(path, withToken, { cookie: this.cookie, ip: this.ip });
  }
}

export async function signIn(email: string, ip: string): Promise<Staff> {
  const response = await post('/staff/login', { email, password }, { ip });
  if (response.status !== 303) throw new Error(`Sign-in failed for ${email}: ${response.status}`);
  return new Staff(cookieFrom(response), ip);
}
