import type { BrowserContext, Request } from "@playwright/test"
import { FILEN_DOMAINS } from "../../vite/filenHosts"
import { e2eBaseUrl } from "../baseUrl"

// Network observers over a whole context: the page, its frames and its workers (all three engines report a
// dedicated worker's requests to the context; Chromium reports a service worker's too).

// Resource types the page draws or plays.
const PAINTED_TYPES: ReadonlySet<string> = new Set(["image", "stylesheet", "font", "media"])

function isFilenHost(hostname: string): boolean {
	return FILEN_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
}

function isFamilyHost(hostname: string, subdomain: string): boolean {
	return FILEN_DOMAINS.some(domain => hostname === `${subdomain}.${domain}`)
}

// Network URLs only: data:, blob: and about: never leave the browser.
function networkUrl(request: Request): URL | null {
	const url = URL.parse(request.url())

	return url !== null && (url.protocol === "https:" || url.protocol === "http:") ? url : null
}

// A request the page's or a frame's Content Security Policy refused: never sent. Chromium still reports it as a request,
// then fails it with this reason; Firefox and WebKit report none.
const CSP_BLOCKED = /^csp$|ERR_BLOCKED_BY_CSP|content security policy/i

// Collects every request that leaves the app's own origin and Filen's hosts, as "<resource type> <url>"; the array
// fills in place, so assert it once the flow is done: `expect(foreign).toEqual([])`. strictPreview also collects any
// image, stylesheet, font or media request to another origin, Filen's CDN and egest included: a preview draws its
// pictures from bytes it already holds. The SDK's own downloads are fetches from its worker and stay out of it. A
// request a Content Security Policy blocked never left the browser and is taken out again once it fails so.
export function trackForeignRequests(context: BrowserContext, { strictPreview }: { strictPreview: boolean }): string[] {
	const appOrigin = new URL(e2eBaseUrl()).origin
	const foreign: string[] = []
	const tracked: Request[] = []

	context.on("request", request => {
		const url = networkUrl(request)

		if (url === null || url.origin === appOrigin) {
			return
		}

		if (!isFilenHost(url.hostname) || (strictPreview && PAINTED_TYPES.has(request.resourceType()))) {
			foreign.push(`${request.resourceType()} ${url.href}`)
			tracked.push(request)
		}
	})
	context.on("requestfailed", request => {
		const index = tracked.indexOf(request)

		if (index !== -1 && CSP_BLOCKED.test(request.failure()?.errorText ?? "")) {
			foreign.splice(index, 1)
			tracked.splice(index, 1)
		}
	})

	return foreign
}

export interface EgestObserver {
	// Chunk requests to the egest hosts since the start or the last reset().
	requests: () => number
	// Their response body bytes, once every finished one is measured.
	bytes: () => Promise<number>
	reset: () => void
}

// A response's body size on the wire, or its Content-Length where the engine reports no sizes for it.
async function responseBytes(request: Request): Promise<number> {
	const sizes = await request.sizes().catch(() => null)

	if (sizes !== null && sizes.responseBodySize >= 0) {
		return sizes.responseBodySize
	}

	const length = Number((await request.response())?.headers()["content-length"])

	if (!Number.isFinite(length)) {
		throw new Error(`observeEgest: no size for ${request.url()}`)
	}

	return length
}

// Counts the download requests to the egest host family, and the bytes they carried: the positive control for
// "nothing was downloaded" and the measure of a ranged read.
export function observeEgest(context: BrowserContext): EgestObserver {
	let requests = 0
	let measured: Promise<number>[] = []
	const isEgest = (request: Request): boolean => {
		const url = networkUrl(request)

		return url !== null && isFamilyHost(url.hostname, "egest")
	}

	context.on("request", request => {
		if (isEgest(request)) {
			requests++
		}
	})
	context.on("requestfinished", request => {
		if (isEgest(request)) {
			const size = responseBytes(request)

			// Handled here too, so a size nobody asks for never surfaces as an unhandled rejection.
			size.catch(() => undefined)
			measured.push(size)
		}
	})

	return {
		requests: () => requests,
		bytes: async () => (await Promise.all(measured)).reduce((sum, size) => sum + size, 0),
		reset: () => {
			requests = 0
			measured = []
		}
	}
}
