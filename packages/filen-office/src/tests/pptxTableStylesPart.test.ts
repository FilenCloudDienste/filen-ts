import { describe, expect, it } from "vitest"
import { builtinTableStyleIds, builtinTableStylesPart } from "../core/pptx/write/emit/table"
import { parseXml, encodeUtf8 } from "../core/xml/index"
import type { ShapeNode } from "../core/presentation/model"
import { emitPptx } from "../core/pptx/write/emit"
import { insertTableOp } from "../core/presentation/edit/commands/insert"
import type { DeckOp } from "../core/presentation/edit/ops"
import { editHarness } from "./presentationEditFixtures"
import { partsOf, saveEdits, text } from "./pptxWriteFixtures"
import { body, buildPptx, para, sp } from "./pptxFixtures"

// A deck without a tableStyles part whose saved tables name a built-in style gets one holding its definition, with
// PowerPoint's default as `def` (LibreOffice 7.5 draws no table style without the part); a style not built in adds
// nothing, and a deck with the part keeps it untouched.

const ACCENT1 = "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"
const ACCENT2 = "{21E4AEA4-8DFA-4A89-87EB-49C32662AFE0}"

function table(id: number, styleId: string | undefined): ShapeNode {
	return {
		id,
		name: "Table",
		hidden: false,
		kind: "graphicFrame",
		frame: { kind: "table", table: { grid: [1000], rows: [], flags: {}, ...(styleId === undefined ? {} : { styleId }) } }
	} as unknown as ShapeNode
}

describe("tableStyles part", () => {
	it("writes a part with the definitions a deck without one needs, PowerPoint's default as def", () => {
		const ids = builtinTableStyleIds([
			table(2, ACCENT2),
			{ ...table(3, undefined), children: [table(4, ACCENT2), table(5, "{NOT-BUILT-IN}")] } as ShapeNode
		])
		const xml = builtinTableStylesPart(ids)

		expect([...ids]).toEqual([ACCENT2])
		expect(xml).toContain(`def="${ACCENT1}"`)
		expect(xml).toContain(`styleId="${ACCENT2}"`)
		expect(() => parseXml(encodeUtf8(xml ?? ""))).not.toThrow()
	})

	it("saves an inserted table's built-in style into a new tableStyles part related from presentation.xml", async () => {
		const h = await editHarness(buildPptx({ slides: [{ shapes: sp(2, "Title 1", 'type="title"', "", body(para("Tables"))) }] }), {
			emit: emitPptx
		} as never)
		const deck = h.session.deck
		const inserted = await h.command(insertTableOp(deck, deck.slides[0] as never, 2, 2, 9) as DeckOp)

		expect(inserted.ok).toBe(true)

		const before = await partsOf(buildPptx({ slides: [{ shapes: "" }] }))
		const parts = await partsOf(await saveEdits(h, 1))
		const styles = text(parts.get("ppt/tableStyles.xml"))

		expect(before.has("ppt/tableStyles.xml")).toBe(false)
		expect(styles).toContain(`styleId="${ACCENT1}"`)
		expect(text(parts.get("ppt/_rels/presentation.xml.rels"))).toMatch(/relationships\/tableStyles" Target="tableStyles.xml"/u)
		expect(text(parts.get("[Content_Types].xml"))).toContain(
			'PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"'
		)
	})
})
