// Runs only when no static asset matches (assets are served first) and the request is not a navigation:
// with `assets_navigation_prefers_asset_serving` (on by default since the 2025-04-01 compatibility date)
// a navigation gets the single-page-application fallback without invoking this script. So what reaches
// here is a subresource miss — typically an open tab from before a deploy asking for a worker file the
// new build no longer has. It must get a real 404: the index.html fallback would come back as a 200 under
// /assets/*, where _headers marks responses immutable, and the browser would keep that HTML for a year.
// A Workers runtime global: a stream whose response declares exactly this many bytes.
declare const FixedLengthStream: new (expectedLength: number) => TransformStream<Uint8Array, Uint8Array>

interface Env {
	ASSETS: { fetch(request: Request): Promise<Response> }
}

// The service worker serves /sw/ (src/lib/sw/protocol.ts's SW_DOWNLOAD_PREFIX); a request for it that
// reaches the server is one the service worker never saw, such as a browser download manager retrying a
// download (Firefox's retries bypass it). Firefox saves whatever body comes back, an error status
// included, so an empty 404 became a 0-byte "finished" file. A body that errors at once is a failed
// download in every browser.
function brokenDownload(): Response {
	// A body shorter than its declared length: the runtime can only cut the connection, which is what the
	// browser reports as a failed download (an error thrown from the body stream instead still ends the
	// response cleanly, as an empty file).
	const { readable, writable } = new FixedLengthStream(1)

	writable.close().catch(() => undefined)

	return new Response(readable, { status: 503, headers: { "Cache-Control": "no-store" } })
}

export default {
	fetch(request: Request, env: Env): Promise<Response> | Response {
		if (new URL(request.url).pathname.startsWith("/sw/")) {
			return brokenDownload()
		}

		// A browser that sends no Sec-Fetch-Mode (Safari before 16.4) lands here for every deep link, so
		// the fallback is repeated for what looks like a page load. "/" resolves to index.html, and
		// _headers still applies because the asset binding answers it.
		if (
			request.method === "GET" &&
			!request.headers.has("Sec-Fetch-Mode") &&
			(request.headers.get("Accept") ?? "").includes("text/html")
		) {
			return env.ASSETS.fetch(new Request(new URL("/", request.url), { headers: request.headers }))
		}

		return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } })
	}
}
