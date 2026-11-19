// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { SearchQuery, searchPanelOpen } from "@codemirror/search"
import { codeReadOnly } from "@filen/office/dom/code"
import {
	CODE_FIND_EDIT_DELAY,
	CODE_FIND_LIMIT,
	CodeFind,
	codeFindExtension,
	collectCodeMatches,
	countOfCodeMatches
} from "@/features/preview/lib/codeFind"

// The command bar's find and replace over CodeMirror's search: counted (capped) and stepped through, replaced one at
// a time or all at once, never opening CodeMirror's own panel. The matches are collected once per query and once the
// edits pause; a caret move only looks itself up in them, at most once a frame.

const views: EditorView[] = []

afterEach(() => {
	for (const view of views.splice(0)) view.destroy()

	vi.useRealTimers()
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

function setup(doc: string, editable = true): { view: EditorView; find: CodeFind } {
	const view = new EditorView({
		state: EditorState.create({ doc, extensions: [codeFindExtension, codeReadOnly(!editable)] }),
		parent: document.body
	})

	views.push(view)

	return { view, find: new CodeFind(() => view, editable) }
}

// Walks of the whole document (the highlighter walks the viewport only, between bounds).
function walks(cursors: { mock: { calls: readonly (readonly unknown[])[] } }): number {
	return cursors.mock.calls.filter(call => call.length === 1).length
}

function selected(view: EditorView): string {
	return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)
}

describe("collectCodeMatches", () => {
	it("counts literally and knows which match is selected", () => {
		const state = EditorState.create({ doc: "a.b a.b axb", selection: { anchor: 4, head: 7 } })
		const matches = collectCodeMatches(state, new SearchQuery({ search: "a.b", literal: true }), CODE_FIND_LIMIT)

		expect(countOfCodeMatches(matches, 4, 7)).toEqual({ count: 2, capped: false, active: 1 })
		expect(countOfCodeMatches(matches, 0, 3).active).toBe(0)
		expect(countOfCodeMatches(matches, 4, 6).active).toBe(-1)
		expect(collectCodeMatches(state, new SearchQuery({ search: "" }), CODE_FIND_LIMIT).starts).toHaveLength(0)
	})

	it("stops at the limit and says there are more, with no match past it selected", () => {
		const state = EditorState.create({ doc: "x ".repeat(CODE_FIND_LIMIT + 200) })
		const matches = collectCodeMatches(state, new SearchQuery({ search: "x" }), CODE_FIND_LIMIT)

		expect(countOfCodeMatches(matches, 0, 0)).toEqual({ count: CODE_FIND_LIMIT, capped: true, active: -1 })
		expect(countOfCodeMatches(matches, 2 * (CODE_FIND_LIMIT - 1), 2 * (CODE_FIND_LIMIT - 1) + 1).active).toBe(CODE_FIND_LIMIT - 1)
		expect(countOfCodeMatches(matches, 2 * CODE_FIND_LIMIT, 2 * CODE_FIND_LIMIT + 1).active).toBe(-1)
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

	it("looks a caret move up once a frame, with no walk of the document", () => {
		const frames: FrameRequestCallback[] = []

		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback))
		vi.stubGlobal("cancelAnimationFrame", () => undefined)

		const { view, find } = setup("ab ab ab")

		find.open(false)
		find.search("ab", false)
		expect(find.get()).toMatchObject({ count: 3, active: 0 })

		view.dispatch({ selection: { anchor: 6, head: 8 } })

		// The editor asks for frames of its own; its highlighter walks the viewport only, and has run by now.
		const cursors = vi.spyOn(SearchQuery.prototype, "getCursor")
		const before = frames.length

		find.schedule(false)
		find.schedule(false)
		expect(frames.length - before).toBe(1)

		for (const frame of frames.splice(0)) frame(0)

		expect(find.get()).toMatchObject({ count: 3, active: 2 })
		expect(cursors).not.toHaveBeenCalled()
	})

	it("collects the matches again once the edits pause, and not at all once closed", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })

		const { view, find } = setup("ab ab")

		find.open(false)
		find.search("ab", false)

		const collect = vi.spyOn(SearchQuery.prototype, "getCursor")

		for (const insert of [" ab", " ab"]) {
			view.dispatch({ changes: { from: view.state.doc.length, insert } })
			collect.mockClear()
			find.schedule(true)
		}

		vi.advanceTimersByTime(CODE_FIND_EDIT_DELAY - 1)
		expect(find.get().count).toBe(2)
		expect(collect).not.toHaveBeenCalled()

		vi.advanceTimersByTime(1)
		expect(find.get().count).toBe(4)
		expect(collect).toHaveBeenCalledTimes(1)

		find.close()
		view.dispatch({ changes: { from: 0, insert: "ab " } })
		collect.mockClear()
		find.schedule(true)
		vi.runAllTimers()
		expect(collect).not.toHaveBeenCalled()
		expect(find.get()).toMatchObject({ open: false, count: 0, query: "" })
	})

	it("collects the matches at once for another query", () => {
		const { find } = setup("ab ab cd")

		find.open(false)
		find.search("ab", false)

		const collect = vi.spyOn(SearchQuery.prototype, "getCursor")

		find.search("cd", false)
		expect(find.get()).toMatchObject({ count: 1, active: 0 })
		expect(walks(collect)).toBe(1)
	})

	it("finds the first match after the selection past the cap, and counts it as beyond it", () => {
		const { view, find } = setup("x ".repeat(CODE_FIND_LIMIT + 200))

		view.dispatch({ selection: { anchor: 2 * (CODE_FIND_LIMIT + 10) } })
		find.open(false)
		find.search("x", false)
		expect(view.state.selection.main.from).toBe(2 * (CODE_FIND_LIMIT + 10))
		expect(find.get()).toMatchObject({ count: CODE_FIND_LIMIT, capped: true, active: -1 })
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
