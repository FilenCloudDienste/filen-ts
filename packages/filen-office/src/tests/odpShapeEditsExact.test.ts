import { describe, expect, it } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import type { ShapeNode, SlideRef, TextBody, Xfrm } from "../core/presentation/model"
import { odpParts } from "../dom/presentation/engine/open/odp"
import { review } from "../dom/presentation/engine/review"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { entriesOf, openOdpDeck, text } from "./odpWriteFixtures"

// ODP shapes edited and edited back: custom outlines flipped, grouped, resized and ungrouped; a turned shape turned
// back; the same state saved twice. Each saves, and returning to a state writes that state's bytes.

const STYLE =
	'<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#3366cc" draw:stroke="solid" svg:stroke-color="#000000"/></style:style>'
const CUSTOM =
	'<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="non-primitive" draw:modifiers="5400" draw:enhanced-path="M ?f0 0 L 21600 0 21600 21600 0 21600 Z N"><draw:equation draw:name="f0" draw:formula="$0 "/><draw:handle draw:handle-position="$0 top" draw:handle-range-x-minimum="0" draw:handle-range-x-maximum="21600"/></draw:enhanced-geometry>'
const SHAPES =
	'<draw:custom-shape draw:name="hexagon" draw:style-name="gr1" svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="3cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="hexagon" draw:modifiers="3000"/></draw:custom-shape>' +
	`<draw:custom-shape draw:name="custom" draw:style-name="gr1" svg:x="7cm" svg:y="1cm" svg:width="4cm" svg:height="3cm">${CUSTOM}</draw:custom-shape>` +
	'<draw:custom-shape draw:name="nopath" draw:style-name="gr1" svg:x="13cm" svg:y="1cm" svg:width="4cm" svg:height="3cm"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:enhanced-path="M 0 0 L 21600 10800 0 21600 Z N"/></draw:custom-shape>' +
	'<draw:custom-shape draw:name="rot" draw:style-name="gr1" svg:width="4cm" svg:height="3cm" draw:transform="rotate (0.5235987756) translate (12cm 12cm)"><draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="can" draw:modifiers="3000"/></draw:custom-shape>'
const SOURCE = odpBytes({ automatic: STYLE, body: `<draw:page draw:name="One" draw:master-page-name="M">${SHAPES}</draw:page>` })

async function content(bytes: Uint8Array | undefined): Promise<string> {
	return text((await entriesOf(bytes as Uint8Array)).get("content.xml"))
}

function element(markup: string, name: string): string {
	return new RegExp(`<draw:custom-shape draw:name="${name}"[\\s\\S]*?</draw:custom-shape>`, "u").exec(markup)?.[0] ?? ""
}

async function session() {
	const d = await driveSession(SOURCE)
	const slide = d.session.deck.slides[0] as SlideRef
	const shapes = async (): Promise<readonly ShapeNode[]> => (await odpParts(d.session.deck)?.slide(slide))?.shapes ?? []
	const set = async (name: string, change: (xfrm: Xfrm) => Partial<Xfrm>) => {
		const shape = (await shapes()).find(each => each.name === name) as ShapeNode
		const xfrm = shape.xfrm as Xfrm

		return d.command({ family: "shape", kind: "setXfrm", target: { slide, id: shape.id }, xfrm: { ...xfrm, ...change(xfrm) } })
	}

	return { d, slide, shapes, set }
}

describe("a custom outline in an ODP flipped", () => {
	it("saves, the flip as the outline's mirror, its formulas and handles kept; undone it writes the source", async () => {
		const { d, set } = await session()

		expect((await set("custom", xfrm => ({ flipH: !xfrm.flipH }))).ok).toBe(true)
		expect((await set("nopath", xfrm => ({ flipV: !xfrm.flipV }))).ok).toBe(true)

		const saved = await d.save()

		expect(saved.result.kind).toBe("written")

		const after = await content(saved.bytes)

		expect(element(after, "custom")).toContain('draw:mirror-horizontal="true"')
		expect(element(after, "custom")).toContain('<draw:handle draw:handle-position="$0 top"')
		expect(element(after, "nopath")).toContain('draw:mirror-vertical="true"')

		expect((await d.undo()).ok).toBe(true)
		expect((await d.undo()).ok).toBe(true)
		expect(await content((await d.save()).bytes)).toBe(await content(SOURCE))
	})
})

