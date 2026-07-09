import { type } from "arktype"
import { experimental_createQueryPersister, type AsyncStorage, type PersistedQuery } from "@tanstack/react-query-persist-client"
import type { QueryClient } from "@tanstack/react-query"
import { storage } from "@/lib/storage/adapter"
import { parseEnvelope, stringifyEnvelope } from "@/lib/serialize"
import { log } from "@/lib/log"
import { REGISTER_CHECK_QUERY_KEY } from "@/features/auth/queries/registerCheck"

// PER-QUERY persistence: `persistQueryClient` re-serializes the ENTIRE dehydrated client on every
// cache change — O(cache) write amplification through the envelope serializer into sqlite on
// every query settle. Mobile hit exactly that wall and deliberately runs
// `experimental_createQueryPersister` (one kv row per query, written only when THAT query updates)
// — see filen-mobile/src/queries/client.ts. Web mirrors that architecture on the OPFS sqlite kv
// table. The "experimental_" label notwithstanding, this API is mobile-proven in production; the
// stable whole-client API is the one with the disqualifying write profile.
//
// Deliberate deltas vs mobile:
// - Import location: mobile imports from `@tanstack/query-persist-client-core` (a direct dep
//   there); here the SAME symbols come via `@tanstack/react-query-persist-client`, which
//   re-exports core verbatim (verified against the installed package) — core itself is not a
//   direct dependency of this app.
// - Mobile's in-memory buffer + debounced write-behind (`QueryPersisterKv`) and its O(1)
//   `persistQueryByKey` narrowing facade are NOT ported: both are measured-need perf optimizations,
//   and the facade is explicitly version-pinned to library internals. Our kv writes already leave
//   the main thread (worker-owned sqlite); add batching only if profiling demands it.
// - Mobile uses its `serialize` option as a should-persist FILTER (returning `undefined` into an
//   object-typed buffer). That policy filter is not ported: `persisterFn` persists only after a
//   SUCCESSFUL queryFn run by construction, so nothing needs filtering yet — and when the first
//   genuinely non-persistable query appears, the API's first-class `filters` option is the
//   sanctioned tool, not the serialize-undefined trick. Our `serialize` below returns `undefined`
//   ONLY on serialization failure (error path, not policy — see its comment).

// Versioned kv-key prefix AND cache-buster in one: bumping this moves every persisted row to a
// fresh key family and makes the persister's own expired-or-busted check drop any older-versioned
// row on read — deliberately a single constant so the two can never drift apart. Bump on ANY
// change to the persisted shape (mobile's client.ts:13 flags this as the easy-to-forget step).
export const PERSIST_PREFIX = "rq.v1"

// ON-DISK expiry: a persisted row whose `state.dataUpdatedAt` is older than this is dropped (and
// its kv row deleted) by the persister's own expired-or-busted check on read/restore. This is the
// SOLE disk-expiry authority, and it is deliberately a DIFFERENT clock from the QueryClient's
// `gcTime` (in-memory retention since the last observer unsubscribed — near-infinite; see
// client.ts). Mobile decouples the two the same way: "the persister is the real eviction
// mechanism".
// ~10 years: the persisted cache IS the warm-boot story — stale rows render instantly as
// placeholders and refetch-on-focus/mount keeps them honest; versioned busters + the buster check
// handle format evolution, not wall-clock age.
export const PERSIST_MAX_AGE = 86400 * 365 * 1000 * 10

// Storage keys follow the persister's OWN scheme — `${prefix}-${queryHash}` (verified in the
// installed createPersister.ts) — so rows live at `rq.v1-<queryHash>`.
const KV_KEY_PREFIX = `${PERSIST_PREFIX}-`

// Every kv read is arktype-validated. This checks the OUTER `PersistedQuery` wrapper only —
// `state`'s internals are TanStack-owned and the library already self-defends on them (a row whose
// `state.dataUpdatedAt` is missing/falsy is treated as expired and removed; `setQueryData` bails
// on `undefined` data) — deep-validating them would duplicate that for no safety gain, consistent
// with this codebase's "SDK returns are NOT re-validated" policy elsewhere.
const persistedQuerySchema = type({
	buster: "string",
	queryHash: "string",
	queryKey: "unknown[]",
	state: "object"
})

