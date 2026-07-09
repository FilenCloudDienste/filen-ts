import { type } from "arktype"
import { useQuery, type UseQueryResult } from "@tanstack/react-query"

// Query key taxonomy per client.ts: [domain, entity]. persist.ts imports this exact constant to
// exclude the query from disk persistence, rather than re-literaling the key.
export const REGISTER_CHECK_QUERY_KEY = ["auth", "registerCheck"] as const

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

// IP/region + time sensitive: gcTime 0 drops it from memory the instant nothing observes it, and
// refetchOnMount "always" refetches even over an unexpired restored value. Window-focus/reconnect
// refetch is off — this is a one-shot signup-time check, not a value worth keeping live.
export function useRegisterCheckQuery(): UseQueryResult<RegisterCheckResult> {
	return useQuery({
		queryKey: REGISTER_CHECK_QUERY_KEY,
		queryFn: fetchRegisterCheck,
		gcTime: 0,
		refetchOnMount: "always",
		refetchOnWindowFocus: false,
		refetchOnReconnect: false
	})
}
