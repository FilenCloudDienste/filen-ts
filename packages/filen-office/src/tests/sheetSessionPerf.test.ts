import { serialize } from "node:v8"
import { zipSync } from "fflate"
import { describe, expect, it } from "vitest"
import { encodeUtf8 } from "../core/xml/index"
import { openTextSession } from "../core/sheet/text"
import { inThreadSheetHost } from "../dom/sheet/host"
import { R, SML } from "./xlsxWriteFixtures"
import { ZIP_ENTRY_TIME } from "./zipTime"
import { budget } from "./timing"
import { changeOf } from "./sheetSessionFixtures"

// The session's budgets at 1M cells (100k rows by 10 columns, no formulas): a keystroke's commit at most 5 ms of
// CPU, an inserted row at most 150 ms with a change message of at most 64 KB, and an in-thread open that never
// runs 50 ms without yielding. Opt-in (FILEN_OFFICE_SHEET_PERF=1): the workbook is built in the test.

const PERF = process.env["FILEN_OFFICE_SHEET_PERF"] === "1"
const ROWS = 100_000
const COLS = 10

function bigWorkbook(): Uint8Array {
	const chunks: string[] = [
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${SML}" xmlns:r="${R}"><dimension ref="A1:J${ROWS}"/><sheetData>`
	]

	for (let row = 1; row <= ROWS; row++) {
		let markup = `<row r="${row}" spans="1:${COLS}">`

		for (let col = 0; col < COLS; col++) {
			const reference = `${String.fromCharCode(65 + col)}${row}`

			markup +=
				col === 0 ? `<c r="${reference}" t="s"><v>${row % 100}</v></c>` : `<c r="${reference}"><v>${(row * COLS + col) / 7}</v></c>`
		}

		chunks.push(`${markup}</row>`)
	}

	chunks.push("</sheetData></worksheet>")

	const strings = Array.from({ length: 100 }, (_, k) => `<si><t>text ${k}</t></si>`).join("")
	const declaration = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
	const packageRels = "http://schemas.openxmlformats.org/package/2006/relationships"

	return zipSync(
		{
			"[Content_Types].xml": encodeUtf8(
				`${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
					'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'
			),
			"_rels/.rels": encodeUtf8(
				`${declaration}<Relationships xmlns="${packageRels}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
			),
			"xl/workbook.xml": encodeUtf8(
				`${declaration}<workbook xmlns="${SML}" xmlns:r="${R}"><sheets><sheet name="Big" sheetId="1" r:id="rId1"/></sheets></workbook>`
			),
			"xl/_rels/workbook.xml.rels": encodeUtf8(
				`${declaration}<Relationships xmlns="${packageRels}"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`
			),
			"xl/sharedStrings.xml": encodeUtf8(`${declaration}<sst xmlns="${SML}" count="${ROWS}" uniqueCount="100">${strings}</sst>`),
			"xl/worksheets/sheet1.xml": encodeUtf8(chunks.join(""))
		},
		{ mtime: ZIP_ENTRY_TIME }
	)
}

