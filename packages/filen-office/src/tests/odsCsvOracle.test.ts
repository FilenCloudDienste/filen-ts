import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { openOds } from "../core/ods/open"
import { CORPUS_DIR } from "./corpusDir"
import { ODS_ENCRYPTED, odsDocument, shownRows } from "./odsFixtures"
import { exportShown, sheetOffices, sheetProfile } from "./oracles/sheet/libreOffice"

// Each corpus spreadsheet's sheets as shown (CSV, number formats applied, cached results) equal LibreOffice 7.5's
// CSV export of them, apart from the accepted differences below. Opt-in: FILEN_OFFICE_SOFFICE=<soffice> naming a
// 7.5 install (the differences were measured against it). Profiles and copies go under
// FILEN_OFFICE_SHEET_LO_SCRATCH (default: the system temp directory).

const DIR = join(CORPUS_DIR, "ods")
const FILES = existsSync(DIR)
	? readdirSync(DIR)
			.filter(name => name.endsWith(".ods"))
			.sort()
	: []
const OFFICE = sheetOffices().find(office => office.version.startsWith("7.5."))
const SCRATCH = process.env["FILEN_OFFICE_SHEET_LO_SCRATCH"] || tmpdir()

// Where LibreOffice's text differs from ours, and why.
const ACCEPTED: Readonly<Record<string, string>> = {
	// ODF 1.3 Part 3 §6.1.2: white space is collapsed in text:p and its children, text:a among them; LibreOffice
	// keeps a link's trailing space out, and drops text beside a link in a paragraph that holds one.
	"govuk__Eng_BDI_conservation-volunteering.ods":
		"a link's collapsed trailing space (§6.1.2); General shows 15 significant digits of 4629072.3517026249 (…62), LibreOffice rounds its 16-digit shortest form (…63)",
	"govuk__Klebsiella-monthly-table-2026-june.ods": "a link's collapsed trailing space and the text around a link (§6.1.2)",
	"govuk__partnerships-directory.ods": "a link's collapsed trailing space (§6.1.2)",
	// ODF 1.3 Part 3 §19.343 leaves the rounding of a shown value to the consumer: 0.56499999999999995 in "0%" is
	// 57 % rounded at 15 significant digits (Excel's precision, "Excel specifications and limits"), as the producer
	// cached it; LibreOffice rounds the binary product (56.499…). §16.29: number:text " -" is fixed text, which
	// LibreOffice's import leaves unquoted (xmlnumfi.cxx lcl_EnquoteIfNecessary) and so loses the space of.
	"govuk__Main_Tables_Q3_2025_26.ods": 'percentages rounded at 15 significant digits (§19.343); the fixed text " -" kept whole (§16.29)',
	"govuk__Statutory_Homelessness_Detailed_Local_Authority_Data_202406_revised.ods": 'the fixed text " -" kept whole (§16.29)',
	"lo__fdo30900-1.ods":
		"a raw trailing space collapsed (§6.1.2); a FORMULA() cell shows the formula as its document's grammar wrote it, LibreOffice recalculates it in its own",
	"lo__tdf100458_lost_zero_value.ods": "the file is LibreOffice's fixture for a bug that loses a cell's zero value: the zero is shown",
	"lo__tdf132278.ods":
		"a raw trailing space collapsed (§6.1.2); error texts are the engine's (#VALUE!), the cache holds an it-IT author's (#VALORE!) and ODF Part 4 §6.3.14 converts with the evaluator's locale",
	"lo__user-defined-function.ods": "a Basic function's result is the cached one: macros never run here",
	"lo__vba_macro_functions.ods": "a VBA function's result is the cached one: macros never run here",
	"odftk__Basic.ods": "raw white space collapsed (§6.1.2); a row repeated past the row cap is refused with its issue, not drawn"
}

function trimmed(rows: readonly (readonly string[])[]): string[][] {
	const out = rows.map(row => {
		const copy = [...row]

		while (copy.length > 0 && copy[copy.length - 1] === "") copy.pop()

		return copy
	})

	while (out.length > 0 && out[out.length - 1]?.length === 0) out.pop()

	return out
}

describe.skipIf(FILES.length === 0 || OFFICE === undefined)("ODS as shown against LibreOffice 7.5", () => {
	it("equals LibreOffice's CSV export of every sheet apart from accepted differences", { timeout: 3_600_000 }, async () => {
		const office = OFFICE

		if (office === undefined) return

		const work = mkdtempSync(join(SCRATCH, "filen-office-ods-csv-"))

		try {
			const inputs = FILES.map(name => {
				const copy = join(work, name)

				copyFileSync(join(DIR, name), copy)

				return copy
			})
			const theirs = await exportShown(office, sheetProfile(work, "ods-csv"), inputs, join(work, "out"), 600_000, false)
			const unexpected: string[] = []
			let equal = 0

			for (const [index, name] of FILES.entries()) {
				const exported = theirs[index]
				const result = await openOds(bytesSource(new Uint8Array(readFileSync(join(DIR, name)))))

				if (!result.ok || exported?.ok !== true) {
					if (!ODS_ENCRYPTED.includes(name) || result.ok || exported?.ok === true)
						unexpected.push(`${name}: one side did not open it`)

					continue
				}

				const document = odsDocument(result)

				// As a session prepares a view-only workbook: results the file lacks or recalculates on load.
				if (document.needsPreparing(false)) document.buildEngine()

				const same = result.workbook.sheets.every(entry => {
					const sheet =
						exported.sheets.find(item => item.name === entry.name) ??
						(exported.sheets.length === 1 && result.workbook.sheets.length === 1 ? exported.sheets[0] : undefined)

					// LibreOffice writes no CSV for a sheet whose name cannot be a file name.
					if (sheet === undefined) return /[/\\:*?"<>|]/.test(entry.name)

					return JSON.stringify(shownRows(document, entry.id)) === JSON.stringify(trimmed(sheet.text))
				})

				document.dropEngine()

				if (same) equal++
				else if (ACCEPTED[name] === undefined) unexpected.push(name)
			}

			expect(unexpected).toEqual([])
			// Neither side opens an encrypted file; an accepted one differs.
			expect(equal).toBe(FILES.filter(name => !ODS_ENCRYPTED.includes(name) && ACCEPTED[name] === undefined).length)
		} finally {
			rmSync(work, { recursive: true, force: true })
		}
	})
})
