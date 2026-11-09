import { describe, expect, it, vi } from "vitest"
import { findInStories, findInStory, type DocumentMatch, type StorySearch } from "@filen/office/core/docx/edit"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor, settleAll } from "./pagedFixtures"

// Find across stories searches again on every render while typing pauses and on every keystroke in one story:
// only the documents that changed are gone through again, and the matches are what a fresh search finds.

const SECTION =
	'<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/>' +
	'<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
const STORIES = buildDocx({
	body: p("Body alpha") + p("Second alpha line") + SECTION,
	headers: { rIdH: p("Header alpha alpha") },
	footers: { rIdF: p("Footer Alpha") }
})

// A search of every story as if none had been searched before.
function fresh(stories: readonly StorySearch[], query: string, options: { caseSensitive?: boolean }, limit: number): DocumentMatch[] {
	return stories.flatMap(({ story, doc }) => findInStory(doc, query, options, limit).map(match => ({ story, ...match }))).slice(0, limit)
}

describe("docx find across stories, searched again", () => {
	it("goes through only the stories whose documents changed, finding what a fresh search finds", async () => {
		const { editor } = await pagedEditor(STORIES)

		await settleAll(editor)

		const stories = editor.searchStories()

		expect(stories.length).toBeGreaterThanOrEqual(3)

		const first = findInStories(stories, "alpha")

		expect(first).toEqual(fresh(stories, "alpha", {}, 10_000))
		// The same stories and search: the same list, nothing gone through.
		expect(findInStories(stories, "alpha")).toBe(first)

		// A keystroke in the body: a new body document, the others as they were.
		editor.dispatch(editor.state.tr.insertText("alpha ", 1))

		const typed = editor.searchStories()
		const body = typed[0]

		expect(typed).not.toBe(stories)
		expect(body?.doc).not.toBe(stories[0]?.doc)

		const searched = typed.map(entry => vi.spyOn(entry.doc, "descendants"))
		const after = findInStories(typed, "alpha")

		expect(searched[0]).toHaveBeenCalledTimes(1)

		for (const spy of searched.slice(1)) {
			expect(spy).not.toHaveBeenCalled()
		}

		for (const spy of searched) {
			spy.mockRestore()
		}

		expect(after).toEqual(fresh(typed, "alpha", {}, 10_000))
		expect(after.filter(match => match.story === body?.story)).toHaveLength(3)

		// Another search, another limit: gone through again, still what a fresh search finds.
		expect(findInStories(typed, "alpha", { caseSensitive: true })).toEqual(fresh(typed, "alpha", { caseSensitive: true }, 10_000))
		expect(findInStories(typed, "alpha", {}, 4)).toEqual(fresh(typed, "alpha", {}, 4))
		expect(findInStories(typed, "alpha", {}, 1)).toEqual(fresh(typed, "alpha", {}, 1))
		expect(findInStories(typed, "alpha")).toEqual(fresh(typed, "alpha", {}, 10_000))
		expect(findInStories(typed, "", {})).toHaveLength(0)
	})
})
