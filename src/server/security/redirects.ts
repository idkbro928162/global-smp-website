/**
 * Validates post-login redirect targets (`?next=`) so the login page cannot be
 * used as an open redirect. Only same-origin paths inside the staff area are
 * accepted; everything else falls back to the dashboard.
 */
export const STAFF_HOME = '/staff';

export function safeStaffRedirect(next: string | null | undefined): string {
  if (!next || next.length > 512) return STAFF_HOME;
  // Reject protocol-relative ("//host"), backslash variants ("/\host") that
  // browsers normalise to "//host", and control characters.
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (!next.startsWith('/') || next.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(next)) {
    return STAFF_HOME;
  }
  let url: URL;
  try {
    url = new URL(next, 'http://placeholder.invalid');
  } catch {
    return STAFF_HOME;
  }
  if (url.origin !== 'http://placeholder.invalid') return STAFF_HOME;
  const isStaffPath = url.pathname === STAFF_HOME || url.pathname.startsWith(`${STAFF_HOME}/`);
  const isAuthPage =
    url.pathname.startsWith('/staff/login') || url.pathname.startsWith('/staff/logout');
  if (!isStaffPath || isAuthPage) return STAFF_HOME;
  return `${url.pathname}${url.search}`;
}
