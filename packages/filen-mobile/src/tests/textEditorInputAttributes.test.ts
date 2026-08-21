import { describe, it, expect } from "vitest"

import { proseContentAttributes } from "@/components/textEditor/inputAttributes"

describe("proseContentAttributes", () => {
	it("hands capitalization, autocorrect and spellcheck back to the platform for plain-text notes", () => {
		expect(proseContentAttributes("text")).toEqual({
			autocapitalize: "sentences",
			autocorrect: "on",
			spellcheck: "true"
		})
	})

	it("treats markdown as prose too — it is the type the filename-based gate would have missed", () => {
		expect(proseContentAttributes("markdown")).toEqual({
			autocapitalize: "sentences",
			autocorrect: "on",
			spellcheck: "true"
		})
	})

	it("leaves code notes on CodeMirror's own defaults", () => {
		expect(proseContentAttributes("code")).toBeNull()
	})

	it("leaves richtext alone — Quill renders it, and it already follows the platform", () => {
		expect(proseContentAttributes("richtext")).toBeNull()
	})

	// Upstream disables writingsuggestions because Safari's completions corrupt the document. That is
	// a correctness workaround rather than a user preference, so it must never join this set.
	it("never re-enables writingsuggestions", () => {
		for (const type of ["text", "markdown", "code", "richtext"] as const) {
			expect(Object.keys(proseContentAttributes(type) ?? {})).not.toContain("writingsuggestions")
		}
	})
})
