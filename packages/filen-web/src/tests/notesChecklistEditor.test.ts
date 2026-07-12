import { describe, expect, it } from "vitest"
import type { Checklist } from "@filen/utils"
import {
	parseChecklistSeed,
	serializeChecklist,
	addChecklistLine,
	removeChecklistItem,
	toggleChecklistItem,
	setChecklistItemContent,
	visibleChecklistRows
} from "@/features/notes/components/editor/checklistEditor.logic"

describe("parseChecklistSeed", () => {
	it("falls back to a single empty unchecked row for empty content", () => {
		const rows = parseChecklistSeed("", () => "fallback")

		expect(rows).toEqual([{ id: "fallback", checked: false, content: "" }])
	})

	it("falls back to a single empty row for unparseable HTML (parser returns [])", () => {
		const rows = parseChecklistSeed('<ul data-checked="false">no li', () => "fallback")

		expect(rows).toEqual([{ id: "fallback", checked: false, content: "" }])
	})

	it("parses existing rows and preserves checked state + order", () => {
		const rows = parseChecklistSeed(
			'<ul data-checked="false"><li>A</li><li>B</li></ul><ul data-checked="true"><li>C</li></ul>',
			() => "unused"
		)

		expect(rows.map(r => r.content)).toEqual(["A", "B", "C"])
		expect(rows.map(r => r.checked)).toEqual([false, false, true])
	})
})

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
		const rows = parseChecklistSeed(html, () => "unused")

		expect(serializeChecklist(rows)).toBe(html)
	})
})

describe("serializeChecklist / parseChecklistSeed — tag-like text losslessness", () => {
	// serialize → (persist) → parse must return the exact user text, even when it contains markup
	// characters. Without escaping, checklistParser.stringify writes the text raw into `<li>` and its
	// parser then strips or splits it: "Fix <Header>" collapses to "Fix", and a literal `</li><li>`
	// splits one row into two. Each case here serializes a row, feeds the HTML back through the parser
	// (the reopen path), and asserts the content survives byte-for-byte.
	function roundTrip(content: string): string[] {
		const serialized = serializeChecklist([{ id: "1", checked: false, content }])
		const parsed = parseChecklistSeed(serialized, () => "unused")

		return parsed.map(row => row.content)
	}

	it("preserves a tag-like token instead of stripping it ('Fix <Header>' → 'Fix')", () => {
		expect(roundTrip("Fix <Header>")).toEqual(["Fix <Header>"])
	})

	it("preserves inline markup instead of unwrapping it ('<b>bold</b>' → 'bold')", () => {
		expect(roundTrip("<b>bold</b>")).toEqual(["<b>bold</b>"])
	})

	it("keeps a literal </li><li> payload as ONE row instead of splitting into two", () => {
		expect(roundTrip("a</li><li>b")).toEqual(["a</li><li>b"])
	})

	it("preserves a literally typed entity (a typed &lt; survives as &lt;, not decoded to <)", () => {
		expect(roundTrip("&lt;")).toEqual(["&lt;"])
	})

	it("preserves a bare ampersand", () => {
		expect(roundTrip("Tom & Jerry")).toEqual(["Tom & Jerry"])
	})
})

describe("addChecklistLine", () => {
	it("appends a fresh empty row after a non-empty one and focuses it", () => {
		const rows: Checklist = [{ id: "1", checked: false, content: "hello" }]
		const result = addChecklistLine(rows, "1", "new")

		expect(result.changed).toBe(true)
		expect(result.next).toEqual([
			{ id: "1", checked: false, content: "hello" },
			{ id: "new", checked: false, content: "" }
		])
		expect(result.focusId).toBe("new")
	})

	it("reuses an already-empty next row instead of inserting another (no change)", () => {
		const rows: Checklist = [
			{ id: "1", checked: false, content: "hello" },
			{ id: "2", checked: false, content: "" }
		]
		const result = addChecklistLine(rows, "1", "new")

		expect(result.changed).toBe(false)
		expect(result.next).toBe(rows)
		expect(result.focusId).toBe("2")
	})
})

describe("removeChecklistItem", () => {
	it("removes a middle/last row and focuses the previous one", () => {
		const rows: Checklist = [
			{ id: "1", checked: false, content: "A" },
			{ id: "2", checked: false, content: "" }
		]
		const result = removeChecklistItem(rows, "2", "unused")

		expect(result.changed).toBe(true)
		expect(result.next).toEqual([{ id: "1", checked: false, content: "A" }])
		expect(result.focusId).toBe("1")
	})

	it("resets to one fresh empty row when the last remaining row is removed", () => {
		const rows: Checklist = [{ id: "1", checked: false, content: "" }]
		const result = removeChecklistItem(rows, "1", "fresh")

		expect(result.changed).toBe(true)
		expect(result.next).toEqual([{ id: "fresh", checked: false, content: "" }])
		expect(result.focusId).toBeNull()
	})

	it("is a no-op on the first row", () => {
		const rows: Checklist = [
			{ id: "1", checked: false, content: "" },
			{ id: "2", checked: false, content: "B" }
		]
		const result = removeChecklistItem(rows, "1", "unused")

		expect(result.changed).toBe(false)
		expect(result.next).toBe(rows)
	})
})

describe("toggleChecklistItem / setChecklistItemContent", () => {
	it("toggles only the targeted row's checked state without mutating the input", () => {
		const rows: Checklist = [
			{ id: "1", checked: false, content: "A" },
			{ id: "2", checked: false, content: "B" }
		]
		const next = toggleChecklistItem(rows, "2", true)

		expect(next).not.toBe(rows)
		expect(next.map(r => r.checked)).toEqual([false, true])
		expect(rows[1]?.checked).toBe(false)
	})

	it("sets only the targeted row's content", () => {
		const rows: Checklist = [{ id: "1", checked: false, content: "old" }]
		const next = setChecklistItemContent(rows, "1", "new")

		expect(next[0]?.content).toBe("new")
		expect(rows[0]?.content).toBe("old")
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
