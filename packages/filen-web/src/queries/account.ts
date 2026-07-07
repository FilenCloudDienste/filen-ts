import { useQuery, type UseQueryResult } from "@tanstack/react-query"
import type { UserInfo } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"

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

// Plain, testable query function. `useAccountQuery` itself is a one-line hook wrapper this
// project's node-environment unit tests cannot exercise (no DOM/React renderer — see
// vitest.config.ts), so the fetch itself is exported and unit-tested against a mocked `sdkApi`
// instead, mirroring how session.test.ts mocks the same module boundary.
export function fetchAccount(): Promise<UserInfo> {
	return sdkApi.getUserInfo()
}

// getUserInfo()'s bigint fields (id, storageUsed, maxStorage, versionedStorage, …) cross the
// Comlink boundary via structured clone — no serializer needed there — and ride the query
// persister's own envelope serialization at rest (queries/persist.ts wraps the whole
// PersistedQuery through stringifyEnvelope). This module must never JSON.stringify the UserInfo
// object itself; every default from queries/client.ts (retry:false, per-query kv persistence,
// refetch-on-focus/reconnect) applies unmodified, so there is nothing to override here.
export function useAccountQuery(): UseQueryResult<UserInfo> {
	return useQuery({
		queryKey: ACCOUNT_QUERY_KEY,
		queryFn: fetchAccount
	})
}
