import { describe, expect, it } from "vitest"
import { applyOp } from "../core/presentation/edit/apply"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type SlideNode } from "../core/presentation/model"
import { odpSourceReading } from "../core/odp/write/session"
import { odpWriteSource } from "../core/odp/write/source"
import { odpBytes, plainText } from "./odpFixtures"
import { changes, entriesOf, odpDeck, openOdpDeck, saveDeck, shapeNamed, slideAt, text, type OpenedOdp } from "./odpWriteFixtures"

// Slide structure ops through the slide and shape families (the edit session's ODP source reading), saved.

function applier(opened: OpenedOdp): (op: DeckOp) => void {
	let next = 0x4000_0000
	const context = odpSourceReading(opened.deck, odpWriteSource(opened.parts), { next: () => slideRef(next++) })

	return op => {
		const result = applyOp(opened.deck, op, context)

		if (result.kind === "refused") throw new Error(`${result.reason} ${result.detail ?? ""}`)
	}
}

function pageNames(content: string): string[] {
	return [...content.matchAll(/<draw:page draw:name="([^"]*)"/gu)].map(match => match[1] ?? "")
}

describe("ODP writer: slides", () => {
	it("deletes a page that others jump to: the jumps go to the next slide, custom shows drop it", async () => {
		const opened = await openOdpDeck(odpDeck())
		const apply = applier(opened)
		const end = opened.deck.slides[2]

		if (end === undefined) throw new Error("no slide")

		apply({ family: "slide", kind: "delete", slides: [end] })

		const saved = await saveDeck(opened, changes("slideList", "customShows"))

		expect(saved.outcome.kind === "refused" ? saved.outcome : "written").toBe("written")

		const content = text((await entriesOf(saved.bytes)).get("content.xml"))

		expect(pageNames(content)).toEqual(["Intro", "Middle"])
		expect(content).toContain('presentation:pages="Intro"')
		expect(content).toContain('presentation:start-page="Middle"')
		expect(content).not.toContain("#End")

		const reopened = await openOdpDeck(saved.bytes)
		const middle = slideAt(reopened, 1)

		expect(shapeNamed(middle, "Jump").actions?.click).toEqual({ kind: "internal", jump: "next" })
		expect(plainText(shapeNamed(middle, "Title2"))).toBe("Second page to the end")
		expect(reopened.deck.customShows[0]?.slides).toEqual([reopened.deck.slides[0]])
	})

	it("duplicates a page under a free name with its IDs renamed, and reorders pages", async () => {
		const opened = await openOdpDeck(odpDeck())
		const apply = applier(opened)
		const [intro, middle] = opened.deck.slides

		if (intro === undefined || middle === undefined) throw new Error("no slides")

		apply({ family: "slide", kind: "duplicate", slide: middle })
		apply({ family: "slide", kind: "move", slides: [intro], to: 3 })

		const saved = await saveDeck(opened, changes("slideList"))

		expect(saved.outcome.kind === "refused" ? saved.outcome : "written").toBe("written")

		const content = text((await entriesOf(saved.bytes)).get("content.xml"))

		expect(pageNames(content)).toEqual(["Middle", "Middle (2)", "End", "Intro"])
		expect(content.match(/xml:id="id1"/gu)).toHaveLength(1)
		expect(content).toContain('xml:id="id1_2"')
		expect(content).toContain('presentation:pages="Intro,End"')

		const reopened = await openOdpDeck(saved.bytes)

		expect(reopened.deck.slides).toHaveLength(4)
		expect(plainText(shapeNamed(slideAt(reopened, 1), "Title2"))).toBe("Second page to the end")
		expect(plainText(shapeNamed(slideAt(reopened, 3), "Title"))).toBe("Hello bold world")
	})

	it("adds a slide on a layout with its placeholders written where the layout puts them", async () => {
		const opened = await openOdpDeck(odpDeck())
		const apply = applier(opened)
		const layout = slideAt(opened, 0).parent

		if (layout === undefined) throw new Error("no layout")

		apply({ family: "slide", kind: "add", layout, at: 1 })

		const saved = await saveDeck(opened, changes("slideList"))

		expect(saved.outcome.kind === "refused" ? saved.outcome : "written").toBe("written")

		const reopened = await openOdpDeck(saved.bytes)

		expect(reopened.deck.slides).toHaveLength(4)

		const added = slideAt(reopened, 1)

		expect(added.parent === undefined ? undefined : reopened.deck.nodes.get(added.parent)?.layoutType).toBe("AL1T0")
	})

	it("hides a slide through a patched drawing-page style", async () => {
		const opened = await openOdpDeck(odpDeck())
		const apply = applier(opened)
		const [intro] = opened.deck.slides

		if (intro === undefined) throw new Error("no slide")

		apply({ family: "slide", kind: "hide", slides: [intro], hidden: true })

		const saved = await saveDeck(opened)

		expect(saved.outcome.kind === "refused" ? saved.outcome : "written").toBe("written")
		expect(slideAt(await openOdpDeck(saved.bytes), 0).hidden).toBe(true)
	})

	it("moves, renames and groups shapes through the shape family", async () => {
		const opened = await openOdpDeck(odpDeck())
		const apply = applier(opened)
		const slide = slideAt(opened, 0)
		const box = shapeNamed(slide, "Box")
		const line = shapeNamed(slide, "Line")

		apply({
			family: "shape",
			kind: "setXfrm",
			target: { slide: slide.ref, id: box.id },
			xfrm: { ...(box.xfrm as NonNullable<typeof box.xfrm>), x: 360_000 }
		})
		apply({ family: "shape", kind: "group", slide: slide.ref, shapes: [box.id, line.id] })

		const saved = await saveDeck(opened)

		expect(saved.outcome.kind === "refused" ? saved.outcome : "written").toBe("written")

		const reopened = slideAt(await openOdpDeck(saved.bytes), 0)
		const group = reopened.shapes.find(shape => shape.kind === "grpSp" && shape.children?.some(child => child.name === "Box"))

		expect(group?.children?.map(child => child.name)).toEqual(["Box", "Line"])
		expect(shapeNamed(reopened, "Box").xfrm?.x).toBe(360_000)
	})

	it("writes a second save of the same edits byte for byte the same", async () => {
		const first = await openOdpDeck(odpDeck())
		const second = await openOdpDeck(odpDeck())

		for (const opened of [first, second]) {
			const apply = applier(opened)
			const slide = slideAt(opened, 0)
			const box = shapeNamed(slide, "Box")

			apply({
				family: "shape",
				kind: "setXfrm",
				target: { slide: slide.ref, id: box.id },
				xfrm: { ...(box.xfrm as NonNullable<typeof box.xfrm>), y: 0 }
			})
			apply({ family: "slide", kind: "move", slides: [opened.deck.slides[0] ?? slide.ref], to: 2 })
		}

		const a = await saveDeck(first, changes("slideList"))
		const b = await saveDeck(second, changes("slideList"))

		expect(a.bytes).toEqual(b.bytes)
		expect((await saveDeck(await openOdpDeck(a.bytes))).outcome.kind).toBe("unchanged")
	})
})

