/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope

import initSdk, {
	fromStringified,
	type Client as SwClient,
	type StringifiedClient as SwStringifiedClient,
	type AnyFile as SwAnyFile,
	type AnyItemWithContext as SwZipItem
} from "@filen/sdk-rs/service-worker/sdk-rs.js"
import {
	SW_PROTOCOL_VERSION,
	SW_SKIP_WAITING_MESSAGE,
	SW_MSG_BUILD,
	SW_DOWNLOAD_PREFIX,
	SW_MSG_INIT_CLIENT,
	SW_MSG_REGISTER_DOWNLOAD,
	SW_MSG_REGISTER_ZIP_DOWNLOAD,
	SW_MSG_REGISTER_PREVIEW,
	SW_ERROR_NO_CLIENT,
	SW_MSG_LOGOUT,
	SW_MSG_WATCH_DOWNLOAD,
	SW_MSG_CANCEL_DOWNLOAD,
	SW_MSG_KEEPALIVE,
	isAllowedInlineContentType
} from "@/lib/sw/protocol"
import { PendingRegistry } from "@/lib/sw/pendingRegistry"
import { DownloadReporter, type ReportedStream } from "@/lib/sw/downloadReporter"
import { plainErrorDTO, toErrorDTO } from "@/lib/sdk/errors"
import { contentDispositionAttachment } from "@/lib/filename"
import { log } from "@/lib/log"
import { parseRange, previewPieceEnd } from "@/sw/range"

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
// How each attachment download ended, for the page that started it (downloadReporter.ts).
const reporter = new DownloadReporter(MAX_PENDING_DOWNLOADS)

function ensureSdkInit(): Promise<void> {
	sdkReady ??= initSdk().then(() => undefined)
	return sdkReady
}

// One worker serves every tab of the origin, so a handover (another tab's or a reloaded tab's INIT_CLIENT)
// or a logout can replace the Client while a stream still borrows it. Freeing it then either throws
// (leaving a dead Client installed and every later stream failing) or cuts the running stream off, so a
// replaced Client is only retired, and freed once its last stream ends.
const clientStreams = new Map<SwClient, number>()
const retiredClients = new Set<SwClient>()
// Bumped by every logout, so an adoption suspended across one cannot reinstall the logged-out session.
let logoutEpoch = 0

function freeClient(client: SwClient): void {
	try {
		client.free()
	} catch (e) {
		log.error("sw", "freeing a Client failed", e)
	}
}

function retireClient(client: SwClient | null): void {
	if (client === null) {
		return
	}

	if (clientStreams.has(client)) {
		retiredClients.add(client)
	} else {
		freeClient(client)
	}
}

function retainClient(client: SwClient): void {
	clientStreams.set(client, (clientStreams.get(client) ?? 0) + 1)
}

function releaseClient(client: SwClient): void {
	const remaining = (clientStreams.get(client) ?? 1) - 1

	if (remaining > 0) {
		clientStreams.set(client, remaining)

		return
	}

	clientStreams.delete(client)

	if (retiredClients.delete(client)) {
		freeClient(client)
	}
}

async function adoptSwClient(blob: SwStringifiedClient): Promise<void> {
	const epoch = logoutEpoch

	await ensureSdkInit()

	if (epoch !== logoutEpoch) {
		throw new Error("logged out during the session handover")
	}

	const previous = swClient

	swClient = fromStringified(blob)
	retireClient(previous)
}

// A watched download's Response body: the TransformStream's readable, passed through so the worker sees
// the browser cancel it (the user aborting in the browser's download UI), and can fail it at once when
// the page cancels instead of waiting for the SDK's next write to notice.
function watchedBody(readable: ReadableStream<Uint8Array>): {
	body: ReadableStream<Uint8Array>
	cancelledByBrowser: () => boolean
	fail: (reason: unknown) => void
} {
	const reader = readable.getReader()
	let cancelled = false
	let control: ReadableStreamDefaultController<Uint8Array> | null = null

	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				control = controller
			},
			async pull(controller) {
				const { done, value } = await reader.read()

				if (done) {
					controller.close()
				} else {
					controller.enqueue(value)
				}
			},
			cancel(reason) {
				cancelled = true

				return reader.cancel(reason)
			}
		},
		{ highWaterMark: 0 }
	)

	return {
		body,
		cancelledByBrowser: () => cancelled,
		fail: reason => {
			try {
				control?.error(reason)
			} catch {
				// Already closed or errored.
			}

			// Errors the writable the SDK writes into, so it stops too.
			reader.cancel(reason).catch(() => undefined)
		}
	}
}

