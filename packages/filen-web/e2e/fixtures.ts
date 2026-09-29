import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
	test as base,
	expect,
	type Browser,
	type BrowserContext,
	type BrowserType,
	type Page,
	type PlaywrightWorkerArgs,
	type Request,
	type TestInfo
} from "@playwright/test"
import { SESSION_SLOT } from "@/e2e-hooks/sessionSlot"

// The session blob is secret-equivalent and lives ONLY here (gitignored, mode 0600) and in the
// sessionStorage seed — it is never typed into a page, so it cannot appear in screenshots or DOM
// snapshots.
export const AUTH_DIR = fileURLToPath(new URL(".auth", import.meta.url))
export const SESSION_FILE = fileURLToPath(new URL(".auth/session.json", import.meta.url))

// Where setup/fixtures.setup.ts records the shared read-only fixture tree it built, for every spec
// worker (a separate process) and the teardown project to read back. Gitignored for the same reason
// as .auth/ above — it is per-run state, never source — though unlike the session blob it holds
// nothing secret: just a run id and a directory name.
export const FIXTURES_DIR = fileURLToPath(new URL(".fixtures", import.meta.url))
export const FIXTURES_FILE = fileURLToPath(new URL(".fixtures/tree.json", import.meta.url))

export interface FixtureManifest {
	runId: string
	// The fixture root's NAME, not its uuid: every navigation to it goes through the listing UI, which
	// locates rows by name.
	fixtureRoot: string
}

// Throws rather than returning null: every caller is mid-test with nowhere useful to go without the
// tree, and the two ways this file can be missing (the fixtures-setup project did not run, or it ran
// in a different working copy) are both configuration mistakes that a "directory not found" timeout
// several steps later would disguise.
export function readFixtureManifest(): FixtureManifest {
	if (!existsSync(FIXTURES_FILE)) {
		throw new Error(`no fixture manifest at ${FIXTURES_FILE} — the fixtures-setup project has not run for this suite`)
	}

	return JSON.parse(readFileSync(FIXTURES_FILE, "utf8")) as FixtureManifest
}

export function readHarvestedSession(): string | null {
	if (!existsSync(SESSION_FILE)) {
		return null
	}

	const { session } = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as { session: string }

	return session
}

// addInitScript re-fires on every navigation of the page, reloads included.
export async function seedSession(page: Page, session: string): Promise<void> {
	await page.addInitScript(
		([slot, blob]) => {
			sessionStorage.setItem(slot, blob)
		},
		[SESSION_SLOT, session] as const
	)
}

// Every write serialises on an account-wide lease the SDK takes with `POST …/v3/user/lock`
// (resource `drive-write` / `notes-write` / `chats-write`) and releases fire-and-forget once the last
// write in the page finishes. Watched through the wire rather than asked for: the SDK exposes no way to
// enumerate or await held leases, and Playwright sees these requests even though the SDK runs in a
// dedicated Worker.
const LOCK_PATH = "/v3/user/lock"

interface LockRequestBody {
	uuid?: unknown
	type?: unknown
	resource?: unknown
}

// The answer is an envelope — `{status, message, code, data: {acquired, released, …}}` — so the flag
// sits one level down. Reading it off the top level fails silently: every lease then looks unheld, and
// the wait below returns on a page that is still holding one.
interface LockResponseBody {
	data?: {
		acquired?: unknown
	}
}

// Bounded, but generously: a lease nobody releases ages out on its own in ~70s (measured on this
// account), and the next test's first write pays every second of that — so waiting here up to 40s
// strictly dominates giving up at 10s, which is what the previous budget did.
const LEASE_RELEASE_TIMEOUT_MS = 40_000
const LEASE_RELEASE_POLL_MS = 100
// Every lock round trip on this account answers in tens of milliseconds, so an acquire still
// unanswered after this is one the CLIENT abandoned rather than one in flight. Observed live on the
// hop to /trash: the SDK fires two acquires and drops both — Chromium reports one `net::ERR_ABORTED`
// and the other no event at all — and the server grants one of them a lease that nothing ever
// releases. Waiting on those can only burn the whole budget (no answer is coming, and the lease is not
// ours to release), so they stop counting and are named in the warning instead.
const LEASE_ACQUIRE_ANSWER_MS = 5_000

interface LeaseTracker {
	waitForReleases: () => Promise<void>
}

// Every tracker by page, so closeTrackedPage can find the one the fixture attached.
const leaseTrackers = new WeakMap<Page, LeaseTracker>()

