import { QueryClient, QueryCache, onlineManager, notifyManager, type UseQueryOptions } from "@tanstack/react-query"
import { experimental_createQueryPersister, type PersistedQuery } from "@tanstack/query-persist-client-core"
import sqlite from "@/lib/sqlite"
import { forEachKvRowByPrefix } from "@/lib/kvScan"
import alerts from "@/lib/alerts"
import { serialize, deserialize } from "@/lib/serializer"
import { unwrapSdkError, isNetworkClassError } from "@/lib/sdkErrors"
import { ErrorKind } from "@filen/sdk-rs"
import { AppState } from "react-native"
import auth from "@/lib/auth"
import useAppStore from "@/stores/useApp.store"
import logger from "@/lib/logger"

// Critical: When changing anything related to query persistence, increment the VERSION constant to invalidate old caches and prevent potential issues from stale or incompatible data.
export const VERSION = 1
export const QUERY_CLIENT_PERSISTER_PREFIX = `reactQuery_v${VERSION}`
// 365 days. Drives gcTime + the persister maxAge + the boot restore-drop (an entry is evicted at
// restore when dataUpdatedAt + this < now). dataUpdatedAt = last online view OR optimistic touch
// (staleTime:0 + refetchOnMount:"always" restamp it every online view, and queryUpdater.set restamps
// it on every optimistic/socket update; networkMode:"offlineFirst" freezes it while offline), so this
// is the "neither viewed online nor touched within the window → evict at next boot" clock.
// Sized well above a plausible offline / app-unopened gap so a long-offline user keeps their cached
// cloud state. Offline editing of a note whose content has aged out is guarded in
// features/notes/components/content (renders a read-only "unavailable offline" surface, never an
// editable empty seed that a keystroke could push over the real note).
export const QUERY_CLIENT_CACHE_TIME = 86400 * 365 * 1000

const PERSIST_DEBOUNCE = 1000
const PERSIST_CHUNK_SIZE = 100
// How far the stored `dataUpdatedAt` may lag reality while unchanged rows are skipped (see
// canSkipPersist). Far inside QUERY_CLIENT_CACHE_TIME, so the restore-time eviction clock can never
// fire on a row that is still being viewed.
const PERSIST_STALE_REFRESH_MS = 86400 * 7 * 1000
// Serialized size past which a row gets its own, much slower write cadence, and that cadence.
//
// PERSIST_DEBOUNCE is sized for the ordinary row. It is the wrong clock for the outliers: a whale
// account's recursive photos listing serializes to tens of MB, and every camera-upload completion
// appends one item to it. At one upload per second that is one multi-MB JS string build + JSI copy +
// SQLite write PER SECOND, all on the JS thread — the shape behind the "app freezes after startup"
// reports. Content-equal no-op refetches are already gated by canSkipPersist; these writes are real
// changes, so the only lever left is how often they land.
//
// What this trades: after a crash-without-backgrounding, a large row on disk can be up to this
// interval stale. It holds re-fetchable server state, whatever mounts the query refetches it anyway,
// and every deliberate flush point (AppState background, the background task's persist-before-suspend
// defer) goes through flushNow/buildCommands, which never defers. Small rows are untouched.
const LARGE_ROW_BYTES = 1024 * 1024
const LARGE_ROW_MIN_INTERVAL_MS = 30 * 1000

/**
 * The two persisted fields a skip decision depends on, or null when the value is not shaped like a
 * PersistedQuery (in which case the caller must fall through to a real write — never guess).
 */
function persistedQueryFields(value: unknown): { data: unknown; dataUpdatedAt: number } | null {
	if (typeof value !== "object" || value === null) {
		return null
	}

	const state = (value as { state?: unknown }).state

	if (typeof state !== "object" || state === null) {
		return null
	}

	const dataUpdatedAt = (state as { dataUpdatedAt?: unknown }).dataUpdatedAt

	if (typeof dataUpdatedAt !== "number") {
		return null
	}

	return {
		data: (state as { data?: unknown }).data,
		dataUpdatedAt
	}
}

const UNCACHED_QUERY_KEYS = new Map<string, true>([
	["useFileTextQuery", true],
	["useFileBase64Query", true],
	["useFileUriQuery", true],
	["useFileUrlQuery", true],
	["useMediaPermissionsQuery", true],
	["useCameraUploadAlbumsQuery", true],
	["useCameraUploadAlbumLatestPhotoQuery", true],
	["useLocalAuthenticationQuery", true],
	["useCacheSizes", true],
	["useFileProviderCacheBudget", true],
	["useRegisterCheck", true]
])

