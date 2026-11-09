import { describe, expect, it } from "vitest"
import {
	DocumentLayout,
	Region,
	TURN_FLOATS,
	TURN_INTS,
	TurnInt,
	textDirectionTurn,
	turnMatrix,
	turnRect,
	turnX,
	turnY,
	unturnX,
	unturnY,
	type LayoutOptions
} from "@filen/office/core/docx"
import { FRAGMENT_INTS, FragmentFlag } from "@filen/office/core/text"
import { writingMode } from "../core/docx/reflow/tables"
import { buildDocx, type SyntheticDocx } from "./docxSynthetic"
import { layOut, pageLines } from "./layoutFixtures"

// Letter paper, 1 in margins: a 624 x 864 px text area; Times New Roman 10 pt without a styles part.
const SECTION =
	'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
const GRID = '<w:tblGrid><w:gridCol w:w="2880"/><w:gridCol w:w="2880"/></w:tblGrid>'
const NO_MARGINS =
	'<w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="0" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar>'

function p(text: string, pPr = ""): string {
	return `<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
}

function cell(content: string, tcPr = ""): string {
	return `<w:tc>${tcPr === "" ? "" : `<w:tcPr>${tcPr}</w:tcPr>`}${content}</w:tc>`
}

function table(rows: string): string {
	return `<w:tbl><w:tblPr>${NO_MARGINS}</w:tblPr>${GRID}${rows}</w:tbl>`
}

async function layout(spec: SyntheticDocx, options: LayoutOptions = {}): Promise<DocumentLayout> {
	return layOut(buildDocx({ ...spec, body: `${spec.body ?? ""}${SECTION}` }), options)
}

interface Turn {
	readonly angle: number
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
	readonly lines: readonly [number, number]
}

function turns(result: DocumentLayout, index: number): Turn[] {
	const page = result.pages[index]
	const out: Turn[] = []

	for (let t = 0; t < (page?.turnCount ?? 0); t++) {
		const f = t * TURN_FLOATS
		const i = t * TURN_INTS

		out.push({
			angle: page?.turnInts[i + TurnInt.ANGLE] ?? 0,
			x: page?.turnFloats[f] ?? 0,
			y: page?.turnFloats[f + 1] ?? 0,
			width: page?.turnFloats[f + 2] ?? 0,
			height: page?.turnFloats[f + 3] ?? 0,
			lines: [page?.turnInts[i + TurnInt.LINE_FROM] ?? 0, page?.turnInts[i + TurnInt.LINE_TO] ?? 0]
		})
	}

	return out
}

describe("turned text primitives", () => {
	it("maps ST_TextDirection to a turn", () => {
		expect(textDirectionTurn("btLr")).toBe(270)
		expect(textDirectionTurn("lr")).toBe(270)
		expect(textDirectionTurn("tbRl")).toBe(90)
		expect(textDirectionTurn("tbRlV")).toBe(90)
		expect(textDirectionTurn("tbLrV")).toBe(90)
		expect(textDirectionTurn("lrTb")).toBe(0)
		expect(textDirectionTurn("lrTbV")).toBe(0)
		expect(textDirectionTurn(undefined)).toBe(0)
	})

	it("turns a frame onto its box both ways and back", () => {
		// Box 40 wide, 200 tall at (100, 50): frame x runs 0..200 along, y 0..40 across from the box's corner.
		const down = turnMatrix(90, 100, 50, 40, 200)

		// Top to bottom: the frame's start is the box's top right corner, its first line at the right.
		expect([turnX(down, 100, 50), turnY(down, 100, 50)]).toEqual([140, 50])
		expect([turnX(down, 300, 50), turnY(down, 300, 50)]).toEqual([140, 250])
		expect([turnX(down, 100, 90), turnY(down, 100, 90)]).toEqual([100, 50])

		const up = turnMatrix(270, 100, 50, 40, 200)

		// Bottom to top: the frame's start is the box's bottom left corner.
		expect([turnX(up, 100, 50), turnY(up, 100, 50)]).toEqual([100, 250])
		expect([turnX(up, 300, 50), turnY(up, 300, 50)]).toEqual([100, 50])

		for (const m of [down, up]) {
			expect(unturnX(m, turnX(m, 123, 67), turnY(m, 123, 67))).toBeCloseTo(123, 6)
			expect(unturnY(m, turnX(m, 123, 67), turnY(m, 123, 67))).toBeCloseTo(67, 6)
		}

		expect(turnRect(down, 100, 50, 200, 40, { x: 0, y: 0, width: 0, height: 0 })).toEqual({ x: 100, y: 50, width: 40, height: 200 })
	})
})

describe("sideways text in table cells", () => {
	it("draws upright cells without turns", async () => {
		const result = await layout({ body: table(`<w:tr>${cell(p("a"))}${cell(p("b"))}</w:tr>`) })

		expect(result.pages[0]?.turnCount).toBe(0)
	})

	it("grows the row to fit a bottom to top cell's text on one line", async () => {
		const text = "a rather long label that runs up the cell"
		// Its one line's length, upright on the page (wider than the cell).
		const upright = await layout({ body: p(text) })
		const result = await layout({
			body: table(`<w:tr>${cell(p(text), '<w:textDirection w:val="btLr"/>')}${cell(p("b"))}</w:tr>`) + p("after")
		})
		const width = pageLines(upright, 0)[0]?.width ?? 0
		const list = turns(result, 0)
		const lines = pageLines(result, 0).filter(line => line.region === Region.BODY)
		const label = lines.find(line => line.text === text)
		const after = lines.find(line => line.text === "after")

		expect(width).toBeGreaterThan(192)
		expect(list).toHaveLength(1)
		expect(list[0]?.angle).toBe(270)
		// The box is the cell (no margins): 192 px wide, as tall as the text's one line is long.
		expect(list[0]?.x).toBeCloseTo(96, 0)
		expect(list[0]?.width).toBeCloseTo(192, 0)
		expect(list[0]?.height).toBeCloseTo(width, 0)
		// The line is laid out in the box's frame: from its corner, as long as the box is tall.
		expect(label?.x).toBeCloseTo(96, 0)
		expect(label?.width).toBeCloseTo(width, 0)
		// The paragraph after the table starts below the grown row.
		expect(after?.top).toBeGreaterThanOrEqual((list[0]?.y ?? 0) + width - 1)
	})

	it("wraps sideways text at an exact row height", async () => {
		const text = "one two three four five six seven eight nine ten"
		const result = await layout({
			body: table(
				`<w:tr><w:trPr><w:trHeight w:val="1200" w:hRule="exact"/></w:trPr>${cell(p(text), '<w:textDirection w:val="tbRl"/>')}${cell(p("b"))}</w:tr>`
			)
		})
		const list = turns(result, 0)
		const turned = pageLines(result, 0).slice(list[0]?.lines[0] ?? 0, list[0]?.lines[1] ?? 0)

		expect(list[0]?.angle).toBe(90)
		expect(list[0]?.height).toBeCloseTo(80, 0)
		expect(turned.length).toBeGreaterThan(1)

		for (const line of turned) expect(line.width).toBeLessThanOrEqual(80 + 0.01)
	})

	it("aligns sideways text across its cell", async () => {
		const row = (vAlign: string): string =>
			table(`<w:tr>${cell(p("label"), `<w:textDirection w:val="btLr"/><w:vAlign w:val="${vAlign}"/>`)}${cell(p("b"))}</w:tr>`)
		const top = await layout({ body: row("top") })
		const bottom = await layout({ body: row("bottom") })
		const at = (result: DocumentLayout): number => {
			const turn = turns(result, 0)[0]

			return pageLines(result, 0)[turn?.lines[0] ?? 0]?.top ?? 0
		}

		// In the frame the first line stands at the top (the cell's left edge on the page), or at the bottom.
		expect(at(top)).toBeCloseTo(turns(top, 0)[0]?.y ?? 0, 0)
		expect(at(bottom) - at(top)).toBeGreaterThan(150)
	})

	it("lays a vertical merge's sideways text over the rows it spans", async () => {
		const result = await layout({
			body: table(
				`<w:tr>${cell(p("group"), '<w:vMerge w:val="restart"/><w:textDirection w:val="btLr"/>')}${cell(p("r1"))}</w:tr>` +
					`<w:tr>${cell("<w:p/>", "<w:vMerge/>")}${cell(p("r2"))}</w:tr>` +
					`<w:tr>${cell("<w:p/>", "<w:vMerge/>")}${cell(p("r3"))}</w:tr>`
			)
		})
		const lines = pageLines(result, 0)
		const r1 = lines.find(line => line.text === "r1")
		const r3 = lines.find(line => line.text === "r3")
		const list = turns(result, 0)

		expect(list).toHaveLength(1)
		expect(list[0]?.y).toBeCloseTo(r1?.top ?? 0, 0)
		expect((list[0]?.y ?? 0) + (list[0]?.height ?? 0)).toBeCloseTo(r3?.bottom ?? 0, 0)
	})

	it("keeps the turn with its row when the table moves to the next page", async () => {
		const filler = Array.from({ length: 52 }, (_, k) => p(`line ${k}`)).join("")
		const result = await layout({
			body:
				filler +
				table(`<w:tr>${cell(p("a long sideways label in a cell"), '<w:textDirection w:val="btLr"/>')}${cell(p("b"))}</w:tr>`)
		})
		const second = turns(result, 1)

		expect(turns(result, 0)).toHaveLength(0)
		expect(second).toHaveLength(1)
		expect(second[0]?.y).toBeCloseTo(96, 0)
	})

	it("puts the first line of a tbLrV cell at its left and stands East Asian characters upright", async () => {
		const text = "日本語の縦書き text that wraps over lines"
		const result = await layout({
			body: table(
				`<w:tr><w:trPr><w:trHeight w:val="1500" w:hRule="exact"/></w:trPr>${cell(p(text), '<w:textDirection w:val="tbLrV"/>')}${cell(p("b"))}</w:tr>`
			)
		})
		const turn = turns(result, 0)[0]
		const page = result.pages[0]
		const lines = pageLines(result, 0).slice(turn?.lines[0] ?? 0, turn?.lines[1] ?? 0)
		let upright = 0

		for (let f = 0; f < (page?.text.fragmentCount ?? 0); f++)
			if (((page?.text.fragmentInts[f * FRAGMENT_INTS + 3] ?? 0) & FragmentFlag.UPRIGHT) !== 0) upright++

		expect(turn?.angle).toBe(90)
		expect(lines.length).toBeGreaterThan(1)
		// Turned by 90 the frame's bottom is the box's left: lines follow each other upwards in the frame.
		expect(lines[0]?.top ?? 0).toBeGreaterThan(lines[1]?.top ?? 0)
		// One fragment per East Asian character (seven), the Latin words lying with the line.
		expect(upright).toBe(7)
	})
})

describe("sideways cells in the reflow view", () => {
	it("gives each text direction its writing mode", () => {
		expect(writingMode("tbRl")).toBe("writing-mode: vertical-rl; text-orientation: sideways")
		expect(writingMode("tbRlV")).toBe("writing-mode: vertical-rl")
		expect(writingMode("tbLrV")).toBe("writing-mode: vertical-lr")
		expect(writingMode("btLr")).toContain("writing-mode: sideways-lr")
		expect(writingMode("lrTb")).toBe("")
		expect(writingMode(undefined)).toBe("")
	})
})

describe("sideways text in text boxes", () => {
	const box = (vert: string): string =>
		'<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor behindDoc="0" allowOverlap="1" layoutInCell="1" relativeHeight="1" simplePos="0" locked="0"><wp:simplePos x="0" y="0"/>' +
		'<wp:positionH relativeFrom="page"><wp:posOffset>952500</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>4762500</wp:posOffset></wp:positionV>' +
		'<wp:extent cx="952500" cy="1905000"/><wp:wrapNone/><wp:docPr id="3" name="t"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
		`<wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>inside the box</w:t></w:r></w:p></w:txbxContent></wps:txbx><wps:bodyPr vert="${vert}" lIns="0" tIns="0" rIns="0" bIns="0"/></wps:wsp>` +
		"</a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice></mc:AlternateContent></w:r>"

	it("turns a vert270 box's text onto the box", async () => {
		const result = await layout({ body: `<w:p>${box("vert270")}<w:r><w:t>body</w:t></w:r></w:p>` })
		const turn = turns(result, 0)[0]
		const inside = pageLines(result, 0).find(line => line.region === Region.TEXTBOX)

		// The box is 100 x 200 px at (100, 500); its text runs along its 200 px height.
		expect(turn).toMatchObject({ angle: 270, x: 100, y: 500, width: 100, height: 200 })
		expect(inside?.x).toBe(100)
		expect(inside?.top).toBe(500)
	})

	it("leaves a horizontal box upright", async () => {
		const result = await layout({ body: `<w:p>${box("horz")}<w:r><w:t>body</w:t></w:r></w:p>` })

		expect(result.pages[0]?.turnCount).toBe(0)
	})
})