// A deck whose first page shows the master's footer (a declaration) and page number; the second shows neither.
const FOOTED = odpBytes({
	automatic:
		'<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties presentation:display-footer="true" presentation:display-page-number="true"/></style:style>',
	body:
		'<presentation:footer-decl presentation:name="ftr1">Company</presentation:footer-decl>' +
		'<draw:page draw:name="one" draw:style-name="dp1" draw:master-page-name="M" presentation:use-footer-name="ftr1"/>' +
		'<draw:page draw:name="two" draw:master-page-name="M"/>'
})

function masterFooters(node: SlideNode): string[] {
	return node.shapes.filter(shape => shape.synthetic === true && shape.lock === "master").map(shape => plainText(shape))
}

describe("ODP writer: a new slide's header and footer", () => {
	it.each([
		["after a footed page", 1],
		["first, before a footed page", 0]
	])("takes the neighbouring page's footer and page number %s", async (_, at) => {
		const opened = await openOdpDeck(FOOTED)
		const apply = applier(opened)
		const layout = slideAt(opened, 0).parent

		if (layout === undefined) throw new Error("no layout")

		apply({ family: "slide", kind: "add", layout, at })

		const added = slideAt(opened, at)

		expect(added.odpHeaderFooter).toEqual({ use: { footer: "ftr1" }, display: { footer: true, "page-number": true } })
		expect(masterFooters(added)).toHaveLength(2)
		expect(masterFooters(added)).toContain("Company")

		const saved = await saveDeck(opened, changes("slideList"))

		expect(saved.outcome.kind === "refused" ? saved.outcome : "written").toBe("written")
		expect(text((await entriesOf(saved.bytes)).get("content.xml"))).toContain('<presentation:footer-decl presentation:name="ftr1">')

		const reread = slideAt(await openOdpDeck(saved.bytes), at)

		expect(reread.odpHeaderFooter).toEqual(added.odpHeaderFooter)
		expect(masterFooters(reread)).toEqual(masterFooters(added))
	})

	it("gives a slide after a page without footers none", async () => {
		const opened = await openOdpDeck(FOOTED)
		const apply = applier(opened)
		const layout = slideAt(opened, 0).parent

		if (layout === undefined) throw new Error("no layout")

		apply({ family: "slide", kind: "add", layout, at: 2 })

		const added = slideAt(opened, 2)

		expect(added.odpHeaderFooter).toBeUndefined()
		expect(masterFooters(added)).toEqual([])

		const saved = await saveDeck(opened, changes("slideList"))
		const reread = slideAt(await openOdpDeck(saved.bytes), 2)

		expect(reread.odpHeaderFooter).toBeUndefined()
		expect(masterFooters(reread)).toEqual([])
	})
})
