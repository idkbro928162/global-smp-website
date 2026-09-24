/**
 * Server-side runtime configuration, read from environment variables.
 *
 * This module is imported by Astro (at request time) and by plain Node CLI
 * scripts, so it reads `process.env` directly instead of `import.meta.env`
 * (which Astro would inline at build time).
 */
import path from 'node:path';

export interface ServerConfig {
  /** Canonical public origin, e.g. "https://basedproductions.xyz" (no trailing slash). */
  siteUrl: string;
  siteOrigin: string;
  /** True when the site is served over HTTPS: enables Secure/__Host- cookies and HSTS. */
  secure: boolean;
  dataDir: string;
  databasePath: string;
  uploadsDir: string;
  trustProxy: boolean;
}

/** The planned production domain. Used only when SITE_URL is unset in a production build. */
export const PRODUCTION_SITE_URL = 'https://basedproductions.xyz';
const DEVELOPMENT_SITE_URL = 'http://localhost:4321';

function isProductionBuild(): boolean {
  // `import.meta.env` exists inside Astro/Vite; plain Node scripts fall back to NODE_ENV.
  const env = (import.meta as { env?: { PROD?: boolean } }).env;
  return env?.PROD === true || process.env.NODE_ENV === 'production';
}

export function parseSiteUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`SITE_URL is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('SITE_URL must use http or https');
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('SITE_URL must be an origin only, e.g. https://basedproductions.xyz');
  }
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const fallback = isProductionBuild() ? PRODUCTION_SITE_URL : DEVELOPMENT_SITE_URL;
  const site = parseSiteUrl(env.SITE_URL?.trim() || fallback);
  const dataDir = path.resolve(env.DATA_DIR?.trim() || './data');
  return {
    siteUrl: site.origin,
    siteOrigin: site.origin,
    secure: site.protocol === 'https:',
    dataDir,
    databasePath: path.join(dataDir, 'based-productions.db'),
    uploadsDir: path.join(dataDir, 'uploads'),
    trustProxy: env.TRUST_PROXY?.trim().toLowerCase() === 'true',
  };
}

let cached: ServerConfig | undefined;

export function getConfig(): ServerConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test hook: forget the cached configuration so the next call re-reads the environment. */
export function resetConfigForTests(): void {
  cached = undefined;
}