// Closes a page a spec opened itself only once its leases are released: closing it with a release in
// flight orphans the lease, and the next write anywhere on the account waits ~70s for it to age out.
export async function closeTrackedPage(page: Page): Promise<void> {
	await leaseTrackers.get(page)?.waitForReleases()
	await page.close()
}

// For a spec about to reload or navigate away right after a write: the SDK releases the lease
// fire-and-forget, and unloading the page with that release in flight orphans it the same way.
export async function settleLeases(page: Page): Promise<void> {
	await leaseTrackers.get(page)?.waitForReleases()
}

// Watches the write leases a page takes and hands back a bounded wait for their releases. The
// listeners attach on call, so a lease taken before that is invisible to it.
export function trackLeaseReleases(page: Page): LeaseTracker {
	// uuid -> resource for every lease acquired and not released again. The SDK mints a uuid per lease,
	// not per page, and its writes serialise on the lock anyway, so this holds one entry at a time.
	const heldLeases = new Map<string, string>()
	// An acquire whose answer has not been read yet. Waited on like a held lease: the answer lands
	// milliseconds after teardown starts and is usually `acquired: true`, so a wait that ignored these
	// would return on exactly the lease it exists to wait for. `startedAt` is what tells one of those
	// apart from an abandoned request that will never answer at all.
	const pendingAcquires = new Map<Request, { uuid: string; resource: string; startedAt: number }>()
	// uuids let go while their acquire was still undecided, so the late answer cannot re-mark them.
	const releasedUuids = new Set<string>()
	// A release the server has not answered yet. The request going out is NOT the end of the story: it
	// is dispatched to the network service, and a context closed before the answer comes back cancels it
	// with the lease still held.
	const pendingReleases = new Map<Request, { uuid: string; resource: string }>()

	// Guarded throughout: postDataJSON()/json() throw on a page that is closing, and a frame missed
	// here may only ever cost the wait below, never the test.
	page.on("request", request => {
		try {
			if (!new URL(request.url()).pathname.endsWith(LOCK_PATH)) {
				return
			}

			const body = request.postDataJSON() as LockRequestBody | null

			if (body === null || typeof body.uuid !== "string") {
				return
			}

			const uuid = body.uuid
			const resource = typeof body.resource === "string" ? body.resource : "unknown"

			if (body.type === "acquire") {
				releasedUuids.delete(uuid)
				pendingAcquires.set(request, { uuid, resource, startedAt: Date.now() })
			}

			if (body.type === "release") {
				// The SDK never awaits this, so the wait below does it instead. Any acquire for this uuid
				// still awaiting an answer is dropped with it, so a late one cannot re-mark a lease that
				// has already been let go.
				heldLeases.delete(uuid)
				releasedUuids.add(uuid)
				pendingReleases.set(request, { uuid, resource })

				for (const [pending, acquire] of pendingAcquires) {
					if (acquire.uuid === uuid) {
						pendingAcquires.delete(pending)
					}
				}
			}
		} catch {
			// see above
		}
	})

	page.on("response", response => {
		try {
			pendingReleases.delete(response.request())

			const acquire = pendingAcquires.get(response.request())

			if (acquire === undefined) {
				return
			}

			// Stays pending until the body has been read and acted on, not just until the headers land:
			// reading it is I/O, and dropping it first opens a window where the lease is neither pending
			// nor held and the wait below sees nothing to wait for.
			void response
				.json()
				.then((body: LockResponseBody | null) => {
					if (body?.data?.acquired === true && !releasedUuids.has(acquire.uuid)) {
						heldLeases.set(acquire.uuid, acquire.resource)
					}
				})
				.catch(() => undefined)
				.finally(() => pendingAcquires.delete(response.request()))
		} catch {
			// see above
		}
	})

	// A request that never answers (a page torn down mid-flight) would otherwise hold the wait open for
	// its whole budget.
	page.on("requestfailed", request => {
		pendingAcquires.delete(request)
		pendingReleases.delete(request)
	})

	const tracker: LeaseTracker = {
		// Hold the context open until the server has answered the release. Killing it with one still in
		// flight leaves the lease to age out on its own, and the next test's first write waits that out:
		// measured at 74,683ms against 544ms, and one such orphan cost a later create 49s even after the
		// release request itself had gone out. A page that acquired nothing waits for nothing, so this is
		// free on the read lane.
		waitForReleases: async () => {
			const deadline = Date.now() + LEASE_RELEASE_TIMEOUT_MS
			const answerable = () =>
				[...pendingAcquires.values()].filter(({ startedAt }) => Date.now() - startedAt < LEASE_ACQUIRE_ANSWER_MS).length

			while ((heldLeases.size > 0 || answerable() > 0 || pendingReleases.size > 0) && Date.now() < deadline) {
				await new Promise(resolve => setTimeout(resolve, LEASE_RELEASE_POLL_MS))
			}

			// Named per bucket, because the three mean different things and the silent version of this
			// reported only the first: a HELD lease means the release never went out, an UNANSWERED
			// release that it went out and died in flight, and an ABANDONED acquire that the client threw
			// a lock request away — which is the one that leaves a lease nobody can release. All three
			// cost the next test's first write, so none of them may pass unremarked.
			const stuck = [
				...[...heldLeases.values()].map(resource => `held ${resource}`),
				...[...pendingAcquires.values()].map(({ uuid, resource }) => `abandoned acquire ${resource} ${uuid}`),
				...[...pendingReleases.values()].map(({ uuid, resource }) => `unanswered release ${resource} ${uuid}`)
			]

			if (stuck.length > 0) {
				console.warn(`lease not settled at teardown (${stuck.join(", ")})`)
			}
		}
	}

	leaseTrackers.set(page, tracker)

	return tracker
}

