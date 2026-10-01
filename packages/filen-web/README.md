# @filen/web

The Filen web app — a from-scratch rewrite of Filen's end-to-end encrypted Cloud Drive, Notes and Chats client for the browser. All cryptography, networking and transfers run through the Rust SDK (`@filen/sdk-rs`) inside a cross-origin-isolated worker; this package is the UI, routing and boot shell around it.

## Requirements

| Tool | Version |
| ---- | ------- |
| Node | >= 24   |
| pnpm | >= 12   |

## Commands

Install once at the repo root (`pnpm install`); these run from this directory.

| Command              | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `pnpm run dev`       | Start the Vite dev server                                |
| `pnpm run build`     | Type-check, build the app, then build the service worker |
| `pnpm run preview`   | Serve the production build locally                       |
| `pnpm run test`      | Run the unit tests (Vitest)                              |
| `pnpm run test:e2e`  | Run the end-to-end tests (Playwright)                    |
| `pnpm run lint`      | ESLint plus a Prettier format check                      |
| `pnpm run typecheck` | Type-check without emitting                              |
| `pnpm run format`    | Format the source with Prettier                          |

Unit tests are Vitest in `src/**/*.test.{ts,tsx}`, node by default (DOM tests opt in per file with `// @vitest-environment jsdom`). E2E is Playwright against a free-tier account (`FILEN_WEB_E2E_TEST_EMAIL` / `FILEN_WEB_E2E_TEST_PASSWORD` from `.env` or the environment), so premium-gated flows can only be checked for a graceful upgrade error; without credentials only the SDK-free specs run.

## Deployment

`pnpm run build` emits a static `dist/` plus a service worker. Any static host can serve it, but the response headers below are part of the contract — the app does not boot without them. The deployed host is Cloudflare (see [Cloudflare](#cloudflare)).

### Response headers

Send these on **every** response, `304 Not Modified` included: Safari judges a revalidated worker script by the 304's own headers, so a bare 304 blocks the SDK worker on reload.

| Header                         | Value                                      |
| ------------------------------ | ------------------------------------------ |
| `Cross-Origin-Opener-Policy`   | `same-origin`                              |
| `Cross-Origin-Embedder-Policy` | `require-corp`                             |
| `Cross-Origin-Resource-Policy` | `same-origin`                              |
| `X-Content-Type-Options`       | `nosniff`                                  |
| `Referrer-Policy`              | `no-referrer`                              |
| `Permissions-Policy`           | `camera=(), microphone=(), geolocation=()` |
| `Content-Security-Policy`      | the `CSP` const in `vite.config.ts`        |

The three cross-origin headers are what make `self.crossOriginIsolated` true; without it the SDK's threaded wasm worker cannot start and the app redirects to `/no-coi`. The CSP is deliberately referenced rather than copied: `vite.config.ts` is the edit-first source and carries the rationale for each directive, and a second literal copy would drift.

Note that nginx's `add_header` does not inherit into a nested `location`, so every block that serves a response has to repeat the whole set.

### MIME types and compression

`.wasm` must be served as `application/wasm` or the browser cannot stream-compile it. The SDK wasm is roughly 10 MiB, so pre-compressed Brotli (`brotli_static` or equivalent) is required, not optional.

### Caching

- `/assets/*` is content-hashed — `Cache-Control: public, max-age=31536000, immutable`.
- The SDK artifacts and `/sw.js` are **unhashed by contract** and must be revalidated on every load (`Cache-Control: no-cache`). Long-caching them pins users to a stale SDK or service worker.
- `index.html` is the SPA fallback for unknown page loads and must never be long-cached. A missing file that is not a page load must get a real 404: a tab opened before a deploy asks for chunks the new build no longer has, and an `index.html` fallback there would be cached as immutable under `/assets/*`.

### Cloudflare

The app is deployed as static assets on Cloudflare Workers (`wrangler.jsonc`): the top-level Worker is production, the `staging` environment is a separate Worker. The build writes everything above into `dist/_headers` (`deployHeaders()` in `vite.config.ts`), and `cloudflare/worker.ts` turns asset misses that are not page loads into 404s.

- **Staging** deploys on every push to `main` that touches the web app (`.github/workflows/staging-web.yml`), with `X-Robots-Tag: noindex`.
- **Production** deploys from a `filen-web@<version>` tag matching `package.json`'s version, after lint, typecheck and unit tests (`.github/workflows/release-web.yml`).
- Both need the `CLOUDFLARE_WORKERS_DEPLOY_TOKEN` (an account API token with only Workers Scripts: Edit) and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

Open tabs follow a deploy on their own: each deployed build changes `sw.js` (its build id), which raises the update prompt, and a chunk the deploy removed reloads the tab into the new build, or raises the same prompt while transfers or unsaved edits are running (`src/lib/appUpdate.ts`).
