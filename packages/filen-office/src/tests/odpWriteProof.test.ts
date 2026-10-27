import { describe, expect, it } from "vitest"
import { proveOdpSlide } from "../core/odp/write/proof"
import { odpWriteSource } from "../core/odp/write/source"
import { odpBytes, page } from "./odpFixtures"
import { odpApplier, odpDeck, openOdpDeck, saveDeck, shapeNamed, slideAt } from "./odpWriteFixtures"

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
})
