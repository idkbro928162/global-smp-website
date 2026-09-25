import type { APIRoute } from 'astro';
import { getConfig } from '../server/config.ts';
import { getDb } from '../server/db/client.ts';
import { listDocCollections } from '../server/services/docs.ts';
import { listPublishedProducts } from '../server/services/products.ts';

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Sitemap of published public pages only (drafts and /staff are never listed). */
export const GET: APIRoute = () => {
  const { siteUrl } = getConfig();
  const db = getDb();
  const paths = ['/', '/products', '/docs', '/services', '/support', '/about', '/changelog'];
  for (const product of listPublishedProducts(db)) {
    paths.push(`/products/${product.slug}`);
    if (product.latestRelease) paths.push(`/products/${product.slug}/changelog`);
  }
  for (const collection of listDocCollections(db)) {
    if (collection.pages.length === 0) continue;
    paths.push(`/docs/${collection.key}`);
    for (const page of collection.pages) paths.push(`/docs/${collection.key}/${page.slug}`);
  }
  const urls = paths
    .map((path) => `  <url><loc>${escapeXml(new URL(path, siteUrl).toString())}</loc></url>`)
    .join('\n');
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
