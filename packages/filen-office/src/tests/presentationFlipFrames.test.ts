import { describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import { canFlip, flipOp } from "../core/presentation/edit/commands/shape"
import type { SlideRef, Xfrm } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { editHarness, shapeById } from "./presentationEditFixtures"
import { tableDeck } from "./presentationObjectsFixtures"

// A graphic frame (a table, chart, embedded object, medium or diagram) has no flip PowerPoint draws (ECMA-376 §19.3.1.21
// graphicFrame's xfrm: its flips are not applied) and ODF's draw:frame holds none: flipping one is refused as the
// command in both formats (refused "unsupported"), and the Rotate menu offers no flip for it, saying why.

const BOX: Xfrm = { x: 0, y: 0, cx: 100, cy: 100, rot: 0, flipH: false, flipV: false }

describe("flipping a graphic frame", () => {
	it("is not offered for tables, charts, objects, media and diagrams, and is for shapes, pictures and groups", () => {
		for (const role of ["table", "chart", "ole", "media", "smartart"] as const)
			expect(canFlip({ id: 1, xfrm: BOX, role }), role).toBe(false)
		for (const role of ["shape", "picture", "group", "placeholder", "ink"] as const)
			expect(canFlip({ id: 1, xfrm: BOX, role }), role).toBe(true)
		expect(canFlip({ id: 1, xfrm: BOX, role: "picture", media: true })).toBe(false)
		expect(flipOp(0 as SlideRef, [{ id: 1, xfrm: BOX, role: "table" }], "horizontal")).toBeUndefined()
		expect(flipOp(0 as SlideRef, [{ id: 1, xfrm: BOX, role: "shape" }], "horizontal")).toBeDefined()
	})

	it("is refused as the command in a pptx deck, the table kept as it was", async () => {
		const h = await editHarness(tableDeck(), { emit: emitPptx } as never)
		const slide = h.session.deck.slides[0] as SlideRef
		const table = shapeById((await h.slide(0)).shapes, 3)
		const result = await h.command({
			family: "shape",
			kind: "setXfrm",
			target: { slide, id: 3 },
			xfrm: { ...(table?.xfrm as Xfrm), flipH: true }
		})

		expect(result).toMatchObject({ ok: false, refusal: "unsupported" })
		expect(shapeById((await h.slide(0)).shapes, 3)?.xfrm?.flipH).toBe(false)
	})

	it("is refused as the command in an ODP deck", async () => {
		const source = odpBytes({
			body: '<draw:page draw:name="One" draw:master-page-name="M"><draw:frame draw:name="Table" svg:x="1cm" svg:y="1cm" svg:width="6cm" svg:height="2cm"><table:table><table:table-column/><table:table-row><table:table-cell><text:p>A</text:p></table:table-cell></table:table-row></table:table></draw:frame></draw:page>'
		})
		const d = await driveSession(source)
		const slide = d.session.deck.slides[0] as SlideRef
		const table = (await odpParts(d.session.deck)?.slide(slide))?.shapes.find(shape => shape.name === "Table")
		const result = await d.command({
			family: "shape",
			kind: "setXfrms",
			slide,
			xfrms: [{ id: table?.id as number, xfrm: { ...(table?.xfrm as Xfrm), flipV: true } }]
		})

		expect(result).toMatchObject({ ok: false, refusal: "unsupported" })
	})
})
