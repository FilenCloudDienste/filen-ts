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
// 90 days. Drives gcTime + the persister maxAge + the boot restore-drop (an entry is evicted at
// restore when dataUpdatedAt + this < now). dataUpdatedAt = last online view OR optimistic touch
// (staleTime:0 + refetchOnMount:"always" restamp it every online view, and queryUpdater.set restamps
// it on every optimistic/socket update; networkMode:"offlineFirst" freezes it while offline), so this
// is the "neither viewed online nor touched within the window → evict at next boot" clock.
// Sized well above a plausible offline / app-unopened gap so a long-offline user keeps their cached
// cloud state. Offline editing of a note whose content has aged out is guarded in
// features/notes/components/content (renders a read-only "unavailable offline" surface, never an
// editable empty seed that a keystroke could push over the real note).
export const QUERY_CLIENT_CACHE_TIME = 86400 * 90 * 1000

const PERSIST_DEBOUNCE = 1000
const PERSIST_CHUNK_SIZE = 100
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

export const shouldPersistQuery = (query: PersistedQuery): boolean => {
	return !(query.queryKey as unknown[]).some(isUncachedKeyPart) && query.state.status === "success"
}

export class QueryPersisterKv {
	private readonly buffer = new Map<string, unknown>()
	private readonly dirtyUpserts = new Set<string>()
	private readonly dirtyDeletes = new Set<string>()
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
		this.buffer.set(key, value)

		this.dirtyUpserts.add(key)
		this.dirtyDeletes.delete(key)

		this.persistDirty()
	}

	public removeItem(key: string): void {
		this.buffer.delete(key)

		this.dirtyDeletes.add(key)
		this.dirtyUpserts.delete(key)

		this.persistDirty()
	}

	public keys(): string[] {
		return Array.from(this.buffer.keys())
	}

	public clear(): void {
		this.buffer.clear()
		this.dirtyUpserts.clear()
		this.dirtyDeletes.clear()
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
			// doesn't abort restoration of the remaining rows. Mirrors the per-row
			// isolation in sqlite.kvAsync.getByPrefix.
			try {
				this.buffer.set(key.slice(prefix.length), deserialize(value))
			} catch (err) {
				logger.warn("queries-restore", "Skipped corrupt persisted query row", { rowId: key, error: err })
			}
		})

		this.restoredOnce = true

		logger.debug("queries-restore", "Restored persisted query rows", { count: this.buffer.size, ms: (performance.now() - now).toFixed(2) })
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

				if (value !== undefined) {
					commands.push(["INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", [prefix + key, serialize(value)]])

					serialized++

					if (serialized % PERSIST_CHUNK_SIZE === 0) {
						await new Promise<void>(resolve => {
							setImmediate(resolve)
						})
					}
				}
			}

			if (commands.length === 0) {
				return
			}

			logger.debug("queries-persist", "Async persist started", { count: commands.length })

			const db = await sqlite.openDb()

			await db.executeBatch(commands)

			logger.debug("queries-persist", "Async persist completed", { ms: (performance.now() - now).toFixed(2) })
		} catch (err) {
			logger.error("queries-persist", "Batch persist to SQLite failed", { error: err, upserts: snapshotUpserts.size, deletes: snapshotDeletes.size })

			// Restore failed keys so the finally-block re-trigger actually retries them.
			// Only re-add keys that were not re-dirtied or re-removed after the snapshot.
			for (const key of snapshotUpserts) {
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

	private buildCommands(): [string, (string | Uint8Array)[]][] {
		const prefix = `${QUERY_CLIENT_PERSISTER_PREFIX}:`
		const commands: [string, (string | Uint8Array)[]][] = []

		for (const key of this.dirtyDeletes) {
			commands.push(["DELETE FROM kv WHERE key = ?", [prefix + key]])
		}

		for (const key of this.dirtyUpserts) {
			const value = this.buffer.get(key)

			if (value !== undefined) {
				commands.push(["INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", [prefix + key, serialize(value)]])
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

		logger.error("queries", "QueryCache error", { queryHash: query.queryHash, error: err, action })

		if (action === "suppress") {
			return
		}

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
