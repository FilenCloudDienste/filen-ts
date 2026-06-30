import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import logger from "@/lib/logger"

export const BASE_QUERY_KEY = "useRegisterCheck"

const REGISTER_CHECK_URL = "https://gateway.filen.io/v3/registerCheck"

// Manual fetch of the "free 10 GiB at signup" eligibility check (GET, IP/region-based, no params).
// The Rust SDK has no binding for this endpoint, so we call it directly — the one sanctioned manual
// API request on the register screen; everything else still routes through the SDK. Mirrors
// filen-web/src/routes/register.tsx: EVERY failure (network, non-2xx, malformed body) collapses to
// { ok: false }, so the query never enters an error state and the screen always renders a result.
export async function fetchData(): Promise<{ ok: boolean }> {
	try {
		const response = await fetch(REGISTER_CHECK_URL, {
			method: "GET"
		})

		if (!response.ok) {
			throw new Error("Failed to check registration eligibility")
		}

		const json = (await response.json()) as {
			status?: unknown
			data?: { ok?: unknown } | null
		}

		if (!json.status || typeof json.data !== "object" || json.data === null || json.data.ok === undefined) {
			throw new Error("Invalid response from registration eligibility check")
		}

		return {
			ok: json.data.ok === true
		}
	} catch (e) {
		logger.warn("auth", "registerCheck failed", { error: e })

		return {
			ok: false
		}
	}
}

export function useRegisterCheckQuery(
	options?: Omit<UseQueryOptions<{ ok: boolean }, Error>, "queryKey" | "queryFn">
): UseQueryResult<{ ok: boolean }, Error> {
	return useQuery<{ ok: boolean }, Error>({
		// IP/region-based + time-sensitive — recompute on mount, never persist (registered in
		// UNCACHED_QUERY_KEYS in @/queries/client). fetchData never throws, so this is always "success".
		staleTime: 0,
		gcTime: 0,
		networkMode: "always",
		refetchOnMount: "always",
		refetchOnReconnect: false,
		refetchOnWindowFocus: false,
		...options,
		queryKey: [BASE_QUERY_KEY],
		queryFn: () => fetchData()
	})
}

export default useRegisterCheckQuery
