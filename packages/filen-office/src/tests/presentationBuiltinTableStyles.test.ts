import { describe, expect, it } from "vitest"
import { ItemFloat, ItemInt, ItemKind, rgbaAlpha, rgbaHex } from "../core/drawingml/displayList"
import type { DrawingData } from "../core/drawingml/data"
import { D, drawingReader } from "../core/drawingml/reader"
import { renderSlide } from "../core/presentation/render/slide"
import { builtinTableStyleFamily, builtinTableStyleXml } from "../core/presentation/render/tableStyles"
import { builtinTableStylesPart } from "../core/pptx/write/emit/table"
import { encodeUtf8, parseXml } from "../core/xml/index"
import type { Slicing } from "../core/slicing"
import { NS, SLIDE, THEME, THEME_PART, body, deckOf, renderServices, xfrm } from "./fixtures/presentation/renderDeck"
import { freshFromPptx } from "./odpWriteFreshFixtures"
import { buildPptx } from "./pptxFixtures"

// PowerPoint applies its built-in table styles by id alone (a:tableStyleId); a deck from another generator may name one
// without writing its definition into the tableStyles part. Each family's definition is the markup PowerPoint writes.

const EMU = 9525
const SLICING: Slicing = { pause: () => Promise.resolve(), sliceMs: 8, now: () => 0 }

// The fixture theme's accents.
const ACCENT = { 1: "4472C4", 2: "ED7D31", 3: "A5A5A5", 4: "FFC000", 5: "5B9BD5", 6: "70AD47" } as const

// A 2 × 3 table (header row, two body rows, banded rows) naming `styleId`, rendered with a tableStyles part that does
// not define it: each distinct solid fill as "y:RRGGBB" in drawing order (rows 20 px tall), plus its alpha.
async function fills(styleId: string): Promise<{ readonly at: string; readonly alpha: number }[]> {
	const fixture = renderServices(
		{ parts: { [THEME_PART]: THEME, "/ppt/tableStyles.xml": `<a:tblStyleLst ${NS} def="{NONE}"/>` } },
		{ textHeight: 0 }
	)
	const row = (h: number, a: string, b: string) => ({ h: h * EMU, cells: [{ text: body(a) }, { text: body(b) }] })
	const deck = deckOf(
		[],
		[],
		[
			{
				id: 5,
				name: "Table",
				hidden: false,
				kind: "frame",
				xfrm: xfrm(0, 0, 200 * EMU, 60 * EMU),
				frame: {
					kind: "table",
					table: {
						grid: [100 * EMU, 100 * EMU],
						rows: [row(20, "A", "B"), row(20, "1", "2"), row(20, "3", "4")],
						styleId,
						flags: { firstRow: true, lastRow: false, firstCol: false, lastCol: false, bandRow: true, bandCol: false }
					}
				}
			}
		]
	)
	const render = await renderSlide(deck, SLIDE, fixture.services, SLICING)
	const data = render.layers[0]?.drawing as DrawingData
	const out: { at: string; alpha: number }[] = []

	for (let item = 0; item < data.itemCount; item++) {
		if (data.itemInts[item * 10 + ItemInt.KIND] !== ItemKind.PATH) continue

		const paint = data.paints[data.itemInts[item * 10 + ItemInt.FILL] ?? -1]

		if (paint?.kind !== "solid") continue

		const at = `${String(data.itemFloats[item * 10 + ItemFloat.Y])}:${rgbaHex(paint.color)}`

		if (!out.some(fill => fill.at === at)) out.push({ at, alpha: rgbaAlpha(paint.color) })
	}

	return out
}