// The outcome a failed watched stream reports: a cancel from either side is not a failure to show.
function failedOutcome(e: unknown, cancelled: boolean): { type: "failed"; error: ReturnType<typeof toErrorDTO> } {
	return { type: "failed", error: cancelled ? plainErrorDTO("download cancelled", "Cancelled") : toErrorDTO(e) }
}

// Pumps `run` into a Response the caller has ALREADY built: constructing it validates every header value
// as a ByteString and can throw synchronously, and counting the stream first would leave the in-flight
// count stuck above zero (the finally never runs because nothing consumes the readable), permanently
// gating SKIP_WAITING so the SW could never activate an update. On failure the writable is aborted so the
// Response readable ERRORS (never hangs).
//
// waitUntil is what keeps this worker alive for the pump: respondWith gets an already-resolved Response,
// so the fetch event itself settles immediately and an idle worker is terminated (spec-permitted, ~30 s in
// Firefox) straight through a running download — which the page cannot observe, having handed the save
// off to the browser. Browsers cap that extension (Firefox at about a minute past the last event): a
// watched download's page sends SW_MSG_KEEPALIVE events for as long as it streams, and a media preview's
// pieces each bring a fresh fetch event.
function pumpToResponse(
	event: FetchEvent,
	id: string,
	client: SwClient,
	writable: WritableStream<Uint8Array>,
	run: () => Promise<void>,
	watch: { stream: ReportedStream; cancelledByBrowser: () => boolean } | null = null
): void {
	downloads.beginStream(id)
	retainClient(client)
	event.waitUntil(
		(async () => {
			try {
				await run()
				watch?.stream.end({ type: "done" })
			} catch (e) {
				await writable.abort().catch(() => undefined)
				watch?.stream.end(failedOutcome(e, watch.stream.cancelRequested || watch.cancelledByBrowser()))
			} finally {
				downloads.endStream(id)
				releaseClient(client)
			}
		})()
	)
}