// Hoisted .some predicates — shouldPersistQuery runs per persisted row at restore and
// per persistQueryByKey; inline arrows allocated two closures per call.
function isUncachedKeyString(part: unknown): boolean {
	return typeof part === "string" && UNCACHED_QUERY_KEYS.has(part)
}

function isUncachedKeyPart(part: unknown): boolean {
	if (typeof part === "string" && UNCACHED_QUERY_KEYS.has(part)) {
		return true
	}

	return Array.isArray(part) && part.some(isUncachedKeyString)
}

/**
 * `next`, or `prev` itself when the two hold the very same elements in the same order.
 *
 * A map/filter updater allocates a fresh array even when it matched nothing — the common case for the
 * drive updaters, which broadcast to EVERY listing including the recursive photos one (a whale account's
 * photos listing is a single row holding tens of thousands of items). Handing back the original array
 * lets TanStack's replaceEqualDeep take its `a === b` fast path instead of walking the whole listing.
 *
 * Scope, precisely: replaceEqualDeep would ALSO have returned the previous reference here (that is its
 * job), so this changes neither what is stored nor whether subscribers re-render — `setQueryData` still
 * dispatches and still restamps `dataUpdatedAt`. What it saves is the deep walk itself, which is why it
 * is worth applying only where listings are large enough for that walk to matter.
 *
 * Deliberately narrower than replaceEqualDeep's own equality: element identity implies deep equality, so
 * this can only ever collapse arrays that replaceEqualDeep would have collapsed anyway. A fast path, not
 * a behaviour change.
 */
export function preserveArrayIdentity<T>(prev: T[], next: T[]): T[] {
	if (prev === next || prev.length !== next.length) {
		return next
	}

	for (let i = 0; i < prev.length; i++) {
		if (prev[i] !== next[i]) {
			return next
		}
	}

	return prev
}

export const shouldPersistQuery = (query: PersistedQuery): boolean => {
	return !(query.queryKey as unknown[]).some(isUncachedKeyPart) && query.state.status === "success"
}

export class QueryPersisterKv {
	private readonly buffer = new Map<string, unknown>()
	private readonly dirtyUpserts = new Set<string>()
	private readonly dirtyDeletes = new Set<string>()
	// Per key, the `dataUpdatedAt` of the value last queued for disk (or restored from it). Read by
	// canSkipPersist to bound how far the stored stamp may lag while unchanged rows are skipped.
	private readonly persistedStamp = new Map<string, number>()
	// Per key, the serialized length and the wall clock of the last write that actually reached (or
	// was handed to) SQLite. Only consulted by shouldDeferLargeRow. Both are seeded by a real write,
	// so a key's FIRST write is never deferred, and a row that shrinks under LARGE_ROW_BYTES stops
	// being deferred at its next write.
	private readonly persistedBytes = new Map<string, number>()
	private readonly persistedAt = new Map<string, number>()
	private restoredOnce = false

