import type { Node } from "prosemirror-model"
import { describe, expect, it } from "vitest"
import {
	DocxEditorSession,
	NO_SOURCE,
	conservativeProof,
	formattingMarks,
	markerKey,
	proveBlocks,
	survivorsOf,
	type BlockProof
} from "@filen/office/core/docx/edit"
import { RICH, bodyOf, nodeText, openSpec, structureProblems } from "./docxEditFixtures"
import { p } from "./docxSynthetic"

function types(node: Node): string[] {
	const out: string[] = []

	node.forEach(child => out.push(child.type.name))

	return out
}

function allMarkerKeys(doc: Node): Set<string> {
	const keys = new Set<string>()

	doc.descendants(node => {
		for (const marker of survivorsOf(node)) keys.add(markerKey(marker))

		for (const name of ["before", "end"]) {
			const list: unknown = node.attrs[name]

			if (Array.isArray(list))
				for (const marker of list as { kind: never; src: number; id: string | null }[]) keys.add(markerKey(marker))
		}

		return true
	})

	for (const marker of doc.attrs["end"] as never[]) keys.add(markerKey(marker))

	return keys
}

describe("docx editing documents", () => {
	it("maps paragraphs, runs and inline content to the schema", async () => {
		const story = await bodyOf(RICH)
		const doc = story.doc

		doc.check()
		expect(structureProblems(story)).toEqual([])
		expect(types(doc)).toEqual([
			"paragraph",
			"table",
			"paragraph",
			"locked_block",
			"locked_block",
			"sdt",
			"locked_block",
			"locked_block",
			"paragraph"
		])

		const first = doc.child(0)

		expect(first.attrs["styleId"]).toBe("Heading1")
		expect(first.attrs["align"]).toBe("center")
		expect(types(first)).toEqual([
			"marker",
			"text",
			"text",
			"text",
			"tab",
			"break",
			"symbol",
			"hyphen",
			"rendered_break",
			"marker",
			"text",
			"text",
			"text",
			"field",
			"field",
			"note_ref",
			"marker",
			"text",
			"marker",
			"comment_ref",
			"math"
		])
		// Runs keep their identity: two runs with the same w:rPr share a base but stay two text nodes.
		const bold = first.child(1).marks[0]?.attrs
		const more = first.child(2).marks[0]?.attrs

		expect(first.child(1).text).toBe("Bold")
		expect(first.child(2).text).toBe(" more")
		expect(first.child(1).marks.map(mark => mark.type.name)).toEqual(["run", "bold"])
		expect(bold?.["base"]).toBe(more?.["base"])
		expect(bold?.["src"]).not.toBe(more?.["src"])
		expect(first.child(1).marks[1]?.attrs).toEqual({ value: true, cs: null })
		expect(first.child(3).marks.map(mark => mark.attrs)).toEqual([{ src: first.child(8).marks[0]?.attrs["src"], base: -1 }])
		expect(first.child(5).attrs["type"]).toBe("page")
		expect(first.child(6).attrs).toMatchObject({ char: 0xf04a, font: "Wingdings" })
		expect(first.child(10).marks.map(mark => mark.type.name)).toEqual(["link", "run"])
		expect(first.child(10).marks[0]?.attrs).toMatchObject({ target: "https://example.com/" })
		expect(first.child(11).marks[0]?.attrs).toMatchObject({ id: 5, author: "Ann", date: "2026-01-01T00:00:00Z" })
		expect(first.child(12).marks[0]?.type.name).toBe("deletion")
		expect(first.child(13).attrs).toMatchObject({ type: "PAGE", instruction: " PAGE ", result: "3", simple: false })
		expect(first.child(14).attrs).toMatchObject({ type: "NUMPAGES", result: "9", simple: true })
		expect(first.child(15).attrs).toMatchObject({ kind: "footnote", id: "1" })
		expect(first.child(20).attrs["display"]).toBe(false)
		expect(nodeText(first)).toBe("Bold moreplain\t\f­linkinsertedgone39c")
	})

	it("keeps tables one node per element, with markers between blocks", async () => {
		const story = await bodyOf(RICH)
		const table = story.doc.child(1)

		expect(table.attrs["styleId"]).toBe("Grid")
		expect(table.attrs["grid"]).toEqual([2000, 3000])
		expect((table.attrs["before"] as { kind: string; id: string }[]).map(marker => [marker.kind, marker.id])).toEqual([
			["bookmarkStart", "1"]
		])
		expect(table.child(0).child(0).attrs["colspan"]).toBe(2)
		expect(table.child(1).child(0).attrs["vMerge"]).toBe("restart")
		expect((table.child(1).child(1).attrs["end"] as { kind: string }[]).map(marker => marker.kind)).toEqual(["bookmarkEnd"])
		expect((story.doc.attrs["end"] as { id: string }[]).map(marker => marker.id)).toEqual(["2", "2"])
		expect(story.doc.attrs["sectPr"]).toBeGreaterThan(0)
	})

	it("marks section breaks and locks what cannot be edited", async () => {
		const story = await bodyOf(RICH)
		const doc = story.doc
		const section = doc.child(2)

		expect(section.attrs["sectPr"]).toBe(section.attrs["src"])
		expect(doc.child(3).attrs).toMatchObject({ kind: "paragraph", reason: "fieldSpansBlocks", text: "Entry 1", deletable: false })
		expect(doc.child(4).attrs).toMatchObject({ reason: "fieldSpansBlocks", deletable: false })
		expect(doc.child(5).attrs).toMatchObject({ lock: "sdtLocked", type: "text" })
		expect(doc.child(6).attrs).toMatchObject({ kind: "sdt", reason: "contentLocked", text: "locked control", deletable: true })
		expect(doc.child(7).attrs).toMatchObject({ kind: "element", reason: "altChunk" })
		expect(story.stats).toMatchObject({ lockedBlocks: 4, lockReasons: { fieldSpansBlocks: 2, contentLocked: 1, altChunk: 1 } })
	})

	it("records every paragraph made from source bytes as pristine", async () => {
		const story = await bodyOf(RICH)

		story.doc.descendants(node => {
			if (node.isBlock) expect(story.pristine.has(node)).toBe(node.type.name === "paragraph")

			return !node.isTextblock
		})
	})

	it("builds formatting marks that mirror the direct run properties", async () => {
		const story = await bodyOf({
			body:
				'<w:p><w:r><w:rPr><w:rStyle w:val="Emphasis"/><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:i/><w:caps/><w:strike w:val="0"/>' +
				'<w:color w:val="1F3864" w:themeColor="accent1" w:themeShade="80"/><w:sz w:val="28"/><w:szCs w:val="28"/><w:highlight w:val="yellow"/>' +
				'<w:u w:val="double" w:color="FF0000"/><w:shd w:val="clear" w:color="auto" w:fill="DDDDDD"/><w:vertAlign w:val="superscript"/><w:lang w:val="de-DE"/>' +
				'<w:rPrChange w:id="9" w:author="Cy"><w:rPr/></w:rPrChange></w:rPr><w:t>x</w:t></w:r></w:p>'
		})
		const text = story.doc.child(0).child(0)

		expect(text.marks.map(mark => mark.type.name)).toEqual([
			"run",
			"char_style",
			"italic",
			"underline",
			"strike",
			"caps",
			"vert_align",
			"color",
			"highlight",
			"shading",
			"font",
			"size",
			"lang",
			"format_change"
		])
		expect(text.marks.find(mark => mark.type.name === "color")?.attrs).toEqual({
			value: "1F3864",
			themeColor: "accent1",
			themeTint: null,
			themeShade: 128
		})
		expect(text.marks.find(mark => mark.type.name === "underline")?.attrs).toMatchObject({ style: "double", value: "FF0000" })
		expect(text.marks.find(mark => mark.type.name === "strike")?.attrs).toEqual({ value: false })
		expect(text.marks.find(mark => mark.type.name === "format_change")?.attrs).toEqual({
			id: 9,
			author: "Cy",
			date: null,
			base: null,
			run: null
		})
		expect(formattingMarks({ bold: true, boldCs: false }).map(mark => mark.attrs)).toEqual([{ value: true, cs: false }])
	})

	it("locks paragraphs whose field does not consist of whole runs", async () => {
		const story = await bodyOf({
			body:
				'<w:p><w:r><w:t>before</w:t><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
				'<w:p><w:hyperlink w:anchor="x"><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:hyperlink><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
				'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:t>never ends</w:t></w:r></w:p>' +
				p("fine")
		})

		expect(types(story.doc)).toEqual(["locked_block", "locked_block", "locked_block", "paragraph"])
		expect(story.doc.child(0).attrs["reason"]).toBe("fieldStructure")
		expect(story.doc.child(1).attrs["reason"]).toBe("fieldStructure")
		expect(story.doc.child(2).attrs).toMatchObject({ reason: "fieldStructure", deletable: true })
	})

	it("locks tables whose rows or cells hold anything but rows and cells", async () => {
		const story = await bodyOf({
			body:
				'<w:tbl><w:tblGrid><w:gridCol w:w="100"/></w:tblGrid><w:sdt><w:sdtContent><w:tr><w:tc><w:p/></w:tc></w:tr></w:sdtContent></w:sdt></w:tbl>' +
				"<w:tbl><w:tr><w:tc><w:p><w:r><w:t>ok</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
				"<w:tbl><w:tr><w:tc><w:tcPr/></w:tc></w:tr></w:tbl>" +
				p("after")
		})

		expect(types(story.doc)).toEqual(["locked_block", "table", "locked_block", "paragraph"])
		expect(story.doc.child(0).attrs).toMatchObject({ kind: "table", reason: "tableStructure" })
		expect(story.doc.child(2).attrs).toMatchObject({ kind: "table", reason: "tableStructure" })
		expect(story.stats.tables).toBe(3)
	})

	it("keeps range markers inside atoms as survivors", async () => {
		const story = await bodyOf({
			body:
				'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>REF x</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
				'<w:bookmarkStart w:id="7" w:name="_Ref1"/><w:r><w:t>result</w:t></w:r><w:bookmarkEnd w:id="7"/><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		})
		const field = story.doc.child(0).child(0)

		expect(field.type.name).toBe("field")
		expect(field.attrs["result"]).toBe("result")
		expect(survivorsOf(field).map(markerKey)).toEqual(["bookmarkStart:7", "bookmarkEnd:7"])
		expect(allMarkerKeys(story.doc)).toEqual(new Set(["bookmarkStart:7", "bookmarkEnd:7"]))
	})

	it("gives an empty body a paragraph to type in", async () => {
		const story = await bodyOf({ body: "<w:sectPr/>" })

		expect(types(story.doc)).toEqual(["paragraph"])
		// New content, which while untouched stands for no block (the body is written as its source).
		expect(story.doc.child(0).attrs["src"]).toBe(NO_SOURCE)
		expect(story.pristine.has(story.doc.child(0))).toBe(true)
	})

	it("locks the blocks a proof rejects, leaving their containers as built", async () => {
		const { context } = await openSpec({
			body:
				p("one") +
				"<w:tbl><w:tr><w:tc><w:p><w:r><w:t>reject me</w:t></w:r></w:p><w:p><w:r><w:t>two</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
				p("reject me")
		})
		const proof: BlockProof = {
			check: node => (node.textContent === "reject me" ? "proof" : undefined)
		}
		const session = new DocxEditorSession(context, { proof })
		const doc = session.state.doc

		expect(types(doc)).toEqual(["paragraph", "table", "locked_block"])
		expect(doc.child(2).attrs).toMatchObject({ reason: "proof", kind: "paragraph", text: "reject me" })

		const cell = doc.child(1).child(0).child(0)

		expect(types(cell)).toEqual(["locked_block", "paragraph"])
		// The cell keeps its source item and attributes; its other paragraph is still the built one.
		expect(cell.attrs["src"]).toBe(session.story.doc.child(1).child(0).child(0).attrs["src"])
		expect(cell.attrs).toBe(session.story.doc.child(1).child(0).child(0).attrs)
		expect(session.story.pristine.has(cell.child(1))).toBe(true)
		// Locking is not an edit.
		expect(session.snapshot()).toMatchObject({ dirty: false, canUndo: false })
		expect(proveBlocks(session.story, doc, proof)).toEqual([])
	})

	it("the conservative proof locks paragraphs holding unmodelled content", async () => {
		const story = await bodyOf({ body: "<w:p><w:r><w:t>a</w:t></w:r><w15:unknownThing/></w:p>" + p("b") })

		expect(story.doc.child(0).child(1).attrs["kind"]).toBe("Opaque")
		expect(proveBlocks(story, story.doc, conservativeProof)).toEqual([{ pos: 0, reason: "unmodelled" }])
	})

	it("builds header, footnote and comment stories", async () => {
		const { context, model } = await openSpec({
			body: p("body") + '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>',
			headers: { rIdH: p("header text") },
			footnotes: '<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t>note</w:t></w:r></w:p></w:footnote>',
			comments: '<w:comment w:id="3" w:author="Ann"><w:p><w:r><w:annotationRef/></w:r><w:r><w:t>remark</w:t></w:r></w:p></w:comment>'
		})

		const stories = model.stories.filter(story => story.kind !== "body")
		const expected: Partial<Record<string, string>> = { header: "header text", footnote: "note", comment: "remark" }

		expect(stories.map(story => story.kind).sort()).toEqual(["comment", "footnote", "header"])

		for (const story of stories) {
			const session = new DocxEditorSession(context, { story })
			const doc = session.state.doc

			doc.check()
			expect(doc.attrs["story"]).toBe(story.index)
			expect(doc.textContent).toBe(expected[story.kind])
		}
	})
})
