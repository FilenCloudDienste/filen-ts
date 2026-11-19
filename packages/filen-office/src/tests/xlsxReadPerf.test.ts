import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { budget } from "./timing"
import { type FormulaColumn, writePerfWorkbook } from "./xlsxPerfWorkbooks"

// The reader's budgets on the benchmark workbooks (100,000 x 10 values; the same with a formula column, without
// and with stored results; 300,000 x 10 values), each opened in a process of its own: the open plus the first
// sheet within 0.35 s of this thread's CPU time, the live heap it retains and the store's estimate within about 1.15
// times what they measure (values 18.5 MB, with a formula column 26.5 MB), and the 3M-cell workbook within a 600 MB
// peak. Opt-in, with xlsxWritePerf.test.ts: FILEN_OFFICE_XLSX_PERF=1. The workbooks are built into a temporary
// directory (xlsxPerfWorkbooks.ts).

const PERF = process.env["FILEN_OFFICE_XLSX_PERF"] === "1"
const WORKBOOKS: readonly (readonly [name: string, rows: number, formulas: FormulaColumn])[] = [
	["sheet-100000x10-m0.xlsx", 100_000, "none"],
	["sheet-100000x10-m1.xlsx", 100_000, "uncached"],
	["sheet-100000x10-m2.xlsx", 100_000, "cached"],
	["sheet-300000x10-m0.xlsx", 300_000, "none"]
]
const RUN = join(import.meta.dirname, "xlsxReadPerfRun.ts")

interface Run {
	readonly cells: number
	readonly cpuMs: number
	readonly retainedMB: number
	readonly storeMB: number
	readonly peakRssMB: number
}

function measure(file: string, mode: "fflate" | "native"): Run {
	const output = execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", RUN, file, mode], {
		encoding: "utf8",
		cwd: join(import.meta.dirname, "..", "..")
	})

	return JSON.parse(output.trim().split("\n").pop() ?? "{}") as Run
}

describe.skipIf(!PERF)("xlsx reader budgets", () => {
	let dir = ""

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "filen-office-xlsx-perf-"))

		for (const [name, rows, formulas] of WORKBOOKS) writePerfWorkbook(join(dir, name), rows, formulas)
	}, 300_000)

	afterAll(() => {
		if (dir !== "") rmSync(dir, { recursive: true, force: true })
	})

	for (const [name, retained] of [
		["sheet-100000x10-m0.xlsx", 21],
		["sheet-100000x10-m1.xlsx", 30],
		["sheet-100000x10-m2.xlsx", 30]
	] as const) {
		it(`opens ${name} and parses its sheet within 0.35 s CPU and ${String(retained)} MB`, { timeout: 120_000 }, () => {
			const file = join(dir, name)

			for (const mode of ["fflate", "native"] as const) {
				const run = measure(file, mode)

				console.log(`${name} ${mode}: ${JSON.stringify(run)}`)
				expect(run.cells).toBe(1_000_000)
				expect(run.cpuMs).toBeLessThanOrEqual(budget(350))
				expect(Math.max(run.retainedMB, run.storeMB)).toBeLessThanOrEqual(retained)
			}
		})
	}

	it("opens 3M cells within a 600 MB peak", { timeout: 120_000 }, () => {
		const run = measure(join(dir, "sheet-300000x10-m0.xlsx"), "fflate")

		console.log(`sheet-300000x10-m0.xlsx: ${JSON.stringify(run)}`)
		expect(run.cells).toBe(3_000_000)
		expect(run.peakRssMB).toBeLessThanOrEqual(600)
	})
})
