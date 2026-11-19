import { describe, expect, it } from "vitest"
import { planRefEdit } from "../core/xlsx/refs/index"
import { saveXlsx } from "../core/xlsx/write/save"
import { buildFixture, openWorkbook } from "./xlsxWriteFixtures"
import { slicedRun } from "./slicedRun"
import { budget } from "./timing"

// A save after a structure edit on a large sheet, on an in-thread host: written and checked in slices, so the
// thread is never held over 50 ms of its CPU time, and its cost (wall and this thread's CPU time) is logged.

const ROWS = 100_000

function body(): string {
	let data = "<sheetData>"

	for (let r = 1; r <= ROWS; r++) {
		data += `<row r="${r}"><c r="A${r}"><v>${r}</v></c><c r="B${r}"><v>${r * 2}</v></c><c r="C${r}"><f>A${r}+B${r}</f><v>0</v></c>`
		data +=
			r === 1
				? `<c r="D1"><f t="shared" ref="D1:D${ROWS}" si="0">C1*2</f><v>0</v></c>`
				: `<c r="D${r}"><f t="shared" si="0"/><v>0</v></c>`
		data += "</row>"
	}

	return `${data}</sheetData>`
}

describe("a sliced save", () => {
	it("gives the host a turn at least every 50 ms after a structure edit on 100,000 rows of formulas", { timeout: 300_000 }, async () => {
		const workbook = await openWorkbook(buildFixture({ sheets: [{ name: "Data", body: body() }] }))

		await workbook.load(0)

		const planned = await planRefEdit(workbook, {
			kind: "axis",
			sheet: 0,
			shift: { type: "insert", axis: "rows", at: 1, count: 1 }
		})

		if (!planned.ok) throw new Error(JSON.stringify(planned.refusal))

		planned.plan.apply()

		const { result, longest, turns, wall, cpu } = await slicedRun(slicing => saveXlsx({ opc: workbook.opc, workbook }, { slicing }))

		expect(result.ok, JSON.stringify(result)).toBe(true)
		console.log(
			`sliced save, ${ROWS} rows: ${wall.toFixed(0)} ms wall, ${cpu.toFixed(0)} ms CPU, ${turns} turns, longest task ${longest.toFixed(1)} ms, ${JSON.stringify(result.ok ? result.timings : null)}`
		)
		expect(longest).toBeLessThan(budget(50))
	})
})
