import { describe, it, expect } from "vitest"
import { checklistParser } from "@filen/utils"

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
