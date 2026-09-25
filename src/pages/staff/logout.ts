import type { APIRoute } from 'astro';
import { sessionCookieDeleteOptions, sessionCookieName } from '../../server/auth/sessions.ts';
import { getDb } from '../../server/db/client.ts';
import { logout } from '../../server/services/auth.ts';
import { mutationContext } from '../../server/staff/page.ts';

/**
 * Sign out. POST only (the middleware has already verified the session and
 * its CSRF token), so a cross-site link or image cannot sign staff out.
 */
export const POST: APIRoute = (context) => {
  const session = context.locals.session;
  if (session) logout(getDb(), mutationContext(context), session.id);
  context.cookies.delete(sessionCookieName(), sessionCookieDeleteOptions());
  return context.redirect('/staff/login?notice=signed-out', 303);
};