// The WRITE side of the log-and-degrade policy. `stringifyEnvelope` can throw (circular refs; a
// root `undefined` cannot happen — the library always passes a PersistedQuery object), and the
// library calls `storage.setItem(key, await serialize(...))` inside an unawaited, uncaught
// `notifyManager.schedule` callback (verified in the installed createPersister.ts) — an unwrapped
// throw there is an UNHANDLED REJECTION. Degrade path: return `undefined`. The library does NOT
// skip the write itself on `undefined` — it forwards it to `storage.setItem` verbatim (verified;
// mobile's filter trick depends on exactly this pass-through) — so the actual skip lives in the
// bridge's `setItem` below, and the storage is typed `AsyncStorage<string | undefined>`
// accordingly. Chosen over writing a poison string because skipping never OVERWRITES a
// previously-persisted still-valid row with junk and never wastes the write: the old row stays
// (stale-but-valid, bounded by PERSIST_MAX_AGE), and the next successful update replaces it.
function serialize(persistedQuery: PersistedQuery): string | undefined {
	try {
		return stringifyEnvelope(persistedQuery)
	} catch (e) {
		log.warn("query.persist", "skipping unserializable query row", e)
		return undefined
	}
}

// THROWING is this API's sanctioned per-row cache-miss (verified in the installed source, unlike
// the whole-client persister where a deserialize throw propagated out of restore): BOTH consumers
// wrap `deserialize` per row — `retrieveQuery` catches → removes the row → returns a miss, and
// `restoreQueries` catches → removes the row → `continue`s with the remaining rows. So a corrupt
// or wrong-shape row self-heals (its kv row is deleted) and never affects any other query.
// (`cached: string | undefined` only because TStorageValue is widened for `serialize`'s degrade
// path above — the bridge never actually YIELDS an undefined value to read back.)
function deserialize(cached: string | undefined): PersistedQuery {
	let parsed: unknown

	try {
		if (cached === undefined) {
			throw new Error("empty row")
		}

		parsed = parseEnvelope(cached)
	} catch (e) {
		log.warn("query.persist", "dropping unparseable persisted query row", e)
		throw new Error("unparseable persisted query row", { cause: e })
	}

	const out = persistedQuerySchema(parsed)

	if (out instanceof type.errors) {
		log.warn("query.persist", "dropping invalid persisted query row", out.summary)
		throw new Error(`invalid persisted query row: ${out.summary}`)
	}

	// arktype's callable `Type` returns `distill.Out<t>`; this schema asserts only the outer wrapper
	// (`state: "object"`, see above), so its inferred output doesn't structurally satisfy
	// `PersistedQuery`'s `state: QueryState`. Same generic-wrapper friction, same narrow bridge, as
	// `kvGetJson` in src/lib/storage/adapter.ts.
	return out as PersistedQuery
}

