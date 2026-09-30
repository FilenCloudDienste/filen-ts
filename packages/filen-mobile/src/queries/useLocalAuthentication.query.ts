import { useQuery, type UseQueryResult } from "@tanstack/react-query"
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

export function useLocalAuthenticationQuery(): UseQueryResult<Awaited<ReturnType<typeof fetchData>>, Error> {
	const query = useQuery<Awaited<ReturnType<typeof fetchData>>, Error>({
		queryKey: [BASE_QUERY_KEY],
		queryFn: () => fetchData()
	})

	return query
}

export default useLocalAuthenticationQuery
