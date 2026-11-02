import { describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import type { EmitFunction } from "../core/presentation/edit/proof"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideNode, SlideRef, Xfrm } from "../core/presentation/model"
import { review } from "../dom/presentation/engine/review"
import { driveSession } from "./odpWriteDrive"
import { editDeck, shapeById } from "./presentationEditFixtures"

// Proof gate 1 locks a shape the emitters cannot write back as its source has it, before the slide's first edit. A
// save of the slide changes nothing there: after a save that wrote the slide around that shape (a comment, notes, the
// slide hidden, another shape moved), the shape is still locked and its edit refused.

// The real emitters, except shape 3 comes out empty: gate 1 locks exactly that shape.
const BROKEN: EmitFunction = (family, request, context) =>
	request.shape?.id === 3
		? { kind: "markup", pieces: ['<p:sp xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>'] }
		: emitPptx(family, request, context as never)

const BEFORE: Readonly<Record<string, (slide: SlideRef, shapes: readonly ShapeNode[]) => DeckOp | undefined>> = {
	nothing: () => undefined,
	"the slide hidden": slide => ({ family: "slide", kind: "hide", slides: [slide], hidden: true }),
	"notes made": slide => ({
		family: "notes",
		kind: "setNotes",
		slide,
		body: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "Notes", rPr: {} }] }] }
	}),
	"a comment added": slide =>
		({
			family: "comment",
			kind: "add",
			slide,
			comment: {
				id: "{12345678-7777-4777-8777-777777777777}",
				author: "{22222222-2222-4222-8222-222222222222}",
				text: "Comment",
				created: "2026-10-28T08:00:00.000Z",
				anchor: { x: 0, y: 0 }
			},
			authorName: "Author"
		}) as DeckOp,
	"another shape moved": (slide, shapes) => {
		const other = shapes.find(shape => shape.id !== 3 && shape.xfrm !== undefined) as ShapeNode
		const box = other.xfrm as Xfrm

		return { family: "shape", kind: "setXfrm", target: { slide, id: other.id }, xfrm: { ...box, x: box.x + 12_700 } }
	}
}

describe("a shape proof gate 1 locks, after a save of its slide", () => {
	for (const [label, before] of Object.entries(BEFORE))
		it(`pptx: ${label}, saved: the shape is still locked and its edit refused`, async () => {
			const d = await driveSession(editDeck(), "pptx", [], { emit: BROKEN })
			const slide = d.session.deck.slides[0] as SlideRef

			await review(d.context, slide)

			const op = before(slide, (d.session.deck.nodes.get(slide) as SlideNode).shapes)

			if (op !== undefined) {
				expect((await d.command(op)).ok).toBe(true)
				expect((await d.save()).result.kind).toBe("written")
			}

			expect(
				await d.command({ family: "shape", kind: "setProps", target: { slide, id: 3 }, props: { fill: "none" } } as DeckOp)
			).toEqual({
				ok: false,
				refusal: "locked"
			})
			expect(shapeById((d.session.deck.nodes.get(slide) as SlideNode).shapes, 3)?.lock).toBe("proofFailed")
		})
})
