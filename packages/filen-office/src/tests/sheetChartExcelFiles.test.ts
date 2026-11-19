import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { SheetSessionApi } from "../core/sheet/protocol"
import { CORPUS_DIR } from "./corpusDir"
import { changeOf, settle } from "./sheetNotesFixtures"
import { openCharts, partText } from "./sheetChartFixtures"

// Charts as Excel wrote them, in corpus workbooks: a pivot chart drawn and kept from its own caches, and a layout
// edit that leaves every chart's bytes as they were. Each skips while its file is not fetched.

const PIVOT = join(CORPUS_DIR, "xlsx", "oxsdk__OlapPivotA3.xlsx")
const MANY = join(CORPUS_DIR, "xlsm", "govuk__AllGB.xlsm")

// Each worksheet's chart frames, as the drawings feature lists them.
async function chartFrames(session: SheetSessionApi, sheets: readonly number[]): Promise<{ sheet: number; part: string }[]> {
	const out: { sheet: number; part: string }[] = []

	for (const sheet of sheets) {
		await session.layout(sheet)
		await settle()

		for (const object of (await session.layout(sheet)).extensions?.drawings?.objects ?? [])
			if (object.chartPart !== undefined) out.push({ sheet, part: object.chartPart })
	}

	return out
}

describe("charts Excel wrote", () => {
	it.skipIf(!existsSync(PIVOT))(
		"draws a pivot chart from its own caches, without the table's grand total, and saves it as it was",
		{ timeout: 60_000 },
		async () => {
			const source = new Uint8Array(readFileSync(PIVOT))
			const { session, sheets } = await openCharts(source)
			const frame = (await chartFrames(session, sheets))[0]

			if (frame === undefined) throw new Error("no chart")

			const drawn = await session.query("chart.render", { part: frame.part, width: 4_572_000, height: 2_743_200 })

			expect(drawn.kind).toBe("drawing")
			expect(drawn.kind === "drawing" ? JSON.stringify(drawn.drawing.texts) : "").not.toContain("Grand Total")
			changeOf(
				await session.command({ type: "axis.hide", sheet: frame.sheet, axis: "rows", spans: [{ start: 3, end: 3 }], hidden: true })
			)

			const saved = await session.save()

			if (!saved.ok) throw new Error(saved.message)

			expect(partText(saved.bytes, frame.part)).toBe(partText(source, frame.part))
			session.close()
		}
	)

	it.skipIf(!existsSync(MANY))(
		"rewrites none of a workbook's charts when a column of their sheet is resized",
		{ timeout: 120_000 },
		async () => {
			const { session, sheets } = await openCharts(new Uint8Array(readFileSync(MANY)))
			const frame = (await chartFrames(session, sheets))[0]

			if (frame === undefined) throw new Error("no chart")

			changeOf(
				await session.command({
					type: "axis.resize",
					sheet: frame.sheet,
					axis: "cols",
					indices: Uint32Array.of(30),
					sizes: Float32Array.of(90)
				})
			)

			const saved = await session.save()

			if (!saved.ok) throw new Error(saved.message)

			expect(saved.changedParts.filter(part => part.includes("/charts/"))).toEqual([])
			session.close()
		}
	)
})
