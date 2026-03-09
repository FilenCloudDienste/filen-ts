import { QueryClient, type UseQueryOptions } from "@tanstack/react-query"
import { experimental_createQueryPersister, type PersistedQuery } from "@tanstack/query-persist-client-core"
import { useMemo } from "@/lib/memo"
import useFocusNotifyOnChangeProps from "@/queries/useFocusNotifyOnChangeProps"
import useQueryFocusAware from "@/queries/useQueryFocusAware"
import useNetInfo from "@/hooks/useNetInfo"
import sqlite from "@/lib/sqlite"
import { Semaphore, run } from "@filen/utils"
import { unpack, pack } from "@/lib/msgpack"
import alerts from "@/lib/alerts"
import { unwrapSdkError } from "@/lib/utils"
import { ErrorKind } from "@filen/sdk-rs"

export const VERSION = 1
export const QUERY_CLIENT_PERSISTER_PREFIX = `reactQuery_v${VERSION}`
export const QUERY_CLIENT_CACHE_TIME = 86400 * 365 * 1000

export const UNCACHED_QUERY_KEYS: string[] = []

export const shouldPersistQuery = (query: PersistedQuery): boolean => {
	const shouldNotPersist = (query.queryKey as unknown[]).some(
		queryKey => typeof queryKey === "string" && UNCACHED_QUERY_KEYS.includes(queryKey)
	)

	return !shouldNotPersist && query.state.status === "success"
}

const persisterMutex = new Semaphore(1)

