import { createFixedKeyQuery } from "@/queries/createFixedKeyQuery"
import auth from "@/lib/auth"
import { toSignalOpts } from "@/lib/signals"

export const BASE_QUERY_KEY = "useContactsQuery"

export async function fetchData(params?: { signal?: AbortSignal }) {
	const { authedSdkClient } = await auth.getSdkClients()

	const [contacts, blocked] = await Promise.all([
		authedSdkClient.getContacts(
			toSignalOpts(params?.signal)
		),
		authedSdkClient.getBlockedContacts(
			toSignalOpts(params?.signal)
		)
	])

	return {
		contacts,
		blocked
	}
}

const contactsQuery = createFixedKeyQuery({
	baseKey: BASE_QUERY_KEY,
	fetchData,
	empty: () => ({
		contacts: [],
		blocked: []
	})
})

export const useContactsQuery = contactsQuery.useQuery
export const contactsQueryUpdate = contactsQuery.update
export const contactsQueryGet = contactsQuery.get

export default useContactsQuery
