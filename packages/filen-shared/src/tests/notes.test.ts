import { describe, it, expect } from "vitest"
import { createNotePreviewFromContentText } from "@filen/shared"

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

		it("decodes the text's entities after stripping tags", () => {
			expect(createNotePreviewFromContentText("rich", "<p>Tom &amp; Jerry</p>")).toBe("Tom & Jerry")
			expect(createNotePreviewFromContentText("rich", "<p>Fix &lt;Header&gt;</p><p><br></p><p>next</p>")).toBe("Fix <Header>")
		})

		it("keeps a typed entity literal (&amp;lt; reads as &lt;)", () => {
			expect(createNotePreviewFromContentText("rich", "<p>&amp;lt;</p>")).toBe("&lt;")
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

		it("decodes the row text instead of showing its entities", () => {
			const html = "<ul data-checked=\"false\"><li>Tom &amp; Jerry</li></ul>"

			expect(createNotePreviewFromContentText("checklist", html)).toBe("Tom & Jerry")
		})

		it("keeps an escaped tag-like row as text (decoded after tags are gone, not stripped)", () => {
			const html = "<ul data-checked=\"true\"><li>Fix &lt;Header&gt;</li></ul>"

			expect(createNotePreviewFromContentText("checklist", html)).toBe("Fix <Header>")
		})

		it("skips an empty first row (<br>) and previews the first row with text", () => {
			const html = "<ul data-checked=\"false\"><li><br></li><li>Milk</li></ul>"

			expect(createNotePreviewFromContentText("checklist", html)).toBe("Milk")
		})

		it("reads a row older mobile builds stored unescaped as it was typed", () => {
			const html = "<ul data-checked=\"false\"><li>cut&copy</li></ul>"

			expect(createNotePreviewFromContentText("checklist", html)).toBe("cut&copy")
		})

		it("truncates the row to 128 characters", () => {
			const html = `<ul data-checked="false"><li>${"&amp;".repeat(200)}</li></ul>`

			expect(createNotePreviewFromContentText("checklist", html)).toBe("&".repeat(128))
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
