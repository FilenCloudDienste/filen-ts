import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { test as base, expect, type BrowserContext, type Page, type Request } from "@playwright/test"

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

// Must match src/e2e-hooks/index.ts and the app's SESSION_SLOT.
const SESSION_SLOT = "filen.e2e.session"

interface SessionFile {
	session: string
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
function collectDiagnostics(context: BrowserContext): () => string {
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
	}

	for (const page of context.pages()) {
		watch(page)
	}

	context.on("page", watch)

	return () => lines.join("\n")
}

// Opt-in only: reproduces CI's slower runners locally by slowing every Chromium renderer in the
// context by this factor. Anything but a number above 1 (unset, garbage, 1) leaves the run untouched.
const CPU_THROTTLE_RATE = Number(process.env["E2E_CPU_THROTTLE"] ?? "1")

// Fixture every authed spec pulls in. It seeds the saved session blob into sessionStorage before the
// app loads on every navigation (page context — the worker-owned sqlite cannot be written from an
// init script; the app's own e2e hook moves it into the worker + kv and re-runs the route guards).
// Skips cleanly when no session was minted (no credentials), so the SDK-free subset still runs for
// contributors without credentials.
export const test = base.extend<{ injectedSession: string; failureDiagnostics: undefined }>({
	failureDiagnostics: [
		async ({ context }, use, testInfo) => {
			const report = collectDiagnostics(context)

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
	injectedSession: async ({ page, context }, use) => {
		if (!existsSync(SESSION_FILE)) {
			test.skip(true, "no injected session (e2e credentials not configured)")

			return
		}

		const { session } = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as SessionFile

		await page.addInitScript(
			([slot, blob]) => {
				sessionStorage.setItem(slot, blob)
			},
			[SESSION_SLOT, session] as const
		)

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
