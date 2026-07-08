import { describe, expect, it } from "vitest"
import { EMPTY_CONTACT_SELECTION, removeFromContactSelection, toggleContactSelection } from "@/lib/contacts/selection"

describe("toggleContactSelection", () => {
	it("adds a uuid that is not yet selected in the given section", () => {
		const next = toggleContactSelection(EMPTY_CONTACT_SELECTION, "contacts", "a")

		expect(next.contacts.has("a")).toBe(true)
	})

	it("removes a uuid that is already selected in the given section", () => {
		const selected = toggleContactSelection(EMPTY_CONTACT_SELECTION, "contacts", "a")
		const next = toggleContactSelection(selected, "contacts", "a")

		expect(next.contacts.has("a")).toBe(false)
	})

	it("does not mutate the input selection (returns a new object)", () => {
		const next = toggleContactSelection(EMPTY_CONTACT_SELECTION, "contacts", "a")

		expect(EMPTY_CONTACT_SELECTION.contacts.has("a")).toBe(false)
		expect(next).not.toBe(EMPTY_CONTACT_SELECTION)
	})

	it("only touches the targeted section, leaving every other section's bucket untouched (same reference)", () => {
		const next = toggleContactSelection(EMPTY_CONTACT_SELECTION, "requests", "a")

		expect(next.pending).toBe(EMPTY_CONTACT_SELECTION.pending)
		expect(next.contacts).toBe(EMPTY_CONTACT_SELECTION.contacts)
		expect(next.blocked).toBe(EMPTY_CONTACT_SELECTION.blocked)
	})

	it("toggling the same uuid twice restores the original membership", () => {
		let selection = toggleContactSelection(EMPTY_CONTACT_SELECTION, "blocked", "a")
		selection = toggleContactSelection(selection, "blocked", "a")

		expect(selection.blocked.has("a")).toBe(false)
	})
})

describe("removeFromContactSelection", () => {
	it("drops only the given uuids from the targeted section", () => {
		let selection = toggleContactSelection(EMPTY_CONTACT_SELECTION, "contacts", "a")
		selection = toggleContactSelection(selection, "contacts", "b")

		const next = removeFromContactSelection(selection, "contacts", ["a"])

		expect(next.contacts.has("a")).toBe(false)
		expect(next.contacts.has("b")).toBe(true)
	})

	it("leaves other sections untouched", () => {
		let selection = toggleContactSelection(EMPTY_CONTACT_SELECTION, "contacts", "a")
		selection = toggleContactSelection(selection, "requests", "r1")

		const next = removeFromContactSelection(selection, "contacts", ["a"])

		expect(next.requests.has("r1")).toBe(true)
	})

	it("returns the same reference when the uuid list is empty", () => {
		const next = removeFromContactSelection(EMPTY_CONTACT_SELECTION, "contacts", [])

		expect(next).toBe(EMPTY_CONTACT_SELECTION)
	})

	it("returns the same reference when none of the given uuids were selected", () => {
		const next = removeFromContactSelection(EMPTY_CONTACT_SELECTION, "contacts", ["ghost"])

		expect(next).toBe(EMPTY_CONTACT_SELECTION)
	})
})
