import { SW_MSG_BUILD, SW_SKIP_WAITING_MESSAGE } from "@/lib/sw/protocol"
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

// sw.js and the page are built together, so a worker of this page's own build is never an update: a
// first install, a second registration of the same origin, or the worker a reload into a new deploy
// already runs. Only a different build prompts. Absent in local builds, where every worker matches.
const PAGE_BUILD = import.meta.env.VITE_BUILD_ID ?? null
// A worker answers from its own message handler, so silence this long means it cannot be compared:
// one older than this protocol, or one gone redundant.
const BUILD_QUERY_TIMEOUT_MS = 5_000

// Resolves undefined when the worker does not answer.
function workerBuild(worker: ServiceWorker): Promise<string | null | undefined> {
	return new Promise(resolve => {
		const channel = new MessageChannel()
		const timeout = setTimeout(() => {
			channel.port1.close()
			resolve(undefined)
		}, BUILD_QUERY_TIMEOUT_MS)

		channel.port1.onmessage = (event: MessageEvent<{ build?: unknown } | null>) => {
			clearTimeout(timeout)
			channel.port1.close()

			const build = event.data?.build

			resolve(typeof build === "string" ? build : null)
		}

		worker.postMessage({ type: SW_MSG_BUILD }, [channel.port2])
	})
}

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

	// Each installed worker is compared once, whichever of the paths below finds it first.
	const compared = new WeakSet<ServiceWorker>()

	// A worker of another build prompts. One of this page's build waiting beside an older active worker
	// is the worker this page belongs with (the tab reloaded into a new deploy before the old worker
	// let go), so it takes over without a reload: the page already runs its build.
	function compareInstalled(reg: ServiceWorkerRegistration, worker: ServiceWorker): void {
		if (compared.has(worker)) {
			return
		}

		compared.add(worker)

		void workerBuild(worker).then(build => {
			if (build === undefined) {
				return
			}

			if (build !== PAGE_BUILD) {
				onUpdateReady()
			} else if (reg.waiting === worker && reg.active !== null && reg.active !== worker) {
				worker.postMessage({ type: SW_SKIP_WAITING_MESSAGE })
			}
		})
	}

	function watchInstalling(reg: ServiceWorkerRegistration, installing: ServiceWorker): void {
		installing.addEventListener("statechange", () => {
			if (installing.state === "installed") {
				compareInstalled(reg, installing)
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
			if (reg.waiting !== null) {
				compareInstalled(reg, reg.waiting)
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
