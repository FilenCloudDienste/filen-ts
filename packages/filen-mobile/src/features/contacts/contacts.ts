import auth from "@/lib/auth"
import { contactRequestsQueryUpdate } from "@/features/contacts/queries/useContactRequests.query"
import { contactsQueryUpdate } from "@/features/contacts/queries/useContacts.query"

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

		contactRequestsQueryUpdate({
			updater: prev => ({
				...prev,
				incoming: prev.incoming.filter(r => r.uuid !== uuid)
			})
		})

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
				contacts
			})
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

	async block({ email, signal }: { email: string; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()
		const contacts = await authedSdkClient.getContacts(
			signal
				? {
						signal
					}
				: undefined
		)
		const contactToBlock = contacts.find(c => c.email === email)

		if (!contactToBlock) {
			throw new Error("Contact not found")
		}

		await authedSdkClient.blockContact(
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
						uuid: contactToBlock.uuid,
						userId: contactToBlock.userId,
						email: contactToBlock.email,
						avatar: contactToBlock.avatar,
						nickName: contactToBlock.nickName ?? "",
						timestamp: contactToBlock.timestamp
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
