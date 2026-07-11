// @vitest-environment jsdom
//
// exportContent's "rich" branch calls sanitizeRichTextHtml, which needs a real window/document
// (DOMPurify degrades to a passthrough without one — see notesSanitizeRichText.test.ts's own
// pragma) — so this whole file opts into jsdom rather than splitting the rich case into its own file.

import { describe, expect, it } from "vitest"
import type { NoteType } from "@filen/sdk-rs"
import {
	exportFilename,
	exportContent,
	exportMimeType,
	checklistToMarkdown,
	checklistToMarkdownLines,
	dedupeExportNames
} from "@/features/notes/lib/export.logic"

const FALLBACK = "Untitled note"

describe("exportFilename — per-type extension table", () => {
	const cases: { noteType: NoteType; title: string; expected: string }[] = [
		{ noteType: "text", title: "Groceries", expected: "Groceries.txt" },
		{ noteType: "md", title: "Groceries", expected: "Groceries.md" },
		{ noteType: "rich", title: "Groceries", expected: "Groceries.html" },
		{ noteType: "checklist", title: "Groceries", expected: "Groceries.md" },
		// code, no recognizable extension on the title: falls back to .txt like every other type.
		{ noteType: "code", title: "scratch", expected: "scratch.txt" }
	]

	it.each(cases)("$noteType -> $expected", ({ noteType, title, expected }) => {
		expect(exportFilename(title, noteType, FALLBACK)).toBe(expected)
	})
})

describe("exportFilename — code notes keep a title extension the CM editor already highlights", () => {
	it("a recognized language extension (py, in CODE_LANGUAGE_MAP) is kept, not doubled with .txt", () => {
		expect(exportFilename("script.py", "code", FALLBACK)).toBe("script.py")
	})

	it("an uppercase recognized extension is still recognized and kept as-is", () => {
		expect(exportFilename("Main.RS", "code", FALLBACK)).toBe("Main.RS")
	})

	it("an extension in CODE_EXTENSIONS but NOT the CM language map (e.g. mk) still falls back to .txt", () => {
		// reader.logic's codeMirrorTagForNote resolves "" (unhighlighted) for this extension too —
		// exportFilename intentionally reuses that SAME map, not the broader code-extension set.
		expect(exportFilename("readme.mk", "code", FALLBACK)).toBe("readme.mk.txt")
	})

	it("no extension at all falls back to .txt", () => {
		expect(exportFilename("Untitled", "code", FALLBACK)).toBe("Untitled.txt")
	})
})

describe("exportFilename — title already ends with the target extension", () => {
	it("does not double the extension for a matching-case title", () => {
		expect(exportFilename("notes.md", "md", FALLBACK)).toBe("notes.md")
	})

	it("does not double the extension for a differently-cased title", () => {
		expect(exportFilename("notes.MD", "md", FALLBACK)).toBe("notes.MD")
	})
})

describe("exportFilename — title sanitize + fallback", () => {
	it("falls back to the caller's fallback title when the note has no title", () => {
		expect(exportFilename(undefined, "text", FALLBACK)).toBe("Untitled note.txt")
	})

	it("falls back when the title is blank/whitespace-only", () => {
		expect(exportFilename("   ", "text", FALLBACK)).toBe("Untitled note.txt")
	})

	it("strips filesystem-unsafe characters from the title", () => {
		expect(exportFilename('a/b\\c"d', "text", FALLBACK)).toBe("a_b_c_d.txt")
	})
})

describe("exportMimeType", () => {
	it("maps .md to text/markdown", () => {
		expect(exportMimeType("notes.md")).toBe("text/markdown")
	})

	it("maps .html to text/html", () => {
		expect(exportMimeType("notes.html")).toBe("text/html")
	})

	it("falls back to text/plain for .txt and any other/no extension", () => {
		expect(exportMimeType("notes.txt")).toBe("text/plain")
		expect(exportMimeType("notes.py")).toBe("text/plain")
		expect(exportMimeType("notes")).toBe("text/plain")
	})
})

