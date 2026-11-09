import { describe, expect, it, vi } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openOdp } from "../core/odp/read/document"
import { odpLayoutType } from "../core/odp/read/layoutType"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { designLayouts } from "../core/presentation/edit/apply/design"
import { newSlideLayout } from "../core/presentation/edit/commands/slide"
import type { Deck } from "../core/presentation/model"
import { blankOdp } from "../core/templates/odp"
import { DEFAULT_MASTER, DEFAULT_STYLES_AUTOMATIC, openOdpFixture, page, slideOf } from "./odpFixtures"

// What the ODP reader offers beyond the pages: every presentation page layout on every master, typed as
// ST_SlideLayoutType (ECMA-376 §19.7.15) for New Slide; the notes page's own size (its presentation:notes'
// style:page-layout-name); and pictures' own sizes for crops read from their headers only, once per picture.

const EMU_PER_CM = 360_000

const LAYOUTS =
	'<style:presentation-page-layout style:name="AL1T0"><presentation:placeholder presentation:object="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"/><presentation:placeholder presentation:object="subtitle" svg:x="2cm" svg:y="5cm" svg:width="24cm" svg:height="10cm"/></style:presentation-page-layout>' +
	'<style:presentation-page-layout style:name="Content"><presentation:placeholder presentation:object="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"/><presentation:placeholder presentation:object="outline" svg:x="2cm" svg:y="5cm" svg:width="24cm" svg:height="10cm"/></style:presentation-page-layout>' +
	'<style:presentation-page-layout style:name="AL3T19" style:display-name="Heading"><presentation:placeholder presentation:object="title" svg:x="2cm" svg:y="1cm" svg:width="24cm" svg:height="3cm"/></style:presentation-page-layout>'

function choices(deck: Deck) {
	return designLayouts(deck)
}

describe("ODP layouts", () => {
	it("gives every master every presentation page layout, typed by its placeholders and named only when the file names it", async () => {
		const opened = await openOdpFixture({
			styles: LAYOUTS,
			masters: DEFAULT_MASTER + DEFAULT_MASTER.replace('style:name="M"', 'style:name="N"'),
			body: page("", 'draw:master-page-name="M" presentation:presentation-page-layout-name="AL1T0"')
		})
		const [m, n] = opened.deck.masters
		const listed = choices(opened.deck).map(({ master, type, name }) => [master === m ? "M" : master === n ? "N" : "?", type, name])

		expect(listed).toEqual([
			["M", "title", undefined],
			["M", "obj", "Content"],
			["M", "titleOnly", "Heading"],
			["N", "title", undefined],
			["N", "obj", "Content"],
			["N", "titleOnly", "Heading"]
		])
		// The page's layout is the one its master offers.
		expect((await slideOf(opened, 0)).parent).toBe(opened.deck.layouts[0])
	})

	it("keeps layouts no page uses within what the layout budget leaves after the pages'", async () => {
		const opened = await openOdpFixture(
			{
				styles: LAYOUTS,
				body: page("", 'draw:master-page-name="M" presentation:presentation-page-layout-name="AL3T19"')
			},
			{ budgets: { ...DEFAULT_PRESENTATION_BUDGETS, layouts: 2 } }
		)
		const layouts = opened.deck.layouts.map(ref => opened.deck.nodes.get(ref)?.layoutType)

		expect(layouts).toHaveLength(2)
		expect(layouts).toContain("AL3T19")
	})

	it("types layouts without placeholders by LibreOffice's AutoLayout names, else as blank", () => {
		expect(odpLayoutType({ layoutType: "AL7T1", shapes: [] })).toBe("obj")
		expect(odpLayoutType({ layoutType: "AL2T20", shapes: [] })).toBe("blank")
		expect(odpLayoutType({ layoutType: "Plain", shapes: [] })).toBe("blank")
		expect(odpLayoutType({ shapes: [] })).toBe("blank")
	})

	it("offers a blank deck Title Slide, Title and Content, Two Content, Title Only and Blank; New Slide after the title is Title and Content", async () => {
		const opened = await openOdp(bytesSource(await blankOdp({ locale: "en-US" })))

		if (opened.kind !== "opened") throw new Error(opened.reason)

		const offered = choices(opened.deck)
		const slide = await opened.parts.slide(opened.deck.slides[0] ?? (0 as never))

		expect(offered.map(layout => layout.type)).toEqual(["title", "obj", "twoObj", "titleOnly", "blank"])
		expect(offered.every(layout => layout.name === undefined)).toBe(true)
		expect(slide.parent).toBe(offered[0]?.ref)
		expect(newSlideLayout(offered, slide.parent)).toBe(offered[1]?.ref)
		expect(opened.deck.nodes.get(offered[2]?.ref ?? (0 as never))?.shapes.map(shape => shape.ph?.type)).toEqual([
			"title",
			"body",
			"body"
		])
	})
})

