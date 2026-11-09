import { describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import { duplicateOp } from "../core/presentation/edit/commands/shape"
import type { ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { sessionEdits } from "../dom/presentation/engine/edit"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { entriesOf, text } from "./odpWriteFixtures"
import { editDeck, editHarness, shapeById } from "./presentationEditFixtures"
import { changedParts, saveEdits } from "./pptxWriteFixtures"

// Duplicate (Ctrl+D on selected objects): copies of the shapes, offset and on top, saved as elements of their own.

const EDIT = { emit: emitPptx } as never
const OFFSET = 10 * 9525

function ids(shapes: readonly ShapeNode[]): number[] {
	return shapes.map(shape => shape.id)
}

function allIds(shapes: readonly ShapeNode[], into: number[] = []): number[] {
	for (const shape of shapes) {
		into.push(shape.sourceId ?? shape.id)
		allIds(shape.children ?? [], into)
	}

	return into
}

describe("shape duplicate", () => {
	it("copies a shape and a group on top, offset, and saves them with ids of their own", async () => {
		const h = await editHarness(editDeck(), EDIT)
		const slide = await h.slide(0)
		const before = ids(slide.shapes)
		const op = duplicateOp(slide.ref, [5, 6])

		if (op === undefined) throw new Error("no op")

		expect(await h.command(op)).toMatchObject({ ok: true })

		const copies = slide.shapes.slice(before.length)

		expect(ids(slide.shapes.slice(0, before.length))).toEqual(before)
		expect(copies.map(shape => shape.name)).toEqual(["Box C", "Group 5"])
		expect(copies.map(shape => shape.xfrm?.x)).toEqual([4000 + OFFSET, 5000 + OFFSET])

		const bytes = await saveEdits(h, sessionEdits(h.session).history.revision)

		expect((await changedParts(editDeck(), bytes)).filter(name => !name.startsWith("ppt/slides/slide1.xml"))).toEqual([])

		const reopened = await editHarness(bytes, EDIT)
		const back: SlideNode = await reopened.slide(0)
		const written = allIds(back.shapes)

		// Every cNvPr id on the slide is unique as written (none reassigned on read).
		expect(new Set(written).size).toBe(written.length)
		expect(back.shapes.map(shape => shape.name)).toEqual([...slide.shapes.map(shape => shape.name)])

		const [box, group] = back.shapes.slice(before.length)

		expect(box?.xfrm).toMatchObject({ x: 4000 + OFFSET, y: 600 + OFFSET, cx: 600, cy: 600 })
		expect(box?.actions?.click).toEqual(shapeById(back.shapes, 5)?.actions?.click)
		expect(group?.children?.map(child => child.name)).toEqual(["Inner 1", "Inner 2"])
		expect(group?.xfrm).toMatchObject({ x: 5000 + OFFSET, y: 5000 + OFFSET, chX: 0, chY: 0 })
		reopened.close()
		h.close()
	})

	it("undoes as one step and redoes with the same ids", async () => {
		const h = await editHarness(editDeck(), EDIT)
		const slide = await h.slide(0)
		const before = ids(slide.shapes)

		expect(await h.command({ family: "shape", kind: "duplicate", slide: slide.ref, shapes: [3, 4], dx: 0, dy: 0 })).toMatchObject({
			ok: true
		})

		const after = ids(slide.shapes)

		expect(after.length).toBe(before.length + 2)
		expect(await h.undo()).toMatchObject({ ok: true })
		expect(ids(slide.shapes)).toEqual(before)
		expect(await h.redo()).toMatchObject({ ok: true })
		expect(ids(slide.shapes)).toEqual(after)
		h.close()
	})

	it("refuses a placeholder and leaves the slide as it was", async () => {
		const h = await editHarness(editDeck(), EDIT)
		const slide = await h.slide(0)
		const before = ids(slide.shapes)

		expect(await h.command({ family: "shape", kind: "duplicate", slide: slide.ref, shapes: [3, 2], dx: 0, dy: 0 })).toMatchObject({
			ok: false,
			refusal: "unsupported"
		})
		expect(ids(slide.shapes)).toEqual(before)
		expect(duplicateOp(slide.ref, [])).toBeUndefined()
		h.close()
	})

	it("copies an ODP shape as an element of its own", async () => {
		const source = odpBytes({
			automatic:
				'<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#3366cc"/></style:style>',
			body: '<draw:page draw:name="One" draw:master-page-name="M"><draw:custom-shape draw:name="hexagon" draw:style-name="gr1" svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="3cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="hexagon" draw:modifiers="3000"/></draw:custom-shape></draw:page>'
		})
		const d = await driveSession(source)
		const slide = d.session.deck.slides[0] as SlideRef
		const shapes = async (): Promise<readonly ShapeNode[]> => (await odpParts(d.session.deck)?.slide(slide))?.shapes ?? []
		const [hexagon] = await shapes()

		if (hexagon === undefined) throw new Error("no shape")

		const op = duplicateOp(slide, [hexagon.id])

		if (op === undefined) throw new Error("no op")

		expect((await d.command(op)).ok).toBe(true)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		const markup = text((await entriesOf(saved.bytes as Uint8Array)).get("content.xml"))
		const copies = markup.match(/<draw:custom-shape draw:name="hexagon"[^>]*>/gu) ?? []

		expect(copies.length).toBe(2)
		expect(copies.every(copy => copy.includes('draw:style-name="gr1"'))).toBe(true)
		expect(markup.match(/draw:type="hexagon" draw:modifiers="3000"/gu)?.length).toBe(2)
	})
})
