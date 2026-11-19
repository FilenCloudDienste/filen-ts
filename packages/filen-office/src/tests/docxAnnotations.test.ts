import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import type { FontExtents, TextMeasurer } from "@filen/office/core/text"
import {
	DocxEngine,
	RECT_FLOATS,
	markupInfo,
	parseDocxMarkupMode,
	revisionColor,
	type DocxAnnotations,
	type DocxEngineServices,
	type DocxOpenOptions,
	type DocxPageData
} from "@filen/office/dom/docx"
// The pure layout helpers by their own module: the React index needs the DOM typings.
import { indexAnnotations, placeBalloons } from "../react/docx/annotations/layout"
import { CORPUS_DIR } from "./corpusDir"
import { buildDocx } from "./docxSynthetic"

// Every character half an em wide, so positions inside a line are exact multiples.
const measurer: TextMeasurer = {
	kerningControl: true,
	measure(font, _kerning, texts, count, widths) {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		for (let i = 0; i < count; i++) widths[i] = (texts[i] ?? "").length * size * 0.5
	},
	fontExtents(font): FontExtents {
		const size = Number(/([\d.]+)px/.exec(font)?.[1] ?? "16")

		return { ascent: size * 0.8, descent: size * 0.2 }
	}
}

function services(): DocxEngineServices {
	return {
		fontHost: { addBytes: () => Promise.resolve(true), addLocal: () => Promise.resolve(false), remove: () => undefined },
		replayFonts: false,
		fontAssets: { read: () => Promise.resolve(new Uint8Array(4)) },
		measurer,
		yield: () => Promise.resolve(),
		sliceMs: Infinity
	}
}

async function open(
	bytes: Uint8Array,
	options: DocxOpenOptions = {}
): Promise<{ annotations: DocxAnnotations | null; pages: DocxPageData[]; counts: { comments?: number; revisions?: number } }> {
	const pages: DocxPageData[] = []
	let counts = {}
	const engine = new DocxEngine(
		bytesSource(bytes),
		services(),
		event => {
			if (event.type === "pages") for (const page of event.pages) pages[page.index] = page
			if (event.type === "opened") counts = { comments: event.info.comments, revisions: event.info.revisions }
		},
		options
	)

	await engine.run()

	const annotations = await engine.annotations()

	engine.close()

	return { annotations, pages, counts }
}

const W15 = "http://schemas.microsoft.com/office/word/2012/wordml"

