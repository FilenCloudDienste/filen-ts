import { spawn } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { describe, expect, it } from "vitest"
import type { PrintPage } from "../core/sheet/print/paginate"
import { AxisFlag, type SheetAxisLayout, type SheetRange } from "../core/sheet/protocol"
import { SheetGridModel } from "../react/sheet/model"
import { printSheet } from "../react/sheet/print/printPage"
import { printRanges } from "../react/sheet/print/printRanges"
import { inThreadSheetHost } from "../dom/sheet/host"
import { officeEnv } from "./interop/soffice"
import { CORPUS_DIR } from "./corpusDir"
import { sheetOffices, sheetProfile, unoEnv, unoOffice } from "./oracles/sheet/libreOffice"
import { IMMEDIATE } from "./sheetSessionFixtures"

// Our pages against LibreOffice's: for each corpus workbook, LibreOffice (over UNO) lays out every sheet's page breaks
// and exports the workbook as PDF, and each fit-to sheet on its own; we cut the same sheets into pages from the file's
// print settings. The report (print-oracle.json in the scratch directory) lists, per sheet, both page counts and both
// sets of breaks, the PDF's page count beside ours, and the counts by category: fit-to sheets against the sheet's own
// PDF, row breaks only where every printed row has its own height (LibreOffice fits the others again to its fonts). Opt-in: FILEN_OFFICE_SOFFICE=<soffice>; FILEN_OFFICE_PRINT_FILES caps the files
// (default 40); FILEN_OFFICE_LO_PROFILE names where LibreOffice's profile goes.

const UNO = unoOffice(sheetOffices())
const SCRIPT = join(import.meta.dirname, "oracles", "sheet", "uno", "print.py")
const LIMIT = Number(process.env["FILEN_OFFICE_PRINT_FILES"] ?? "40")
const MAX_BYTES = 3 * 1024 * 1024
// A file LibreOffice takes longer than this to lay out and export is reported and skipped (its runner restarted).
const JOB_TIMEOUT_MS = 180_000

interface LoSheet {
	readonly name: string
	readonly visible: boolean
	readonly rowBreaks: readonly (readonly [number, boolean])[]
	readonly colBreaks: readonly (readonly [number, boolean])[]
	readonly areas: readonly (readonly [number, number, number, number])[]
}

interface LoResult {
	readonly ok: boolean
	readonly error?: string
	readonly sheets?: readonly LoSheet[]
	readonly pdfPages?: number
	// Page counts of the sheets exported on their own (null: the sheet was not found).
	readonly alonePages?: Readonly<Record<string, number | null>>
}

interface SheetReport {
	readonly file: string
	readonly sheet: string
	readonly ours: number
	readonly theirs: number
	readonly ourRowBreaks: readonly number[]
	readonly theirRowBreaks: readonly number[]
	readonly ourColBreaks: readonly number[]
	readonly theirColBreaks: readonly number[]
	// Fit to page: `theirs` is the page count of LibreOffice's PDF of the sheet alone (its page break API ignores the
	// fit scale), and the breaks are not compared.
	readonly fit: boolean
	// Every printed row has a height of its own (customHeight): LibreOffice keeps those, where it fits other rows again
	// to its own fonts, so only then are the row breaks compared.
	readonly rowsComparable: boolean
}

function corpusFiles(): string[] {
	const directory = join(CORPUS_DIR, "xlsx")

	if (!existsSync(directory)) return []

	return readdirSync(directory)
		.filter(name => name.endsWith(".xlsx") && statSync(join(directory, name)).size <= MAX_BYTES)
		.sort()
		.slice(0, LIMIT)
		.map(name => join(directory, name))
}

// Whether every row from `first` to `last` has a height of its own (the layout lists rows with anything of their own,
// in order; one it does not list has the default height).
function customRows(rows: SheetAxisLayout, first: number, last: number): boolean {
	let at = 0

	while (at < rows.indices.length && (rows.indices[at] ?? 0) < first) at++

	for (let row = first; row <= last; row++, at++) {
		if (rows.indices[at] !== row || ((rows.flags[at] ?? 0) & AxisFlag.CUSTOM) === 0) return false
	}

	return true
}

// Where pages start along one axis inside `first`..`last`, without the first.
function starts(breaks: readonly (readonly [number, boolean])[], first: number, last: number): number[] {
	return breaks.map(([position]) => position).filter(position => position > first && position <= last)
}

