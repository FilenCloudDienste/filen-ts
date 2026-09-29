import { describe, expect, it } from "vitest"
import { codeMirrorTagForNote } from "@/features/notes/components/reader/reader.logic"
import { mockNote } from "@/tests/fixtures/notes"

describe("codeMirrorTagForNote", () => {
	it("is always 'markdown' for an md note, regardless of title", () => {
		expect(codeMirrorTagForNote(mockNote({ noteType: "md", title: "notes" }))).toBe("markdown")
		expect(codeMirrorTagForNote(mockNote({ noteType: "md", title: "readme.txt" }))).toBe("markdown")
	})

	it("is '' (unhighlighted) for a text note", () => {
		expect(codeMirrorTagForNote(mockNote({ noteType: "text", title: "script.rs" }))).toBe("")
	})

	it("derives the language from a code note's title extension", () => {
		expect(codeMirrorTagForNote(mockNote({ noteType: "code", title: "main.rs" }))).toBe("rust")
		expect(codeMirrorTagForNote(mockNote({ noteType: "code", title: "index.ts" }))).toBe("typescript")
		expect(codeMirrorTagForNote(mockNote({ noteType: "code", title: "styles.css" }))).toBe("css")
	})

	it("is '' for a code note with no recognizable extension", () => {
		expect(codeMirrorTagForNote(mockNote({ noteType: "code", title: "untitled" }))).toBe("")
	})

	it("is '' for a code note with an empty title", () => {
		expect(codeMirrorTagForNote(mockNote({ noteType: "code", title: "" }))).toBe("")
	})

	it("is '' for a rich/checklist note (no language notion at all)", () => {
		expect(codeMirrorTagForNote(mockNote({ noteType: "rich" }))).toBe("")
		expect(codeMirrorTagForNote(mockNote({ noteType: "checklist" }))).toBe("")
	})
})
