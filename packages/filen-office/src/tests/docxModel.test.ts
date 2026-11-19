import { describe, expect, it } from "vitest"
import { Namespaces, parseXml } from "@filen/office/core/xml"
import {
	BreakClear,
	BreakType,
	FieldCharType,
	Item,
	ItemWalker,
	PropsStore,
	Revision,
	RevisionFlag,
	RevisionView,
	SdtLevel,
	gateReasons,
	modelStats,
	parseNumbering,
	parseStyles,
	parseTheme,
	type DocxModel,
	type StoryPart
} from "@filen/office/core/docx"
import { commentParagraphTexts } from "../core/docx/model/comments"
import { modelProblems } from "./docxIntegrity"
import { NAMESPACES, modelOf, p } from "./docxSynthetic"
import { budget, cpuMs } from "./timing"

function itemsOf(part: StoryPart, kind: number): number[] {
	const out: number[] = []

	for (let item = 0; item < part.count; item++) {
		if (part.kinds[item] === kind) out.push(item)
	}

	return out
}

function body(model: DocxModel): StoryPart {
	const story = model.body

	if (story === undefined) throw new Error("no body")

	return model.partOf(story)
}

function first(part: StoryPart, kind: number): number {
	const item = itemsOf(part, kind)[0]

	if (item === undefined) throw new Error(`no item of kind ${kind}`)

	return item
}

async function sound(spec: Parameters<typeof modelOf>[0]): Promise<DocxModel> {
	const model = await modelOf(spec)

	expect(modelProblems(model)).toEqual([])

	return model
}

describe("paragraphs, runs and text", () => {
	it("keeps text as byte spans and decodes on request", async () => {
		const model = await sound({
			body: '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:rStyle w:val="Strong"/><w:b/></w:rPr><w:t>Größe &amp; Co</w:t></w:r><w:r><w:t xml:space="preserve"> two </w:t></w:r></w:p>'
		})
		const part = body(model)
		const paragraph = first(part, Item.Paragraph)
		const [text1, text2] = itemsOf(part, Item.Text)
		const row = part.paragraphRow(paragraph)
		const runRow = part.runRow(first(part, Item.Run))
		const span = new Int32Array(2)

		expect(model.string(part.paragraphs.style[row] ?? -1)).toBe("Heading1")
		expect(model.string(part.runs.style[runRow] ?? -1)).toBe("Strong")
		expect(part.ref(part.runs.rPr[runRow] ?? -1)?.document).toBe(part.document)
		expect(part.document.name(part.runs.rPr[runRow] ?? -1)).toBe("w:rPr")
		expect(part.text(text1 ?? -1)).toBe("Größe & Co")
		expect(part.preservesSpace(text1 ?? -1)).toBe(false)
		expect(part.preservesSpace(text2 ?? -1)).toBe(true)
		expect(part.textSpan(text1 ?? -1, span)).toBe(new TextEncoder().encode("Größe &amp; Co").length)
		expect(new TextDecoder().decode(part.document.bytes.subarray(span[0], span[1]))).toBe("Größe &amp; Co")
		expect(part.paragraphText(paragraph)).toBe("Größe & Co two ")
		expect(part.parent(text1 ?? -1)).toBe(first(part, Item.Run))
	})

	it("models every run content element", async () => {
		const model = await sound({
			body:
				"<w:p><w:r>" +
				'<w:t>a</w:t><w:tab/><w:br/><w:br w:type="page"/><w:br w:type="column"/><w:br w:type="textWrapping" w:clear="all"/>' +
				'<w:cr/><w:lastRenderedPageBreak/><w:sym w:font="Wingdings" w:char="F0E0"/><w:softHyphen/><w:noBreakHyphen/>' +
				'<w:ptab w:relativeTo="margin" w:alignment="right" w:leader="dot"/><w:pgNum/><w:yearLong/><w:annotationRef/>' +
				'<w:fldData>AAAA</w:fldData><w14:contentPart r:id="rId9"/>' +
				"</w:r></w:p>"
		})
		const part = body(model)
		const breaks = itemsOf(part, Item.Break)

		expect(breaks.map(item => part.breakType(item))).toEqual([
			BreakType.TextWrapping,
			BreakType.Page,
			BreakType.Column,
			BreakType.TextWrapping
		])
		expect(part.breakClear(breaks[3] ?? -1)).toBe(BreakClear.All)
		expect(itemsOf(part, Item.Tab)).toHaveLength(1)
		expect(itemsOf(part, Item.CarriageReturn)).toHaveLength(1)
		expect(itemsOf(part, Item.LastRenderedPageBreak)).toHaveLength(1)
		expect(part.symbol(first(part, Item.Symbol))).toEqual({ char: 0xf0e0, font: "Wingdings" })
		expect(itemsOf(part, Item.SoftHyphen)).toHaveLength(1)
		expect(itemsOf(part, Item.NoBreakHyphen)).toHaveLength(1)
		expect(itemsOf(part, Item.PositionalTab)).toHaveLength(1)
		expect(itemsOf(part, Item.PageNumber)).toHaveLength(1)
		expect(itemsOf(part, Item.DateTimePart)).toHaveLength(1)
		expect(itemsOf(part, Item.AnnotationMark)).toHaveLength(1)
		expect(itemsOf(part, Item.ContentPart)).toHaveLength(1)
		expect(part.document.name(part.node(first(part, Item.Opaque)))).toBe("w:fldData")
		expect(part.paragraphText(first(part, Item.Paragraph))).toBe("a\t\n\f\f\n\n\uf0e0\u00ad\u2011\t")
	})

	it("reads a comment's symbol as the character its font draws and a paragraph's as its code", async () => {
		const run =
			'<w:r><w:t xml:space="preserve">Done </w:t></w:r><w:r><w:sym w:font="Wingdings" w:char="F0FC"/><w:sym w:char="F0FC"/><w:noBreakHyphen/></w:r>'
		const model = await sound({
			body: `<w:p><w:commentRangeStart w:id="1"/>${run}<w:r><w:softHyphen/></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>`,
			comments: `<w:comment w:id="1" w:author="A"><w:p>${run}</w:p></w:comment>`
		})
		const comment = model.stories[model.comments[0]?.story ?? -1]

		if (comment === undefined) throw new Error("no comment")

		expect(body(model).paragraphText(first(body(model), Item.Paragraph))).toBe("Done \uf0fc\uf0fc\u2011\u00ad")
		// Without a symbol font the code is kept.
		expect(commentParagraphTexts(model.partOf(comment), comment.item)).toEqual(["Done \u2713\uf0fc\u2011"])
	})

	it("ignores proofErr and unwraps smartTag and customXml while keeping them", async () => {
		const model = await sound({
			body:
				'<w:p><w:proofErr w:type="spellStart"/><w:smartTag w:uri="urn:x" w:element="place"><w:smartTagPr><w:attr w:name="a" w:val="b"/></w:smartTagPr>' +
				'<w:r><w:t>Paris</w:t></w:r></w:smartTag><w:proofErr w:type="spellEnd"/><w:customXml w:element="c"><w:customXmlPr/><w:r><w:t> rocks</w:t></w:r></w:customXml></w:p>' +
				'<w:customXml w:element="block"><w:p><w:r><w:t>inside</w:t></w:r></w:p></w:customXml>'
		})
		const part = body(model)
		const smartTag = first(part, Item.SmartTag)

		expect(model.counts.proofErrors).toBe(2)
		expect(part.document.name(part.aux[smartTag] ?? -1)).toBe("w:smartTagPr")
		expect(itemsOf(part, Item.CustomXml)).toHaveLength(2)
		expect(part.paragraphText(first(part, Item.Paragraph))).toBe("Paris rocks")

		const walker = new ItemWalker().reset(part, model.body?.item ?? -1)
		const blocks: number[] = []

		for (let item = walker.next(); item >= 0; item = walker.next()) blocks.push(part.kinds[item] ?? 0)

		expect(blocks).toEqual([Item.Paragraph, Item.CustomXml, Item.Paragraph])
	})

	it("keeps unknown elements as opaque items with their span", async () => {
		const model = await sound({
			body: '<w:p><w:r><w:t>x</w:t></w:r><w:futureThing w:a="1"><w:r><w:t>hidden</w:t></w:r></w:futureThing></w:p><w14:unknownBlock/>'
		})
		const part = body(model)
		const opaque = itemsOf(part, Item.Opaque)

		expect(opaque.map(item => part.document.name(part.node(item)))).toEqual(["w:futureThing", "w14:unknownBlock"])
		expect(part.end(opaque[0] ?? -1)).toBe((opaque[0] ?? 0) + 1)
		expect(part.paragraphText(first(part, Item.Paragraph))).toBe("x")
		expect(modelStats(model).opaque).toEqual({ "w:futureThing": 1, "w14:unknownBlock": 1 })
	})
})

