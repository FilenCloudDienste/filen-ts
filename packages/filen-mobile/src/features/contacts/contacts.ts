import auth from "@/lib/auth"
import { contactRequestsQueryUpdate, BASE_QUERY_KEY as CONTACT_REQUESTS_QUERY_KEY } from "@/features/contacts/queries/useContactRequests.query"
import { contactsQueryUpdate, BASE_QUERY_KEY as CONTACTS_QUERY_KEY } from "@/features/contacts/queries/useContacts.query"
import queryClient from "@/queries/client"
import logger from "@/lib/logger"

// Stateless namespace of contact operations (requests, block/unblock, delete). No instance
// state, so a plain object rather than a class. Silent: throws on failure; UI owns error UX.
const contacts = {
	async acceptRequest({ uuid, signal }: { uuid: string; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.acceptContactRequest(
			uuid,
			signal
				? {
						signal
					}
				: undefined
		)

		// Remove the accepted request from the cache immediately for instant UI feedback.
		contactRequestsQueryUpdate({
			updater: prev => ({
				...prev,
				incoming: prev.incoming.filter(r => r.uuid !== uuid)
			})
		})

		// Invalidate both queries so TanStack Query re-fetches with retry rather than
		// doing an inline getContacts() that — if it fails — would leave the request
		// removed but the new contact absent (inconsistent gap until next focus refetch).
		// Consistent with the bulk-accept path in contactsHeader.tsx.
		queryClient.invalidateQueries({ queryKey: [CONTACTS_QUERY_KEY] }).catch(e => {
			logger.warn("contacts", "Failed to invalidate contacts query after acceptRequest", { uuid, error: e instanceof Error ? e.message : String(e) })
		})
		queryClient.invalidateQueries({ queryKey: [CONTACT_REQUESTS_QUERY_KEY] }).catch(e => {
			logger.warn("contacts", "Failed to invalidate contactRequests query after acceptRequest", { uuid, error: e instanceof Error ? e.message : String(e) })
		})
	},

	async denyRequest({ uuid, signal }: { uuid: string; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.denyContactRequest(
			uuid,
			signal
				? {
						signal
					}
				: undefined
		)

		contactRequestsQueryUpdate({
			updater: prev => ({
				...prev,
				incoming: prev.incoming.filter(r => r.uuid !== uuid)
			})
		})
	},

	async cancelRequest({ uuid, signal }: { uuid: string; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.cancelContactRequest(
			uuid,
			signal
				? {
						signal
					}
				: undefined
		)

		contactRequestsQueryUpdate({
			updater: prev => ({
				...prev,
				outgoing: prev.outgoing.filter(r => r.uuid !== uuid)
			})
		})
	},

	async block({
		userId,
		email,
		avatar,
		nickName,
		timestamp,
		signal
	}: {
		userId: bigint
		email: string
		avatar: string | undefined
		nickName: string | undefined
		timestamp: bigint
		signal?: AbortSignal
	}) {
		const { authedSdkClient } = await auth.getSdkClients()

		const blockedUuid = await authedSdkClient.blockContact(
			email,
			signal
				? {
						signal
					}
				: undefined
		)

		contactsQueryUpdate({
			updater: prev => ({
				...prev,
				contacts: prev.contacts.filter(c => c.email !== email),
				blocked: [
					...prev.blocked.filter(c => c.email !== email),
					{
						uuid: blockedUuid,
						userId,
						email,
						avatar,
						nickName: nickName ?? "",
						timestamp
					}
				]
			})
		})
	},

	async delete({ uuid, signal }: { uuid: string; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.deleteContact(
			uuid,
			signal
				? {
						signal
					}
				: undefined
		)

		contactsQueryUpdate({
			updater: prev => ({
				...prev,
				contacts: prev.contacts.filter(c => c.uuid !== uuid)
			})
		})
	},

	async unblock({ uuid, signal }: { uuid: string; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.unblockContact(
			uuid,
			signal
				? {
						signal
					}
				: undefined
		)

		const contacts = await authedSdkClient.getContacts(
			signal
				? {
						signal
					}
				: undefined
		)

		contactsQueryUpdate({
			updater: prev => ({
				...prev,
				contacts,
				blocked: prev.blocked.filter(c => c.uuid !== uuid)
			})
		})
	},

	async sendRequest({ email, signal }: { email: string; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.sendContactRequest(
			email,
			signal
				? {
						signal
					}
				: undefined
		)

		const outgoing = await authedSdkClient.listOutgoingContactRequests(
			signal
				? {
						signal
					}
				: undefined
		)

		contactRequestsQueryUpdate({
			updater: prev => ({
				...prev,
				outgoing
			})
		})
	}
}

export default contacts
