import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"

export function mockContact(overrides: Partial<Contact> = {}): Contact {
	return {
		uuid: "11111111-1111-1111-1111-111111111111",
		userId: 1n,
		email: "alice@filen.io",
		nickName: "Alice",
		lastActive: 1_700_000_000_000n,
		timestamp: 1_700_000_000_000n,
		publicKey: "alice-public-key",
		...overrides
	}
}

export function mockBlockedContact(overrides: Partial<BlockedContact> = {}): BlockedContact {
	return {
		uuid: "22222222-2222-2222-2222-222222222222",
		userId: 2n,
		email: "bob@filen.io",
		nickName: "Bob",
		timestamp: 1_700_000_000_000n,
		...overrides
	}
}

export function mockIncoming(overrides: Partial<ContactRequestIn> = {}): ContactRequestIn {
	return {
		uuid: "33333333-3333-3333-3333-333333333333",
		userId: 3n,
		email: "carol@filen.io",
		nickName: "Carol",
		...overrides
	}
}

export function mockOutgoing(overrides: Partial<ContactRequestOut> = {}): ContactRequestOut {
	return {
		uuid: "44444444-4444-4444-4444-444444444444",
		email: "dave@filen.io",
		nickName: "Dave",
		...overrides
	}
}

// Zero-valued variants for chat/note participant tests, where only userId and email matter.
export function mockPlainContact(overrides: Partial<Contact> = {}): Contact {
	return {
		uuid: "contact-0000-0000-0000-000000000000",
		userId: 2n,
		email: "c@x.io",
		nickName: "c",
		lastActive: 0n,
		timestamp: 0n,
		publicKey: "",
		...overrides
	}
}

export function mockPlainBlockedContact(overrides: Partial<BlockedContact> = {}): BlockedContact {
	return {
		uuid: "blocked-0000-0000-0000-000000000000",
		userId: 2n,
		email: "b@example.com",
		nickName: "",
		timestamp: 0n,
		...overrides
	}
}
