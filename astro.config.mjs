// @ts-check
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel';

// Vercel sets VERCEL=1 during its builds. That build is a disposable preview
// only: Vercel Functions have no persistent disk, so the SQLite database and
// uploads live in /tmp and are lost or differ between instances. Everywhere
// else the app is the long-running Node server described in the README.
const vercelPreview = process.env.VERCEL === '1';

/** Every file of the build-time demo snapshot (the adapter copies files, not folders). */
function previewSeedFiles() {
  const dir = '.vercel-preview-seed';
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((file) => `./${path.posix.join(dir, file.split(path.sep).join('/'))}`)
    .filter((file) => statSync(file).isFile());
}

// Every route renders on demand: public pages read staff-managed content from
// SQLite, and the staff panel needs sessions. See README "Architecture".
export default defineConfig({
  output: 'server',
  adapter: vercelPreview
    ? vercel({
        // Demo content prepared during the build (see "vercel-build" in
        // package.json); copied into DATA_DIR when an instance starts empty.
        includeFiles: previewSeedFiles(),
      })
    : node({
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
