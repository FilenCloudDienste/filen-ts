import { describe, expect, it } from "vitest"
import { pageLines } from "./layoutFixtures"
import { odtBytes, odtLayout } from "./odtFixtures"

// Expected distances are LibreOffice 7.5's PDF export of the same documents, in twips (10 pt lines: 230).
const STYLES =
	'<style:default-style style:family="paragraph"><style:text-properties fo:font-family="&apos;Liberation Sans&apos;" fo:font-size="10pt"/></style:default-style><style:style style:name="Par" style:family="paragraph"><style:paragraph-properties fo:margin-top="0.5in" fo:margin-bottom="0.5in"/></style:style>'

async function baselines(properties: string): Promise<number[]> {
	const { layout } = await odtLayout(
		odtBytes({
			styles: STYLES,
			automatic: `<style:style style:name="Ch" style:family="paragraph" style:parent-style-name="Par"><style:paragraph-properties ${properties}/></style:style>`,
			body: '<text:p>top</text:p><text:p text:style-name="Ch">One</text:p><text:p text:style-name="Ch">Two</text:p><text:p>after</text:p>'
		})
	)
	const page = layout.pages[0]

	return pageLines(layout, 0).map((_, index) => (page?.text.lineFloats[index * 5 + 2] ?? 0) * 15)
}

describe("an ODT paragraph style's space above and below", () => {
	it.each([
		["space below alone leaves no space above", 'fo:margin-bottom="0in"', [230, 230, 230]],
		["space above alone leaves no space below", 'fo:margin-top="0.25in"', [590, 590, 230]],
		["neither inherits both", "", [950, 1670, 950]]
	])("are set together: %s", async (_, properties, expected) => {
		const all = await baselines(properties)
		const pitches = all.slice(1).map((value, index) => Math.round(value - (all[index] ?? 0)))
		expect(pitches, pitches.join(",")).toHaveLength(expected.length)

		pitches.forEach((value, index) => expect(Math.abs(value - (expected[index] ?? 0)), pitches.join(",")).toBeLessThanOrEqual(2))
	})
})
