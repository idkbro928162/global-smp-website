import type { APIRoute } from 'astro';
import { getDb } from '../../server/db/client.ts';
import { readMediaFile } from '../../server/services/media.ts';

/**
 * Serves uploaded images. `readMediaFile` only accepts strictly formatted
 * names that belong to a media record, so no other file can be read.
 * Files are immutable (random ids), so they are cached aggressively.
 */
export const GET: APIRoute = async ({ params }) => {
  const data = await readMediaFile(getDb(), params.file ?? '');
  if (!data) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(data), {
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(data.length),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'cross-origin',
    },
  });
};