describe("a custom outline in an ODP grouped, resized with its group and ungrouped", () => {
	it("saves each step keeping the outlines; undone it writes the source", async () => {
		const { d, slide, shapes } = await session()
		const ids = (await shapes()).filter(each => each.name === "hexagon" || each.name === "custom").map(each => each.id)

		expect((await d.command({ family: "shape", kind: "group", slide, shapes: ids })).ok).toBe(true)

		const group = (await shapes()).find(each => each.kind === "grpSp") as ShapeNode
		const box = group.xfrm as Xfrm

		expect(
			(
				await d.command({
					family: "shape",
					kind: "setXfrm",
					target: { slide, id: group.id },
					xfrm: { ...box, cx: Math.round(box.cx * 1.2) }
				})
			).ok
		).toBe(true)

		const grouped = await d.save()

		expect(grouped.result.kind).toBe("written")
		expect((await d.command({ family: "shape", kind: "ungroup", slide, group: group.id })).ok).toBe(true)

		const ungrouped = await d.save()

		expect(ungrouped.result.kind).toBe("written")

		const markup = await content(ungrouped.bytes)

		expect(element(markup, "custom")).toContain(CUSTOM)
		expect(element(markup, "hexagon")).toContain('draw:type="hexagon" draw:modifiers="3000"')

		for (let k = 0; k < 3; k++) expect((await d.undo()).ok).toBe(true)

		expect(await content((await d.save()).bytes)).toBe(await content(SOURCE))
	})

	it("flips a group as LibreOffice does: each member mirrored in the group's box, its mirror turned; undone it writes the source", async () => {
		const { d, slide, shapes } = await session()
		const ids = (await shapes()).filter(each => each.name === "hexagon" || each.name === "custom").map(each => each.id)

		expect((await d.command({ family: "shape", kind: "group", slide, shapes: ids })).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")

		const group = (await shapes()).find(each => each.kind === "grpSp") as ShapeNode
		const box = group.xfrm as Xfrm

		expect(
			(await d.command({ family: "shape", kind: "setXfrm", target: { slide, id: group.id }, xfrm: { ...box, flipH: !box.flipH } })).ok
		).toBe(true)

		const flipped = await d.save()

		expect(flipped.result.kind).toBe("written")

		const markup = await content(flipped.bytes)

		// The hexagon (1–5 cm) and the custom outline (7–11 cm) change places in the 1–11 cm group box.
		expect(element(markup, "hexagon")).toContain('svg:x="7cm"')
		expect(element(markup, "hexagon")).toContain('draw:type="hexagon" draw:modifiers="3000" draw:mirror-horizontal="true"')
		expect(element(markup, "custom")).toContain('svg:x="1cm"')
		expect(element(markup, "custom")).toContain('draw:mirror-horizontal="true"')

		// Read again: a group as ODF holds one (never mirrored), its members mirrored.
		const read = await openOdpDeck(flipped.bytes as Uint8Array)
		const page = read.deck.nodes.get(read.deck.slides[0] as SlideRef)
		const again = page?.shapes.find(each => each.kind === "grpSp")

		expect(again?.xfrm?.flipH).toBe(false)
		expect(again?.children?.map(member => member.xfrm?.flipH)).toEqual([true, true])

		for (let k = 0; k < 2; k++) expect((await d.undo()).ok).toBe(true)

		expect(await content((await d.save()).bytes)).toBe(await content(SOURCE))
	})
})

describe("a turned ODP shape turned back", () => {
	it("writes its source's draw:transform text again", async () => {
		const { d, set } = await session()

		expect((await set("rot", xfrm => ({ rot: xfrm.rot + 30 * 60000 }))).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
		expect((await d.undo()).ok).toBe(true)
		expect(await content((await d.save()).bytes)).toBe(await content(SOURCE))
	})
})

describe("the same ODP state saved twice", () => {
	const body = (value: string): TextBody => ({ bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: value, rPr: {} }] }] })

	it("writes the same bytes: a style a save retired is named again, not renumbered", async () => {
		const { d, slide } = await session()

		expect((await d.command({ family: "notes", kind: "setNotes", slide, body: body("") } as DeckOp)).ok).toBe(true)

		const first = await d.save()

		expect((await d.undo()).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
		expect((await d.redo()).ok).toBe(true)

		const again = await d.save()

		expect(await content(again.bytes)).toBe(await content(first.bytes))
	})

	it("keeps an emptied notes frame a placeholder", async () => {
		const { d, slide } = await session()

		expect((await d.command({ family: "notes", kind: "setNotes", slide, body: body("note") } as DeckOp)).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")

		const target = (await review(d.context, slide, { comments: false })).notes

		expect(
			(await d.command({ family: "text", kind: "setText", target: target as NonNullable<typeof target>, body: body("") } as DeckOp))
				.ok
		).toBe(true)

		const markup = await content((await d.save()).bytes)
		const frame = /<draw:frame [^>]*presentation:class="notes"[^>]*>[\s\S]*?<\/draw:frame>/u.exec(markup)?.[0] ?? ""

		expect(frame).toContain('presentation:placeholder="true"')
		expect(frame).not.toContain("<text:span")
	})
})