describe("fields", () => {
	it("matches nested complex fields, results across paragraphs and simple fields", async () => {
		const model = await sound({
			body:
				'<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" </w:instrText></w:r>' +
				'<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Intro</w:t></w:r>' +
				'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGEREF _Toc1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
				'<w:p><w:r><w:t>More</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
				'<w:p><w:fldSimple w:instr=" NUMPAGES \\* MERGEFORMAT "><w:r><w:t>9</w:t></w:r></w:fldSimple>' +
				'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>IF </w:instrText></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:instrText> = 1 "a" "b"</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
		})
		const part = body(model)
		const fields = part.fields

		expect(fields.count).toBe(5)
		expect([0, 1, 2, 3, 4].map(field => part.fieldType(field))).toEqual(["TOC", "PAGEREF", "NUMPAGES", "IF", "PAGE"])
		expect(part.fieldInstruction(0)).toBe(' TOC \\o "1-3" ')
		expect(part.fieldInstruction(3)).toBe('IF  = 1 "a" "b"')
		expect(fields.parent[1]).toBe(0)
		expect(fields.parent[4]).toBe(3)
		expect(fields.simple[2]).toBe(1)

		const [, second, third] = itemsOf(part, Item.Paragraph)

		// The TOC field ends in the second paragraph.
		expect(fields.end[0] ?? -1).toBeGreaterThan(second ?? 0)
		expect(fields.end[0] ?? -1).toBeLessThan(third ?? 0)

		const begin = fields.begin[0] ?? -1

		expect(part.fieldCharType(begin)).toBe(FieldCharType.Begin)
		expect(part.fieldCharDirty(begin)).toBe(true)
		expect(part.fieldOf(begin)).toBe(0)
		expect(part.fieldOf(fields.end[1] ?? -1)).toBe(1)
		expect(part.paragraphText(itemsOf(part, Item.Paragraph)[0] ?? -1)).toBe("Intro3")
		expect(model.counts.unbalancedFieldEnds).toBe(0)
		expect(model.counts.unterminatedFields).toBe(0)
	})

	it("survives unbalanced field characters", async () => {
		const model = await sound({
			body:
				'<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
				'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r></w:p>'
		})
		const part = body(model)

		expect(model.counts.unbalancedFieldEnds).toBe(1)
		expect(model.counts.unterminatedFields).toBe(1)
		expect(part.fields.count).toBe(1)
		expect(part.fields.end[0]).toBe(-1)
		expect(part.fieldInstruction(0)).toBe("PAGE")
	})
})

describe("links, bookmarks and comments", () => {
	it("resolves hyperlinks without fetching anything", async () => {
		const model = await sound({
			body: '<w:p><w:hyperlink r:id="rId5" w:tooltip="tip"><w:r><w:t>out</w:t></w:r></w:hyperlink><w:hyperlink w:anchor="_Toc1" w:history="1"><w:r><w:t>in</w:t></w:r></w:hyperlink></w:p>',
			relationships: [{ id: "rId5", type: "hyperlink", target: "https://example.com/a?b=1", external: true }]
		})
		const part = body(model)
		const [external, internal] = itemsOf(part, Item.Hyperlink)

		expect(part.hyperlink(external ?? -1)).toMatchObject({
			relationshipId: "rId5",
			target: "https://example.com/a?b=1",
			external: true,
			tooltip: "tip"
		})
		expect(part.hyperlink(internal ?? -1)).toMatchObject({ relationshipId: undefined, anchor: "_Toc1", external: false })
	})

	it("pairs bookmarks and comment ranges and reads the comment parts", async () => {
		const model = await sound({
			body:
				'<w:bookmarkStart w:id="0" w:name="top"/><w:p w14:paraId="00000001"><w:commentRangeStart w:id="7"/><w:r><w:t>commented</w:t></w:r>' +
				'<w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r><w:r><w:commentReference w:id="8"/></w:r></w:p>' +
				'<w:p><w:bookmarkEnd w:id="0"/><w:bookmarkStart w:id="41" w:name="_Toc1" w:colFirst="0" w:colLast="1"/><w:bookmarkEnd w:id="41"/></w:p>',
			comments:
				'<w:comment w:id="7" w:author="Ann" w:date="2024-01-02T03:04:05Z" w:initials="A"><w:p w14:paraId="0A0A0A0A"><w:r><w:annotationRef/></w:r><w:r><w:t>note</w:t></w:r></w:p></w:comment>' +
				'<w:comment w:id="8" w:author="Bob"><w:p w14:paraId="0B0B0B0B"><w:r><w:t>reply</w:t></w:r></w:p></w:comment>',
			commentsExtended: `<w15:commentsEx ${NAMESPACES}><w15:commentEx w15:paraId="0A0A0A0A" w15:done="1"/><w15:commentEx w15:paraId="0b0b0b0b" w15:paraIdParent="0A0A0A0A" w15:done="0"/></w15:commentsEx>`,
			commentsIds: `<w16cid:commentsIds ${NAMESPACES}><w16cid:commentId w16cid:paraId="0A0A0A0A" w16cid:durableId="11223344"/></w16cid:commentsIds>`,
			commentsExtensible: `<w16cex:commentsExtensible ${NAMESPACES}><w16cex:commentExtensible w16cex:durableId="11223344" w16cex:dateUtc="2024-01-02T03:04:05Z"/></w16cex:commentsExtensible>`,
			people: `<w15:people ${NAMESPACES}><w15:person w15:author="Ann"><w15:presenceInfo w15:providerId="None" w15:userId="Ann"/></w15:person></w15:people>`
		})
		const part = body(model)
		const bookmarks = part.bookmarks

		expect(bookmarks.count).toBe(2)
		expect(part.bookmarkName(bookmarks.ids.get("0") ?? -1)).toBe("top")
		expect(part.kinds[bookmarks.start[0] ?? -1]).toBe(Item.BookmarkStart)
		expect(part.kinds[bookmarks.end[0] ?? -1]).toBe(Item.BookmarkEnd)
		expect(model.maxIds.bookmark).toBe(41)
		expect(model.maxIds.comment).toBe(8)

		const anchors = model.commentAnchors
		const row = anchors.ids.get("7") ?? -1

		expect(anchors.startPart[row]).toBe(part.index)
		expect(part.kinds[anchors.startItem[row] ?? -1]).toBe(Item.CommentRangeStart)
		expect(part.kinds[anchors.endItem[row] ?? -1]).toBe(Item.CommentRangeEnd)
		expect(part.kinds[anchors.referenceItem[row] ?? -1]).toBe(Item.CommentReference)
		expect(model.comments).toEqual([
			{
				id: "7",
				story: expect.any(Number),
				author: "Ann",
				initials: "A",
				date: "2024-01-02T03:04:05Z",
				paraId: "0A0A0A0A",
				parentId: undefined,
				done: true,
				durableId: "11223344",
				dateUtc: "2024-01-02T03:04:05Z",
				anchor: row
			},
			expect.objectContaining({ id: "8", author: "Bob", parentId: "7", done: false, paraId: "0B0B0B0B" })
		])
		expect(model.people).toEqual([{ author: "Ann", providerId: "None", userId: "Ann" }])

		const comment = model.stories[model.comments[0]?.story ?? -1]

		expect(comment?.kind).toBe("comment")
		expect(model.partOf(comment ?? (model.body as never)).paragraphText(comment?.item ?? -1)).toBe("note")
	})
})

