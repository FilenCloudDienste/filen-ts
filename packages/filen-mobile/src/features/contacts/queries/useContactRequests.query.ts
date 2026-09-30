import { createFixedKeyQuery } from "@/queries/createFixedKeyQuery"
import auth from "@/lib/auth"
import { toSignalOpts } from "@/lib/signals"

export const BASE_QUERY_KEY = "useContactRequestsQuery"

export async function fetchData(params?: { signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()

	const [incoming, outgoing] = await Promise.all([
		authedSdkClient.listIncomingContactRequests(
			toSignalOpts(params?.signal)
		),
		authedSdkClient.listOutgoingContactRequests(
			toSignalOpts(params?.signal)
		)
	])

	return {
		incoming,
		outgoing
	}
}

const contactRequestsQuery = createFixedKeyQuery({
	baseKey: BASE_QUERY_KEY,
	fetchData,
	empty: () => ({
		incoming: [],
		outgoing: []
	})
})

export const useContactRequestsQuery = contactRequestsQuery.useQuery
export const contactRequestsQueryUpdate = contactRequestsQuery.update

export default useContactRequestsQuery
