import { QueryClient } from "@tanstack/react-query"

/**
 * A real TanStack client with the app's refetch defaults, minus the SQLite persister, for request-count
 * suites. queryUpdater.set honours an explicit dataUpdatedAt and otherwise restamps, like the real one.
 *
 *   vi.mock("@/queries/client", async () => await (await import("@/tests/mocks/queryClient")).createQueryClientMock())
 */
export async function createQueryClientMock(options?: { trackServerReads?: boolean }) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				refetchOnMount: "always",
				refetchOnReconnect: "always",
				retry: false,
				networkMode: "offlineFirst"
			}
		}
	})

	if (options?.trackServerReads) {
		const { trackServerReads } = await import("@/queries/socketSession")

		trackServerReads(queryClient.getQueryCache())
	}

	return {
		default: queryClient,
		queryClient,
		getCachedQuery: (queryKey: unknown[]) => queryClient.getQueryCache().find({ queryKey, exact: true }),
		queryUpdater: {
			get: (queryKey: unknown[]) => queryClient.getQueryData(queryKey),
			set: (queryKey: unknown[], updater: unknown, dataUpdatedAt?: number) =>
				queryClient.setQueryData(
					queryKey,
					(prev: unknown) => (typeof updater === "function" ? (updater as (p: unknown) => unknown)(prev) : updater),
					{ updatedAt: typeof dataUpdatedAt === "number" ? dataUpdatedAt : Date.now() }
				)
		}
	}
}
