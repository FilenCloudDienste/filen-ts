import { describe, expect, it } from "vitest"
import { bytesSource } from "@filen/office/core/opc"
import { Relationships } from "../core/opc/relationships"
import { encodeUtf8 } from "@filen/office/core/xml"
import { sliceClock } from "../core/slicing"
import { MAX_SHEET_STRINGS } from "../core/xlsx/read/limits"
import { DEFAULT_XLSX_LIMITS, openXlsx, type XlsxLimits, type XlsxSheet, type XlsxWorkbook } from "../core/xlsx/read/index"
import { readSharedStrings } from "../core/xlsx/read/sharedStrings"
import { readWorksheet } from "../core/xlsx/read/worksheet"
import { buildWorkbook, SML, type TestWorkbook } from "./xlsxReadFixtures"

async function open(workbook: TestWorkbook, readLimits: Partial<XlsxLimits> = {}): Promise<XlsxWorkbook> {
	const result = await openXlsx(bytesSource(buildWorkbook(workbook)), { readLimits })

	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

	return result.workbook
}

function merges(count: number, first = 0): string {
	let out = ""

	for (let i = 0; i < count; i++) out += `<mergeCell ref="A${first + i * 2 + 1}:B${first + i * 2 + 2}"/>`

	return `<sheetData/><mergeCells count="${count}">${out}</mergeCells>`
}

describe("xlsx reader: counts are capped before they cost memory", () => {
	it("refuses a worksheet whose root holds a flood of tiny children", async () => {
		// 200,000 <a/>: 0.8 MB inflated, a few KB zipped; kept one copy each, millions of them exhaust the heap.
		const workbook = await open({ sheets: [{ body: `<sheetData/>${"<a/>".repeat(200_000)}` }] })

		await expect(workbook.load(0)).rejects.toMatchObject({ code: "tooLarge" })
	})

	it("refuses a workbook part whose root holds a flood of tiny children", async () => {
		const result = await openXlsx(bytesSource(buildWorkbook({ sheets: [{}], workbookTail: "<a/>".repeat(200_000) })))

		expect(result.ok ? "opened" : result.reason).toBe("tooLarge")
	})

	it("takes the sections of every sheet from one budget, and gives back what a refused sheet took", async () => {
		const flood = (count: number): TestWorkbook["sheets"][number] => ({ body: `<sheetData/>${"<a/>".repeat(count)}` })
		// workbook.xml holds <sheets> alone: 1 section; each sheet holds sheetData and its <a/>s.
		const workbook = await open({ sheets: [flood(5), flood(20), flood(5)] }, { maxSections: 14 })

		expect((await workbook.load(0)).sections.length).toBe(6)
		await expect(workbook.load(1)).rejects.toMatchObject({ code: "tooLarge" })
		expect((await workbook.load(2)).sections.length).toBe(6)
	})

	it("refuses merged ranges past the cap before parsing them", async () => {
		await expect((await open({ sheets: [{ body: merges(11) }] }, { maxMerges: 10 })).load(0)).rejects.toMatchObject({
			code: "tooLarge"
		})

		// The cap counts every element of the section, merge or not: none is parsed into a tree.
		const junk = `<sheetData/><mergeCells>${"<x/>".repeat(11)}</mergeCells>`

		await expect((await open({ sheets: [{ body: junk }] }, { maxMerges: 10 })).load(0)).rejects.toMatchObject({ code: "tooLarge" })
	})

	it("holds the merged ranges of every sheet to one cap", async () => {
		const workbook = await open({ sheets: [{ body: merges(6) }, { body: merges(6) }, { body: merges(4) }] }, { maxMerges: 10 })

		expect((await workbook.load(0)).merges.length).toBe(24)
		await expect(workbook.load(1)).rejects.toMatchObject({ code: "tooLarge" })
		expect((await workbook.load(2)).merges.length).toBe(16)
	})

	it("reads merged ranges as written: absolute, reversed, escaped, and skips what is not one", async () => {
		const body =
			'<sheetData/><mergeCells><mergeCell ref="$C$3:$A$1"/><mergeCell ref="D4"/><mergeCell ref="E5&#58;F6"/>' +
			'<mergeCell ref="nope"/><other ref="A1:B2"/><!-- note --><mergeCell ref=" G7 : H8 "></mergeCell></mergeCells>'
		const sheet = await (await open({ sheets: [{ body }] })).load(0)

		expect([...sheet.merges]).toEqual([0, 0, 2, 2, 3, 3, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7])
	})

	it("refuses more column ranges than a sheet has columns, before parsing them", async () => {
		const many = `<cols>${'<col min="1" max="1"/>'.repeat(16_385)}</cols><sheetData/>`
		const workbook = await open({ sheets: [{ body: many }] })

		await expect(workbook.load(0)).rejects.toMatchObject({ code: "tooLarge" })

		const nested = `<cols><col min="1" max="1">${"<x/>".repeat(16_385)}</col></cols><sheetData/>`

		await expect((await open({ sheets: [{ body: nested }] })).load(0)).rejects.toMatchObject({ code: "tooLarge" })
	})

	it("refuses a section the model parses whole when it holds a flood of elements", async () => {
		const body = `<sheetViews><sheetView workbookViewId="0">${"<selection/>".repeat(70_000)}</sheetView></sheetViews><sheetData/>`

		await expect((await open({ sheets: [{ body }] })).load(0)).rejects.toMatchObject({ code: "tooLarge" })
	})

	it("walks a large section in slices", async () => {
		const bytes = encodeUtf8(`<worksheet xmlns="${SML}"><sheetData/><extLst>${"<a/>".repeat(200_000)}</extLst></worksheet>`)
		let pauses = 0
		// Every look at the clock finds the slice used up.
		let time = 0
		const clock = sliceClock({
			sliceMs: 1,
			now: () => (time += 1),
			pause: () => {
				pauses++

				return Promise.resolve()
			}
		})
		const sheet: XlsxSheet = await readWorksheet(bytes, {
			id: 0,
			part: "xl/worksheets/sheet1.xml",
			relationships: new Relationships([]),
			limits: DEFAULT_XLSX_LIMITS,
			sharedStrings: 0,
			cellBudget: DEFAULT_XLSX_LIMITS.maxCells,
			clock,
			signal: undefined
		})

		expect(sheet.sections.map(section => section.name)).toEqual(["sheetData", "extLst"])
		expect(pauses).toBeGreaterThanOrEqual(10)
	})

	it("keeps the default cell cap below what one sheet's string table can hold", () => {
		// A JS Map holds at most 2^24 entries; a sheet's own strings are at most one per cell.
		expect(DEFAULT_XLSX_LIMITS.maxCells).toBe(5_000_000)
		expect(DEFAULT_XLSX_LIMITS.maxCells).toBeLessThan(MAX_SHEET_STRINGS)
		expect(MAX_SHEET_STRINGS).toBeLessThan(2 ** 24)
	})
})