// What a failed test's page did, attached to its report: console errors (dedicated workers' included),
// uncaught page errors, failed or >= 400 requests and the lock timeline, each with its offset from the
// test's start. Method and path only, never headers, query strings or bodies. Collected on every test but
// attached only on failure, so a green run pays for nothing but the listeners.
// Runs in every page: reports main-thread long tasks, stalled timers (script blocked) and frames that do
// not come (rendering paused) to the diagnostics. An action stuck on "waiting for element to be …" with
// no reason logged is Playwright's in-page check never answering, which otherwise leaves no trace.
function stallProbe(): void {
	const report = (line: string): void => {
		void (window as unknown as { __e2eStall?: (line: string) => Promise<void> }).__e2eStall?.(line)
	}

	if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
		new PerformanceObserver(list => {
			for (const entry of list.getEntries()) {
				if (entry.duration >= 500) {
					report(`long task ${String(Math.round(entry.duration))}ms`)
				}
			}
		}).observe({ type: "longtask" })
	}

	let last = performance.now()

	setInterval(() => {
		const now = performance.now()
		const late = now - last - 1000

		last = now

		if (late >= 1000) {
			report(`timers stalled ${String(Math.round(late))}ms`)
		}

		if (document.visibilityState === "visible") {
			requestAnimationFrame(() => {
				const waited = performance.now() - now

				if (waited >= 1000) {
					report(`frame stalled ${String(Math.round(waited))}ms`)
				}
			})
		}
	}, 1000)
}

async function collectDiagnostics(context: BrowserContext): Promise<() => string> {
	const startedAt = Date.now()
	const lines: string[] = []
	const log = (line: string) => {
		lines.push(`+${String(Date.now() - startedAt).padStart(6)}ms ${line}`)
	}
	const path = (url: string) => {
		try {
			return new URL(url).pathname
		} catch {
			return "?"
		}
	}
	const inFlight = new Map<Request, { tab: string; startedAt: number }>()
	const watch = (page: Page) => {
		const tab = `tab${String(context.pages().indexOf(page))}`

		page.on("console", message => {
			if (message.type() === "error" || message.type() === "warning") {
				log(`${tab} console.${message.type()}: ${message.text().slice(0, 500)}`)
			}
		})
		page.on("pageerror", error => {
			log(`${tab} pageerror: ${error.message.slice(0, 500)}`)
		})
		page.on("requestfailed", request => {
			log(`${tab} request failed ${request.method()} ${path(request.url())}: ${request.failure()?.errorText ?? "?"}`)
		})
		page.on("request", request => {
			try {
				if (path(request.url()).endsWith(LOCK_PATH)) {
					const body = request.postDataJSON() as LockRequestBody | null

					log(`${tab} lock ${String(body?.type)} ${String(body?.resource)} ${String(body?.uuid)}`)
				}
			} catch {
				// A closing page's request can no longer be read; the timeline just loses that line.
			}
		})
		page.on("response", response => {
			if (response.status() >= 400) {
				log(`${tab} ${String(response.status())} ${response.request().method()} ${path(response.url())}`)
			}
		})
		page.on("close", () => {
			log(`${tab} closed`)
		})
		// Requests still unanswered when the test ends: a listing or a stream that never arrives shows up
		// as a request left hanging, or as none at all.
		page.on("request", request => {
			inFlight.set(request, { tab, startedAt: Date.now() })
		})
		page.on("requestfinished", request => {
			inFlight.delete(request)
		})
		page.on("requestfailed", request => {
			inFlight.delete(request)
		})
	}

	for (const page of context.pages()) {
		watch(page)
	}

	context.on("page", watch)

	await context.exposeBinding("__e2eStall", ({ page }, line: string) => {
		log(`tab${String(context.pages().indexOf(page))} ${line}`)
	})
	await context.addInitScript(stallProbe)

	return () => {
		const now = Date.now()
		const pending = [...inFlight].map(
			([request, { tab, startedAt }]) =>
				`+${String(now - startedAt).padStart(6)}ms ago ${tab} still in flight ${request.method()} ${path(request.url())}`
		)

		return [...lines, ...(pending.length === 0 ? [] : ["-- in flight at the end --", ...pending])].join("\n")
	}
}

