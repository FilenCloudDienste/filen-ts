import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { exportSheetPdf } from "../react/sheet/print/pdfExport"
import { nodeFontAssets, pdfBytes, workbookRequest } from "./sheetPdfFixtures"
import { openFixture } from "./sheetSessionFixtures"

// A sample of the xlsx corpus (charts, pictures, headers and footers, links, right to left, a 1,105-page sheet) printed
// to PDF and checked by qpdf --check, veraPDF's PDF/UA-1 profile and pypdf. Opt-in: FILEN_OFFICE_PDF_TOOLS=<dir>
// holding qpdf/bin/qpdf, verapdf/verapdf and pypdf, and the corpus in .corpus/xlsx.

const TOOLS = process.env["FILEN_OFFICE_PDF_TOOLS"] ?? ""
const QPDF = join(TOOLS, "qpdf", "bin", "qpdf")
const VERAPDF = join(TOOLS, "verapdf", "verapdf")
const CORPUS = new URL("../../.corpus/xlsx/", import.meta.url)
const SAMPLE = [
	"xlsxwriter__hyperlink03.xlsx",
	"oxsdk__Photo_Formats_-_CGM-O12-XL-Pictures.xlsx",
	"oxsdk__3D_Bar-O12-XL-Charts.xlsx",
	"xlsxwriter__chart_scatter01.xlsx",
	"xlsxwriter__chart_radar01.xlsx",
	"xlsxwriter__chart_doughnut01.xlsx",
	"xlsxwriter__chart_stock01.xlsx",
	"poi__right-to-left.xlsx",
	"xlsxwriter__chart_data_labels16.xlsx",
	"poi__picture.xlsx",
	"poi__45540_classic_Header.xlsx",
	"poi__45540_classic_Footer.xlsx",
	"docx4j__strict-invoice.xlsx",
	"closedxml__column-style-autofilter.xlsx",
	"closedxml__cond_format_theme_color2.xlsx",
	"docx4j__cr022-sparklines.xlsx",
	"poi__clone_sheet.xlsx",
	"poi__45544.xlsx",
	"govuk__Budget-template-Aug19.xlsx",
	"docx4j__strict-chart.xlsx"
]

const PYPDF = `
import sys, json
sys.path[:0] = [sys.argv[1] + "/pypdf"]
from pypdf import PdfReader
r = PdfReader(sys.argv[2])
print(json.dumps({"pages": len(r.pages), "text": r.pages[0].extract_text(), "outline": [o.title for o in r.outline]}))
`

const available = TOOLS !== "" && existsSync(QPDF) && existsSync(VERAPDF) && existsSync(new URL(SAMPLE[0] ?? "", CORPUS))

describe.skipIf(!available)("a corpus sample printed to PDF, under qpdf, veraPDF and pypdf", () => {
	const kept = process.env["FILEN_OFFICE_PDF_OUT"]
	const dir = !available ? "" : (kept ?? mkdtempSync(join(tmpdir(), "sheetpdf-")))

	afterAll(() => {
		if (dir !== "" && kept === undefined) rmSync(dir, { recursive: true, force: true })
	})

	it("is clean under qpdf, passes PDF/UA-1 for every file, and reads with one outline item per sheet", { timeout: 600_000 }, async () => {
		const failures: string[] = []
		let exported = 0

		for (const file of SAMPLE) {
			const { session, info } = await openFixture(new Uint8Array(readFileSync(new URL(file, CORPUS))))

			for (let k = 0; k < 30; k++) await new Promise(resolve => setTimeout(resolve, 0))

			const request = await workbookRequest(session, info, file)
			const result = await exportSheetPdf(request, { session, assets: nodeFontAssets, deterministic: true })

			session.close()
			expect(result.ok, file).toBe(true)

			if (!result.ok) continue

			exported++

			const path = join(dir, `${String(exported)}.pdf`)

			writeFileSync(path, pdfBytes(result.output.parts))
			expect(execFileSync(QPDF, ["--check", path]).toString(), file).toContain("No syntax or stream encoding errors found")

			const report = spawnSync(VERAPDF, ["-f", "ua1", "--format", "text", path], {
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024
			}).stdout

			if (!report.startsWith("PASS")) failures.push(`${file}: ${report.trim()}`)

			const read = JSON.parse(
				execFileSync("python3", ["-I", "-c", PYPDF, TOOLS, path], { maxBuffer: 64 * 1024 * 1024 }).toString()
			) as {
				pages: number
				outline: string[]
			}

			expect(read.pages, file).toBe(result.pages)
			// One item per sheet that printed, in the print's order.
			const order = read.outline.map(title => request.sheets.findIndex(sheet => sheet.name === title))

			expect(read.outline.length, file).toBeGreaterThan(0)
			expect(
				order.every((at, k) => at >= 0 && (k === 0 || at > (order[k - 1] ?? -1))),
				file
			).toBe(true)
		}

		expect(failures, failures.join("\n")).toEqual([])
	})
})
