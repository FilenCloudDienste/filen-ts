import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { ShapeNode, SlideNode, SlideRef, TextBody } from "../core/presentation/model"
import { notesTarget } from "../core/presentation/notes"
import { review } from "../dom/presentation/engine/review"
import { CORPUS_DIR } from "./corpusDir"
import { driveSession } from "./odpWriteDrive"
import { buildPptx } from "./pptxFixtures"
import { partsOf } from "./pptxWriteFixtures"

// A body set, saved and undone on a deck PowerPoint wrote (self-closed `<a:lstStyle />`, dirty="0" run properties):
// the next save gives every part back byte for byte, slide text and speaker notes alike.

const DECK = join(CORPUS_DIR, "pptx", "govuk__Shaping_the_Qualifications_Landscape.pptx")

function line(text: string): TextBody {
	return { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] }
}

async function changedParts(before: Uint8Array, after: Uint8Array | undefined): Promise<string[]> {
	if (after === undefined) return ["(not written)"]

	const a = await partsOf(before)
	const b = await partsOf(after)
	const out: string[] = []

	for (const name of new Set([...a.keys(), ...b.keys()])) {
		const x = a.get(name)
		const y = b.get(name)

		if (x === undefined || y === undefined || x.length !== y.length || x.some((byte, index) => byte !== y[index])) out.push(name)
	}

	return out
}

// A slide shape serialised as PowerPoint writes it: spaces before "/>", run properties PowerPoint marks dirty="0".
const POWERPOINT_SHAPE =
	'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1" /><p:cNvSpPr><a:spLocks noGrp="1" /></p:cNvSpPr><p:nvPr><p:ph type="title" /></p:nvPr></p:nvSpPr>' +
	'<p:spPr /><p:txBody><a:bodyPr /><a:lstStyle /><a:p><a:r><a:rPr lang="en-US" dirty="0" /><a:t>Hello</a:t></a:r>' +
	'<a:endParaRPr lang="en-US" dirty="0" /></a:p></p:txBody></p:sp>'

describe("undo after a save on PowerPoint-serialised markup", () => {
	it("puts the shape's body back byte for byte", async () => {
		const original = buildPptx({ slides: [{ shapes: POWERPOINT_SHAPE }] })
		const s = await driveSession(original, "pptx")
		const slide = s.session.deck.slides[0] as SlideRef

		await review(s.context, slide, { comments: false })
		expect((await s.command({ family: "text", kind: "setText", target: { slide, id: 2 }, body: line("X") })).ok).toBe(true)
		await s.save()
		await s.undo()

		expect(await changedParts(original, (await s.save()).bytes)).toEqual([])
	})
})

describe.skipIf(!existsSync(DECK))("undo after a save on a PowerPoint-written deck (corpus)", () => {
	it("puts a slide shape's text back byte for byte", { timeout: 120_000 }, async () => {
		const original = new Uint8Array(readFileSync(DECK))
		const s = await driveSession(original, "pptx")
		let target: { slide: SlideRef; shape: ShapeNode } | undefined

		for (const slide of s.session.deck.slides) {
			await review(s.context, slide, { comments: false })

			const shape = (s.session.deck.nodes.get(slide) as SlideNode).shapes.find(each => each.kind === "sp" && each.text !== undefined)

			if (shape !== undefined) {
				target = { slide, shape }
				break
			}
		}

		if (target === undefined) throw new Error("no text shape")

		expect(
			(await s.command({ family: "text", kind: "setText", target: { slide: target.slide, id: target.shape.id }, body: line("X") })).ok
		).toBe(true)
		await s.save()
		await s.undo()

		expect(await changedParts(original, (await s.save()).bytes)).toEqual([])
	})

	it("puts a slide's speaker notes back byte for byte", { timeout: 120_000 }, async () => {
		const original = new Uint8Array(readFileSync(DECK))
		const s = await driveSession(original, "pptx")
		let slide: SlideRef | undefined

		for (const each of s.session.deck.slides) {
			await review(s.context, each, { comments: false })

			if (notesTarget(s.session.deck, each) !== undefined) {
				slide = each
				break
			}
		}

		if (slide === undefined) throw new Error("no notes")

		expect((await s.command({ family: "notes", kind: "setNotes", slide, body: line("N") })).ok).toBe(true)
		await s.save()
		await s.undo()

		expect(await changedParts(original, (await s.save()).bytes)).toEqual([])
	})
})
