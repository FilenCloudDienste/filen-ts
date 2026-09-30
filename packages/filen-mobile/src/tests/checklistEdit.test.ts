import { describe, it, expect } from "vitest"
import { removeChecklistItem, type Checklist } from "@filen/shared"

// #80 caller contract: removeChecklistItem's single-item branch resets parsed BEFORE checking the
// id — an unmaterialized ghost id passed over a one-checked-item note would destroy the user's
// completed item. Item.removeItem guards on store presence; this pin documents WHY that guard
// must exist (the helper itself deliberately keeps the hide-off single-item reset semantics).
describe("removeChecklistItem ghost-id hazard (caller-guarded)", () => {
	it("single-item branch replaces the list without consulting the id — callers must pre-check membership", () => {
		const oneChecked: Checklist = [{ id: "a", checked: true, content: "important done item" }]
		const result = removeChecklistItem(oneChecked, "seed-ghost-0", "fresh")

		// The helper resets to one empty row — proof the component-level membership guard is
		// load-bearing, NOT an assertion that this call is legal.
		expect(result.changed).toBe(true)
		expect(result.next).toEqual([{ id: "fresh", checked: false, content: "" }])
	})
})
