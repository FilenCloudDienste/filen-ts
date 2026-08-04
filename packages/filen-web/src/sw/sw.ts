/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope

import initSdk, {
	fromStringified,
	type Client as SwClient,
	type StringifiedClient as SwStringifiedClient,
	type AnyFile as SwAnyFile,
	type ZipItem as SwZipItem
} from "@filen/sdk-rs/service-worker/sdk-rs.js"
import {
	SW_PROTOCOL_VERSION,
	SW_SKIP_WAITING_MESSAGE,
	SW_DOWNLOAD_PREFIX,
	SW_MSG_INIT_CLIENT,
	SW_MSG_REGISTER_DOWNLOAD,
	SW_MSG_REGISTER_ZIP_DOWNLOAD,
	SW_MSG_REGISTER_PREVIEW,
	SW_ERROR_NO_CLIENT,
	SW_MSG_LOGOUT,
	isAllowedInlineContentType
} from "@/lib/sw/protocol"
import { PendingRegistry } from "@/lib/sw/pendingRegistry"
import { contentDispositionAttachment } from "@/lib/filename"

// ── SW-hosted trimmed SDK (single-threaded — no COI, no rayon pool) ─────────────────────────────
// Lazy: only fetch+compile the 2 MB wasm and reconstruct the Client when a session is handed over, so
// mere SW registration on every page load stays cheap. The StringifiedClient (decrypted key material)
// and the resolved AnyFile arrive ONLY via structured-clone postMessage — never a URL.
let sdkReady: Promise<void> | null = null
let swClient: SwClient | null = null

// Resolved downloads keyed by opaque token — the `/sw/download/<id>` route reads them. A discriminated
// union: a single file streams with Range/206 support, a zip is one non-seekable archive stream (no
// known size upfront, so no `size` field on that arm), and a preview is the same Range/206-capable
// single-file stream as "file" but served INLINE (no Content-Disposition) under an allowlisted
// Content-Type instead of a forced attachment/octet-stream.
interface PendingFileDownload {
	kind: "file"
	file: SwAnyFile
	name: string
	size: number
}
interface PendingZipDownload {
	kind: "zip"
	items: SwZipItem[]
	name: string
}
interface PendingPreviewDownload {
	kind: "preview"
	file: SwAnyFile
	name: string
	size: number
	contentType: string
}
type PendingDownload = PendingFileDownload | PendingZipDownload | PendingPreviewDownload

// A generous concurrent-download ceiling — bounded retention is the only guard against unbounded growth
// of decrypted key material across the SW's lifetime (no page-side signal ever says a download
// finished, by design — see the registration handlers below). The registry's own eviction policy keeps
// entries that are still being read; its in-flight count also guards SKIP_WAITING, since activating an
// update through a running save would truncate that download.
const MAX_PENDING_DOWNLOADS = 32
const downloads = new PendingRegistry<PendingDownload>(MAX_PENDING_DOWNLOADS)

function ensureSdkInit(): Promise<void> {
	sdkReady ??= initSdk().then(() => undefined)
	return sdkReady
}

async function adoptSwClient(blob: SwStringifiedClient): Promise<void> {
	await ensureSdkInit()
	const next = fromStringified(blob)
	swClient?.free()
	swClient = next
}

// Parse a single-range `bytes=` header against the known total; null = unsatisfiable/absent.
function parseRange(header: string, total: number): { start: number; end: number } | null {
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
	if (match === null) {
		return null
	}
	const startStr = match[1] ?? ""
	const endStr = match[2] ?? ""
	if (startStr === "" && endStr === "") {
		return null
	}
	let start: number
	let end: number
	if (startStr === "") {
		const suffix = Number(endStr)
		if (suffix <= 0) {
			return null
		}
		start = Math.max(0, total - suffix)
		end = total - 1
	} else {
		start = Number(startStr)
		end = endStr === "" ? total - 1 : Number(endStr)
	}
	if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end >= total) {
		return null
	}
	return { start, end }
}

