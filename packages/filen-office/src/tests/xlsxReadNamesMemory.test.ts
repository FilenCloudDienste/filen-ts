import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { openXlsx } from "../core/xlsx/read/index"
import { liveHeap } from "./liveHeap"
import { buildWorkbook } from "./xlsxReadFixtures"

// A workbook of 100,000 defined names (about 6 MB of definedNames markup), opened: it retains the section's one
// copy, each name's element as offsets into it, and the decoded names and formulas, about 26 MB. A copy (51 MB) or
// a view (33 MB) of each name's element fails.

const NAMES = 100_000

describe("xlsx defined names memory", () => {
	it("retains one copy of 100,000 defined names", { timeout: 120_000 }, async () => {
		const names = Array.from(
			{ length: NAMES },
			(_, k) => `<definedName name="Range_${String(k)}" hidden="1">Sheet1!$A$${String(k + 1)}:$C$${String(k + 2)}</definedName>`
		).join("")
		const file = buildWorkbook({ sheets: [{ body: "<sheetData/>" }], workbookTail: `<definedNames>${names}</definedNames>` })
		const before = await liveHeap()
		const opened = await openXlsx(bytesSource(file))

		if (!opened.ok) throw new Error(opened.message)

		const retained = (await liveHeap()) - before
		const definedNames = opened.workbook.definedNames

		console.log(`xlsxReadNamesMemory: ${String(definedNames.length)} names, ${(retained / 1e6).toFixed(1)} MB retained`)
		expect(definedNames.length).toBe(NAMES)
		expect(definedNames[NAMES - 1]?.formula).toBe(`Sheet1!$A$${String(NAMES)}:$C$${String(NAMES + 1)}`)
		expect(retained).toBeLessThan(31e6)
	})
})
