import { describe, expect, it } from "vitest"
import type { SlideNode, SlideRef, TextBody } from "../core/presentation/model"
import { notesParagraphs } from "../core/presentation/notes"
import { review } from "../dom/presentation/engine/review"
import { driveSession } from "./odpWriteDrive"
import { buildPptx } from "./pptxFixtures"
import { editDeckOptions } from "./presentationEditFixtures"

// Speaker notes as the presenter view shows them: per paragraph its level, alignment, indents and marker, per run the
// character formatting the notes pane keeps (bold, italic, underline, strike, superscript and subscript); font, size
// and colour are not carried (PowerPoint's notes pane and Presenter view do not show them).

const FORMATTED: TextBody = {
	bodyPr: {},
	paragraphs: [
		{
			pPr: {},
			runs: [
				{ kind: "r", text: "Plain ", rPr: { sz: 2400, latin: { typeface: "Arial" } } },
				{ kind: "r", text: "bold", rPr: { b: true } },
				{ kind: "r", text: " and ", rPr: {} },
				{ kind: "r", text: "italic", rPr: { i: true, u: "sng" } },
				{ kind: "br", rPr: {} },
				{ kind: "r", text: "x", rPr: {} },
				{ kind: "r", text: "2", rPr: { baseline: 30000 } },
				{ kind: "r", text: "gone", rPr: { strike: "sngStrike", baseline: -25000 } }
			]
		},
		{
			pPr: { algn: "ctr", marL: 457_200, indent: -228_600, bullet: { kind: "char", char: "•" } },
			runs: [{ kind: "r", text: "Point", rPr: {} }]
		},
		{ pPr: { lvl: 1, bullet: { kind: "autoNum", scheme: "arabicPeriod" } }, runs: [{ kind: "r", text: "One", rPr: {} }] },
		{ pPr: { lvl: 1, bullet: { kind: "autoNum", scheme: "arabicPeriod" } }, runs: [{ kind: "r", text: "Two", rPr: {} }] },
		{ pPr: { bullet: { kind: "char", char: "§" }, buFont: { typeface: "Wingdings" } }, runs: [{ kind: "r", text: "Square", rPr: {} }] },
		{ pPr: { bullet: { kind: "char", char: "•" } }, runs: [] }
	]
}

async function deckWithNotes(body: TextBody | undefined) {
	const s = await driveSession(buildPptx(editDeckOptions()), "pptx")
	const slide = s.session.deck.slides[1] as SlideRef

	await review(s.context, slide, { comments: false })

	if (body !== undefined) expect((await s.command({ family: "notes", kind: "setNotes", slide, body })).ok).toBe(true)

	return { deck: s.session.deck, node: s.session.deck.nodes.get(slide) as SlideNode }
}

describe("notes paragraphs", () => {
	it("keeps the notes' character formatting, alignment, levels and bullets, without font or size", async () => {
		const { deck, node } = await deckWithNotes(FORMATTED)
		const paragraphs = notesParagraphs(deck, node)

		expect(paragraphs?.[0]?.runs).toEqual([
			{ text: "Plain " },
			{ text: "bold", b: true },
			{ text: " and " },
			{ text: "italic", i: true, u: true },
			{ text: "\nx" },
			{ text: "2", script: "sup" },
			{ text: "gone", strike: true, script: "sub" }
		])
		expect(paragraphs?.[0]?.marker).toBeUndefined()

		const point = paragraphs?.[1]

		expect(point?.align).toBe("ctr")
		expect(point?.marker).toBe("•")
		expect(point?.start).toBeGreaterThan(0)
		expect(point?.first).toBeLessThan(0)
		expect(paragraphs?.[2]).toMatchObject({ level: 1, marker: "1." })
		expect(paragraphs?.[3]).toMatchObject({ level: 1, marker: "2." })
		// A symbol font's bullet is the character it shows.
		expect(paragraphs?.[4]?.marker).toBe("▪")
		// An empty paragraph draws no marker.
		expect(paragraphs?.[5]?.marker).toBeUndefined()
		expect(paragraphs?.[5]?.runs).toEqual([])
	})

	it("is absent for a slide without notes text", async () => {
		const { deck, node } = await deckWithNotes(undefined)

		expect(notesParagraphs(deck, node)).toBeUndefined()
	})
})