// Zip branch: a freshly-generated archive is non-seekable, so any Range header is IGNORED — this
// always answers a plain 200 with the full stream (standard behavior for a resource that doesn't
// support range requests), never Content-Length/Accept-Ranges (the total size isn't known upfront
// either). Otherwise mirrors the file branch's streaming/failure contract exactly.
function handleZipDownload(event: FetchEvent, id: string, pending: PendingZipDownload, client: SwClient): Response {
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()

	// Build the Response BEFORE counting the stream: constructing it validates every header value as a
	// ByteString and can throw synchronously — counting first would leave the in-flight count stuck above
	// zero (the pump below never runs its finally), permanently gating SKIP_WAITING so the SW could never
	// activate an update.
	const response = new Response(readable, {
		status: 200,
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": contentDispositionAttachment(pending.name),
			"X-Content-Type-Options": "nosniff"
		}
	})

	downloads.beginStream(id)
	// On failure, abort the writable so the Response readable ERRORS (never hangs) — same contract as
	// the file branch. progress is a no-op: nothing page-side reads it, the browser's own download manager
	// owns the save from here. This route carries no Content-Length (a generated archive's total isn't
	// known), so a truncated body looks like a COMPLETE download — hence waitUntil, see below.
	event.waitUntil(
		(async () => {
			try {
				await client.downloadItemsToZip(pending.items, writable, () => undefined, {})
			} catch {
				await writable.abort().catch(() => undefined)
			} finally {
				downloads.endStream(id)
			}
		})()
	)

	return response
}

// Shared by the "file" (forced attachment) and "preview" (inline) kinds below — both are single-file,
// Range/206-capable streams that only ever differ in which headers they answer with. `disposition:
// null` omits Content-Disposition entirely (the preview route's inline contract); a non-null string
// is used verbatim (the file route's attachment, or a preview that failed its own Content-Type
// re-validation and fell back to one). `sandbox: true` adds a maximally-restrictive
// Content-Security-Policy: sandbox response header (scripts/forms/popups/same-origin all disabled) —
// inert for the intended <video>/<audio>/<img> SUBRESOURCE use (a CSP header only ever governs a
// response loaded as its own browsing context/document, never a media/image fetch), but it closes off
// a direct-navigation edge case: an allowlisted image/svg+xml response, if a URL is copied out of the
// app and navigated to directly rather than embedded, could otherwise execute an embedded <script> as
// a full document with no CSP of its own to stop it.
function streamFileRange(
	event: FetchEvent,
	id: string,
	pending: { file: SwAnyFile; size: number },
	client: SwClient,
	headers: { contentType: string; disposition: string | null; sandbox?: boolean }
): Response {
	const total = pending.size
	const rangeHeader = event.request.headers.get("Range")
	const range = rangeHeader !== null ? parseRange(rangeHeader, total) : null
	if (rangeHeader !== null && range === null) {
		return new Response("range not satisfiable", { status: 416, headers: { "Content-Range": `bytes */${String(total)}` } })
	}

	const start = range?.start ?? 0
	const end = range?.end ?? total - 1
	const length = end - start + 1

	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()

	const responseHeaders: Record<string, string> = {
		"Content-Type": headers.contentType,
		"X-Content-Type-Options": "nosniff"
	}
	if (headers.disposition !== null) {
		responseHeaders["Content-Disposition"] = headers.disposition
	}
	if (headers.sandbox === true) {
		responseHeaders["Content-Security-Policy"] = "sandbox"
	}

	// Build the Response BEFORE counting the stream and starting the pump: header-value validation (a
	// Content-Disposition that isn't a legal ByteString) throws synchronously here, and counting first
	// would leave the in-flight count stuck above zero (the pump's finally never runs because nothing
	// consumes the readable), permanently gating SKIP_WAITING.
	let response: Response
	if (range !== null) {
		responseHeaders["Content-Range"] = `bytes ${String(start)}-${String(end)}/${String(total)}`
		responseHeaders["Content-Length"] = String(length)
		response = new Response(readable, { status: 206, headers: responseHeaders })
	} else {
		responseHeaders["Content-Length"] = String(total)
		responseHeaders["Accept-Ranges"] = "bytes"
		response = new Response(readable, { status: 200, headers: responseHeaders })
	}

	downloads.beginStream(id)
	// Stream the decrypted bytes straight into the Response body's writable end. `end` is EXCLUSIVE on
	// the SDK's `{start,end}` (Rust range convention) — an HTTP inclusive `bytes=0-99` maps to
	// `{start:0,end:100}`. On failure, abort the writable so the Response readable ERRORS (never hangs).
	// The id is NOT evicted on GET — Safari probes a range then re-fetches, so a download must survive
	// repeated GETs. There is no page-side completion signal either, so nothing ever evicts it on
	// finish — retention is bounded instead (PendingRegistry), which still respects Safari's
	// repeated-GET need for any recent entry.
	//
	// waitUntil is what keeps this worker alive for the pump: respondWith gets an already-resolved
	// Response, so the fetch event itself settles immediately and an idle worker is terminated
	// (spec-permitted, ~30 s in Firefox) straight through a running download — which the page cannot
	// observe, having handed the save off to the browser. Browsers cap that extension (~5 min), so this
	// bounds the exposure rather than removing it.
	event.waitUntil(
		(async () => {
			try {
				await client.downloadFileToWriter({
					file: pending.file,
					writer: writable,
					// progress is REQUIRED at runtime despite `progress?:` in the .d.ts (omitting it rejects the
					// wasm call mid-stream — same gotcha as the streaming upload).
					progress: () => undefined,
					...(range !== null ? { start: BigInt(start), end: BigInt(end + 1) } : {})
				})
			} catch {
				await writable.abort().catch(() => undefined)
			} finally {
				downloads.endStream(id)
			}
		})()
	)

	return response
}