describe("xlsx reader: rich shared strings", () => {
	it("keeps every rich entry in one byte pool and parses the same runs from it", async () => {
		const count = 10_000
		const entries: string[] = []
		const texts: string[] = []
		let richCount = 0
		let siBytes = 0

		for (let i = 0; i < count; i++) {
			const text = `s${i}`

			texts.push(text)

			if (i % 3 === 0) {
				const si = `<si><r><rPr><b/></rPr><t>${text}</t></r><r><t>!</t></r></si>`

				texts[i] = `${text}!`
				entries.push(si)
				richCount++
				siBytes += si.length
			} else {
				entries.push(`<si><t>${text}</t></si>`)
			}
		}

		const part = encodeUtf8(`<sst xmlns="${SML}" count="${count}">${entries.join("")}</sst>`)
		const strings = await readSharedStrings(part, "xl/sharedStrings.xml", DEFAULT_XLSX_LIMITS, undefined)
		const lastRich = count - 1 - ((count - 1) % 3)

		for (const index of [0, 4998, lastRich]) {
			expect(strings.isRich(index)).toBe(true)
			expect(strings.runs(index)).toEqual([
				{ text: `s${index}`, font: expect.objectContaining({ bold: true }) },
				{ text: "!", font: null }
			])
		}

		for (const index of [1, 4999, count - 2]) {
			expect(strings.isRich(index)).toBe(false)
			expect(strings.runs(index)).toBeNull()
			expect(strings.text(index)).toBe(`s${index}`)
		}

		expect(strings.isRich(count)).toBe(false)
		// The offsets, the pooled text, the rich bytes and two Uint32 per rich entry: no per-entry overhead.
		expect(strings.estimateBytes()).toBe(count * 4 + texts.join("").length * 2 + siBytes + richCount * 8)
	})
})
