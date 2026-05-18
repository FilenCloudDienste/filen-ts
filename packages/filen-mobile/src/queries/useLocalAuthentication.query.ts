import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query"
import { DEFAULT_QUERY_OPTIONS } from "@/queries/client"
import * as LocalAuthentication from "expo-local-authentication"

export const BASE_QUERY_KEY = "useLocalAuthenticationQuery"

export async function fetchData() {
	const [hasHardware, isEnrolled, supportedTypes] = await Promise.all([
		LocalAuthentication.hasHardwareAsync(),
		LocalAuthentication.isEnrolledAsync(),
		LocalAuthentication.supportedAuthenticationTypesAsync()
	])

	return {
		hasHardware,
		isEnrolled,
		supportedTypes
	}
}

export function useLocalAuthenticationQuery(
	options?: Omit<UseQueryOptions, "queryKey" | "queryFn">
): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery({
		...DEFAULT_QUERY_OPTIONS,
		...options,
		queryKey: [BASE_QUERY_KEY],
		queryFn: () => fetchData()
	})

	return query as UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error>
}

export default useLocalAuthenticationQuery
