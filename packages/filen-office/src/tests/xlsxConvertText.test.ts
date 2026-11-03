import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { CellFlag, type SheetHost, type SheetOpenResult } from "@filen/office/core/sheet"
import { bytesSource, OpcPackage } from "@filen/office/core/opc"
import { inThreadSheetHost, inThreadTextHost } from "@filen/office/dom/sheet"
import { textCellsTsv } from "../core/sheet/save/cells"
import { textCellNumber, textSheetName, textWorkbookXlsx } from "../core/xlsx/convert/text"
import { newValidityErrors, schemaFamily, XsdOracle, xsdOracleMissing } from "./oracles/xsd"
import { loadAllowlist, newSdkErrors, OpenXmlSdk, openXmlSdkMissing, sdkErrorCounts } from "./oracles/openXmlSdk"
import { exportShown, sheetOffices, sheetProfile } from "./oracles/sheet/libreOffice"

// Save as .xlsx of a text file: its cells become a workbook of one sheet, numbers as Excel writes them back in
// General format becoming numbers and every other value staying the text it was; the package is read back before
// it is handed out, validates against the SpreadsheetML schemas and the Open XML SDK, and LibreOffice shows the
// same cells.

const ROWS: readonly (readonly string[])[] = [
	["Name", "Qty", "Price", "Note"],
	["Apples", "3", "1.5", "=SUM(B2:B3)"],
	["Pears", "007", "1.50", "'quoted"],
	["Plums", "-12", "1e5", "  padded  "],
	["Dates", "2024-01-02", "1,000", 'a "quoted" word'],
	["Lines", "0.25", "123456789012345", "first\nsecond"],
	["Returns", "1234567890123456", "+3", "a\rb"],
	["Escapes", "_x0041_", "\u0001bell", "émoji 😀"],
	[],
	["", "", "", "last"]
]

function host(): SheetHost {
	return inThreadSheetHost()
}

async function opened(
	target: SheetHost,
	bytes: Uint8Array,
	kind: "csv" | "tsv" | "xlsx"
): Promise<Extract<SheetOpenResult, { kind: "opened" }>> {
	const result = await target.open(bytes, { kind }, () => undefined)

	if (result.kind !== "opened") throw new Error(`did not open: ${result.kind}`)

	return result
}

// Every cell of the first tile: its shown text and whether it is a number.
async function cells(bytes: Uint8Array): Promise<Map<string, { text: string; number: boolean }>> {
	const reader = host()
	const { session, info } = await opened(reader, bytes, "xlsx")
	const { tiles } = await session.tiles(info.activeSheet, Uint32Array.of(0, 0))
	const tile = tiles[0]
	const found = new Map<string, { text: string; number: boolean }>()

	if (tile === undefined) throw new Error("no tile")

	for (let i = 0; i < tile.count; i++) {
		const position = tile.positions[i] ?? 0
		const text = tile.strings[tile.texts[i] ?? -1] ?? ""

		found.set(`${String(Math.floor(position / 32))},${String(position % 32)}`, {
			text,
			number: ((tile.flags[i] ?? 0) & CellFlag.NUMBER) !== 0
		})
	}

	reader.dispose()

	return found
}

async function convert(rows: readonly (readonly string[])[], name = "prices"): Promise<Uint8Array> {
	const result = await textWorkbookXlsx(rows, name)

	if (!result.ok) throw new Error(`refused: ${result.refusal.reason} ${result.refusal.detail ?? ""}`)

	return result.bytes
}

