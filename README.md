# Based Productions — website and staff platform

The official website of **Based Productions**, a Minecraft development brand that creates and sells
Minecraft plugins and related server software. Planned domain: `basedproductions.xyz`.

The repository contains two things served by one Node process:

1. **The public website**: brand presence, the product catalogue and product pages, changelogs,
   documentation, a services page, a support page and an about/team page.
2. **A private staff platform** (`/staff`): an authenticated panel where authorised staff manage
   the website's content, with role-based permissions and an audit log.

> The GitHub repository is still called `global-smp-website` for historical reasons. It has nothing
> to do with GlobalSMP any more; renaming it (e.g. `based-productions-website`) is recommended.

---

## Contents

- [System boundaries](#system-boundaries)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Directory structure](#directory-structure)
- [Configuration](#configuration)
- [Managing content](#managing-content)
- [Staff platform](#staff-platform)
- [Security model](#security-model)
- [Testing](#testing)
- [Build and deployment](#build-and-deployment)
- [Brand assets](#brand-assets)
- [Placeholders that need real values](#placeholders-that-need-real-values)
- [Known limitations](#known-limitations)
- [Possible future work](#possible-future-work)

---

## System boundaries

| System           | Responsible for                                                                                                                | Not responsible for                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **This website** | Brand, product discovery and details, documentation, changelogs, team, links to support and purchase, staff content management | Payments, orders, licences, downloads, customer accounts, tickets |
| **BuiltByBit**   | Purchasing, marketplace transactions, product delivery                                                                         | —                                                                 |
| **Discord**      | Customer support (tickets), community                                                                                          | —                                                                 |

**BuiltByBit boundary.** The site links out to BuiltByBit: a site-wide store link (setting
`links.builtbybit`) and one listing link per product (`builtbybitUrl`), shown as a “Buy on
BuiltByBit” button. There is no checkout, payment code, order database, purchase verification or
BuiltByBit API client. Links are validated to point at `builtbybit.com`. A deeper integration
(e.g. showing live listing data or verifying purchases) would need BuiltByBit API access,
credentials and current API documentation — none of which are available — and should be added as a
separate server-side module behind its own configuration rather than mixed into the product
services.

**Discord boundary.** Support happens on Discord. The site shows the Discord invite (setting
`links.discord`, validated to `discord.gg`/`discord.com`) on the Support page and elsewhere. There
are no website tickets, customer accounts, live chat or Discord data synchronisation, and the staff
dashboard says so explicitly. A product can override the support link (e.g. a product-specific
channel).

---

## Quick start

Requirements: **Node.js 22.18+** (type stripping is used to run TypeScript scripts directly) and npm.

```bash
npm install
cp .env.example .env            # then set SITE_URL=http://localhost:4321 for local development
npm run demo:seed               # optional: clearly labelled demo content for local work
npm run staff:create-owner -- --email you@example.com --name "Your Name"
npm run dev                     # http://localhost:4321
```

`staff:create-owner` prints a one-time setup link. Open it, choose a password, then sign in at
`/staff/login`. There is **no default administrator account and no default password.**

`demo:seed` fills an empty local database with products, releases, docs and team entries named
“Demo …”, so layouts can be reviewed. It refuses to run in production (`NODE_ENV=production` or an
`https` `SITE_URL`) or when products already exist. Delete `data/` to start again.

Demo products and demo images are flagged in the database (`is_demo`). Demo images are not offered
in the artwork, screenshot or team-photo pickers for real content, the server rejects them if they
are submitted anyway, and a real product that already points at one (possible in databases seeded
before the flag existed; migration `0002` flags those automatically) is shown with the neutral
placeholder instead. The staff dashboard warns while demo content exists; delete it before launch.

Draft copy for the first real product is in [`docs/content/anti-esp.md`](docs/content/anti-esp.md);
the site does not read that file — paste it into the staff editor.

### Scripts

| Command                           | What it does                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `npm run dev`                     | Astro dev server (loads `.env`)                                               |
| `npm run build`                   | Production build into `dist/`                                                 |
| `npm start`                       | Run the production build (`dist/server/entry.mjs`, loads `.env`)              |
| `npm run check`                   | TypeScript/Astro type checking (`astro check`)                                |
| `npm run lint`                    | ESLint, including accessibility rules for Astro templates                     |
| `npm run format` / `format:check` | Prettier                                                                      |
| `npm test`                        | Unit tests, then a production build and the integration tests                 |
| `npm run test:unit`               | Unit tests only (fast, in-memory database)                                    |
| `npm run test:integration`        | Builds, starts the production server on a temporary database, tests over HTTP |
| `npm run test:e2e`                | Builds, then Playwright browser tests (navigation, responsive, axe)           |
| `npm run verify`                  | format check + lint + type check + unit and integration tests                 |
| `npm run db:migrate`              | Apply database migrations explicitly (also done on startup)                   |
| `npm run staff:create-owner`      | Bootstrap an owner account (prints a one-time setup link)                     |
| `npm run demo:seed`               | Development-only demo content                                                 |
| `npm run brand:process-logo`      | Regenerate logo derivatives from `brand/source/` (see Brand assets)           |

---

## Architecture

```
Browser ──HTTPS──> reverse proxy (TLS) ──HTTP──> Node: Astro server (dist/server/entry.mjs)
                                                   │  src/middleware.ts  (origin check, body limits,
                                                   │                      session, CSRF, headers)
                                                   ├─ public pages  ── read ──┐
                                                   ├─ /staff pages  ─ call ─> src/server/services/*  (validation +
                                                   │                           authorisation + audit)
                                                   └─ /media/*  (uploaded images)          │
                                                                                SQLite (DATA_DIR/based-productions.db)
                                                                                + DATA_DIR/uploads/
```

### Technology choices

- **[Astro 7](https://astro.build) with `output: 'server'` and the Node adapter.** Every page is
  rendered on the server: public pages read staff-managed content from the database, and the staff
  panel needs sessions. Astro ships **no JavaScript by default**; the public site uses three
  tiny progressive-enhancement scripts (mobile menu Escape handling, docs copy buttons, docs menu
  closing). Everything works without JavaScript. Compared with a React meta-framework this keeps
  the public site very light and the staff panel simple (plain HTML forms, POST-redirect-GET).
- **SQLite via `better-sqlite3` + [Drizzle ORM](https://orm.drizzle.team).** The content set is
  small, writes are rare and come from a handful of staff, so an embedded database gives the
  simplest possible deployment (one process, one data directory, trivial backups) with full SQL and
  type-safe queries. Migrations are hand-written SQL in `src/server/db/migrations.ts`;
  `tests/unit/schema-and-config.test.ts` fails if they drift from the Drizzle schema. (`drizzle-kit`
  was deliberately not used: it pulled in a deprecated, vulnerable `esbuild` chain.)
- **Zod** validates every input on the server.
- **markdown-it + highlight.js** render staff-written Markdown with raw HTML disabled and class-based
  highlighting (no inline styles, so the CSP stays strict).
- **sharp** re-encodes every uploaded image.
- **Self-hosted fonts** (`@fontsource-variable/archivo`, `jetbrains-mono`): no third-party requests.
- **TypeScript 6** (not 7: `@astrojs/check` and `typescript-eslint` do not support it yet).
- Server modules use only erasable TypeScript and explicit `.ts` imports, so the same code runs in
  Astro and in plain `node` CLI scripts without a build step (`erasableSyntaxOnly` enforces this).

### Request flow and trust boundary

`src/middleware.ts` runs before every route:

1. Public routes accept only `GET`/`HEAD` (others get 405).
2. For `/staff/**` `POST`s the `Origin` (or `Referer`) must equal `SITE_URL`.
3. The session cookie is resolved to an **Actor** whose role and permissions are re-read from the
   database on every request. Unauthenticated requests to protected routes are rejected **before
   the body is read**; bodies are then read with a byte cap (1 MiB, or 11 MiB for signed-in uploads;
   the adapter also caps bodies at 12 MiB).
4. Every staff route except sign-in and account setup requires a session with `panel.access`;
   every signed-in `POST` must carry the session's CSRF token.
   Unused framework endpoints (`/_image`, `/_server-islands/*`, `/_actions/*`) return 404.
5. Pages check their specific permission; the **services check it again**, so a page that forgot
   its check still cannot perform the operation.
6. Security headers are added to every response.

Pages read the already-parsed body from `Astro.locals.form`, never from the request directly.

---

## Directory structure

```
astro.config.mjs          Astro config (server output, body limit, CSP-friendly build options)
brand/source/             The official logo exactly as supplied (source of truth)
public/                   Static files: favicons, derived logo files under public/brand/
scripts/
  create-owner.ts         Bootstrap an owner account (prints a one-time setup link)
  migrate.ts              Apply migrations
  seed-demo.ts            Development-only demo content
  brand/process-logo.ts   Derive web logo files from brand/source/
src/
  middleware.ts           Request pipeline (see Architecture)
  env.d.ts                Types for Astro.locals
  lib/                    Pure modules usable anywhere
    catalog.ts            Platforms, accents, availability/channel vocabularies
    site-registry.ts      Editable copy blocks (with defaults) and settings (no defaults)
    markdown.ts           The sanitising Markdown renderer (only source of raw HTML)
    validation.ts         Shared zod schemas and URL/slug/version rules
    format.ts             Date/number formatting
  server/                 Server-only code
    config.ts             Environment configuration
    db/                   schema.ts (Drizzle), migrations.ts (SQL), client.ts
    auth/                 permissions, authorization (Actor, can/assertCan), passwords, sessions, tokens
    security/             request guard (origin/CSRF/body limits/client IP), headers, redirects, rate limits
    services/             Domain logic: products, releases, docs, team, offerings (services page),
                          site (copy + settings), media, auth, staff accounts, roles, audit, dashboard
    staff/                Helpers for staff pages (permission guards, form parsing)
  components/             UI components (site chrome, products, docs, staff forms)
  layouts/                BaseLayout, SiteLayout (public), StaffLayout
  pages/                  Routes: public pages, /staff/**, /media/[file], sitemap.xml, robots.txt
  styles/                 Design tokens and global styles, product accents, prose, staff styles
tests/
  unit/                   Vitest, in-memory database
  integration/            Vitest against the production build over HTTP
  e2e/                    Playwright (Chromium) + axe-core
  helpers/                Test fixtures
```

---

## Configuration

Environment variables (see `.env.example`). The application has **no secrets**: sessions are random
database-backed tokens, so there is no signing key to manage.

| Variable      | Default                                                                              | Purpose                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SITE_URL`    | `http://localhost:4321` in dev, `https://basedproductions.xyz` in a production build | Canonical origin. Used for canonical URLs, sitemap, setup links and the CSRF origin check. **Set it explicitly in every deployment.** An `https` value enables `Secure`/`__Host-` cookies and HSTS.           |
| `DATA_DIR`    | `./data`                                                                             | Directory for the SQLite database and uploads. Must be persistent and writable.                                                                                                                               |
| `TRUST_PROXY` | `false`                                                                              | `true` only behind a reverse proxy that sets `X-Forwarded-For`; the right-most entry is then used as the client IP for rate limiting and audit. Enabling it without such a proxy lets clients spoof their IP. |
| `HOST`/`PORT` | `localhost`/`4321` when unset                                                        | Listen address of the Node server. Keep it on a private interface behind the reverse proxy.                                                                                                                   |

Business values that change over time live in the **database**, edited in the staff panel:

- **Site settings** (`/staff/settings`, `settings.manage`): Discord invite, BuiltByBit store,
  GitHub, YouTube, X, business email. Unset values stay empty — the site shows “not yet available”
  notes rather than a fake link. URLs are validated per service (e.g. Discord links must be
  `https://discord.gg/…` or `https://discord.com/…`).
- **Site copy** (`/staff/content`, `content.manage`): homepage headline and intro, About text,
  Services intro, Support intro and checklist, footer disclaimer. Defaults live in
  `src/lib/site-registry.ts` and are factual statements from the brief; an edited block can be reset
  to its default.

---

## Managing content

All content is created in the staff panel and stays **hidden until set to Published**.

- **Products** (`products.manage`): name, slug, short and full description (Markdown), availability
  (in development / available / discontinued), featured flag, sort order, accent colour (a curated
  palette — see `src/lib/catalog.ts` and `src/styles/accents.css`), artwork and screenshots from the
  media library, features, supported Minecraft versions (e.g. `1.20.4`, `1.21.x`, `1.21+`, `26.1`),
  platforms, Java version, BuiltByBit listing URL, optional external docs and support URLs, first
  release date. The “latest version” shown is derived from published releases (newest stable,
  otherwise newest pre-release) — it is never typed in twice.
- **Releases** (`releases.manage`): version, channel, date, title, Markdown notes. Public only when
  both the release and its product are published.
- **Documentation** (`docs.manage`): Markdown pages in a product collection (`/docs/<product>/<page>`)
  or the general collection (`/docs/general/<page>`), grouped by sidebar section and ordered by a sort
  number. Headings get anchors and a table of contents; code blocks get highlighting and a copy
  button; tables scroll on small screens. Markdown preview is available without saving.
- **Services** (`content.manage`): offerings listed on `/services`. The page shows an honest empty
  state until something is published. No prices or guarantees are modelled.
- **Team page** (`team.manage`): public profiles for the About page (separate from staff accounts).
- **Media** (`media.manage`): image uploads (PNG, JPEG, WebP, GIF, AVIF, max 10 MB). Each upload is
  re-encoded to two WebP sizes with metadata stripped. Images in use cannot be deleted. Embed images
  in Markdown with the snippet shown on the image's page. **Uploaded images are public.**

Missing optional data is handled everywhere: products without artwork get an accent-coloured
placeholder, empty sections are omitted, and empty catalogues show explicit empty states.

---

## Staff platform

### Accounts and sign-in

- No self-registration and no default account. The first owner is created with
  `npm run staff:create-owner`; later accounts are invited from `/staff/users/new`.
- An invitation creates an inactive account and shows a **one-time setup link** (valid 72 hours,
  single use, stored only as a SHA-256 hash). Share it privately; no email is sent. The same
  mechanism issues password-reset links (valid 24 hours) — issuing a new link invalidates older ones.
- Passwords: at least 12 characters, a small common-password denylist, hashed with **scrypt**
  (N=2¹⁷, r=8, p=1; parameters stored per hash so they can be raised later).
- Sessions: random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`__Host-` prefixed and
  `Secure` over HTTPS); only its hash is stored. 12-hour idle timeout, 7-day absolute lifetime.
  Changing your password signs out your other sessions; disabling an account ends its sessions
  immediately.
- Sign-in is rate-limited per account (8 failures / 15 min) and per IP (20 failures / 15 min).
  Unknown accounts and wrong passwords get the same response and similar timing. At most two
  password hashes run at once (each needs ~128 MiB), so a flood of attempts queues instead of
  exhausting memory or the I/O thread pool.

### Roles and permissions

Permissions are defined in code (`src/server/auth/permissions.ts`); roles are named sets of them,
editable in `/staff/roles`.

| Permission        | Allows                                                             |
| ----------------- | ------------------------------------------------------------------ |
| `panel.access`    | Using the staff panel at all (required for every other permission) |
| `products.manage` | Products and their marketplace links                               |
| `releases.manage` | Releases and changelogs                                            |
| `docs.manage`     | Documentation pages                                                |
| `content.manage`  | Site copy and the services listing                                 |
| `team.manage`     | Public team profiles                                               |
| `media.manage`    | Uploading and deleting images                                      |
| `staff.manage`    | Inviting, disabling and resetting staff accounts                   |
| `roles.manage`    | Creating and editing roles                                         |
| `settings.manage` | Discord/BuiltByBit/social/contact links                            |
| `audit.view`      | Reading the audit log                                              |

Default roles (editable, except Owner): **Owner** (everything; cannot be edited or deleted),
**Administrator** (every permission, but cannot touch owners), **Editor** (products, releases, docs,
copy, team, media), **Documentation writer** (docs and media).

Escalation rules, enforced in the services:

- You can only grant permissions you hold, and only assign roles whose permissions you hold.
- You cannot edit your own role, a role with permissions you lack, or the Owner role.
- You cannot manage your own account through staff management, accounts with permissions you lack,
  or (unless you are an owner) owner accounts. Only owners grant the Owner role.
- The last active owner can never be demoted or disabled. Roles in use cannot be deleted.

### Audit log

Security-relevant and content actions (sign-ins, failed sign-ins on real accounts, invitations,
role and account changes, settings, content create/update/publish/delete, uploads) are recorded with
actor, target, changed field names and IP. Values, passwords and links are never recorded. There is
no way to edit or delete entries from the application.

### What the staff platform deliberately does not have

No shell or OS command execution, Minecraft console, RCON, arbitrary commands, file browsing,
database consoles, environment/secret viewers, customer accounts, support tickets or fake analytics.
If server administration is ever needed, it should be a separate system with narrowly scoped
operations.

---

## Security model

- **Authorisation** is server-side only; nothing the client sends (cookies other than the session,
  form fields, query parameters, headers) is used to decide permissions.
- **CSRF**: `SameSite=Lax` cookies + mandatory same-origin `Origin`/`Referer` on every POST +
  per-session CSRF token on every signed-in form. Astro's own `checkOrigin` is disabled because it
  compares against the request URL, which is wrong behind a TLS-terminating proxy; the replacement
  compares against `SITE_URL`.
- **XSS**: Astro escapes all expressions. Raw HTML is produced only by `src/lib/markdown.ts`
  (raw HTML disabled, link schemes allow-listed, images limited to `/media` uploads) and rendered
  only by `src/components/Markdown.astro`, which accepts the branded `SafeHtml` type. ESLint fails
  on any other `set:html`. The production **Content-Security-Policy** allows only same-origin
  scripts, styles, images and fonts — no `unsafe-inline` or `unsafe-eval`.
- **Headers**: CSP, `X-Frame-Options: DENY` + `frame-ancestors 'none'`, `nosniff`,
  `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, HSTS over HTTPS,
  `Cache-Control: no-store` and `X-Robots-Tag: noindex` on staff pages.
- **Open redirects**: the post-login `next` parameter only accepts same-origin `/staff` paths.
- **Stored links** are validated when saved and again when read, so a tampered database value
  (e.g. `javascript:`) is treated as unset instead of reaching an `href`.
- **Injection**: all queries are parameterised through Drizzle.
- **Uploads**: size-capped, decoded and re-encoded by sharp, served from a strict file-name pattern
  with `Content-Security-Policy: default-src 'none'; sandbox`.
- **Dependencies**: `npm audit` reports no known vulnerabilities at the time of writing; re-run it
  regularly.

This is a description of the design, not a guarantee. Treat the application like any other
internet-facing service: keep dependencies updated, restrict server access and review changes to
`src/middleware.ts`, `src/server/auth/` and `src/server/security/` carefully.

---

## Testing

- **Unit** (`tests/unit`, Vitest, in-memory SQLite): Markdown XSS handling, validation rules,
  redirects, origin/CSRF/body-limit checks, passwords, sessions (expiry, revocation, hashing),
  login rate limiting, one-time links, permission checks and escalation rules, product/doc/settings
  behaviour including malformed stored data, media upload validation and path safety, schema drift.
- **Integration** (`tests/integration`): builds the app, starts `dist/server/entry.mjs` on a
  temporary database with fixture accounts for each role, and tests over real HTTP — public routes
  and headers, redirects of every staff route when signed out, forged cookies, CSRF and
  cross-origin rejection, the permission matrix, privilege-escalation attempts via direct POSTs,
  content publishing, XSS rendering, uploads, logout, setup links, account disabling and rate limits.
- **End-to-end** (`tests/e2e`, Playwright on Chromium): no horizontal overflow at 320–1920 px on
  public pages and 360 px on staff pages, axe-core WCAG 2.2 AA scans of public and staff pages,
  keyboard skip link and focus styles, the mobile menu, docs navigation and copy buttons, a full
  write–preview–publish docs flow, validation error summaries and sign-out.

`@playwright/test` is pinned to the version whose Chromium build is available in the environment the
project was built in; after upgrading it, run `npx playwright install chromium`.

---

## Build and deployment

The app is a single long-running Node process with a persistent data directory. It is **not suited
to serverless platforms** (SQLite needs a persistent disk).

**Vercel:** Vercel Functions have a read-only deployment directory and only an ephemeral `/tmp`
that is not shared between instances, so the database, sessions, audit log and uploads would be
lost or diverge between instances. Deploying this app there unchanged is unsafe. Running on Vercel
would need a hosted database (for example libSQL/Turso or Postgres), object storage for uploads
(for example Vercel Blob) and the `@astrojs/vercel` adapter — an architecture change that has not
been made.

1. `npm ci && npm run build`
2. Set `SITE_URL=https://basedproductions.xyz`, `DATA_DIR=/var/lib/based-productions` (persistent,
   writable, not web-served), `HOST`, `PORT`, and `TRUST_PROXY=true` if behind a proxy.
3. `npm start` (or `node dist/server/entry.mjs` under systemd, a container, Fly.io/Railway with a
   volume, etc.). Migrations run automatically on startup; `npm run db:migrate` runs them explicitly.
4. Put a reverse proxy in front for TLS (Caddy, nginx, a platform load balancer) that forwards
   `Host` and appends `X-Forwarded-For`. Example (Caddy): `basedproductions.xyz { reverse_proxy 127.0.0.1:4321 }`.
5. Run `npm run staff:create-owner -- --email … --name …` on the server once.

Operational notes:

- **Backups**: back up `DATA_DIR` (database and `uploads/`). For a consistent database copy while
  running, use `sqlite3 based-productions.db ".backup backup.db"`.
- Only one app instance should use a given `DATA_DIR`.
- `npm install` needs build tools only if prebuilt binaries for `better-sqlite3`/`sharp` are
  unavailable for the platform.
- Public pages are rendered per request and are cookie-free, so a CDN can cache them briefly if
  traffic requires it; never cache `/staff`.

---

## Brand assets

- `brand/source/based-productions-logo-original.webp` — the official logo as supplied
  (1254×1254 raster, black wordmark on white). It is the source of truth.
- `npm run brand:process-logo` derives the web files in `public/` and `public/brand/` by converting
  luminance to transparency and recolouring the ink. **The letterforms are never redrawn or
  traced.** Outputs: off-white and ink wordmarks (transparent PNG/WebP), favicons, Apple touch icon
  and a default social preview image.

Assets that should be supplied to replace the derivatives:

1. A **vector (SVG) master** of the wordmark — the raster wordmark is only ~866 px wide, so very
   large renders are slightly soft.
2. A **small-size icon/monogram mark**. The logo has none; the current favicon is the whole
   wordmark scaled down, where “PRODUCTIONS” is not legible at 16–32 px. (Cropping a letter was
   rejected because the letters touch — it would mean redrawing the logo.)
3. Optionally, official brand colours/typography guidance; the site currently pairs the monochrome
   logo with Archivo (display/body) and JetBrains Mono (technical labels).

---

## Placeholders that need real values

Nothing is filled with plausible-looking fake data. Before launch, staff should set:

- [ ] Discord invite link (`/staff/settings`)
- [ ] BuiltByBit store link (`/staff/settings`)
- [ ] Optional: GitHub, YouTube, X, business email (`/staff/settings`)
- [ ] Products, their BuiltByBit listing links, artwork, releases and documentation
- [ ] Team profiles (About page)
- [ ] Services (if offered) and the Services intro text
- [ ] Review the default site copy (`/staff/content`)
- [ ] `SITE_URL` and `DATA_DIR` in the production environment

The staff dashboard shows a checklist of missing settings and incomplete published products.

---

## Known limitations

- No legal pages (terms, privacy policy). The site sets cookies only for signed-in staff and uses no
  analytics, but a privacy notice may still be required; its content must come from Based
  Productions.
- Staff sign-in has no second factor (TOTP/passkeys) yet.
- No email sending: setup and reset links are shared manually.
- Changing a product or doc slug breaks old links (no redirect table).
- Screenshot order follows the media library order; there is no drag-and-drop ordering.
- Media uploads are public by URL even when used only by draft content.
- No full-text docs search.
- Rate limits and sessions assume a single app instance per database.
- Browser tests run on Chromium only; Firefox and Safari were not tested.
- Concurrent edits of the same item are last-write-wins (no conflict detection).
- The media library and staff tables are not paginated (fine for the expected content volume).
- The Markdown `Preview` button is a normal submit button (the page reloads with the preview).

## Possible future work

- TOTP or passkey second factor for staff; optional sign-in with Discord OAuth for staff.
- Slug history with automatic redirects.
- Draft previews of unpublished pages for staff.
- BuiltByBit integration (listing data, purchase verification) if API access is obtained — as a
  separate, credential-gated server module.
- Docs search; RSS/Atom feed for releases.
