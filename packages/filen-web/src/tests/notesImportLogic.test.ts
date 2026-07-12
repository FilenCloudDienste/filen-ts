// @vitest-environment jsdom
//
// sanitizeImportedContent's "rich" branch calls sanitizeRichTextHtml, which needs a real window/document
// (DOMPurify degrades to a passthrough without one) — same pragma as notesExportLogic.test.ts, which
// shares this exact rationale for export's own rich branch.

import { describe, expect, it } from "vitest"
import { detectImportNoteType, importAcceptAttribute, sanitizeImportedContent, titleFromFilename } from "@/features/notes/lib/import.logic"

describe("detectImportNoteType — extension-based, widened to accept text/markdown/html/code files", () => {
	it("maps .txt to text", () => {
		expect(detectImportNoteType("shopping.txt")).toBe("text")
	})

	it("maps .md and .markdown to md", () => {
		expect(detectImportNoteType("notes.md")).toBe("md")
		expect(detectImportNoteType("notes.markdown")).toBe("md")
	})

	it("maps .html/.htm/.html5 to rich, NOT code — even though html has a CodeMirror grammar too", () => {
		expect(detectImportNoteType("page.html")).toBe("rich")
		expect(detectImportNoteType("page.htm")).toBe("rich")
		expect(detectImportNoteType("page.html5")).toBe("rich")
	})

	it("md also has a CodeMirror grammar, but the markdown check wins (checked before the code fallback)", () => {
		expect(detectImportNoteType("readme.md")).toBe("md")
	})

	it("maps a recognized code extension to code", () => {
		expect(detectImportNoteType("script.py")).toBe("code")
		expect(detectImportNoteType("main.rs")).toBe("code")
	})

	it("returns undefined for an unrecognized extension", () => {
		expect(detectImportNoteType("archive.zip")).toBeUndefined()
	})

	it("returns undefined for a file with no extension", () => {
		expect(detectImportNoteType("README")).toBeUndefined()
	})

	it("never auto-detects checklist (reverse-engineering a task list back into a checklist is lossy/ambiguous)", () => {
		// A checklist-shaped .md task-list file still becomes a plain md note, never a checklist.
		expect(detectImportNoteType("tasks.md")).toBe("md")
	})
})

describe("importAcceptAttribute — the file input's accept union", () => {
	it("includes every extension the detector recognizes", () => {
		const accept = importAcceptAttribute()

		for (const ext of [".txt", ".md", ".markdown", ".html", ".htm", ".html5", ".py", ".rs", ".ts"]) {
			expect(accept).toContain(ext)
		}
	})

	it("is a non-empty comma-separated list", () => {
		const accept = importAcceptAttribute()

		expect(accept.length).toBeGreaterThan(0)
		expect(accept.split(",").every(part => part.startsWith("."))).toBe(true)
	})
})

describe("sanitizeImportedContent — never trusts a file's raw HTML", () => {
	it("passes text/md/code content through byte-faithfully", () => {
		expect(sanitizeImportedContent("text", "hello <b>world</b>")).toBe("hello <b>world</b>")
		expect(sanitizeImportedContent("md", "# heading")).toBe("# heading")
		expect(sanitizeImportedContent("code", "<script>bad()</script>")).toBe("<script>bad()</script>")
	})

	it("re-sanitizes rich content through the SAME allowlist the live editor/reader/export path uses", () => {
		const withScript = '<p>hello</p><script>alert(1)</script><img src=x onerror="alert(2)">'

		const sanitized = sanitizeImportedContent("rich", withScript)

		expect(sanitized).toContain("<p>hello</p>")
		expect(sanitized).not.toContain("<script>")
		expect(sanitized).not.toContain("onerror")
	})
})

describe("titleFromFilename", () => {
	it("strips a recognized extension", () => {
		expect(titleFromFilename("Groceries.txt")).toBe("Groceries")
	})

	it("strips only the LAST extension for a multi-dot name", () => {
		expect(titleFromFilename("release.notes.md")).toBe("release.notes")
	})

	it("falls back to the whole name when there's no real extension (a dotfile)", () => {
		expect(titleFromFilename(".gitignore")).toBe(".gitignore")
	})
})
