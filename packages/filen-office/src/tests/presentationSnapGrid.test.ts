import { describe, expect, it } from "vitest"
import { bytesSource, memorySink } from "@filen/office/core/opc"
import { openPptx } from "../core/pptx/package"
import { DEFAULT_SLIDE_GRID, slideRef, type Deck, type Xfrm } from "../core/presentation/model"
import { SnapTargets } from "../react/presentation/edit/guides"
import { ShapeDrag } from "../react/presentation/edit/handles"
import { freshPptx } from "../core/pptx/write/fresh"
import { buildPptx, type FixtureOptions } from "./pptxFixtures"
import { openDeck as openWriteDeck, partsOf, text } from "./pptxWriteFixtures"

// Snap objects to grid (PowerPoint's View > Grid Settings, on by default): the grid is read from ppt/viewProps.xml,
// and moves, resizes and line ends land on its lines unless a smart guide is within reach; Alt turns both off.

const ref = slideRef(256)
const box = (x: number, y: number, cx: number, cy: number): Xfrm => ({ x, y, cx, cy, rot: 0, flipH: false, flipV: false })
const free = { shift: false, ctrl: false, alt: false }
const slide = { cx: 100_000, cy: 100_000 }
const grid = { cx: 1000, cy: 500 }

async function openDeck(options: FixtureOptions): Promise<Deck> {
	const result = await openPptx(bytesSource(buildPptx(options)))

	if (result.kind !== "opened") throw new Error(`${result.reason}: ${result.detail ?? ""}`)

	return result.deck
}

const VIEW_NS =
	'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