// A forced-attachment octet-stream response — the "file" kind's own contract, and the fallback a
// "preview" kind takes when its contentType fails the SW's own re-validation.
function attachmentHeaders(name: string): { contentType: string; disposition: string } {
	return { contentType: "application/octet-stream", disposition: contentDispositionAttachment(name) }
}

function handleDownload(event: FetchEvent, url: URL): Response {
	const id = decodeURIComponent(url.pathname.slice(SW_DOWNLOAD_PREFIX.length))
	const pending = downloads.get(id)
	const client = swClient
	if (pending === undefined || client === null) {
		// The download trigger is a top-level NAVIGATION, so answering it with a body would commit that
		// body as the new document and destroy the running app. 204 abandons the navigation instead,
		// leaving the page untouched (the registration itself self-heals page-side, see SW_ERROR_NO_CLIENT).
		// Anything else — a media element's range fetch — gets the plain 404 its error handling expects.
		return event.request.mode === "navigate" ? new Response(null, { status: 204 }) : new Response("download not found", { status: 404 })
	}

	if (pending.kind === "zip") {
		return handleZipDownload(event, id, pending, client)
	}

	if (pending.kind === "file") {
		return streamFileRange(event, id, pending, client, attachmentHeaders(pending.name))
	}

	// "preview": defense-in-depth re-validation — never trust the page's own registration call alone.
	// An unrecognized contentType degrades to the same forced-attachment response as a plain file
	// download rather than ever serving an unvalidated Content-Type inline.
	if (!isAllowedInlineContentType(pending.contentType)) {
		return streamFileRange(event, id, pending, client, attachmentHeaders(pending.name))
	}

	return streamFileRange(event, id, pending, client, { contentType: pending.contentType, disposition: null, sandbox: true })
}

// A registration is only worth anything with a session Client to stream it: an idle-terminated worker
// restarts with every module global empty, so acking ok there would hand the page a token that can only
// 404 later. Reporting it lets the page re-hand the session over and retry (registerWithSw).
function hasClient(port: MessagePort | null): boolean {
	if (swClient !== null) {
		return true
	}

	port?.postMessage({ ok: false, error: SW_ERROR_NO_CLIENT })

	return false
}