describe("checklistToMarkdownLines — round-trips checked state and order exactly", () => {
	it("empty content produces an empty line list", () => {
		expect(checklistToMarkdownLines("")).toEqual([])
		expect(checklistToMarkdown("")).toBe("")
	})

	it("a single unchecked item", () => {
		const html = '<ul data-checked="false"><li>Buy milk</li></ul>'
		expect(checklistToMarkdownLines(html)).toEqual(["- [ ] Buy milk"])
	})

	it("a single checked item", () => {
		const html = '<ul data-checked="true"><li>Already done</li></ul>'
		expect(checklistToMarkdownLines(html)).toEqual(["- [x] Already done"])
	})

	it("preserves item order across a mixed run", () => {
		const html = '<ul data-checked="false"><li>First</li><li>Second</li></ul><ul data-checked="true"><li>Third</li></ul>'
		expect(checklistToMarkdownLines(html)).toEqual(["- [ ] First", "- [ ] Second", "- [x] Third"])
	})

	// checklistParser.parse flattens every <ul> run in document order — a checked item followed by an
	// unchecked one followed by ANOTHER checked one (two separate checked "runs") must stay in that
	// exact order, not get grouped/reordered by checked state.
	it("preserves order across multiple runs of the same checked state (no re-grouping)", () => {
		const html =
			'<ul data-checked="true"><li>Done A</li></ul>' +
			'<ul data-checked="false"><li>Todo</li></ul>' +
			'<ul data-checked="true"><li>Done B</li></ul>'
		expect(checklistToMarkdownLines(html)).toEqual(["- [x] Done A", "- [ ] Todo", "- [x] Done B"])
	})

	it("an empty item still emits its own line rather than being dropped", () => {
		const html = '<ul data-checked="false"><li><br></li><li>Second</li></ul>'
		expect(checklistToMarkdownLines(html)).toEqual(["- [ ] ", "- [ ] Second"])
	})

	it("malformed HTML parses to no lines (checklistParser's own empty-checklist fallback)", () => {
		expect(checklistToMarkdownLines('<ul data-checked="false">Item 1<li>Item 2')).toEqual([])
	})
})

describe("exportContent — per-type transform", () => {
	it("text/md/code pass raw content through byte-for-byte", () => {
		const raw = "line one\nline **two**\n<b>not stripped</b>"
		expect(exportContent("text", raw)).toBe(raw)
		expect(exportContent("md", raw)).toBe(raw)
		expect(exportContent("code", raw)).toBe(raw)
	})

	it("checklist becomes its markdown task lines", () => {
		const html = '<ul data-checked="true"><li>Done</li></ul>'
		expect(exportContent("checklist", html)).toBe("- [x] Done")
	})

	it("rich is sanitized through the same allowlist the editor/reader use — a hostile fixture loses its script", () => {
		const hostile = '<p>Hello <strong>rich</strong></p><script>window.__xss = true</script><img src="x" onerror="alert(1)">'
		const out = exportContent("rich", hostile)

		expect(out).toContain("<strong>rich</strong>")
		expect(out).not.toContain("<script")
		expect(out).not.toContain("onerror")
	})
})

describe("dedupeExportNames — collision suffixing", () => {
	it("leaves unique names untouched", () => {
		expect(dedupeExportNames(["a.txt", "b.txt", "c.md"])).toEqual(["a.txt", "b.txt", "c.md"])
	})

	it("suffixes repeats with ' (2)', ' (3)', ... before the extension", () => {
		expect(dedupeExportNames(["a.txt", "a.txt", "a.txt"])).toEqual(["a.txt", "a (2).txt", "a (3).txt"])
	})

	it("suffixes a name with no extension the same way", () => {
		expect(dedupeExportNames(["a", "a"])).toEqual(["a", "a (2)"])
	})

	it("tracks each distinct name's own collision count independently", () => {
		expect(dedupeExportNames(["a.txt", "b.txt", "a.txt", "b.txt", "a.txt"])).toEqual([
			"a.txt",
			"b.txt",
			"a (2).txt",
			"b (2).txt",
			"a (3).txt"
		])
	})

	it("returns a fresh array, same length as the input, empty input stays empty", () => {
		const input: string[] = []
		expect(dedupeExportNames(input)).toEqual([])
		expect(dedupeExportNames(input)).not.toBe(input)
	})
})
