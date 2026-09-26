// Playwright's Firefox build (not Firefox itself) never completes a fetch made from a worker that
// another worker spawned, while the page is controlled by a service worker. The SDK does all of its
// network I/O from exactly such workers (its wasm thread pool, spawned by the SDK worker), so with the
// app's service worker in control every authenticated read hangs and fails after the SDK's timeout.
//
// Measured on Playwright 1.63 (firefox-1543, Firefox 155) against the preview build: the same app page
// answers a nested-worker fetch in ~20ms once service workers are blocked, and hangs without an answer
// while its service worker is in control. Real Firefox 153, driven outside Playwright, answers the same
// nested-worker fetch in ~20ms with a service worker in control, so users are unaffected.
//
// The firefox lanes therefore block service workers (playwright.config.ts). A test that exercises the
// service worker itself (streamed downloads, the SW version endpoint, media streamed over the SW) skips
// there with this reason, and still runs on chromium and webkit. Retest by flipping `serviceWorkers`
// back to "allow" for firefox whenever @playwright/test is bumped.
export const FIREFOX_SERVICE_WORKERS_BLOCKED =
	"service workers are blocked on Playwright-firefox: its build hangs nested-worker fetches under SW control (see e2e/helpers/firefox.ts)"
