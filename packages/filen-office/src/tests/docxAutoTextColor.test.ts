import { describe, expect, it } from "vitest"
import { buildDocx } from "./docxSynthetic"
import { layOut } from "./layoutFixtures"

// Automatic text colour (w:color auto, ST_HexColorAuto) is drawn white over a dark fill behind it: the run's
// highlight, then its shading, then the paragraph's, the cell's and the table's; explicit colours stay.

const run = (size: number, rPr = ""): string =>
	`<w:r><w:rPr><w:sz w:val="${String(size)}"/>${rPr}</w:rPr><w:t xml:space="preserve">t${String(size)}</w:t></w:r>`
const para = (runs: string, pPr = ""): string => `<w:p>${pPr === "" ? "" : `<w:pPr>${pPr}</w:pPr>`}${runs}</w:p>`
const shd = (fill: string): string => `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`
const table = (tblPr: string, cells: readonly { tcPr: string; body: string }[]): string =>
	`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${tblPr}</w:tblPr><w:tblGrid>${cells.map(() => '<w:gridCol w:w="3000"/>').join("")}</w:tblGrid>` +
	`<w:tr>${cells.map(cell => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/>${cell.tcPr}</w:tcPr>${cell.body}</w:tc>`).join("")}</w:tr></w:tbl>`

async function colors(body: string): Promise<Map<number, (string | undefined)[]>> {
	const layout = await layOut(buildDocx({ body }))
	const out = new Map<number, (string | undefined)[]>()

	layout.styleInfo.forEach(info => {
		const size = info.run?.size

		if (size === undefined) return

		const list = out.get(size) ?? []

		if (!list.includes(info.color)) list.push(info.color)

		out.set(size, list)
	})

	return out
}

describe("automatic text colour over fills", () => {
	it("turns white over dark run, paragraph, cell and table fills, and stays automatic elsewhere", async () => {
		const body =
			para(run(50)) +
			para(run(22), shd("1F3864")) +
			para(run(24), shd("FFF2CC")) +
			para(
				run(26, '<w:highlight w:val="darkBlue"/>') + run(28, shd("000000")) + run(30, '<w:color w:val="FF0000"/>'),
				shd("FFFFFF")
			) +
			// A light highlight over a dark paragraph: the highlight is what lies behind the text.
			para(run(32, '<w:highlight w:val="yellow"/>'), shd("000000")) +
			table("", [
				{ tcPr: shd("203864"), body: para(run(34)) },
				{ tcPr: "", body: para(run(36)) }
			]) +
			table(shd("404040"), [
				{ tcPr: "", body: para(run(38)) },
				{ tcPr: shd("DDDDDD"), body: para(run(40)) }
			]) +
			// A paragraph inside a cell: its own (light) shading wins over the dark cell.
			table("", [{ tcPr: shd("000000"), body: para(run(42), shd("FFFFFF")) + para(run(44)) }]) +
			// A nested table without fill shows the outer cell's dark fill.
			table("", [{ tcPr: shd("000000"), body: table("", [{ tcPr: "", body: para(run(46)) }]) + para(run(48)) }])
		const found = await colors(body)

		expect(found.get(50)).toEqual([undefined])
		expect(found.get(22)).toEqual(["FFFFFF"])
		expect(found.get(24)).toEqual([undefined])
		expect(found.get(26)).toEqual(["FFFFFF"])
		expect(found.get(28)).toEqual(["FFFFFF"])
		expect(found.get(30)).toEqual(["FF0000"])
		expect(found.get(32)).toEqual([undefined])
		expect(found.get(34)).toEqual(["FFFFFF"])
		expect(found.get(36)).toEqual([undefined])
		expect(found.get(38)).toEqual(["FFFFFF"])
		expect(found.get(40)).toEqual([undefined])
		expect(found.get(42)).toEqual([undefined])
		expect(found.get(44)).toEqual(["FFFFFF"])
		expect(found.get(46)).toEqual(["FFFFFF"])
		expect(found.get(48)).toEqual(["FFFFFF"])
	})

	it("draws an automatic underline in the resolved colour", async () => {
		const layout = await layOut(buildDocx({ body: para(run(22, '<w:u w:val="single"/>'), shd("000000")) }))
		const underlines = layout.decorations.filter(value => value.kind === "underline")

		expect(underlines).toEqual([{ kind: "underline", style: "single", color: "FFFFFF" }])
	})
})
