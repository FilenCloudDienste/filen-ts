import { type } from "arktype"
import { queryOptions, useQuery, type UseQueryResult } from "@tanstack/react-query"
import { noDiskPersister } from "@/queries/persist"

// Query key taxonomy per client.ts: [domain, entity].
const REGISTER_CHECK_QUERY_KEY = ["auth", "registerCheck"] as const

const REGISTER_CHECK_URL = "https://gateway.filen.io/v3/registerCheck"

export interface RegisterCheckResult {
	ok: boolean
}

const registerCheckResponseSchema = type({
	status: "boolean",
	data: {
		ok: "boolean"
	}
})

// Sanctioned raw fetch: no @filen/sdk-rs binding exists for this endpoint (mobile precedent). GET,
// no auth, IP/region-based, read-only. EVERY failure — network error, non-2xx, malformed or
// unexpected body — collapses to `{ ok: false }` so the query itself never enters an error state;
// the caller can only ever render "nothing" or "eligible", never a distinguishable "not eligible"
// vs "check failed" state, by design (never asserting a negative the check couldn't confirm).
export async function fetchRegisterCheck(): Promise<RegisterCheckResult> {
	try {
		const response = await fetch(REGISTER_CHECK_URL, { method: "GET" })

		if (!response.ok) {
			return { ok: false }
		}

		const json: unknown = await response.json()
		const parsed = registerCheckResponseSchema(json)

		if (parsed instanceof type.errors) {
			return { ok: false }
		}

		return { ok: parsed.status && parsed.data.ok }
	} catch {
		return { ok: false }
	}
}

// IP/region + time sensitive: never persisted (a disk row would only serve a stale banner for an
// instant), gcTime 0 drops it from memory the instant nothing observes it, and refetchOnMount "always"
// refetches on every mount. Window-focus/reconnect refetch is off — this is a one-shot signup-time
// check, not a value worth keeping live.
export const registerCheckQueryOptions = queryOptions({
	queryKey: REGISTER_CHECK_QUERY_KEY,
	queryFn: fetchRegisterCheck,
	persister: noDiskPersister,
	gcTime: 0,
	refetchOnMount: "always",
	refetchOnWindowFocus: false,
	refetchOnReconnect: false
})

export function useRegisterCheckQuery(): UseQueryResult<RegisterCheckResult> {
	return useQuery(registerCheckQueryOptions)
}
