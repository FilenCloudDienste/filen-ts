import { describe, expect, it } from "vitest"
import {
	EMPTY_CONTACT_SELECTION,
	EMPTY_CONTACT_SELECTION_STATE,
	contactSelectionSize,
	nextContactSelection,
	removeFromContactSelection,
	resolveSelectedContacts,
	toggleContactSelection,
	type ContactRecords,
	type ContactSelectionState
} from "@/features/contacts/lib/selection"

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

describe("contactSelectionSize", () => {
	it("is zero for an empty selection", () => {
		expect(contactSelectionSize(EMPTY_CONTACT_SELECTION)).toBe(0)
	})

	it("counts every section's bucket", () => {
		const withRequest = toggleContactSelection(EMPTY_CONTACT_SELECTION, "requests", "a")
		const withContacts = toggleContactSelection(toggleContactSelection(withRequest, "contacts", "b"), "contacts", "c")

		expect(contactSelectionSize(withContacts)).toBe(3)
	})
})

// The bulk bar's contents AND the gate that mounts it both read this, so a uuid whose record is gone
// (accepted request, removed contact) can never keep an empty bar floating over the list.
describe("resolveSelectedContacts", () => {
	function records(uuids: { requests?: string[]; pending?: string[]; contacts?: string[]; blocked?: string[] } = {}) {
		return {
			requests: (uuids.requests ?? []).map(uuid => ({ uuid })),
			pending: (uuids.pending ?? []).map(uuid => ({ uuid })),
			contacts: (uuids.contacts ?? []).map(uuid => ({ uuid })),
			blocked: (uuids.blocked ?? []).map(uuid => ({ uuid }))
		} as unknown as ContactRecords
	}

	it("keeps only the selected records that still exist", () => {
		const selection = toggleContactSelection(toggleContactSelection(EMPTY_CONTACT_SELECTION, "requests", "a"), "requests", "b")
		const resolved = resolveSelectedContacts(records({ requests: ["b"] }), selection)

		expect(resolved.requests.map(request => request.uuid)).toEqual(["b"])
		expect(resolved.total).toBe(1)
	})

	it("totals nothing once every selected record has left its section", () => {
		const selection = toggleContactSelection(toggleContactSelection(EMPTY_CONTACT_SELECTION, "requests", "a"), "requests", "b")

		expect(resolveSelectedContacts(records(), selection).total).toBe(0)
	})

	it("sums across sections", () => {
		const selection = toggleContactSelection(toggleContactSelection(EMPTY_CONTACT_SELECTION, "contacts", "a"), "blocked", "b")
		const resolved = resolveSelectedContacts(records({ contacts: ["a", "z"], blocked: ["b"] }), selection)

		expect(resolved.contacts.map(contact => contact.uuid)).toEqual(["a"])
		expect(resolved.blocked.map(contact => contact.uuid)).toEqual(["b"])
		expect(resolved.total).toBe(2)
	})
})

const CONTACT_UUIDS = ["a", "b", "c", "d", "e"]

function plainClick(state: ContactSelectionState, index: number, uuids = CONTACT_UUIDS): ContactSelectionState {
	return nextContactSelection(state, { section: "contacts", uuids, index, shift: false, toggle: false })
}

function shiftClick(state: ContactSelectionState, index: number, uuids = CONTACT_UUIDS): ContactSelectionState {
	return nextContactSelection(state, { section: "contacts", uuids, index, shift: true, toggle: false })
}

function toggleClick(state: ContactSelectionState, index: number, uuids = CONTACT_UUIDS): ContactSelectionState {
	return nextContactSelection(state, { section: "contacts", uuids, index, shift: false, toggle: true })
}

describe("nextContactSelection", () => {
	it("plain click selects only that row and clears every other section", () => {
		const withRequest = { selection: toggleContactSelection(EMPTY_CONTACT_SELECTION, "requests", "r1"), anchor: null }
		const next = plainClick(withRequest, 2)

		expect([...next.selection.contacts]).toEqual(["c"])
		expect(next.selection.requests.size).toBe(0)
	})

	it("plain click sets the anchor", () => {
		expect(plainClick(EMPTY_CONTACT_SELECTION_STATE, 1).anchor).toEqual({ section: "contacts", uuid: "b" })
	})

	it("ctrl/cmd toggle adds without clearing other sections", () => {
		const withRequest = { selection: toggleContactSelection(EMPTY_CONTACT_SELECTION, "requests", "r1"), anchor: null }
		const next = toggleClick(toggleClick(withRequest, 0), 2)

		expect([...next.selection.contacts]).toEqual(["a", "c"])
		expect([...next.selection.requests]).toEqual(["r1"])
	})

	it("ctrl/cmd toggle on an already-selected row removes it", () => {
		const next = toggleClick(plainClick(EMPTY_CONTACT_SELECTION_STATE, 0), 0)

		expect(next.selection.contacts.size).toBe(0)
	})

	it("shift after a plain click selects the inclusive range, ascending", () => {
		const next = shiftClick(plainClick(EMPTY_CONTACT_SELECTION_STATE, 1), 3)

		expect([...next.selection.contacts]).toEqual(["b", "c", "d"])
	})

	it("shift selects the same range when clicked backwards", () => {
		const next = shiftClick(plainClick(EMPTY_CONTACT_SELECTION_STATE, 3), 1)

		expect([...next.selection.contacts].sort()).toEqual(["b", "c", "d"])
	})

	it("two consecutive shift clicks both range from the ORIGINAL anchor", () => {
		const anchored = plainClick(EMPTY_CONTACT_SELECTION_STATE, 1)
		const next = shiftClick(shiftClick(anchored, 3), 2)

		expect([...next.selection.contacts]).toEqual(["b", "c"])
		expect(next.anchor).toEqual({ section: "contacts", uuid: "b" })
	})

	it("shift with an anchor in another section collapses to a plain select", () => {
		const foreign: ContactSelectionState = { selection: EMPTY_CONTACT_SELECTION, anchor: { section: "requests", uuid: "r1" } }
		const next = shiftClick(foreign, 3)

		expect([...next.selection.contacts]).toEqual(["d"])
		expect(next.anchor).toEqual({ section: "contacts", uuid: "d" })
	})

	it("shift with an anchor whose uuid is gone collapses to a plain select", () => {
		const stale: ContactSelectionState = { selection: EMPTY_CONTACT_SELECTION, anchor: { section: "contacts", uuid: "gone" } }
		const next = shiftClick(stale, 2)

		expect([...next.selection.contacts]).toEqual(["c"])
	})

	it("a range replaces a selection held in another section", () => {
		const withBlocked = { selection: toggleContactSelection(EMPTY_CONTACT_SELECTION, "blocked", "x"), anchor: null }
		const next = shiftClick(plainClick(withBlocked, 0), 1)

		expect([...next.selection.contacts]).toEqual(["a", "b"])
		expect(next.selection.blocked.size).toBe(0)
	})

	it("ignores a click on an index that is not in the section", () => {
		const state = plainClick(EMPTY_CONTACT_SELECTION_STATE, 0)

		expect(plainClick(state, 99)).toBe(state)
	})
})