const REVIEWED = buildDocx({
	body:
		'<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:commentRangeStart w:id="1"/><w:r><w:t>world</w:t></w:r>' +
		'<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r><w:r><w:t xml:space="preserve"> again</w:t></w:r></w:p>' +
		'<w:p><w:ins w:id="10" w:author="Bob" w:date="2024-01-02T03:04:05Z"><w:r><w:t>Inserted</w:t></w:r></w:ins>' +
		'<w:r><w:t xml:space="preserve"> kept </w:t></w:r>' +
		'<w:del w:id="11" w:author="Carol" w:date="2024-01-02T03:04:05Z"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>' +
		'<w:p><w:r><w:rPr><w:b/><w:rPrChange w:id="12" w:author="Bob" w:date="2024-01-03T00:00:00Z"><w:rPr/></w:rPrChange></w:rPr>' +
		"<w:t>Bolded</w:t></w:r></w:p>",
	comments:
		'<w:comment w:id="1" w:author="Alice" w:initials="A" w:date="2024-01-01T00:00:00Z"><w:p w14:paraId="00000001">' +
		'<w:r><w:t xml:space="preserve">Nice </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>point</w:t></w:r></w:p></w:comment>' +
		'<w:comment w:id="2" w:author="Bob" w:date="2024-01-01T01:00:00Z"><w:p><w:r><w:t>Agreed</w:t></w:r></w:p>' +
		// commentsExtended keys a comment on its last paragraph.
		'<w:p w14:paraId="00000002"/></w:comment>',
	commentsExtended:
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:w15="${W15}">` +
		'<w15:commentEx w15:paraId="00000001" w15:done="1"/><w15:commentEx w15:paraId="00000002" w15:paraIdParent="00000001" w15:done="0"/>' +
		"</w15:commentsEx>"
})

// The x and width a text range of one line gets with every character equally wide.
function lineMetrics(page: DocxPageData, source: number): { x: number; char: number } {
	for (let line = 0; line < page.lineCount; line++) {
		if (page.lineInts[line * 7 + 5] !== source) continue

		const start = page.lineInts[line * 7 + 2] ?? 0
		const end = page.lineInts[line * 7 + 3] ?? 0

		return { x: page.lineFloats[line * 5 + 3] ?? 0, char: (page.lineFloats[line * 5 + 4] ?? 0) / Math.max(1, end - start) }
	}

	throw new Error("no line")
}

describe("docx annotations", () => {
	it("reports comments with their thread, text and anchor boxes", async () => {
		const { annotations, pages, counts } = await open(REVIEWED)

		expect(counts).toEqual({ comments: 2, revisions: 3 })
		expect(annotations?.authors).toEqual(["Alice", "Bob", "Carol"])

		const [first, reply] = annotations?.comments ?? []

		expect(first).toMatchObject({
			id: "1",
			author: 0,
			initials: "A",
			date: "2024-01-01T00:00:00Z",
			parent: -1,
			done: true,
			rectCount: 1
		})
		expect(first?.paragraphs).toEqual([
			[
				{ text: "Nice ", bold: false, italic: false, underline: false, strike: false },
				{ text: "point", bold: true, italic: false, underline: false, strike: false }
			]
		])
		expect(reply).toMatchObject({ id: "2", author: 1, parent: 0, done: false, rectCount: 0 })
		// The empty paragraph at its end is dropped.
		expect(reply?.paragraphs).toHaveLength(1)

		const page = pages[0]

		if (page === undefined || annotations === null || annotations === undefined || first === undefined) throw new Error("not laid out")

		const { x, char } = lineMetrics(page, 0)
		const at = first.firstRect * RECT_FLOATS

		expect(annotations.rectPages[first.firstRect]).toBe(0)
		// "Hello " before it, "world" its text.
		expect(annotations.rectFloats[at]).toBeCloseTo(x + 6 * char, 3)
		expect(annotations.rectFloats[at + 2]).toBeCloseTo(5 * char, 3)
	})

	it("reports tracked changes as the view lays them out", async () => {
		const final = await open(REVIEWED)
		const markup = await open(REVIEWED, { view: "markup" })
		const kinds = (annotations: DocxAnnotations | null | undefined): string[] =>
			annotations?.revisions.map(revision => `${revision.kind}:${revision.target}:${revision.author}`) ?? []

		expect(kinds(final.annotations)).toEqual(["insertion:text:1", "deletion:text:2", "formatting:text:1"])
		expect(final.annotations?.revisions.map(revision => revision.text)).toEqual(["Inserted", "gone", ""])
		expect(final.annotations?.revisions[2]?.properties).toEqual(["b"])

		const width = (annotations: DocxAnnotations | null | undefined, index: number): number => {
			const revision = annotations?.revisions[index]

			return revision === undefined ? -1 : (annotations?.rectFloats[revision.firstRect * RECT_FLOATS + 2] ?? -1)
		}

		// Accepted, the deletion is a point where its text was; laid out inline, it has the text's width.
		expect(final.annotations?.revisions[1]?.rectCount).toBe(1)
		expect(width(final.annotations, 1)).toBe(0)
		expect(width(markup.annotations, 1)).toBeGreaterThan(0)
		expect(width(markup.annotations, 0)).toBeCloseTo(width(final.annotations, 0), 3)
	})

	it("indexes threads, formatting and change bars per page", async () => {
		const { annotations } = await open(REVIEWED)

		if (annotations === null) throw new Error("closed")

		const index = indexAnnotations(annotations)
		const page = index.pages.get(0)

		expect(index.threads[0]).toEqual({ comment: 0, replies: [1] })
		expect(index.threads[1]).toBeUndefined()
		expect(page?.threads.map(thread => thread.index)).toEqual([0])
		expect(page?.formatting.map(change => change.index)).toEqual([2])
		// The two changed lines touch: one bar over both.
		expect(page?.bars.length).toBe(2)
		expect(page?.bars[1] ?? 0).toBeGreaterThan(0)
	})

	it("marks a deleted paragraph's place when changes show accepted", async () => {
		const bytes = buildDocx({
			body:
				"<w:p><w:r><w:t>Kept before</w:t></w:r></w:p>" +
				'<w:p><w:pPr><w:rPr><w:del w:id="1" w:author="Bob" w:date="2024-01-01T00:00:00Z"/></w:rPr></w:pPr>' +
				'<w:del w:id="2" w:author="Bob" w:date="2024-01-01T00:00:00Z"><w:r><w:delText>Gone</w:delText></w:r></w:del></w:p>' +
				"<w:p><w:r><w:t>Kept after</w:t></w:r></w:p>"
		})
		const { annotations } = await open(bytes)

		expect(annotations?.revisions.length).toBe(2)
		expect(annotations?.revisions.every(revision => revision.rectCount === 1)).toBe(true)
	})

	it("shows a comment's symbol-font characters as the characters they draw", async () => {
		const bytes = buildDocx({
			body: '<w:p><w:commentRangeStart w:id="1"/><w:r><w:t>Text</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>',
			comments:
				'<w:comment w:id="1" w:author="A"><w:p><w:r><w:t xml:space="preserve">Done </w:t></w:r><w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r></w:p></w:comment>'
		})
		const { annotations } = await open(bytes)

		expect(annotations?.comments[0]?.paragraphs[0]?.map(run => run.text).join("")).toBe("Done \u2713")
	})

	it("places a comment after a MACROBUTTON at the text it covers", async () => {
		const field =
			'<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> MACROBUTTON NoMacro ab </w:instrText></w:r>' +
			'<w:r><w:fldChar w:fldCharType="end"/></w:r>'
		const bytes = buildDocx({
			// Drawn "qababab": the button's "ab", then the commented "ab". Read without the button's text, the paragraph
			// ("qabab") is found at the start of the drawn text and the comment two characters early.
			body:
				`<w:p><w:r><w:t>q</w:t></w:r>${field}<w:commentRangeStart w:id="1"/><w:r><w:t>ab</w:t></w:r>` +
				'<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r><w:r><w:t>ab</w:t></w:r></w:p>',
			comments: '<w:comment w:id="1" w:author="A"><w:p><w:r><w:t>Note</w:t></w:r></w:p></w:comment>'
		})
		const { annotations, pages } = await open(bytes)
		const page = pages[0]
		const comment = annotations?.comments[0]

		if (page === undefined || annotations === null || annotations === undefined || comment === undefined)
			throw new Error("not laid out")

		const { x, char } = lineMetrics(page, 0)
		const at = comment.firstRect * RECT_FLOATS

		expect(comment.rectCount).toBe(1)
		expect(annotations.rectFloats[at]).toBeCloseTo(x + 3 * char, 3)
		expect(annotations.rectFloats[at + 2]).toBeCloseTo(2 * char, 3)
	})

	it("returns nothing to place for a document without annotations", async () => {
		const { annotations, counts } = await open(buildDocx({ body: "<w:p><w:r><w:t>Plain</w:t></w:r></w:p>" }))

		expect(counts).toEqual({ comments: 0, revisions: 0 })
		expect(annotations?.comments).toEqual([])
		expect(annotations?.revisions).toEqual([])
	})

	it("keeps the annotations of a retained document", async () => {
		const { annotations } = await open(REVIEWED, { retain: true })

		expect(annotations?.comments).toHaveLength(2)
	})
})

// Unanchored comments replying to the given parents (-1 for none), as a file's reply metadata may name them.
function threaded(parents: readonly number[]): DocxAnnotations {
	return {
		authors: [],
		comments: parents.map((parent, index) => ({
			id: String(index),
			author: -1,
			initials: "",
			date: "",
			paragraphs: [],
			parent,
			done: false,
			firstRect: 0,
			rectCount: 0
		})),
		revisions: [],
		rectPages: new Int32Array(0),
		rectFloats: new Float32Array(0)
	}
}

describe("comment threads", () => {
	it("roots two comments naming each other at the first", () => {
		const index = indexAnnotations(threaded([1, 0]))

		expect(index.threads).toEqual([{ comment: 0, replies: [1] }, undefined])
		expect(index.unanchored).toEqual([0])
	})

	it("roots a longer loop at its first comment with the others as replies", () => {
		const index = indexAnnotations(threaded([-1, 3, 1, 2]))

		expect(index.threads).toEqual([{ comment: 0, replies: [] }, { comment: 1, replies: [2, 3] }, undefined, undefined])
		expect(index.unanchored).toEqual([0, 1])
	})

	it("roots a chain hanging off a loop at the loop's root", () => {
		const index = indexAnnotations(threaded([4, 0, 3, 2, 3]))

		expect(index.threads).toEqual([undefined, undefined, { comment: 2, replies: [0, 1, 3, 4] }, undefined, undefined])
	})

	it("keeps a comment replying to itself or to no comment a root", () => {
		const index = indexAnnotations(threaded([0, 9, 1]))

		expect(index.threads).toEqual([{ comment: 0, replies: [] }, { comment: 1, replies: [2] }, undefined])
	})
})

describe("balloon placement", () => {
	it("stacks balloons below each other without overlap", () => {
		expect(Array.from(placeBalloons([0, 10, 200], [50, 50, 50], { gap: 8 }).tops)).toEqual([0, 58, 200])
	})

	it("keeps the active balloon at its anchor and moves the ones above up", () => {
		expect(Array.from(placeBalloons([100, 110], [50, 50], { gap: 10, active: 1 }).tops)).toEqual([50, 110])
	})

	it("never places a balloon above the column's top", () => {
		expect(Array.from(placeBalloons([10, 20], [50, 50], { gap: 10, top: 0, active: 1 }).tops)).toEqual([0, 60])
	})

	it("moves balloons up to keep them beside their page", () => {
		const placed = placeBalloons([0, 150], [50, 50], { gap: 10, top: 0, bottom: 180, more: 20 })

		expect(Array.from(placed.tops)).toEqual([0, 130])
		expect(placed.shown).toBe(2)
	})

	it("leaves what does not fit beside the page behind a control below the rest", () => {
		const placed = placeBalloons([0, 10, 20, 30], [50, 50, 50, 50], { gap: 10, top: 0, bottom: 150, more: 20 })

		// Two balloons (120 px) and the control (20 px) fit in 150 px.
		expect(placed.shown).toBe(2)
		expect(Array.from(placed.tops)).toEqual([0, 60])
		expect(placed.moreTop).toBe(120)
	})
})

describe("markup modes", () => {
	it("maps each mode to its revision view", () => {
		expect(markupInfo("all").view).toBe("markup")
		expect(markupInfo("simple").view).toBe("final")
		expect(markupInfo("none").view).toBe("final")
		expect(markupInfo("original").view).toBe("original")
		expect(parseDocxMarkupMode("simple")).toBe("simple")
		expect(parseDocxMarkupMode("everything")).toBeUndefined()
		expect(revisionColor(0)).toContain("--fo-revision-1")
		expect(revisionColor(9)).toContain("--fo-revision-2")
		expect(revisionColor(-1)).toContain("--fo-revision-8")
	})
})

// Reviewed documents of the corpus: every comment the document anchors in laid-out text gets a box.
const CORPUS = [
	"docx/oxsdk__Comment033.docx",
	"docx/oxsdk__Comment025.docx",
	"docx/oxsdk__Comment045.docx",
	"docx/lo__wDateValueFormat.docx",
	"docx/oxpt__RA001-Tracked-Revisions-01.docx",
	"docx/lo__tdf123054.docx",
	"docx/lo__redline-range-comment.docx",
	"docx/oxpt__HC031-Complicated-Document.docx"
].map(file => join(CORPUS_DIR, file))

describe.skipIf(!CORPUS.every(file => existsSync(file)))("docx annotations over the corpus", () => {
	it("threads replies recorded under the pre-release Word 2013 namespace", async () => {
		const { annotations } = await open(new Uint8Array(readFileSync(join(CORPUS_DIR, "docx/oxsdk__Comment025.docx"))))
		const replies = annotations?.comments.filter(comment => comment.parent >= 0) ?? []

		expect(replies.length).toBeGreaterThan(0)
		expect(replies.every(reply => annotations?.comments[reply.parent]?.parent === -1)).toBe(true)
	})

	it.each(CORPUS)("places the annotations of %s", async file => {
		const bytes = new Uint8Array(readFileSync(file))

		for (const view of ["final", "markup"] as const) {
			const { annotations, pages, counts } = await open(bytes, { view })

			if (annotations === null) throw new Error("closed")

			expect(annotations.comments.length).toBe(counts.comments)

			const anchored = annotations.comments.filter(comment => comment.rectCount > 0)
			const roots = annotations.comments.filter(comment => comment.parent < 0)

			// Replies may share their parent's anchor only; every root with a range in the body is placed.
			expect(anchored.length).toBeGreaterThanOrEqual(Math.min(1, roots.length))

			for (let rect = 0; rect < annotations.rectPages.length; rect++) {
				const page = pages[annotations.rectPages[rect] ?? -1]
				const at = rect * RECT_FLOATS

				expect(page).toBeDefined()
				expect(annotations.rectFloats[at + 1] ?? -1).toBeGreaterThanOrEqual(0)
				expect((annotations.rectFloats[at + 1] ?? 0) + (annotations.rectFloats[at + 3] ?? 0)).toBeLessThanOrEqual(
					(page?.height ?? 0) + 1
				)
				expect(annotations.rectFloats[at + 2] ?? -1).toBeGreaterThanOrEqual(0)
			}
		}
	})
})