describe("an ODP placeholder moved and moved back", () => {
	it("is marked user-transformed while moved, and loses the mark again when an undo after a save moves it back", async () => {
		const source = odpBytes({
			body: '<draw:page draw:name="One" draw:master-page-name="M"><draw:frame presentation:class="title" svg:x="2cm" svg:y="1cm" svg:width="20cm" svg:height="3cm"><draw:text-box><text:p>Title</text:p></draw:text-box></draw:frame></draw:page>'
		})
		const d = await driveSession(source)
		const slide = d.session.deck.slides[0] as SlideRef
		const title = ((await odpParts(d.session.deck)?.slide(slide))?.shapes ?? [])[0] as ShapeNode
		const xfrm = title.xfrm as Xfrm

		expect(
			(await d.command({ family: "shape", kind: "setXfrm", target: { slide, id: title.id }, xfrm: { ...xfrm, x: xfrm.x + 12700 } }))
				.ok
		).toBe(true)

		const moved = await content((await d.save()).bytes)

		expect(moved).toContain('presentation:user-transformed="true"')
		expect((await d.undo()).ok).toBe(true)
		expect(await content((await d.save()).bytes)).toBe(await content(source))
	})
})

describe("ODP notes the session added, on a slide deleted and restored", () => {
	it("save each step: notes, save, delete, save, undo, save", async () => {
		const source = odpBytes({
			body: [0, 1, 2]
				.map(
					i =>
						`<draw:page draw:name="P${String(i)}" draw:master-page-name="M"><draw:frame draw:name="T" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box><text:p>T${String(i)}</text:p></draw:text-box></draw:frame></draw:page>`
				)
				.join("")
		})
		const d = await driveSession(source)
		const slide = d.session.deck.slides[1] as SlideRef
		const notes: TextBody = { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "N", rPr: {} }] }] }

		expect((await d.command({ family: "notes", kind: "setNotes", slide, body: notes } as DeckOp)).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
		expect((await d.command({ family: "slide", kind: "delete", slides: [slide] } as DeckOp)).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
		expect((await d.undo()).ok).toBe(true)
		expect((await d.save()).result.kind).toBe("written")
	})
})

