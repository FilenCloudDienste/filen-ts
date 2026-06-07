import { describe, it, expect, beforeEach } from "vitest"
import useContactsStore, { type ContactListItem } from "@/features/contacts/store/useContacts.store"

// The store only keys items by `${type}:${data.uuid}`, so a minimal shape is enough.
const makeContact = (uuid: string): ContactListItem => ({ type: "contact", data: { uuid } }) as unknown as ContactListItem

beforeEach(() => {
	useContactsStore.setState({ selectedContacts: [], bulkMode: false })
})

describe("useContactsStore — bulk mode auto-exit", () => {
	it("exits bulk mode when the last selected contact is toggled off", () => {
		const a = makeContact("a")

		useContactsStore.getState().setBulkMode(true)
		useContactsStore.getState().toggleSelectedContact(a)

		expect(useContactsStore.getState().bulkMode).toBe(true)
		expect(useContactsStore.getState().selectedContacts).toHaveLength(1)

		useContactsStore.getState().toggleSelectedContact(a)

		expect(useContactsStore.getState().selectedContacts).toHaveLength(0)
		expect(useContactsStore.getState().bulkMode).toBe(false)
	})

	it("exits bulk mode when setSelectedContacts empties the selection", () => {
		useContactsStore.getState().setBulkMode(true)
		useContactsStore.getState().setSelectedContacts([makeContact("a")])

		expect(useContactsStore.getState().bulkMode).toBe(true)

		useContactsStore.getState().setSelectedContacts([])

		expect(useContactsStore.getState().bulkMode).toBe(false)
	})

	it("stays in bulk mode while at least one contact remains selected", () => {
		const a = makeContact("a")
		const b = makeContact("b")

		useContactsStore.getState().setBulkMode(true)
		useContactsStore.getState().setSelectedContacts([a, b])

		useContactsStore.getState().toggleSelectedContact(a)

		expect(useContactsStore.getState().selectedContacts).toHaveLength(1)
		expect(useContactsStore.getState().bulkMode).toBe(true)
	})

	it("leaves bulkMode false when emptying a selection that was never in bulk mode", () => {
		const a = makeContact("a")

		useContactsStore.getState().toggleSelectedContact(a)

		expect(useContactsStore.getState().bulkMode).toBe(false)

		useContactsStore.getState().toggleSelectedContact(a)

		expect(useContactsStore.getState().selectedContacts).toHaveLength(0)
		expect(useContactsStore.getState().bulkMode).toBe(false)
	})
})
