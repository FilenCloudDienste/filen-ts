import { QueryCache, QueryClient } from "@tanstack/react-query"
import { persister } from "@/queries/persist"
import { toErrorDTO, labelFirst } from "@/lib/sdk/errors"
import { log } from "@/lib/log"

// TWO INDEPENDENT CLOCKS, deliberately decoupled: gcTime is IN-MEMORY retention measured from the
// last observer unsubscribing; the persister's `PERSIST_MAX_AGE` (persist.ts) is ON-DISK expiry
// measured from `dataUpdatedAt` and is the sole disk-eviction authority. gcTime is set
// effectively-infinite because the persister is the real eviction mechanism — mirroring mobile's
// own QUERY_CLIENT_CACHE_TIME value.
const GC_TIME = 86400 * 365 * 1000 * 10 // ~10 years

// ---------------------------------------------------------------------------------------------
// Conventions
// ---------------------------------------------------------------------------------------------
//
// Query key taxonomy: every key is a tuple `[domain, entity, params?]` —
//   ["drive", "listing", { parentUuid }]
//   ["notes", "detail", { uuid }]
//   ["chats", "messages", { chatUuid, cursor }]
// `domain` mirrors the feature folder under `src/features/<domain>/`; `entity` names the resource
// within it; `params` (when present) is a plain, structurally-hashable object — never a class
// instance or SDK wasm handle (handles are worker-scoped and must never leak across a query key,
// let alone survive a hash/compare or a persist round trip through this client's persister).
// bigint belongs in query DATA, never in query KEYS: the default key hasher is JSON.stringify-
// based and THROWS on bigint (mobile sidesteps this with a global envelope-serializer
// `queryKeyHashFn`; adopt that only if a key genuinely needs a bigint param — none should).
//
// Persistence: PER-QUERY, mirroring mobile (see src/queries/persist.ts for the full rationale) —
// each query owns one sqlite kv row (`rq.v1-<queryHash>`), written via the `persister` default
// below only when that query settles successfully; `restorePersistedQueries(queryClient)` runs
// once on boot. Mobile's O(1) `persistQueryByKey` narrowing facade (version-pinned to library
// internals) is deliberately NOT ported — parked until profiling shows the need. When the first
// query that must NOT persist appears, use the persister's first-class `filters` option
// (persist.ts) — not mobile's serialize-undefined hack.
//
// Zero-`useMutation` convention: this app never calls `useMutation`. Writes are plain typed async
// functions that call the SDK directly from the triggering event handler and, on success,
// explicitly patch the affected queries (`queryClient.setQueryData` / `invalidateQueries`) —
// "confirm-then-patch", mirroring filen-mobile's own convention. There is no
// `onMutate`/`onError`/`onSettled` lifecycle to reason about; optimistic-update/rollback logic,
// where a screen needs it, stays inline at the call site.
//
// Socket-driven invalidation (not yet wired): realtime socket events will invalidate or patch
// queries by key from a single subscription mounted near the router root. This module only owns
// the client instance and its error/persistence plumbing — never feature-specific query keys.
// ---------------------------------------------------------------------------------------------

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			// Per-query kv persistence as a default: every query automatically restores from /
			// persists to its own sqlite row through the wrapped queryFn pipeline.
			persister: persister.persisterFn,
			staleTime: 0, // every mount/focus refetches; realtime events + refetch-on-focus/reconnect own freshness
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
	},
	// Global error logging (verified against the installed v5.101.2 source,
	// @tanstack/query-core/src/query.ts): a failed fetch dispatches an `updated` cache event AND
	// calls this `onError` config callback with the same `(error, query)` pair — `onError` is used
	// here since it is the documented, single-purpose hook for this (no need to subscribe to every
	// cache event and filter `event.type === "updated" && event.action.type === "error"` by hand).
	queryCache: new QueryCache({
		onError: (error, query) => {
			const dto = toErrorDTO(error)
			log.error("query", `[${query.queryHash}]`, labelFirst(dto))
		}
	})
})