describe.skipIf(UNO === undefined || corpusFiles().length === 0)("printed pages against LibreOffice", () => {
	it("reports page counts and break positions per sheet", async () => {
		const office = UNO

		if (office?.resources === undefined) return

		const scratch = mkdtempSync(join(tmpdir(), "filen-office-print-lo-"))
		let runs = 0
		// A headless LibreOffice and the UNO runner on it; started again when a file takes it down.
		const start = () => {
			const profile = sheetProfile(process.env["FILEN_OFFICE_LO_PROFILE"] ?? scratch, `print-${String(runs++)}`)
			const pipe = `filen-office-print-${String(process.pid)}-${String(Date.now())}`
			const soffice = spawn(
				office.path,
				[
					`-env:UserInstallation=file://${profile}`,
					"--headless",
					"--norestore",
					"--nologo",
					"--nodefault",
					"--nolockcheck",
					`--accept=pipe,name=${pipe};urp;`
				],
				{ detached: true, stdio: ["ignore", "ignore", "ignore"], env: officeEnv() }
			)
			const python = spawn(join(office.resources ?? "", "python"), ["-I", SCRIPT, office.resources ?? "", pipe], {
				stdio: ["pipe", "pipe", "inherit"],
				env: unoEnv(office.resources ?? "")
			})
			const lines = createInterface({ input: python.stdout })[Symbol.asyncIterator]()
			const read = async (timeoutMs = JOB_TIMEOUT_MS): Promise<string> => {
				let timer: NodeJS.Timeout | undefined
				const timeout = new Promise<never>((_, reject) => {
					timer = setTimeout(() => {
						reject(new Error(`LibreOffice silent for ${String(timeoutMs)} ms`))
					}, timeoutMs)
				})

				try {
					const line = await Promise.race([lines.next(), timeout])

					if (line.done === true) throw new Error("the UNO runner exited")

					return line.value
				} finally {
					clearTimeout(timer)
				}
			}
			const stop = (): void => {
				python.stdin.end()
				python.kill("SIGKILL")

				try {
					if (soffice.pid !== undefined) process.kill(-soffice.pid, "SIGKILL")
				} catch {
					// Already gone.
				}
			}

			return { python, read, stop }
		}
		let runner = start()
		const report: SheetReport[] = []
		const totals: { file: string; ours: number; pdf: number }[] = []
		const failures: string[] = []

		try {
			expect(JSON.parse(await runner.read())).toEqual({ ready: true })

			for (const [index, file] of corpusFiles().entries()) {
				const copy = join(scratch, `input-${String(index)}.xlsx`)
				const pdf = join(scratch, `output-${String(index)}.pdf`)

				copyFileSync(file, copy)

				const name = file.slice(file.lastIndexOf("/") + 1)
				const host = inThreadSheetHost()
				const opened = await host.open(readFileSync(file), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

				if (opened.kind !== "opened") {
					failures.push(`${name}: ${opened.kind}`)

					continue
				}

				// Our pages first: the fit-to sheets are exported on their own too.
				const model = new SheetGridModel({ source: opened.session, edit: opened.session, info: opened.info })
				const ourSheets: {
					readonly name: string
					readonly fit: boolean
					readonly clamped: readonly SheetRange[]
					readonly pages: readonly PrintPage[]
					readonly rowsComparable: boolean
				}[] = []

				for (const summary of opened.info.sheets) {
					if (summary.kind !== "worksheet" || summary.state !== "visible") continue

					const settings = await opened.session.query("print.settings", { sheet: summary.id })

					if (settings === null) continue

					const layout = await opened.session.layout(summary.id)
					const ranges: readonly SheetRange[] = settings.setup.printArea ?? (settings.used === null ? [] : [settings.used])
					// Objects grow the used range as the print dialog's pages do.
					const clamped = printRanges(
						ranges,
						settings.used,
						layout.extensions?.drawings?.objects.filter(object => !object.hidden) ?? [],
						[],
						layout
					)
					// The rows at the heights the file stores, as the print dialog lays them out.
					const exact = await opened.session.query("print.rows", { sheet: summary.id })
					const printed =
						clamped.length === 0
							? null
							: printSheet(summary.id, summary.name, layout, settings.setup, clamped, undefined, exact)

					ourSheets.push({
						name: summary.name,
						fit: settings.setup.fitToPage,
						clamped,
						pages: printed?.pagination.pages ?? [],
						rowsComparable: clamped.length > 0 && clamped.every(range => customRows(layout.rows, range.startRow, range.endRow))
					})
				}

				runner.python.stdin.write(
					`${JSON.stringify({ id: index, input: copy, pdf, alone: ourSheets.filter(sheet => sheet.fit).map(sheet => sheet.name) })}\n`
				)

				let theirs: LoResult

				try {
					theirs = JSON.parse(await runner.read()) as LoResult
				} catch (error) {
					theirs = { ok: false, error: String(error) }
				}

				if (!theirs.ok || theirs.sheets === undefined) {
					failures.push(`${name}: LibreOffice ${theirs.error ?? "failed"}`)
					runner.stop()
					runner = start()
					expect(JSON.parse(await runner.read())).toEqual({ ready: true })
					model.dispose()
					opened.session.close()

					continue
				}

				let ours = 0

				for (const sheet of ourSheets) {
					const lo = theirs.sheets.find(entry => entry.name === sheet.name)

					if (lo === undefined) continue

					const { pages, clamped } = sheet
					const first = clamped[0]
					const theirRows = first === undefined ? [] : starts(lo.rowBreaks, first.startRow, first.endRow)
					const theirCols = first === undefined ? [] : starts(lo.colBreaks, first.startCol, first.endCol)
					const alone = theirs.alonePages?.[sheet.name]

					if (sheet.fit && (alone === undefined || alone === null)) continue

					ours += pages.length
					report.push({
						file: name,
						sheet: sheet.name,
						ours: pages.length,
						theirs: sheet.fit ? (alone ?? 0) : first === undefined ? 0 : (theirRows.length + 1) * (theirCols.length + 1),
						ourRowBreaks: [...new Set(pages.filter(page => page.range === 0).map(page => page.rows.first))].filter(
							row => row !== first?.startRow
						),
						theirRowBreaks: theirRows,
						ourColBreaks: [...new Set(pages.filter(page => page.range === 0).map(page => page.cols.first))].filter(
							col => col !== first?.startCol
						),
						theirColBreaks: theirCols,
						fit: sheet.fit,
						rowsComparable: sheet.rowsComparable
					})
				}

				totals.push({ file: name, ours, pdf: theirs.pdfPages ?? 0 })
				model.dispose()
				opened.session.close()
				rmSync(copy, { force: true })
				rmSync(pdf, { force: true })
			}
		} finally {
			runner.stop()
			rmSync(scratch, { recursive: true, force: true })
		}

		const fitted = report.filter(entry => entry.fit)
		const laid = report.filter(entry => !entry.fit)
		const comparableRows = laid.filter(entry => entry.rowsComparable)
		const categories = {
			// Fit to page: our page count against LibreOffice's PDF of the sheet alone.
			fit: { sheets: fitted.length, pagesEqual: fitted.filter(entry => entry.ours === entry.theirs).length },
			// The rest: page counts and column breaks; row breaks where every printed row has its own height.
			laidOut: {
				sheets: laid.length,
				pagesEqual: laid.filter(entry => entry.ours === entry.theirs).length,
				colBreaksEqual: laid.filter(entry => entry.ourColBreaks.join() === entry.theirColBreaks.join()).length,
				rowSheets: comparableRows.length,
				rowBreaksEqual: comparableRows.filter(entry => entry.ourRowBreaks.join() === entry.theirRowBreaks.join()).length
			}
		}
		const sameCount = report.filter(entry => entry.ours === entry.theirs).length
		const samePdf = totals.filter(entry => entry.ours === entry.pdf).length
		const out = join(process.env["FILEN_OFFICE_PRINT_REPORT"] ?? tmpdir(), "print-oracle.json")

		mkdirSync(join(out, ".."), { recursive: true })
		writeFileSync(
			out,
			JSON.stringify(
				{ sameCount, categories, samePdf, sheets: report.length, files: totals.length, failures, totals, report },
				null,
				1
			)
		)
		console.log(
			`print oracle: ${String(report.length)} sheets, page count equal ${String(sameCount)} (${JSON.stringify(categories)}); ` +
				`${String(totals.length)} files, PDF page count equal ${String(samePdf)}; failures ${String(failures.length)}; report ${out}`
		)
		expect(report.length).toBeGreaterThan(0)
	}, 3_600_000)
})
