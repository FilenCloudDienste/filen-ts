import { SW_SKIP_WAITING_MESSAGE } from "@/lib/sw/protocol"
import { log } from "@/lib/log"

let started = false
let registration: ServiceWorkerRegistration | null = null
// clients.claim() makes the FIRST-ever activation in a tab fire controllerchange too (an
// uncontrolled tab acquiring one is a "change"), not just a real update — this discriminates the two
// so only a user-confirmed applyUpdate() ever reloads the page.
let updateRequested = false
// `controllerchange` can in principle fire more than once — guards the reload to exactly once so a
// second firing can never re-navigate mid-flight.
let reloaded = false

// Dev has no built `sw.js` (that is a separate build, see vite.sw.config.ts), so it registers the
// worker's SOURCE module and lets the dev server transform it — sw.ts imports one module of
// constants and nothing else, so there is no bundle to reproduce. Scope has to be requested there
// because the script no longer sits at the root; the dev server answers Service-Worker-Allowed to
// permit it (vite.config.ts).
//
// Running it under HMR is safe for THIS worker specifically: it registers no install handler, never
// touches the Cache API, and its fetch handler returns without responding to anything but its own
// two routes — so every module request Vite serves passes straight through it.
const SW_URL = import.meta.env.PROD ? "/sw.js" : "/src/sw/sw.ts"

// Every deployed build changes sw.js (sw.ts reports its build id), so a deploy reaches open tabs as a
// worker update. The browser looks for one on each full page load, which a long-lived tab never makes,
// so a tab returning to view checks too: at most hourly, and the check is one conditional request.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

export function registerSW(onUpdateReady: () => void): void {
	if (started || !("serviceWorker" in navigator)) {
		return
	}

	started = true

	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (!updateRequested || reloaded) {
			return
		}

		reloaded = true
		window.location.reload()
	})

	// An update is a new worker installed beside a different active one; a first install (nothing to
	// prompt for) has none. The page's controller can't tell them apart: the first worker claims the page
	// on activating, and Firefox can deliver that claim before the worker's own "installed" state change
	// (seen with several tabs opening the origin at once).
	function watchInstalling(reg: ServiceWorkerRegistration, installing: ServiceWorker): void {
		installing.addEventListener("statechange", () => {
			if (installing.state === "installed" && reg.active !== null && reg.active !== installing) {
				onUpdateReady()
			}
		})
	}

	void navigator.serviceWorker
		.register(SW_URL, { type: "module", scope: "/" })
		.then(reg => {
			registration = reg

			// The browser's own update check runs independently of this page's JS and can finish before
			// this SDK-boot-gated call ever reaches here — a worker can already be waiting or mid-install
			// by the time `register()` resolves. Covers that in addition to the forward-looking listener
			// below, which only catches an update that starts later.
			if (reg.waiting !== null && reg.active !== null && reg.waiting !== reg.active) {
				onUpdateReady()
			} else if (reg.installing) {
				watchInstalling(reg, reg.installing)
			}

			reg.addEventListener("updatefound", () => {
				if (reg.installing) {
					watchInstalling(reg, reg.installing)
				}
			})

			let lastUpdateCheck = Date.now()

			document.addEventListener("visibilitychange", () => {
				if (document.visibilityState !== "visible" || Date.now() - lastUpdateCheck < UPDATE_CHECK_INTERVAL_MS) {
					return
				}

				lastUpdateCheck = Date.now()
				reg.update().catch((e: unknown) => {
					log.warn("sw", "update check failed", e)
				})
			})
		})
		.catch((e: unknown) => {
			log.warn("sw", "registration failed", e)
		})
}

// Tells the waiting worker to activate; the `controllerchange` listener set up in registerSW performs
// the actual reload once it does.
export function applyUpdate(): void {
	const waiting = registration?.waiting

	// No waiting worker: the prompt came from a newer build found another way (appUpdate.ts) before the
	// worker update was, and the page reload alone picks up the new build.
	if (!waiting) {
		window.location.reload()
		return
	}

	updateRequested = true
	waiting.postMessage({ type: SW_SKIP_WAITING_MESSAGE })
}