// This thread's CPU time (the worker's, where a session runs), without the engine's helper threads.
function cpu(): number {
	const usage = (process as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage?.() ?? process.cpuUsage()

	return (usage.user + usage.system) / 1000
}

describe.skipIf(!PERF)("text session budget", () => {
	it("opens a 7 MB CSV within 0.2 s", async () => {
		const lines: string[] = []

		for (let row = 0; lines.join("").length < 7_000_000 && row < 1_000_000; row += 1000)
			for (let k = 0; k < 1000; k++)
				lines.push(`${row + k},item ${row + k},${((row + k) / 7).toFixed(4)},"a, b",2024-01-0${k % 9}\r\n`)

		const bytes = new TextEncoder().encode(lines.join(""))
		const before = cpu()
		const opened = await openTextSession(bytes, { kind: "csv" }, () => undefined)
		const ms = cpu() - before

		if (opened.kind !== "opened") throw new Error(opened.kind)

		process.stdout.write(`csv open ${(bytes.length / 1e6).toFixed(1)} MB: ${ms.toFixed(0)} ms\n`)
		expect(ms).toBeLessThanOrEqual(budget(200))
		opened.session.close()
	})

	it("commits a keystroke in a 1M-row CSV within 5 ms", { timeout: 120_000 }, async () => {
		const lines: string[] = []

		for (let row = 0; row < 1_000_000; row++) lines.push(`${row},b,c,d,e`)

		const opened = await openTextSession(new TextEncoder().encode(lines.join("\n")), { kind: "csv" }, () => undefined)

		if (opened.kind !== "opened") throw new Error(opened.kind)

		const times: number[] = []

		for (let i = 0; i < 21; i++) {
			const before = cpu()

			changeOf(
				await opened.session.command({
					type: "cells.set",
					sheet: 0,
					cells: { rows: Uint32Array.of(5 + i), cols: Uint16Array.of(1), inputs: [String(i)] }
				})
			)
			times.push(cpu() - before)
		}

		opened.session.close()
		times.sort((a, z) => a - z)
		process.stdout.write(`csv keystroke at 1M rows: p50 ${(times[10] ?? 0).toFixed(2)} ms\n`)
		expect(times[10]).toBeLessThanOrEqual(budget(5))
	})
})

describe.skipIf(!PERF)("sheet session budgets at 1M cells", () => {
	it("commits keystrokes, inserts rows and opens in slices within budget", { timeout: 600_000 }, async () => {
		const bytes = bigWorkbook()
		let last = cpu()
		let longest = 0
		const host = inThreadSheetHost()
		const opening = performance.now()
		const result = await host.open(
			bytes,
			{
				kind: "xlsx",
				slicing: {
					sliceMs: 16,
					now: () => performance.now(),
					pause: () => {
						longest = Math.max(longest, cpu() - last)

						return new Promise(resolve =>
							setTimeout(() => {
								last = cpu()
								resolve()
							}, 0)
						)
					}
				}
			},
			() => undefined
		)
		const openMs = performance.now() - opening

		longest = Math.max(longest, cpu() - last)

		if (result.kind !== "opened") throw new Error(result.kind)

		const { session, info } = result
		const sheet = info.activeSheet

		expect(await session.intent()).toEqual({ state: "writable" })
		await session.tiles(sheet, Uint32Array.of(0, 0, 1, 0, 2, 0))

		const commits: number[] = []

		for (let i = 0; i < 40; i++) {
			const before = cpu()

			changeOf(
				await session.command({
					type: "cells.set",
					sheet,
					cells: { rows: Uint32Array.of(10 + i), cols: Uint16Array.of(3), inputs: [String(i * 3.5)] }
				})
			)
			commits.push(cpu() - before)
		}

		commits.sort((a, b) => a - b)

		const p50 = commits[Math.floor(commits.length / 2)] ?? 0
		const p95 = commits[Math.floor(commits.length * 0.95)] ?? 0
		const before = cpu()
		const inserted = changeOf(await session.command({ type: "axis.insert", sheet, axis: "rows", at: 50, count: 1 }))
		const insertMs = cpu() - before
		const message = serialize(inserted).length

		process.stdout.write(
			`open ${openMs.toFixed(0)} ms (longest slice ${longest.toFixed(1)} ms); keystroke p50 ${p50.toFixed(2)} ms p95 ${p95.toFixed(2)} ms; insert row ${insertMs.toFixed(1)} ms, message ${message} B\n`
		)

		expect(p95).toBeLessThanOrEqual(budget(5))
		expect(insertMs).toBeLessThanOrEqual(budget(150))
		expect(message).toBeLessThanOrEqual(64 * 1024)
		expect(longest).toBeLessThanOrEqual(budget(50))
		session.close()
		host.dispose()
	})
})
