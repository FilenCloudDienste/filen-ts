import { describe, expect, it } from "vitest"
import { Schema } from "prosemirror-model"
import { EditorState, TextSelection } from "prosemirror-state"
import { FIND_CLOSED, FIND_SEED_MAX, closedFind, findSeed, openedFind, wheelZoom } from "@/features/preview/components/docxEditorFind.logic"

// Find's query from the selection and across closing (Word's Find what), and Ctrl/Cmd+wheel zoom steps.

const schema = new Schema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} } })

function editorWith(paragraphs: readonly string[], from: number, to: number): { state: EditorState } {
	const doc = schema.node(
		"doc",
		null,
		paragraphs.map(text => schema.node("paragraph", null, text === "" ? [] : [schema.text(text)]))
	)

	return { state: EditorState.create({ doc, selection: TextSelection.create(doc, from, to) }) }
}

describe("findSeed", () => {
	it("takes a short selection within one paragraph", () => {
		expect(findSeed(editorWith(["zebra okapi"], 1, 6))).toBe("zebra")
	})

	it("takes nothing from a caret, a selection across paragraphs or one past the limit", () => {
		expect(findSeed(editorWith(["zebra okapi"], 3, 3))).toBeUndefined()
		expect(findSeed(editorWith(["zebra", "okapi"], 2, 9))).toBeUndefined()

		const long = "a".repeat(FIND_SEED_MAX + 1)

		expect(findSeed(editorWith([long], 1, FIND_SEED_MAX + 1))).toBe("a".repeat(FIND_SEED_MAX))
		expect(findSeed(editorWith([long], 1, FIND_SEED_MAX + 2))).toBeUndefined()
	})
})

describe("find state across closing", () => {
	it("keeps the query and case option once closed, and a seed replaces them as a new search", () => {
		const searched = { ...FIND_CLOSED, open: true, query: "zebra", caseSensitive: true, wholeWord: true, active: 3 }
		const closed = closedFind(searched)

		expect(FIND_CLOSED.wholeWord).toBe(false)
		expect(closed).toMatchObject({ open: false, query: "zebra", caseSensitive: true, wholeWord: true, active: -1 })

		const reopened = openedFind(closed, false, undefined)

		expect(reopened).toMatchObject({ open: true, replace: false, query: "zebra", caseSensitive: true, wholeWord: true, active: -1 })
		expect(openedFind(closed, true, "okapi")).toMatchObject({ open: true, replace: true, query: "okapi", active: -1 })
		// Open already: a seed starts a new search there, the same query keeps the current match.
		expect(openedFind(searched, false, "okapi")).toMatchObject({ query: "okapi", active: -1, focus: searched.focus + 1 })
		expect(openedFind(searched, true, "zebra")).toMatchObject({ query: "zebra", active: 3, replace: true })
	})
})

describe("wheelZoom", () => {
	it("steps from the fit zoom first, then from the previous step, so quick steps add up", () => {
		const first = wheelZoom("fit", 1, -100)
		const second = wheelZoom(first, 1, -100)

		expect(first).toBeCloseTo(1.15)
		expect(second).toBeCloseTo(1.3)
		expect(wheelZoom(1, 0.5, 100_000)).toBe(0.25)
	})
})
