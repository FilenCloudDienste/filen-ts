import { createFixedKeyQuery } from "@/queries/createFixedKeyQuery"
import auth from "@/lib/auth"
import { toSignalOpts } from "@/lib/signals"

export const BASE_QUERY_KEY = "useEvents"

export async function fetchData(params?: { signal?: AbortSignal; timestamp?: bigint }) {
	const { authedSdkClient } = await auth.getSdkClients()

	return authedSdkClient.getUserEvents(
		undefined,
		params?.timestamp,
		toSignalOpts(params?.signal)
	)
}

const eventsQuery = createFixedKeyQuery({
	baseKey: BASE_QUERY_KEY,
	fetchData,
	empty: () => []
})

export const useEventsQuery = eventsQuery.useQuery
export const eventsQueryUpdate = eventsQuery.update

export default useEventsQuery
