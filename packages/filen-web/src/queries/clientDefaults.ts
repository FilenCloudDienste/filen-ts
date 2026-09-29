// The query defaults, apart from the persister: its own module so tests can build a client with the
// same options without loading the sqlite-backed persister.

// TWO INDEPENDENT CLOCKS, deliberately decoupled: gcTime is IN-MEMORY retention measured from the
// last observer unsubscribing; the persister's `PERSIST_MAX_AGE` (persist.ts) is ON-DISK expiry
// measured from `dataUpdatedAt` and is the sole disk-eviction authority. gcTime is set
// effectively-infinite because the persister is the real eviction mechanism — mirroring mobile's
// own QUERY_CLIENT_CACHE_TIME value.
const GC_TIME = 86400 * 365 * 1000 * 10 // ~10 years

export const QUERY_DEFAULTS = {
	staleTime: 0, // every mount/focus refetches unless the query sets its own (see Freshness in client.ts)
	gcTime: GC_TIME,
	// retry: false — the Rust SDK owns ALL retries internally (tower stack; CLAUDE.md rule:
	// never add retry/rate-limit/concurrency logic in JS). An app-level retry here would just
	// re-run an already-exhausted SDK retry cycle and delay surfacing the error to the UI.
	// Transient recovery = SDK-internal retries + refetchOnWindowFocus/refetchOnReconnect
	// below (+ socket-driven invalidation).
	retry: false,
	refetchOnWindowFocus: true,
	refetchOnReconnect: true
}
