import { describe, expect, it } from "vitest"
import type { TimeNode } from "../core/anim/model"
import { TIMING_XML } from "./animFixtures"
import { openOdpFixture, page, slideOf } from "./odpFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { Changes, openDeck, partsOf, save, slideNode, text } from "./pptxWriteFixtures"

// Timing through the open deck and the splice writer: read with the slide, kept byte for byte when only a shape
// changes, and an edited effect written back with the rest of p:timing as its source.

const SLIDE = "/ppt/slides/slide1.xml"
const PART = "ppt/slides/slide1.xml"

function deck(): Uint8Array {
	return buildPptx({
		slides: [
			{
				shapes:
					sp(2, "Title", 'type="title"', xfrm(100, 100, 5000000, 800000), body(para("Animated"))) +
					sp(3, "Body", 'idx="1"', xfrm(100, 1000000, 5000000, 3000000), body(para("One") + para("Two"))) +
					sp(4, "Box", undefined, xfrm(6000000, 1000000, 1000000, 1000000)),
				after: `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${TIMING_XML}`
			}
		]
	})
}

function find(node: TimeNode, id: number): TimeNode | undefined {
	return node.ctn.id === id ? node : node.ctn.children.map(child => find(child, id)).find(found => found !== undefined)
}

describe("timing in a saved deck", () => {
	it("reads the slide's timing when the slide is parsed", async () => {
		const opened = await openDeck(deck())
		const timing = slideNode(opened, 0).timing

		expect(timing?.root.ctn.nodeType).toBe("tmRoot")
		expect(timing?.builds).toHaveLength(1)
	})

	it("keeps p:timing byte for byte when a shape on the slide moves", async () => {
		const opened = await openDeck(deck())
		const node = slideNode(opened, 0)
		const box = node.shapes.find(shape => shape.id === 4)

		if (box?.xfrm === undefined) throw new Error("no box")

		box.xfrm.x += 12700

		const saved = await save(opened, new Changes().shape(SLIDE, 4, { kind: "xfrm" }).build())

		expect(saved.outcome.kind).toBe("written")
		expect(text((await partsOf(saved.bytes)).get(PART))).toContain(TIMING_XML)
	})

	it("writes an edited effect and keeps the rest of p:timing as its source", async () => {
		const opened = await openDeck(deck())
		const node = slideNode(opened, 0)
		const anim = node.timing === undefined ? undefined : find(node.timing.root, 7)

		if (anim === undefined) throw new Error("no node 7")

		;(anim.ctn as { dur?: number }).dur = 900

		const saved = await save(opened, new Changes().slide(SLIDE, { kind: "slidePart", part: "timing" }).build())

		expect(saved.outcome.kind).toBe("written")

		const xml = text((await partsOf(saved.bytes)).get(PART))
		const second = TIMING_XML.slice(
			TIMING_XML.indexOf('<p:par><p:cTn id="12"'),
			TIMING_XML.indexOf("</p:childTnLst></p:cTn><p:prevCondLst>")
		)

		expect(xml).toContain('<p:cTn id="7" dur="900" fill="hold"/>')
		expect(xml).toContain(second)
		expect(xml).toContain('p14:presetBounceEnd="40000"')

		// The saved deck reads back the edit; saving it again untouched changes nothing.
		const reopened = await openDeck(saved.bytes)
		const again = slideNode(reopened, 0).timing

		expect(again === undefined ? undefined : find(again.root, 7)?.ctn.dur).toBe(900)
		expect((await save(reopened, new Changes().build())).outcome.kind).toBe("unchanged")
	})

	it("removes p:timing when the slide loses it", async () => {
		const opened = await openDeck(deck())
		const node = slideNode(opened, 0)

		delete node.timing

		const saved = await save(opened, new Changes().slide(SLIDE, { kind: "slidePart", part: "timing" }).build())
		const xml = text((await partsOf(saved.bytes)).get(PART))

		expect(xml).not.toContain("<p:timing")
		expect(slideNode(await openDeck(saved.bytes), 0).timing).toBeUndefined()
	})
})

describe("timing in an opened ODP", () => {
	it("reads a page's SMIL timing with its targets resolved to the page's shapes", async () => {
		const frames =
			'<draw:frame draw:id="id1" xml:id="id1" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box/></draw:frame>' +
			'<draw:frame draw:id="id2" xml:id="id2" svg:x="8cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box/></draw:frame>'
		const timing =
			'<anim:par presentation:node-type="timing-root"><anim:seq presentation:node-type="main-sequence">' +
			'<anim:par smil:begin="indefinite"><anim:par smil:begin="0s"><anim:par smil:begin="0s" smil:fill="hold" presentation:node-type="on-click" presentation:preset-class="entrance" presentation:preset-id="ooo-entrance-appear">' +
			'<anim:set smil:begin="0s" smil:dur="0.001s" smil:fill="hold" smil:targetElement="id2" smil:attributeName="visibility" smil:to="visible"/>' +
			"</anim:par></anim:par></anim:par></anim:seq></anim:par>"
		const opened = await openOdpFixture({ body: page(frames + timing) })
		const slide = await slideOf(opened, 0)
		const second = slide.shapes[1]
		const effect = slide.timing?.root.ctn.children[0]?.ctn.children[0]?.ctn.children[0]?.ctn.children[0]

		expect(effect?.ctn).toMatchObject({
			presetClass: "entr",
			presetID: 1,
			nodeType: "clickEffect"
		})
		expect(effect?.ctn.children[0]).toMatchObject({
			behavior: {
				type: "set",
				to: "visible",
				common: { target: { kind: "shape", shape: second?.id } }
			}
		})
	})
})
