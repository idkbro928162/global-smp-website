/**
 * Request pipeline. Runs before every page and endpoint.
 *
 * Public site: GET/HEAD only. Any other method is rejected with 405.
 *
 * Staff area (/staff/**):
 *   1. State-changing requests must come from the site's own origin.
 *   2. Form bodies are read here with a byte cap (pages read `locals.form`).
 *   3. The session cookie is resolved to an Actor (role + permissions are
 *      re-read from the database on every request).
 *   4. Every route except sign-in and account setup requires a session with
 *      `panel.access`; every POST from a signed-in user must carry the
 *      session's CSRF token.
 *   5. Pages then check their specific permission, and the services they call
 *      check it again (defence in depth).
 */
import { defineMiddleware } from 'astro:middleware';
import { ForbiddenError, NotFoundError, can } from './server/auth/authorization.ts';
import {
  resolveSession,
  sessionCookieDeleteOptions,
  sessionCookieName,
} from './server/auth/sessions.ts';
import { getConfig } from './server/config.ts';
import { getDb } from './server/db/client.ts';
import { applySecurityHeaders } from './server/security/headers.ts';
import {
  DEFAULT_FORM_LIMIT_BYTES,
  RequestRejectedError,
  UPLOAD_FORM_LIMIT_BYTES,
  hasAllowedOrigin,
  isSafeMethod,
  readFormData,
  resolveClientIp,
  verifyCsrfToken,
} from './server/security/request-guard.ts';

const STAFF_ROOT = '/staff';
/** Staff routes reachable without a session. */
const SESSIONLESS_STAFF_ROUTES = [/^\/staff\/login\/?$/, /^\/staff\/setup\/[^/]+\/?$/];
/** Staff routes that need a session but not `panel.access`. */
const SESSION_ONLY_STAFF_ROUTES = [/^\/staff\/forbidden\/?$/, /^\/staff\/logout\/?$/];
const UPLOAD_ROUTES = [/^\/staff\/media\/?$/];
/**
 * Framework endpoints this site does not use. `/_image` would otherwise let
 * anyone trigger on-demand image transforms (CPU) on bundled images.
 */
const DISABLED_FRAMEWORK_ROUTES = [/^\/_image\/?$/, /^\/_server-islands\//, /^\/_actions\//];

function isStaffPath(pathname: string): boolean {
  return pathname === STAFF_ROOT || pathname.startsWith(`${STAFF_ROOT}/`);
}

function errorPage(
  status: number,
  title: string,
  message: string,
  link?: [string, string],
): Response {
  const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} · Based Productions</title></head><body><main><h1>${escape(title)}</h1><p>${escape(message)}</p>${
    link ? `<p><a href="${escape(link[0])}">${escape(link[1])}</a></p>` : ''
  }</main></body></html>`;
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function forbiddenPage(): Response {
  return errorPage(403, 'Not allowed', 'Your role does not allow this action.', [
    '/staff',
    'Back to the dashboard',
  ]);
}

export const onRequest = defineMiddleware(async (context, next) => {
  const config = getConfig();
  const { request, url, locals } = context;
  const pathname = url.pathname;
  const staff = isStaffPath(pathname);
  const development = import.meta.env.DEV;

  let socketAddress: string | undefined;
  try {
    socketAddress = context.clientAddress;
  } catch {
    socketAddress = undefined;
  }
  locals.clientIp = resolveClientIp(request, socketAddress, config.trustProxy);
  locals.actor = null;
  locals.session = null;
  locals.form = null;

  const finish = (response: Response): Response => {
    applySecurityHeaders(response.headers, { secure: config.secure, development, staff });
    return response;
  };

  if (DISABLED_FRAMEWORK_ROUTES.some((r) => r.test(pathname))) {
    return finish(new Response('Not found', { status: 404 }));
  }

  try {
    const safe = isSafeMethod(request.method);
    if (!safe) {
      if (!staff || request.method !== 'POST') {
        return finish(
          new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } }),
        );
      }
      // In development the request origin is also accepted (localhost vs 127.0.0.1).
      const allowed = development ? [config.siteOrigin, url.origin] : [config.siteOrigin];
      if (!hasAllowedOrigin(request, allowed)) {
        return finish(
          errorPage(403, 'Request blocked', 'This form was submitted from another site.'),
        );
      }
    }

    if (!staff) return finish(await next());

    const db = getDb();
    const cookieName = sessionCookieName();
    const token = context.cookies.get(cookieName)?.value;
    const resolved = token ? resolveSession(db, token) : null;
    if (token && !resolved) context.cookies.delete(cookieName, sessionCookieDeleteOptions());
    if (resolved) {
      locals.actor = resolved.actor;
      locals.session = { id: resolved.sessionId, csrfToken: resolved.csrfToken };
    }

    const sessionless = SESSIONLESS_STAFF_ROUTES.some((r) => r.test(pathname));
    if (!sessionless && !resolved) {
      if (safe) {
        const nextPath = `${pathname}${url.search}`;
        return finish(context.redirect(`/staff/login?next=${encodeURIComponent(nextPath)}`));
      }
      return finish(
        errorPage(401, 'Signed out', 'Your session has ended. Sign in again to continue.', [
          '/staff/login',
          'Sign in',
        ]),
      );
    }

    // Bodies are read only after the session check, so unauthenticated clients
    // cannot make the server buffer large payloads, and only signed-in staff
    // get the larger upload allowance.
    if (!safe) {
      const upload = resolved !== null && UPLOAD_ROUTES.some((r) => r.test(pathname));
      locals.form = await readFormData(
        request,
        upload ? UPLOAD_FORM_LIMIT_BYTES : DEFAULT_FORM_LIMIT_BYTES,
      );
    }

    if (!sessionless && resolved) {
      if (!safe && !verifyCsrfToken(locals.form ?? new FormData(), resolved.csrfToken)) {
        return finish(
          errorPage(
            403,
            'Form expired',
            'This form could not be verified. Reload the page and try again.',
            ['/staff', 'Back to the dashboard'],
          ),
        );
      }
      const sessionOnly = SESSION_ONLY_STAFF_ROUTES.some((r) => r.test(pathname));
      if (!sessionOnly && !can(resolved.actor, 'panel.access')) {
        return finish(safe ? await context.rewrite('/staff/forbidden') : forbiddenPage());
      }
    }

    return finish(await next());
  } catch (error) {
    if (error instanceof RequestRejectedError) {
      return finish(errorPage(error.status, 'Request rejected', error.message));
    }
    // Rewrites re-run this middleware as the original method, so only GET/HEAD
    // requests are rewritten to the styled error pages; a POST (whose body has
    // already been consumed) gets a plain error response instead.
    const safe = isSafeMethod(request.method);
    if (error instanceof ForbiddenError && staff && locals.actor) {
      return finish(safe ? await context.rewrite('/staff/forbidden') : forbiddenPage());
    }
    if (error instanceof NotFoundError) {
      return finish(
        safe
          ? await context.rewrite('/404')
          : errorPage(404, 'Not found', 'That item no longer exists.'),
      );
    }
    throw error;
  }
});
