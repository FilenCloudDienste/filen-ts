import { describe, expect, it } from "vitest"
import type { BlockedContact, Contact, ContactRequestIn, ContactRequestOut } from "@filen/sdk-rs"
import {
	buildContactSections,
	contactDisplayName,
	contactInitials,
	isContactOnline
} from "@/features/contacts/components/contactsList.logic"

function mockContact(overrides: Partial<Contact> = {}): Contact {
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

function mockBlockedContact(overrides: Partial<BlockedContact> = {}): BlockedContact {
	return {
		uuid: "22222222-2222-2222-2222-222222222222",
		userId: 2n,
		email: "bob@filen.io",
		nickName: "Bob",
		timestamp: 1_700_000_000_000n,
		...overrides
	}
}

function mockIncoming(overrides: Partial<ContactRequestIn> = {}): ContactRequestIn {
	return {
		uuid: "33333333-3333-3333-3333-333333333333",
		userId: 3n,
		email: "carol@filen.io",
		nickName: "Carol",
		...overrides
	}
}

function mockOutgoing(overrides: Partial<ContactRequestOut> = {}): ContactRequestOut {
	return {
		uuid: "44444444-4444-4444-4444-444444444444",
		email: "dave@filen.io",
		nickName: "Dave",
		...overrides
	}
}

describe("contactDisplayName", () => {
	it("returns the nickname when it is set and non-empty", () => {
		expect(contactDisplayName({ email: "alice@filen.io", nickName: "Alice" })).toBe("Alice")
	})

	it("falls back to the email when nickName is undefined", () => {
		expect(contactDisplayName({ email: "alice@filen.io", nickName: undefined })).toBe("alice@filen.io")
	})

	it("falls back to the email when nickName is an empty string", () => {
		expect(contactDisplayName({ email: "alice@filen.io", nickName: "" })).toBe("alice@filen.io")
	})

	it("falls back to the email when nickName is omitted entirely", () => {
		expect(contactDisplayName({ email: "alice@filen.io" })).toBe("alice@filen.io")
	})
})

describe("contactInitials", () => {
	it("uppercases the first character of the display name", () => {
		expect(contactInitials("alice")).toBe("A")
	})

	it("trims leading whitespace before taking the first character", () => {
		expect(contactInitials("  bob")).toBe("B")
	})

	it("falls back to a placeholder for an empty display name", () => {
		expect(contactInitials("")).toBe("?")
	})
})

describe("isContactOnline", () => {
	it("is true for a lastActive well inside the 5-minute presence window", () => {
		expect(isContactOnline(BigInt(Date.now() - 60_000))).toBe(true)
	})

	it("is false for a lastActive well outside the 5-minute presence window", () => {
		expect(isContactOnline(BigInt(Date.now() - 600_000))).toBe(false)
	})

	it("is true for a lastActive in the future (clock skew tolerance)", () => {
		expect(isContactOnline(BigInt(Date.now() + 60_000))).toBe(true)
	})
})

describe("buildContactSections", () => {
	it("orders sections Requests -> Pending -> Contacts -> Blocked when every category has data", () => {
		const sections = buildContactSections({
			contacts: [mockContact()],
			blocked: [mockBlockedContact()],
			incoming: [mockIncoming()],
			outgoing: [mockOutgoing()],
			search: ""
		})

		expect(sections.map(section => section.key)).toEqual(["requests", "pending", "contacts", "blocked"])
	})

	it("omits a section entirely when its category has no data, instead of an empty section", () => {
		const sections = buildContactSections({
			contacts: [mockContact()],
			blocked: [],
			incoming: [],
			outgoing: [],
			search: ""
		})

		expect(sections).toEqual([{ key: "contacts", items: [mockContact()] }])
	})

	it("returns no sections at all when every category is empty", () => {
		expect(buildContactSections({ contacts: [], blocked: [], incoming: [], outgoing: [], search: "" })).toEqual([])
	})

	it("sorts each section's items by email, locale-aware", () => {
		const bob = mockContact({ uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", email: "bob@filen.io" })
		const alice = mockContact({ uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", email: "alice@filen.io" })
		const carol = mockContact({ uuid: "cccccccc-cccc-cccc-cccc-cccccccccccc", email: "carol@filen.io" })

		const sections = buildContactSections({ contacts: [bob, alice, carol], blocked: [], incoming: [], outgoing: [], search: "" })

		expect(sections).toEqual([{ key: "contacts", items: [alice, bob, carol] }])
	})

	it("search matches a substring of the email, case-insensitively", () => {
		const alice = mockContact({ email: "alice@filen.io" })
		const bob = mockContact({ uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", email: "bob@filen.io", nickName: "Bob" })

		const sections = buildContactSections({ contacts: [alice, bob], blocked: [], incoming: [], outgoing: [], search: "ALICE" })

		expect(sections).toEqual([{ key: "contacts", items: [alice] }])
	})

	it("search matches a substring of the display name (nickname), case-insensitively", () => {
		const alice = mockContact({ nickName: "Alice Smith" })
		const bob = mockContact({ uuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", email: "bob@filen.io", nickName: "Bob" })

		const sections = buildContactSections({ contacts: [alice, bob], blocked: [], incoming: [], outgoing: [], search: "smith" })

		expect(sections).toEqual([{ key: "contacts", items: [alice] }])
	})

	it("drops a section that becomes empty after the search filter removes every item", () => {
		const sections = buildContactSections({
			contacts: [mockContact({ email: "alice@filen.io", nickName: undefined })],
			blocked: [],
			incoming: [],
			outgoing: [],
			search: "no-match"
		})

		expect(sections).toEqual([])
	})

	it("an empty (whitespace-only) search returns the full unfiltered set", () => {
		const sections = buildContactSections({
			contacts: [mockContact()],
			blocked: [mockBlockedContact()],
			incoming: [mockIncoming()],
			outgoing: [mockOutgoing()],
			search: "   "
		})

		expect(sections.map(section => section.key)).toEqual(["requests", "pending", "contacts", "blocked"])
	})

	it("the full set: every section present, correctly typed, correctly keyed, nothing dropped", () => {
		const contact = mockContact()
		const blocked = mockBlockedContact()
		const incoming = mockIncoming()
		const outgoing = mockOutgoing()

		const sections = buildContactSections({
			contacts: [contact],
			blocked: [blocked],
			incoming: [incoming],
			outgoing: [outgoing],
			search: ""
		})

		expect(sections).toEqual([
			{ key: "requests", items: [incoming] },
			{ key: "pending", items: [outgoing] },
			{ key: "contacts", items: [contact] },
			{ key: "blocked", items: [blocked] }
		])
	})
})
