import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { emitPptx } from "../core/pptx/write/emit"
import { presentationTextServices, viewCapability } from "../dom/presentation/engine/view"
import { installPresentationRealm } from "../dom/presentation/services"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"
import { editHarness } from "./presentationEditFixtures"
import { buildPptx, para } from "./pptxFixtures"

// Rows grow to their cells' text; a vertically merged cell grows the last row it spans by what the spanned rows lack
// (PowerPoint; LibreOffice 7.5 draws the same), so its text never runs below the table.

const FOUR = ["One", "Two", "Three", "Four"].map(word => para(word)).join("")

function cell(content: string, attributes = ""): string {
	return `<a:tc${attributes}><a:txBody><a:bodyPr/><a:lstStyle/>${content}</a:txBody><a:tcPr/></a:tc>`
}

// Two rows of two cells; the first column's two cells one vertical merge holding four paragraphs, or (merged false)
// the four paragraphs in the first row's own cell.
function deck(merged: boolean): Uint8Array {
	const rows = merged
		? `<a:tr h="400">${cell(FOUR, ' rowSpan="2"')}${cell(para("B1"))}</a:tr><a:tr h="400">${cell('<a:p><a:endParaRPr lang="en-GB"/></a:p>', ' vMerge="1"')}${cell(para("B2"))}</a:tr>`
		: `<a:tr h="400">${cell(FOUR)}${cell(para("B1"))}</a:tr><a:tr h="400">${cell(para("A2"))}${cell(para("B2"))}</a:tr>`
	const frame =
		'<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table 3"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>' +
		'<p:xfrm><a:off x="100" y="200"/><a:ext cx="2000000" cy="800"/></p:xfrm>' +
		'<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/>' +
		`<a:tblGrid><a:gridCol w="1000000"/><a:gridCol w="1000000"/></a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`

	return buildPptx({ slides: [{ shapes: frame }] })
}

async function rowEdges(merged: boolean): Promise<readonly number[]> {
	const h = await editHarness(deck(merged), { emit: emitPptx } as never, { text: presentationTextServices })
	const [render] = await viewCapability.render(h.context, [h.session.deck.slides[0] as never])
	const edges = render?.layers.find(layer => layer.table !== undefined)?.table?.rowEdges

	if (edges === undefined) throw new Error("no table")

	return edges
}

beforeAll(() => {
	installPresentationRealm({
		text: {
			fontHost: nodeFontHost,
			replayFonts: true,
			fontAssets: nodeFontAssets,
			measurer: new HmtxMeasurer(),
			yield: () => Promise.resolve()
		},
		canvas: {
			canvas: () => undefined,
			decode: () => Promise.resolve(undefined),
			copy: () => Promise.resolve(undefined),
			fontsReady: () => Promise.resolve()
		}
	})
})

afterAll(() => {
	installPresentationRealm(undefined)
})

describe("table rows", () => {
	it("grows the last row a vertical merge spans by what its text needs beyond the spanned rows", async () => {
		const merged = await rowEdges(true)
		const single = await rowEdges(false)
		const [top = 0, firstEnd = 0, end = 0] = merged
		// The four paragraphs in one row: the height they need with the cell's margins.
		const needed = (single[1] ?? 0) - (single[0] ?? 0)
		// One line (B1, B2): the height a row of one-line cells has.
		const line = (single[2] ?? 0) - (single[1] ?? 0)

		expect(needed).toBeGreaterThan(2 * line)
		expect(firstEnd - top).toBeCloseTo(line, 3)
		expect(end - top).toBeCloseTo(needed, 3)
	})
})
