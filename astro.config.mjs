// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// Every route renders on demand: public pages read staff-managed content from
// SQLite, and the staff panel needs sessions. See README "Architecture".
export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone',
    // Hard cap on any request body (the adapter default is 1 GiB). Individual
    // routes apply tighter limits in src/server/security/request-guard.ts.
    bodySizeLimit: 12 * 1024 * 1024,
  }),
  security: {
    // Astro's built-in check compares the Origin header with the request URL,
    // which breaks behind a TLS-terminating reverse proxy. It is replaced by
    // src/server/security/request-guard.ts, which compares Origin against the
    // configured SITE_URL for every state-changing request and is paired with
    // a per-session CSRF token on all staff forms.
    checkOrigin: false,
  },
  build: {
    // Keep CSS in external files so the Content-Security-Policy can use
    // `style-src 'self'` without 'unsafe-inline'.
    inlineStylesheets: 'never',
  },
  vite: {
    build: {
      // Never inline assets (e.g. fonts) as data: URIs — the CSP only allows 'self'.
      assetsInlineLimit: 0,
    },
  },
  devToolbar: { enabled: false },
  prefetch: false,
});