describe("a text file saved as .xlsx", () => {
	it("keeps as numbers only the values Excel writes back as they are", () => {
		expect(textCellNumber("3")).toBe(3)
		expect(textCellNumber("-12")).toBe(-12)
		expect(textCellNumber("1.5")).toBe(1.5)
		expect(textCellNumber("0.25")).toBe(0.25)
		expect(textCellNumber("12345678901")).toBe(12345678901)
		expect(textCellNumber("1E+20")).toBe(1e20)
		for (const text of [
			"007",
			"1.50",
			"1e5",
			"+3",
			"1,000",
			"-0",
			"123456789012345",
			"0.1234567890123456",
			" 3",
			"3 ",
			"",
			".",
			"Infinity",
			"0x10"
		])
			expect(textCellNumber(text), text).toBeNull()
	})

	it("names its sheet after the file as Excel allows", () => {
		expect(textSheetName("prices")).toBe("prices")
		expect(textSheetName("a/b:c*d?e[f]g\\h")).toBe("abcdefgh")
		expect(textSheetName("'quoted'")).toBe("quoted")
		expect(textSheetName("history")).toBe("Sheet1")
		expect(textSheetName("::")).toBe("Sheet1")
		expect(textSheetName("x".repeat(40))).toBe("x".repeat(31))
		// 31 UTF-16 code units, never half an emoji.
		expect(textSheetName("😀".repeat(20))).toBe("😀".repeat(15))
	})

	it("holds every value as shown, numbers as numbers and the rest as text", async () => {
		const shown = await cells(await convert(ROWS))
		const expected = new Map<string, { text: string; number: boolean }>()

		ROWS.forEach((row, r) => {
			row.forEach((text, c) => {
				if (text !== "") expected.set(`${String(r)},${String(c)}`, { text, number: textCellNumber(text) !== null })
			})
		})

		expect(shown).toEqual(expected)
	})

	it("opens as one sheet named after the file, with an empty file giving an empty sheet", async () => {
		const reader = host()
		const { info } = await opened(reader, await convert(ROWS, "q1/prices"), "xlsx")
		const empty = await opened(reader, await convert([], "empty"), "xlsx")

		expect(info.sheets.map(sheet => sheet.name)).toEqual(["q1prices"])
		expect(info.writability.state).not.toBe("viewOnly")
		expect(empty.info.sheets.map(sheet => sheet.name)).toEqual(["empty"])
		reader.dispose()
	})

	it("refuses what a workbook cannot hold rather than dropping it", async () => {
		const long = await textWorkbookXlsx([["x".repeat(32_768)]], "long")
		const tall: string[][] = []

		tall[1_048_576] = ["past the last row"]

		const pastRows = await textWorkbookXlsx(tall, "tall")

		expect(long).toEqual({ ok: false, refusal: { reason: "tooLarge", detail: "cellText" } })
		expect(pastRows).toEqual({ ok: false, refusal: { reason: "tooLarge", detail: "grid" } })
		expect((await textWorkbookXlsx([["x".repeat(32_767)]], "fits")).ok).toBe(true)
	})

	it("stops when aborted", async () => {
		const result = await textWorkbookXlsx(ROWS, "aborted", { signal: { aborted: true } })

		expect(result).toEqual({ ok: false, refusal: { reason: "unsupported", detail: "aborted" } })
	})

	it("moves an edited text file's cells from the text host to the workbook host, which makes the workbook", async () => {
		// As the web's two workers: the text one never loads the workbook writer.
		const textHost = inThreadTextHost()
		const workbookHost = host()
		const csv = new TextEncoder().encode('a;b\r\n"x;y";2\r\n')
		const { session } = await opened(textHost, csv, "csv")

		await session.intent()

		const edit = await session.command({
			type: "cells.set",
			sheet: 0,
			cells: { rows: Uint32Array.of(2, 2), cols: Uint16Array.of(0, 1), inputs: ["tab\there", '"lead'] }
		})

		expect(edit.ok).toBe(true)

		const handed = await session.query("saveAs.cells", {})

		if (!handed.ok) throw new Error(handed.refusal.reason)

		const moved = await opened(workbookHost, handed.bytes, "tsv")
		const xlsx = await moved.session.query("saveAs.xlsx", { name: "moved" })

		if (!xlsx.ok) throw new Error(xlsx.refusal.reason)

		expect(await cells(xlsx.bytes)).toEqual(
			new Map([
				["0,0", { text: "a", number: false }],
				["0,1", { text: "b", number: false }],
				["1,0", { text: "x;y", number: false }],
				["1,1", { text: "2", number: true }],
				["2,0", { text: "tab\there", number: false }],
				["2,1", { text: '"lead', number: false }]
			])
		)
		await expect(session.query("saveAs.xlsx", { name: "x" })).rejects.toThrow()
		textHost.dispose()
		workbookHost.dispose()
	})

	it("keeps a byte order mark that starts the first cell when the cells are handed out", async () => {
		const reader = host()
		const { session } = await opened(reader, textCellsTsv([["\uFEFFstart", "x"]]), "tsv")
		const { tiles } = await session.tiles(0, Uint32Array.of(0, 0))
		const tile = tiles[0]

		expect(tile?.strings[tile.texts[0] ?? -1]).toBe("\uFEFFstart")
		reader.dispose()
	})

	it("hands out cells that read back exactly as a TSV, whatever they hold", async () => {
		const reader = host()
		const { session } = await opened(reader, textCellsTsv(ROWS), "tsv")
		const sheet = 0
		const { tiles } = await session.tiles(sheet, Uint32Array.of(0, 0))
		const tile = tiles[0]
		const texts = new Map<string, string>()

		for (let i = 0; i < (tile?.count ?? 0); i++) {
			const position = tile?.positions[i] ?? 0

			texts.set(`${String(Math.floor(position / 32))},${String(position % 32)}`, tile?.strings[tile.texts[i] ?? -1] ?? "")
		}

		ROWS.forEach((row, r) => {
			row.forEach((text, c) => {
				if (text !== "") expect(texts.get(`${String(r)},${String(c)}`), `${String(r)},${String(c)}`).toBe(text)
			})
		})
		reader.dispose()
	})

	describe.skipIf(xsdOracleMissing() !== undefined)("against the SpreadsheetML schemas", () => {
		let oracle: XsdOracle

		beforeAll(() => {
			oracle = new XsdOracle()
		})

		afterAll(() => {
			oracle.dispose()
		})

		it("validates every part", { timeout: 60_000 }, async () => {
			const pkg = await OpcPackage.open(bytesSource(await convert(ROWS)))
			const types = await pkg.contentTypes()
			const parts = pkg.zip.entries.map(entry => entry.name).filter(name => schemaFamily(name, types.typeOf(name)) !== undefined)
			const results = oracle.validate(await Promise.all(parts.map(part => pkg.read(part))))
			// The ECMA schema has no xml:space on a shared string's t, which Excel writes to keep leading and trailing
			// spaces (the Open XML SDK's schemas allow it, below).
			const space = /\{http:\/\/www\.w3\.org\/XML\/1998\/namespace\}space/

			expect(parts.length).toBeGreaterThanOrEqual(5)
			for (const errors of results) expect(newValidityErrors(new Map(), errors).filter(error => !space.test(error))).toEqual([])
		})
	})

	describe.skipIf(openXmlSdkMissing() !== undefined)("against the Open XML SDK validator", () => {
		it("validates", { timeout: 120_000 }, async () => {
			const sdk = new OpenXmlSdk()
			const scratch = mkdtempSync(join(tmpdir(), "filen-office-convert-text-"))

			try {
				const path = join(scratch, "converted.xlsx")

				writeFileSync(path, await convert(ROWS))

				const result = await sdk.validate(path)

				expect(result.fatal).toBeUndefined()
				expect(newSdkErrors(new Map(), sdkErrorCounts(result), loadAllowlist())).toEqual([])
			} finally {
				await sdk.close()
				rmSync(scratch, { recursive: true, force: true })
			}
		})
	})

	const office = sheetOffices()[0]

	describe.skipIf(office === undefined)("in LibreOffice", () => {
		it("shows the same cells", { timeout: 180_000 }, async () => {
			if (office === undefined) return

			const scratch = mkdtempSync(join(tmpdir(), "filen-office-convert-lo-"))

			try {
				const path = join(scratch, "converted.xlsx")
				// Text LibreOffice's CSV export cannot carry as it is (a lone CR, a control character) is left out.
				const rows = ROWS.map(row => row.map(text => (text.includes("\r") || text.includes(String.fromCharCode(1)) ? "" : text)))

				writeFileSync(path, await convert(rows))

				const [shown] = await exportShown(office, sheetProfile(tmpdir(), "D-save-1"), [path], join(scratch, "out"), 60_000, false)

				expect(shown?.ok, shown?.error).toBe(true)

				const text = shown?.sheets[0]?.text ?? []

				rows.forEach((row, r) => {
					row.forEach((value, c) => {
						expect(text[r]?.[c] ?? "", `${String(r)},${String(c)}`).toBe(value)
					})
				})
			} finally {
				rmSync(scratch, { recursive: true, force: true })
			}
		})
	})
})
