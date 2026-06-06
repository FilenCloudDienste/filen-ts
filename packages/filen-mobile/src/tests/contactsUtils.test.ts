import { describe, it, expect, vi } from "vitest"

// utils.ts imports contactDisplayName from @/lib/utils (a heavy module that pulls
// in SDK runtime values). Stub it with the real nickName-or-email behaviour so the
// test stays self-contained and avoids the full SDK mock surface.
vi.mock("@/lib/utils", () => ({
	contactDisplayName: (contact: { nickName?: string | null; email: string }) =>
		contact.nickName && contact.nickName.length > 0 ? contact.nickName : contact.email
}))

import { buildContactSections, filterContactSections } from "@/features/contacts/utils"
import { type SelectOptions } from "@/features/contacts/contactsSelect"
import { type ContactListItemWithHeader } from "@/features/contacts/store/useContacts.store"

const headerTitles = {
	requests: "Requests",
	pending: "Pending",
	contacts: "Contacts",
	blocked: "Blocked"
}

const emptyData = {
	contacts: [],
	blocked: [],
	incoming: [],
	outgoing: []
}

describe("buildContactSections", () => {
	it("returns an empty array when all sections are empty", () => {
		const items = buildContactSections({
			data: emptyData,
			headerTitles,
			selectOptions: null
		})

		expect(items).toEqual([])
	})

	it("orders sections requests -> pending -> contacts -> blocked, each with a header", () => {
		const items = buildContactSections({
			data: {
				contacts: [{ uuid: "c1", email: "c@example.com" }] as never,
				blocked: [{ uuid: "b1", email: "b@example.com" }] as never,
				incoming: [{ uuid: "i1", email: "i@example.com" }] as never,
				outgoing: [{ uuid: "o1", email: "o@example.com" }] as never
			},
			headerTitles,
			selectOptions: null
		})

		expect(items.map(i => i.type)).toEqual([
			"header",
			"incomingRequest",
			"header",
			"outgoingRequest",
			"header",
			"contact",
			"header",
			"blocked"
		])

		const headerIds = items.filter(i => i.type === "header").map(i => (i.type === "header" ? i.data.id : ""))

		expect(headerIds).toEqual(["requests", "pending", "contacts", "blocked"])
	})

	it("omits a section header when that section has no entries", () => {
		const items = buildContactSections({
			data: {
				...emptyData,
				contacts: [{ uuid: "c1", email: "c@example.com" }] as never
			},
			headerTitles,
			selectOptions: null
		})

		expect(items.map(i => i.type)).toEqual(["header", "contact"])
		expect(items[0]).toMatchObject({ type: "header", data: { id: "contacts", title: "Contacts" } })
	})

	it("sorts entries within a section by email", () => {
		const items = buildContactSections({
			data: {
				...emptyData,
				contacts: [
					{ uuid: "c1", email: "zoe@example.com" },
					{ uuid: "c2", email: "amy@example.com" },
					{ uuid: "c3", email: "mike@example.com" }
				] as never
			},
			headerTitles,
			selectOptions: null
		})

		const emails = items.filter(i => i.type === "contact").map(i => (i.type === "contact" ? i.data.email : ""))

		expect(emails).toEqual(["amy@example.com", "mike@example.com", "zoe@example.com"])
	})

	it("sorts incoming requests within the section by email", () => {
		const items = buildContactSections({
			data: {
				...emptyData,
				incoming: [
					{ uuid: "i1", email: "zoe@example.com" },
					{ uuid: "i2", email: "amy@example.com" },
					{ uuid: "i3", email: "mike@example.com" }
				] as never
			},
			headerTitles,
			selectOptions: null
		})

		const emails = items.filter(i => i.type === "incomingRequest").map(i => (i.type === "incomingRequest" ? i.data.email : ""))

		expect(emails).toEqual(["amy@example.com", "mike@example.com", "zoe@example.com"])
	})

	it("sorts outgoing requests within the section by email", () => {
		const items = buildContactSections({
			data: {
				...emptyData,
				outgoing: [
					{ uuid: "o1", email: "zoe@example.com" },
					{ uuid: "o2", email: "amy@example.com" },
					{ uuid: "o3", email: "mike@example.com" }
				] as never
			},
			headerTitles,
			selectOptions: null
		})

		const emails = items.filter(i => i.type === "outgoingRequest").map(i => (i.type === "outgoingRequest" ? i.data.email : ""))

		expect(emails).toEqual(["amy@example.com", "mike@example.com", "zoe@example.com"])
	})

	it("sorts blocked entries within the section by email", () => {
		const items = buildContactSections({
			data: {
				...emptyData,
				blocked: [
					{ uuid: "bl1", email: "zoe@example.com" },
					{ uuid: "bl2", email: "amy@example.com" },
					{ uuid: "bl3", email: "mike@example.com" }
				] as never
			},
			headerTitles,
			selectOptions: null
		})

		const emails = items.filter(i => i.type === "blocked").map(i => (i.type === "blocked" ? i.data.email : ""))

		expect(emails).toEqual(["amy@example.com", "mike@example.com", "zoe@example.com"])
	})

	it("in picker mode keeps only the contacts section and its header", () => {
		const selectOptions: SelectOptions = {
			id: "pick-1",
			multiple: true,
			userIdsToExclude: []
		}

		const items = buildContactSections({
			data: {
				contacts: [{ uuid: "c1", email: "c@example.com" }] as never,
				blocked: [{ uuid: "b1", email: "b@example.com" }] as never,
				incoming: [{ uuid: "i1", email: "i@example.com" }] as never,
				outgoing: [{ uuid: "o1", email: "o@example.com" }] as never
			},
			headerTitles,
			selectOptions
		})

		expect(items.map(i => i.type)).toEqual(["header", "contact"])
		expect(items[0]).toMatchObject({ type: "header", data: { id: "contacts" } })
	})
})

describe("filterContactSections", () => {
	const items = [
		{ type: "header", data: { id: "contacts", title: "Contacts" } },
		{ type: "contact", data: { uuid: "c1", email: "amy@example.com", nickName: "Amy" } },
		{ type: "contact", data: { uuid: "c2", email: "bob@example.com", nickName: null } }
	] as unknown as ContactListItemWithHeader[]

	it("returns the input unchanged when the query is empty or whitespace", () => {
		expect(filterContactSections({ items, searchQuery: "" })).toBe(items)
		expect(filterContactSections({ items, searchQuery: "   " })).toBe(items)
	})

	it("drops header rows from search results", () => {
		const filtered = filterContactSections({ items, searchQuery: "example" })

		expect(filtered.every(i => i.type !== "header")).toBe(true)
		expect(filtered).toHaveLength(2)
	})

	it("matches on email case-insensitively", () => {
		const filtered = filterContactSections({ items, searchQuery: "BOB" })

		expect(filtered).toHaveLength(1)
		expect(filtered[0]).toMatchObject({ data: { uuid: "c2" } })
	})

	it("matches on display name (nickName) when present", () => {
		const filtered = filterContactSections({ items, searchQuery: "amy" })

		expect(filtered).toHaveLength(1)
		expect(filtered[0]).toMatchObject({ data: { uuid: "c1" } })
	})

	it("returns nothing when no row matches", () => {
		expect(filterContactSections({ items, searchQuery: "zzz-nomatch" })).toHaveLength(0)
	})
})
