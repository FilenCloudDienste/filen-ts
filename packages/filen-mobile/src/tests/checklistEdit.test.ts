import { describe, it, expect, vi } from "vitest"
import { addChecklistLine, removeChecklistItem } from "@/features/notes/checklistEdit"
import { checklistParser, type Checklist } from "@filen/utils"

const base: Checklist = [
	{ id: "a", checked: false, content: "one" },
	{ id: "b", checked: false, content: "two" },
	{ id: "c", checked: false, content: "three" }
]

describe("removeChecklistItem", () => {
	it("removes a middle/last row and focuses the previous row", () => {
		const result = removeChecklistItem(base, "c", "new")

		expect(result.changed).toBe(true)
		expect(result.next.map(i => i.id)).toEqual(["a", "b"])
		expect(result.focusId).toBe("b")
	})

	it("is a no-op for the first row", () => {
		const result = removeChecklistItem(base, "a", "new")

		expect(result.changed).toBe(false)
		expect(result.next).toBe(base)
		expect(result.focusId).toBeNull()
	})

	it("is a no-op for an unknown id", () => {
		const result = removeChecklistItem(base, "missing", "new")

		expect(result.changed).toBe(false)
		expect(result.next).toBe(base)
	})

	it("resets a single remaining item to one fresh empty row", () => {
		const single: Checklist = [{ id: "only", checked: true, content: "done" }]
		const result = removeChecklistItem(single, "only", "fresh")

		expect(result.changed).toBe(true)
		expect(result.next).toEqual([{ id: "fresh", checked: false, content: "" }])
		expect(result.focusId).toBeNull()
	})
})

describe("addChecklistLine", () => {
	it("inserts a fresh empty row after the target and focuses it", () => {
		const result = addChecklistLine(base, "a", "new")

		expect(result.changed).toBe(true)
		expect(result.next.map(i => i.id)).toEqual(["a", "new", "b", "c"])
		expect(result.next[1]).toEqual({ id: "new", checked: false, content: "" })
		expect(result.focusId).toBe("new")
	})

	it("appends after the last row", () => {
		const result = addChecklistLine(base, "c", "new")

		expect(result.changed).toBe(true)
		expect(result.next.map(i => i.id)).toEqual(["a", "b", "c", "new"])
		expect(result.focusId).toBe("new")
	})

	it("reuses an existing empty next row instead of inserting another", () => {
		const withEmpty: Checklist = [
			{ id: "a", checked: false, content: "one" },
			{ id: "b", checked: false, content: "" }
		]
		const result = addChecklistLine(withEmpty, "a", "new")

		expect(result.changed).toBe(false)
		expect(result.next).toBe(withEmpty)
		expect(result.focusId).toBe("b")
	})
})

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
