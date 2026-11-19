import { unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { SHEET_MAX_ROWS } from "../core/sheet/protocol"
import { borderPresetEdges } from "../core/sheet/style/borders"
import { buildFixture, openFixture } from "./sheetSessionFixtures"
import { budget, cpuMs } from "./timing"
import { STYLES } from "./xlsxWriteFixtures"

// Download as CSV covers the data area, as LibreOffice's CSV export does (measured, 26.8): from A1 to the last row
// and column holding a value or a formula, each row as wide as that area. Cells holding only a format are not data.

async function csvOf(
	body: string,
	edit?: (sheet: number) => Parameters<Awaited<ReturnType<typeof openFixture>>["session"]["command"]>[0]
): Promise<string> {
	const { session, info } = await openFixture({ sheets: [{ name: "One", body }], styles: STYLES })
	const sheet = info.activeSheet

	if (edit !== undefined) {
		const result = await session.command(edit(sheet))

		expect(result.ok).toBe(true)
	}

	const csv = await session.export("csv", { sheet })

	session.close()

	return csv.ok ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(csv.bytes) : ""
}

describe("Download as CSV", () => {
	it("stops at the data area when a whole column's border styles cells down to the last row", async () => {
		const csv = await csvOf(
			'<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row><row r="3"><c r="A3"><v>3</v></c></row>' +
				'<row r="5" s="1" customFormat="1"/></sheetData>',
			sheet => ({
				type: "format.borders",
				sheet,
				ranges: [{ startRow: 0, startCol: 1, endRow: SHEET_MAX_ROWS - 1, endCol: 1 }],
				edges: borderPresetEdges("outside")
			})
		)

		expect(csv).toBe("﻿1,2\r\n,\r\n3,\r\n")
	})

	it("starts at A1 and makes every row as wide as the data area", async () => {
		const csv = await csvOf(
			'<sheetData><row r="3"><c r="C3" t="inlineStr"><is><t>x</t></is></c><c r="E3" s="1"/></row>' +
				'<row r="4"><c r="B4" t="inlineStr"><is><t>y</t></is></c></row><row r="9"><c r="A9" s="1"/></row></sheetData>'
		)

		expect(csv).toBe("﻿,,\r\n,,\r\n,,x\r\n,y,\r\n")
	})

	it("counts a formula whose result is empty as data", async () => {
		const csv = await csvOf('<sheetData><row r="2"><c r="B2" t="str"><f>""</f><v></v></c></row></sheetData>')

		expect(csv).toBe("﻿,\r\n,\r\n")
	})
})

describe("Download as CSV of a sparse sheet", () => {
	// Before the 328 MB export below: maxRSS is the process high-water mark, so after that export this growth reads 0.
	it("refuses, before allocating it, a CSV past the size a browser download holds", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: `<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="XFD1"><v>2</v></c></row><row r="${String(SHEET_MAX_ROWS)}"><c r="A${String(SHEET_MAX_ROWS)}"><v>3</v></c></row></sheetData>`
				}
			]
		})
		const peak = process.resourceUsage().maxRSS * 1024
		const cpu = cpuMs()
		const csv = await session.export("csv", { sheet: info.activeSheet })
		const used = cpuMs() - cpu

		session.close()

		// 17 GB of commas, refused from its known size alone.
		expect(csv).toEqual({ ok: false, refusal: { reason: "tooLarge", detail: "csv" } })
		expect(process.resourceUsage().maxRSS * 1024 - peak).toBeLessThan(64 * 1024 * 1024)
		expect(used).toBeLessThan(budget(500))
	})

	it("writes the whole data area row by row, a far column and a far row included", async () => {
		const rows = 20_000
		const { session, info, bytes } = await openFixture({
			sheets: [
				{
					name: "One",
					body: `<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="XFD1"><v>2</v></c></row><row r="${String(rows)}"><c r="A${String(rows)}"><v>3</v></c></row></sheetData>`
				}
			]
		})

		expect(bytes.length).toBeLessThan(4096)

		const peak = process.resourceUsage().maxRSS * 1024
		const cpu = process.cpuUsage()
		const csv = await session.export("csv", { sheet: info.activeSheet })
		const used = process.cpuUsage(cpu)

		session.close()

		if (!csv.ok) throw new Error(csv.refusal.reason)

		// Memory near the output's own size (328 MB here), never a row × column array of it.
		expect(process.resourceUsage().maxRSS * 1024 - peak).toBeLessThan(2 * csv.bytes.length)
		expect((used.user + used.system) / 1000).toBeLessThan(budget(3_000))

		const width = 16_384
		const line = width - 1 + 2

		// Every row as wide as the data area, and the three values' digits.
		expect(csv.bytes.length).toBe(3 + rows * line + 3)

		const decoder = new TextDecoder("utf-8", { ignoreBOM: true })

		expect(decoder.decode(csv.bytes.subarray(0, 3 + line + 2))).toBe(`\ufeff1${",".repeat(width - 1)}2\r\n`)
		expect(decoder.decode(csv.bytes.subarray(3 + line + 2, 3 + 2 * line + 2))).toBe(`${",".repeat(width - 1)}\r\n`)
		expect(decoder.decode(csv.bytes.subarray(csv.bytes.length - line - 1))).toBe(`3${",".repeat(width - 1)}\r\n`)
	})

	it("of a sheet whose part is missing is refused, never left unanswered", async () => {
		const files = unzipSync(
			buildFixture({
				sheets: [{ name: "One", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' }, { name: "Two" }]
			})
		)

		delete files["xl/worksheets/sheet2.xml"]

		const { session, info } = await openFixture(zipSync(files))
		const two = info.sheets.find(sheet => sheet.name === "Two")

		if (two === undefined) throw new Error("no sheet Two")

		expect(await session.export("csv", { sheet: two.id })).toEqual({
			ok: false,
			refusal: { reason: "unsupported", detail: "unreadable" }
		})
		expect((await session.export("csv", { sheet: info.activeSheet })).ok).toBe(true)
		session.close()
	})

	it("quotes a value holding a separator the next open would weigh", async () => {
		const csv = await csvOf(
			'<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a;b</t></is></c><c r="B1" t="inlineStr"><is><t>"q", r</t></is></c><c r="C1" t="inlineStr"><is><t>ü😀</t></is></c></row></sheetData>'
		)

		expect(csv).toBe('﻿"a;b","""q"", r",ü😀\r\n')
	})
})
