import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import type { SheetOpenResult } from "@filen/office/core/sheet"
import { workbookOpener } from "@filen/office/dom/sheet"
import { budget } from "@filen/shared/tooling/testBudget"
import { xlsToXlsx } from "@/features/spreadsheet/lib/xlsConvert"
import { sheetWorkbookOpener } from "@/features/spreadsheet/workers/sheetWorkbookOpener"

// Every Excel 97–2003 workbook and template of the real-world corpus (packages/filen-office/corpus/manifest.json)
// through the workbook worker's opener, as a user opens it: Excel's default password tried, then converted to .xlsx
// and opened view-only. Each opens with named sheets and cells, or is refused with a typed reason, within a bound on
// time. FILEN_OFFICE_CORPUS when set, else the cache `pnpm run corpus:fetch` fills; skipped while it is absent.

const CORPUS = (() => {
	const configured = process.env["FILEN_OFFICE_CORPUS"]

	return configured !== undefined && configured !== ""
		? resolve(configured)
		: join(__dirname, "..", "..", "..", "filen-office", ".corpus")
})()

function familyFiles(family: "xls" | "xlt"): string[] {
	const directory = join(CORPUS, family)

	if (!existsSync(directory)) return []

	return readdirSync(directory)
		.filter(name => !name.startsWith("."))
		.sort()
		.map(name => `${family}/${name}`)
}

const FILES = [...familyFiles("xls"), ...familyFiles("xlt")]

// The files that do not open, and how each is turned away.
const REFUSED: Readonly<Record<string, Exclude<SheetOpenResult["kind"], "opened"> | `failed:${string}`>> = {
	// A password to open other than Excel's default: the user is asked.
	"xls/tika__testEXCEL_protected_passtika.xls": "needsPassword",
	// A damaged file from POI's fuzz cases: its BoundSheet points at no sheet.
	"xls/poi__61300.xls": "failed:malformed"
}

// Files with no cell on any sheet (LibreOffice reads none either): blank workbooks, sheet-name and metadata cases, an
// embedded object alone.
const EMPTY = new Set([
	"xls/poi__DBCSSheetName.xls",
	"xls/poi__TestBug44375.xls",
	"xls/poi__blankworkbook.xls",
	"xls/poi__namedinput.xls",
	"xls/tika__testEXCEL_95.xls",
	"xls/tika__testEXCEL_embeddedPDF_mac.xls"
])

// The slowest file opens in under 400 ms on a developer's machine; a complexity regression exceeds this.
const PER_FILE_MS = 2_000

function read(path: string): Uint8Array {
	return new Uint8Array(readFileSync(join(CORPUS, path)))
}

function open(path: string, opener = sheetWorkbookOpener()): Promise<SheetOpenResult> {
	return opener(
		bytesSource(read(path)),
		{ kind: path.startsWith("xlt/") ? "xlt" : "xls" },
		() => undefined,
		() => undefined
	)
}

describe.skipIf(FILES.length === 0)("the .xls and .xlt corpus through the workbook opener", () => {
	it("covers both families", () => {
		expect(FILES.some(path => path.startsWith("xls/"))).toBe(true)
		expect(FILES.some(path => path.startsWith("xlt/"))).toBe(true)
	})

	it.each(FILES)("%s", async path => {
		const start = performance.now()
		const result = await open(path)
		const elapsed = performance.now() - start

		try {
			expect(elapsed).toBeLessThan(budget(PER_FILE_MS))

			const expected = REFUSED[path]

			if (expected !== undefined) {
				expect(result.kind === "failed" ? `failed:${result.reason}` : result.kind).toBe(expected)

				return
			}

			if (result.kind !== "opened") throw new Error(`${path}: ${JSON.stringify(result)}`)

			const sheets = result.info.sheets

			expect(sheets.length).toBeGreaterThan(0)
			expect(sheets.every(sheet => sheet.name !== "")).toBe(true)
			expect(result.info.writability).toEqual({ state: "viewOnly", reason: "legacyFormat" })

			let cells = false

			for (const sheet of sheets) {
				const layout = await result.session.layout(sheet.id)

				if (layout.rowCount > 0 && layout.colCount > 0) {
					cells = true

					break
				}
			}

			expect(cells).toBe(!EMPTY.has(path))
		} finally {
			if (result.kind === "opened") result.session.close()
			if (result.kind === "needsPassword") result.locked.dispose()
		}
	})

	it("refuses a sheet past the cell limit as too large, not damaged", async () => {
		const result = await open("xls/csvkit__test.xls", workbookOpener({ legacy: file => xlsToXlsx(file, 2) }))

		expect(result.kind === "failed" && result.reason).toBe("tooLarge")
	})
})
