import { closeSync, openSync, writeSync } from "node:fs"
import { Zip, ZipDeflate, ZipPassThrough } from "fflate"
import { encodeUtf8 } from "../core/xml/index"
import { R, SML } from "./xlsxWriteFixtures"
import { ZIP_ENTRY_TIME } from "./zipTime"

// The reader's benchmark workbooks (xlsxReadPerf.test.ts): `rows` x 10 cells on one sheet, column A a shared string
// out of 100, B to J numbers; with a formula column, J is a formula over A and B, without (m1) or with (m2) its
// stored result. Streamed to `file` a block of rows at a time: 300,000 rows are about 100 MB of sheet markup.

export type FormulaColumn = "none" | "uncached" | "cached"

const COLS = 10
const BLOCK = 2_000
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const PACKAGE_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
const CONTENT_TYPES = "application/vnd.openxmlformats-officedocument.spreadsheetml"

function rowMarkup(row: number, formulas: FormulaColumn): string {
	let markup = `<row r="${row}" spans="1:${COLS}"><c r="A${row}" t="s"><v>${row % 100}</v></c>`

	for (let col = 1; col < COLS; col++) {
		const reference = `${String.fromCharCode(65 + col)}${row}`
		const value = (row * COLS + col) / 7

		if (col < COLS - 1 || formulas === "none") markup += `<c r="${reference}"><v>${value}</v></c>`
		else markup += `<c r="${reference}"><f>B${row}*2</f>${formulas === "cached" ? `<v>${((row * COLS + 1) / 7) * 2}</v>` : ""}</c>`
	}

	return `${markup}</row>`
}

export function writePerfWorkbook(file: string, rows: number, formulas: FormulaColumn): void {
	const fd = openSync(file, "w")

	try {
		const failures: Error[] = []
		const zip = new Zip((error, data) => {
			if (error !== null) failures.push(error)
			else writeSync(fd, data)
		})
		const stored = (name: string, text: string): void => {
			const entry = new ZipPassThrough(name)

			entry.mtime = ZIP_ENTRY_TIME
			zip.add(entry)
			entry.push(encodeUtf8(text), true)
		}

		stored(
			"[Content_Types].xml",
			`${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${CONTENT_TYPES}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CONTENT_TYPES}.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${CONTENT_TYPES}.sharedStrings+xml"/></Types>`
		)
		stored(
			"_rels/.rels",
			`${DECLARATION}<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
		)
		stored(
			"xl/workbook.xml",
			`${DECLARATION}<workbook xmlns="${SML}" xmlns:r="${R}"><sheets><sheet name="Big" sheetId="1" r:id="rId1"/></sheets></workbook>`
		)
		stored(
			"xl/_rels/workbook.xml.rels",
			`${DECLARATION}<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`
		)
		stored(
			"xl/sharedStrings.xml",
			`${DECLARATION}<sst xmlns="${SML}" count="${rows}" uniqueCount="100">${Array.from({ length: 100 }, (_, k) => `<si><t>text ${k}</t></si>`).join("")}</sst>`
		)

		const sheet = new ZipDeflate("xl/worksheets/sheet1.xml", { level: 6 })

		sheet.mtime = ZIP_ENTRY_TIME
		zip.add(sheet)
		sheet.push(encodeUtf8(`${DECLARATION}<worksheet xmlns="${SML}" xmlns:r="${R}"><dimension ref="A1:J${rows}"/><sheetData>`))

		for (let from = 1; from <= rows; from += BLOCK) {
			const chunks: string[] = []

			for (let row = from; row < Math.min(from + BLOCK, rows + 1); row++) chunks.push(rowMarkup(row, formulas))

			sheet.push(encodeUtf8(chunks.join("")))
		}

		sheet.push(encodeUtf8("</sheetData></worksheet>"), true)
		zip.end()

		if (failures[0] !== undefined) throw failures[0]
	} finally {
		closeSync(fd)
	}
}
