import { compareNames } from "./naturalSort"

// Minimal shape every contact-like record satisfies (contact, blocked contact, incoming/outgoing
// request, chat/note participant) — nickName's shape differs only in optionality across those
// records, never in type: a record with a required `nickName: string` still structurally
// satisfies an optional `string | undefined` field.
export interface ContactLike {
	email: string
	nickName?: string | undefined
}

// A nickname wins over the bare email whenever one is actually set. Guarded, not asserted —
// nickName is optional precisely because not every contact-like record carries one.
export function contactDisplayName(contact: ContactLike): string {
	return contact.nickName ? contact.nickName : contact.email
}

// Participant order within a rank: natural, case-insensitive display name, then the user id (unique per account).
export function compareParticipantsByName(a: ContactLike & { userId: bigint }, b: ContactLike & { userId: bigint }): number {
	const order = compareNames(contactDisplayName(a), contactDisplayName(b))

	if (order !== 0) {
		return order
	}

	return a.userId === b.userId ? 0 : a.userId < b.userId ? -1 : 1
}
