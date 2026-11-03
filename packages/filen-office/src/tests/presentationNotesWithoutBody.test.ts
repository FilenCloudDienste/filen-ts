import { describe, expect, it } from "vitest"
import type { SlideRef, TextBody } from "../core/presentation/model"
import { notesText } from "../core/presentation/notes"
import { review } from "../dom/presentation/engine/review"
import { modelVsFile } from "./modelVsFile"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, NS, para, sp, tree, xfrm } from "./pptxFixtures"

// Notes typed on a slide whose notes page has no body placeholder (a page with only the slide image): the page gets
// the body the notes master places, as PowerPoint and LibreOffice add it; an undo takes it out again.

const lines = (text: string): TextBody => ({ bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] })

function deckOf(format: "pptx" | "odp"): Uint8Array {
	if (format === "odp")
		return odpBytes({
			body: [0, 1]
				.map(
					k =>
						`<draw:page draw:name="P${String(k)}" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>T${String(k)}</text:p></draw:text-box></draw:frame><presentation:notes><draw:page-thumbnail draw:page-number="${String(k + 1)}" svg:x="2cm" svg:y="2cm" svg:width="14cm" svg:height="10cm" presentation:class="page"/></presentation:notes></draw:page>`
				)
				.join("")
		})

	const shapes = sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("S")))

	return buildPptx({
		slides: [
			{ shapes, notes: "" },
			{ shapes, notes: "" }
		],
		parts: {
			"ppt/notesSlides/notesSlide1.xml": {
				data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:notes ${NS}>${tree(sp(2, "Slide Image Placeholder 1", 'type="sldImg"'))}</p:notes>`
			}
		}
	})
}

describe("notes on a notes page without a body placeholder", () => {
	for (const format of ["pptx", "odp"] as const)
		it(`${format}: typed notes get a body, the file holds them, and an undo takes the body out again`, async () => {
			const d = await driveSession(deckOf(format), format)
			const slide = d.session.deck.slides[0] as SlideRef

			await review(d.context, slide)
			expect((await review(d.context, slide, { comments: false })).notes).toBeUndefined()

			const typed = await d.command({ family: "notes", kind: "setNotes", slide, body: lines("Added") })

			expect(typed.ok).toBe(true)
			expect((await review(d.context, slide, { comments: false })).notes).toBeDefined()
			expect(notesText(d.session.deck, d.session.deck.nodes.get(slide) as never)).toBe("Added")

			const saved = await d.save()

			expect(saved.result.kind).toBe("written")
			expect(await modelVsFile(d, saved.bytes as Uint8Array, format)).toBe("")

			const back = await driveSession(saved.bytes as Uint8Array, format)

			await review(back.context, back.session.deck.slides[0] as SlideRef)
			expect(notesText(back.session.deck, back.session.deck.nodes.get(back.session.deck.slides[0] as SlideRef) as never)).toBe(
				"Added"
			)

			expect((await d.undo()).ok).toBe(true)
			expect(notesText(d.session.deck, d.session.deck.nodes.get(slide) as never)).toBe("")

			const undone = await d.save()

			expect(undone.result.kind).toBe("written")
			expect(await modelVsFile(d, undone.bytes as Uint8Array, format)).toBe("")
			expect((await d.redo()).ok).toBe(true)
			expect(notesText(d.session.deck, d.session.deck.nodes.get(slide) as never)).toBe("Added")
		})
})
