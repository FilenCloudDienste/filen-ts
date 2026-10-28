import { describe, expect, it } from "vitest"
import type { ShapeNode } from "../core/presentation/model"
import { plainText } from "./odpFixtures"
import { changes, entriesOf, odpDeck, openOdpDeck, saveDeck, shapeNamed, slideAt, text, touched } from "./odpWriteFixtures"

const EMU_PER_CM = 360_000

describe("ODP splice writer", () => {
	it("answers unchanged for a deck opened and saved with nothing edited", async () => {
		const opened = await openOdpDeck(odpDeck())

		expect((await saveDeck(opened, { empty: true, parts: new Map(), presentation: new Set() })).outcome.kind).toBe("unchanged")
		// A history that went somewhere and came back touches no slide.
		expect((await saveDeck(opened)).outcome.kind).toBe("unchanged")
	})

	it("answers unchanged for an edit undone (the slide was touched, nothing differs from its source)", async () => {
		const opened = await openOdpDeck(odpDeck())
		const slide = touched(slideAt(opened, 0))
		const title = shapeNamed(slide, "Title")
		const before = title.xfrm

		if (before === undefined) throw new Error("no box")

		title.xfrm = { ...before, x: before.x + 1000 }
		title.xfrm = before

		expect((await saveDeck(opened)).outcome.kind).toBe("unchanged")
	})

	it("moves a frame by its svg:x and svg:y alone and copies every other entry and page", async () => {
		const opened = await openOdpDeck(odpDeck())
		const slide = touched(slideAt(opened, 0))
		const title = shapeNamed(slide, "Title")

		title.xfrm = { ...(title.xfrm as NonNullable<ShapeNode["xfrm"]>), x: 3 * EMU_PER_CM, y: 2 * EMU_PER_CM }

		const saved = await saveDeck(opened)

		expect(saved.outcome.kind).toBe("written")

		const before = await entriesOf(opened.bytes)
		const after = await entriesOf(saved.bytes)

		for (const [name, bytes] of before) if (name !== "content.xml") expect(after.get(name), name).toEqual(bytes)

		const content = text(after.get("content.xml"))
		const source = text(before.get("content.xml"))

		expect(content).toContain('svg:x="3cm" svg:y="2cm"')
		// Only the title's start tag changed (and it says it was placed by the user).
		expect(content.replace(/<draw:frame draw:name="Title"[^>]*>/u, "")).toBe(source.replace(/<draw:frame draw:name="Title"[^>]*>/u, ""))

		const reopened = await openOdpDeck(saved.bytes)

		expect(shapeNamed(slideAt(reopened, 0), "Title").xfrm).toMatchObject({ x: 3 * EMU_PER_CM, y: 2 * EMU_PER_CM })
		expect((await saveDeck(reopened)).outcome.kind).toBe("unchanged")
	})

	it("turns a shape with draw:transform and reads it back at the same box and angle", async () => {
		const opened = await openOdpDeck(odpDeck())
		const slide = touched(slideAt(opened, 0))
		const box = shapeNamed(slide, "Box")
		const xfrm = box.xfrm as NonNullable<ShapeNode["xfrm"]>

		box.xfrm = { ...xfrm, rot: 30 * 60_000 }

		const saved = await saveDeck(opened)

		expect(saved.outcome.kind).toBe("written")

		const read = shapeNamed(slideAt(await openOdpDeck(saved.bytes), 0), "Box").xfrm

		expect(read?.rot).toBe(30 * 60_000)
		expect(Math.abs((read?.x ?? 0) - xfrm.x)).toBeLessThanOrEqual(2)
		expect(Math.abs((read?.cy ?? 0) - xfrm.cy)).toBeLessThanOrEqual(2)
	})

	it("moves a group by writing its members where the group puts them", async () => {
		const opened = await openOdpDeck(odpDeck())
		const slide = touched(slideAt(opened, 0))
		const group = shapeNamed(slide, "Group")
		const xfrm = group.xfrm as NonNullable<ShapeNode["xfrm"]>

		group.xfrm = { ...xfrm, x: xfrm.x + EMU_PER_CM, y: xfrm.y - EMU_PER_CM }

		const saved = await saveDeck(opened)

		expect(saved.outcome.kind).toBe("written")

		const reopened = shapeNamed(slideAt(await openOdpDeck(saved.bytes), 0), "Group")

		expect(reopened.children?.map(child => child.xfrm?.x)).toEqual([11 * EMU_PER_CM, 14 * EMU_PER_CM])
		expect(reopened.children?.map(child => child.xfrm?.y)).toEqual([14 * EMU_PER_CM, 14 * EMU_PER_CM])
	})

	it("writes edited text with its paragraph and span styles, keeping the shape's other children", async () => {
		const opened = await openOdpDeck(odpDeck())
		const slide = touched(slideAt(opened, 0))
		const box = shapeNamed(slide, "Box")
		const paragraph = box.text?.paragraphs[0]

		if (box.text === undefined || paragraph === undefined) throw new Error("no text")

		box.text = {
			...box.text,
			paragraphs: [
				{
					...paragraph,
					runs: [
						{ kind: "r", text: "Typed  text ", rPr: {} },
						{ kind: "r", text: "italic", rPr: { i: true, sz: 1800 } }
					]
				}
			]
		}

		const saved = await saveDeck(opened)

		expect(saved.outcome.kind).toBe("written")

		const content = text((await entriesOf(saved.bytes)).get("content.xml"))

		expect(content).toContain("<svg:title>A box</svg:title>")
		expect(content).toContain("draw:enhanced-path")
		expect(content).toMatch(/Typed <text:s\/>text <text:span text:style-name="T\d+">italic<\/text:span>/u)

		const read = shapeNamed(slideAt(await openOdpDeck(saved.bytes), 0), "Box")

		expect(plainText(read)).toBe("Typed  text italic")
		expect(read.text?.paragraphs[0]?.runs[1]).toMatchObject({ text: "italic", rPr: { i: true, sz: 1800 } })
	})

	it("changes a fill through a patched copy of the shape's own style", async () => {
		const opened = await openOdpDeck(odpDeck())
		const slide = touched(slideAt(opened, 0))
		const box = shapeNamed(slide, "Box")

		box.props = { ...box.props, fill: { kind: "solid", color: { kind: "srgb", rgb: "00FF00" } } }

		const saved = await saveDeck(opened)

		expect(saved.outcome.kind).toBe("written")

		const content = text((await entriesOf(saved.bytes)).get("content.xml"))
		const style = /<style:style style:family="graphic" style:name="(gr\d+)"|<style:style style:name="(gr\d+)" style:family="graphic"/u

		expect(content).toMatch(style)
		// The copy keeps what the source style said beside the fill (its line).
		expect(content).toMatch(/draw:fill-color="#00ff00"[^>]*draw:stroke="none"|draw:stroke="none"[^>]*draw:fill-color="#00ff00"/u)
		// The rectangle and ellipse still name the source style, which stays.
		expect(content).toContain('draw:style-name="gr1"')
		expect(shapeNamed(slideAt(await openOdpDeck(saved.bytes), 0), "Box").props?.fill).toEqual({
			kind: "solid",
			color: { kind: "srgb", rgb: "00FF00" }
		})
	})

	it("keeps the pages it did not touch byte for byte", async () => {
		const opened = await openOdpDeck(odpDeck())
		const slide = touched(slideAt(opened, 2))

		shapeNamed(slide, "Title3").name = "Renamed"

		const saved = await saveDeck(opened)
		const before = text((await entriesOf(opened.bytes)).get("content.xml"))
		const after = text((await entriesOf(saved.bytes)).get("content.xml"))
		const pageOf = (content: string, name: string): string =>
			new RegExp(`<draw:page draw:name="${name}".*?</draw:page>`, "su").exec(content)?.[0] ?? ""

		expect(pageOf(after, "Intro")).toBe(pageOf(before, "Intro"))
		expect(pageOf(after, "Middle")).toBe(pageOf(before, "Middle"))
		expect(pageOf(after, "End")).toContain('draw:name="Renamed"')
	})

	it("refuses a page background an ODP source save cannot hold instead of dropping it", async () => {
		const opened = await openOdpDeck(odpDeck())
		const slide = touched(slideAt(opened, 0))

		slide.background = {
			kind: "fill",
			fill: { kind: "gradient", stops: [], angle: 0 }
		} as unknown as NonNullable<typeof slide.background>

		const saved = await saveDeck(opened)

		expect(saved.outcome).toMatchObject({ kind: "refused", reason: "unsupported" })
	})

	it("refuses a view-only deck", async () => {
		const opened = await openOdpDeck(odpDeck())

		opened.deck.gate.push("signed")

		expect((await saveDeck(opened, changes())).outcome).toMatchObject({ kind: "refused", reason: "viewOnly" })
	})
})
