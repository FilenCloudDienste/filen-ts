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
	return contact.nickName && contact.nickName.length > 0 ? contact.nickName : contact.email
}
