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

// Keeps the row's dataUpdatedAt: the unpatched fields (storage above all) are only as fresh as the last
// read, and a restamp would make them look newer than they are. False when nothing is cached.
function writeAccountFields(fields: Partial<Account>): boolean {
	const state = queryClient.getQueryState<Account>([BASE_QUERY_KEY])

	if (!state?.data) {
		return false
	}

	queryUpdater.set<Account>(
		[BASE_QUERY_KEY],
		{
			...state.data,
			...fields
		},
		state.dataUpdatedAt
	)

	return true
}

// Values written while a read was out, each with that read. Its answer may predate them and would revert
// them on landing, so they are written again on top of it; restarting the read instead would cost a
// request and reject the quota checks that joined it. A read started after them (a refetch replaces the
// one out) already has them, and may hold a newer value.
let writesDuringRead: {
	fields: Partial<Account>
	read: Promise<unknown>
}[] = []

function rewriteWhenReadLands(fields: Partial<Account>, read: Promise<unknown>): void {
	writesDuringRead.push({
		fields,
		read
	})

	if (writesDuringRead.length > 1) {
		return
	}

	const unsubscribe = queryClient.getQueryCache().subscribe(event => {
		if (event.query.queryKey[0] !== BASE_QUERY_KEY) {
			return
		}

		// A read's answer, or a read's end without one (failed, or cancelled back to the patched row).
		const landed = event.type === "updated" && event.action.type === "success" && !event.action.manual
		const settled =
			landed ||
			event.type === "removed" ||
			(event.type === "updated" && (event.action.type === "error" || event.action.type === "setState"))

		if (!settled) {
			return
		}

		// The answer is set while its read is still the query's promise.
		const landedRead = landed ? event.query.promise : undefined
		const merged: Partial<Account> = {}
		let rewrite = false

		for (const write of writesDuringRead) {
			if (write.read === landedRead) {
				Object.assign(merged, write.fields)

				rewrite = true
			}
		}

		writesDuringRead = []
		unsubscribe()

		if (rewrite) {
			writeAccountFields(merged)
		}
	})
}

/**
 * Writes fields an account mutation just set, instead of refetching the whole record.
 */
export function accountQueryPatch(fields: Partial<Account>): void {
	if (!writeAccountFields(fields)) {
		return
	}

	const query = queryClient.getQueryCache().get(queryClient.defaultQueryOptions({ queryKey: [BASE_QUERY_KEY] }).queryHash)

	if (query?.promise && query.state.fetchStatus !== "idle") {
		rewriteWhenReadLands(fields, query.promise)
	}
}

// Storage moved (a drive write or event): the next mount rereads instead of waiting out the
// staleTime. Mounted screens are left alone. Runs for every drive event and write, so the query is
// looked up by its hash (as getQueryState does) rather than invalidateQueries hashing the key once per
// cached query.
export function markAccountStale(): void {
	const query = queryClient.getQueryCache().get(queryClient.defaultQueryOptions({ queryKey: [BASE_QUERY_KEY] }).queryHash)

	if (query && !query.state.isInvalidated) {
		query.invalidate()
	}
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

// A write that added bytes the server will count: the cached figure follows without a read. Never
// written again over a read that lands: that read's figure is the server's own.
export function addAccountStorageUsed(bytes: bigint): void {
	const account = cachedAccountState()?.data

	if (!account || bytes <= 0n) {
		return
	}

	writeAccountFields({
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
