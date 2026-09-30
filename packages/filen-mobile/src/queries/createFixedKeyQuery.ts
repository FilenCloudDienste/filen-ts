import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { queryUpdater, type QueryUpdater } from "@/queries/client"

export type FixedKeyQueryOptions = Omit<UseQueryOptions, "queryKey" | "queryFn">

// The hook, cache patch and cache read of a parameterless query cached under the single key [baseKey].
// `empty` is what a function updater patches when nothing is cached yet; a thunk, so an updater that
// mutates its input can never corrupt a shared instance.
export function createFixedKeyQuery<T>({
	baseKey,
	fetchData,
	empty,
	defaultOptions
}: {
	baseKey: string
	fetchData: (params: { signal: AbortSignal }) => Promise<T>
	empty: () => NoInfer<T>
	defaultOptions?: FixedKeyQueryOptions
}) {
	const queryKey = [baseKey]

	return {
		useQuery: function useFixedKeyQuery(options?: FixedKeyQueryOptions): UseQueryResult<T, Error> {
			const query = useQuery({
				...defaultOptions,
				...options,
				queryKey,
				queryFn: ({ signal }) =>
					fetchData({
						signal
					})
			})

			return query as UseQueryResult<T, Error>
		},
		update({ updater }: { updater: QueryUpdater<T> }): void {
			queryUpdater.set<T>(queryKey, prev => {
				return typeof updater === "function" ? (updater as (prev: T) => T)(prev ?? empty()) : updater
			})
		},
		get(): T | undefined {
			return queryUpdater.get<T>(queryKey)
		}
	}
}