// Every lane runs once per browser, but the account has one write lease per resource, and two browsers'
// writes to the same resource only queue on it: every extra in-flight write is one more lease a timeout
// can orphan (see playwright.config.ts). So a test in a lane that writes (its project's
// `metadata.accountLock` names the resource: drive, notes or chats) holds a cross-process lock for that
// resource for its whole run, page and lease settling included. Reads take none.
const LOCK_DIR = fileURLToPath(new URL(".locks", import.meta.url))
const LOCK_POLL_MS = 250
// Waiting is not the test's own work, so it gets its own budget (the fixture timeout below) rather than
// eating the test's. Sized for every other browser's writes to the same resource queued ahead of it.
const LOCK_WAIT_TIMEOUT_MS = 60 * 60_000
// A lock whose owner has not written its record yet is only that old for an instant.
const LOCK_UNCLAIMED_MS = 10_000

interface LockOwner {
	pid: number
	test: string
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)

		return true
	} catch (error) {
		// EPERM: alive, owned by someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

// A lock left by a worker that died (killed at its timeout, or a crashed earlier run) has no live owner.
function isAbandoned(lock: string): boolean {
	try {
		const owner = JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")) as LockOwner

		return !isProcessAlive(owner.pid)
	} catch {
		try {
			return Date.now() - statSync(lock).mtimeMs > LOCK_UNCLAIMED_MS
		} catch {
			return false
		}
	}
}

function lockOwner(testInfo: TestInfo): string {
	return `${testInfo.project.name} › ${testInfo.titlePath.join(" › ")}`
}

// A cross-process lock shared by every worker of the run (and any other local run on this checkout).
// mkdir is atomic, so exactly one process creates the lock. An abandoned one is renamed away before it is
// removed, so two waiters that both find it abandoned cannot delete the lock one of them has just taken.
async function acquireLock(name: string, test: string): Promise<() => void> {
	const lock = join(LOCK_DIR, name)

	mkdirSync(LOCK_DIR, { recursive: true })

	for (;;) {
		try {
			mkdirSync(lock)
			writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, test } satisfies LockOwner))

			return () => {
				rmSync(lock, { recursive: true, force: true })
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error
			}
		}

		if (isAbandoned(lock)) {
			const stale = `${lock}.stale-${String(process.pid)}-${String(Date.now())}`

			try {
				renameSync(lock, stale)
				rmSync(stale, { recursive: true, force: true })
				console.warn(`lock "${name}" was abandoned by a dead worker, taken over`)
			} catch {
				// Another waiter took it over first.
			}

			continue
		}

		await new Promise(resolve => setTimeout(resolve, LOCK_POLL_MS))
	}
}

// Playwright's WebKit keeps OPFS in one directory per origin for the whole machine (macOS:
// ~/Library/WebKit/org.webkit.Playwright/WebsiteData), whatever profile a persistent context is given, so
// every webkit test shares the app's storage: its session, its settings, its database files. So webkit
// tests run one at a time under this lock, each from a wiped origin (wipeWebkitOrigin).
const WEBKIT_STORAGE_LOCK = "webkit-storage"

