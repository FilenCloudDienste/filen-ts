import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { TimeNode } from "../core/anim/model"
import type { ShapeNode, SlideNode } from "../core/presentation/model"
import { CORPUS_DIR } from "./corpusDir"
import { changes, entriesOf, openOdpDeck, saveDeck, text, touched } from "./odpWriteFixtures"

// A page's timing (anim:par timing-root) through the ODP writer: kept as its source span when only shapes change,
// written by the timing family when the timing itself changes, read back the same, saved again as unchanged.

const DECK = join(CORPUS_DIR, "odp", "govuk__bbfa-11-business-lifecycle.odp")

function timingOf(content: string, page: string): string {
	const at = content.indexOf(`draw:name="${page}"`)
	const end = content.indexOf("</draw:page>", at)
	const slice = content.slice(at, end)
	const start = slice.search(/<anim:par[^>]*presentation:node-type="timing-root"/u)

	return start < 0 ? "" : slice.slice(start)
}

function animated(slides: readonly SlideNode[]): SlideNode {
	const slide = slides.find(node => node.timing !== undefined)

	if (slide === undefined) throw new Error("no animated slide")

	return slide
}

function firstTimed(node: TimeNode): TimeNode | undefined {
	if (node.ctn.dur !== undefined && node.ctn.dur !== "indefinite") return node

	for (const child of node.ctn.children ?? []) {
		const found = firstTimed(child)

		if (found !== undefined) return found
	}

	return undefined
}

describe.skipIf(!existsSync(DECK))("ODP writer: timing", () => {
	it("keeps a page's anim:* markup byte for byte when a shape on it moves, and saves again as unchanged", async () => {
		const opened = await openOdpDeck(new Uint8Array(readFileSync(DECK)))
		const slide = touched(animated(opened.deck.slides.map(ref => opened.deck.nodes.get(ref) as SlideNode)))
		const shape = slide.shapes.find(candidate => candidate.xfrm !== undefined && candidate.synthetic !== true) as ShapeNode & {
			xfrm: NonNullable<ShapeNode["xfrm"]>
		}

		shape.xfrm = { ...shape.xfrm, x: shape.xfrm.x + 12_700 }

		const saved = await saveDeck(opened)

		expect(saved.outcome.kind).toBe("written")

		const before = timingOf(text((await entriesOf(opened.bytes)).get("content.xml")), slide.name ?? "")
		const after = timingOf(text((await entriesOf(saved.bytes)).get("content.xml")), slide.name ?? "")

		expect(before.length).toBeGreaterThan(100)
		expect(after).toBe(before)
		expect((await saveDeck(await openOdpDeck(saved.bytes))).outcome.kind).toBe("unchanged")
	})

	it("writes an edited effect through the timing family and reads it back", async () => {
		const opened = await openOdpDeck(new Uint8Array(readFileSync(DECK)))
		const slide = touched(animated(opened.deck.slides.map(ref => opened.deck.nodes.get(ref) as SlideNode)))
		const timing = slide.timing

		if (timing === undefined) throw new Error("no timing")

		const node = firstTimed(timing.root)

		if (node === undefined) throw new Error("no timed node")

		node.ctn.dur = 1234

		const saved = await saveDeck(opened, changes())

		expect(saved.outcome.kind).toBe("written")
		expect(text((await entriesOf(saved.bytes)).get("content.xml"))).toContain('smil:dur="1.234s"')

		const reopened = await openOdpDeck(saved.bytes)
		const index = opened.deck.slides.indexOf(slide.ref)
		const read = reopened.deck.nodes.get(reopened.deck.slides[index] ?? slide.ref)

		expect(read?.timing === undefined ? undefined : firstTimed(read.timing.root)?.ctn.dur).toBe(1234)
		expect((await saveDeck(reopened)).outcome.kind).toBe("unchanged")
	})
})
