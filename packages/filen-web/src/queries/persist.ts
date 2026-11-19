import { type } from "arktype"
import {
	experimental_createQueryPersister,
	type AsyncStorage,
	type PersistedQuery,
	type StoragePersisterOptions
} from "@tanstack/react-query-persist-client"
import { hashKey, type QueryClient, type QueryFunction, type QueryFunctionContext, type QueryKey } from "@tanstack/react-query"
import { DECODE_SLICE_MS, kvEntryPages, storage } from "@/lib/storage/adapter"
import { nextTask } from "@/lib/nextTask"
import { parseEnvelope, stringifyEnvelope } from "@filen/shared/session"
import { log } from "@/lib/log"

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
//   object-typed buffer). That policy filter is not ported, and neither is a central `filters`
//   predicate: a query that must stay off disk sets `persister: noDiskPersister` (below) on its own
//   definition — the one opt-out, visible where the query is declared. Our `serialize` below returns
//   `undefined` only on serialization failure and for a removed query's late write (see removedStates).

// Versioned kv-key prefix AND cache-buster in one: bumping this moves every persisted row to a
// fresh key family and makes the persister's own expired-or-busted check drop any older-versioned
// row on read — deliberately a single constant so the two can never drift apart. Bump on ANY
// change to the persisted shape (mobile's client.ts:13 flags this as the easy-to-forget step).
// Rows of a retired version are deleted by the next boot's restore (restorePersistedQueries).
export const PERSIST_FAMILY = "rq."
export const PERSIST_PREFIX = `${PERSIST_FAMILY}v3`

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
// installed createPersister.ts) — so rows live at `<PERSIST_PREFIX>-<queryHash>`.
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

// The state each query held when removeQueriesAndPersisted dropped it. A fetch in flight then still
// resolves (destroy's silent cancel stops neither the SDK call nor the library's follow-up persistQuery)
// and would write that state back under the deleted row, for every later boot to restore. The silent
// cancel dispatches nothing, so that late write carries this very object. By identity: a query built
// again under the same key has its own state and persists as usual.
const removedStates = new WeakSet<object>()

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
	if (removedStates.has(persistedQuery.state)) {
		return undefined
	}

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

// Best-effort row delete (see removeItem below), shared with removeQueriesAndPersisted.
async function removeRow(key: string): Promise<void> {
	try {
		const { api } = await storage()
		await api.kvDelete(key)
	} catch (e) {
		log.warn("query.persist", "kv delete failed", e)
	}
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
// No `entries`: restorePersistedQueries hands the library one page of rows at a time instead.
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
	removeItem: removeRow
}

const persisterOptions: StoragePersisterOptions<string | undefined> = {
	storage: kvStorage,
	prefix: PERSIST_PREFIX,
	buster: PERSIST_PREFIX,
	maxAge: PERSIST_MAX_AGE,
	serialize,
	deserialize
}

export const persister = experimental_createQueryPersister(persisterOptions)

// The one way to keep a query off disk: set `persister: noDiskPersister` on the query. It runs the
// queryFn with no storage round trip (an explicit `undefined` is rejected under
// exactOptionalPropertyTypes, so this overrides the client's default).
export function noDiskPersister<T, K extends QueryKey>(queryFn: QueryFunction<T, K>, context: QueryFunctionContext<K>): T | Promise<T> {
	return queryFn(context)
}

// Boot-time restore-all (called once, after storage init): `setQueryData`s each fresh, current-buster
// `<PERSIST_PREFIX>-*` row back into `client` (the library's documented restore mechanism for this API —
// mobile's hand-rolled equivalent walks its buffer the same way). Expired/busted/corrupt rows are deleted as it
// walks, and so are a retired version's rows, which is also why no separate `persisterGc` pass exists: every
// boot IS the gc pass. Never rejects — a failed restore means an empty cache and real fetches, never a blocked
// boot.
// The rows arrive a page per message (one message for the whole family would be one huge structured clone, on a
// follower tab relayed through the leader tab's main thread), and each page goes through the library's own
// `restoreQueries`, so its checks stay the library's. Decoding lets the thread go every few milliseconds: the
// library awaits `deserialize` per row, which alone is only a microtask.
export async function restorePersistedQueries(client: QueryClient): Promise<void> {
	try {
		const { api } = await storage()
		let sliceStart = performance.now()

		const deserializeInSlices = async (cached: string | undefined): Promise<PersistedQuery> => {
			if (performance.now() - sliceStart >= DECODE_SLICE_MS) {
				await nextTask()

				sliceStart = performance.now()
			}

			return deserialize(cached)
		}

		for await (const rows of kvEntryPages(api, PERSIST_FAMILY)) {
			const current: [string, string][] = []
			const retired: string[] = []

			for (const row of rows) {
				if (row[0].startsWith(KV_KEY_PREFIX)) {
					current.push(row)
				} else {
					retired.push(row[0])
				}
			}

			if (retired.length > 0) {
				await Promise.allSettled(retired.map(key => api.kvDelete(key)))
			}

			await experimental_createQueryPersister({
				...persisterOptions,
				storage: { ...kvStorage, entries: () => current },
				deserialize: deserializeInSlices
			}).restoreQueries(client)
		}
	} catch (e) {
		log.error("query.persist", "restoring persisted queries failed — continuing with an empty cache", e)
	}
}

// Wipes every row of the persist family without restoring any of them — retired versions too, since no
// restore runs to drop those — the not-authed counterpart to restorePersistedQueries, called instead of
// it whenever a boot's resumeSession() comes back false.
// Closes a cross-tab race: a floating persister write (fire-and-forget, see kvStorage.setItem above)
// can land after another tab's logout wipe, leaving an orphan row this tab must not adopt. One
// statement drops the whole family, however many rows it holds.
export async function purgePersistedQueries(): Promise<void> {
	try {
		const { api } = await storage()
		await api.kvDeletePrefix(PERSIST_FAMILY)
	} catch (e) {
		log.error("query.persist", "purging persisted queries failed", e)
	}
}

// removeQueries alone frees only memory: nothing maps an in-memory removal to the persister, so the row
// would come back into the cache on every later boot. For data that is gone for good (a deleted note, a
// left chat), drop both. Rows are keyed by queryHash, so every matching cached query's row goes, plus the
// exact key's own row, which another tab may have persisted without this tab ever holding it. Best-effort:
// removeRow logs and swallows.
export function removeQueriesAndPersisted(client: QueryClient, queryKey: QueryKey): void {
	const rows = new Set([`${KV_KEY_PREFIX}${hashKey(queryKey)}`])

	for (const query of client.getQueryCache().findAll({ queryKey })) {
		rows.add(`${KV_KEY_PREFIX}${query.queryHash}`)
		removedStates.add(query.state)
	}

	client.removeQueries({ queryKey })

	for (const key of rows) {
		void removeRow(key)
	}
}