// Update policy: no skipWaiting at install — a new worker stays in "waiting" until the page confirms
// the update prompt (register.ts's applyUpdate posts this message), so activation never interrupts
// whatever the currently-controlling worker is already doing. Hence: no install handler at all.
self.addEventListener("message", (event: ExtendableMessageEvent) => {
	const data = event.data as { type?: string } | null
	const type = data?.type

	if (type === SW_SKIP_WAITING_MESSAGE) {
		// Never truncate a running save — only honor the update switch when no stream is in flight.
		if (downloads.activeStreams === 0) {
			void self.skipWaiting()
		}
		return
	}

	const port = event.ports[0] ?? null

	if (type === SW_MSG_INIT_CLIENT) {
		const blob = (event.data as { blob: SwStringifiedClient }).blob
		void adoptSwClient(blob).then(
			() => port?.postMessage({ ok: true }),
			(e: unknown) => port?.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) })
		)
		return
	}

	if (type === SW_MSG_REGISTER_DOWNLOAD) {
		if (!hasClient(port)) {
			return
		}
		const msg = event.data as { id: string; file: SwAnyFile; name: string; size: number }
		downloads.set(msg.id, { kind: "file", file: msg.file, name: msg.name, size: msg.size })
		port?.postMessage({ ok: true })
		return
	}

	if (type === SW_MSG_REGISTER_ZIP_DOWNLOAD) {
		if (!hasClient(port)) {
			return
		}
		const msg = event.data as { id: string; items: SwZipItem[]; name: string }
		downloads.set(msg.id, { kind: "zip", items: msg.items, name: msg.name })
		port?.postMessage({ ok: true })
		return
	}

	if (type === SW_MSG_REGISTER_PREVIEW) {
		if (!hasClient(port)) {
			return
		}
		const msg = event.data as { id: string; file: SwAnyFile; name: string; size: number; contentType: string }
		downloads.set(msg.id, {
			kind: "preview",
			file: msg.file,
			name: msg.name,
			size: msg.size,
			contentType: msg.contentType
		})
		port?.postMessage({ ok: true })
		return
	}

	if (type === SW_MSG_LOGOUT) {
		// Logout must leave no decrypted key material resident in the worker: free the reconstructed
		// Client and drop every pending download (each holds a decrypted AnyFile/ZipItem). The page sends
		// this before its reload; the SW keeps running independently of that navigation, so the wipe
		// lands regardless of reload timing.
		swClient?.free()
		swClient = null
		downloads.clear()
		port?.postMessage({ ok: true })
	}
})

self.addEventListener("activate", event => {
	event.waitUntil(self.clients.claim())
})

self.addEventListener("fetch", event => {
	const url = new URL(event.request.url)

	// Scope to a same-origin GET: a controlled client's cross-origin requests also route through this
	// worker, and only our own origin's GET should ever receive a synthetic response.
	if (url.origin !== self.location.origin || event.request.method !== "GET") {
		return
	}

	if (url.pathname === "/__sw/version") {
		event.respondWith(new Response(JSON.stringify({ v: SW_PROTOCOL_VERSION }), { headers: { "Content-Type": "application/json" } }))
		return
	}

	// A plain navigation to this route (NOT an `<a download>` — the download attribute makes the browser
	// fetch via its download manager, bypassing the SW) is intercepted here; the attachment response
	// turns it into the file save. A `<video>`/`<audio>`/`<img src>` subresource fetch (never a
	// navigation) and its own Range probes/seeks hit the same handler and the same route prefix — only
	// the registered PendingDownload's own `kind` decides attachment vs. inline.
	if (url.pathname.startsWith(SW_DOWNLOAD_PREFIX)) {
		event.respondWith(handleDownload(event, url))
	}
})