// Clears what outlives a profile, from a same-origin document that does not boot the app (booting would
// open the database and lock the very files this removes).
async function wipeWebkitOrigin(context: BrowserContext, baseURL: string): Promise<void> {
	const page = await context.newPage()

	await page.goto(new URL("/robots.txt", baseURL).toString())
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory()
		const names: string[] = []

		for await (const [name] of root.entries()) {
			names.push(name)
		}

		await Promise.all(names.map(name => root.removeEntry(name, { recursive: true })))
		await Promise.all((await navigator.serviceWorker.getRegistrations()).map(registration => registration.unregister()))
		await Promise.all((await caches.keys()).map(key => caches.delete(key)))
	})
	await page.close()
}

// A persistent webkit context over a fresh profile, its origin wiped. `discard` removes the profile once
// the context is closed. Its blank start page stays open: on Linux, MiniBrowser opens every later page
// in that page's web context through a pointer it holds no reference to, so closing it frees the context
// and the next newPage() aborts the browser.
async function launchWebkitContext(
	webkit: BrowserType,
	options: Parameters<BrowserType["launchPersistentContext"]>[1]
): Promise<{ context: BrowserContext; discard: () => void }> {
	const profile = mkdtempSync(join(tmpdir(), "filen-e2e-webkit-"))
	const context = await webkit.launchPersistentContext(profile, options)

	if (options?.baseURL !== undefined) {
		await wipeWebkitOrigin(context, options.baseURL)
	}

	return {
		context,
		discard: () => {
			rmSync(profile, { recursive: true, force: true })
		}
	}
}

// For a hook, which gets no `context` fixture: a context made the way the fixtures make one, under the
// account lock its project writes with and, on webkit, the storage lock over a persistent wiped profile.
export async function openHookContext(
	{ browser, browserName, playwright }: { browser: Browser; browserName: string; playwright: PlaywrightWorkerArgs["playwright"] },
	testInfo: TestInfo,
	baseURL: string
): Promise<{ context: BrowserContext; close: () => Promise<void> }> {
	const releases: (() => void)[] = []
	const resource: unknown = testInfo.project.metadata["accountLock"]
	const owner = `${lockOwner(testInfo)} (hook)`

	if (typeof resource === "string") {
		releases.push(await acquireLock(resource, owner))
	}

	const release = () => {
		for (const releaseLock of releases.reverse()) {
			releaseLock()
		}
	}

	try {
		if (browserName !== "webkit") {
			const context = await browser.newContext({ baseURL })

			return {
				context,
				close: async () => {
					await context.close()
					release()
				}
			}
		}

		releases.push(await acquireLock(WEBKIT_STORAGE_LOCK, owner))

		const { context, discard } = await launchWebkitContext(playwright.webkit, { baseURL })

		return {
			context,
			close: async () => {
				await context.close()
				discard()
				release()
			}
		}
	} catch (error) {
		release()

		throw error
	}
}

// Opt-in only: reproduces CI's slower runners locally by slowing every Chromium renderer in the
// context by this factor. Anything but a number above 1 (unset, garbage, 1) leaves the run untouched.
const CPU_THROTTLE_RATE = Number(process.env["E2E_CPU_THROTTLE"] ?? "1")

