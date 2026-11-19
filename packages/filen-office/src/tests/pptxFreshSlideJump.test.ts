import { describe, expect, it } from "vitest"
import { memorySink } from "@filen/office/core/opc"
import { freshPptx } from "../core/pptx/write/fresh"
import { body, buildPptx, sp, xfrm } from "./pptxFixtures"
import { openDeck, partsOf, slideNode, text } from "./pptxWriteFixtures"

// A fresh write classifies a source run's slide jump as the reader does: by part key, so a relationship target that
// differs from the slide's part name in case or percent-encoding still names that slide and the unchanged run stays
// its source hole. (A fresh write needs every slide parsed, so a jump to an unparsed slide does not arise there.)

const KEEP = '<a:extLst><a:ext uri="{00000000-0000-0000-0000-00000000000A}"><x:keep xmlns:x="urn:example:keep"/></a:ext></a:extLst>'

function deckWith(target: string): Uint8Array {
	const run = `<a:p><a:r><a:rPr lang="en-GB"><a:hlinkClick r:id="rId91" action="ppaction://hlinksldjump"/>${KEEP}</a:rPr><a:t>Jump</a:t></a:r></a:p>`

	return buildPptx({
		slides: [
			{ shapes: sp(2, "TextBox 1", undefined, xfrm(0, 0, 100, 100), body(run)), rels: [["rId91", "slide", target]] },
			{ shapes: sp(2, "TextBox 1", undefined, xfrm(0, 0, 100, 100), body("<a:p><a:r><a:t>Two</a:t></a:r></a:p>")) }
		]
	})
}

describe("a fresh write of a slide-jump run", () => {
	for (const target of ["SLIDE2.xml", "slide%32.xml"])
		it(`keeps the run whole when its target is ${target}`, async () => {
			const opened = await openDeck(deckWith(target))
			const two = opened.deck.slides[1]

			expect(slideNode(opened, 0).shapes[0]?.text?.paragraphs[0]?.runs[0]).toMatchObject({
				rPr: { hlinkClick: { kind: "slide", slide: two } }
			})

			const sink = memorySink()
			const outcome = await freshPptx(opened.deck, opened.source, sink, {})

			expect(outcome.kind).toBe("written")

			const parts = await partsOf(sink.bytes())
			const slide = text(parts.get("ppt/slides/slide1.xml"))

			// The run's markup is the source's (its relationship id kept), not written again from the model.
			expect(slide).toContain(`<a:hlinkClick r:id="rId91" action="ppaction://hlinksldjump"/>${KEEP}`)
			expect(text(parts.get("ppt/slides/_rels/slide1.xml.rels"))).toContain(
				'Id="rId91" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slide2.xml"'
			)
		})
})
