import { useQuery, type Query, type UseQueryResult } from "@tanstack/react-query"
import type { UserInfo } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"

// Query key taxonomy per client.ts ([domain, entity, params?]): this resource has exactly one
// entity per session (there is no per-account param to key on — the worker only ever holds a
// single authed client), so the bare domain tuple IS the whole key. Every consumer (rail account
// menu, export-keys reminder, every security card) imports this constant rather than re-literaling
// ["account"], so a future shape change can never let one call site drift onto a different key.
export const ACCOUNT_QUERY_KEY = ["account"] as const

// Narrowed success-state alias, mirrors filen-mobile's `useAccount.query.ts` consumers: every
// security card takes this exact type as a prop instead of re-deriving its own narrowing or
// re-subscribing with its own `useAccountQuery()` call for data it can receive from the page that
// already gated on `status === "success"`.
export type AccountQuerySuccess = Extract<UseQueryResult<UserInfo>, { status: "success" }>

// A persisted account restores with its original read time, and nothing on the socket reports a
// change made elsewhere while the app was closed.
let readThisSession = false

// Plain, testable query function. `useAccountQuery` itself is a one-line hook wrapper this
// project's node-environment unit tests cannot exercise (no DOM/React renderer — see
// vitest.config.ts), so the fetch itself is exported and unit-tested against a mocked `sdkApi`
// instead, mirroring how session.test.ts mocks the same module boundary.
export async function fetchAccount(): Promise<UserInfo> {
	const info = await sdkApi.getUserInfo()

	readThisSession = true

	return info
}

// No socket event covers the account, so a change made on another device (plan, storage used,
// settings) shows on the next focus or mount after this window. This tab's own writes patch it
// (accountQueryUpdate) or mark it stale (markAccountStale), so they never wait on the window.
export const ACCOUNT_STALE_TIME = 60 * 1000

// getUserInfo()'s bigint fields (id, storageUsed, maxStorage, versionedStorage, …) cross the
// Comlink boundary via structured clone — no serializer needed there — and ride the query
// persister's own envelope serialization at rest (queries/persist.ts wraps the whole
// PersistedQuery through stringifyEnvelope). This module must never JSON.stringify the UserInfo
// object itself. Until the first read of the session it refetches like any staleTime-0 query, and a
// reconnect always reads: whatever changed while offline has no other way in.
export function useAccountQuery(): UseQueryResult<UserInfo> {
	return useQuery({
		queryKey: ACCOUNT_QUERY_KEY,
		queryFn: fetchAccount,
		staleTime: () => (readThisSession ? ACCOUNT_STALE_TIME : 0),
		refetchOnReconnect: "always"
	})
}

// Counts this tab's writes to the cached account, patches and stale marks alike.
let accountWrites = 0

// One lookup by the key's hash: find(), cancelQueries and invalidateQueries each copy and re-hash the
// whole query cache, and an upload batch writes once per file.
function accountQuery(): Query<UserInfo> | undefined {
	return queryClient.getQueryCache().get<UserInfo>(queryClient.defaultQueryOptions({ queryKey: ACCOUNT_QUERY_KEY }).queryHash)
}

// A read in flight may have been answered before this tab's write and would land over it. Not an
// initial fetch: cancelling that would strand the query on its loading state with nothing to show.
function cancelInFlightIfCached(query: Query<UserInfo>): void {
	if (query.state.data !== undefined) {
		void query.cancel({ revert: true })
	}
}

// For a write whose server-side effect is not known locally (storage used after an upload or a
// delete): the next focus or mount reads, as it did before the stale time existed, without a read
// per write during a many-file batch.
export function markAccountStale(): void {
	accountWrites++

	const query = accountQuery()

	if (query === undefined) {
		return
	}

	cancelInFlightIfCached(query)
	query.invalidate()
}

// Confirm-then-patch for a write whose whole effect is known locally. A cache miss is left alone: the
// first read will carry the write. setQueryData marks the account fresh, dropping a pending refresh
// and the read cancelled above; left unrestored, the change behind them would wait out the stale time.
export function accountQueryUpdate(updater: (prev: UserInfo) => UserInfo): void {
	accountWrites++

	const query = accountQuery()

	if (query?.state.data === undefined) {
		return
	}

	const refreshPending = query.state.isInvalidated || query.state.fetchStatus !== "idle"

	cancelInFlightIfCached(query)
	queryClient.setQueryData<UserInfo>(ACCOUNT_QUERY_KEY, prev => (prev === undefined ? prev : updater(prev)))

	if (refreshPending) {
		query.invalidate()
	}
}

async function readAccountFresh(writes: number): Promise<UserInfo> {
	const info = await fetchAccount()

	if (accountWrites === writes) {
		queryClient.setQueryData(ACCOUNT_QUERY_KEY, info)
	}

	return info
}

// The fresh read in flight, and the write count it started at.
let freshRead: { promise: Promise<UserInfo>; writes: number } | undefined

// The server's figure, whatever this tab writes meanwhile: a write cancels the query's own read, which
// then resolves with the cached account instead. The cache takes the answer only if nothing was written
// during the read, so it never lands over a patch or clears a stale mark. Callers share a read in flight
// until the next write, whose effect it may predate.
export function fetchAccountFresh(): Promise<UserInfo> {
	if (freshRead?.writes === accountWrites) {
		return freshRead.promise
	}

	const promise = readAccountFresh(accountWrites).finally(() => {
		if (freshRead?.promise === promise) {
			freshRead = undefined
		}
	})

	freshRead = { promise, writes: accountWrites }

	return promise
}