describe("tracked changes", () => {
	it("records wrappers and property changes with author, date and id", async () => {
		const model = await sound({
			body:
				'<w:p><w:pPr><w:pStyle w:val="A"/><w:rPr><w:ins w:id="1" w:author="Ann" w:date="2024-01-01T00:00:00Z"/></w:rPr><w:pPrChange w:id="2" w:author="Ann"><w:pPr/></w:pPrChange></w:pPr>' +
				'<w:ins w:id="3" w:author="Ann" w:date="2024-01-01T00:00:00Z"><w:r><w:t>new </w:t></w:r></w:ins>' +
				'<w:del w:id="4" w:author="Bob"><w:r><w:delText>old </w:delText></w:r></w:del>' +
				'<w:r><w:rPr><w:b/><w:rPrChange w:id="5" w:author="Bob"><w:rPr/></w:rPrChange></w:rPr><w:t>same</w:t></w:r></w:p>' +
				'<w:moveFromRangeStart w:id="6" w:name="move1" w:author="Ann"/><w:p><w:moveFrom w:id="7" w:author="Ann"><w:r><w:t>moved</w:t></w:r></w:moveFrom></w:p><w:moveFromRangeEnd w:id="6"/>' +
				'<w:moveToRangeStart w:id="8" w:name="move1" w:author="Ann"/><w:p><w:moveTo w:id="9" w:author="Ann"><w:r><w:t>moved</w:t></w:r></w:moveTo></w:p><w:moveToRangeEnd w:id="8"/>' +
				'<w:tbl><w:tblPr><w:tblStyle w:val="Grid"/><w:tblPrChange w:id="10" w:author="C"><w:tblPr/></w:tblPrChange></w:tblPr><w:tblGrid><w:gridCol w:w="100"/></w:tblGrid>' +
				'<w:tr><w:trPr><w:ins w:id="11" w:author="C"/></w:trPr><w:tc><w:tcPr><w:cellIns w:id="12" w:author="C"/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>' +
				'<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/><w:numberingChange w:id="13" w:author="C" w:original="%1."/></w:numPr></w:pPr></w:p>' +
				'<w:sectPr><w:sectPrChange w:id="14" w:author="C"><w:sectPr/></w:sectPrChange></w:sectPr>'
		})
		const part = body(model)
		const revisions = part.revisions
		const kinds = Array.from(revisions.kind)

		expect(kinds).toEqual([
			Revision.ParagraphMarkInsertion,
			Revision.ParagraphProperties,
			Revision.Insertion,
			Revision.Deletion,
			Revision.RunProperties,
			Revision.MoveFromRange,
			Revision.MoveFrom,
			Revision.MoveToRange,
			Revision.MoveTo,
			Revision.TableProperties,
			Revision.RowInsertion,
			Revision.CellInsertion,
			Revision.Numbering,
			Revision.SectionProperties
		])
		expect(Array.from(revisions.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
		expect(model.string(revisions.author[3] ?? -1)).toBe("Bob")
		expect(model.string(revisions.date[2] ?? -1)).toBe("2024-01-01T00:00:00Z")
		expect(model.maxIds.revision).toBe(14)
		expect(part.kinds[revisions.item[2] ?? -1]).toBe(Item.Insertion)
		expect(part.kinds[revisions.item[4] ?? -1]).toBe(Item.Run)
		expect(part.runs.rPrChange[part.runRow(revisions.item[4] ?? -1)]).toBe(revisions.node[4])
		expect(model.string(part.tables.style[0] ?? -1)).toBe("Grid")

		const paragraph = first(part, Item.Paragraph)

		expect(part.paragraphText(paragraph, RevisionView.Final)).toBe("new same")
		expect(part.paragraphText(paragraph, RevisionView.Original)).toBe("old same")
		expect(part.paragraphText(paragraph, RevisionView.Markup)).toBe("new old same")

		const walker = new ItemWalker(RevisionView.Final).reset(part, paragraph)
		const seen: number[] = []

		for (let item = walker.next(); item >= 0; item = walker.next()) seen.push(part.kinds[item] ?? 0)

		expect(seen).toEqual([Item.Insertion, Item.Run, Item.Text, Item.Run, Item.Text])

		walker.setView(RevisionView.Markup)
		walker.reset(part, paragraph)

		const skipped: number[] = []

		for (let item = walker.next(); item >= 0; item = walker.next()) {
			skipped.push(part.kinds[item] ?? 0)

			if (part.kinds[item] === Item.Run) walker.skip(item)
		}

		expect(skipped).toEqual([Item.Insertion, Item.Run, Item.Deletion, Item.Run, Item.Run])
	})
})

describe("notes", () => {
	it("models note references and note stories with separators", async () => {
		const model = await sound({
			body: '<w:p><w:r><w:t>x</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:endnoteReference w:id="2"/></w:r></w:p>',
			footnotes:
				'<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
				'<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>' +
				'<w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Note.</w:t></w:r></w:p></w:footnote>',
			endnotes: '<w:endnote w:id="2"><w:p><w:r><w:endnoteRef/></w:r><w:r><w:t>End.</w:t></w:r></w:p></w:endnote>',
			settings: '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>'
		})
		const part = body(model)

		expect(part.aux[first(part, Item.FootnoteReference)]).toBe(1)
		expect(part.aux[first(part, Item.EndnoteReference)]).toBe(2)
		expect([...model.footnotes.keys()]).toEqual(["-1", "0", "1"])
		expect(model.footnotes.get("-1")?.noteType).toBe("separator")
		expect(model.footnotes.get("0")?.noteType).toBe("continuationSeparator")
		expect(model.footnotes.get("1")?.noteType).toBe("normal")
		expect(model.settings.footnoteSeparators).toEqual(["-1", "0"])
		expect(model.maxIds.footnote).toBe(1)
		expect(model.maxIds.endnote).toBe(2)

		const note = model.footnotes.get("1")

		if (note === undefined) throw new Error("note missing")

		const notes = model.partOf(note)

		expect(notes.paragraphText(note.item)).toBe(" Note.")
		expect(itemsOf(notes, Item.FootnoteMark)).toHaveLength(1)
		expect(itemsOf(notes, Item.Separator)).toHaveLength(1)
		expect(itemsOf(notes, Item.ContinuationSeparator)).toHaveLength(1)
	})
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

function inline(graphic: string, extra: string = ""): string {
	return (
		'<w:r><w:drawing><wp:inline distT="0" distB="0" distL="114300" distR="0"><wp:extent cx="914400" cy="457200"/><wp:effectExtent l="1" t="2" r="3" b="4"/>' +
		`<wp:docPr id="5" name="Picture 5" descr="alt" hidden="1"/>${extra}<a:graphic>${graphic}</a:graphic></wp:inline></w:drawing></w:r>`
	)
}

const PICTURE =
	'<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData>'

const TEXTBOX =
	'<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:spPr/><wps:txbx><w:txbxContent>' +
	"<w:p><w:r><w:t>boxed</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData>"

describe("drawings", () => {
	it("reads inline pictures and serves internal media only", async () => {
		const model = await sound({
			body:
				`<w:p>${inline(PICTURE)}` +
				inline(
					'<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:link="rIdExt"/></pic:blipFill></pic:pic></a:graphicData>'
				) +
				"</w:p>",
			relationships: [
				{ id: "rIdImg", type: "image", target: "media/image1.png" },
				{ id: "rIdExt", type: "image", target: "https://tracker.example/pixel.png", external: true }
			],
			parts: [{ name: "word/media/image1.png", data: PNG }]
		})
		const [picture, linked] = model.drawings

		expect(picture).toMatchObject({
			placement: "inline",
			graphic: "picture",
			width: 914400,
			height: 457200,
			effectLeft: 1,
			effectBottom: 4,
			distLeft: 114300,
			docPrId: 5,
			hidden: true,
			embedId: "rIdImg",
			linkId: undefined,
			anchor: undefined,
			textboxes: 0
		})
		expect(model.maxIds.docPr).toBe(5)

		const ref = model.mediaRef(picture?.part ?? -1, picture?.embedId ?? "")

		expect(ref).toMatchObject({ partName: "word/media/image1.png", contentType: "image/png", external: false, size: PNG.length })
		expect(await model.media(ref ?? (undefined as never))).toEqual(PNG)

		const external = model.mediaRef(linked?.part ?? -1, linked?.linkId ?? "")

		expect(external).toMatchObject({ external: true, partName: undefined, target: "https://tracker.example/pixel.png" })
		expect(await model.media(external ?? (undefined as never))).toBeUndefined()
	})

	it("reads anchors, positions and wrapping", async () => {
		const model = await sound({
			body:
				'<w:p><w:r><w:drawing><wp:anchor distT="1" distB="2" distL="3" distR="4" simplePos="0" relativeHeight="251659264" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">' +
				'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>228600</wp:posOffset></wp:positionH>' +
				'<wp:positionV relativeFrom="page"><wp:align>center</wp:align></wp:positionV><wp:extent cx="10" cy="20"/><wp:effectExtent l="0" t="0" r="0" b="0"/>' +
				'<wp:wrapTight wrapText="bothSides"><wp:wrapPolygon edited="0"><wp:start x="0" y="0"/><wp:lineTo x="1" y="1"/></wp:wrapPolygon></wp:wrapTight>' +
				'<wp:docPr id="12" name="Shape"/><wp:cNvGraphicFramePr/><a:graphic>' +
				PICTURE +
				'</a:graphic><wp14:sizeRelH relativeFrom="margin"><wp14:pctWidth>0</wp14:pctWidth></wp14:sizeRelH></wp:anchor></w:drawing></w:r></w:p>',
			relationships: [{ id: "rIdImg", type: "image", target: "media/image1.png" }],
			parts: [{ name: "word/media/image1.png", data: PNG }]
		})
		const drawing = model.drawings[0]

		expect(drawing?.placement).toBe("anchor")
		expect(drawing?.anchor).toMatchObject({
			behindDoc: true,
			locked: false,
			layoutInCell: true,
			allowOverlap: true,
			relativeHeight: 251659264,
			simplePos: false,
			horizontal: { relativeFrom: "column", align: undefined, offset: 228600 },
			vertical: { relativeFrom: "page", align: "center", offset: undefined },
			wrap: "tight",
			wrapText: "bothSides"
		})
		expect(drawing?.distRight).toBe(4)
	})

	it("turns shape text boxes into nested stories", async () => {
		const model = await sound({
			body:
				`<w:p><w:r><w:t>before</w:t></w:r>${inline(TEXTBOX)}<w:r><w:t>after</w:t></w:r></w:p>` +
				'<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><wp:docPr id="7" name="g"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:wgp>' +
				"<wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>one</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp>" +
				"<wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>two</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></wpg:wgp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
		})
		const part = body(model)
		const textboxes = model.stories.filter(story => story.kind === "textbox")

		expect(model.drawings.map(drawing => [drawing.graphic, drawing.textboxes])).toEqual([
			["shape", 1],
			["group", 2]
		])
		expect(textboxes.map(story => part.paragraphText(story.item))).toEqual(["boxed\ncell", "one", "two"])
		expect(textboxes[0]?.owner).toBe(model.drawings[0]?.item)
		expect(textboxes[0]?.parent).toBe(model.body?.index)
		expect(part.tables.depth[0]).toBe(0)
		// The paragraph's own text leaves the text box out.
		expect(part.paragraphText(first(part, Item.Paragraph))).toBe("beforeafter")
	})

	it("classifies charts, SmartArt, ink and unknown graphics", async () => {
		const model = await sound({
			body:
				"<w:p>" +
				inline(
					'<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rIdChart"/></a:graphicData>'
				) +
				inline(
					'<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds r:dm="rIdDm" r:lo="rIdLo" r:qs="rIdQs" r:cs="rIdCs"/></a:graphicData>'
				) +
				inline(
					'<a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"><w14:contentPart r:id="rIdInk"/></a:graphicData>'
				) +
				inline('<a:graphicData uri="urn:future:graphic"><x:thing xmlns:x="urn:future:graphic"/></a:graphicData>') +
				"</w:p>",
			relationships: [
				{ id: "rIdChart", type: "chart", target: "charts/chart1.xml" },
				{ id: "rIdDm", type: "diagramData", target: "diagrams/data1.xml" },
				{
					id: "rIdDsp",
					type: "http://schemas.microsoft.com/office/2007/relationships/diagramDrawing",
					target: "diagrams/drawing1.xml"
				}
			],
			parts: [
				{
					name: "word/charts/chart1.xml",
					data: '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>'
				},
				{
					name: "word/diagrams/data1.xml",
					data: '<dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram"><dgm:extLst><a:ext xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" uri="x"><dsp:dataModelExt relId="rIdDsp" minVer="http://schemas.openxmlformats.org/drawingml/2006/diagram"/></a:ext></dgm:extLst></dgm:dataModel>'
				},
				{
					name: "word/diagrams/drawing1.xml",
					data: '<dsp:drawing xmlns:dsp="http://schemas.microsoft.com/office/drawing/2008/diagram"/>'
				}
			]
		})
		const [chart, smartArt, ink, unknown] = model.drawings

		expect([chart?.graphic, smartArt?.graphic, ink?.graphic, unknown?.graphic]).toEqual(["chart", "smartArt", "ink", "unknown"])
		expect(model.chartPart(chart ?? (undefined as never))).toBe("word/charts/chart1.xml")
		expect(smartArt?.diagram).toEqual({ data: "rIdDm", layout: "rIdLo", style: "rIdQs", colors: "rIdCs" })
		expect(await model.smartArtDrawingPart(smartArt ?? (undefined as never))).toBe("word/diagrams/drawing1.xml")
		expect(unknown?.graphicUri).toBe("urn:future:graphic")
	})

	it("selects supported mc:Choice branches and falls back otherwise, recording both", async () => {
		const model = await sound({
			body:
				'<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:extent cx="1" cy="1"/><wp:docPr id="1" name="a"/><a:graphic>' +
				TEXTBOX +
				"</a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:rect><v:textbox><w:txbxContent><w:p><w:r><w:t>boxed</w:t></w:r></w:p></w:txbxContent></v:textbox></v:rect></w:pict></mc:Fallback></mc:AlternateContent></w:r>" +
				'<w:r><mc:AlternateContent><mc:Choice Requires="wpi"><w:drawing/></mc:Choice><mc:Fallback><w:t>ink fallback</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>' +
				'<mc:AlternateContent><mc:Choice Requires="w14"><w:p><w:r><w:t>choice</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>fallback</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>'
		})
		const part = body(model)
		const alternates = part.alternates

		expect(alternates.count).toBe(3)
		expect(alternates.selected[0]).toBe(alternates.branches[alternates.firstBranch[0] ?? -1])
		expect(Array.from(alternates.branchCount)).toEqual([2, 2, 2])
		expect(alternates.selected[1]).toBe(alternates.fallback[1])
		expect(alternates.fallback[0]).toBeGreaterThan(0)
		// The fallback's copy of the text box is not a second story.
		expect(model.stories.filter(story => story.kind === "textbox")).toHaveLength(1)
		expect(model.vml).toHaveLength(0)
		expect(part.paragraphText(first(part, Item.Paragraph))).toBe("ink fallback")
		expect(part.paragraphText(model.body?.item ?? -1)).toBe("ink fallback\nchoice")
	})

	it("reads VML pictures, text boxes, watermarks and OLE objects", async () => {
		const model = await sound({
			body:
				'<w:p><w:r><w:pict><v:shapetype id="_x0000_t75"/><v:shape id="s1" type="#_x0000_t75" style="width:10pt"><v:imagedata r:id="rIdImg" o:title=""/></v:shape></w:pict></w:r>' +
				'<w:r><w:pict><v:shape id="wm"><v:textpath style="font-family:Calibri" string="DRAFT"/></v:shape></w:pict></w:r>' +
				"<w:r><w:pict><v:rect><v:textbox><w:txbxContent><w:p><w:r><w:t>vml box</w:t></w:r></w:p></w:txbxContent></v:textbox></v:rect></w:pict></w:r>" +
				'<w:r><w:object w:dxaOrig="100" w:dyaOrig="100"><v:shape id="ole"><v:imagedata r:id="rIdImg"/></v:shape><o:OLEObject Type="Embed" ProgID="Excel.Sheet.12" ShapeID="ole" r:id="rIdOle"/></w:object></w:r></w:p>',
			relationships: [{ id: "rIdImg", type: "image", target: "media/image1.png" }],
			parts: [{ name: "word/media/image1.png", data: PNG }]
		})
		const [picture, watermark, box, object] = model.vml

		expect(picture).toMatchObject({ kind: "picture", shapeType: "shape", imageId: "rIdImg", textboxes: 0 })
		expect(watermark?.textPath).toBeGreaterThan(0)
		expect(box).toMatchObject({ shapeType: "rect", textboxes: 1 })
		expect(object).toMatchObject({ kind: "object", progId: "Excel.Sheet.12", oleId: "rIdOle", imageId: "rIdImg" })
		expect(itemsOf(body(model), Item.EmbeddedObject)).toHaveLength(1)
		expect(model.stories.filter(story => story.kind === "textbox")).toHaveLength(1)
	})

	it("keeps an OLE object's text boxes and drawing preview in document order", async () => {
		const model = await sound({
			body:
				'<w:p><w:r><w:object><v:shape id="o"><v:textbox><w:txbxContent><w:p><w:r><w:t>first</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape>' +
				inline(PICTURE).replace("<w:r>", "").replace("</w:r>", "") +
				'<o:OLEObject Type="Embed" ProgID="Word.Document.12" r:id="rIdOle"/></w:object></w:r></w:p>',
			relationships: [{ id: "rIdImg", type: "image", target: "media/image1.png" }],
			parts: [{ name: "word/media/image1.png", data: PNG }]
		})
		const part = body(model)
		const object = first(part, Item.EmbeddedObject)
		const children: number[] = []

		for (let child = part.firstChild(object); child >= 0; child = part.nextSibling(child)) children.push(part.kinds[child] ?? 0)

		expect(children).toEqual([Item.Textbox, Item.Drawing])
		expect(model.vml[0]).toMatchObject({ kind: "object", textboxes: 1, progId: "Word.Document.12" })
		expect(model.drawings[0]?.graphic).toBe("picture")
	})

	it("keeps equations as opaque subtrees", async () => {
		const model = await sound({
			body: "<w:p><m:oMathPara><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara></w:p><w:p><w:r><w:t>a</w:t></w:r><m:oMath><m:r><m:t>y</m:t></m:r></m:oMath></w:p>"
		})
		const part = body(model)

		expect(itemsOf(part, Item.MathParagraph)).toHaveLength(1)
		expect(itemsOf(part, Item.Math)).toHaveLength(1)
		expect(part.end(first(part, Item.MathParagraph))).toBe(first(part, Item.MathParagraph) + 1)
	})
})

describe("content controls, tables and sections", () => {
	it("models content controls at every level", async () => {
		const model = await sound({
			body:
				'<w:sdt><w:sdtPr><w:alias w:val="Block"/><w:id w:val="1"/><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtEndPr/><w:sdtContent>' +
				p("in block") +
				"</w:sdtContent></w:sdt>" +
				'<w:p><w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>☒</w:t></w:r></w:sdtContent></w:sdt></w:p>' +
				"<w:tbl><w:tblGrid/><w:sdt><w:sdtPr><w:dropDownList/></w:sdtPr><w:sdtContent><w:tr><w:sdt><w:sdtPr><w:date/></w:sdtPr><w:sdtContent><w:tc><w:p/></w:tc></w:sdtContent></w:sdt></w:tr></w:sdtContent></w:sdt></w:tbl>"
		})
		const part = body(model)
		const sdts = part.sdts

		expect(Array.from(sdts.level)).toEqual([SdtLevel.Block, SdtLevel.Run, SdtLevel.Row, SdtLevel.Cell])
		expect([0, 1, 2, 3].map(sdt => part.sdtType(sdt))).toEqual(["docPartObj", "checkbox", "dropDownList", "date"])
		expect(part.document.name(sdts.sdtEndPr[0] ?? -1)).toBe("w:sdtEndPr")
		expect(itemsOf(part, Item.Row)).toHaveLength(1)
		expect(itemsOf(part, Item.Cell)).toHaveLength(1)
		expect(part.paragraphText(model.body?.item ?? -1)).toBe("in block\n☒\n")
	})

	it("models nested tables with their property references", async () => {
		const inner =
			'<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>deep</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
		const model = await sound({
			body: `<w:tbl><w:tblPr><w:tblStyle w:val="T"/></w:tblPr><w:tblGrid><w:gridCol/></w:tblGrid><w:tr><w:tblPrEx/><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${inner}<w:p/></w:tc></w:tr></w:tbl>`
		})
		const part = body(model)

		expect(part.tables.count).toBe(2)
		expect(Array.from(part.tables.depth)).toEqual([0, 1])
		expect(part.document.name(part.rows.trPr[0] ?? -1)).toBe("w:trPr")
		expect(part.document.name(part.rows.tblPrEx[0] ?? -1)).toBe("w:tblPrEx")
		expect(part.document.name(part.cells.tcPr[0] ?? -1)).toBe("w:tcPr")
		expect(part.cells.tcPr[1]).toBe(-1)
		expect(modelStats(model)).toMatchObject({ tables: 2, nestedTables: 1, maxTableDepth: 1, rows: 2, cells: 2 })
	})

	it("splits the body into sections with inherited headers and footers", async () => {
		const sectPr = (refs: string) => `<w:sectPr>${refs}<w:pgSz w:w="11906" w:h="16838"/></w:sectPr>`
		const model = await sound({
			body:
				p("one") +
				`<w:p><w:pPr>${sectPr('<w:headerReference w:type="default" r:id="rH1"/><w:headerReference w:type="first" r:id="rH2"/><w:footerReference w:type="default" r:id="rF1"/>')}</w:pPr></w:p>` +
				p("two") +
				`<w:tbl><w:tr><w:tc><w:p><w:pPr>${sectPr("")}</w:pPr></w:p></w:tc></w:tr></w:tbl>` +
				`<w:p><w:pPr>${sectPr('<w:headerReference w:type="even" r:id="rH3"/>')}</w:pPr></w:p>` +
				p("three") +
				sectPr('<w:headerReference w:type="default" r:id="rH3"/><w:footerReference w:type="even" r:id="rMissing"/>'),
			headers: { rH1: p("H1"), rH2: p("H2"), rH3: p("H3") },
			footers: { rF1: p("F1") },
			relationships: [{ id: "rMissing", type: "footer", target: "footer9.xml" }]
		})
		const part = body(model)
		const sections = model.sections
		const story = (index: number): string => {
			const target = model.stories[index]

			return target === undefined ? "-" : model.partOf(target).paragraphText(target.item)
		}

		expect(sections).toHaveLength(3)
		expect(model.counts.ignoredSectionProperties).toBe(1)
		expect(story(sections[0]?.headers.default ?? -1)).toBe("H1")
		expect(story(sections[0]?.headers.first ?? -1)).toBe("H2")
		expect(story(sections[0]?.footers.default ?? -1)).toBe("F1")
		expect(sections[1]?.headers.default).toBe(-1)
		expect(story(sections[1]?.effectiveHeaders.default ?? -1)).toBe("H1")
		expect(story(sections[1]?.effectiveHeaders.even ?? -1)).toBe("H3")
		expect(story(sections[2]?.headers.default ?? -1)).toBe("H3")
		expect(story(sections[2]?.effectiveHeaders.first ?? -1)).toBe("H2")
		expect(story(sections[2]?.effectiveFooters.default ?? -1)).toBe("F1")
		expect(model.missingParts).toEqual(["word/footer9.xml"])
		expect(part.kinds[sections[2]?.item ?? -1]).toBe(Item.SectionProperties)
		expect(sections[0]?.start).toBe((model.body?.item ?? 0) + 1)
		expect(sections[1]?.start).toBe(sections[0]?.end)
		expect(sections[2]?.end).toBe(part.end(model.body?.item ?? -1))

		const walker = new ItemWalker().resetRange(part, sections[1]?.start ?? 0, sections[1]?.end ?? 0)
		const kinds: number[] = []

		for (let item = walker.next(); item >= 0; item = walker.next()) kinds.push(part.kinds[item] ?? 0)

		expect(kinds).toEqual([Item.Paragraph, Item.Table, Item.Paragraph])
	})

	it("keeps altChunk as an opaque block that is never rendered", async () => {
		const model = await sound({
			body: `${p("a")}<w:altChunk r:id="rIdChunk"/>${p("b")}`,
			relationships: [{ id: "rIdChunk", type: "aFChunk", target: "chunk.html" }],
			parts: [{ name: "word/chunk.html", contentType: "text/html", data: "<script>alert(1)</script>" }]
		})
		const part = body(model)

		expect(itemsOf(part, Item.AltChunk)).toHaveLength(1)
		expect(part.paragraphText(model.body?.item ?? -1)).toBe("a\nb")
	})
})

describe("robustness", () => {
	it("limits nesting depth instead of overflowing the stack", async () => {
		const depth = 2000
		const model = await modelOf({ body: "<w:customXml>".repeat(depth) + p("deep") + "</w:customXml>".repeat(depth) })

		expect(model.counts.depthLimited).toBe(1)
		expect(modelProblems(model)).toEqual([])
	})

	it("limits text boxes nested in text boxes", async () => {
		const depth = 400
		const open = "<w:p><w:r><w:pict><v:rect><v:textbox><w:txbxContent>"
		const close = "</w:txbxContent></v:textbox></v:rect></w:pict></w:r></w:p>"
		const model = await modelOf({ body: open.repeat(depth) + p("deep") + close.repeat(depth) })

		expect(model.counts.depthLimited).toBeGreaterThan(0)
		expect(model.stories.filter(story => story.kind === "textbox").length).toBeLessThan(depth)
		expect(modelProblems(model)).toEqual([])
	})

	it("resolves namespaces declared below the root and unusual prefixes", async () => {
		const model = await sound({
			document:
				'<?xml version="1.0"?><ns0:document xmlns:ns0="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><ns0:body>' +
				"<ns0:p><ns0:r><ns0:t>one</ns0:t></ns0:r></ns0:p>" +
				'<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
				"</ns0:body></ns0:document>"
		})
		const part = body(model)

		expect(part.paragraphs.count).toBe(2)
		expect(part.fieldType(0)).toBe("PAGE")
		expect(part.paragraphText(model.body?.item ?? -1)).toBe("one\n")
	})

	it("reads Strict documents", async () => {
		const model = await sound({
			strict: true,
			body: '<w:p><w:hyperlink r:id="rIdL"><w:r><w:t>strict</w:t></w:r></w:hyperlink></w:p>',
			relationships: [{ id: "rIdL", type: "hyperlink", target: "https://example.com", external: true }]
		})
		const part = body(model)

		expect(model.strict).toBe(true)
		expect(model.package.facts.strict).toBe(true)
		expect(part.paragraphText(model.body?.item ?? -1)).toBe("strict")
		expect(part.hyperlink(first(part, Item.Hyperlink)).target).toBe("https://example.com")
	})

	it("reads settings facts", async () => {
		const model = await sound({
			body: p("x"),
			settings:
				'<w:writeProtection w:recommended="1"/><w:trackRevisions/><w:documentProtection w:edit="forms" w:enforcement="1" w:hashValue="abc"/>' +
				'<w:defaultTabStop w:val="720"/><w:evenAndOddHeaders w:val="false"/><w:mirrorMargins/><w:gutterAtTop w:val="1"/><w:updateFields w:val="true"/>' +
				'<w:autoHyphenation/><w:hyphenationZone w:val="357"/><w:characterSpacingControl w:val="doNotCompress"/>' +
				'<w:compat><w:doNotExpandShiftReturn/><w:suppressTopSpacing w:val="0"/><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat>' +
				'<w:themeFontLang w:val="en-GB" w:eastAsia="ja-JP"/><w:decimalSymbol w:val=","/><w:listSeparator w:val=";"/>'
		})

		expect(model.settings).toMatchObject({
			present: true,
			trackRevisions: true,
			evenAndOddHeaders: false,
			mirrorMargins: true,
			gutterAtTop: true,
			updateFields: true,
			autoHyphenation: true,
			defaultTabStop: 720,
			hyphenationZone: 357,
			compatibilityMode: 15,
			legacyCompat: ["doNotExpandShiftReturn"],
			documentProtection: { edit: "forms", enforced: true, formatting: false, hashed: true },
			writeProtection: { recommended: true, hashed: false },
			characterSpacingControl: "doNotCompress",
			themeFontLanguages: { latin: "en-GB", eastAsia: "ja-JP", bidi: undefined },
			decimalSymbol: ",",
			listSeparator: ";"
		})
	})
})

describe("hostile and malformed input", () => {
	it("reads attributes in one pass however many prefixes alias a namespace", async () => {
		const paragraphs =
			'<w:p><w:bookmarkStart w:id="1" w:name="b"/><w:r><w:fldChar w:fldCharType="begin"/><w:br w:type="page"/></w:r><w:bookmarkEnd w:id="1"/></w:p>'.repeat(
				4000
			)
		const aliases = Array.from(
			{ length: 3000 },
			(_, k) => `xmlns:q${k}="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`
		).join(" ")
		const time = async (extra: string): Promise<number> => {
			const start = cpuMs()
			const model = await modelOf({
				document: `<?xml version="1.0"?><w:document ${extra} ${NAMESPACES}><w:body>${paragraphs}</w:body></w:document>`
			})

			expect(body(model).bookmarks.count).toBe(1)
			expect(itemsOf(body(model), Item.Break).every(item => body(model).breakType(item) === BreakType.Page)).toBe(true)

			return cpuMs() - start
		}

		await time("")

		const baseline = await time("")
		const flooded = await time(aliases)

		expect(flooded).toBeLessThan(baseline * 5 + budget(200))

		const aliased = await sound({
			document: `<?xml version="1.0"?><w:document ${aliases} ${NAMESPACES}><w:body><w:p><w:pPr><w:pStyle q2999:val="X"/></w:pPr></w:p></w:body></w:document>`
		})

		expect(aliased.string(body(aliased).paragraphs.style[0] ?? -1)).toBe("X")
	})

	it("keeps bad references as written, searching for a reference's end within the value only", async () => {
		const model = await modelOf({
			body:
				'<w:p><w:r><w:t xml:space="preserve">a&b c&#xZZ; &amp;&lt; d&very-long-name; e&</w:t></w:r></w:p>' +
				`<w:p>${"<w:r><w:t>R&D</w:t></w:r>".repeat(4000)}</w:p>` +
				// Megabytes after them with no ';'.
				p("plain text ".repeat(400_000))
		})
		const part = body(model)
		const texts = itemsOf(part, Item.Text)

		expect(part.text(texts[0] ?? -1)).toBe("a&b c&#xZZ; &< d&very-long-name; e&")

		const start = cpuMs()
		let length = 0

		for (let k = 1; k <= 4000; k++) length += part.text(texts[k] ?? -1).length

		// With no ';' after them each bad '&' searched the rest of the part for one: seconds.
		expect(cpuMs() - start).toBeLessThan(budget(250))
		expect(length).toBe(4000 * 3)
	})

	it("keeps elements with unreadable start tags as opaque and never throws", async () => {
		const model = await sound({
			body:
				'<w:p><w:r><w:t w:x="1" w:x="2">dup</w:t><w:br w:type/><w:fldChar w:fldCharType=begin/><w:t>ok &bogus; &amp;</w:t></w:r>' +
				'<w:hyperlink w:anchor="a&bad;b"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>' +
				'<w:p><w:pPr><w:pStyle w:val="a" w:val="b"/></w:pPr><w:r><w:t>still here</w:t></w:r></w:p>' +
				'<w:p xmlns:z="a" xmlns:z="b"><w:r><w:t>opaque</w:t></w:r></w:p>'
		})
		const part = body(model)
		const opaque = itemsOf(part, Item.Opaque).map(item => part.document.name(part.node(item)))

		expect(opaque).toEqual(["w:t", "w:br", "w:fldChar", "w:p"])
		expect(part.paragraphs.style[1]).toBe(-1)
		expect(part.paragraphText(first(part, Item.Paragraph))).toBe("ok &bogus; &link")
		expect(part.hyperlink(first(part, Item.Hyperlink)).anchor).toBe("a&bad;b")
		expect(part.paragraphText(itemsOf(part, Item.Paragraph)[1] ?? -1)).toBe("still here")
		expect(model.counts.malformed).toBeGreaterThanOrEqual(5)
		expect(model.malformed).toBe(true)
		expect(gateReasons(model.package.facts, model)).toEqual(["malformed"])
	})

	it("leaves out parts that do not parse and parts in the wrong role", async () => {
		const model = await sound({
			body: `${p("x")}<w:sectPr><w:headerReference w:type="default" r:id="rH1"/><w:headerReference w:type="first" r:id="rSelf"/><w:footerReference w:type="default" r:id="rH1"/></w:sectPr>`,
			headers: { rH1: p("H") },
			footers: { rF1: "<w:p><w:r><w:t>broken</w:r></w:p>" },
			relationships: [{ id: "rSelf", type: "header", target: "document.xml" }]
		})
		const footerModel = await modelOf({
			body: `${p("x")}<w:sectPr><w:footerReference w:type="default" r:id="rF1"/></w:sectPr>`,
			footers: { rF1: "<w:p><w:r><w:t>broken</w:r></w:p>" }
		})

		expect(model.parts.map(part => part.name)).toEqual(["word/document.xml", "word/header1.xml"])
		expect(model.rejectedParts).toEqual(["word/document.xml"])
		expect(model.sections[0]?.headers).toEqual({
			default: model.stories.findIndex(story => story.kind === "header"),
			first: -1,
			even: -1
		})
		expect(model.sections[0]?.footers.default).toBe(-1)
		expect(footerModel.malformedParts).toEqual(["word/footer1.xml"])
		expect(footerModel.malformed).toBe(true)
		expect(footerModel.body).toBeDefined()
	})

	it("reads namespaces leniently when asked", () => {
		const document = parseXml(new TextEncoder().encode('<a xmlns:x="u"><b xmlns:y="v" xmlns:y="w"><y:c/></b></a>'))
		const lenient = new Namespaces(document, { lenient: true })

		expect(() => new Namespaces(document)).toThrow()
		expect(lenient.malformed).toEqual([2])
		expect(lenient.uri(2, "x")).toBe("u")
		expect(lenient.uri(2, "y")).toBeUndefined()
	})

	it("reads instructions of unterminated fields in linear time", async () => {
		const count = 20000
		const model = await modelOf({
			body: `<w:p>${'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r>'.repeat(count)}</w:p>`
		})
		const part = body(model)
		const start = performance.now()

		for (let field = 0; field < part.fields.count; field++) expect(part.fieldType(field)).toBe("PAGE")

		expect(part.fields.count).toBe(count)
		expect(performance.now() - start).toBeLessThan(budget(2000))
	})
})

describe("review fixes", () => {
	it("lists the wrappers a section starts inside", async () => {
		const model = await sound({
			body: `<w:sdt><w:sdtContent><w:customXml>${p("a", "<w:sectPr/>")}${p("b")}</w:customXml></w:sdtContent></w:sdt>${p("c")}<w:sectPr/>`
		})
		const part = body(model)
		const [first, second] = model.sections

		expect(first?.openWrappers).toEqual([])
		expect(second?.openWrappers.map(item => part.kinds[item])).toEqual([Item.Sdt, Item.CustomXml])
	})

	it("keeps a text box's pictures out of the VML shape around it", async () => {
		const inner = '<w:p><w:r><w:pict><v:shape id="i"><v:imagedata r:id="rImg"/></v:shape></w:pict></w:r></w:p>'
		const model = await sound({
			body: `<w:p><w:r><w:pict><v:shape id="tb"><v:textbox><w:txbxContent>${inner}</w:txbxContent></v:textbox></v:shape></w:pict></w:r></w:p>`
		})

		expect(model.vml.map(vml => [vml.textboxes, vml.imageId])).toEqual([
			[1, undefined],
			[0, "rImg"]
		])
	})

	it("hides deleted rows, cells and paragraph marks by view", async () => {
		const row = (trPr: string, cell: string) => `<w:tr>${trPr}<w:tc><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc></w:tr>`
		const model = await sound({
			body:
				'<w:p><w:pPr><w:rPr><w:del w:id="1" w:author="A"/></w:rPr></w:pPr><w:r><w:t>one</w:t></w:r></w:p>' +
				'<w:p><w:pPr><w:rPr><w:ins w:id="2" w:author="A"/></w:rPr></w:pPr><w:r><w:t>two</w:t></w:r></w:p>' +
				p("three") +
				"<w:tbl>" +
				row('<w:trPr><w:del w:id="3" w:author="A"/></w:trPr>', "gone") +
				row('<w:trPr><w:ins w:id="4" w:author="A"/></w:trPr>', "new") +
				'<w:tr><w:tc><w:tcPr><w:cellIns w:id="5" w:author="A"/></w:tcPr><w:p><w:r><w:t>cellNew</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:cellDel w:id="6" w:author="A"/></w:tcPr><w:p><w:r><w:t>cellGone</w:t></w:r></w:p></w:tc></w:tr>' +
				"</w:tbl>"
		})
		const part = body(model)
		const [one, two] = itemsOf(part, Item.Paragraph)
		const story = model.body?.item ?? -1

		expect(part.paragraphs.markRevision[part.paragraphRow(one ?? -1)]).toBe(RevisionFlag.Deleted)
		expect(part.revisions.kind[part.paragraphs.markRevisionRow[part.paragraphRow(one ?? -1)] ?? -1]).toBe(
			Revision.ParagraphMarkDeletion
		)
		expect(part.paragraphMarkHidden(one ?? -1, RevisionView.Final)).toBe(true)
		expect(part.paragraphMarkHidden(two ?? -1, RevisionView.Original)).toBe(true)
		expect(Array.from(part.rows.revision)).toEqual([RevisionFlag.Deleted, RevisionFlag.Inserted, 0])
		expect(Array.from(part.cells.revision)).toEqual([0, 0, RevisionFlag.Inserted, RevisionFlag.Deleted])
		expect(part.paragraphText(story, RevisionView.Final)).toBe("onetwo\nthree\nnew\ncellNew")
		expect(part.paragraphText(story, RevisionView.Original)).toBe("one\ntwothree\ngone\ncellGone")
		expect(part.paragraphText(story, RevisionView.Markup)).toBe("one\ntwo\nthree\ngone\nnew\ncellNew\ncellGone")

		const table = first(part, Item.Table)
		const rows = (view: RevisionView): number => {
			const walker = new ItemWalker(view).reset(part, table)
			let count = 0

			for (let item = walker.next(); item >= 0; item = walker.next()) count++

			return count
		}

		expect([rows(RevisionView.Markup), rows(RevisionView.Final), rows(RevisionView.Original)]).toEqual([3, 2, 2])
	})

	it("records every branch of an AlternateContent", async () => {
		const model = await sound({
			body: '<w:p><mc:AlternateContent><mc:Choice Requires="wpi"><w:r><w:t>ink</w:t></w:r></mc:Choice><mc:Choice Requires="wps"><w:r><w:t>wps</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>fb</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p>'
		})
		const part = body(model)
		const alternates = part.alternates
		const branches = Array.from(
			alternates.branches.subarray(alternates.firstBranch[0], (alternates.firstBranch[0] ?? 0) + (alternates.branchCount[0] ?? 0))
		)

		expect(branches.map(node => part.document.name(node))).toEqual(["mc:Choice", "mc:Choice", "mc:Fallback"])
		expect(alternates.selected[0]).toBe(branches[1])
		expect(alternates.fallback[0]).toBe(branches[2])
		expect(part.paragraphText(first(part, Item.Paragraph))).toBe("wps")
	})
})

describe("nesting limits, malformed parts, field views and interning", () => {
	it("limits AlternateContent nested inside drawings, VML and OLE objects", async () => {
		const depth = 20000
		const nest = (inner: string) =>
			"<mc:AlternateContent><mc:Fallback>".repeat(depth) + inner + "</mc:Fallback></mc:AlternateContent>".repeat(depth)
		const shape = "<v:shape><v:textbox><w:txbxContent><w:p/></w:txbxContent></v:textbox></v:shape>"

		for (const body of [
			`<w:p><w:r><w:pict>${nest(shape)}</w:pict></w:r></w:p>`,
			`<w:p><w:r><w:drawing>${nest("")}</w:drawing></w:r></w:p>`,
			`<w:p><w:r><w:object>${nest("<w:drawing/>")}</w:object></w:r></w:p>`
		]) {
			const model = await modelOf({ body })

			expect(model.counts.depthLimited).toBeGreaterThan(0)
			expect(modelProblems(model)).toEqual([])
		}
	})

	it("marks malformed property containers outside the content walk", async () => {
		const model = await sound({
			body:
				'<w:p><w:pPr><w:jc w:val="left" w:val="right"/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>' +
				'<w:tbl><w:tblPr><w:tblW w:w="1" w:w="2"/></w:tblPr><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>'
		})
		const clean = await sound({ body: '<w:p><w:pPr><w:jc w:val="left"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>x</w:t></w:r></w:p>' })

		expect(model.counts.malformed).toBe(2)
		expect(gateReasons(model.package.facts, model)).toEqual(["malformed"])
		expect(clean.malformed).toBe(false)
	})

	it("marks settings, styles, numbering and themes with malformed markup", async () => {
		const model = await sound({
			body: p("x"),
			settings: '<w:documentProtection w:edit="readOnly" w:enforcement="0" w:enforcement="1"/>'
		})

		expect(model.package.facts.malformed).toBe(true)
		expect(gateReasons(model.package.facts, model)).toEqual(["malformed"])

		const xml = (text: string) => parseXml(new TextEncoder().encode(text))
		const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
		const store = new PropsStore()
		const styles = parseStyles(xml(`<w:styles ${W}><w:style w:type="paragraph" w:styleId="A" w:styleId="B"/></w:styles>`), store)
		const numbering = parseNumbering(xml(`<w:numbering ${W}><w:num w:numId="1" w:numId="2"/></w:numbering>`), store)
		const theme = parseTheme(xml('<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="x" name="y"/>'))
		const cleanStyles = parseStyles(xml(`<w:styles ${W}><w:style w:type="paragraph" w:styleId="A"/></w:styles>`), store)

		expect([styles.malformed, numbering.malformed, theme.malformed, cleanStyles.malformed]).toEqual([true, true, true, false])
		expect(gateReasons(model.package.facts, undefined, cleanStyles)).toEqual(["malformed"])

		const fine = await sound({ body: p("x"), settings: '<w:documentProtection w:edit="readOnly" w:enforcement="1"/>' })

		expect(gateReasons(fine.package.facts, fine, cleanStyles)).toEqual(["protected"])
		expect(gateReasons(fine.package.facts, fine, styles)).toEqual(["protected", "malformed"])
	})

	it("reads field instructions as each revision view shows them", async () => {
		const run = (content: string) => `<w:r>${content}</w:r>`
		const model = await sound({
			body:
				`<w:p>${run('<w:fldChar w:fldCharType="begin"/>')}` +
				`<w:del w:id="1" w:author="a">${run('<w:delInstrText xml:space="preserve"> PAGE </w:delInstrText>')}</w:del>` +
				`<w:ins w:id="2" w:author="a">${run('<w:instrText xml:space="preserve"> NUMPAGES </w:instrText>')}</w:ins>` +
				`${run('<w:fldChar w:fldCharType="separate"/>')}${run("<w:t>3</w:t>")}${run('<w:fldChar w:fldCharType="end"/>')}</w:p>`
		})
		const part = body(model)

		expect(part.fieldType(0)).toBe("NUMPAGES")
		expect(part.fieldType(0, RevisionView.Original)).toBe("PAGE")
		expect(part.fieldInstruction(0, RevisionView.Markup)).toBe(" PAGE  NUMPAGES ")
	})

	it("interns property containers by the namespace bindings in scope where they sit", async () => {
		const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
		const runs = (first: string, second: string) =>
			`<?xml version="1.0"?><w:document ${NAMESPACES} xmlns:x="${W}"><w:body>` +
			`<w:p${first}><w:r><w:rPr><w:b/><x:i/></w:rPr><w:t>a</w:t></w:r></w:p>` +
			`<w:p${second}><w:r><w:rPr><w:b/><x:i/></w:rPr><w:t>b</w:t></w:r></w:p></w:body></w:document>`
		const italics = async (document: string, reverse: boolean): Promise<(boolean | undefined)[]> => {
			const model = await modelOf({ document })
			const part = body(model)
			const store = new PropsStore()
			const rows = [0, 1]

			if (reverse) rows.reverse()

			const out = rows.map(row => store.run(part.document, part.runs.rPr[row] ?? -1).italic)

			return reverse ? out.reverse() : out
		}
		const document = runs("", ' xmlns:x="urn:not-word"')

		expect(await italics(document, false)).toEqual([true, undefined])
		expect(await italics(document, true)).toEqual([true, undefined])
	})
})
