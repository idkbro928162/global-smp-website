/**
 * Security headers added to every response rendered by Astro.
 *
 * The production CSP allows only same-origin resources: Astro emits bundled
 * scripts and styles as external files (inline stylesheets are disabled in
 * astro.config.mjs), the site loads no third-party scripts, fonts are
 * self-hosted and images come from /brand, /media or the build output. No
 * 'unsafe-inline' or 'unsafe-eval' is needed.
 *
 * The CSP is omitted in development because Vite's dev server injects inline
 * scripts and styles.
 */
export function contentSecurityPolicy(secure: boolean): string {
  const directives = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "worker-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (secure) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

export function applySecurityHeaders(
  headers: Headers,
  options: { secure: boolean; development: boolean; staff: boolean },
): void {
  // Routes may set a stricter policy of their own (e.g. /media): keep it.
  if (!options.development && !headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', contentSecurityPolicy(options.secure));
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  );
  if (options.secure) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (options.staff) {
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
}