export const queryClientPersisterKv = {
	getItem: async <T>(key: string): Promise<T | null> => {
		const result = await run(async defer => {
			await persisterMutex.acquire()

			defer(() => {
				persisterMutex.release()
			})

			return await sqlite.kvAsync.get<T>(`${QUERY_CLIENT_PERSISTER_PREFIX}:${key}`)
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	},
	setItem: async (key: string, value: unknown): Promise<void> => {
		const result = await run(async defer => {
			await persisterMutex.acquire()

			defer(() => {
				persisterMutex.release()
			})

			await sqlite.kvAsync.set(`${QUERY_CLIENT_PERSISTER_PREFIX}:${key}`, value)
		})

		if (!result.success) {
			throw result.error
		}
	},
	removeItem: async (key: string): Promise<void> => {
		const result = await run(async defer => {
			await persisterMutex.acquire()

			defer(() => {
				persisterMutex.release()
			})

			return await sqlite.kvAsync.remove(`${QUERY_CLIENT_PERSISTER_PREFIX}:${key}`)
		})

		if (!result.success) {
			throw result.error
		}
	},
	keys: async (): Promise<string[]> => {
		return (await sqlite.kvAsync.keys()).map(key => key.replace(`${QUERY_CLIENT_PERSISTER_PREFIX}:`, ""))
	},
	clear: async (): Promise<void> => {
		return sqlite.kvAsync.clear()
	}
} as const

export const queryClientPersister = experimental_createQueryPersister({
	storage: queryClientPersisterKv,
	maxAge: QUERY_CLIENT_CACHE_TIME,
	serialize: query => {
		if (query.state.status !== "success" || !shouldPersistQuery(query)) {
			return undefined
		}

		return pack(query)
	},
	deserialize: query => {
		return unpack(query as unknown as Buffer) as unknown as PersistedQuery
	},
	prefix: QUERY_CLIENT_PERSISTER_PREFIX,
	buster: VERSION.toString()
})

export async function restoreQueries(): Promise<void> {
	try {
		const keys = await queryClientPersisterKv.keys()

		await Promise.all(
			keys.map(async key => {
				if (!key.startsWith(QUERY_CLIENT_PERSISTER_PREFIX)) {
					return
				}

				const query = (await queryClientPersisterKv.getItem(key)) as unknown as string | null

				if (!query) {
					return
				}

				const persistedQuery = unpack(query as unknown as Buffer) as unknown as PersistedQuery

				if (
					!persistedQuery ||
					!persistedQuery.state ||
					!shouldPersistQuery(persistedQuery) ||
					persistedQuery.state.dataUpdatedAt + QUERY_CLIENT_CACHE_TIME < Date.now() ||
					persistedQuery.state.status !== "success"
				) {
					await queryClientPersisterKv.removeItem(key)

					return
				}

				queryClient.setQueryData(persistedQuery.queryKey, persistedQuery.state.data, {
					updatedAt: persistedQuery.state.dataUpdatedAt
				})
			})
		)
	} catch (e) {
		console.error(e)
		alerts.error(e)
	}
}

export const DEFAULT_QUERY_OPTIONS: Pick<
	UseQueryOptions,
	| "refetchOnMount"
	| "refetchOnReconnect"
	| "refetchOnWindowFocus"
	| "staleTime"
	| "gcTime"
	| "refetchInterval"
	| "throwOnError"
	| "retryOnMount"
	| "experimental_prefetchInRender"
	| "refetchIntervalInBackground"
	| "retry"
	| "retryDelay"
	| "networkMode"
	| "notifyOnChangeProps"
> = {
	refetchOnMount: "always",
	refetchOnReconnect: "always",
	refetchOnWindowFocus: "always",
	staleTime: 0,
	gcTime: QUERY_CLIENT_CACHE_TIME,
	refetchInterval: false,
	experimental_prefetchInRender: false,
	refetchIntervalInBackground: false,
	retry: true,
	retryDelay: 1000,
	retryOnMount: true,
	networkMode: "always",
	throwOnError(err) {
		console.error(err)

		const unwrappedSdkError = unwrapSdkError(err)

		if (unwrappedSdkError && unwrappedSdkError.kind() === ErrorKind.Unauthenticated) {
			// TODO: Logout on auth errors

			return
		}

		alerts.error(err)

		return false
	}
} as Omit<UseQueryOptions, "queryKey" | "queryFn">

export const DEFAULT_QUERY_OPTIONS_ETERNAL: Pick<
	UseQueryOptions,
	| "refetchOnMount"
	| "refetchOnReconnect"
	| "refetchOnWindowFocus"
	| "staleTime"
	| "gcTime"
	| "refetchInterval"
	| "throwOnError"
	| "retryOnMount"
	| "experimental_prefetchInRender"
	| "refetchIntervalInBackground"
	| "retry"
	| "retryDelay"
	| "networkMode"
	| "notifyOnChangeProps"
> = {
	notifyOnChangeProps: undefined,
	refetchOnMount: false,
	refetchOnReconnect: false,
	refetchOnWindowFocus: false,
	staleTime: Infinity,
	gcTime: Infinity,
	refetchInterval: false,
	experimental_prefetchInRender: false,
	refetchIntervalInBackground: false,
	retry: true,
	retryDelay: 1000,
	retryOnMount: true,
	networkMode: "always",
	throwOnError(err) {
		console.error(err)

		const unwrappedSdkError = unwrapSdkError(err)

		if (unwrappedSdkError && unwrappedSdkError.kind() === ErrorKind.Unauthenticated) {
			// TODO: Logout on auth errors

			return
		}

		alerts.error(err)

		return false
	}
} as Omit<UseQueryOptions, "queryKey" | "queryFn">

export const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			...DEFAULT_QUERY_OPTIONS,
			persister: queryClientPersister.persisterFn,
			queryKeyHashFn: queryKey => pack(queryKey).toString("base64")
		}
	}
})

export function useDefaultQueryParams(
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): Omit<UseQueryOptions, "queryKey" | "queryFn"> {
	const { hasInternet } = useNetInfo()
	const isFocused = useQueryFocusAware()
	const notifyOnChangeProps = useFocusNotifyOnChangeProps()

	const enabled = useMemo(() => {
		if (!hasInternet) {
			return false
		}

		if (typeof options?.enabled === "boolean") {
			return options.enabled
		}

		return isFocused()
	}, [hasInternet, isFocused, options?.enabled])

	return {
		notifyOnChangeProps,
		enabled
	}
}

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
