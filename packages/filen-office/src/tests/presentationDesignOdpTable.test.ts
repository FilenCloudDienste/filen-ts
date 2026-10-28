import { describe, expect, it } from "vitest"
import type { Xfrm } from "../core/presentation/model"
import { odpBytes } from "./odpFixtures"
import { driveSession } from "./odpWriteDrive"
import { entriesOf, openOdpDeck, shapeNamed, slideAt, text } from "./odpWriteFixtures"

// A table frame as LibreOffice writes it carries a replacement image after its table:table (ODF 1.3 Part 3 §10.4.3,
// the frame's alternatives). A scaled slide size change rewrites the table (its columns and rows scale) inside the
// frame the shape writer patches; the frame's other children are kept as they are, a hairline cell border keeps its
// width to the EMU, and the size change saves.

const TABLE =
	'<draw:frame draw:name="Table" svg:x="2cm" svg:y="4cm" svg:width="12cm" svg:height="2cm">' +
	'<table:table table:template-name="default"><table:table-column table:style-name="co1" table:number-columns-repeated="2"/>' +
	'<table:table-row table:style-name="ro1"><table:table-cell table:style-name="ce1"><text:p>A1</text:p></table:table-cell><table:table-cell><text:p>B1</text:p></table:table-cell></table:table-row>' +
	"</table:table>" +
	'<draw:image xlink:href="Pictures/TablePreview1.svm" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>' +
	"</draw:frame>"

const AUTOMATIC =
	'<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="6cm"/></style:style>' +
	'<style:style style:name="ro1" style:family="table-row"><style:table-row-properties style:row-height="2cm"/></style:style>' +
	'<style:style style:name="ce1" style:family="table-cell"><style:paragraph-properties fo:border="0.001cm solid #ff3366"/></style:style>'

async function opened(bytes: Uint8Array): Promise<{ readonly size: { readonly cx: number; readonly cy: number }; readonly box: Xfrm }> {
	const deck = await openOdpDeck(bytes)
	const box = shapeNamed(slideAt(deck, 0), "Table").xfrm

	if (box === undefined) throw new Error("a table without a box")

	return { size: deck.deck.size, box }
}

describe("a scaled slide size change on an ODP table with a replacement image", () => {
	it("saves the scaled table and keeps the frame's replacement image", async () => {
		const source = odpBytes({ automatic: AUTOMATIC, body: `<draw:page draw:name="One" draw:master-page-name="M">${TABLE}</draw:page>` })
		const before = await opened(source)
		const d = await driveSession(source)

		expect((await d.command({ family: "design", kind: "setSize", cx: 9_144_000, cy: 6_858_000, scale: "ensureFit" })).ok).toBe(true)

		const saved = await d.save()

		expect(saved.result).toMatchObject({ kind: "written" })

		const bytes = saved.bytes as Uint8Array
		const content = text((await entriesOf(bytes)).get("content.xml"))

		expect(content).toContain('<draw:image xlink:href="Pictures/TablePreview1.svm"')
		expect(content).toContain('fo:border-top="0.001cm solid #ff3366"')
		// A table-cell style takes its table-cell properties first (ODF 1.3 Part 3 §16.2, the table-cell family's content).
		for (const style of content.match(/<style:style [^>]*style:family="table-cell"[^>]*>.*?<\/style:style>/gu) ?? [])
			expect(style).not.toMatch(/<style:(paragraph|text)-properties\b.*<style:table-cell-properties/u)

		const after = await opened(bytes)
		const s = Math.min(9_144_000 / before.size.cx, 6_858_000 / before.size.cy)

		expect(s).not.toBe(1)
		expect(after.size).toMatchObject({ cx: 9_144_000, cy: 6_858_000 })
		expect(Math.abs(after.box.cx - before.box.cx * s)).toBeLessThan(400)
		expect(Math.abs(after.box.cy - before.box.cy * s)).toBeLessThan(400)
		expect(Math.abs(after.box.x - (before.box.x * s + (9_144_000 - before.size.cx * s) / 2))).toBeLessThan(400)
		expect(Math.abs(after.box.y - (before.box.y * s + (6_858_000 - before.size.cy * s) / 2))).toBeLessThan(400)
	})
})
