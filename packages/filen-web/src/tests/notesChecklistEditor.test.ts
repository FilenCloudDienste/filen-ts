import { describe, expect, it } from "vitest"
import { checklistParser, type Checklist } from "@filen/shared"
import { serializeChecklist, visibleChecklistRows } from "@/features/notes/components/editor/checklistEditor.logic"

describe("serializeChecklist — multi-run consecutive-state grouping", () => {
	it("groups consecutive same-checked rows under one <ul> and splits on state change", () => {
		const rows: Checklist = [
			{ id: "1", checked: false, content: "A" },
			{ id: "2", checked: false, content: "B" },
			{ id: "3", checked: true, content: "C" },
			{ id: "4", checked: false, content: "D" }
		]

		expect(serializeChecklist(rows)).toBe(
			'<ul data-checked="false"><li>A</li><li>B</li></ul>' +
				'<ul data-checked="true"><li>C</li></ul>' +
				'<ul data-checked="false"><li>D</li></ul>'
		)
	})

	it("serializes an empty list to the empty string", () => {
		expect(serializeChecklist([])).toBe("")
	})

	it("round-trips through parse → serialize", () => {
		const html = '<ul data-checked="false"><li>one</li><li>two</li></ul><ul data-checked="true"><li>three</li></ul>'
		const rows = checklistParser.parse(html)

		expect(serializeChecklist(rows)).toBe(html)
	})
})

describe("visibleChecklistRows — hide-completed render filter", () => {
	const rows: Checklist = [
		{ id: "1", checked: false, content: "A" },
		{ id: "2", checked: true, content: "B" },
		{ id: "3", checked: false, content: "C" },
		{ id: "4", checked: true, content: "D" }
	]

	it("returns the SAME array reference when hideCompleted is off (no filtering)", () => {
		expect(visibleChecklistRows(rows, false)).toBe(rows)
	})

	it("drops checked rows, preserving the order of what remains, when hideCompleted is on", () => {
		expect(visibleChecklistRows(rows, true).map(r => r.id)).toEqual(["1", "3"])
	})

	it("never mutates the input list either way", () => {
		visibleChecklistRows(rows, true)

		expect(rows.map(r => r.checked)).toEqual([false, true, false, true])
	})
})