// AsyncStorage-shaped bridge over RAW strings straight to the kv worker api — NOT
// `kvGetJson`/`kvSetJson` (those run the envelope serializer themselves; `serialize`/`deserialize`
// here already do that job for the persister's payload — both would double-envelope every row).
// Error policy makes persistence strictly best-effort, per method:
// - getItem: a kv READ failure (e.g. storage boot failure) logs + reads as a miss, so the query
//   falls through to its real fetch instead of erroring — `persisterFn` awaits `retrieveQuery`
//   inside the query pipeline, and a rejection there would otherwise fail the query itself.
// - setItem: the library fire-and-forgets `persistQuery`'s write (verified: the `setItem` promise
//   is floating in the installed source), so a rejection would surface as an unhandled rejection —
//   log + swallow instead; the row simply stays stale until the next successful write. An
//   `undefined` value (serialize's degrade path above) skips the write entirely, keeping the
//   previous row.
// - removeItem: self-heal deletions are also best-effort — log + swallow keeps one failed delete
//   from aborting a whole `restoreQueries` walk.
// - entries: propagates — its only callers run under `restorePersistedQueries`'s own catch below.
const kvStorage: AsyncStorage<string | undefined> = {
	getItem: async key => {
		try {
			const { api } = await storage()
			return await api.kvGet(key)
		} catch (e) {
			log.warn("query.persist", "kv read failed — treating as cache miss", e)
			return null
		}
	},
	setItem: async (key, value) => {
		if (value === undefined) {
			return
		}

		try {
			const { api } = await storage()
			await api.kvSet(key, value)
		} catch (e) {
			log.error("query.persist", "kv write failed — query row not persisted", e)
		}
	},
	removeItem: async key => {
		try {
			const { api } = await storage()
			await api.kvDelete(key)
		} catch (e) {
			log.warn("query.persist", "kv delete failed", e)
		}
	},
	entries: async () => {
		const { api } = await storage()
		const keys = await api.kvKeys(KV_KEY_PREFIX)
		const out: [string, string][] = []

		for (const key of keys) {
			const value = await api.kvGet(key)

			if (value !== null) {
				out.push([key, value])
			}
		}

		return out
	}
}

// Query keys excluded from disk persistence entirely, matched exactly (not just by domain prefix)
// so future queries sharing a domain default back to normal persistence. First (and today, only)
// entry: the register-eligibility check is IP/region + time sensitive and already refetches on
// every mount (staleTime 0 + refetchOnMount "always"), so persisting it would only ever serve a
// stale banner for an instant, at the cost of a needless disk row. Imported rather than
// re-literaled so the two can never drift apart.
const NEVER_PERSIST_QUERY_KEYS: readonly (readonly string[])[] = [REGISTER_CHECK_QUERY_KEY]

function isNeverPersisted(queryKey: readonly unknown[]): boolean {
	return NEVER_PERSIST_QUERY_KEYS.some(
		excluded => excluded.length === queryKey.length && excluded.every((segment, i) => segment === queryKey[i])
	)
}

export const persister = experimental_createQueryPersister({
	storage: kvStorage,
	prefix: PERSIST_PREFIX,
	buster: PERSIST_PREFIX,
	maxAge: PERSIST_MAX_AGE,
	serialize,
	deserialize,
	filters: {
		predicate: query => !isNeverPersisted(query.queryKey)
	}
})

// Boot-time restore-all (called once, after storage init): walks every `rq.v1-*` row via
// the bridge's `entries()` and `setQueryData`s each fresh, current-buster row back into `client`
// (the library's documented restore mechanism for this API — mobile's hand-rolled equivalent walks
// its buffer the same way). Expired/busted/corrupt rows are deleted as it walks, which is also why
// no separate `persisterGc` pass exists: every boot IS the gc pass. Never rejects — a failed
// restore means an empty cache and real fetches, never a blocked boot.
export async function restorePersistedQueries(client: QueryClient): Promise<void> {
	try {
		await persister.restoreQueries(client)
	} catch (e) {
		log.error("query.persist", "restoring persisted queries failed — continuing with an empty cache", e)
	}
}

// Wipes every rq.v1-* row without restoring any of them — the not-authed counterpart to
// restorePersistedQueries, called instead of it whenever a boot's resumeSession() comes back false.
// Closes a cross-tab race: a floating persister write (fire-and-forget, see kvStorage.setItem above)
// can land after another tab's logout wipe, leaving an orphan row this tab must not adopt. Same
// allSettled-over-independent-RPCs shape as kvClear (adapter.ts) — one slow/failed delete must not
// abort the rest.
export async function purgePersistedQueries(): Promise<void> {
	try {
		const { api } = await storage()
		const keys = await api.kvKeys(KV_KEY_PREFIX)
		await Promise.allSettled(keys.map(key => api.kvDelete(key)))
	} catch (e) {
		log.error("query.persist", "purging persisted queries failed", e)
	}
}
