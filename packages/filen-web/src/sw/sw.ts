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
	SW_MSG_PING
} from "@/lib/sw/protocol"

// ── SW-hosted trimmed SDK (single-threaded — no COI, no rayon pool) ─────────────────────────────
// Lazy: only fetch+compile the 2 MB wasm and reconstruct the Client when a session is handed over, so
// mere SW registration on every page load stays cheap. The StringifiedClient (decrypted key material)
// and the resolved AnyFile arrive ONLY via structured-clone postMessage (D16 — never a URL).
let sdkReady: Promise<void> | null = null
let swClient: SwClient | null = null

// Resolved downloads keyed by opaque token — the `/sw/download/<id>` route reads them. A discriminated
// union: a single file streams with Range/206 support, a zip is one non-seekable archive stream (no
// known size upfront, so no `size` field on that arm).
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
type PendingDownload = PendingFileDownload | PendingZipDownload
const downloads = new Map<string, PendingDownload>()

// No page-side signal ever tells the SW a download finished (by design — see the registration
// handlers below): the id must also survive every GET (Safari probes a Range, then re-fetches), so
// eviction can't key off a GET either. Bounded retention is the only guard against unbounded growth of
// decrypted key material across the SW's lifetime — a generous concurrent-download ceiling, evicting
// the OLDEST entry (Map preserves insertion order) once a new registration pushes past it.
const MAX_PENDING_DOWNLOADS = 32

function registerPendingDownload(id: string, entry: PendingDownload): void {
	downloads.set(id, entry)

	if (downloads.size > MAX_PENDING_DOWNLOADS) {
		const oldest = downloads.keys().next().value

		if (oldest !== undefined) {
			downloads.delete(oldest)
		}
	}
}

// In-flight stream count — the SW must not skipWaiting() an update through a running save (it would
// truncate the download). Guards SKIP_WAITING.
let activeStreams = 0

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

// Strip anything that could break out of the quoted Content-Disposition filename or inject a header
// (the name is decrypted-but-attacker-controlled). RFC 5987 `filename*` encoding for non-ASCII is a
// later refinement; this keeps the ASCII fallback safe.
function sanitizeFilename(name: string): string {
	// eslint-disable-next-line no-control-regex -- deliberately stripping control chars from a filename
	return name.replace(/[\x00-\x1f"\\/\r\n]/g, "_") || "download"
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
function handleZipDownload(pending: PendingZipDownload, client: SwClient): Response {
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
	activeStreams++
	// On failure, abort the writable so the Response readable ERRORS (never hangs) — same contract as
	// the file branch. progress is a no-op: the page has already navigated away by the time this runs,
	// nothing reads it.
	void (async () => {
		try {
			await client.downloadItemsToZip(pending.items, writable, () => undefined, {})
		} catch {
			await writable.abort().catch(() => undefined)
		} finally {
			activeStreams--
		}
	})()

	return new Response(readable, {
		status: 200,
		headers: {
			"Content-Type": "application/zip",
			"Content-Disposition": `attachment; filename="${sanitizeFilename(pending.name)}"`,
			"X-Content-Type-Options": "nosniff"
		}
	})
}

function handleDownload(request: Request, url: URL): Response {
	const id = decodeURIComponent(url.pathname.slice(SW_DOWNLOAD_PREFIX.length))
	const pending = downloads.get(id)
	const client = swClient
	if (pending === undefined || client === null) {
		return new Response("download not found", { status: 404 })
	}

	if (pending.kind === "zip") {
		return handleZipDownload(pending, client)
	}

	const total = pending.size
	const rangeHeader = request.headers.get("Range")
	const range = rangeHeader !== null ? parseRange(rangeHeader, total) : null
	if (rangeHeader !== null && range === null) {
		return new Response("range not satisfiable", { status: 416, headers: { "Content-Range": `bytes */${String(total)}` } })
	}

	const start = range?.start ?? 0
	const end = range?.end ?? total - 1
	const length = end - start + 1

	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
	activeStreams++
	// Stream the decrypted bytes straight into the Response body's writable end. `end` is EXCLUSIVE on
	// the SDK's `{start,end}` (Rust range convention) — an HTTP inclusive `bytes=0-99` maps to
	// `{start:0,end:100}`. On failure, abort the writable so the Response readable ERRORS (never hangs).
	// The id is NOT evicted on GET — Safari probes a range then re-fetches, so a download must survive
	// repeated GETs. There is no page-side completion signal either, so nothing ever evicts it on
	// finish — retention is bounded instead (registerPendingDownload), which still respects Safari's
	// repeated-GET need for any recent entry.
	void (async () => {
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
			activeStreams--
		}
	})()

	const headers: Record<string, string> = {
		"Content-Type": "application/octet-stream",
		"Content-Disposition": `attachment; filename="${sanitizeFilename(pending.name)}"`,
		"X-Content-Type-Options": "nosniff"
	}
	if (range !== null) {
		headers["Content-Range"] = `bytes ${String(start)}-${String(end)}/${String(total)}`
		headers["Content-Length"] = String(length)
		return new Response(readable, { status: 206, headers })
	}
	headers["Content-Length"] = String(total)
	headers["Accept-Ranges"] = "bytes"
	return new Response(readable, { status: 200, headers })
}

// Update policy: no skipWaiting at install — a new worker stays in "waiting" until the page confirms
// the update prompt (register.ts's applyUpdate posts this message), so activation never interrupts
// whatever the currently-controlling worker is already doing. Hence: no install handler at all.
self.addEventListener("message", (event: ExtendableMessageEvent) => {
	const data = event.data as { type?: string } | null
	const type = data?.type

	if (type === SW_SKIP_WAITING_MESSAGE) {
		// Never truncate a running save — only honor the update switch when no stream is in flight.
		if (activeStreams === 0) {
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
		const msg = event.data as { id: string; file: SwAnyFile; name: string; size: number }
		registerPendingDownload(msg.id, { kind: "file", file: msg.file, name: msg.name, size: msg.size })
		port?.postMessage({ ok: true })
		return
	}

	if (type === SW_MSG_REGISTER_ZIP_DOWNLOAD) {
		const msg = event.data as { id: string; items: SwZipItem[]; name: string }
		registerPendingDownload(msg.id, { kind: "zip", items: msg.items, name: msg.name })
		port?.postMessage({ ok: true })
		return
	}

	if (type === SW_MSG_PING) {
		port?.postMessage({ pong: true })
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
	// turns it into the file save. Page-`fetch()` (e.g. a Range probe) hits the same handler.
	if (url.pathname.startsWith(SW_DOWNLOAD_PREFIX)) {
		event.respondWith(handleDownload(event.request, url))
	}
})
