import type { ErrorDTO } from "@/lib/sdk/errors"

// Single source of truth for the service worker's own contract — the version it reports at
// `/__sw/version` (bump on any change to sw.ts's runtime behavior, never on app/feature versioning)
// and the message types + route prefixes it understands. Imported by both sw.ts and register.ts;
// that import is the only edge between them.
export const SW_PROTOCOL_VERSION = 13

// Shared so the page side (register.ts's applyUpdate) can't drift from sw.ts's message listener with
// a typo'd literal.
export const SW_SKIP_WAITING_MESSAGE = "SKIP_WAITING"

// page → SW: answered on `event.ports[0]` with `{ build: string | null }`, the build the worker was
// built from. Asked of a worker that is not (yet) the page's controller, which `/__sw/version` cannot
// reach: the page's own fetches go to its controller.
export const SW_MSG_BUILD = "FILEN_SW_BUILD"

// ── Download route (SW-hosted trimmed SDK stream) ───────────────────────────────────────────────
// Virtual URL the SW answers with a streamed, attachment-forced file download. The `<id>` is an
// opaque per-download token (crypto.randomUUID) — NEVER key material (secrets cross only via
// the postMessage channels below, never a URL/query/log).
export const SW_DOWNLOAD_PREFIX = "/sw/download/"

// page → SW postMessage types. The StringifiedClient (decrypted key material) and the resolved
// AnyFile cross ONLY through these structured-clone messages (never a URL/query/log). Each carries a
// MessagePort in `event.ports[0]` for its ACK.
export const SW_MSG_INIT_CLIENT = "FILEN_SW_INIT_CLIENT"
export const SW_MSG_REGISTER_DOWNLOAD = "FILEN_SW_REGISTER_DOWNLOAD"
// Same secrets-never-in-a-URL rule as SW_MSG_REGISTER_DOWNLOAD — the AnyItemWithContext[] (each item's
// own decrypted meta/key material) crosses ONLY through this structured-clone postMessage, never a
// URL/query/log. No `size`: a freshly-generated zip's total byte count isn't known upfront.
export const SW_MSG_REGISTER_ZIP_DOWNLOAD = "FILEN_SW_REGISTER_ZIP_DOWNLOAD"
// A download whose bytes the page produces (an archive entry, which only the page's SDK can read): the
// message transfers a ReadableStream the worker only pipes, so no session Client is needed or asked for.
// One-shot: the first GET takes it, Range ignored, and any later GET finds it gone.
export const SW_MSG_REGISTER_STREAM_DOWNLOAD = "FILEN_SW_REGISTER_STREAM_DOWNLOAD"
// Same cross-only-via-structured-clone-postMessage rule, registering an INLINE (non-attachment)
// stream instead — the `<video>`/`<audio>`/`<img>` preview route. `contentType` is the caller's own
// allowlist-checked claim (features/preview/lib/mediaType.ts's allowedMediaContentType); the SW re-validates
// it independently at serve time (isAllowedInlineContentType below) rather than trusting the message,
// so a compromised/buggy sender can never force an arbitrary inline Content-Type through.
export const SW_MSG_REGISTER_PREVIEW = "FILEN_SW_REGISTER_PREVIEW"
// Ack error a registration answers with when the worker holds no session Client. An idle worker is
// terminated and restarts with empty module globals, so the handed-over Client is gone while the page's
// handoff memo still believes otherwise — the page heals on this by re-handing the session over and
// retrying once (features/drive/lib/saveDownload.ts's registerWithSw). Anything the SW registered before
// that restart is gone too, which is why the acks must never blindly report ok.
export const SW_ERROR_NO_CLIENT = "no-client"
// page → SW logout signal: nulls the reconstructed Client and clears the pending-downloads map so no
// decrypted key material survives sign-out inside the worker. Sent (and acked) from runLogout before
// the page reload.
export const SW_MSG_LOGOUT = "FILEN_SW_LOGOUT"

// page → SW, sent once a download is registered and before its navigation: `event.ports[0]` is the port the
// SW reports that download's SwDownloadStatus on (no ack). The browser's download manager owns the save
// once the navigation starts, so this is the page's only way to learn how it ended.
export const SW_MSG_WATCH_DOWNLOAD = "FILEN_SW_WATCH_DOWNLOAD"
// page → SW: cut a watched download's stream off (the transfer row's Cancel). Reported back as a
// Cancelled failure.
export const SW_MSG_CANCEL_DOWNLOAD = "FILEN_SW_CANCEL_DOWNLOAD"

// What the SW reports on a watched download's port. `total` is null while unknown (a zip's grows as the
// SDK walks its items). A cancel, from the page or the browser's own download UI, is a failure of kind
// "Cancelled".
export type SwDownloadStatus =
	{ type: "progress"; bytes: number; total: number | null } | { type: "done" } | { type: "failed"; error: ErrorDTO }

// A streaming download repeats its latest progress this often even when no byte moved, and the page
// fails a watched download that stays silent for SW_DOWNLOAD_STALL_MS: a worker the browser terminated
// mid-stream sends nothing at all.
export const SW_DOWNLOAD_HEARTBEAT_MS = 5_000
export const SW_DOWNLOAD_STALL_MS = 30_000

// Sent by the page to the worker itself (never over a port) while any watched download streams. A whole
// download is one fetch event, and Firefox terminates a worker about a minute after its last event even
// with waitUntil pending; a client's message is an event that restarts its 30 s idle timeout. The worker
// treats it as a no-op.
export const SW_MSG_KEEPALIVE = "FILEN_SW_KEEPALIVE"
export const SW_KEEPALIVE_MS = 10_000

// How long the page waits for a message's ack before rejecting. Generous enough for the one slow
// message: INIT_CLIENT compiles the 2 MB wasm on a cold worker before it can reply.
export const SW_REQUEST_TIMEOUT_MS = 15_000

// ── Inline-preview Content-Type allowlist ───────────────────────────────────────────────────────
// The SW's inline route (SW_MSG_REGISTER_PREVIEW) only ever serves a Content-Type on this list —
// never an attacker-controlled file's own claimed mime unchecked, never text/html. video/audio use a
// broad codec-agnostic regex (mime diversity across containers/codecs is high, and the route's own
// nosniff header is the real defense there); image uses an explicit, small enumerated set instead of
// a broad `image/*` match — svg+xml specifically needs an exact allowlisted Content-Type rather than
// a pattern, since an over-broad image match is the wrong place to make that call. Shared by the
// page-side gate (features/preview/lib/mediaType.ts's allowedMediaContentType, decides what to even attempt
// registering) and the SW's own independent re-check in sw.ts's handleDownload (defense-in-depth:
// the SW never trusts that the page applied this correctly, it re-validates whatever contentType it
// actually received over postMessage).
const INLINE_MEDIA_MIME_RE = /^(video|audio)\/[a-z0-9.+-]+$/
const INLINE_IMAGE_MIME_ALLOWLIST = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/svg+xml",
	"image/bmp",
	"image/x-icon",
	"image/apng",
	"image/avif"
])

export function isAllowedInlineContentType(contentType: string): boolean {
	const normalized = contentType.toLowerCase().trim()

	return INLINE_MEDIA_MIME_RE.test(normalized) || INLINE_IMAGE_MIME_ALLOWLIST.has(normalized)
}
