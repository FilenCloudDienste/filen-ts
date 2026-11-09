import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { DocxEngineServices } from "../dom/docx/index"
import { exportDocxPdf } from "../dom/docx/pdf"
import { pdfAssets } from "./docxPdfFixtures"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"

// A sample of the Word corpus exported to PDF as the editor exports it (opened, laid out with the bundled fonts'
// metrics, painted) and checked by qpdf --check, veraPDF's PDF/UA-1 profile and pypdf. Opt-in:
// FILEN_OFFICE_PDF_TOOLS=<dir> holding qpdf/bin/qpdf, verapdf/verapdf and pypdf, and the corpus in .corpus.

const TOOLS = process.env["FILEN_OFFICE_PDF_TOOLS"] ?? ""
const QPDF = join(TOOLS, "qpdf", "bin", "qpdf")
const VERAPDF = join(TOOLS, "verapdf", "verapdf")
const CORPUS = new URL("../../.corpus/", import.meta.url)
// The corpus holds no JPEG with an EXIF orientation other than 1; the photo case is a document's plain JPEGs.
const SAMPLE = [
	// A 187-row table that splits across pages.
	"docx/govuk___final__Annex_H_-_DARDR_Data_Capture_Form.docx",
	// A header and footer with hyperlinks, symbol-font bullets and a JPEG logo.
	"docx/govuk__template-inform-and-advise-letter-for-TB-in-cattle.docx",
	// Office Math beside tables and symbol-font bullets.
	"docx/oxpt__HC031-Complicated-Document.docx",
	"docx/lo__math-subscripts.docx",
	// Symbol-font bullets.
	"docx/lo__tdf90789.docx",
	// Right-to-left paragraphs.
	"docx/oxpt__HC012-Test-07.docx",
	// JPEG photos around an equation.
	"docx/oxpt__WC022-Image-Math-Para-Before.docx",
	"dotx/lo__sample.dotx",
	"docm/lo__hello.docm"
]

const PYPDF = `
import sys, json
sys.path[:0] = [sys.argv[1] + "/pypdf"]
from pypdf import PdfReader
r = PdfReader(sys.argv[2])
print(json.dumps({"pages": len(r.pages), "text": r.pages[0].extract_text()}))
`

function services(): DocxEngineServices {
	return {
		fontHost: nodeFontHost,
		replayFonts: false,
		fontAssets: nodeFontAssets,
		measurer: new HmtxMeasurer(),
		yield: () => new Promise(resolve => setTimeout(resolve, 0)),
		sliceMs: 50
	}
}

const available = TOOLS !== "" && existsSync(QPDF) && existsSync(VERAPDF) && SAMPLE.every(file => existsSync(new URL(file, CORPUS)))

describe.skipIf(!available)("a Word corpus sample exported to PDF, under qpdf, veraPDF and pypdf", () => {
	const kept = process.env["FILEN_OFFICE_PDF_OUT"]
	const dir = !available ? "" : (kept ?? mkdtempSync(join(tmpdir(), "docxpdf-")))

	afterAll(() => {
		if (dir !== "" && kept === undefined) rmSync(dir, { recursive: true, force: true })
	})

	it("is clean under qpdf, passes PDF/UA-1 for every file, and reads with text on its first page", { timeout: 600_000 }, async () => {
		const failures: string[] = []
		let exported = 0

		for (const file of SAMPLE) {
			const name = file.slice(file.lastIndexOf("/") + 1)
			const result = await exportDocxPdf(new Uint8Array(readFileSync(new URL(file, CORPUS))), services(), pdfAssets, {
				options: { title: name, deterministic: true },
				signal: { aborted: false }
			})

			exported++

			const path = join(dir, `${String(exported)}.pdf`)

			writeFileSync(path, new Uint8Array(await result.blob.arrayBuffer()))

			// qpdf exits 0 only when clean, 3 on warnings.
			const check = spawnSync(QPDF, ["--check", path], { encoding: "utf8" })

			expect(check.status, `${file}: ${check.stdout}${check.stderr}`).toBe(0)
			expect(check.stdout, file).toContain("No syntax or stream encoding errors found")

			const report = spawnSync(VERAPDF, ["-f", "ua1", "--format", "text", path], {
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024
			}).stdout

			if (!report.startsWith("PASS")) failures.push(`${file}: ${report.trim()}`)

			const read = JSON.parse(
				execFileSync("python3", ["-I", "-c", PYPDF, TOOLS, path], { maxBuffer: 64 * 1024 * 1024 }).toString()
			) as {
				pages: number
				text: string
			}

			expect(read.pages, file).toBeGreaterThan(0)
			expect(read.text.trim(), file).not.toBe("")
		}

		expect(failures, failures.join("\n")).toEqual([])
	})
})
