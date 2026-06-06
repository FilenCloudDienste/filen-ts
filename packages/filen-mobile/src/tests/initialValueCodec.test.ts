import { describe, it, expect } from "vitest"
import { encodeEditorInitialValue, decodeEditorInitialValue } from "@/components/textEditor/initialValueCodec"

describe("editor initial-value codec", () => {
	it("round-trips plain text", () => {
		const input = "Hello world"

		expect(decodeEditorInitialValue(encodeEditorInitialValue(input))).toBe(input)
	})

	it("round-trips HTML content with quotes, newlines and angle brackets (the injection-breaking case)", () => {
		const input = `<h1>Header1</h1>\n<p class="quill" style='color:red'>line "with" 'quotes'</p>\n<a href="https://x.test?a=1&b=2">l</a>`

		expect(decodeEditorInitialValue(encodeEditorInitialValue(input))).toBe(input)
	})

	it("round-trips unicode and emoji", () => {
		const input = "Grüße — 日本語 — 🚀🔐 —   "

		expect(decodeEditorInitialValue(encodeEditorInitialValue(input))).toBe(input)
	})

	it("produces only JSON/JS-injection-safe base64 characters", () => {
		const encoded = encodeEditorInitialValue(`<p>"quote" 'apos'\nnewline\\backslash</p>`)

		expect(encoded).toMatch(/^[A-Za-z0-9+/]*={0,2}$/)
	})

	it("encodes empty string to empty string and decodes it back", () => {
		expect(encodeEditorInitialValue("")).toBe("")
		expect(decodeEditorInitialValue("")).toBe("")
	})
})
