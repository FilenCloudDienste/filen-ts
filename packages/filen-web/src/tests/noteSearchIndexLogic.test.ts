import { describe, expect, it } from "vitest"
import { buildNoteMatchQuery, noteIndexIsStale, noteIndexText, splitSnippet } from "@/features/notes/lib/searchIndex.logic"
import { SNIPPET_CLOSE, SNIPPET_OPEN } from "@/workers/noteIndex"
import { mockNote } from "@/tests/fixtures/notes"
import { testUuid } from "@/tests/support/uuid"

describe("buildNoteMatchQuery", () => {
	it("quotes each token as a word prefix", () => {
		expect(buildNoteMatchQuery("launch plan")).toBe('"launch"* "plan"*')
	})

	it("escapes quotes and drops tokens without a letter or digit", () => {
		expect(buildNoteMatchQuery('say "hi" -')).toBe('"say"* """hi"""*')
		expect(buildNoteMatchQuery("- ...")).toBeNull()
	})
})

describe("noteIndexIsStale", () => {
	const note = mockNote({ uuid: testUuid("a"), editedTimestamp: 10n })

	it("is stale when missing or older than the listed edit, fresh at or past it", () => {
		expect(noteIndexIsStale(note, undefined)).toBe(true)
		expect(noteIndexIsStale(note, 9n)).toBe(true)
		expect(noteIndexIsStale(note, 10n)).toBe(false)
		expect(noteIndexIsStale(note, 0n)).toBe(true)
		expect(noteIndexIsStale({ ...note, editedTimestamp: 0n }, 0n)).toBe(false)
	})
})

describe("noteIndexText", () => {
	it("indexes a checklist's item text and composes decomposed text", () => {
		expect(noteIndexText("checklist", '<ul data-checked="false"><li>milk</li></ul>')).toContain("milk")
		expect(noteIndexText("text", "Übersicht")).toBe("Übersicht")
	})
})

describe("splitSnippet", () => {
	it("splits a snippet at its hit markers", () => {
		expect(splitSnippet(`…the ${SNIPPET_OPEN}launch${SNIPPET_CLOSE} plan`)).toEqual([
			{ text: "…the ", hit: false },
			{ text: "launch", hit: true },
			{ text: " plan", hit: false }
		])
	})
})
