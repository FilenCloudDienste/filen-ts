// Single source of truth for every Playwright-firefox authed-read skip in this suite. The specs that
// need a real, authenticated SDK call all import FIREFOX_HANG_REASON from here so the reason lives in
// exactly one place.
//
// OBSERVED SYMPTOM (reproducible)
// On Playwright-firefox the authed drive listing sits on its loading skeleton forever and the toolbar
// stays permanently disabled — it never reaches either terminal render state. Chromium is unaffected.
// The SDK runs entirely inside a Web Worker (src/workers/sdk.worker.ts) backed by a SharedArrayBuffer
// thread pool, which mandates cross-origin isolation (COOP + COEP require-corp; initThreadPool boots
// several threads under COI). boot.spec.ts still passes on firefox because the authed shell renders
// from the injected session alone (hasClient) with no network read — only flows that reach the API
// hang. This much is stable and is why the skips below are retained.
//
// SUSPECTED MECHANISM (NOT independently reproduced — treat as a hypothesis)
// The natural explanation is that Playwright-firefox stalls a worker-initiated cross-origin fetch under
// COI. A login-free minimal case was built to isolate it — a COI page (COOP same-origin, COEP
// require-corp) issuing an in-page fetch vs a blob module Worker fetch to gateway.filen.io/v3/health —
// but on current Playwright-firefox it does NOT reproduce the differential: the in-page control returns
// 200 and the worker cross-origin fetch ALSO returns 200, including under a concurrency variant (many
// module workers x repeated fetches). Earlier runs saw the worker fetch hang only intermittently. So a
// bare worker cross-origin simple-GET is not by itself the defect on this Playwright build. The real
// cause is more specific than the minimal case exercises — candidates the /v3/health GET does not cover
// include the wasm rayon SAB thread-pool nested-worker path and preflighted authed POSTs — or it is a
// Playwright-version-specific race the current build no longer trips. This has not been narrowed
// further because the full authed SDK path cannot be exercised headlessly here (no credentials/build).
//
// WHY THE SKIPS STAY
// COEP cannot be dropped: it is required for SharedArrayBuffer, and without it initThreadPool fails on
// EVERY browser (boot "pool" error) — a real regression to appease one test engine. COEP credentialless
// was tested end-to-end and does NOT change the outcome: crossOriginIsolated stays true on both engines
// and firefox still hangs. The failing work lives inside the wasm SDK worker and must not be
// reimplemented or moved to the main thread. Absent a reproduced client-side mechanism, and given the
// symptom is confined to Playwright-firefox (chromium is unaffected and real Firefox is untested here),
// the pragmatic call is to skip these authed reads on firefox rather than degrade the architecture.
//
// SIBLING MANIFESTATIONS (same authed-under-COI symptom, different call site)
// sw.spec.ts (service worker unreliable under COI), storage.spec.ts (second SDK-worker tab unstable),
// auth.spec.ts (authed-shell-reload instability) present the same way on firefox.
//
// RETEST TRIGGER
// Since the minimal case now passes on the current Playwright build, re-run
// `npx playwright test --project=firefox` with the gated tests flipped whenever @playwright/test is
// bumped — the underlying issue may already be gone, or may resurface. Playwright ships only its own
// patched Firefox (no stable-channel target), so confirming against real Firefox needs a manual profile
// run and cannot be done headlessly here.
export const FIREFOX_HANG_REASON =
	"authed SDK reads hang on Playwright-firefox under cross-origin isolation; mechanism unconfirmed (see e2e/helpers/firefox.ts)"
