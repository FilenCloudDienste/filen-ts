import type { Browser, Page } from "playwright-core"
import { errorMessage, waitFor } from "../../support.ts"
import { listTargets } from "./inspector.ts"

// The app's page through playwright-core over --remote-debugging-port: the only way into 4.x, whose fuses remove
// --inspect (and so Playwright's own Electron launcher). No tracing: traces record typed values and request headers.

export interface Renderer {
	browser: Browser
	page: Page
}

const FIRST_CONNECT_MS = 60_000

// The first page whose URL starts with `origin` (filendesktop://bundle for 3.x, filen://app for 4.x).
// The port opens some time after the launch; connectOverCDP does not wait for it, so the endpoint is polled first.
export async function connectRenderer(port: number, origin: string, timeoutMs: number): Promise<Renderer> {
	const { chromium } = await import("playwright-core")

	await waitFor(
		`the debugging port ${String(port)} to answer`,
		timeoutMs,
		async () => ((await listTargets(port)) === null ? null : true),
		500
	)

	const endpoint = `http://127.0.0.1:${String(port)}`
	// Connecting takes seconds; one that stalls with the socket open (a target never answering the attach) is dropped
	// once and tried again, the targets it saw logged.
	const browser = await chromium.connectOverCDP(endpoint, { timeout: FIRST_CONNECT_MS }).catch(async (error: unknown) => {
		const targets = (await listTargets(port))?.map(target => `${target.type} ${target.url}`) ?? []

		console.log(`connectOverCDP stalled (${errorMessage(error).split("\n")[0] ?? ""}); targets: ${targets.join(", ") || "none"}; again`)

		return chromium.connectOverCDP(endpoint, { timeout: timeoutMs })
	})
	const page = await waitFor(
		`a page at ${origin}`,
		timeoutMs,
		() =>
			browser
				.contexts()
				.flatMap(context => context.pages())
				// 3.x on macOS also lists its launcher page, which goes away once the app's page is up.
				.find(candidate => candidate.url().startsWith(origin) && !candidate.url().includes("launcher")) ?? null,
		1000
	)

	return { browser, page }
}
