import { QueryClient, onlineManager, type UseQueryOptions, type Query } from "@tanstack/react-query"
import { experimental_createQueryPersister, type PersistedQuery } from "@tanstack/query-persist-client-core"
import sqlite, { prefixUpperBound } from "@/lib/sqlite"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import { serialize, deserialize } from "@/lib/serializer"
import { debounce } from "es-toolkit/function"
import { unwrapSdkError, isNetworkClassError } from "@/lib/sdkErrors"
import { ErrorKind } from "@filen/sdk-rs"
import { AppState } from "react-native"
import auth from "@/lib/auth"

// Critical: When changing anything related to query persistence, increment the VERSION constant to invalidate old caches and prevent potential issues from stale or incompatible data.
export const VERSION = 1
export const QUERY_CLIENT_PERSISTER_PREFIX = `reactQuery_v${VERSION}`
export const QUERY_CLIENT_CACHE_TIME = 86400 * 365 * 1000 * 10 // 10 years, effectively infinite for our use case

const PERSIST_DEBOUNCE = 1000
const PERSIST_CHUNK_SIZE = 100
const UNCACHED_QUERY_KEYS = new Map<string, true>([
	["useFileTextQuery", true],
	["useFileBase64Query", true],
	["useFileUriQuery", true],
	["useFileUrlQuery", true],
	["useMediaPermissionsQuery", true],
	["useCameraUploadAlbumsQuery", true],
	["useLocalAuthenticationQuery", true],
	["useCacheSizes", true],
	["useFileProviderCacheBudget", true]
])

export const shouldPersistQuery = (query: PersistedQuery): boolean => {
	const shouldNotPersist = (query.queryKey as unknown[]).some(queryKey => {
		if (typeof queryKey === "string" && UNCACHED_QUERY_KEYS.has(queryKey)) {
			return true
		}

		if (Array.isArray(queryKey) && queryKey.some(k => typeof k === "string" && UNCACHED_QUERY_KEYS.has(k))) {
			return true
		}

		return false
	})

	return !shouldNotPersist && query.state.status === "success"
}

export class QueryPersisterKv {
	private readonly buffer = new Map<string, unknown>()
	private readonly dirtyUpserts = new Set<string>()
	private readonly dirtyDeletes = new Set<string>()

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

		sqlite.kvAsync.removeByPrefix(`${QUERY_CLIENT_PERSISTER_PREFIX}:`).catch(err => {
			console.error("[QueryPersisterKv] Failed to clear", err)
		})
	}

	public async restore(): Promise<void> {
		const prefix = `${QUERY_CLIENT_PERSISTER_PREFIX}:`
		const db = await sqlite.openDb()
		const rows = await db.executeRaw("SELECT key, value FROM kv WHERE key >= ? AND key < ?", [prefix, prefixUpperBound(prefix)])

		for (const row of rows) {
			// Isolate each row's deserialize so a single corrupt/unparseable value
			// (mid-write crash, storage corruption, serializer version mismatch)
			// doesn't abort restoration of the remaining rows. Mirrors the per-row
			// isolation in sqlite.kvAsync.getByPrefix.
			try {
				this.buffer.set((row[0] as string).slice(prefix.length), deserialize(row[1] as string))
			} catch (err) {
				console.error("[QueryPersisterKv] Failed to deserialize row, skipping", err)
			}
		}
	}

	public flush(): void {
		this.persistDirty()
	}

	public flushNow(): void {
		this.persistDirty.cancel()

		if (!this.persisting) {
			this.persistNow()

			return
		}

		// A persistAsync() run is already in flight. Entries added after its dirty-set
		// snapshot (persistAsync lines: deletes/upserts copied then originals cleared)
		// remain in the dirty sets but would otherwise only be re-persisted via the
		// debounced finally-block re-trigger — which can be lost if the process is
		// killed during backgrounding. Chain an immediate persist onto the in-flight
		// run so those entries are flushed without waiting for the debounce window.
		if (this.inFlight) {
			this.inFlight.finally(() => {
				this.persistDirty.cancel()
				this.persistNow()
			})
		}
	}

	private persisting = false
	private inFlight: Promise<void> | null = null

	private persistNow(): void {
		if (this.dirtyUpserts.size === 0 && this.dirtyDeletes.size === 0) {
			return
		}

		const now = performance.now()

		// Snapshot the keys being flushed before clearing so they can be restored on failure.
		const snapshotUpserts = new Set(this.dirtyUpserts)
		const snapshotDeletes = new Set(this.dirtyDeletes)

		const commands = this.buildCommands()

		if (commands.length === 0) {
			return
		}

		console.log(`[QueryPersisterKv] Persisting ${commands.length} changes`)

		sqlite
			.openDb()
			.then(db => db.executeBatch(commands))
			.catch(err => {
				console.error("[QueryPersisterKv] Failed to batch persist", err)

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
			.finally(() => {
				console.log(`[QueryPersisterKv] Persisted in ${(performance.now() - now).toFixed(2)}ms`)
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

			console.log(`[QueryPersisterKv] Persisting ${commands.length} changes`)

			const db = await sqlite.openDb()

			await db.executeBatch(commands)

			console.log(`[QueryPersisterKv] Persisted in ${(performance.now() - now).toFixed(2)}ms`)
		} catch (err) {
			console.error("[QueryPersisterKv] Failed to persist", err)

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

	private persistDirty = debounce(
		() => {
			this.persistAsync()
		},
		PERSIST_DEBOUNCE,
		{
			edges: ["trailing"]
		}
	)
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
		await queryClientPersisterKv.restore()

		for (const key of queryClientPersisterKv.keys()) {
			const persistedQuery = queryClientPersisterKv.getItem<PersistedQuery>(key)

			if (
				!persistedQuery ||
				!persistedQuery.state ||
				!shouldPersistQuery(persistedQuery) ||
				persistedQuery.state.dataUpdatedAt + QUERY_CLIENT_CACHE_TIME < Date.now() ||
				persistedQuery.state.status !== "success"
			) {
				queryClientPersisterKv.removeItem(key)

				continue
			}

			queryClient.setQueryData(persistedQuery.queryKey, persistedQuery.state.data, {
				updatedAt: persistedQuery.state.dataUpdatedAt
			})
		}
	} catch (e) {
		console.error(e)
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
	retry: 5,
	retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000),
	retryOnMount: true,
	networkMode: "offlineFirst",
	throwOnError(err, query: Query) {
		console.error("Query error for key:", query?.queryKey, err)

		// When offline, suppress network-class errors so the user doesn't see banner storms.
		// The persistent <OfflineBanner /> is the canonical signal that requests can't go out.
		if (isNetworkClassError(err) && !onlineManager.isOnline()) {
			return false
		}

		const unwrappedSdkError = unwrapSdkError(err)

		if (unwrappedSdkError && unwrappedSdkError.kind() === ErrorKind.Unauthenticated) {
			// Auth failures while offline are indistinguishable from network failures;
			// don't kick the user out — the next online query will surface a real Unauthenticated.
			if (!onlineManager.isOnline()) {
				return false
			}

			auth.logout().catch(e => {
				console.error("[QueryClient] logout failed:", e)
			})

			return false
		}

		alerts.error(err)

		return false
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as Omit<UseQueryOptions<any, any, any, any>, "queryKey" | "queryFn">

export const queryClient = new QueryClient({
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

		run(async () => {
			await queryClientPersister.persistQueryByKey(queryKey, queryClient)
		})
	}
}

export default queryClient
