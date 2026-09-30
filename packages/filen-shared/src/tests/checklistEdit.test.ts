import { describe, it, expect } from "vitest"
import { addChecklistLine, removeChecklistItem, patchChecklistItem, type Checklist } from "@filen/shared"

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

	// The single-item branch never consults the id, so callers must check membership first or a
	// stray id wipes the only (possibly checked) row.
	it("resets a single remaining item even when the id is not in the list", () => {
		const single: Checklist = [{ id: "a", checked: true, content: "done" }]
		const result = removeChecklistItem(single, "ghost", "fresh")

		expect(result.changed).toBe(true)
		expect(result.next).toEqual([{ id: "fresh", checked: false, content: "" }])
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

describe("patchChecklistItem", () => {
	it("patches only the targeted row's checked state without mutating the input", () => {
		const rows: Checklist = [
			{ id: "1", checked: false, content: "A" },
			{ id: "2", checked: false, content: "B" }
		]
		const next = patchChecklistItem(rows, "2", { checked: true })

		expect(next).not.toBe(rows)
		expect(next.map(r => r.checked)).toEqual([false, true])
		expect(rows[1]?.checked).toBe(false)
	})

	it("patches only the targeted row's content", () => {
		const rows: Checklist = [{ id: "1", checked: false, content: "old" }]
		const next = patchChecklistItem(rows, "1", { content: "new" })

		expect(next[0]?.content).toBe("new")
		expect(rows[0]?.content).toBe("old")
	})
})
