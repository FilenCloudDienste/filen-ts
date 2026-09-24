import auth from "@/lib/auth"
import { contactRequestsQueryUpdate } from "@/features/contacts/queries/useContactRequests.query"
import { contactsQueryUpdate, contactsQueryGet, BASE_QUERY_KEY as CONTACTS_QUERY_KEY } from "@/features/contacts/queries/useContacts.query"
import queryClient from "@/queries/client"
import logger from "@/lib/logger"

// Coalesces contact-list rereads: a request made while one is in flight gets one more pass after it,
// so accepts that land during a read are never missed and a burst costs at most two reads.
let contactsRefresh: Promise<void> | null = null
let contactsRefreshAgain = false

async function readContactsIntoCache(): Promise<void> {
	// Nothing read yet: the first mount reads everything. Writing here would seed an empty
	// blocked list the blocked-user filters would trust.
	if (!contactsQueryGet()) {
		return
	}

	try {
		const { authedSdkClient } = await auth.getSdkClients()
		const contacts = await authedSdkClient.getContacts()

		contactsQueryUpdate({
			updater: prev => ({
				...prev,
				contacts
			})
		})
	} catch (e) {
		// Leave recovery to the query (its mount/reconnect refetch) rather than a request that
		// vanished with no contact in its place.
		logger.warn("contacts", "contacts reread after accept failed; invalidating instead", { error: e })

		queryClient.invalidateQueries({ queryKey: [CONTACTS_QUERY_KEY] }).catch(err => {
			logger.warn("contacts", "Failed to invalidate contacts query after accept", { error: err })
		})
	}
}

// Stateless namespace of contact operations (requests, block/unblock, delete). No instance
// state, so a plain object rather than a class. Silent: throws on failure; UI owns error UX.
const contacts = {
	/**
	 * Accepting only adds a contact, and acceptContactRequest returns just its uuid, so the one
	 * read needed is the contacts list. Blocked contacts and outgoing requests are untouched, and
	 * the accepted incoming request is dropped locally. Bulk callers pass refreshContacts: false
	 * and call refreshContacts() once for the batch.
	 */
	async acceptRequest({ uuid, signal, refreshContacts = true }: { uuid: string; signal?: AbortSignal; refreshContacts?: boolean }) {
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

		if (refreshContacts) {
			await contacts.refreshContacts()
		}
	},

	refreshContacts(): Promise<void> {
		if (contactsRefresh) {
			contactsRefreshAgain = true

			return contactsRefresh
		}

		contactsRefresh = (async () => {
			try {
				do {
					contactsRefreshAgain = false

					await readContactsIntoCache()
				} while (contactsRefreshAgain)
			} finally {
				contactsRefresh = null
			}
		})()

		return contactsRefresh
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
		).catch(e => {
			logger.error("contacts", "getContacts refresh failed after successful unblock; unblock did complete server-side", { uuid, error: e })

			throw e
		})

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
