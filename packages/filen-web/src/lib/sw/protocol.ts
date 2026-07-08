// Single source of truth for the service worker's own contract — the version it reports at
// `/__sw/version` (bump on any change to sw.ts's runtime behavior, never on app/feature versioning)
// and the message types + route prefixes it understands. Imported by both sw.ts and register.ts;
// that import is the only edge between them.
export const SW_PROTOCOL_VERSION = 3

// Shared so the page side (register.ts's applyUpdate) can't drift from sw.ts's message listener with
// a typo'd literal.
export const SW_SKIP_WAITING_MESSAGE = "SKIP_WAITING"

// ── Download route (SW-hosted trimmed SDK stream) ───────────────────────────────────────────────
// Virtual URL the SW answers with a streamed, attachment-forced file download. The `<id>` is an
// opaque per-download token (crypto.randomUUID) — NEVER key material (D16: secrets cross only via
// the postMessage channels below, never a URL/query/log).
export const SW_DOWNLOAD_PREFIX = "/sw/download/"

// page → SW postMessage types. The StringifiedClient (decrypted key material) and the resolved
// AnyFile cross ONLY through these structured-clone messages (never a URL/query/log). Each carries a
// MessagePort in `event.ports[0]` for its ACK.
export const SW_MSG_INIT_CLIENT = "FILEN_SW_INIT_CLIENT"
export const SW_MSG_REGISTER_DOWNLOAD = "FILEN_SW_REGISTER_DOWNLOAD"
// Same D16 rule as SW_MSG_REGISTER_DOWNLOAD — the ZipItem[] (each item's own decrypted meta/key
// material) crosses ONLY through this structured-clone postMessage, never a URL/query/log. No `size`:
// a freshly-generated zip's total byte count isn't known upfront.
export const SW_MSG_REGISTER_ZIP_DOWNLOAD = "FILEN_SW_REGISTER_ZIP_DOWNLOAD"
// page ↔ SW keepalive heartbeat — Firefox kills an idle SW at ~30 s mid-stream, so the page pings
// every ~10-15 s for the duration of any active download and the SW pongs.
export const SW_MSG_PING = "FILEN_SW_PING"
