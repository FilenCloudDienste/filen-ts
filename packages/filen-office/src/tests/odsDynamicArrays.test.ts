import { describe, expect, it } from "vitest"
import { strFromU8, unzipSync } from "fflate"
import { bytesSource } from "../core/opc/index"
import { openOds } from "../core/ods/open"
import { convertSheet } from "../core/ods/convert/index"
import type { SheetCommand } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { odsBytes, odsDocument, shownRows, table } from "./odsFixtures"
import { IMMEDIATE } from "./sheetSessionFixtures"

// Formulas Excel calculates as dynamic arrays, typed in an OpenDocument spreadsheet: they spill in the session, are
// written as matrix formulas over what they spill (ODF 1.3 Part 3 §19.680-§19.681) and spill again once reopened.

async function open(bytes: Uint8Array) {
	const host = inThreadSheetHost()
	const result = await host.open(
		bytes,
		{ kind: "ods", slicing: IMMEDIATE, settings: { clock: () => Date.UTC(2023, 2, 15, 12), author: "Test" } },
		() => undefined
	)

	if (result.kind !== "opened") throw new Error(result.kind === "failed" ? result.message : result.kind)

	await result.session.intent()

	return { session: result.session, sheet: result.info.sheets[0]?.id ?? 0 }
}

function set(sheet: number, row: number, col: number, input: string): SheetCommand {
	return { type: "cells.set", sheet, cells: { rows: Uint32Array.of(row), cols: Uint16Array.of(col), inputs: [input] } }
}

async function saved(session: Awaited<ReturnType<typeof open>>["session"]): Promise<Uint8Array> {
	const result = await session.save()

	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

	return result.bytes
}

async function rows(bytes: Uint8Array): Promise<string[][]> {
	const opened = await openOds(bytesSource(bytes))

	if (!opened.ok) throw new Error(opened.message)

	const document = odsDocument(opened)

	await document.readyAllSheets()

	return shownRows(document, 0)
}

const cell = (value: number): string =>
	`<table:table-cell office:value-type="float" office:value="${value}"><text:p>${value}</text:p></table:table-cell>`
const SOURCE = table(
	"One",
	[
		[1, 10],
		[2, 20],
		[3, 30]
	]
		.map(([a, b]) => `<table:table-row>${cell(a ?? 0)}${cell(b ?? 0)}</table:table-row>`)
		.join("")
)

describe("dynamic arrays typed in an ODS", () => {
	it("are taken, spill, save as matrices over their spill and recalculate after a reopen", async () => {
		const { session, sheet } = await open(odsBytes({ body: SOURCE }))

		for (const [col, input] of [
			[2, "=SEQUENCE(3)"],
			[3, "=XLOOKUP(2,A1:A3,B1:B3)"],
			[4, "=SUM(A1:A3*2)"],
			[5, "=A1:A3*2"]
		] as const) {
			const result = await session.command(set(sheet, 0, col, input))

			expect(result.ok, input).toBe(true)
		}

		const written = await saved(session)
		const xml = strFromU8(unzipSync(written)["content.xml"] ?? new Uint8Array(0))

		session.close()

		expect(await rows(written)).toEqual([
			["1", "10", "1", "20", "12", "2"],
			["2", "20", "2", "", "", "4"],
			["3", "30", "3", "", "", "6"]
		])
		expect(xml).toMatch(
			/table:formula="of:=COM\.MICROSOFT\.SEQUENCE\(3\)" table:number-matrix-columns-spanned="1" table:number-matrix-rows-spanned="3"/
		)
		expect(xml).toMatch(
			/table:formula="of:=\[\.A1:\.A3\]\*2" table:number-matrix-columns-spanned="1" table:number-matrix-rows-spanned="3"/
		)
		expect(xml).not.toContain("metadata")

		// Reopened, the matrix is a dynamic array again: an input's change reaches every cell it spills over.
		const again = await open(written)

		expect((await again.session.command(set(again.sheet, 1, 0, "5"))).ok).toBe(true)
		expect((await again.session.command(set(again.sheet, 0, 6, "=SEQUENCE(2,2)"))).ok).toBe(true)

		const edited = await saved(again.session)

		again.session.close()

		expect(await rows(edited)).toEqual([
			["1", "10", "1", "#N/A", "18", "2", "1", "2"],
			["5", "20", "2", "", "", "10", "3", "4"],
			["3", "30", "3", "", "", "6"]
		])
	})

	it("convert to SpreadsheetML as array formulas without cell metadata the package lacks", async () => {
		const { session, sheet } = await open(odsBytes({ body: SOURCE }))

		expect((await session.command(set(sheet, 0, 2, "=A1:A3*2"))).ok).toBe(true)

		const written = await saved(session)

		session.close()

		const result = await convertSheet(written, "ods", "xlsx")

		if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

		const files = unzipSync(result.bytes)
		const sheetXml = strFromU8(files["xl/worksheets/sheet1.xml"] ?? new Uint8Array(0))

		expect(sheetXml).toContain('t="array" ref="C1:C3"')
		expect(sheetXml).not.toContain(" cm=")
	})
})
