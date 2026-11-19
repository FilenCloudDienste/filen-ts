import { describe, expect, it } from "vitest"
import { planRefEdit } from "../core/xlsx/refs/index"
import { saveXlsx } from "../core/xlsx/write/save"
import { buildFixture, openWorkbook } from "./xlsxWriteFixtures"
import { slicedRun } from "./slicedRun"
import { budget } from "./timing"

// A save after a column insert on a million cells, on an in-thread host: every row spliced and checked (the store
// and the rows read back) in slices, so the thread is never held over 50 ms of its CPU time.

const ROWS = 100_000

function body(): string {
	let data = "<sheetData>"

	for (let r = 1; r <= ROWS; r++) {
		data += `<row r="${r}" spans="1:10">`

		for (let c = 0; c < 10; c++) data += `<c r="${String.fromCharCode(65 + c)}${r}"><v>${(r * 10 + c) / 7}</v></c>`

		data += "</row>"
	}

	return `${data}</sheetData>`
}

describe("a sliced save after a column insert", () => {
	it("gives the host a turn at least every 50 ms on 100,000 rows of 10 cells", { timeout: 300_000 }, async () => {
		const workbook = await openWorkbook(buildFixture({ sheets: [{ name: "Data", body: body() }] }))

		await workbook.load(0)

		const planned = await planRefEdit(workbook, { kind: "axis", sheet: 0, shift: { type: "insert", axis: "cols", at: 0, count: 1 } })

		if (!planned.ok) throw new Error(JSON.stringify(planned.refusal))

		planned.plan.apply()

		const { result, longest, turns, wall, cpu } = await slicedRun(slicing => saveXlsx({ opc: workbook.opc, workbook }, { slicing }))

		expect(result.ok, JSON.stringify(result)).toBe(true)
		console.log(
			`sliced column-insert save, ${ROWS} rows: ${wall.toFixed(0)} ms wall, ${cpu.toFixed(0)} ms CPU, ${turns} turns, longest task ${longest.toFixed(1)} ms, ${JSON.stringify(result.ok ? result.timings : null)}`
		)
		expect(longest).toBeLessThan(budget(50))
	})
})
