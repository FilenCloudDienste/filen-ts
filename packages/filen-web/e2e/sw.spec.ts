import type { Page } from "@playwright/test"
import { test, expect } from "./fixtures"
import { SW_DOWNLOAD_PREFIX, SW_MSG_INIT_CLIENT, SW_MSG_REGISTER_ZIP_DOWNLOAD, SW_PROTOCOL_VERSION } from "@/lib/sw/protocol"

// Polls the synthetic version endpoint until the worker has activated and claimed the page — the
// proven readiness signal both tests below build on.
async function waitForSwReady(page: Page): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate(async () => {
					try {
						const res = await fetch("/__sw/version")

						return res.ok ? ((await res.json()) as unknown) : null
					} catch {
						return null
					}
				}),
			{ timeout: 30_000 }
		)
		.toEqual({ v: SW_PROTOCOL_VERSION })
}

// Registration is PROD-only and gated on boot ready, so this runs against preview. webkit is excluded
// (not tagged @no-sdk) — its service-worker support under Playwright is unreliable.
test.describe("service worker", () => {
	test("registers and answers the version endpoint", async ({ page, browserName }) => {
		// Playwright-firefox's service-worker support under COI is unreliable (registration never
		// controls the page), so this is verified on chromium; webkit is excluded from the suite.
		test.skip(browserName === "firefox", "service workers are unreliable on Playwright-firefox under COI")

		await page.goto("/")

		// SW registration fires once the app reaches a ready shell.
		await expect(page.getByText("Sign in to Filen")).toBeVisible()

		await waitForSwReady(page)
	})

	// The zip flavor of the sw download route needs real, live-downloadable content and an
	// authenticated SW_MSG_INIT_CLIENT handshake, neither of which the anonymous test above needs.
	// Driven directly through the SW postMessage protocol (mirroring the version-endpoint probe's own
	// style) rather than through a real Download click: Chromium (the only engine this suite trusts
	// for service workers — see the skip above) always has the File System Access API, so a real click
	// would take the fsa branch and never reach the sw route under test here.
	test("registers a real 2-file selection and streams a valid zip response", async ({ page, injectedSession, browserName }) => {
		// Same root cause as the version-endpoint test's own skip (SW unreliable on Playwright-firefox
		// under COI) — this test additionally makes real authenticated worker calls (upload/trash),
		// which independently hang on Playwright-firefox under COI too (see boot.spec.ts).
		test.skip(
			browserName === "firefox",
			"service workers and authenticated worker calls are unreliable on Playwright-firefox under COI"
		)
		expect(injectedSession.length).toBeGreaterThan(0)

		await page.goto("/")
		// The authed shell only renders once the injected session resumed into the worker — hooks are
		// installed well before that, during early boot (mirrors boot.spec.ts's own authed-read test).
		await expect(page.getByRole("navigation", { name: "Filen" })).toBeVisible()
		await waitForSwReady(page)

		const result = await page.evaluate(
			async ({ initType, registerType, prefix }) => {
				const hooks = window.__filenE2E
				// allSettled, not all: if one upload succeeds and the other rejects, the finally below must
				// still see (and trash) the one that landed — Promise.all would reject past it.
				const created = await Promise.allSettled([
					hooks.createTestFile(`e2e-sw-zip-a-${crypto.randomUUID()}.txt`, "filen sw zip e2e file a"),
					hooks.createTestFile(`e2e-sw-zip-b-${crypto.randomUUID()}.txt`, "filen sw zip e2e file b")
				])

				try {
					const [a, b] = created

					if (a.status !== "fulfilled" || b.status !== "fulfilled") {
						throw new Error("test file creation failed")
					}

					const fileA = a.value
					const fileB = b.value

					const registration = await navigator.serviceWorker.ready

					if (registration.active === null) {
						throw new Error("no active service worker")
					}

					// Reassigned to a fresh, non-null-typed const: a nested closure doesn't retain the
					// null-check narrowing above on the original `registration.active` access.
					const activeWorker: ServiceWorker = registration.active

					// Mirrors save-download.ts's own sendToSw: one MessageChannel round trip, resolving on
					// the SW's single {ok}/{ok:false,error} ack.
					function send(type: string, payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
						return new Promise(resolve => {
							const channel = new MessageChannel()
							channel.port1.onmessage = (event: MessageEvent<{ ok: boolean; error?: string }>) => {
								resolve(event.data)
							}
							activeWorker.postMessage({ type, ...payload }, [channel.port2])
						})
					}

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
					// the SW answers both identically (see save-download.ts's own triggerSwDownload comment).
					const res = await fetch(`${prefix}${id}`)
					const buf = new Uint8Array(await res.arrayBuffer())

					return {
						status: res.status,
						contentType: res.headers.get("Content-Type"),
						contentDisposition: res.headers.get("Content-Disposition"),
						contentLength: res.headers.get("Content-Length"),
						acceptRanges: res.headers.get("Accept-Ranges"),
						bodyLength: buf.length,
						magic: Array.from(buf.slice(0, 4))
					}
				} finally {
					// Net-zero on the shared e2e account, mirroring uploads.spec.ts's own create -> act ->
					// trash convention — trashing exactly the files that were actually created.
					await Promise.all(created.flatMap(r => (r.status === "fulfilled" ? [hooks.trashTestFile(r.value)] : [])))
				}
			},
			{ initType: SW_MSG_INIT_CLIENT, registerType: SW_MSG_REGISTER_ZIP_DOWNLOAD, prefix: SW_DOWNLOAD_PREFIX }
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
	})
})
