# @filen/web

The Filen web app — a from-scratch rewrite of Filen's end-to-end encrypted Cloud Drive, Notes and Chats client for the browser. All cryptography, networking and transfers run through the Rust SDK (`@filen/sdk-rs`) inside a cross-origin-isolated worker; this package is the UI, routing and boot shell around it.

## Requirements

| Tool | Version |
| ---- | ------- |
| Node | >= 24   |
| npm  | >= 11   |

## Commands

| Command             | Description                                              |
| ------------------- | -------------------------------------------------------- |
| `npm run dev`       | Start the Vite dev server                                |
| `npm run build`     | Type-check, build the app, then build the service worker |
| `npm run preview`   | Serve the production build locally                       |
| `npm run test`      | Run the unit tests (Vitest)                              |
| `npm run test:e2e`  | Run the end-to-end tests (Playwright)                    |
| `npm run lint`      | ESLint plus a Prettier format check                      |
| `npm run typecheck` | Type-check without emitting                              |
| `npm run format`    | Format the source with Prettier                          |

## Deployment

`npm run build` emits a static `dist/` plus a service worker. Any static host can serve it, but the response headers below are part of the contract — the app does not boot without them.

### Response headers

Send these on **every** response:

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
- `index.html` is the SPA fallback for unknown paths and must never be long-cached.

An nginx `server{}` block implementing all of the above exists but is deliberately not checked in yet — ask before writing a new one.