describe("ODP elements without a mirror of their own, flipped", () => {
	const ELEMENTS =
		'<draw:rect draw:name="Rect" draw:style-name="gr1" svg:x="1cm" svg:y="1cm" svg:width="4cm" svg:height="2cm"><text:p>Rect</text:p></draw:rect>' +
		'<draw:ellipse draw:name="Ellipse" draw:style-name="gr1" svg:x="6cm" svg:y="1cm" svg:width="4cm" svg:height="2cm"/>' +
		'<draw:polyline draw:name="Polyline" draw:style-name="gr1" svg:x="11cm" svg:y="1cm" svg:width="4cm" svg:height="3cm" svg:viewBox="0 0 4000 3000" draw:points="0,0 4000,1000 1000,3000"/>' +
		'<draw:polygon draw:name="Polygon" draw:style-name="gr1" svg:x="16cm" svg:y="1cm" svg:width="4cm" svg:height="3cm" svg:viewBox="0 0 4000 3000" draw:points="0,0 4000,1000 1000,3000"/>' +
		'<draw:path draw:name="Path" draw:style-name="gr1" svg:width="4cm" svg:height="3cm" svg:viewBox="0 0 4000 3000" svg:d="M 0 0 L 4000 1000 1000 3000 Z" draw:transform="rotate (0.5235987756) translate (2cm 8cm)"/>' +
		'<dr3d:scene xmlns:dr3d="urn:oasis:names:tc:opendocument:xmlns:dr3d:1.0" svg:x="8cm" svg:y="8cm" svg:width="4cm" svg:height="3cm"/>'
	const source = odpBytes({ automatic: STYLE, body: `<draw:page draw:name="One" draw:master-page-name="M">${ELEMENTS}</draw:page>` })

	for (const [label, change] of [
		["horizontally", (xfrm: Xfrm): Partial<Xfrm> => ({ flipH: !xfrm.flipH })],
		["vertically", (xfrm: Xfrm): Partial<Xfrm> => ({ flipV: !xfrm.flipV })]
	] as const)
		it(`saves each flipped ${label} as DrawingML means it, and undoes to the source`, async () => {
			const d = await driveSession(source)
			const slide = d.session.deck.slides[0] as SlideRef
			const shapes = (await odpParts(d.session.deck)?.slide(slide))?.shapes ?? []

			for (const shape of shapes)
				expect(
					(
						await d.command({
							family: "shape",
							kind: "setXfrm",
							target: { slide, id: shape.id },
							xfrm: { ...(shape.xfrm as Xfrm), ...change(shape.xfrm as Xfrm) }
						})
					).ok,
					shape.name
				).toBe(true)

			const saved = await d.save()

			expect(saved.result.kind).toBe("written")

			const read = await openOdpDeck(saved.bytes as Uint8Array)
			const page = read.deck.nodes.get(read.deck.slides[0] as SlideRef)
			const box = (name: string): Xfrm | undefined => page?.shapes.find(shape => shape.name === name)?.xfrm
			const before = (name: string): Xfrm => shapes.find(shape => shape.name === name)?.xfrm as Xfrm
			// Under DrawingML's meaning a horizontal flip is a vertical one half a turn round.
			const half = (rot: number): number => (rot + 10_800_000) % 21_600_000

			// Mirrored, a rectangle and an ellipse are themselves: a vertical flip turns their text half round.
			for (const name of ["Rect", "Ellipse"]) {
				expect(box(name)?.flipH || box(name)?.flipV, name).toBe(false)
				expect(box(name)?.rot, name).toBe(label === "vertically" ? half(before(name).rot) : before(name).rot)
			}

			// A polyline, polygon and path hold the mirror in their transform, read back as a vertical one.
			for (const name of ["Polyline", "Polygon", "Path"]) {
				expect(box(name)?.flipV, name).toBe(true)
				expect(box(name)?.rot, name).toBe(label === "vertically" ? before(name).rot : half(before(name).rot))
				expect(box(name)?.x, name).toBe(before(name).x)
				expect(box(name)?.y, name).toBe(before(name).y)
			}

			for (let k = 0; k < shapes.length; k++) expect((await d.undo()).ok).toBe(true)

			expect(await content((await d.save()).bytes)).toBe(await content(source))
		})
})
