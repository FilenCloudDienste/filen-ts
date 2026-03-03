import { describe, it, expect } from "vitest"
import { createNotePreviewFromContentText } from "../notes"

describe("createNotePreviewFromContentText", () => {
	describe("rich text", () => {
		it("should strip HTML tags and return first line", () => {
			const result = createNotePreviewFromContentText("rich", "<p>Hello World</p>\n<p>Second line</p>")

			expect(result).toBe("Hello World")
		})

		it("should split on <p><br></p> when present", () => {
			const result = createNotePreviewFromContentText("rich", "<p>First paragraph</p><p><br></p><p>Second paragraph</p>")

			expect(result).toBe("First paragraph")
		})

		it("should truncate to 128 characters", () => {
			const longText = "<p>" + "a".repeat(200) + "</p>"
			const result = createNotePreviewFromContentText("rich", longText)

			expect(result.length).toBeLessThanOrEqual(128)
		})
	})

	describe("checklist", () => {
		it("should extract first non-empty list item", () => {
			const html = "<ul data-checked=\"false\"><li>First item</li><li>Second item</li></ul>"
			const result = createNotePreviewFromContentText("checklist", html)

			expect(result).toBe("First item")
		})

		it("should skip empty items", () => {
			const html = "<ul data-checked=\"false\"><li></li><li>Actual item</li></ul>"
			const result = createNotePreviewFromContentText("checklist", html)

			expect(result).toBe("Actual item")
		})

		it("should return empty string for empty checklist", () => {
			const html = "<ul data-checked=\"false\"><li></li></ul>"
			const result = createNotePreviewFromContentText("checklist", html)

			expect(result).toBe("")
		})
	})

	describe("other types", () => {
		it("should strip tags and return first line", () => {
			const result = createNotePreviewFromContentText("other", "Line 1\nLine 2\nLine 3")

			expect(result).toBe("Line 1")
		})

		it("should truncate to 128 characters", () => {
			const result = createNotePreviewFromContentText("other", "a".repeat(200))

			expect(result.length).toBeLessThanOrEqual(128)
		})
	})

	describe("edge cases", () => {
		it("should return empty string for undefined content", () => {
			expect(createNotePreviewFromContentText("rich")).toBe("")
		})

		it("should return empty string for empty content", () => {
			expect(createNotePreviewFromContentText("rich", "")).toBe("")
		})
	})
})
