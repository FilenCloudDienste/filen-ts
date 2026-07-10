// Single source of truth for every Playwright-firefox authed-read skip in this suite. The dozen specs
// that need a real, authenticated SDK call all import FIREFOX_HANG_REASON from here so the proven root
// cause lives in exactly one place.
//
// SYMPTOM
// On Playwright-firefox the authed drive listing sits on its loading skeleton forever and the toolbar
// stays permanently disabled — it never reaches either terminal render state. Chromium is unaffected.
//
// ROOT CAUSE (reproduced, login-free, isolated to a minimal case)
// The SDK runs entirely inside a Web Worker (src/workers/sdk.worker.ts) and issues every API request as
// a cross-origin fetch from that worker and its SharedArrayBuffer thread pool. Under cross-origin
// isolation (COOP + COEP require-corp — mandatory for the wasm thread pool, which boots 8 threads under
// COI) Playwright-firefox HANGS on a worker-initiated cross-origin fetch: the request neither resolves
// nor rejects. Proof, with no login and no SDK involved: an in-page `fetch("https://gateway.filen.io/
// v3/health")` resolves 200 on BOTH engines, but the identical fetch from a blob module `Worker` hangs
// on Playwright-firefox while chromium returns 200. The SDK's own probeAuthedRead (getUserInfo — the
// cheapest authed read, a single round-trip with no listing logic) hangs too, which proves the defect
// is not listing-specific but hits every worker cross-origin call the SDK makes. boot.spec.ts still
// passes on firefox because the authed shell renders from the injected session alone (hasClient), with
// no network read — only calls that actually reach the API hang.
//
// NOT CLIENT-SIDE FIXABLE
// COEP cannot be dropped: it is required for SharedArrayBuffer, and without it initThreadPool fails on
// EVERY browser (boot "pool" error) — a real regression to appease one test engine. COEP credentialless
// was tested end-to-end and does NOT change the outcome: crossOriginIsolated stays true on both engines
// and firefox still hangs. The fetch itself lives inside the wasm SDK and must not be reimplemented or
// moved to the main thread. There is no client-side change that keeps the worker+threads architecture
// and unblocks Playwright-firefox — this is a Playwright-firefox engine/interception defect.
//
// SIBLING MANIFESTATIONS (same COI worker-networking defect, different call site)
// sw.spec.ts (service worker unreliable under COI), storage.spec.ts (second SDK-worker tab unstable),
// auth.spec.ts (authed-shell-reload instability) all trace to this same cause.
//
// RETEST TRIGGER
// Bump @playwright/test, then re-run `npx playwright test --project=firefox` with the gated tests
// flipped. Evidence points to a Playwright/Juggler network-layer race, not a Firefox-engine bug: in the
// minimal repro the worker cross-origin CORS fetch was INTERMITTENT (hung once, returned 200 once),
// which a genuine engine bug would not be, and real Firefox is expected to pass. This cannot be
// confirmed headlessly here — Playwright ships only its own patched Firefox (there is no stable-channel
// Firefox target), so verifying against real Firefox needs a manual profile run.
export const FIREFOX_HANG_REASON =
	"authed SDK calls run in a Web Worker; Playwright-firefox hangs on worker-initiated cross-origin fetch under cross-origin isolation (see e2e/helpers/firefox.ts)"
