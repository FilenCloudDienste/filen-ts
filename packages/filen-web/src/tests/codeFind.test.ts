// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { SearchQuery, searchPanelOpen } from "@codemirror/search"
import { codeReadOnly } from "@filen/office/dom/code"
import { CODE_FIND_LIMIT, CodeFind, codeFindExtension, countCodeMatches } from "@/features/preview/lib/codeFind"

// The command bar's find and replace over CodeMirror's search: counted (capped) and stepped through, replaced one at
// a time or all at once, never opening CodeMirror's own panel, and counted again at most once a frame.

const views: EditorView[] = []

afterEach(() => {
	for (const view of views.splice(0)) view.destroy()
})

function setup(doc: string, editable = true): { view: EditorView; find: CodeFind } {
	const view = new EditorView({
		state: EditorState.create({ doc, extensions: [codeFindExtension, codeReadOnly(!editable)] }),
		parent: document.body
	})

	views.push(view)

	return { view, find: new CodeFind(() => view, editable) }
}

function selected(view: EditorView): string {
	return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)
}

describe("countCodeMatches", () => {
	it("counts literally and knows which match is selected", () => {
		const state = EditorState.create({ doc: "a.b a.b axb", selection: { anchor: 4, head: 7 } })

		expect(countCodeMatches(state, new SearchQuery({ search: "a.b", literal: true }), CODE_FIND_LIMIT)).toEqual({
			count: 2,
			capped: false,
			active: 1
		})
		expect(countCodeMatches(state, new SearchQuery({ search: "" }), CODE_FIND_LIMIT).count).toBe(0)
	})

	it("stops at the limit and says there are more", () => {
		const state = EditorState.create({ doc: "x ".repeat(CODE_FIND_LIMIT + 200) })

		expect(countCodeMatches(state, new SearchQuery({ search: "x" }), CODE_FIND_LIMIT)).toEqual({
			count: CODE_FIND_LIMIT,
			capped: true,
			active: -1
		})
	})
})

describe("CodeFind", () => {
	it("searches from the cursor, wraps round and steps both ways", () => {
		const { view, find } = setup("one two one two one")

		view.dispatch({ selection: { anchor: 5 } })
		find.open(false)
		find.search("one", false)
		expect(find.get()).toMatchObject({ open: true, query: "one", count: 3, active: 1 })
		expect(view.state.selection.main.from).toBe(8)

		find.step(1)
		expect(find.get().active).toBe(2)
		find.step(1)
		expect(find.get().active).toBe(0)
		find.step(-1)
		expect(find.get().active).toBe(2)
		expect(searchPanelOpen(view.state)).toBe(false)
	})

	it("matches case only when asked", () => {
		const { find } = setup("Word word WORD")

		find.open(false)
		find.search("word", false)
		expect(find.get().count).toBe(3)
		find.search("word", true)
		expect(find.get().count).toBe(1)
	})

	it("seeds the field with a one-line selection", () => {
		const { view, find } = setup("alpha beta alpha")

		view.dispatch({ selection: { anchor: 0, head: 5 } })
		find.open(false)
		expect(find.get()).toMatchObject({ query: "alpha", count: 2 })
	})

	it("replaces the current match and moves on, then all the rest in one step", () => {
		const { view, find } = setup("cat cat cat")

		find.open(true)
		find.search("cat", false)
		expect(find.get().replace).toBe(true)

		const replace = find.controls(find.get(), false).replace

		replace?.one("dog")
		expect(view.state.doc.toString()).toBe("dog cat cat")
		expect(selected(view)).toBe("cat")
		replace?.all("cow")
		expect(view.state.doc.toString()).toBe("dog cow cow")
		expect(find.get().count).toBe(0)
	})

	it("offers no replace for a read-only file, and a locked one has it disabled", () => {
		const readOnly = setup("a", false)

		expect(readOnly.find.controls(readOnly.find.get(), false).replace).toBeUndefined()

		const { find } = setup("a")

		expect(find.controls(find.get(), true).replace?.disabled).toBe(true)
	})

	it("never opens CodeMirror's panel for a step without a query", () => {
		const { view, find } = setup("text")

		find.open(false)
		find.step(1)
		expect(searchPanelOpen(view.state)).toBe(false)
	})

	it("counts again once a frame after edits while open, and not at all once closed", () => {
		const frames: FrameRequestCallback[] = []

		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback))
		vi.stubGlobal("cancelAnimationFrame", () => undefined)

		const { view, find } = setup("ab ab")

		find.open(false)
		find.search("ab", false)
		view.dispatch({
			changes: [
				{ from: 5, insert: " ab" },
				{ from: 5, insert: " ab" }
			]
		})

		// The editor asks for frames of its own.
		const before = frames.length

		find.schedule()
		find.schedule()
		expect(frames.length - before).toBe(1)

		for (const frame of frames.splice(0)) frame(0)

		expect(find.get().count).toBe(4)

		find.close()

		const closed = frames.length

		find.schedule()
		expect(frames.length).toBe(closed)
		expect(find.get()).toMatchObject({ open: false, count: 0, query: "" })
	})

	it("highlights the matches in view while open", () => {
		const { view, find } = setup("ab ab")

		find.open(false)
		find.search("ab", false)
		expect(view.contentDOM.querySelectorAll(".cm-searchMatch")).toHaveLength(2)
		expect(view.contentDOM.querySelectorAll(".cm-searchMatch-selected")).toHaveLength(1)
		find.close()
		expect(view.contentDOM.querySelectorAll(".cm-searchMatch")).toHaveLength(0)
	})
})