describe("ODP notes page size", () => {
	const notesLayout =
		'<style:page-layout style:name="PM2"><style:page-layout-properties fo:page-width="21.59cm" fo:page-height="27.94cm"/></style:page-layout>'

	it("is the page layout the master's presentation:notes names", async () => {
		const opened = await openOdpFixture({
			stylesAutomatic: DEFAULT_STYLES_AUTOMATIC + notesLayout,
			masters: DEFAULT_MASTER.replace(
				"</style:master-page>",
				'<presentation:notes style:page-layout-name="PM2"><draw:page-thumbnail presentation:class="page" svg:x="2cm" svg:y="2cm" svg:width="17cm" svg:height="12cm"/></presentation:notes></style:master-page>'
			),
			body: page("")
		})

		expect(opened.deck.size).toEqual({ cx: 28 * EMU_PER_CM, cy: 21 * EMU_PER_CM })
		expect(opened.deck.notesSize).toEqual({ cx: Math.round(21.59 * EMU_PER_CM), cy: Math.round(27.94 * EMU_PER_CM) })
	})

	it("is the slide's turned when the notes name no page layout", async () => {
		const opened = await openOdpFixture({
			masters: DEFAULT_MASTER.replace("</style:master-page>", "<presentation:notes/></style:master-page>"),
			body: page("")
		})

		expect(opened.deck.notesSize).toEqual({ cx: 21 * EMU_PER_CM, cy: 28 * EMU_PER_CM })
	})
})

const u32 = (value: number): number[] => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
const pngChunk = (type: string, data: ArrayLike<number>): Uint8Array =>
	new Uint8Array([...u32(data.length), ...[...type].map(c => c.charCodeAt(0)), ...Array.from(data), 0, 0, 0, 0])

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}

	return out
}

describe("ODP picture sizes for crops", () => {
	const clipped =
		'<style:style style:name="g1" style:family="graphic"><style:graphic-properties fo:clip="rect(0pt, 15pt, 7.5pt, 7.5pt)"/></style:style>'
	const frame = (name: string): string =>
		`<draw:frame draw:style-name="g1" svg:width="4cm" svg:height="2cm"><draw:image xlink:href="Pictures/${name}"/></draw:frame>`

	it("reads a picture's header without inflating it, once for every page that crops it", async () => {
		// A 200 × 100 px PNG at 192 per inch (75 × 37.5 pt) with 4 MB of pixel data after its header.
		const png = concat([
			new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			pngChunk("IHDR", [...u32(200), ...u32(100), 8, 6, 0, 0, 0]),
			pngChunk("pHYs", [...u32(7559), ...u32(7559), 1]),
			pngChunk("IDAT", new Uint8Array(4 * 1024 * 1024)),
			pngChunk("IEND", [])
		])
		const opened = await openOdpFixture({
			extra: [{ name: "Pictures/a.png", data: png, mediaType: "image/png" }],
			automatic: clipped,
			body: page(frame("a.png")) + page(frame("a.png"))
		})
		const archive = opened.parts.odf.archive
		const read = vi.spyOn(archive, "read")
		const stream = vi.spyOn(archive, "stream")
		const crop = { l: 10_000, t: 0, r: 20_000, b: 20_000 }

		expect((await slideOf(opened, 0)).shapes[0]?.props?.fill).toEqual({ kind: "picture", part: "/Pictures/a.png", crop })
		expect((await slideOf(opened, 1)).shapes[0]?.props?.fill).toEqual({ kind: "picture", part: "/Pictures/a.png", crop })
		expect(read.mock.calls.filter(([entry]) => entry.name === "Pictures/a.png")).toHaveLength(0)
		expect(stream.mock.calls.filter(([entry]) => entry.name === "Pictures/a.png")).toHaveLength(1)
	})

	it("reads a JPEG whose frame header lies past the first streamed chunk", async () => {
		// 100 × 50 px at 96 per inch (JFIF), after ~640 KB of APP1 segments, stored so chunks are 512 KB.
		const app = (): Uint8Array => concat([new Uint8Array([0xff, 0xe1, 0xff, 0xff]), new Uint8Array(0xfffd)])
		const jpeg = concat([
			new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, 0, 96, 0, 96, 0, 0]),
			...Array.from({ length: 10 }, app),
			new Uint8Array([0xff, 0xc0, 0, 11, 8, 0, 50, 0, 100, 1, 1, 0x11, 0]),
			new Uint8Array([0xff, 0xd9])
		])
		const opened = await openOdpFixture({
			extra: [{ name: "Pictures/b.jpg", data: jpeg, mediaType: "image/jpeg" }],
			automatic: clipped,
			body: page(frame("b.jpg"))
		})

		expect((await slideOf(opened, 0)).shapes[0]?.props?.fill).toEqual({
			kind: "picture",
			part: "/Pictures/b.jpg",
			crop: { l: 10_000, t: 0, r: 20_000, b: 20_000 }
		})
	})
})
