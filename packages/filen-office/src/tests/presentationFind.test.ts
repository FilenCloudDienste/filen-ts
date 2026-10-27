import { describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import {
	bodyMatches,
	matcherOf,
	matchesIn,
	paragraphMatches,
	replaceInBody,
	replaceRange,
	tableParagraph,
	type FindQuery
} from "../core/presentation/edit/find"
import type { Paragraph, ShapeNode, SourceRef, TextBody } from "../core/presentation/model"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { findInDeck } from "../dom/presentation/engine/find"
import { FIND_IN_NOTES, FIND_IN_TABLE, FIND_LOCKED, PRESENTATION_FIND_INTS } from "../dom/presentation/protocol"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { editHarness, shapeById, type EditHarness } from "./presentationEditFixtures"
import { changedParts, partsOf, saveEdits, text } from "./pptxWriteFixtures"

// Find and replace over text bodies: matching (case, whole words, never across a break, a field or kept content),
// replacement keeping the formatting of the first replaced character, the deck-wide search (slides, groups, tables,
// notes; scope and limit), and the text.replace op as one history step.

function matches(text: string, query: FindQuery): [number, number][] {
	const matcher = matcherOf(query)
	const out: [number, number][] = []

	if (matcher !== undefined) matchesIn(text, matcher, (start, end) => out.push([start, end]) > 0)

	return out
}

const SRC: SourceRef = { format: "pptx", part: "/ppt/slides/slide1.xml", node: 7, epoch: 0 }

function paragraph(...runs: Paragraph["runs"]): Paragraph {
	return { pPr: {}, runs: [...runs], src: SRC }
}

function rows(result: Int32Array): number[][] {
	const out: number[][] = []

	for (let i = 0; i < result.length; i += PRESENTATION_FIND_INTS) out.push([...result.subarray(i, i + PRESENTATION_FIND_INTS)])

	return out
}

describe("presentation find matching", () => {
	it("folds case unless asked not to, and an empty query finds nothing", () => {
		expect(matches("Alpha ALPHA alpha", { query: "alpha" })).toEqual([
			[0, 5],
			[6, 11],
			[12, 17]
		])
		expect(matches("Alpha ALPHA alpha", { query: "alpha", caseSensitive: true })).toEqual([[12, 17]])
		expect(matcherOf({ query: "" })).toBeUndefined()
		// A unit that lower-cases to two keeps its offset; final sigma matches sigma.
		expect(matches("İx", { query: "x" })).toEqual([[1, 2]])
		expect(matches("ΟΔΟΣ", { query: "οδοσ" })).toEqual([[0, 4]])
	})

	it("matches whole words only when asked, with letters beyond the basic plane counted as letters", () => {
		expect(matches("cat concat cat_ cat.", { query: "cat", wholeWord: true })).toEqual([
			[0, 3],
			[16, 19]
		])
		// 𝐀 (U+1D400) is a letter: "a𝐀" is not the whole word "a".
		expect(matches("a\u{1D400} a", { query: "a", wholeWord: true })).toEqual([[4, 5]])
		expect(matches("\u{1D400}a", { query: "a", wholeWord: true })).toEqual([])
	})

	it("never matches across a line break, a field or content kept as source, but across plain runs", () => {
		const across = paragraph(
			{ kind: "r", text: "hel", rPr: { b: true } },
			{ kind: "r", text: "lo", rPr: {} },
			{ kind: "br", rPr: {} },
			{ kind: "r", text: "lo", rPr: {} },
			{ kind: "fld", type: "slidenum", id: "{1}", text: "lo", rPr: {} },
			{ kind: "opaque", src: SRC, text: "hello" }
		)
		const found: [number, number][] = []
		const matcher = matcherOf({ query: "lo" })

		if (matcher !== undefined) paragraphMatches(across, matcher, (start, end) => found.push([start, end]) > 0)

		// "hello\nlolohello": the runs' "lo" (3–5) and the third run's (6–8); not the field's nor the kept content's.
		expect(found).toEqual([
			[3, 5],
			[6, 8]
		])

		const hello = matcherOf({ query: "hello" })
		const all: number[] = []

		if (hello !== undefined) bodyMatches({ bodyPr: {}, paragraphs: [across] }, hello, (p, start, end) => all.push(p, start, end) > 0)

		expect(all).toEqual([0, 0, 5])
	})

	it("replaces with the first replaced character's formatting and keeps the paragraph's source", () => {
		const source = paragraph(
			{ kind: "r", text: "Big ", rPr: {} },
			{ kind: "r", text: "Bo", rPr: { b: true } },
			{ kind: "r", text: "ld end", rPr: { i: true } }
		)
		const replaced = replaceRange(source, 4, 8, "X")

		expect(replaced.src).toBe(SRC)
		expect(replaced.runs).toEqual([
			{ kind: "r", text: "Big ", rPr: {} },
			{ kind: "r", text: "X", rPr: { b: true } },
			{ kind: "r", text: " end", rPr: { i: true } }
		])

		const bodyOf: TextBody = { bodyPr: {}, paragraphs: [paragraph({ kind: "r", text: "a b a", rPr: {} })] }
		const matcher = matcherOf({ query: "a" })

		if (matcher === undefined) throw new Error("matcher")

		expect(replaceInBody(bodyOf, matcher, "zz")?.body.paragraphs[0]?.runs).toEqual([{ kind: "r", text: "zz b zz", rPr: {} }])
		expect(replaceInBody(bodyOf, matcher, "zz", [0, 4, 5])?.body.paragraphs[0]?.runs).toEqual([{ kind: "r", text: "a b zz", rPr: {} }])
		// A match that is no longer where the page saw it.
		expect(replaceInBody(bodyOf, matcher, "zz", [0, 1, 2])).toBeUndefined()
	})

	it("turns a table's flat paragraph index into its cell", () => {
		const cell = (count: number) => ({ text: { bodyPr: {}, paragraphs: Array.from({ length: count }, () => paragraph()) } })
		const table = { rows: [{ cells: [cell(2), cell(1)] }, { cells: [cell(1), cell(3)] }] }

		expect(tableParagraph(table, 0)).toEqual({ row: 0, col: 0, paragraph: 0 })
		expect(tableParagraph(table, 2)).toEqual({ row: 0, col: 1, paragraph: 0 })
		expect(tableParagraph(table, 5)).toEqual({ row: 1, col: 1, paragraph: 1 })
		expect(tableParagraph(table, 7)).toBeUndefined()
	})
})

const TABLE =
	'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Table 8"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
	'<p:xfrm><a:off x="100" y="3000"/><a:ext cx="2000" cy="400"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
	'<a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1000"/><a:gridCol w="1000"/></a:tblGrid><a:tr h="200">' +
	"<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>apple cell</a:t></a:r></a:p><a:p><a:r><a:t>second apple</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>" +
	"<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>pear apple</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc></a:tr></a:tbl>" +
	"</a:graphicData></a:graphic></p:graphicFrame>"

function findDeck(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Title 1", 'type="title"', "", body(para("An apple a day"))) +
					'<p:grpSp><p:nvGrpSpPr><p:cNvPr id="6" name="Group 5"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
					sp(
						7,
						"Inner",
						undefined,
						`${xfrm(0, 0, 500, 500)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`,
						body(para("Apple pie"))
					) +
					"</p:grpSp>" +
					TABLE,
				notes: para("Mention the apple")
			},
			{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("No fruit here"))) },
			{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Apples and APPLES"))), notes: para("apple notes") }
		]
	})
}

