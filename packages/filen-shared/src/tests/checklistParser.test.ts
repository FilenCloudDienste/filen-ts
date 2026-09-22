import { describe, it, expect } from "vitest"
import { checklistParser } from "@filen/shared"

describe("ChecklistParser", () => {
	it("should parse empty string to empty checklist", () => {
		const result = checklistParser.parse("")

		expect(result).toEqual([])
	})

	it("should parse single unchecked item", () => {
		const html = "<ul data-checked=\"false\"><li>Item 1</li></ul>"
		const result = checklistParser.parse(html)

		expect(result).toEqual([
			{
				id: expect.any(String),
				checked: false,
				content: "Item 1"
			}
		])
	})

	it("should parse single checked item", () => {
		const html = "<ul data-checked=\"true\"><li>Item 1</li></ul>"
		const result = checklistParser.parse(html)

		expect(result).toEqual([
			{
				id: expect.any(String),
				checked: true,
				content: "Item 1"
			}
		])
	})

	it("should stringify empty checklist to empty string", () => {
		const result = checklistParser.stringify([])

		expect(result).toBe("")
	})

	it("should stringify single unchecked item", () => {
		const checklist = [
			{
				id: "1",
				checked: false,
				content: "Item 1"
			}
		]

		const result = checklistParser.stringify(checklist)

		expect(result).toBe("<ul data-checked=\"false\"><li>Item 1</li></ul>")
	})

	it("should stringify single checked item", () => {
		const checklist = [
			{
				id: "1",
				checked: true,
				content: "Item 1"
			}
		]

		const result = checklistParser.stringify(checklist)

		expect(result).toBe("<ul data-checked=\"true\"><li>Item 1</li></ul>")
	})

	it("should parse and stringify multiple items correctly", () => {
		const html = "<ul data-checked=\"false\"><li>Item 1</li><li>Item 2</li></ul><ul data-checked=\"true\"><li>Item 3</li></ul>"
		const parsed = checklistParser.parse(html)
		const stringified = checklistParser.stringify(parsed)

		expect(stringified).toBe(html)
	})

	it("should handle items with empty content", () => {
		const html = "<ul data-checked=\"false\"><li><br></li><li>Item 2</li></ul>"
		const parsed = checklistParser.parse(html)

		expect(parsed).toEqual([
			{
				id: expect.any(String),
				checked: false,
				content: ""
			},
			{
				id: expect.any(String),
				checked: false,
				content: "Item 2"
			}
		])

		const stringified = checklistParser.stringify(parsed)

		expect(stringified).toBe(html)
	})

	it("should return empty checklist for malformed HTML", () => {
		const html = "<ul data-checked=\"false\">Item 1<li>Item 2"
		const parsed = checklistParser.parse(html)

		expect(parsed).toEqual([])
	})
})

describe("ChecklistParser — tag-like text losslessness", () => {
	// stringify -> (persist) -> parse must return the exact user text, even when it contains markup
	// characters. Without escaping, stringify writes the text raw into `<li>` and parse then strips or
	// splits it: "Fix <Header>" collapses to "Fix", and a literal `</li><li>` splits one row into two.
	// Each case here serializes a row, feeds the HTML back through the parser (the reopen path), and
	// asserts the content survives byte-for-byte.
	function roundTrip(content: string): string[] {
		const serialized = checklistParser.stringify([
			{
				id: "1",
				checked: false,
				content
			}
		])
		const parsed = checklistParser.parse(serialized)

		return parsed.map(item => item.content)
	}

	it("preserves a tag-like token instead of stripping it (\"Fix <Header>\" -> \"Fix\")", () => {
		expect(roundTrip("Fix <Header>")).toEqual(["Fix <Header>"])
	})

	it("preserves inline markup instead of unwrapping it (\"<b>bold</b>\" -> \"bold\")", () => {
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
