/**
 * Request-level protections applied by src/middleware.ts before any page code.
 *
 * CSRF defence is layered:
 *   1. Session cookies are SameSite=Lax (not sent on cross-site POSTs).
 *   2. Every state-changing request must carry an Origin (or Referer) that
 *      matches the configured SITE_URL.
 *   3. Every authenticated staff form must include the session's CSRF token.
 */
import { isIP } from 'node:net';
import { safeEqual } from '../auth/tokens.ts';

export const DEFAULT_FORM_LIMIT_BYTES = 1024 * 1024;
export const UPLOAD_FORM_LIMIT_BYTES = 11 * 1024 * 1024;

export class RequestRejectedError extends Error {
  readonly status: 400 | 403 | 405 | 413 | 415;
  constructor(status: 400 | 403 | 405 | 413 | 415, message: string) {
    super(message);
    this.name = 'RequestRejectedError';
    this.status = status;
  }
}

export function isSafeMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

/**
 * True when the request's Origin (falling back to Referer) is one of the
 * allowed origins. Requests with neither header are rejected: every browser
 * this site supports sends Origin on form POSTs.
 */
export function hasAllowedOrigin(request: Request, allowedOrigins: readonly string[]): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null) {
    return origin !== 'null' && allowedOrigins.includes(origin);
  }
  const referer = request.headers.get('referer');
  if (!referer) return false;
  try {
    return allowedOrigins.includes(new URL(referer).origin);
  } catch {
    return false;
  }
}

const FORM_CONTENT_TYPE = /^(application\/x-www-form-urlencoded|multipart\/form-data)\s*(;|$)/i;

/** Reads and parses a form body, aborting as soon as it exceeds `maxBytes`. */
export async function readFormData(request: Request, maxBytes: number): Promise<FormData> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!FORM_CONTENT_TYPE.test(contentType)) {
    throw new RequestRejectedError(415, 'Unsupported content type.');
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestRejectedError(413, 'Request body too large.');
  }
  if (!request.body) return new FormData();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RequestRejectedError(413, 'Request body too large.');
    }
    chunks.push(value);
  }
  try {
    return await new Response(Buffer.concat(chunks), {
      headers: { 'content-type': contentType },
    }).formData();
  } catch {
    throw new RequestRejectedError(400, 'Malformed form data.');
  }
}

export function verifyCsrfToken(form: FormData, expected: string): boolean {
  const submitted = form.get('_csrf');
  return typeof submitted === 'string' && safeEqual(submitted, expected);
}

/**
 * Client IP for rate limiting and audit records.
 *
 * Without TRUST_PROXY the socket address is used (Astro only honours
 * X-Forwarded-For when `security.allowedDomains` is configured, which this
 * project deliberately leaves unset). With TRUST_PROXY the right-most
 * X-Forwarded-For entry is used — the address appended by the single trusted
 * reverse proxy. Left-most entries are client-controlled and never trusted.
 */
export function resolveClientIp(
  request: Request,
  socketAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = request.headers.get('x-forwarded-for');
    const last = forwarded
      ?.split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1);
    if (last && isIP(last)) return last;
  }
  return socketAddress && isIP(socketAddress) ? socketAddress : 'unknown';
}
