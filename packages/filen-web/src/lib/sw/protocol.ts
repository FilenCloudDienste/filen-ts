// Single source of truth for the service worker's own contract — the version it reports at
// `/__sw/version` (bump on any change to sw.ts's runtime behavior, never on app/feature versioning)
// and the message types + route prefixes it understands. Imported by both sw.ts and register.ts;
// that import is the only edge between them.
export const SW_PROTOCOL_VERSION = 5

// Shared so the page side (register.ts's applyUpdate) can't drift from sw.ts's message listener with
// a typo'd literal.
export const SW_SKIP_WAITING_MESSAGE = "SKIP_WAITING"

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
// Same secrets-never-in-a-URL rule as SW_MSG_REGISTER_DOWNLOAD — the ZipItem[] (each item's own decrypted meta/key
// material) crosses ONLY through this structured-clone postMessage, never a URL/query/log. No `size`:
// a freshly-generated zip's total byte count isn't known upfront.
export const SW_MSG_REGISTER_ZIP_DOWNLOAD = "FILEN_SW_REGISTER_ZIP_DOWNLOAD"
// Same cross-only-via-structured-clone-postMessage rule, registering an INLINE (non-attachment)
// stream instead — the `<video>`/`<audio>`/`<img>` preview route. `contentType` is the caller's own
// allowlist-checked claim (features/preview/lib/mediaType.ts's allowedMediaContentType); the SW re-validates
// it independently at serve time (isAllowedInlineContentType below) rather than trusting the message,
// so a compromised/buggy sender can never force an arbitrary inline Content-Type through.
export const SW_MSG_REGISTER_PREVIEW = "FILEN_SW_REGISTER_PREVIEW"
// page ↔ SW keepalive heartbeat — Firefox kills an idle SW at ~30 s mid-stream, so the page pings
// every ~10-15 s for the duration of any active download and the SW pongs.
export const SW_MSG_PING = "FILEN_SW_PING"

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
