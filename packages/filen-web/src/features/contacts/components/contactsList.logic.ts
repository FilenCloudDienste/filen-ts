import { fastLocaleCompare } from "@filen/utils"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"

// Minimal shape every contact-like record satisfies (Contact/BlockedContact/ContactRequestIn/
// ContactRequestOut) — nickName's shape differs only in optionality across those four, never in
// type: a record with a required `nickName: string` still structurally satisfies an optional
// `string | undefined` field.
export interface ContactLike {
	email: string
	nickName?: string | undefined
}

// Mirrors filen-mobile's contactDisplayName (lib/utils.ts): a nickname wins over the bare email
// whenever one is actually set. Guarded, not asserted — Contact.nickName is the only one of the
// four record types that can be undefined.
export function contactDisplayName(contact: ContactLike): string {
	return contact.nickName && contact.nickName.length > 0 ? contact.nickName : contact.email
}

// First character of the display name, uppercased — AvatarFallback content when no avatar image
// loads. "?" only covers the type-level empty-string case (email is never empty in practice).
export function contactInitials(displayName: string): string {
	const trimmed = displayName.trim()
	return trimmed.length > 0 ? trimmed.charAt(0).toUpperCase() : "?"
}

// 5-minute presence window, mirrors mobile's ui/avatar.tsx lastActive check. The Number() narrow is
// safe: lastActive is a millisecond server timestamp, always far inside f64's safe-integer range,
// and this value is display-only (never fed back into a bigint-typed call).
const PRESENCE_WINDOW_MS = 300_000

export function isContactOnline(lastActive: bigint): boolean {
	return Number(lastActive) > Date.now() - PRESENCE_WINDOW_MS
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

function matchesSearch(item: ContactLike, searchNormalized: string): boolean {
	if (searchNormalized.length === 0) {
		return true
	}

	return item.email.toLowerCase().includes(searchNormalized) || contactDisplayName(item).toLowerCase().includes(searchNormalized)
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

	const requests = sortByEmail(input.incoming.filter(item => matchesSearch(item, searchNormalized)))
	if (requests.length > 0) {
		sections.push({ key: "requests", items: requests })
	}

	const pending = sortByEmail(input.outgoing.filter(item => matchesSearch(item, searchNormalized)))
	if (pending.length > 0) {
		sections.push({ key: "pending", items: pending })
	}

	const contactItems = sortByEmail(input.contacts.filter(item => matchesSearch(item, searchNormalized)))
	if (contactItems.length > 0) {
		sections.push({ key: "contacts", items: contactItems })
	}

	const blockedItems = sortByEmail(input.blocked.filter(item => matchesSearch(item, searchNormalized)))
	if (blockedItems.length > 0) {
		sections.push({ key: "blocked", items: blockedItems })
	}

	return sections
}