describe("snap to grid", () => {
	it("a move with no guide in reach lands the nearer edge on the grid, origin at the slide's corner", () => {
		const targets = new SnapTargets([], slide, grid)
		// Left edge 10_230 (230 past a line), right edge 12_930 (70 short of one): the right edge wins.
		const snap = targets.snapMove({ x: 10_230, y: 40_120, r: 12_930, b: 41_120 }, 50)

		expect(snap.dx).toBe(70)
		expect(snap.dy).toBe(-120)
		expect(snap.guides).toEqual([])
	})

	it("a smart guide within the threshold wins over the grid", () => {
		const targets = new SnapTargets([{ x: 0, y: 0, r: 10_260, b: 1000 }], slide, grid)
		const snap = targets.snapMove({ x: 10_230, y: 40_000, r: 12_830, b: 41_000 }, 50)

		expect(snap.dx).toBe(30)
		expect(snap.guides).toContainEqual(expect.objectContaining({ axis: "x", at: 10_260 }))
	})

	it("no grid: the pointer's position is kept", () => {
		expect(new SnapTargets([], slide).snapMove({ x: 10_230, y: 40_120, r: 12_830, b: 41_120 }, 50)).toMatchObject({ dx: 0, dy: 0 })
	})

	it("drags move, resize and line ends onto the grid; Alt and a Shift-locked axis keep the pointer's", () => {
		const shapes = [{ id: 3, xfrm: box(10_000, 10_000, 2000, 1000) }]
		const move = new ShapeDrag({
			kind: "move",
			slide: ref,
			shapes,
			start: { x: 0, y: 0 },
			snap: { others: [], slide, grid },
			threshold: 30
		})

		expect(move.move({ x: 340, y: 130 }, free).shapes[0]?.xfrm).toMatchObject({ x: 10_000, y: 10_000 })
		expect(move.move({ x: 340, y: 130 }, { ...free, alt: true }).shapes[0]?.xfrm).toMatchObject({ x: 10_340, y: 10_130 })
		expect(move.move({ x: 640, y: 20 }, { ...free, shift: true }).shapes[0]?.xfrm).toMatchObject({ x: 11_000, y: 10_000 })

		const resize = new ShapeDrag({
			kind: "resize",
			slide: ref,
			shapes,
			id: 3,
			handle: "se",
			start: { x: 0, y: 0 },
			snap: { others: [], slide, grid },
			threshold: 30
		})
		const resized = resize.move({ x: 1380, y: 180 }, free)

		expect(resized.shapes[0]?.xfrm).toMatchObject({ x: 10_000, y: 10_000, cx: 3000, cy: 1000 })
		expect(resized.guides).toEqual([])

		const line = new ShapeDrag({
			kind: "end",
			slide: ref,
			shapes: [{ id: 3, xfrm: box(10_000, 10_000, 2000, 0), line: true }],
			id: 3,
			end: "end",
			start: { x: 12_000, y: 10_000 },
			snap: { others: [], slide, grid },
			threshold: 30
		})
		const end = line.move({ x: 14_400, y: 11_100 }, free).shapes[0]?.xfrm

		expect(end).toMatchObject({ x: 10_000, y: 10_000, cx: 4000, cy: 1000 })
	})

	it("reads gridSpacing and snapToGrid from viewProps, and PowerPoint's defaults without them", async () => {
		const withView = (view: string): FixtureOptions => ({
			slides: [{ shapes: "" }],
			presentationRels: [["rId80", "viewProps", "viewProps.xml"]],
			parts: { "ppt/viewProps.xml": { data: `<p:viewPr ${VIEW_NS}>${view}</p:viewPr>` } }
		})
		const set = await openDeck(
			withView(
				'<p:slideViewPr><p:cSldViewPr snapToGrid="0" snapToObjects="1"><p:cViewPr><p:scale><a:sx n="1" d="1"/><a:sy n="1" d="1"/></p:scale><p:origin x="0" y="0"/></p:cViewPr></p:cSldViewPr></p:slideViewPr><p:gridSpacing cx="38100" cy="57150"/>'
			)
		)

		expect(set.grid).toEqual({ cx: 38_100, cy: 57_150, snap: false })
		expect((await openDeck(withView('<p:gridSpacing cx="0" cy="-5"/>'))).grid).toEqual(DEFAULT_SLIDE_GRID)
		expect((await openDeck({ slides: [{ shapes: "" }] })).grid).toBeUndefined()
		expect(DEFAULT_SLIDE_GRID).toEqual({ cx: 76_200, cy: 76_200, snap: true })
	})

	it("a fresh save keeps the source's grid, guides and snapping as written, dropping what names a relationship", async () => {
		const slideView =
			'<p:slideViewPr><p:cSldViewPr snapToGrid="0" showGuides="1"><p:cViewPr varScale="1"><p:scale><a:sx n="94" d="100"/><a:sy n="94" d="100"/></p:scale><p:origin x="-120" y="-90"/></p:cViewPr><p:guideLst><p:guide orient="horz" pos="2160"/><p:guide pos="2880"/></p:guideLst></p:cSldViewPr></p:slideViewPr>'
		const spacing = '<p:gridSpacing cx="38100" cy="57150"/>'
		const opened = await openWriteDeck(
			buildPptx({
				slides: [{ shapes: "" }],
				presentationRels: [["rId80", "viewProps", "viewProps.xml"]],
				parts: {
					"ppt/viewProps.xml": {
						data: `<p:viewPr ${VIEW_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" lastView="sldView">${slideView}<p:outlineViewPr><p:cViewPr><p:scale><a:sx n="33" d="100"/><a:sy n="33" d="100"/></p:scale><p:origin x="0" y="0"/></p:cViewPr><p:sldLst><p:sld r:id="rId2"/></p:sldLst></p:outlineViewPr>${spacing}<p:extLst><p:ext uri="{00000000-0000-0000-0000-000000000000}"/></p:extLst></p:viewPr>`
					}
				}
			})
		)
		const sink = memorySink()

		expect(await freshPptx(opened.deck, opened.source, sink, {})).toMatchObject({ kind: "written" })

		const view = text((await partsOf(sink.bytes())).get("ppt/viewProps.xml"))

		expect((await openWriteDeck(sink.bytes())).deck.grid).toEqual({ cx: 38_100, cy: 57_150, snap: false })
		expect(view).toContain(`lastView="sldView">${slideView}${spacing}</p:viewPr>`)
		expect(view).not.toContain("outlineViewPr")
		expect(view).not.toContain("extLst")
	})

	it("a fresh save of a deck without view settings writes an empty p:viewPr, not PowerPoint's defaults", async () => {
		const opened = await openWriteDeck(buildPptx({ slides: [{ shapes: "" }] }))
		const sink = memorySink()

		expect(await freshPptx(opened.deck, opened.source, sink, {})).toMatchObject({ kind: "written" })
		expect(text((await partsOf(sink.bytes())).get("ppt/viewProps.xml"))).toMatch(/<p:viewPr[^>]*\/>$/u)
	})
})
