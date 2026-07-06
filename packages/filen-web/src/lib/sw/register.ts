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

// Registration is PROD-only: dev never builds `sw.js` (a separate build, see vite.sw.config.ts), and
// a controlling worker would fight Vite's own HMR module invalidation.
export function registerSW(onUpdateReady: () => void): void {
	if (started || !import.meta.env.PROD || !("serviceWorker" in navigator)) {
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

	// A controller already exists → the worker reaching "installed" is an update, not the page's
	// first-ever install (which has nothing to prompt for).
	function watchInstalling(installing: ServiceWorker): void {
		installing.addEventListener("statechange", () => {
			if (installing.state === "installed" && navigator.serviceWorker.controller) {
				onUpdateReady()
			}
		})
	}

	void navigator.serviceWorker
		.register("/sw.js", { type: "module" })
		.then(reg => {
			registration = reg

			// The browser's own update check runs independently of this page's JS and can finish before
			// this SDK-boot-gated call ever reaches here — a worker can already be waiting or mid-install
			// by the time `register()` resolves. Covers that in addition to the forward-looking listener
			// below, which only catches an update that starts later.
			if (reg.waiting && navigator.serviceWorker.controller) {
				onUpdateReady()
			} else if (reg.installing) {
				watchInstalling(reg.installing)
			}

			reg.addEventListener("updatefound", () => {
				if (reg.installing) {
					watchInstalling(reg.installing)
				}
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

	if (!waiting) {
		log.warn("sw", "applyUpdate called with no waiting worker")
		return
	}

	updateRequested = true
	waiting.postMessage({ type: SW_SKIP_WAITING_MESSAGE })
}
