import { describe, it, expect } from "vitest"
import { addChecklistLine, removeChecklistItem, type Checklist } from "@filen/shared"

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
