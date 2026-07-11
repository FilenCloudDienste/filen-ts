import { describe, expect, it } from "vitest"
import { checklistRows } from "@/features/notes/components/reader/checklistReader.logic"

describe("checklistRows", () => {
	it("returns [] for undefined content", () => {
		expect(checklistRows(undefined)).toEqual([])
	})

	it("returns [] for empty-string content without invoking the parser", () => {
		expect(checklistRows("")).toEqual([])
	})

	it("parses a single unchecked item", () => {
		const rows = checklistRows('<ul data-checked="false"><li>Buy milk</li></ul>')

		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ checked: false, content: "Buy milk" })
		expect(typeof rows[0]?.id).toBe("string")
	})

	it("parses a single checked item", () => {
		const rows = checklistRows('<ul data-checked="true"><li>Done already</li></ul>')

		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ checked: true, content: "Done already" })
		expect(typeof rows[0]?.id).toBe("string")
	})

	it("preserves item order across mixed checked/unchecked groups", () => {
		const html = '<ul data-checked="false"><li>First</li><li>Second</li></ul><ul data-checked="true"><li>Third</li></ul>'
		const rows = checklistRows(html)

		expect(rows.map(r => r.content)).toEqual(["First", "Second", "Third"])
		expect(rows.map(r => r.checked)).toEqual([false, false, true])
	})

	it("returns [] for malformed HTML rather than throwing", () => {
		expect(() => checklistRows('<ul data-checked="false">no li here')).not.toThrow()
		expect(checklistRows('<ul data-checked="false">no li here')).toEqual([])
	})

	it("assigns a distinct id to every row", () => {
		const rows = checklistRows('<ul data-checked="false"><li>A</li><li>B</li></ul>')

		expect(new Set(rows.map(r => r.id)).size).toBe(rows.length)
	})
})
