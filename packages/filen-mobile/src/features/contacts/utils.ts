import { fastLocaleCompare } from "@filen/utils"
import { type ContactListItemWithHeader } from "@/features/contacts/store/useContacts.store"
import { contactDisplayName } from "@/lib/utils"
import { type SelectOptions } from "@/features/contacts/contactsSelect"
import type { Contact, BlockedContact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"

export type ContactSectionHeaderTitles = {
	requests: string
	pending: string
	contacts: string
	blocked: string
}

export type ContactSectionData = {
	contacts: Contact[]
	blocked: BlockedContact[]
	incoming: ContactRequestIn[]
	outgoing: ContactRequestOut[]
}

/**
 * Builds the sectioned, sorted and (optionally) picker-filtered list of contact
 * rows from the raw query data. Sections (requests / pending / contacts /
 * blocked) are each prefixed with a header row and the items within a section
 * are sorted by email via fastLocaleCompare. In picker mode (selectOptions set)
 * everything but the contacts section is dropped.
 */
export function buildContactSections({
	data,
	headerTitles,
	selectOptions
}: {
	data: ContactSectionData
	headerTitles: ContactSectionHeaderTitles
	selectOptions: SelectOptions | null
}): ContactListItemWithHeader[] {
	let items = [
		...(data.incoming.length > 0
			? [
					{
						type: "header",
						data: {
							id: "requests",
							title: headerTitles.requests
						}
					} satisfies ContactListItemWithHeader
				]
			: []),
		...data.incoming
			.map(request => ({
				type: "incomingRequest" as const,
				data: request
			}))
			.sort((a, b) => fastLocaleCompare(a.data.email, b.data.email)),
		...(data.outgoing.length > 0
			? [
					{
						type: "header",
						data: {
							id: "pending",
							title: headerTitles.pending
						}
					} satisfies ContactListItemWithHeader
				]
			: []),
		...data.outgoing
			.map(request => ({
				type: "outgoingRequest" as const,
				data: request
			}))
			.sort((a, b) => fastLocaleCompare(a.data.email, b.data.email)),
		...(data.contacts.length > 0
			? [
					{
						type: "header",
						data: {
							id: "contacts",
							title: headerTitles.contacts
						}
					} satisfies ContactListItemWithHeader
				]
			: []),
		...data.contacts
			.map(contact => ({
				type: "contact" as const,
				data: contact
			}))
			.sort((a, b) => fastLocaleCompare(a.data.email, b.data.email)),
		...(data.blocked.length > 0
			? [
					{
						type: "header",
						data: {
							id: "blocked",
							title: headerTitles.blocked
						}
					} satisfies ContactListItemWithHeader
				]
			: []),
		...data.blocked
			.map(blocked => ({
				type: "blocked" as const,
				data: blocked
			}))
			.sort((a, b) => fastLocaleCompare(a.data.email, b.data.email))
	] satisfies ContactListItemWithHeader[]

	if (selectOptions) {
		items = items.filter(item => item.type === "contact" || (item.type === "header" && item.data.id === "contacts"))
	}

	return items
}

/**
 * Applies a case-insensitive search filter against email + display name. Header
 * rows are dropped from search results. An empty query returns the input list
 * unchanged.
 */
export function filterContactSections({
	items,
	searchQuery
}: {
	items: ContactListItemWithHeader[]
	searchQuery: string
}): ContactListItemWithHeader[] {
	const searchQueryNormalized = searchQuery.trim().toLowerCase()

	if (searchQueryNormalized.length === 0) {
		return items
	}

	return items.filter(item => {
		if (item.type === "header") {
			return false
		}

		const email = item.data.email.toLowerCase().trim()
		const displayName = contactDisplayName(item.data).toLowerCase().trim()

		return email.includes(searchQueryNormalized) || displayName.includes(searchQueryNormalized)
	})
}