describe("built-in table style families", () => {
	it("Light Style 1 - Accent 3: no header fill, the first band in accent3 at 20% alpha", async () => {
		const drawn = await fills("{C083E6E3-FA7D-4D7B-A595-EF9225AFEA82}")

		expect(drawn.map(fill => fill.at)).toEqual([`20:${ACCENT[3]}`])
		expect(drawn[0]?.alpha).toBeCloseTo(0.2, 2)
	})

	it("Light Style 2 - Accent 1: the header's fill is the theme's first fill style in accent1 (a tcStyle fillRef)", async () => {
		const drawn = await fills("{69012ECD-51FC-41F1-AA8D-1B2483CD663E}")

		expect(drawn.map(fill => fill.at)).toEqual([`0:${ACCENT[1]}`])
	})

	it("Medium Style 1 - Accent 4: an lt1 table, the header in accent4, the first band tinted", async () => {
		const drawn = (await fills("{1E171933-4619-4E11-9A3F-F7608DF75F80}")).map(fill => fill.at)

		expect(drawn).toContain(`0:${ACCENT[4]}`)
		expect(drawn).toContain("40:FFFFFF")
		expect(drawn.find(fill => fill.startsWith("20:"))).not.toBe("20:FFFFFF")
	})

	it("Medium Style 4 (no accent): every cell filled with a tint of dk1", async () => {
		const drawn = (await fills("{D7AC3CCA-C797-4891-BE02-D94E43425B78}")).map(fill => fill.at)

		for (const y of [0, 20, 40])
			expect(drawn.some(fill => fill.startsWith(`${String(y)}:`) && !/:(000000|FFFFFF)$/u.test(fill))).toBe(true)
	})

	it("Themed Style 1 - Accent 6: the header solid accent6 over the table background", async () => {
		const drawn = (await fills("{08FB837D-C827-4EFA-A057-4D05807E0F7C}")).map(fill => fill.at)

		expect(drawn).toContain(`0:${ACCENT[6]}`)
	})

	it("names each id's family and writes its definition with PowerPoint's style name", () => {
		const cases: readonly (readonly [string, string, string])[] = [
			["{2D5ABB26-0587-4C30-8999-92F81FD0307C}", "No Style, No Grid", "No Style, No Grid"],
			["{5940675A-B579-460E-94D1-54222C63F5DA}", "No Style, Table Grid", "No Style, Table Grid"],
			["{9D7B26C5-4107-4FEC-AEDC-1716B250A1EF}", "Light Style 1", "Light Style 1"],
			["{68D230F3-CF80-4859-8CE7-A43EE81993B5}", "Light Style 1", "Light Style 1 - Accent 6"],
			["{5A111915-BE36-4E01-A7E5-04B1672EAD32}", "Light Style 2", "Light Style 2 - Accent 5"],
			["{793D81CF-94F2-401A-BA57-92F5A7B2D0C5}", "Medium Style 1", "Medium Style 1"],
			["{10A1B5D5-9B99-4C35-A422-299274C87663}", "Medium Style 1", "Medium Style 1 - Accent 6"],
			["{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}", "Medium Style 2", "Medium Style 2"],
			["{93296810-A885-4BE3-A3E7-6D5BEEA58F35}", "Medium Style 2", "Medium Style 2 - Accent 6"],
			["{69CF1AB2-1976-4502-BF36-3FF5EA218861}", "Medium Style 4", "Medium Style 4 - Accent 1"],
			["{3C2FFA5D-87B4-456A-9821-1D502468CF0F}", "Themed Style 1", "Themed Style 1 - Accent 1"]
		]

		for (const [id, family, name] of cases) {
			expect(builtinTableStyleFamily(id)).toBe(family)

			const part = builtinTableStylesPart([id]) ?? ""
			const document = parseXml(encodeUtf8(part))
			const reader = drawingReader(document)
			const styles = [...reader.children(document.documentElement(), D.A, "tblStyle")]

			expect(styles.map(style => [reader.attr(style, "styleId"), reader.attr(style, "styleName")])).toEqual([[id, name]])
		}

		// Light Style 1's plain variant draws in tx1, Medium Style 1's in dk1 (as PowerPoint writes them).
		expect(builtinTableStyleXml("{9D7B26C5-4107-4FEC-AEDC-1716B250A1EF}")).not.toMatch(/accent|dk1/u)
		expect(builtinTableStyleXml("{793D81CF-94F2-401A-BA57-92F5A7B2D0C5}")).not.toMatch(/accent|tx1/u)
		// Families PowerPoint's own markup is not at hand for stay unknown.
		for (const id of [
			"{7E9639D4-E3E2-4D34-9284-5A2195B3D0D7}",
			"{D113A9D2-9D6B-4929-AA2D-F23B5EE8CBE7}",
			"{E8034E78-7F5D-4C2E-B375-FC64B27BC917}"
		])
			expect(builtinTableStyleFamily(id)).toBeUndefined()
	})
})

describe("built-in table styles converted to ODP", () => {
	function tableDeck(styleId: string): Uint8Array {
		const cell = "<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Cell</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>"

		return buildPptx({
			slides: [
				{
					shapes:
						'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
						'<p:xfrm><a:off x="100000" y="100000"/><a:ext cx="2000000" cy="400000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
						`<a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>${styleId}</a:tableStyleId></a:tblPr><a:tblGrid><a:gridCol w="2000000"/></a:tblGrid>` +
						`<a:tr h="400000">${cell}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
				}
			]
		})
	}

	it("writes only Medium Style 2 as its look; another known family is reported approximated", async () => {
		const medium2 = await freshFromPptx(tableDeck("{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"))
		const medium4 = await freshFromPptx(tableDeck("{8A107856-5554-42FB-B03E-39F5DBC370BA}"))

		if ("kind" in medium2 || "kind" in medium4) throw new Error("refused")

		expect(medium2.report.approximated["table style"]).toBeUndefined()
		expect(medium4.report.approximated["table style"]).toBe(1)
	})
})
