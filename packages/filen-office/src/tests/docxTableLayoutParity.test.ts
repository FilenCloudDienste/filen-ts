import { describe, expect, it } from "vitest"
import { GRAPHIC_FLOATS, GRAPHIC_INTS, PageGraphic, Region, type DocumentLayout } from "@filen/office/core/docx"
import { buildDocx } from "./docxSynthetic"
import { layOut, pageLines, type LineInfo } from "./layoutFixtures"

// Table layout as Word lays tables out: keep with next across rows, vertical alignment of merged cells, cell
// preferred widths over a stale grid, cell spacing, legacy horizontal merges and diagonal borders.

// Letter paper, 1 in margins: a 624 x 864 px text area; text is Times New Roman 10 pt (15.33 px lines).
const SECTION =
	'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
const LINE = 15.33

function p(text: string, pPr = ""): string {
	return `<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

function lines(count: number): string {
	return Array.from({ length: count }, (_, k) => p(`line ${k + 1}`)).join("")
}

function cell(text: string, tcPr = "", pPr = ""): string {
	return `<w:tc>${tcPr === "" ? "" : `<w:tcPr>${tcPr}</w:tcPr>`}${p(text, pPr)}</w:tc>`
}

const BORDERS =
	'<w:tblBorders><w:top w:val="single" w:sz="4"/><w:left w:val="single" w:sz="4"/><w:bottom w:val="single" w:sz="4"/><w:right w:val="single" w:sz="4"/>' +
	'<w:insideH w:val="single" w:sz="4"/><w:insideV w:val="single" w:sz="4"/></w:tblBorders>'
// Cells without side margins: text lies on the grid.
const NO_MARGINS = '<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>'

function table(rows: string, grid: readonly number[] = [2880, 2880, 2880], tblPr = ""): string {
	return `<w:tbl><w:tblPr>${BORDERS}${tblPr}${NO_MARGINS}</w:tblPr><w:tblGrid>${grid.map(w => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>${rows}</w:tbl>`
}

async function layout(body: string): Promise<DocumentLayout> {
	return layOut(buildDocx({ body: `${body}${SECTION}` }))
}

function body(result: DocumentLayout, page: number): LineInfo[] {
	return pageLines(result, page).filter(line => line.region === Region.BODY)
}

function find(result: DocumentLayout, page: number, text: string): LineInfo | undefined {
	return body(result, page).find(line => line.text === text)
}

function graphics(result: DocumentLayout, page: number, kind: number): { x: number; y: number; width: number; height: number }[] {
	const list = result.pages[page]
	const out: { x: number; y: number; width: number; height: number }[] = []

	if (list === undefined) return out

	for (let g = 0; g < list.graphicCount; g++) {
		if (list.graphicInts[g * GRAPHIC_INTS] !== kind) continue

		const f = g * GRAPHIC_FLOATS

		out.push({
			x: list.graphicFloats[f] ?? 0,
			y: list.graphicFloats[f + 1] ?? 0,
			width: list.graphicFloats[f + 2] ?? 0,
			height: list.graphicFloats[f + 3] ?? 0
		})
	}

	return out
}

describe("table rows kept with the next", () => {
	const KEEP = "<w:keepNext/>"
	const rows = (keep: number, count: number): string =>
		Array.from(
			{ length: count },
			(_, k) => `<w:tr>${cell(`k${k + 1}`, "", k < keep ? KEEP : "")}${cell("", "", k < keep ? KEEP : "")}</w:tr>`
		).join("")

	it("moves rows kept with the next together with the row that does not fit", async () => {
		const result = await layout(lines(52) + table(rows(4, 5), [2880, 2880]))

		expect(find(result, 0, "k1")).toBeUndefined()
		expect(texts(result, 1).slice(0, 5)).toEqual(["k1", "", "k2", "", "k3"])
		expect(find(result, 1, "k1")?.top).toBe(96)
	})

	it("splits rows that are not kept with the next as before", async () => {
		const result = await layout(lines(52) + table(rows(0, 5), [2880, 2880]))

		expect(find(result, 0, "k4")).toBeDefined()
		expect(find(result, 1, "k5")?.top).toBe(96)
	})

	it("moves a chain longer than a page to the next page once, then breaks it where that page ends", async () => {
		const result = await layout(p("before") + table(rows(80, 81), [2880, 2880]) + p("after"))
		const all = result.pages.flatMap((_, k) => texts(result, k))

		expect(texts(result, 0)).toEqual(["before"])
		expect(find(result, 1, "k1")?.top).toBe(96)
		expect(result.pages.length).toBe(3)
		expect(all.filter(text => /^k\d+$/.test(text)).length).toBe(81)
		expect(all.at(-1)).toBe("after")
	})

	it("moves rows kept with the next with the table's first row and the paragraph kept with it", async () => {
		const result = await layout(lines(52) + p("caption", KEEP) + table(rows(3, 4), [2880, 2880]))

		expect(find(result, 0, "caption")).toBeUndefined()
		expect(find(result, 1, "caption")?.top).toBe(96)
		expect(find(result, 1, "k1")?.top).toBeCloseTo(96 + LINE, 1)
	})

	it("ends a chain at a row that is not kept with the next in every paragraph", async () => {
		const mixed = `<w:tr>${cell("k1", "", KEEP)}${cell("", "", "")}</w:tr>`
		const result = await layout(lines(52) + table(mixed + rows(0, 4), [2880, 2880]))

		expect(find(result, 0, "k1")?.top).toBe(find(result, 0, "line 52")?.bottom)
	})

	function texts(result: DocumentLayout, page: number): string[] {
		return body(result, page).map(line => line.text)
	}
})

describe("vertically merged cells", () => {
	const merged = (align: string): string =>
		table(
			`<w:tr>${cell("M", `<w:vMerge w:val="restart"/><w:vAlign w:val="${align}"/>`)}${cell("a")}${cell("x")}</w:tr>` +
				`<w:tr>${cell("", "<w:vMerge/>")}${cell("b")}${cell("y")}</w:tr>` +
				`<w:tr>${cell("", "<w:vMerge/>")}${cell("c")}${cell("z")}</w:tr>`
		)

	it("centres and bottom-aligns a merged cell's text across the rows it spans", async () => {
		const center = await layout(merged("center"))
		const bottom = await layout(merged("bottom"))
		const top = await layout(merged("top"))

		expect(find(top, 0, "M")?.top).toBe(96)
		expect(find(center, 0, "M")?.top).toBeCloseTo(find(center, 0, "b")?.top ?? 0, 1)
		expect(find(bottom, 0, "M")?.top).toBeCloseTo(find(bottom, 0, "c")?.top ?? 0, 1)
	})

	it("aligns only the last part of a merge that runs on to the next page", async () => {
		const result = await layout(
			lines(50) +
				table(
					`<w:tr>${cell("M", '<w:vMerge w:val="restart"/><w:vAlign w:val="bottom"/>')}${cell("a")}${cell("x")}</w:tr>` +
						Array.from({ length: 12 }, (_, k) => `<w:tr>${cell("", "<w:vMerge/>")}${cell(`b${k}`)}${cell("")}</w:tr>`).join("")
				)
		)

		// The merge's text fits the first page: it stays there, under the merge's top.
		expect(find(result, 0, "M")?.top).toBeCloseTo(find(result, 0, "a")?.top ?? 0, 1)
	})
})

describe("table grid", () => {
	it("takes an autofit table's columns from the cells' preferred widths over a stale grid", async () => {
		const row = `<w:tr>${cell("a", '<w:tcW w:w="4000" w:type="dxa"/>')}${cell("b", '<w:tcW w:w="4000" w:type="dxa"/>')}</w:tr>`
		const stale = await layout(table(row + row, [1000, 1000]))

		expect(find(stale, 0, "b")?.x).toBeCloseTo(96 + 4000 / 15, 1)
	})

	it("keeps a grid that matches the preferred widths, and a fixed table's grid", async () => {
		const row = (w: number): string =>
			`<w:tr>${cell("a", `<w:tcW w:w="${w}" w:type="dxa"/>`)}${cell("b", `<w:tcW w:w="${w}" w:type="dxa"/>`)}</w:tr>`
		const matching = await layout(table(row(3000), [3005, 2995]))
		const fixed = await layout(table(row(4000), [1000, 1000], '<w:tblLayout w:type="fixed"/>'))

		expect(find(matching, 0, "b")?.x).toBeCloseTo(96 + 3005 / 15, 1)
		expect(find(fixed, 0, "b")?.x).toBeCloseTo(96 + 1000 / 15, 1)
	})

	it("resolves percentage preferred widths against the table's width", async () => {
		const row = `<w:tr>${cell("a", '<w:tcW w:w="1000" w:type="pct"/>')}${cell("b", '<w:tcW w:w="4000" w:type="pct"/>')}</w:tr>`
		const result = await layout(table(row, [1000, 1000], '<w:tblW w:w="9000" w:type="dxa"/>'))

		expect(find(result, 0, "b")?.x).toBeCloseTo(96 + 9000 / 15 / 5, 1)
	})

	it("ignores preferred widths some cells do not give", async () => {
		const row = `<w:tr>${cell("a", '<w:tcW w:w="4000" w:type="dxa"/>')}${cell("b", '<w:tcW w:w="0" w:type="auto"/>')}</w:tr>`
		const result = await layout(table(row, [1000, 1000]))
		// Preferred widths adding up to other than the table's preferred width are no truer than the grid.
		const wide = `<w:tr>${cell("a", '<w:tcW w:w="4000" w:type="dxa"/>')}${cell("b", '<w:tcW w:w="4000" w:type="dxa"/>')}</w:tr>`
		const disagreeing = await layout(table(wide, [1000, 1000], '<w:tblW w:w="2000" w:type="dxa"/>'))

		expect(find(result, 0, "b")?.x).toBeCloseTo(96 + 1000 / 15, 1)
		expect(find(disagreeing, 0, "b")?.x).toBeCloseTo(96 + 1000 / 15, 1)
	})
})

describe("cell spacing", () => {
	it("separates a Word table's cells by the spacing, each drawing its own borders", async () => {
		const row = `<w:tr>${cell("a")}${cell("b")}${cell("c")}</w:tr>`
		const spaced = await layout(table(row + row, undefined, '<w:tblCellSpacing w:w="150" w:type="dxa"/>'))
		const plain = await layout(table(row + row))
		const s = 150 / 15
		const as = body(spaced, 0).filter(line => line.text === "a")

		// Cells inset by the spacing from the table's edge and from each other (twice it between two cells).
		expect(as[0]?.x).toBeCloseTo(96 + s, 1)
		expect(find(spaced, 0, "b")?.x).toBeCloseTo(96 + 192 + s, 1)
		expect(as[0]?.top).toBeCloseTo(96 + s, 1)
		expect(as[1]?.top).toBeCloseTo(96 + s + LINE + 2 * s, 1)
		// The table's border around the outside (its sides per row) and every cell's own four borders.
		expect(graphics(spaced, 0, PageGraphic.BORDER).length).toBe(2 + 2 * 2 + 6 * 4)
		expect(graphics(plain, 0, PageGraphic.BORDER).length).toBe(3 + 3 + 3 + 4 + 4)
	})
})

describe("legacy merges and diagonal borders", () => {
	it("merges hMerge cells into the restart cell", async () => {
		const result = await layout(
			table(`<w:tr>${cell("a", '<w:hMerge w:val="restart"/>')}${cell("gone", "<w:hMerge/>")}${cell("c")}</w:tr>`) + p("after")
		)
		const vertical = graphics(result, 0, PageGraphic.BORDER).filter(line => line.height > 2)

		expect(body(result, 0).map(line => line.text)).toEqual(["a", "c", "after"])
		expect(find(result, 0, "c")?.x).toBe(96 + 384)
		expect(vertical.some(line => Math.abs(line.x + line.width / 2 - 288) < 2)).toBe(false)
	})

	it("draws diagonal cell borders corner to corner", async () => {
		const result = await layout(
			table(
				`<w:tr>${cell("a", '<w:tcBorders><w:tl2br w:val="single" w:sz="4"/></w:tcBorders>')}${cell("b", '<w:tcBorders><w:tr2bl w:val="single" w:sz="4"/></w:tcBorders>')}${cell("c")}</w:tr>`
			)
		)
		const down = graphics(result, 0, PageGraphic.DIAGONAL_DOWN)
		const up = graphics(result, 0, PageGraphic.DIAGONAL_UP)

		expect(down).toEqual([{ x: 96, y: 96, width: 192, height: expect.closeTo(LINE, 1) as number }])
		expect(up.map(line => line.x)).toEqual([288])
	})
})
