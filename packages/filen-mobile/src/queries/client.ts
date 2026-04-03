import { QueryClient, type UseQueryOptions, type Query } from "@tanstack/react-query"
import { experimental_createQueryPersister, type PersistedQuery } from "@tanstack/query-persist-client-core"
import sqlite from "@/lib/sqlite"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import { pack } from "@/lib/msgpack"
import { debounce } from "es-toolkit/function"
import { unwrapSdkError } from "@/lib/utils"
import { ErrorKind } from "@filen/sdk-rs"
import { AppState } from "react-native"

// Critical: When changing anything related to query persistence, increment the VERSION constant to invalidate old caches and prevent potential issues from stale or incompatible data.
export const VERSION = 2
export const QUERY_CLIENT_PERSISTER_PREFIX = `reactQuery_v${VERSION}`
export const QUERY_CLIENT_CACHE_TIME = 86400 * 365 * 1000 * 10 // 10 years, effectively infinite for our use case

const PERSIST_DEBOUNCE = 1000
const UNCACHED_QUERY_KEYS = new Map<string, true>([])

export const shouldPersistQuery = (query: PersistedQuery): boolean => {
	const shouldNotPersist = (query.queryKey as unknown[]).some(
		queryKey => typeof queryKey === "string" && UNCACHED_QUERY_KEYS.has(queryKey)
	)

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
		const entries = await sqlite.kvAsync.getByPrefix<unknown>(prefix)

		for (const [fullKey, value] of entries) {
			this.buffer.set(fullKey.slice(prefix.length), value)
		}
	}

	public flush(): void {
		this.persistDirty()
	}

	public flushNow(): void {
		this.persistDirty.cancel()
		this.persistNow()
	}

	private persistNow(): void {
		if (this.dirtyUpserts.size === 0 && this.dirtyDeletes.size === 0) {
			return
		}

		const prefix = `${QUERY_CLIENT_PERSISTER_PREFIX}:`
		const commands: [string, (string | Uint8Array)[]][] = []

		for (const key of this.dirtyDeletes) {
			commands.push(["DELETE FROM kv WHERE key = ?", [prefix + key]])
		}

		for (const key of this.dirtyUpserts) {
			const value = this.buffer.get(key)

			if (value !== undefined) {
				commands.push(["INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", [prefix + key, new Uint8Array(pack(value))]])
			}
		}

		this.dirtyUpserts.clear()
		this.dirtyDeletes.clear()

		if (commands.length === 0) {
			return
		}

		console.log(`[QueryPersisterKv] Persisting ${commands.length} changes`)

		sqlite
			.openDb()
			.then(db => db.executeBatch(commands))
			.catch(err => {
				console.error("[QueryPersisterKv] Failed to batch persist", err)
			})
	}

	private persistDirty = debounce(
		() => {
			queueMicrotask(() => {
				this.persistNow()
			})
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
	experimental_prefetchInRender: false,
	refetchIntervalInBackground: false,
	retry: 5,
	retryDelay: attemptIndex => Math.min(1000 * 2 ** attemptIndex, 30000),
	retryOnMount: true,
	networkMode: "always",
	throwOnError(err, query: Query) {
		console.error("Query error for key:", query?.queryKey, err)

		const unwrappedSdkError = unwrapSdkError(err)

		if (unwrappedSdkError && unwrappedSdkError.kind() === ErrorKind.Unauthenticated) {
			// TODO: Logout on auth errors

			return
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
			queryKeyHashFn: queryKey => JSON.stringify(queryKey, (_, v) => (typeof v === "bigint" ? `__bigint_${v}` : v))
		}
	}
})

export class QueryUpdater {
	public get<T>(queryKey: unknown[]): T | undefined {
		return queryClient.getQueryData<T>(queryKey)
	}

	public set<T>(queryKey: unknown[], updater: T | ((prev?: T) => T), dataUpdatedAt?: number): void {
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

export const queryUpdater = new QueryUpdater()

export default queryClient
