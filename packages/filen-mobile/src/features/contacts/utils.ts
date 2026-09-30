import { fastLocaleCompare, contactDisplayName } from "@filen/shared"
import { type ContactListItem, type ContactListItemWithHeader } from "@/features/contacts/store/useContacts.store"
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

function appendSection(
	out: ContactListItemWithHeader[],
	id: Extract<ContactListItemWithHeader, { type: "header" }>["data"]["id"],
	title: string,
	rows: ContactListItem[]
): void {
	if (rows.length === 0) {
		return
	}

	out.push({
		type: "header",
		data: {
			id,
			title
		}
	})

	for (const row of rows.sort((a, b) => fastLocaleCompare(a.data.email, b.data.email))) {
		out.push(row)
	}
}

/**
 * Builds the sectioned, sorted and (optionally) picker-filtered list of contact
 * rows from the raw query data. Sections (requests / pending / contacts /
 * blocked) are each prefixed with a header row and the items within a section
 * are sorted by email via fastLocaleCompare. In picker mode (selectOptions set)
 * only the contacts section is built.
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
	const items: ContactListItemWithHeader[] = []
	const contacts = data.contacts.map(contact => ({
		type: "contact" as const,
		data: contact
	}))

	if (selectOptions) {
		appendSection(items, "contacts", headerTitles.contacts, contacts)

		return items
	}

	appendSection(
		items,
		"requests",
		headerTitles.requests,
		data.incoming.map(request => ({
			type: "incomingRequest" as const,
			data: request
		}))
	)
	appendSection(
		items,
		"pending",
		headerTitles.pending,
		data.outgoing.map(request => ({
			type: "outgoingRequest" as const,
			data: request
		}))
	)
	appendSection(items, "contacts", headerTitles.contacts, contacts)
	appendSection(
		items,
		"blocked",
		headerTitles.blocked,
		data.blocked.map(blocked => ({
			type: "blocked" as const,
			data: blocked
		}))
	)

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
