import { describe, expect, it } from "vitest"
import { diagramFactsHeld } from "../core/pptx/write/emit/smartart"
import type { ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { pptxParts } from "../dom/presentation/engine/open/pptx"
import { smartArtRenderer } from "../dom/presentation/engine/smartart"
import { driveSession } from "./odpWriteDrive"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { danglingReferences } from "./pptxWriteFixtures"

// The diagram facts a pptx save reads before it emits (the package's parsed diagram data, the parts slides share) live
// for that save only: none are held for the deck once it returns, and the next save reads them again.

describe("diagram facts of a pptx save", () => {
	it("holds none once each save returns, and later saves still write the diagram", async () => {
		const d = await driveSession(
			buildPptx({ slides: [{ shapes: sp(2, "TextBox 1", undefined, xfrm(100_000, 100_000, 3_000_000, 500_000), body(para("P"))) }] }),
			"pptx"
		)
		const slide = d.session.deck.slides[0] as SlideRef

		smartArtRenderer(d.session, {
			services: {
				xml: part => pptxParts(d.session.deck)?.document(part),
				relationship: () => undefined,
				contentType: () => undefined
			}
		})

		const box = { x: 1_000_000, y: 1_000_000, cx: 6_000_000, cy: 3_000_000, rot: 0, flipH: false, flipV: false }
		const inserted = await d.command({
			family: "smartart",
			kind: "insert",
			slide,
			shape: { id: 0, name: "Diagram", hidden: false, kind: "frame", xfrm: box } as ShapeNode,
			layout: { uniqueId: "urn:filen:smartart:layout:list-basic", source: "gallery" },
			texts: ["Alpha", "Beta"]
		})

		expect(inserted.ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
		expect(diagramFactsHeld(d.session.deck)).toBe(false)

		const id = (d.session.deck.nodes.get(slide) as SlideNode).shapes.find(shape => shape.name === "Diagram")?.id ?? 0

		expect(
			(
				await d.command({
					family: "smartart",
					kind: "setLayout",
					target: { slide, id },
					def: { uniqueId: "urn:filen:smartart:layout:process-basic", source: "gallery" }
				})
			).ok
		).toBe(true)

		const { result, bytes } = await d.save()

		expect(result.kind).toBe("written")
		expect(diagramFactsHeld(d.session.deck)).toBe(false)
		expect(await danglingReferences(bytes ?? new Uint8Array())).toEqual([])
	})
})
