import { describe, expect, it } from "vitest"
import { proveOdpSlide } from "../core/odp/write/proof"
import { odpWriteSource } from "../core/odp/write/source"
import type { ShapeNode, SlideNode, SlideRef } from "../core/presentation/model"
import { odpBytes, page } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { odpApplier, odpDeck, openOdpDeck, saveDeck, shapeNamed, slideAt } from "./odpWriteFixtures"
import { image } from "./presentationObjectsFixtures"

// Proof gate 1 on ODP: each source shape rewritten as an edit of what it already says, read back, compared.

describe("ODP proof gate 1", () => {
	it("proves every shape of the writer's own fixture", async () => {
		const opened = await openOdpDeck(odpDeck())
		const tally = proveOdpSlide({ deck: opened.deck, slide: slideAt(opened, 0), source: odpWriteSource(opened.parts) })

		expect(tally.locked).toEqual({})
		expect(tally.shapes).toBeGreaterThan(5)
	})

	it("locks a skewed frame whose box no attribute rewrite reproduces, and keeps its bytes", async () => {
		const opened = await openOdpDeck(
			odpBytes({
				body: page(
					'<draw:frame draw:name="Skewed" svg:width="4cm" svg:height="2cm" draw:transform="skewX (0.3) translate (2cm 2cm)"><draw:text-box><text:p>Skewed</text:p></draw:text-box></draw:frame>' +
						'<draw:frame draw:name="Plain" svg:x="1cm" svg:y="8cm" svg:width="4cm" svg:height="2cm"><draw:text-box><text:p>Plain</text:p></draw:text-box></draw:frame>'
				)
			})
		)
		const slide = slideAt(opened, 0)
		const tally = proveOdpSlide({ deck: opened.deck, slide, source: odpWriteSource(opened.parts) })

		expect(tally.locked).toEqual({ proofFailed: 1 })
		expect(shapeNamed(slide, "Skewed").lock).toBe("proofFailed")
		expect(shapeNamed(slide, "Plain").lock).toBeUndefined()

		// A content edit of the locked shape is refused by the shape family; the plain one saves.
		const apply = odpApplier(opened)
		const skewed = shapeNamed(slide, "Skewed")
		const plain = shapeNamed(slide, "Plain")

		expect(apply({ family: "shape", kind: "setAlt", target: { slide: slide.ref, id: skewed.id }, alt: { title: "t" } })).toMatchObject({
			reason: "locked"
		})
		expect(apply({ family: "shape", kind: "setAlt", target: { slide: slide.ref, id: plain.id }, alt: { title: "t" } })).toBeUndefined()
		expect((await saveDeck(opened)).outcome.kind).toBe("written")
	})

	// A picture inserted on a page proved already, the page then copied: the copy is proved on its first edit, and the
	// picture, which has no source, is never proved (it read back as another kind and was locked).
	it("leaves a shape the session made unproved on a page copied since", async () => {
		const d = await driveSession(
			odpBytes({
				body: page(
					'<draw:frame draw:name="Plain" svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="2cm"><draw:text-box><text:p>Plain</text:p></draw:text-box></draw:frame>'
				)
			})
		)
		const slide = d.session.deck.slides[0] as SlideRef
		const box = { x: 1_000_000, y: 1_000_000, cx: 3_000_000, cy: 2_000_000, rot: 0, flipH: false, flipV: false }
		const shape = { id: 0, name: "Picture", hidden: false, kind: "pic", xfrm: box } as ShapeNode

		expect((await d.command({ family: "picture", kind: "insert", slide, shape, image: image(8, 8) })).ok).toBe(true)
		expect((await d.command({ family: "slide", kind: "duplicate", slide })).ok).toBe(true)

		const copy = d.session.deck.nodes.get(d.session.deck.slides[1] as SlideRef) as SlideNode
		const plain = copy.shapes.find(each => each.name === "Plain") as ShapeNode

		expect(
			(
				await d.command({
					family: "shape",
					kind: "setXfrm",
					target: { slide: copy.ref, id: plain.id },
					xfrm: { ...(plain.xfrm as NonNullable<ShapeNode["xfrm"]>), x: 254_000 }
				})
			).ok
		).toBe(true)
		expect(copy.shapes.map(each => [each.name, each.lock])).toEqual([
			["Plain", undefined],
			["Picture", undefined]
		])
	})
})