// Zip branch: a freshly-generated archive is non-seekable, so any Range header is IGNORED — this
// always answers a plain 200 with the full stream (standard behavior for a resource that doesn't
// support range requests), never Content-Length/Accept-Ranges (the total size isn't known upfront
// either). Otherwise mirrors the file branch's streaming/failure contract exactly.
function handleZipDownload(event: FetchEvent, id: string, pending: PendingZipDownload, client: SwClient): Response {
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
	const watched = watchedBody(readable)

	// Built BEFORE pumpToResponse counts the stream (see there).
	const response = new Response(watched.body, {
		status: 200,
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": contentDispositionAttachment(pending.name),
			"X-Content-Type-Options": "nosniff"
		}
	})

	// This route carries no Content-Length (a generated archive's total isn't known), so a truncated body
	// looks like a COMPLETE download to the browser — which is why the pump's waitUntil matters here, and
	// why the page hears the outcome from the reporter rather than from the browser.
	const stream = reporter.begin(id)

	stream.onCancelRequest(() => {
		watched.fail(new Error("download cancelled"))
	})
	pumpToResponse(
		event,
		id,
		client,
		writable,
		() =>
			client.downloadItemsToZip(
				pending.items,
				writable,
				(bytesWritten, totalBytes) => {
					stream.progress(Number(bytesWritten), Number(totalBytes))
				},
				{}
			),
		{ stream, cancelledByBrowser: watched.cancelledByBrowser }
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
// a full document with no CSP of its own to stop it. `pieced` answers an open-ended range with one
// PREVIEW_PIECE_BYTES piece: for inline media only, since a saved file must stay one whole stream.
function streamFileRange(
	event: FetchEvent,
	id: string,
	pending: { file: SwAnyFile; size: number },
	client: SwClient,
	headers: { contentType: string; disposition: string | null; sandbox?: boolean },
	reported: boolean,
	pieced = false
): Response {
	const total = pending.size
	const rangeHeader = event.request.headers.get("Range")
	const range = rangeHeader !== null ? parseRange(rangeHeader, total) : null
	if (rangeHeader !== null && range === null) {
		return new Response("range not satisfiable", { status: 416, headers: { "Content-Range": `bytes */${String(total)}` } })
	}

	const start = range?.start ?? 0
	const end = range === null ? total - 1 : pieced && range.openEnded ? previewPieceEnd(range.start, range.end) : range.end
	const length = end - start + 1

	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
	// Only the whole file is the download; a ranged request is a probe or a seek.
	const watched = reported && start === 0 && end === total - 1 ? watchedBody(readable) : null
	const body = watched?.body ?? readable

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

	// Built BEFORE pumpToResponse counts the stream (see there).
	let response: Response
	if (range !== null) {
		responseHeaders["Content-Range"] = `bytes ${String(start)}-${String(end)}/${String(total)}`
		responseHeaders["Content-Length"] = String(length)
		response = new Response(body, { status: 206, headers: responseHeaders })
	} else {
		responseHeaders["Content-Length"] = String(total)
		responseHeaders["Accept-Ranges"] = "bytes"
		response = new Response(body, { status: 200, headers: responseHeaders })
	}

	// Stream the decrypted bytes straight into the Response body's writable end. `end` is EXCLUSIVE on
	// the SDK's `{start,end}` (Rust range convention) — an HTTP inclusive `bytes=0-99` maps to
	// `{start:0,end:100}`. The id is NOT evicted on GET — Safari probes a range then re-fetches, so a
	// download must survive repeated GETs. There is no page-side completion signal either, so nothing
	// ever evicts it on finish — retention is bounded instead (PendingRegistry), which still respects
	// Safari's repeated-GET need for any recent entry.
	const stream = watched === null ? null : reporter.begin(id)

	if (watched !== null && stream !== null) {
		stream.onCancelRequest(() => {
			watched.fail(new Error("download cancelled"))
		})
	}

	pumpToResponse(
		event,
		id,
		client,
		writable,
		() =>
			client.downloadFileToWriter({
				file: pending.file,
				writer: writable,
				// progress is REQUIRED at runtime despite `progress?:` in the .d.ts (omitting it rejects the
				// wasm call mid-stream — same gotcha as the streaming upload).
				progress: bytes => {
					stream?.progress(Number(bytes), total)
				},
				...(range !== null ? { start: BigInt(start), end: BigInt(end + 1) } : {})
			}),
		watched === null || stream === null ? null : { stream, cancelledByBrowser: watched.cancelledByBrowser }
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
		return streamFileRange(event, id, pending, client, attachmentHeaders(pending.name), true)
	}

	// "preview": defense-in-depth re-validation — never trust the page's own registration call alone.
	// An unrecognized contentType degrades to the same forced-attachment response as a plain file
	// download rather than ever serving an unvalidated Content-Type inline.
	if (!isAllowedInlineContentType(pending.contentType)) {
		return streamFileRange(event, id, pending, client, attachmentHeaders(pending.name), false)
	}

	return streamFileRange(event, id, pending, client, { contentType: pending.contentType, disposition: null, sandbox: true }, false, true)
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

	// Receiving it is the whole point (see SW_MSG_KEEPALIVE).
	if (type === SW_MSG_KEEPALIVE) {
		return
	}

	if (type === SW_SKIP_WAITING_MESSAGE) {
		// Never truncate a running save — only honor the update switch when no stream is in flight.
		if (downloads.activeStreams === 0) {
			void self.skipWaiting()
		}
		return
	}

	const port = event.ports[0] ?? null

	if (type === SW_MSG_BUILD) {
		port?.postMessage({ build: import.meta.env.VITE_BUILD_ID ?? null })
		return
	}

	if (type === SW_MSG_WATCH_DOWNLOAD) {
		const id = (event.data as { id: string }).id

		if (port !== null) {
			reporter.attach(id, port, downloads.get(id) !== undefined)
		}
		return
	}

	if (type === SW_MSG_CANCEL_DOWNLOAD) {
		reporter.cancel((event.data as { id: string }).id)
		return
	}

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
		// Client and drop every pending download (each holds a decrypted AnyFile/AnyItemWithContext). The
		// page sends this before its reload; the SW keeps running independently of that navigation, so the
		// wipe lands regardless of reload timing. A stream still running keeps its Client until it ends.
		const previous = swClient

		logoutEpoch++
		swClient = null
		downloads.clear()
		reporter.clear()
		retireClient(previous)
		port?.postMessage({ ok: true })
	}
})

// Claims the page that installed it without holding activation on the claim. Firefox cannot finish a claim
// while a page worker is blocked in Atomics.wait, which the SDK's idle wasm threads always are; waited on,
// the worker stays "activating" (about a minute, until Firefox kills it) and every fetch and worker load
// meanwhile, the SDK's included, waits on it.
self.addEventListener("activate", () => {
	void self.clients.claim()
})

self.addEventListener("fetch", event => {
	const url = new URL(event.request.url)

	// Scope to a same-origin GET: a controlled client's cross-origin requests also route through this
	// worker, and only our own origin's GET should ever receive a synthetic response.
	if (url.origin !== self.location.origin || event.request.method !== "GET") {
		return
	}

	if (url.pathname === "/__sw/version") {
		event.respondWith(
			new Response(JSON.stringify({ v: SW_PROTOCOL_VERSION, build: import.meta.env.VITE_BUILD_ID }), {
				headers: { "Content-Type": "application/json" }
			})
		)
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
