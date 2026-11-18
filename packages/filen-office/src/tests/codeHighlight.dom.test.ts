// @vitest-environment happy-dom

import { describe, expect, it } from "vitest"
import { HIGHLIGHT_MAX_CHARS, codeLanguageIdFor, highlightCodeRuns, mountCodeHighlightStyle } from "@filen/office/dom/code"

// Highlighting outside an editor: runs that put the text back exactly, with the editor's classes; nothing for text past
// the cap or a language without a parser.

describe("highlightCodeRuns", () => {
	it("splits code into runs with the editor's classes, and loses no character", () => {
		const text = "def f(x):\n    return x + 1  # one\n"
		const runs = highlightCodeRuns(text, "python")

		expect(runs?.map(run => run.text).join("")).toBe(text)
		expect(runs?.find(run => run.text === "def")?.classes).not.toBe("")
		expect(runs?.find(run => run.text.includes("# one"))?.classes).not.toBe("")
	})

	it("leaves text past the cap plain", () => {
		expect(highlightCodeRuns("x".repeat(HIGHLIGHT_MAX_CHARS + 1), "python")).toBeNull()
	})

	it("resolves a language by id or extension", () => {
		expect(codeLanguageIdFor("Python")).toBe("python")
		expect(codeLanguageIdFor(".py")).toBe("python")
		expect(codeLanguageIdFor("ts")).toBe("typescript")
		expect(codeLanguageIdFor("no-such-language")).toBeNull()
	})

	it("adds the highlight rules to a document once", () => {
		mountCodeHighlightStyle(document)
		mountCodeHighlightStyle(document)

		expect(document.head.querySelectorAll("style")).toHaveLength(1)
	})
})
