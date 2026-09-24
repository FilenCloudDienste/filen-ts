import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS, queryClient, queryUpdater } from "@/queries/client"
import auth from "@/lib/auth"
import type { QuotaCheckDeps } from "@filen/shared"

export const BASE_QUERY_KEY = "useAccountQuery"

// Nothing pushes account changes, so a mount refetches once the value is a minute old; a settings
// drill-down reuses the first read. Local writes patch the fields they changed, and drive writes
// (storage) mark it stale.
const ACCOUNT_STALE_TIME = 60 * 1000

export async function fetchData(signal?: AbortSignal) {
	const { authedSdkClient } = await auth.getSdkClients()

	return await authedSdkClient.getUserInfo(
		signal
			? {
					signal
				}
			: undefined
	)
}

export type Account = Awaited<ReturnType<typeof fetchData>>

/**
 * Writes fields an account mutation just set, instead of refetching the whole record. Keeps the
 * row's dataUpdatedAt: the unpatched fields (storage above all) are only as fresh as the last
 * read, and a restamp would make them look newer than they are.
 */
export function accountQueryPatch(fields: Partial<Account>): void {
	const state = queryClient.getQueryState<Account>([BASE_QUERY_KEY])

	if (!state?.data) {
		return
	}

	queryUpdater.set<Account>(
		[BASE_QUERY_KEY],
		{
			...state.data,
			...fields
		},
		state.dataUpdatedAt
	)
}

// Storage moved (a drive write or event): the next mount rereads instead of waiting out the
// staleTime. Mounted screens are left alone.
export function markAccountStale(): void {
	void queryClient.invalidateQueries({
		queryKey: [BASE_QUERY_KEY],
		exact: true,
		refetchType: "none"
	})
}

// How long quota checks (copies, uploads) answer from the cached storage figure before one fresh read.
export const ACCOUNT_QUOTA_TRUST_MS = 10 * 60 * 1000

function cachedAccountState() {
	return queryClient.getQueryState<Account>([BASE_QUERY_KEY])
}

// One read through the query, so a mounted screen shares it and the cache keeps the result.
export function fetchFreshAccount(): Promise<Account> {
	return queryClient.fetchQuery({
		queryKey: [BASE_QUERY_KEY],
		queryFn: ({ signal }) => fetchData(signal),
		staleTime: 0
	})
}

export const accountQuotaDeps: QuotaCheckDeps = {
	cached: () => cachedAccountState()?.data,
	fetchFresh: fetchFreshAccount,
	isCachedFresh: () => {
		const state = cachedAccountState()

		return state?.data !== undefined && Date.now() - state.dataUpdatedAt < ACCOUNT_QUOTA_TRUST_MS
	}
}

// A write that added bytes the server will count: the cached figure follows without a read.
export function addAccountStorageUsed(bytes: bigint): void {
	const account = cachedAccountState()?.data

	if (!account || bytes <= 0n) {
		return
	}

	accountQueryPatch({
		storageUsed: account.storageUsed + bytes
	})
}

export function useAccountQuery(options?: Omit<UseQueryOptions, "queryKey" | "queryFn">): UseQueryResult<Account, Error> {
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		staleTime: ACCOUNT_STALE_TIME,
		refetchOnMount: true,
		...options,
		queryKey: [BASE_QUERY_KEY],
		queryFn: ({ signal }) => fetchData(signal)
	})

	return query as UseQueryResult<Account, Error>
}

export default useAccountQuery