	public constructor() {
		AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "background") {
				this.flushNow()
			}
		})
	}

	public getItem<T>(key: string): T | null {
		const value = this.buffer.get(key)

		return value !== undefined ? (value as T) : null
	}

	public setItem(key: string, value: unknown): void {
		const previous = this.buffer.get(key)

		this.buffer.set(key, value)

		if (this.canSkipPersist(key, previous, value)) {
			return
		}

		this.dirtyUpserts.add(key)
		this.dirtyDeletes.delete(key)
		this.persistedStamp.set(key, persistedQueryFields(value)?.dataUpdatedAt ?? 0)

		this.persistDirty()
	}

	/**
	 * Whether the stored row is already equivalent to `next`, so this update needs no write.
	 *
	 * TanStack's structural sharing returns the PREVIOUS `data` reference whenever a refetch produced
	 * deep-equal content, so an unchanged reference is an exact "nothing changed" — not a heuristic.
	 * That is worth a lot here: a recursive photos listing is a single multi-MB row, and without this
	 * gate it was re-serialized (plus two JS-thread copies across the JSI boundary, plus the SQLite
	 * write) on every no-op refetch AND on every unrelated drive mutation, because
	 * driveItemsQueryUpdateGlobal ends with an ungated update of the photos query.
	 *
	 * Conservative by construction: anything it cannot prove equivalent falls through to a real write.
	 */
	private canSkipPersist(key: string, previous: unknown, next: unknown): boolean {
		// A dirty key says nothing about what is on disk — a failed write re-dirties its key — so never
		// reason about disk state from one. Defensive rather than load-bearing as things stand: the flush
		// serializes `buffer.get(key)` at flush time, so a skip behind a pending write would still land
		// the newest value. It is kept so this stays correct if the flush ever snapshots earlier.
		if (previous === undefined || this.dirtyUpserts.has(key) || this.dirtyDeletes.has(key)) {
			return false
		}

		const before = persistedQueryFields(previous)
		const after = persistedQueryFields(next)

		if (!before || !after || before.data !== after.data) {
			return false
		}

		const stored = this.persistedStamp.get(key)

		// Unknown stored stamp (nothing written or restored under this key yet) — write.
		if (stored === undefined) {
			return false
		}

		// While skipping, the row on disk keeps the older `dataUpdatedAt`, and THAT stamp is what the
		// restore-time eviction reads (dataUpdatedAt + QUERY_CLIENT_CACHE_TIME < now). Compare against
		// the last stamp actually queued for disk — not against `previous`, or a long series of skips
		// would each look fresh while the stored value aged out and vanished at some later boot.
		return after.dataUpdatedAt - stored < PERSIST_STALE_REFRESH_MS
	}

	/**
	 * Whether `key` is a known-large row whose last write is still inside LARGE_ROW_MIN_INTERVAL_MS.
	 *
	 * Only the debounced background drain consults this. Explicit flushes (backgrounding, the
	 * background task's suspend defer) go through buildCommands and write everything.
	 */
	private shouldDeferLargeRow(key: string): boolean {
		const bytes = this.persistedBytes.get(key)

		if (bytes === undefined || bytes < LARGE_ROW_BYTES) {
			return false
		}

		const writtenAt = this.persistedAt.get(key)

		if (writtenAt === undefined) {
			return false
		}

		return performance.now() - writtenAt < LARGE_ROW_MIN_INTERVAL_MS
	}

	// Serialize + record what the deferral decision needs. Recorded at serialize time rather than on
	// success so the two maps stay in step with `commands`; a failed batch clears persistedAt for its
	// keys (see the catch blocks), so a retry is never held back by a write that did not land.
	private serializeForPersist(key: string, value: unknown): string {
		const serialized = serialize(value)

		this.persistedBytes.set(key, serialized.length)
		this.persistedAt.set(key, performance.now())

		return serialized
	}

	public removeItem(key: string): void {
		this.buffer.delete(key)

		this.dirtyDeletes.add(key)
		this.dirtyUpserts.delete(key)
		this.persistedStamp.delete(key)
		this.persistedBytes.delete(key)
		this.persistedAt.delete(key)

		this.persistDirty()
	}

	public keys(): string[] {
		return Array.from(this.buffer.keys())
	}

	public clear(): void {
		this.buffer.clear()
		this.dirtyUpserts.clear()
		this.dirtyDeletes.clear()
		this.persistedStamp.clear()
		this.persistedBytes.clear()
		this.persistedAt.clear()
		this.restoredOnce = false

		sqlite.kvAsync.removeByPrefix(`${QUERY_CLIENT_PERSISTER_PREFIX}:`).catch(err => {
			logger.error("queries-persist", "Failed to clear persisted query cache from SQLite", { error: err })
		})
	}

	public async restore(): Promise<void> {
		// Once per instance (audit B2b, 2026-06-11): setup() can run more than once in a
		// process. The buffer leads the disk by up to the persist debounce, so re-reading
		// rows here would overwrite newer in-memory entries with stale disk state. A failed
		// restore leaves the flag unset so the next setup() retries; logout ends in a full
		// JS reload, which resets the instance anyway.
		if (this.restoredOnce) {
			return
		}

		const now = performance.now()
		const prefix = `${QUERY_CLIENT_PERSISTER_PREFIX}:`
		const db = await sqlite.openDb()

		// Paged walk (not one full-range executeRaw): a large account's persisted queries can
		// total tens of MB — loading every row's JSON string alongside its parsed object graph
		// in one burst is what OOM'd the Hermes heap at boot. Paging bounds raw-string
		// residency and the inter-page yield lets the GC keep up. Row set and buffer contents
		// are identical to the single-scan version.
		await forEachKvRowByPrefix(db, prefix, (key, value) => {
			// Isolate each row's deserialize so a single corrupt/unparseable value
			// (mid-write crash, storage corruption, serializer version mismatch)
			// doesn't abort restoration of the remaining rows.
			try {
				const bufferKey = key.slice(prefix.length)
				const restored = deserialize(value)

				this.buffer.set(bufferKey, restored)

				// Seed the stamp from disk so the first no-op refetch after boot can already skip its
				// write — without it every restored row would be rewritten once per launch.
				const fields = persistedQueryFields(restored)

				if (fields) {
					this.persistedStamp.set(bufferKey, fields.dataUpdatedAt)
				}
			} catch (err) {
				logger.warn("queries-restore", "Skipped corrupt persisted query row", { rowId: key, error: err })
			}
		})

		this.restoredOnce = true

		logger.debug("queries-restore", "Restored persisted query rows", {
			count: this.buffer.size,
			ms: (performance.now() - now).toFixed(2)
		})
	}

	public flush(): void {
		this.persistDirty()
	}

	/**
	 * Cancels the pending debounce and persists every dirty entry immediately. The
	 * returned promise settles once the batch has landed (or failed and was re-marked
	 * dirty) — the background task threads it through its persist-before-suspend defer
	 * because a headless process may be suspended the moment the task returns. Never
	 * rejects, so callers that cannot await (the AppState handler) may safely ignore it.
	 */
	public flushNow(): Promise<void> {
		this.persistDirty.cancel()

		if (!this.persisting) {
			return this.persistNow()
		}

		// A persistAsync() run is already in flight. Entries added after its dirty-set
		// snapshot (persistAsync lines: deletes/upserts copied then originals cleared)
		// remain in the dirty sets but would otherwise only be re-persisted via the
		// debounced finally-block re-trigger — which can be lost if the process is
		// killed during backgrounding. Chain an immediate persist onto the in-flight
		// run so those entries are flushed without waiting for the debounce window.
		if (this.inFlight) {
			return this.inFlight
				.catch(() => undefined)
				.then(() => {
					this.persistDirty.cancel()

					return this.persistNow()
				})
		}

		return Promise.resolve()
	}

	private persisting = false
	private inFlight: Promise<void> | null = null

	private persistNow(): Promise<void> {
		if (this.dirtyUpserts.size === 0 && this.dirtyDeletes.size === 0) {
			return Promise.resolve()
		}

		const now = performance.now()

		// Snapshot the keys being flushed before clearing so they can be restored on failure.
		const snapshotUpserts = new Set(this.dirtyUpserts)
		const snapshotDeletes = new Set(this.dirtyDeletes)

		const commands = this.buildCommands()

		if (commands.length === 0) {
			return Promise.resolve()
		}

		logger.debug("queries-persist", "In-flight persist started", { count: commands.length })

		// Chain depth is pinned by client.test.ts (openDb → executeBatch → catch → finally,
		// one microtask each) — the void-normalizing .then must come AFTER the catch so the
		// dirty-set restore still lands on the third hop.
		return sqlite
			.openDb()
			.then(db => db.executeBatch(commands))
			.catch(err => {
				logger.error("queries-persist", "In-flight persist failed before flush", { error: err })

				// Restore failed keys into the dirty sets so the next debounce retries them.
				// Only re-add keys that have not been re-dirtied or removed in the interim
				// (i.e. still absent from the dirty sets after buildCommands() cleared them).
				for (const key of snapshotUpserts) {
					// Same reasoning as runPersistAsync's catch: this batch never landed, so no key in it
					// may look "just written" to shouldDeferLargeRow.
					this.persistedAt.delete(key)

					if (!this.dirtyUpserts.has(key) && !this.dirtyDeletes.has(key)) {
						this.dirtyUpserts.add(key)
					}
				}

				for (const key of snapshotDeletes) {
					if (!this.dirtyDeletes.has(key) && !this.dirtyUpserts.has(key)) {
						this.dirtyDeletes.add(key)
					}
				}

				this.persistDirty()
			})
			.then(() => undefined)
			.finally(() => {
				logger.debug("queries-persist", "In-flight persist completed", { ms: (performance.now() - now).toFixed(2) })
			})
	}

	private persistAsync(): Promise<void> {
		if (this.persisting) {
			return this.inFlight ?? Promise.resolve()
		}

		this.persisting = true

		const promise = this.runPersistAsync()

		this.inFlight = promise

		promise.finally(() => {
			if (this.inFlight === promise) {
				this.inFlight = null
			}
		})

		return promise
	}

	private async runPersistAsync(): Promise<void> {
		// Declare snapshot variables outside try so the catch block can restore them on failure.
		let snapshotDeletes = new Set<string>()
		let snapshotUpserts = new Set<string>()

		try {
			if (this.dirtyUpserts.size === 0 && this.dirtyDeletes.size === 0) {
				return
			}

			const now = performance.now()

			snapshotDeletes = new Set(this.dirtyDeletes)
			snapshotUpserts = new Set(this.dirtyUpserts)

			this.dirtyDeletes.clear()
			this.dirtyUpserts.clear()

			const prefix = `${QUERY_CLIENT_PERSISTER_PREFIX}:`
			const commands: [string, (string | Uint8Array)[]][] = []

			for (const key of snapshotDeletes) {
				commands.push(["DELETE FROM kv WHERE key = ?", [prefix + key]])
			}

			let serialized = 0

			for (const key of snapshotUpserts) {
				const value = this.buffer.get(key)

				if (value === undefined) {
					continue
				}

				// Held back, not dropped: the key goes straight back into the dirty set, so the
				// finally-block re-trigger keeps re-checking it once per debounce window until the
				// interval elapses (or a flushNow writes it outright). Checked before serialize() so a
				// deferred multi-MB row costs nothing at all on the ticks it skips.
				if (this.shouldDeferLargeRow(key)) {
					if (!this.dirtyDeletes.has(key)) {
						this.dirtyUpserts.add(key)
					}

					continue
				}

				commands.push([
					"INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
					[prefix + key, this.serializeForPersist(key, value)]
				])

				serialized++

				if (serialized % PERSIST_CHUNK_SIZE === 0) {
					await new Promise<void>(resolve => {
						setImmediate(resolve)
					})
				}
			}

			// Deliberately silent when the batch is empty because everything in it was held back: the
			// re-trigger below re-checks once per debounce window, so logging here would push a line
			// per second into the bounded breadcrumb ring and evict the context a real error needs.
			// The cadence is already visible in the started/completed pair around the writes that land.
			if (commands.length === 0) {
				return
			}

			logger.debug("queries-persist", "Async persist started", { count: commands.length })

			const db = await sqlite.openDb()

			await db.executeBatch(commands)

			logger.debug("queries-persist", "Async persist completed", { ms: (performance.now() - now).toFixed(2) })
		} catch (err) {
			logger.error("queries-persist", "Batch persist to SQLite failed", {
				error: err,
				upserts: snapshotUpserts.size,
				deletes: snapshotDeletes.size
			})

			// Restore failed keys so the finally-block re-trigger actually retries them.
			// Only re-add keys that were not re-dirtied or re-removed after the snapshot.
			for (const key of snapshotUpserts) {
				// Nothing in this batch reached disk, so no key in it may count as "just written" —
				// otherwise a large row's retry would sit out the whole deferral interval for a write
				// that failed. Clearing the stamp (not the size) puts the retry back on the fast path.
				this.persistedAt.delete(key)

				if (!this.dirtyUpserts.has(key) && !this.dirtyDeletes.has(key)) {
					this.dirtyUpserts.add(key)
				}
			}

			for (const key of snapshotDeletes) {
				if (!this.dirtyDeletes.has(key) && !this.dirtyUpserts.has(key)) {
					this.dirtyDeletes.add(key)
				}
			}
		} finally {
			this.persisting = false

			if (this.dirtyUpserts.size > 0 || this.dirtyDeletes.size > 0) {
				this.persistDirty()
			}
		}
	}

	// The EXPLICIT-flush command set: everything dirty, with no LARGE_ROW_MIN_INTERVAL_MS deferral.
	// Its callers (flushNow → backgrounding, the background task's persist-before-suspend defer) exist
	// precisely because the process may not survive to the next debounce window.
	private buildCommands(): [string, (string | Uint8Array)[]][] {
		const prefix = `${QUERY_CLIENT_PERSISTER_PREFIX}:`
		const commands: [string, (string | Uint8Array)[]][] = []

		for (const key of this.dirtyDeletes) {
			commands.push(["DELETE FROM kv WHERE key = ?", [prefix + key]])
		}

		for (const key of this.dirtyUpserts) {
			const value = this.buffer.get(key)

			if (value !== undefined) {
				commands.push([
					"INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
					[prefix + key, this.serializeForPersist(key, value)]
				])
			}
		}

		this.dirtyUpserts.clear()
		this.dirtyDeletes.clear()

		return commands
	}

	// Trailing-debounce scheduler with O(1) re-arms (same shape as src/lib/cache.ts): a
	// generic debounce clears and re-creates a timer on EVERY call — two timer syscalls
	// per setItem/removeItem, i.e. per persistQueryByKey of every query update. Here only
	// the FIRST mutation of an idle window arms a timer; later mutations bump
	// `lastMutationAt`; an early fire re-arms once for the remainder, so the persist
	// still runs exactly PERSIST_DEBOUNCE after the LAST mutation (window-extension
	// semantics pinned by the hardening suite).
	private persistTimer: ReturnType<typeof setTimeout> | null = null
	private lastMutationAt = 0

	private readonly persistDirty: (() => void) & { cancel: () => void } = (() => {
		const onTimer = (): void => {
			this.persistTimer = null

			const elapsed = performance.now() - this.lastMutationAt

			if (elapsed < PERSIST_DEBOUNCE) {
				this.persistTimer = setTimeout(onTimer, PERSIST_DEBOUNCE - elapsed)

				return
			}

			this.persistAsync()
		}

		const trigger = (): void => {
			this.lastMutationAt = performance.now()

			if (this.persistTimer === null) {
				this.persistTimer = setTimeout(onTimer, PERSIST_DEBOUNCE)
			}
		}

		const fn = trigger as (() => void) & { cancel: () => void }

		fn.cancel = (): void => {
			if (this.persistTimer !== null) {
				clearTimeout(this.persistTimer)

				this.persistTimer = null
			}
		}

		return fn
	})()
}

