import { describe, expect, it } from "vitest"
import { DEFAULT_PAGE_SETUP, type SheetHeaderFooter, type SheetPageSetup } from "../core/sheet/print/setup"
import type { SheetAxisLayout, SheetLayout } from "../core/sheet/protocol"
import { overPlacement } from "../react/sheet/print/printLayout"
import { bandPictureSlot, bandVariant, pagePlacement, pageView, printSheet } from "../react/sheet/print/printPage"

// The placement and band rules the SVG print and the PDF export share: where objects and notes go on a page and its
// clip, which header and footer a page prints, where a page's content stands on the paper.

function axis(size: number): SheetAxisLayout {
	return {
		defaultSize: size,
		indices: new Uint32Array(0),
		sizes: new Float32Array(0),
		styles: new Uint32Array(0),
		flags: new Uint16Array(0)
	}
}

function layout(rightToLeft: boolean): SheetLayout {
	return {
		sheet: 0,
		version: 0,
		rowCount: 10,
		colCount: 3,
		rows: axis(20),
		cols: axis(64),
		merges: new Uint32Array(0),
		pane: null,
		zoom: 100,
		gridLines: true,
		headings: false,
		rightToLeft,
		protection: null
	}
}

function printed(rightToLeft: boolean, setup: SheetPageSetup = DEFAULT_PAGE_SETUP): ReturnType<typeof printSheet> {
	return printSheet(0, "Data", layout(rightToLeft), setup, [{ startRow: 0, startCol: 0, endRow: 9, endCol: 2 }])
}

describe("what a page draws over its cells", () => {
	it("places a box by the page's own rows and columns and clips at them, left to right", () => {
		const sheet = printed(false, { ...DEFAULT_PAGE_SETUP, headings: true })
		const first = sheet.pagination.pages[0]

		if (first === undefined) throw new Error("no page")

		// The page from column B on: its own cells start after the row numbers' band.
		const page = { ...first, cols: { first: 1, last: 2 } }
		const view = pageView(sheet, page)
		const header = view.cols.header
		const over = overPlacement(sheet, page, view)

		expect(header).toBeGreaterThan(0)
		expect(over.place({ x: 96, y: 20, width: 32, height: 10 })).toEqual({
			x: header + 32,
			y: view.rows.header + 20,
			width: 32,
			height: 10
		})
		expect(over.clip).toEqual({ x: header, y: view.rows.header, width: 128, height: 200 })
		expect(over.meets({ x: 96, y: 20, width: 32, height: 10 })).toBe(true)
		expect(over.meets({ x: 0, y: 20, width: 64, height: 10 })).toBe(false)
		expect(over.meets({ x: 300, y: 20, width: 10, height: 10 })).toBe(false)
	})

	it("mirrors the box and the clip on a right-to-left sheet", () => {
		const sheet = printed(true, { ...DEFAULT_PAGE_SETUP, headings: true })
		const first = sheet.pagination.pages[0]

		if (first === undefined) throw new Error("no page")

		const page = { ...first, cols: { first: 1, last: 2 } }
		const view = pageView(sheet, page)
		const over = overPlacement(sheet, page, view)

		// Column B is the rightmost of the page's own cells, left of the row numbers on the right.
		expect(over.place({ x: 64, y: 0, width: 64, height: 20 })).toEqual({
			x: view.width - view.cols.header - 64,
			y: view.rows.header,
			width: 64,
			height: 20
		})
		expect(over.clip).toEqual({ x: 0, y: view.rows.header, width: 128, height: 200 })
	})
})

const BANDS: SheetHeaderFooter = {
	...DEFAULT_PAGE_SETUP.headerFooter,
	odd: { header: "odd", footer: "odd footer" },
	even: { header: "even", footer: "even footer" },
	first: { header: "first", footer: "first footer" }
}

describe("a page's header and footer", () => {
	it("prints the first page's on the sheet's first page when the sheet has its own", () => {
		expect(bandVariant({ ...BANDS, differentFirst: true, differentOddEven: true }, 1, true)).toEqual({
			texts: BANDS.first,
			pictures: "FIRST"
		})
	})

	it("prints the even pages' on an even page number, the first page's too when its number is even", () => {
		const both = { ...BANDS, differentOddEven: true }

		expect(bandVariant(both, 4, false)).toEqual({ texts: BANDS.even, pictures: "EVEN" })
		expect(bandVariant(both, 2, true)).toEqual({ texts: BANDS.even, pictures: "EVEN" })
		expect(bandVariant(both, 3, false)).toEqual({ texts: BANDS.odd, pictures: "" })
	})

	it("prints the odd pages' everywhere when the sheet has no others", () => {
		expect(bandVariant(BANDS, 2, true)).toEqual({ texts: BANDS.odd, pictures: "" })
	})

	it("shows a picture in its section of its band when it is of the page's set", () => {
		expect(bandPictureSlot("LHEVEN", "EVEN")).toEqual({ header: true, side: "left" })
		expect(bandPictureSlot("CF", "")).toEqual({ header: false, side: "center" })
		expect(bandPictureSlot("RHFIRST", "FIRST")).toEqual({ header: true, side: "right" })
		expect(bandPictureSlot("RH", "FIRST")).toBeNull()
		expect(bandPictureSlot("LHFIRST", "")).toBeNull()
		expect(bandPictureSlot("XH", "")).toBeNull()
	})
})

describe("a page's place on the paper", () => {
	it("stands at the margins' corner, or centred inside them where the setup says", () => {
		const plain = printed(false)
		const centred = printed(false, { ...DEFAULT_PAGE_SETUP, horizontalCentered: true, verticalCentered: true })
		const page = plain.pagination.pages[0]

		if (page === undefined) throw new Error("no page")

		const view = pageView(plain, page)
		const { area, scale } = plain.pagination
		const k = 0.75 * scale

		expect(pagePlacement(plain, view)).toEqual({ x: area.x, y: area.y, k })
		expect(pagePlacement(centred, view)).toEqual({
			x: area.x + (area.width - view.width * k) / 2,
			y: area.y + (area.height - view.height * k) / 2,
			k
		})
	})
})
