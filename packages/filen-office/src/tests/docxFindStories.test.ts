import { describe, expect, it } from "vitest"
import { findInStories, selectMatch } from "@filen/office/core/docx/edit"
import { buildDocx, p } from "./docxSynthetic"
import { pagedEditor, settleAll } from "./pagedFixtures"

const SEPARATORS =
	'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
	'<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
const SECTION =
	'<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/>' +
	'<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
// "alpha" in the body, the header, the footer and a footnote.
const STORIES = buildDocx({
	body: '<w:p><w:r><w:t>Body alpha</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>' + p("Second alpha line") + SECTION,
	headers: { rIdH: p("Header alpha") },
	footers: { rIdF: p("Footer alpha") },
	footnotes: SEPARATORS + '<w:footnote w:id="1"><w:p><w:r><w:t>Note alpha</w:t></w:r></w:p></w:footnote>'
})

describe("docx find across stories", () => {
	it("finds in the body, then the headers, footers and notes, without a session per story", async () => {
		const { editor } = await pagedEditor(STORIES)

		await settleAll(editor)

		const stories = editor.searchStories()
		const matches = findInStories(stories, "alpha")
		const kinds = matches.map(match => editor.edits.model.stories[match.story]?.kind)

		expect(stories[0]?.story).toBe(editor.body.session.story.story.index)
		expect(kinds.slice(0, 2)).toEqual(["body", "body"])
		expect(new Set(kinds.slice(2))).toEqual(new Set(["header", "footer", "footnote"]))
		expect(matches).toHaveLength(5)
		// Only the body has a session: the other stories were searched in documents built for them.
		expect(editor.sessions).toHaveLength(1)
		// Nothing changed: the same list.
		expect(editor.searchStories()).toBe(stories)

		for (const match of matches) {
			const doc = stories.find(entry => entry.story === match.story)?.doc

			expect(doc?.textBetween(match.from, match.to)).toBe("alpha")
		}
	})

	it("selects a match in another story by entering it, its positions holding", async () => {
		const { editor } = await pagedEditor(STORIES)

		await settleAll(editor)

		const stories = editor.searchStories()
		const match = findInStories(stories, "alpha").find(entry => editor.edits.model.stories[entry.story]?.kind === "footer")

		if (match === undefined) throw new Error("No footer match")

		const searched = stories.find(entry => entry.story === match.story)?.doc

		expect(editor.enterStory(match.story, -1)).toBe(true)
		// The session took the document the search built.
		expect(editor.session.state.doc).toBe(searched)

		const tr = selectMatch(editor.session.state, match)

		if (tr === null) throw new Error("No selection")

		editor.dispatch(tr)

		const { from, to } = editor.session.state.selection

		expect(editor.session.state.doc.textBetween(from, to)).toBe("alpha")
	})

	it("follows an edit in a story entered, and releases what it built", async () => {
		const { editor } = await pagedEditor(STORIES)

		await settleAll(editor)

		const first = editor.searchStories()
		const header = first.find(entry => editor.edits.model.stories[entry.story]?.kind === "header")

		if (header === undefined) throw new Error("No header")

		editor.enterStory(header.story, -1)
		editor.dispatch(editor.session.state.tr.insertText(" alpha", 1))

		const second = editor.searchStories()

		expect(second).not.toBe(first)
		expect(findInStories(second, "alpha").filter(match => match.story === header.story)).toHaveLength(2)

		editor.releaseSearch()

		expect(editor.searchStories()).not.toBe(second)
	})

	it("stops at the limit across stories", async () => {
		const { editor } = await pagedEditor(STORIES)

		await settleAll(editor)

		expect(findInStories(editor.searchStories(), "alpha", {}, 3)).toHaveLength(3)
		expect(findInStories(editor.searchStories(), "", {})).toHaveLength(0)
	})
})