const EDIT = { emit: emitPptx } as never

async function harness(): Promise<EditHarness> {
	return editHarness(findDeck(), EDIT)
}

describe("presentation find in a deck", () => {
	it("finds slide by slide: shapes and groups in tree order, table cells row-major, then the notes", async () => {
		const h = await harness()
		const found = rows(await findInDeck(h.context, "apple"))
		const notesShape = 3

		expect(found).toEqual([
			[0, 2, 0, 3, 8, 0],
			[0, 7, 0, 0, 5, 0],
			[0, 9, 0, 0, 5, FIND_IN_TABLE],
			[0, 9, 1, 7, 12, FIND_IN_TABLE],
			[0, 9, 2, 5, 10, FIND_IN_TABLE],
			[0, notesShape, 0, 12, 17, FIND_IN_NOTES],
			[2, 2, 0, 0, 5, 0],
			[2, 2, 0, 11, 16, 0],
			[2, 3, 0, 0, 5, FIND_IN_NOTES]
		])
		h.close()
	})

	it("searches only the scopes asked for, and stops one past the limit", async () => {
		const h = await harness()

		expect(rows(await findInDeck(h.context, "apple", { scope: ["notes"] })).map(row => row[5])).toEqual([FIND_IN_NOTES, FIND_IN_NOTES])
		expect(rows(await findInDeck(h.context, "apple", { scope: ["tables"] })).every(row => row[5] === FIND_IN_TABLE)).toBe(true)
		expect(rows(await findInDeck(h.context, "apple", { limit: 2 }))).toHaveLength(3)
		expect(rows(await findInDeck(h.context, "apple", { wholeWord: true, scope: ["slides"] }))).toHaveLength(2)
		expect(await findInDeck(h.context, "")).toHaveLength(0)
		h.close()
	})

	it("flags a match inside a locked shape as found but not replaceable", async () => {
		const h = await harness()
		const node = await h.slide(0)
		const title = shapeById(node.shapes, 2)

		if (title === undefined) throw new Error("no title")

		title.lock = "proofFailed"

		const found = rows(await findInDeck(h.context, "apple"))

		expect(found[0]).toEqual([0, 2, 0, 3, 8, FIND_LOCKED])
		expect(found.slice(1).every(row => ((row[5] ?? 0) & FIND_LOCKED) === 0)).toBe(true)
		h.close()
	})
})

