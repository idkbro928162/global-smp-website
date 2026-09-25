import type { APIRoute } from 'astro';
import { getConfig } from '../server/config.ts';

export const GET: APIRoute = () => {
  const { siteUrl } = getConfig();
  // Disallowing /staff only keeps it out of search results; access control is
  // enforced server-side regardless.
  const body = [
    'User-agent: *',
    'Disallow: /staff',
    '',
    `Sitemap: ${siteUrl}/sitemap.xml`,
    '',
  ].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
