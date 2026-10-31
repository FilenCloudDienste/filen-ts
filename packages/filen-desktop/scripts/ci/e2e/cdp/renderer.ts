import type { Browser, Page } from "playwright-core"
import { waitFor } from "../../support.ts"
import { listTargets } from "./inspector.ts"

// The app's page through playwright-core over --remote-debugging-port: the only way into 4.x, whose fuses remove
// --inspect (and so Playwright's own Electron launcher). No tracing: traces record typed values and request headers.

export interface Renderer {
	browser: Browser
	page: Page
}

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

	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${String(port)}`, { timeout: timeoutMs })
	const page = await waitFor(
		`a page at ${origin}`,
		timeoutMs,
		() =>
			browser
				.contexts()
				.flatMap(context => context.pages())
				.find(candidate => candidate.url().startsWith(origin)) ?? null,
		1000
	)

	return { browser, page }
}
