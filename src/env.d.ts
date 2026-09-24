/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Resolved from a valid session cookie by src/middleware.ts; null for anonymous requests. */
    actor: import('./server/auth/authorization.ts').Actor | null;
    session: { id: string; csrfToken: string } | null;
    /**
     * Parsed body of a POST request to the staff area. The middleware reads it
     * (with a size cap) so it can verify the CSRF token before any page code
     * runs; pages must use this instead of `Astro.request.formData()`.
     */
    form: FormData | null;
    clientIp: string;
  }
}
