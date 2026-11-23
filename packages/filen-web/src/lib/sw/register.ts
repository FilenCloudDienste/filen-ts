import { SW_MSG_ACTIVE_STREAMS, SW_MSG_BUILD, SW_MSG_CLAIM, SW_PROTOCOL_VERSION, SW_SKIP_WAITING_MESSAGE } from "@/lib/sw/protocol"
import { log } from "@/lib/log"
import { buildId } from "@/lib/buildId"

let started = false
let registration: ServiceWorkerRegistration | null = null
// clients.claim() makes the FIRST-ever activation in a tab fire controllerchange too (an
// uncontrolled tab acquiring one is a "change"), not just a real update — this discriminates the two
// so only a user-confirmed applyUpdate() ever reloads the page.
let updateRequested = false
// `controllerchange` can in principle fire more than once — guards the reload to exactly once so a
// second firing can never re-navigate mid-flight.
let reloaded = false
// Told when a confirmed update is held back by a running download, so the prompt the user just
// dismissed by confirming can say why nothing happened yet.
let onUpdateDeferred: (() => void) | undefined

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
const PAGE_BUILD = buildId()
// A worker answers from its own message handler, so silence this long means it cannot be compared:
// one older than this protocol, or one gone redundant.
const BUILD_QUERY_TIMEOUT_MS = 5_000
// The active worker's stream count gates an update. A worker older than that query never answers, and
// waiting on it would block every update, so a short silence lets the update through.
const STREAMS_QUERY_TIMEOUT_MS = 2_000
// While a download streams through the active worker, the deferred update asks again this often.
const STREAMS_RECHECK_MS = 5_000

// Posts `type` to `worker` with a reply port. Resolves the reply's data, or undefined after `timeoutMs`
// of silence.
function askWorker(worker: ServiceWorker, type: string, timeoutMs: number): Promise<unknown> {
	return new Promise(resolve => {
		const channel = new MessageChannel()
		const timeout = setTimeout(() => {
			channel.port1.close()
			resolve(undefined)
		}, timeoutMs)

		channel.port1.onmessage = (event: MessageEvent<unknown>) => {
			clearTimeout(timeout)
			channel.port1.close()
			resolve(event.data ?? null)
		}

		worker.postMessage({ type }, [channel.port2])
	})
}

// Resolves undefined when the worker does not answer.
async function workerBuild(worker: ServiceWorker): Promise<string | null | undefined> {
	const answer = await askWorker(worker, SW_MSG_BUILD, BUILD_QUERY_TIMEOUT_MS)

	if (answer === undefined) {
		return undefined
	}

	return typeof answer === "object" && answer !== null && "build" in answer && typeof answer.build === "string" ? answer.build : null
}

// Streams in flight in `worker`, every tab's: each tab's downloads run through the one active worker. No
// answer or an unreadable one counts as none.
async function workerActiveStreams(worker: ServiceWorker): Promise<number> {
	const answer = await askWorker(worker, SW_MSG_ACTIVE_STREAMS, STREAMS_QUERY_TIMEOUT_MS)

	return typeof answer === "object" && answer !== null && "active" in answer && typeof answer.active === "number" ? answer.active : 0
}

// The waiting worker held back until the active one streams nothing, so one takeover runs per worker.
let pendingTakeover: ServiceWorker | null = null
// Whether a stream currently holds `pendingTakeover` back, and who to tell when it does.
let takeoverHeldBack = false
let takeoverOnDeferred: (() => void) | undefined

// Activating the waiting worker replaces the active one, cutting off every download streaming through it,
// so the active worker is asked first and the takeover waits for its last stream to end. Ends without
// posting once `waiting` is no longer the registration's waiting worker (activated, or replaced by a newer
// one, which is compared on its own). `onDeferred` runs the first time a stream holds the takeover back,
// and again for each later call while it is held back (a Reload prompt shown again turns back into the note).
function activateWhenIdle(reg: ServiceWorkerRegistration, waiting: ServiceWorker, onDeferred?: () => void): void {
	if (pendingTakeover === waiting) {
		takeoverOnDeferred = onDeferred ?? takeoverOnDeferred

		if (takeoverHeldBack) {
			onDeferred?.()
		}

		return
	}

	pendingTakeover = waiting
	takeoverHeldBack = false
	takeoverOnDeferred = onDeferred

	void (async () => {
		try {
			for (;;) {
				const active = reg.active
				const streams = active === null || active === waiting ? 0 : await workerActiveStreams(active)

				if (reg.waiting !== waiting) {
					return
				}

				if (streams === 0) {
					waiting.postMessage({ type: SW_SKIP_WAITING_MESSAGE })

					return
				}

				if (!takeoverHeldBack) {
					takeoverHeldBack = true
					takeoverOnDeferred?.()
				}

				await new Promise(resolve => setTimeout(resolve, STREAMS_RECHECK_MS))
			}
		} finally {
			if (pendingTakeover === waiting) {
				pendingTakeover = null
				takeoverHeldBack = false
				takeoverOnDeferred = undefined
			}
		}
	})()
}

export function registerSW(onUpdateReady: () => void, onDeferred?: () => void): void {
	if (started || !("serviceWorker" in navigator)) {
		return
	}

	started = true
	onUpdateDeferred = onDeferred

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
				activateWhenIdle(reg, worker)
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

			// Loaded beside an active worker without being controlled by it (SW_MSG_CLAIM): asked to take the page.
			if (navigator.serviceWorker.controller === null && reg.active !== null) {
				reg.active.postMessage({ type: SW_MSG_CLAIM })
			}

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

// Tells the waiting worker to activate once no download streams through the active one; the
// `controllerchange` listener set up in registerSW performs the actual reload once it does.
export function applyUpdate(): void {
	const reg = registration
	const waiting = reg?.waiting

	// No waiting worker: the prompt came from a newer build found another way (appUpdate.ts) before the
	// worker update was, and the page reload alone picks up the new build.
	if (!reg || !waiting) {
		window.location.reload()
		return
	}

	updateRequested = true
	activateWhenIdle(reg, waiting, onUpdateDeferred)
}

// The protocol version of the worker controlling this page, which answers `/__sw/version` itself (no
// network), asked once per controller. Null when nothing controls the page or the answer is unreadable.
let versionQuery: { controller: ServiceWorker; version: Promise<number | null> } | null = null

export function controllerProtocolVersion(): Promise<number | null> {
	const controller = "serviceWorker" in navigator ? navigator.serviceWorker.controller : null

	if (controller === null) {
		return Promise.resolve(null)
	}

	if (versionQuery?.controller !== controller) {
		const query = { controller, version: fetchProtocolVersion() }

		versionQuery = query
		// Only an answer is kept: a failed ask is asked again next time.
		void query.version.then(version => {
			if (version === null && versionQuery === query) {
				versionQuery = null
			}
		})
	}

	return versionQuery.version
}

// Whether the controlling worker speaks this page's protocol (it may be older: an update waits for the user).
export async function controllerIsCurrent(): Promise<boolean> {
	const version = await controllerProtocolVersion()

	return version !== null && version >= SW_PROTOCOL_VERSION
}

async function fetchProtocolVersion(): Promise<number | null> {
	try {
		const response = await fetch("/__sw/version", { cache: "no-store" })

		if (!response.ok) {
			return null
		}

		const body: unknown = await response.json()

		return typeof body === "object" && body !== null && "v" in body && typeof body.v === "number" ? body.v : null
	} catch {
		return null
	}
}
