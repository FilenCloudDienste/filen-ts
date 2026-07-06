// Single source of truth for the service worker's own contract — the version it reports at
// `/__sw/version` (bump on any change to sw.ts's runtime behavior, never on app/feature versioning)
// and the one postMessage type it understands. Imported by both sw.ts and register.ts; that import
// is the only edge between them.
export const SW_PROTOCOL_VERSION = 1

// Shared so the page side (register.ts's applyUpdate) can't drift from sw.ts's message listener with
// a typo'd literal.
export const SW_SKIP_WAITING_MESSAGE = "SKIP_WAITING"
