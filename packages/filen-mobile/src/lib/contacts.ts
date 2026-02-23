import auth from "@/lib/auth"
import { contactRequestsQueryUpdate } from "@/queries/useContactRequests.query"
import { contactsQueryUpdate } from "@/queries/useContacts.query"

class Contacts {
	public async acceptRequest({ uuid, signal }: { uuid: string; signal?: AbortSignal }) {
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

		const contacts = await authedSdkClient.getContacts()

		contactsQueryUpdate({
			updater: prev => ({
				...prev,
				contacts
			})
		})
	}

	public async denyRequest({ uuid, signal }: { uuid: string; signal?: AbortSignal }) {
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
	}

	public async cancelRequest({ uuid, signal }: { uuid: string; signal?: AbortSignal }) {
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
	}

	public async block({ email, signal }: { email: string; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()
		const contacts = await authedSdkClient.getContacts()
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
				blocked: [...prev.blocked.filter(c => c.email !== email), contactToBlock]
			})
		})
	}

	public async delete({ uuid, signal }: { uuid: string; signal?: AbortSignal }) {
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
	}

	public async unblock({ uuid, signal }: { uuid: string; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.unblockContact(
			uuid,
			signal
				? {
						signal
					}
				: undefined
		)

		const contacts = await authedSdkClient.getContacts()

		contactsQueryUpdate({
			updater: prev => ({
				...prev,
				contacts,
				blocked: prev.blocked.filter(c => c.uuid !== uuid)
			})
		})
	}

	public async sendRequest({ email, signal }: { email: string; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.sendContactRequest(
			email,
			signal
				? {
						signal
					}
				: undefined
		)

		const outgoing = await authedSdkClient.listOutgoingContactRequests()

		contactRequestsQueryUpdate({
			updater: prev => ({
				...prev,
				outgoing
			})
		})
	}
}

const contacts = new Contacts()

export default contacts
