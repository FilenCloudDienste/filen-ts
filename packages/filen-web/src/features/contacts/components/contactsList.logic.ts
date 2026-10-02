import { fastLocaleCompare, contactDisplayName, type ContactLike } from "@filen/shared"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"
import { type ContactsKey } from "@/lib/i18n"

// Per-section counts for the contacts sidebar's filter badges. `requests` is INCOMING requests only,
// matching the icon-rail nav badge's own count (shell/iconRail.tsx's incomingRequestCount) so the two
// surfaces never disagree on what "requests" means for this account.
export function contactsSectionCounts(input: {
	contacts: readonly Contact[]
	blocked: readonly BlockedContact[]
	incoming: readonly ContactRequestIn[]
	outgoing: readonly ContactRequestOut[]
}): Record<ContactSection["key"], number> {
	return {
		requests: input.incoming.length,
		pending: input.outgoing.length,
		contacts: input.contacts.length,
		blocked: input.blocked.length
	}
}

// One section per row-kind the contacts page renders — `items` is concretely typed per key so a
// component switching on `key` gets the right record shape for free, with no extra per-item
// discriminant needed (unlike mobile's flat, single-list ContactListItemWithHeader, which interleaves
// header rows into one array for a single FlashList renderItem — the web page renders one <section>
// per key instead, so the section key IS the discriminant).
export type ContactSection =
	| { key: "requests"; items: ContactRequestIn[] }
	| { key: "pending"; items: ContactRequestOut[] }
	| { key: "contacts"; items: Contact[] }
	| { key: "blocked"; items: BlockedContact[] }

export interface BuildContactSectionsInput {
	contacts: Contact[]
	blocked: BlockedContact[]
	incoming: ContactRequestIn[]
	outgoing: ContactRequestOut[]
	// Raw, unnormalized search box value — trimmed/lowercased internally.
	search: string
}

// The one email-or-display-name rule; `searchNormalized` is already trimmed and lowercased.
export function matchesContactSearch(item: ContactLike, searchNormalized: string): boolean {
	if (searchNormalized.length === 0) {
		return true
	}

	return item.email.toLowerCase().includes(searchNormalized) || contactDisplayName(item).toLowerCase().includes(searchNormalized)
}

// The page search box's email-or-display-name rule, shared with ContactPickerList.
export function filterContactsBySearch<T extends ContactLike>(items: readonly T[], search: string): T[] {
	const normalized = search.trim().toLowerCase()

	return items.filter(item => matchesContactSearch(item, normalized))
}

// Contacts not already among `participants` (a chat's or a note's), in source order.
export function contactsNotIn(contacts: readonly Contact[], participants: readonly { userId: bigint }[]): Contact[] {
	const excluded = new Set(participants.map(p => p.userId))

	return contacts.filter(contact => !excluded.has(contact.userId))
}

// By the name a row shows (nickname, else email), for the pickers.
export function sortContactsByDisplayName<T extends ContactLike>(items: readonly T[]): T[] {
	return [...items].sort((a, b) => fastLocaleCompare(contactDisplayName(a), contactDisplayName(b)))
}

function sortByEmail<T extends { email: string }>(items: T[]): T[] {
	return [...items].sort((a, b) => fastLocaleCompare(a.email, b.email))
}

// Requests -> Pending -> Contacts -> Blocked, each sorted by email and (when `search` is non-empty)
// filtered by a case-insensitive substring match against email + contactDisplayName — mirrors
// mobile's buildContactSections + filterContactSections, combined into one pass since the web page
// has no picker mode to special-case. A section that ends up empty (no data, or search filtered
// every row out) is omitted entirely rather than rendered with a header and no rows.
export function buildContactSections(input: BuildContactSectionsInput): ContactSection[] {
	const searchNormalized = input.search.trim().toLowerCase()
	const sections: ContactSection[] = []

	const requests = sortByEmail(input.incoming.filter(item => matchesContactSearch(item, searchNormalized)))
	if (requests.length > 0) {
		sections.push({ key: "requests", items: requests })
	}

	const pending = sortByEmail(input.outgoing.filter(item => matchesContactSearch(item, searchNormalized)))
	if (pending.length > 0) {
		sections.push({ key: "pending", items: pending })
	}

	const contactItems = sortByEmail(input.contacts.filter(item => matchesContactSearch(item, searchNormalized)))
	if (contactItems.length > 0) {
		sections.push({ key: "contacts", items: contactItems })
	}

	const blockedItems = sortByEmail(input.blocked.filter(item => matchesContactSearch(item, searchNormalized)))
	if (blockedItems.length > 0) {
		sections.push({ key: "blocked", items: blockedItems })
	}

	return sections
}

// i18n key per section kind — shared by the page's own inline section headers (contactsList.tsx) and
// the sidebar's nav labels (contactsSidebar.tsx), so the two surfaces can never drift out of sync on
// wording.
export const CONTACTS_SECTION_HEADER_KEY: Record<ContactSection["key"], ContactsKey> = {
	requests: "contactsSectionRequests",
	pending: "contactsSectionPending",
	contacts: "contactsSectionContacts",
	blocked: "contactsSectionBlocked"
}

// The sidebar's section switch: "all" (every section stacked, the page's original shape) plus one
// entry per real ContactSection kind. Deep-linked via the /contacts route's own `section` search
// param (see routes/_app/contacts.tsx) — a URL search param rather than a nested path segment, since
// the route itself takes no path params today (unlike settings' one-file-per-section layout) and this
// stays the less invasive of the two shapes.
export type ContactsSectionFilter = "all" | ContactSection["key"]

export const CONTACTS_SECTION_FILTERS: readonly ContactsSectionFilter[] = ["all", "requests", "pending", "contacts", "blocked"]

export const DEFAULT_CONTACTS_SECTION_FILTER: ContactsSectionFilter = "all"

export function isContactsSectionFilter(value: string): value is ContactsSectionFilter {
	return (CONTACTS_SECTION_FILTERS as readonly string[]).includes(value)
}

// Narrows an already search-filtered section list down to the sidebar's active filter — "all" is a
// no-op (the page's original every-section view), any real key keeps at most the one matching section
// (a section list only ever has zero or one entry per key already, so this is a single-pass filter,
// never a merge).
export function filterContactSections(sections: ContactSection[], filter: ContactsSectionFilter): ContactSection[] {
	if (filter === "all") {
		return sections
	}

	return sections.filter(section => section.key === filter)
}
