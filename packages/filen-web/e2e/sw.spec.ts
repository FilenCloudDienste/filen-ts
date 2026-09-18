import { test, expect } from "./fixtures"
import { SW_DOWNLOAD_PREFIX, SW_MSG_INIT_CLIENT, SW_MSG_LOGOUT, SW_MSG_REGISTER_ZIP_DOWNLOAD } from "@/lib/sw/protocol"
import { bootTo, enterScratchDirectory, trashScratchDirectory, LIVE_WRITE_TIMEOUT_MS } from "./helpers/listing"
import { waitForSwReady } from "./helpers/sw"

// Mirrors saveDownload.ts's own (non-exported) SW_REQUEST_TIMEOUT_MS — see no-coi.spec.ts for the same
// local-redeclaration precedent. The app's budget is the right one here: this file drives the same
// protocol against the same worker, so an ack that would fail the app must fail here too.
const SW_ACK_TIMEOUT_MS = 15_000

// Ceiling for a response the worker itself serves. The zip is a live SDK download of the two files
// uploaded below, streamed through the worker, so this is sized off that round trip rather than off
// the archive's byte count.
const SW_RESPONSE_TIMEOUT_MS = 60_000

// Registration is PROD-only and gated on boot ready, so this runs against preview. webkit is excluded
// (not tagged @no-sdk) — its service-worker support under Playwright is unreliable. The
// unauthenticated version-endpoint probe lives in sw-version.spec.ts instead: lane membership is per
// FILE, and the live writes below are what pin this one to the serial write lane.
test.describe("service worker", () => {
	// The zip flavor of the sw download route needs real, live-downloadable content and an
	// authenticated SW_MSG_INIT_CLIENT handshake. Driven directly through the SW postMessage protocol
	// rather than through a real Download click: Chromium (the only engine this suite trusts for
	// service workers — see the skip below) always has the File System Access API, so a real click
	// would take the fsa branch and never reach the sw route under test here.
	test("registers a real 2-file selection, streams a valid zip response, and drops it on logout", async ({
		page,
		injectedSession,
		browserName
	}) => {
		// Playwright-firefox's service-worker support under COI is unreliable (registration never
		// controls the page); this test additionally makes real authenticated worker calls
		// (upload/trash), which independently hang on Playwright-firefox under COI too (see boot.spec.ts).
		//
		// It is also what keeps fixtures-teardown safe: the firefox project depends on cleanup-setup
		// only, so nothing orders it behind the fixture tree's removal. This skip is why no firefox
		// write is ever live on the account when that teardown fires.
		test.skip(
			browserName === "firefox",
			"service workers and authenticated worker calls are unreliable on Playwright-firefox under COI"
		)
		expect(injectedSession.length).toBeGreaterThan(0)

		// The drive listing, not just the bare authed shell, so the scratch directory below has somewhere
		// to be created.
		await bootTo(page)
		await waitForSwReady(page)

		const scratchName = `e2e-sw-zip-${crypto.randomUUID()}`

		try {
			await enterScratchDirectory(page, scratchName)

			const scratchUuid = /\/drive\/([^/]+)$/.exec(page.url())?.[1]

			if (scratchUuid === undefined) {
				throw new Error("scratch directory did not navigate to a uuid'd url")
			}

			const result = await page.evaluate(
				async ({ initType, registerType, logoutType, prefix, parentUuid, ackTimeoutMs, uploadTimeoutMs, responseTimeoutMs }) => {
					const hooks = window.__filenE2E

					// page.evaluate is bounded only by the TEST timeout, and every live stage below can stall
					// on its own — an upload queued behind a contended lease, an ack from a wedged worker, a
					// zip stream that never finishes. Left unbounded, one of them burns the whole lane budget
					// and the harness kill lands mid-write, orphaning the very lease this lane is serialised
					// to protect. Each stage therefore races a timer that names it, so a stall fails in
					// seconds, says which stage, and unwinds through the scratch-directory teardown.
					function withTimeout<T>(stage: string, ms: number, work: Promise<T>): Promise<T> {
						let timer: ReturnType<typeof setTimeout> | undefined

						return Promise.race([
							work,
							new Promise<never>((_, reject) => {
								timer = setTimeout(() => {
									reject(new Error(`${stage} timed out after ${String(ms)}ms`))
								}, ms)
							})
						]).finally(() => {
							clearTimeout(timer)
						})
					}

					// allSettled, not all: if one upload succeeds and the other rejects, the check below must
					// still see which one landed rather than an opaque Promise.all rejection.
					const created = await Promise.allSettled([
						withTimeout(
							"upload a",
							uploadTimeoutMs,
							hooks.createTestFile(`e2e-sw-zip-a-${crypto.randomUUID()}.txt`, "filen sw zip e2e file a", parentUuid)
						),
						withTimeout(
							"upload b",
							uploadTimeoutMs,
							hooks.createTestFile(`e2e-sw-zip-b-${crypto.randomUUID()}.txt`, "filen sw zip e2e file b", parentUuid)
						)
					])

					const [a, b] = created

					if (a.status !== "fulfilled" || b.status !== "fulfilled") {
						// The reasons carry the stage names above — without them an upload that timed out and
						// one the account rejected report the same sentence.
						const reasons = created.flatMap(outcome => (outcome.status === "rejected" ? [String(outcome.reason)] : []))

						throw new Error(`test file creation failed: ${reasons.join("; ")}`)
					}

					const fileA = a.value
					const fileB = b.value

					// Bounded like every other stage: a registration that never activates otherwise hangs
					// here until the harness kills the test mid-write, orphaning the lease the uploads
					// above took.
					const registration = await withTimeout("service worker ready", ackTimeoutMs, navigator.serviceWorker.ready)

					if (registration.active === null) {
						throw new Error("no active service worker")
					}

					// Reassigned to a fresh, non-null-typed const: a nested closure doesn't retain the
					// null-check narrowing above on the original `registration.active` access.
					const activeWorker: ServiceWorker = registration.active

					// Mirrors saveDownload.ts's own sendToSw: one MessageChannel round trip, the same
					// SW_REQUEST_TIMEOUT_MS reject, and port1 closed on every outcome — without the timer a
					// lost ack is indistinguishable from a slow one and hangs until the harness kills the
					// test mid-write. A {ok:false} ack resolves rather than rejects, so each call site below
					// keeps reporting the worker's own error string.
					function send(type: string, payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
						return new Promise((resolve, reject) => {
							const channel = new MessageChannel()
							const timer = setTimeout(() => {
								channel.port1.close()
								reject(new Error(`${type} ack timed out after ${String(ackTimeoutMs)}ms`))
							}, ackTimeoutMs)

							channel.port1.onmessage = (event: MessageEvent<{ ok: boolean; error?: string }>) => {
								clearTimeout(timer)
								channel.port1.close()
								resolve(event.data)
							}

							activeWorker.postMessage({ type, ...payload }, [channel.port2])
						})
					}

					// Not bounded like the stages around it: a wasm serialize behind one worker round trip,
					// no network call, and the uploads above already proved that worker responsive.
					const blob = await hooks.rawStringifiedClient()
					const initAck = await send(initType, { blob })

					if (!initAck.ok) {
						throw new Error(`init failed: ${initAck.error ?? "unknown"}`)
					}

					const id = crypto.randomUUID()
					const registerAck = await send(registerType, { id, items: [fileA, fileB], name: "e2e.zip" })

					if (!registerAck.ok) {
						throw new Error(`register failed: ${registerAck.error ?? "unknown"}`)
					}

					// A plain fetch (never `<a download>`) mirrors the real page's own navigation trigger —
					// the SW answers both identically (see saveDownload.ts's own triggerSwDownload comment).
					// Headers and body are pinned separately: a worker that never answers and a zip stream
					// that stalls halfway are different failures.
					const res = await withTimeout("zip response headers", responseTimeoutMs, fetch(`${prefix}${id}`))
					const buf = new Uint8Array(await withTimeout("zip body stream", responseTimeoutMs, res.arrayBuffer()))

					// The same message sign-out's wipe-service-worker phase sends (performLogout.ts wires it to
					// saveDownload.ts's wipeSwClient): the worker frees its reconstructed Client and drops
					// every pending download, so the id registered above must stop resolving. That 404 is the
					// only end-to-end proof anywhere that no decrypted key material survives sign-out inside
					// the worker.
					const logoutAck = await send(logoutType, {})
					const afterLogout = await withTimeout("post-logout re-fetch", responseTimeoutMs, fetch(`${prefix}${id}`))

					return {
						status: res.status,
						contentType: res.headers.get("Content-Type"),
						contentDisposition: res.headers.get("Content-Disposition"),
						contentLength: res.headers.get("Content-Length"),
						acceptRanges: res.headers.get("Accept-Ranges"),
						bodyLength: buf.length,
						magic: Array.from(buf.slice(0, 4)),
						logoutAck,
						afterLogoutStatus: afterLogout.status
					}
				},
				{
					initType: SW_MSG_INIT_CLIENT,
					registerType: SW_MSG_REGISTER_ZIP_DOWNLOAD,
					logoutType: SW_MSG_LOGOUT,
					prefix: SW_DOWNLOAD_PREFIX,
					parentUuid: scratchUuid,
					ackTimeoutMs: SW_ACK_TIMEOUT_MS,
					uploadTimeoutMs: LIVE_WRITE_TIMEOUT_MS,
					responseTimeoutMs: SW_RESPONSE_TIMEOUT_MS
				}
			)

			// managed_future: {} (both ManagedFuture fields serde-default) deserialized and the live SDK
			// produced a real archive — a genuine end-to-end zip, not just a registration ack.
			expect(result.status).toBe(200)
			expect(result.contentType).toBe("application/zip")
			expect(result.contentDisposition).toBe('attachment; filename="e2e.zip"')
			expect(result.contentLength).toBeNull()
			expect(result.acceptRanges).toBeNull()
			expect(result.bodyLength).toBeGreaterThan(0)
			// ZIP local-file-header magic (PK\x03\x04) — proves a real, complete archive streamed through.
			expect(result.magic).toEqual([0x50, 0x4b, 0x03, 0x04])

			// A 404, not the 204 a navigation would get: fetch() issues a cors-mode request, and the
			// worker's own handler branches on that (sw.ts's handleDownload).
			expect(result.logoutAck).toEqual({ ok: true })
			expect(result.afterLogoutStatus).toBe(404)
		} finally {
			await trashScratchDirectory(page, scratchName)
		}
	})
})