// Fixture every authed spec pulls in. It seeds the saved session blob into sessionStorage before the
// app loads on every navigation (page context — the worker-owned sqlite cannot be written from an
// init script; the app's own e2e hook moves it into the worker + kv and re-runs the route guards).
// Skips cleanly when no session was minted (no credentials), so the SDK-free subset still runs for
// contributors without credentials.
export const test = base.extend<{
	injectedSession: string
	failureDiagnostics: undefined
	accountLock: undefined
	webkitStorageLock: undefined
}>({
	accountLock: [
		// Playwright requires a destructured first argument; browserName is a free worker-scoped one.
		async ({ browserName: _browserName }, use, testInfo) => {
			const resource: unknown = testInfo.project.metadata["accountLock"]

			if (typeof resource !== "string") {
				await use(undefined)

				return
			}

			const release = await acquireLock(resource, lockOwner(testInfo))

			try {
				await use(undefined)
			} finally {
				release()
			}
		},
		{ auto: true, timeout: LOCK_WAIT_TIMEOUT_MS }
	],
	// Taken after the account lock, always in that order, so two tests can never hold one each and wait
	// on the other's.
	webkitStorageLock: [
		async ({ browserName, accountLock: _accountLock }, use, testInfo) => {
			if (browserName !== "webkit") {
				await use(undefined)

				return
			}

			const release = await acquireLock(WEBKIT_STORAGE_LOCK, lockOwner(testInfo))

			try {
				await use(undefined)
			} finally {
				release()
			}
		},
		{ auto: true, timeout: LOCK_WAIT_TIMEOUT_MS }
	],
	// WebKit backs OPFS only in a browser profile on disk, never in Playwright's default in-memory
	// contexts (getDirectory() rejects with UnknownError there), and the app cannot boot without it. So a
	// webkit test runs in a persistent context over a fresh profile of its own (which isolates everything
	// but OPFS, see WEBKIT_STORAGE_LOCK), with the options the project's context would have had. The
	// default context is still created, but no page ever opens in it. Depends on the locks so they
	// outlive the context.
	context: async (
		{
			context,
			webkitStorageLock: _webkitStorageLock,
			browserName,
			playwright,
			baseURL,
			viewport,
			userAgent,
			deviceScaleFactor,
			isMobile,
			hasTouch,
			colorScheme,
			locale,
			serviceWorkers,
			acceptDownloads,
			video
		},
		use,
		testInfo
	) => {
		if (browserName !== "webkit") {
			await use(context)

			return
		}

		const videoMode = typeof video === "string" ? video : video.mode
		const videoDir = testInfo.outputPath("webkit-video")
		const { context: persistent, discard } = await launchWebkitContext(playwright.webkit, {
			...(baseURL !== undefined ? { baseURL } : {}),
			viewport,
			...(userAgent !== undefined ? { userAgent } : {}),
			...(deviceScaleFactor !== undefined ? { deviceScaleFactor } : {}),
			isMobile,
			hasTouch,
			colorScheme,
			...(locale !== undefined ? { locale } : {}),
			serviceWorkers,
			acceptDownloads,
			...(videoMode === "off" ? {} : { recordVideo: { dir: videoDir } })
		})

		// Collected as pages open: one a test closes itself is gone from pages() by the end.
		const videos: NonNullable<ReturnType<Page["video"]>>[] = []

		persistent.on("page", opened => {
			const recording = opened.video()

			if (recording !== null) {
				videos.push(recording)
			}
		})

		try {
			await use(persistent)
		} finally {
			await persistent.close()

			if (videoMode === "retain-on-failure" && testInfo.status !== testInfo.expectedStatus) {
				for (const [index, recording] of videos.entries()) {
					await testInfo.attach(`video${index === 0 ? "" : `-${String(index)}`}`, {
						path: await recording.path(),
						contentType: "video/webm"
					})
				}
			} else {
				rmSync(videoDir, { recursive: true, force: true })
			}

			discard()
		}
	},
	failureDiagnostics: [
		async ({ context }, use, testInfo) => {
			const report = await collectDiagnostics(context)

			await use(undefined)

			if (testInfo.status !== testInfo.expectedStatus) {
				await testInfo.attach("diagnostics", { body: report() || "(nothing recorded)", contentType: "text/plain" })
			}
		},
		{ auto: true }
	],
	// CDP is chromium-only, so firefox/webkit run at full speed whatever the variable says.
	page: async ({ page, context, browserName }, use) => {
		if (browserName === "chromium" && CPU_THROTTLE_RATE > 1) {
			const throttle = async (target: Page) => {
				const cdp = await context.newCDPSession(target)

				await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_THROTTLE_RATE })
			}

			// Second pages a spec opens itself (notes, storage, auth) carry their own renderer.
			// Catches: a page closed before its CDP session attaches rejects, and an unhandled rejection
			// here fails the run.
			context.on("page", opened => {
				void throttle(opened).catch(() => undefined)
			})

			await throttle(page)
		}

		await use(page)
	},
	injectedSession: async ({ page, context, accountLock: _accountLock }, use) => {
		const session = readHarvestedSession()

		if (session === null) {
			test.skip(true, "no injected session (e2e credentials not configured)")

			return
		}

		await seedSession(page, session)

		// Second pages a spec opens itself take leases too, and a spec closing one mid-release orphans it
		// the same way a closed context would (closeTrackedPage avoids that).
		trackLeaseReleases(page)
		context.on("page", trackLeaseReleases)

		await use(session)

		await Promise.all(
			context
				.pages()
				.filter(open => !open.isClosed())
				.flatMap(open => {
					const tracker = leaseTrackers.get(open)

					return tracker === undefined ? [] : [tracker.waitForReleases()]
				})
		)
	}
})

export { expect }