function titleText(shapes: readonly ShapeNode[]): string {
	return (shapeById(shapes, 2)?.text?.paragraphs ?? []).flatMap(p => p.runs.map(run => (run.kind === "br" ? "\n" : run.text))).join("")
}

describe("presentation text.replace", () => {
	it("replaces across slides and notes as one step: undo restores every body, redo replaces again", async () => {
		const bytes = findDeck()
		const h = await editHarness(bytes, EDIT)
		const first = await h.slide(0)
		const third = await h.slide(2)
		const before = [titleText(first.shapes), titleText(third.shapes)]
		const notes = third.notes

		const result = await h.command({
			family: "text",
			kind: "replace",
			query: "apple",
			replacement: "pear",
			targets: [
				{ target: { slide: first.ref, id: 2 } },
				{ target: { slide: third.ref, id: 2 } },
				{ target: { slide: third.ref, id: 3 }, notes: true }
			]
		})

		expect(result).toMatchObject({ ok: true, dirty: true })
		expect(titleText(first.shapes)).toBe("An pear a day")
		expect(titleText(third.shapes)).toBe("pears and pearS")

		const notesNode = notes === undefined ? undefined : h.session.deck.nodes.get(notes)

		expect(notesNode === undefined ? "" : (shapeById(notesNode.shapes, 3)?.text?.paragraphs[0]?.runs[0] as { text: string }).text).toBe(
			"pear notes"
		)

		const saved = await saveEdits(h, result.ok ? result.revision : -1)
		const changed = (await changedParts(bytes, saved)).sort()

		expect(changed).toEqual(["ppt/notesSlides/notesSlide3.xml", "ppt/slides/slide1.xml", "ppt/slides/slide3.xml"])

		const parts = await partsOf(saved)

		expect(text(parts.get("ppt/slides/slide3.xml"))).toContain("pears and pearS")
		expect(text(parts.get("ppt/notesSlides/notesSlide3.xml"))).toContain("pear notes")

		// One step back: every body as it was, nothing differs from the source.
		expect(await h.undo()).toMatchObject({ ok: true, dirty: true })
		expect([titleText(first.shapes), titleText(third.shapes)]).toEqual(before)
		expect(await h.redo()).toMatchObject({ ok: true, dirty: false })
		expect(titleText(third.shapes)).toBe("pears and pearS")
		h.close()
	})

	it("an undone replace leaves no changes", async () => {
		const h = await harness()
		const first = await h.slide(0)

		await h.command({
			family: "text",
			kind: "replace",
			query: "apple",
			replacement: "x",
			targets: [{ target: { slide: first.ref, id: 2 } }]
		})
		expect(await h.undo()).toMatchObject({ ok: true, dirty: false })
		expect(sessionEdits(h.session).changes().empty).toBe(true)
		h.close()
	})

	it("a replace whose match moved is refused as stale and changes nothing", async () => {
		const h = await harness()
		const first = await h.slide(0)

		expect(
			await h.command({
				family: "text",
				kind: "replace",
				query: "apple",
				replacement: "x",
				targets: [
					{ target: { slide: first.ref, id: 2 }, match: [0, 3, 8] },
					{ target: { slide: first.ref, id: 7 }, match: [0, 1, 6] }
				]
			})
		).toEqual({ ok: false, refusal: "stale" })
		expect(titleText(first.shapes)).toBe("An apple a day")
		expect(sessionEdits(h.session).changes().empty).toBe(true)
		h.close()
	})
})
