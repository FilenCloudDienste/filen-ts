import { describe, it, expect, vi } from "vitest"
import { addChecklistLine, removeChecklistItem, checklistParser, type Checklist } from "@filen/shared"

const base: Checklist = [
	{ id: "a", checked: false, content: "one" },
	{ id: "b", checked: false, content: "two" },
	{ id: "c", checked: false, content: "three" }
]

// Regression for bugs #2 (Backspace delete never synced) and #33 (Enter add not synced until next
// keystroke). The component applies the transform to its store then calls
// onChange(checklistParser.stringify(latestParsed)). These assert that flow propagates the edit.
describe("checklist edit -> onChange propagation", () => {
	function applyAndPropagate(parsed: Checklist, result: ReturnType<typeof addChecklistLine>, onChange: (v: string) => void) {
		if (!result.changed) {
			return parsed
		}

		// Mirrors item.tsx: write store, then propagate the freshly-written state stringified.
		const next = result.next

		onChange(checklistParser.stringify(next))

		return next
	}

	it("fires onChange with the post-delete content (deletion is persisted, bug #2)", () => {
		const onChange = vi.fn()
		const result = removeChecklistItem(base, "c", "new")

		applyAndPropagate(base, result, onChange)

		expect(onChange).toHaveBeenCalledTimes(1)

		const synced = checklistParser.stringify(base.filter(i => i.id !== "c"))

		expect(onChange).toHaveBeenCalledWith(synced)
		// The dropped item must not survive in what gets synced.
		expect(synced).not.toContain("three")
	})

	it("fires onChange immediately when Enter adds a row (bug #33)", () => {
		const onChange = vi.fn()
		const result = addChecklistLine(base, "a", "new")

		applyAndPropagate(base, result, onChange)

		expect(onChange).toHaveBeenCalledTimes(1)
		expect(onChange).toHaveBeenCalledWith(checklistParser.stringify(result.next))
	})

	it("does NOT fire onChange when nothing changed (first-row backspace, dedup add)", () => {
		const onChange = vi.fn()

		applyAndPropagate(base, removeChecklistItem(base, "a", "new"), onChange)

		const withEmpty: Checklist = [
			{ id: "a", checked: false, content: "one" },
			{ id: "b", checked: false, content: "" }
		]

		applyAndPropagate(withEmpty, addChecklistLine(withEmpty, "a", "new"), onChange)

		expect(onChange).not.toHaveBeenCalled()
	})
})

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
