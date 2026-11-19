import { describe, expect, it } from "vitest"
import { pageLines } from "./layoutFixtures"
import { odtBytes, odtLayout } from "./odtFixtures"

// Expected baseline distances are LibreOffice 7.5's PDF export of the same documents, in twips (10 pt lines: 230).
const STYLES =
	'<style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-top="0in" fo:margin-bottom="0in"/><style:text-properties fo:font-family="&apos;Liberation Sans&apos;" fo:font-size="10pt"/></style:default-style>'
const THICK = 'fo:border="0.05in solid #000000"'

async function pitches(model: string | undefined, cell: string): Promise<number[]> {
	const rows = Array.from(
		{ length: 4 },
		(_, index) =>
			`<table:table-row><table:table-cell table:style-name="C"><text:p>row${index}</text:p></table:table-cell></table:table-row>`
	).join("")
	const { layout } = await odtLayout(
		odtBytes({
			styles: STYLES,
			automatic: `<style:style style:name="Tb" style:family="table"><style:table-properties style:width="6in" table:align="left"${model === undefined ? "" : ` table:border-model="${model}"`}/></style:style><style:style style:name="C" style:family="table-cell"><style:table-cell-properties fo:padding="0in" ${cell}/></style:style>`,
			body: `<text:p>before</text:p><table:table table:name="T" table:style-name="Tb"><table:table-column/>${rows}</table:table><text:p>after</text:p>`
		})
	)
	const page = layout.pages[0]
	const baselines = pageLines(layout, 0).map((_, index) => (page?.text.lineFloats[index * 5 + 2] ?? 0) * 15)

	return baselines.slice(1).map((baseline, index) => Math.round(baseline - (baselines[index] ?? 0)))
}

describe("the borders of an ODT table's cells", () => {
	it.each([
		["collapsing, a thin border once between rows", "collapsing", 'fo:border="0.0069in solid #000000"', [240, 240, 240, 240, 240]],
		["collapsing, a thick border once between rows", "collapsing", THICK, [302, 302, 302, 302, 302]],
		["separating, each cell's own top and bottom", "separating", THICK, [302, 374, 374, 374, 302]],
		["with no border model, as separating", undefined, THICK, [302, 374, 374, 374, 302]],
		[
			"collapsing, only tops",
			"collapsing",
			'fo:border-top="0.05in solid #000000" fo:border-bottom="none" fo:border-left="none" fo:border-right="none"',
			[302, 302, 302, 302, 230]
		],
		[
			"collapsing, only bottoms",
			"collapsing",
			'fo:border-bottom="0.05in solid #000000" fo:border-top="none" fo:border-left="none" fo:border-right="none"',
			[230, 302, 302, 302, 302]
		]
	])("take room in the row: %s", async (_, model, cell, expected) => {
		const actual = await pitches(model, cell)
		expect(actual, actual.join(",")).toHaveLength(expected.length)

		actual.forEach((value, index) =>
			expect(Math.abs(value - (expected[index] ?? 0)), `${index}: ${actual.join(",")}`).toBeLessThanOrEqual(2)
		)
	})
})
