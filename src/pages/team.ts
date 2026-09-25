import type { APIRoute } from 'astro';

/** Convenience URL: the team list lives on the About page. */
export const GET: APIRoute = ({ redirect }) => redirect('/about#team', 301);