export const queryClientPersisterKv = new QueryPersisterKv()

export const queryClientPersister = experimental_createQueryPersister({
	storage: queryClientPersisterKv,
	maxAge: QUERY_CLIENT_CACHE_TIME,
	serialize: query => {
		if (query.state.status !== "success" || !shouldPersistQuery(query)) {
			return undefined
		}

		return query
	},
	deserialize: query => {
		return query as unknown as PersistedQuery
	},
	prefix: QUERY_CLIENT_PERSISTER_PREFIX,
	buster: VERSION.toString()
})

export async function restoreQueries(): Promise<void> {
	try {
		const now = performance.now()

		await queryClientPersisterKv.restore()

		let restored = 0
		let dropped = 0

		// One notification batch for the whole loop: setQueryData notifies cache
		// subscribers per call otherwise — thousands of persisted queries would pay
		// that once each during boot. One expiry instant for the whole loop too —
		// Date.now() per row is a needless native hop ×rows.
		const expiryNow = Date.now()

		notifyManager.batch(() => {
			for (const key of queryClientPersisterKv.keys()) {
				const persistedQuery = queryClientPersisterKv.getItem<PersistedQuery>(key)

				if (
					!persistedQuery ||
					!persistedQuery.state ||
					!shouldPersistQuery(persistedQuery) ||
					persistedQuery.state.dataUpdatedAt + QUERY_CLIENT_CACHE_TIME < expiryNow ||
					persistedQuery.state.status !== "success"
				) {
					queryClientPersisterKv.removeItem(key)

					dropped++

					continue
				}

				queryClient.setQueryData(persistedQuery.queryKey, persistedQuery.state.data, {
					updatedAt: persistedQuery.state.dataUpdatedAt
				})

				restored++
			}
		})

		logger.debug("queries-restore", "Restored persisted queries", { restored, dropped, ms: (performance.now() - now).toFixed(2) })
	} catch (e) {
		logger.error("queries-restore", "Failed to restore persisted queries", { error: e })
		alerts.error(e)
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DEFAULT_QUERY_OPTIONS: Omit<UseQueryOptions<any, any, any, any>, "queryKey" | "queryFn"> = {
	refetchOnMount: "always",
	refetchOnReconnect: "always",
	staleTime: 0,
	gcTime: QUERY_CLIENT_CACHE_TIME,
	refetchInterval: false,
	experimental_prefetchInRender: true,
	refetchIntervalInBackground: false,
	// NO JS-level retries — the Rust SDK owns retrying (CLAUDE.md: "Never add retry logic in JS").
	// Every SDK request already runs behind filen-rs' tower retry stack (auth/http/retry.rs): up to
	// 10 retries per request, rate-limited by a shared TpsBudget, and CLASSIFIED — only transient
	// failures (5xx/408/429/timeouts/safe transport errors) retry; permanent errors fail fast.
	// The previous `retry: 5` + exponential backoff multiplied wire attempts (×6 on top of the
	// SDK's own cycles, re-running EVERY SDK call in the queryFn) and delayed deterministic
	// failures by ~31s of backoff before the error surfaced. Recovery is owned by
	// refetchOnMount/Reconnect ("always" above), socket invalidations, and reconnect.ts — not by
	// queryFn re-runs. Non-SDK queryFns (local FS, permissions) fail deterministically anyway.
	retry: false,
	retryOnMount: true,
	networkMode: "offlineFirst",
	// PURE render-phase predicate: only decides whether to throw to an error boundary.
	// TanStack v5 invokes throwOnError on EVERY render (twice with experimental_prefetchInRender),
	// so it must have zero side effects. None of our queries throw to an error boundary, hence
	// a constant `false`. All error UX (logout, banners, logging) now lives in the once-per-settled-error
	// QueryCache `onError` sink below.
	throwOnError: () => false
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as Omit<UseQueryOptions<any, any, any, any>, "queryKey" | "queryFn">

// Discriminated decision derived purely from the error + connectivity. No side effects, no I/O,
// no global reads — fully unit-testable. The QueryCache `onError` sink interprets the result.
export type QueryErrorAction = "suppress" | "logout" | "alert"

export function decideQueryErrorAction(
	err: unknown,
	deps: {
		isNetworkClassError: (error: unknown) => boolean
		unwrapSdkError: (error: unknown) => { kind: () => ErrorKind } | null
		isOnline: () => boolean
	}
): QueryErrorAction {
	// Internal resolution misses (a session-scoped cache/context not yet warmed) render their own
	// query-local error UX — stale-while-error listings, hidden size labels, the not-found screen.
	// A banner adds only noise, and the per-uuid messages defeat the dedupe window.
	if (err instanceof Error && (err.name === "DriveDirectoryNotFoundError" || err.name === "DirectorySizeUnresolvedError")) {
		return "suppress"
	}

	// When offline, suppress network-class errors so the user doesn't see banner storms.
	// The floating-bar offline slot (components/floatingBar/offlineSlot) is the canonical
	// signal that requests can't go out.
	if (deps.isNetworkClassError(err) && !deps.isOnline()) {
		return "suppress"
	}

	const unwrappedSdkError = deps.unwrapSdkError(err)

	if (unwrappedSdkError && unwrappedSdkError.kind() === ErrorKind.Unauthenticated) {
		// Auth failures while offline are indistinguishable from network failures;
		// don't kick the user out — the next online query will surface a real Unauthenticated.
		if (!deps.isOnline()) {
			return "suppress"
		}

		return "logout"
	}

	return "alert"
}

// Suppress duplicate banners for the same error message within a short window. `throwOnError` no
// longer fires per-render, but distinct queries can still settle into the same error near-simultaneously
// (e.g. a batch of requests all failing on one outage). The window collapses those into a single banner.
const ALERT_DEDUPE_WINDOW = 3000
let lastAlertMessage: string | null = null
let lastAlertAt = 0

function alertMessageKey(err: unknown): string {
	if (err instanceof Error) {
		return err.message
	}

	return String(err)
}

const queryCache = new QueryCache({
	// Fires ONCE when a query settles into an error state — not on every render. This is the
	// correct place for imperative error UX (logging, logout, banners).
	onError(err, query) {
		const action = decideQueryErrorAction(err, {
			isNetworkClassError,
			unwrapSdkError,
			isOnline: () => onlineManager.isOnline()
		})

		// Suppressed = expected, query-local UX (session-cache warm-up misses, offline network
		// errors) — info keeps them in the breadcrumb ring as context for real errors without
		// red-flagging dev LogBox or inflating the persisted error log.
		if (action === "suppress") {
			logger.info("queries", "QueryCache error", { queryHash: query.queryHash, error: err, action })

			return
		}

		logger.error("queries", "QueryCache error", { queryHash: query.queryHash, error: err, action })

		if (action === "logout") {
			// auth.logout() is internally idempotent (logoutPromise dedup), so concurrent
			// Unauthenticated errors collapse into a single logout.
			auth.logout().catch(e => {
				logger.error("queries", "logout triggered by Unauthenticated query error failed", { error: e })
			})

			return
		}

		// action === "alert". Gate on the root-overlay coordination invariant: never surface a banner
		// while the Biometric/Privacy lock is up or the app is backgrounded, or it leaks behind those overlays.
		if (useAppStore.getState().biometricUnlocked !== true || AppState.currentState !== "active") {
			return
		}

		const now = Date.now()
		const messageKey = alertMessageKey(err)

		if (messageKey === lastAlertMessage && now - lastAlertAt < ALERT_DEDUPE_WINDOW) {
			return
		}

		lastAlertMessage = messageKey
		lastAlertAt = now

		alerts.error(err)
	}
})

export const queryClient = new QueryClient({
	queryCache,
	defaultOptions: {
		queries: {
			...DEFAULT_QUERY_OPTIONS,
			persister: queryClientPersister.persisterFn,
			queryKeyHashFn: queryKey => serialize(queryKey)
		}
	}
})

// The key the persister stores a query's row under. createPersister builds `${prefix}-${queryHash}`
// (queryHash is our serialize-based queryKeyHashFn), and QueryPersisterKv then namespaces that again
// under `${QUERY_CLIENT_PERSISTER_PREFIX}:` inside SQLite. Version-pinned third-party surface —
// re-verify on @tanstack/query-persist-client-core upgrades (same caveat as the persistQueryByKey
// facade below).
export function persistedQueryStorageKey(queryKey: unknown[]): string {
	return `${QUERY_CLIENT_PERSISTER_PREFIX}-${serialize(queryKey)}`
}

/**
 * Drops a query from BOTH the in-memory cache and the persisted store.
 *
 * `queryClient.removeQueries` alone frees only memory: the persister is write-only from our side
 * (persistQueryByKey on a missing query just warns, it never deletes), so the SQLite row would
 * survive until its maxAge expired. Anything that means "stop keeping this on the device" — e.g.
 * un-marking a note as available offline — must reclaim the bytes now, not in a year.
 */
export function removeQueryEverywhere(queryKey: unknown[]): void {
	queryClient.removeQueries({
		queryKey,
		exact: true
	})

	queryClientPersisterKv.removeItem(persistedQueryStorageKey(queryKey))
}

// Plain object namespace (no instance state) — get/set delegate to the module-level
// queryClient. Former `class QueryUpdater` added no value (zero fields, zero `this`).
export const queryUpdater = {
	get<T>(queryKey: unknown[]): T | undefined {
		return queryClient.getQueryData<T>(queryKey)
	},
	set<T>(queryKey: unknown[], updater: T | ((prev?: T) => T), dataUpdatedAt?: number): void {
		queryClient.setQueryData(
			queryKey,
			(oldData: T | undefined) => {
				if (typeof updater === "function") {
					return (updater as (prev: T | undefined) => T)(oldData)
				}

				return updater
			},
			{
				updatedAt: typeof dataUpdatedAt === "number" ? dataUpdatedAt : Date.now()
			}
		)

		// persistQueryByKey resolves its query via `getQueryCache().find({queryKey})` —
		// query-core's find() materializes getAll() and LINEAR-SCANS it, re-running
		// hashQueryKeyByOptions (our serialize-based hash) against the searched key for
		// EVERY candidate (each candidate carries its own options). One update against a
		// cache of N queries costs N key serializations; socket bursts multiply that by
		// their fan-out. Every query in this app uses the single global queryKeyHashFn
		// (client.ts — the only assignment in src/), so the O(1) equivalent is a direct
		// hash lookup. The facade below narrows ONLY find() to that lookup while still
		// routing the persist through queryClientPersister.persistQueryByKey — the
		// persisted shape, storage key format, and gating stay the persister's own.
		// (Version-pinned third-party surface: persistQueryByKey touches nothing else of
		// the client — re-verify on @tanstack/query-persist-client-core upgrades.)
		const queryHash = serialize(queryKey)
		const lookupFacade = {
			getQueryCache: () => ({
				find: () => queryClient.getQueryCache().get(queryHash)
			})
		} as unknown as QueryClient

		queryClientPersister.persistQueryByKey(queryKey, lookupFacade).catch(err => {
			logger.error("queries-persist", "persistQueryByKey failed", { queryHash, error: err })
		})
	}
}

export default queryClient
