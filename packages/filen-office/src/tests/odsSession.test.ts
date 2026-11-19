import { describe, expect, it, vi } from "vitest"
import { ODS_CHECK_BOUNDS } from "../core/ods/write/check"
import type { SheetCommand, SheetRenderStyle, SheetStyleAppend, SheetTile } from "../core/sheet/protocol"
import { ChangeLog } from "../core/xlsx/model/changes"
import type { XlsxPartWrite } from "../core/xlsx/model/types"
import { inThreadSheetHost } from "../dom/sheet/host"
import { encryptedEntry, odsBytes, table, type OdsParts } from "./odsFixtures"
import { IMMEDIATE, tileEntry } from "./sheetSessionFixtures"
import { settle } from "./sheetNotesFixtures"

// What the edit check (write/check.ts) runs, counted: rules said as validations, formulas said in OpenFormula, style
// writers made and the formats they planned.
const counted = vi.hoisted(() => ({
	validations: 0,
	formulas: [] as string[],
	writers: [] as { readonly written: number }[],
	planned: 0
}))

vi.mock("../core/ods/write/validations", async importOriginal => {
	const original = await importOriginal<typeof import("../core/ods/write/validations")>()

	return {
		...original,
		sheetValidations: (...args: Parameters<typeof original.sheetValidations>) => {
			counted.validations++

			return original.sheetValidations(...args)
		}
	}
})

vi.mock("../core/ods/formula/toOf", async importOriginal => {
	const original = await importOriginal<typeof import("../core/ods/formula/toOf")>()

	return {
		...original,
		openFormula: (...args: Parameters<typeof original.openFormula>) => {
			counted.formulas.push(args[0])

			return original.openFormula(...args)
		}
	}
})

vi.mock("../core/ods/write/styles", async importOriginal => {
	const original = await importOriginal<typeof import("../core/ods/write/styles")>()

	class CountedWriter extends original.OdsStyleWriter {
		constructor(...args: ConstructorParameters<typeof original.OdsStyleWriter>) {
			super(...args)
			counted.writers.push(this)
		}

		override cell(xf: number): string | undefined {
			counted.planned++

			return super.cell(xf)
		}
	}

	return { ...original, OdsStyleWriter: CountedWriter }
})

// An OpenDocument spreadsheet in a session of the sheet host: opened view-only, and each sheet feature reading its
// ODF source (annotations, links, validations, filters, conditional formats, print ranges, protection) as it reads a
// worksheet's.

// `author`: the name notes are written under (an edit of a note needs one).
async function open(parts: OdsParts, author?: string) {
	const host = inThreadSheetHost()
	const result = await host.open(
		odsBytes(parts),
		{ kind: "ods", slicing: IMMEDIATE, settings: { clock: () => Date.UTC(2023, 2, 15, 12), ...(author !== undefined && { author }) } },
		() => undefined
	)

	if (result.kind !== "opened") throw new Error(result.kind === "failed" ? result.message : result.kind)

	const styles: SheetRenderStyle[] = []
	const add = (append: SheetStyleAppend | undefined): void => append?.styles.forEach((style, i) => (styles[append.from + i] = style))

	add(result.info.styles)

	const sheet = result.info.sheets[0]?.id ?? 0
	const tile = async (): Promise<SheetTile> => {
		const { tiles, styles: appended } = await result.session.tiles(sheet, Uint32Array.of(0, 0))

		add(appended)

		return tiles[0] as SheetTile
	}
	const look = (from: SheetTile, row: number, col: number): SheetRenderStyle => styles[tileEntry(from, row, col)?.style ?? 0] ?? {}

	await result.session.layout(sheet)
	await settle()

	return { session: result.session, info: result.info, sheet, tile, look }
}

const NUMBERS = (values: readonly number[]): string =>
	values
		.map(
			value =>
				`<table:table-row><table:table-cell office:value-type="float" office:value="${value}"><text:p>${value}</text:p></table:table-cell></table:table-row>`
		)
		.join("")

describe("an ODS session", () => {
	it("opens unproven, proves writable and saves an edit", async () => {
		const { session, info } = await open({ body: table("One", NUMBERS([1])) })

		expect(info.kind).toBe("ods")
		expect(info.writability).toEqual({ state: "unproven" })
		expect(await session.intent()).toEqual({ state: "writable" })
		expect(
			(
				await session.command({
					type: "cells.set",
					sheet: 0,
					cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(0), inputs: ["2"] }
				})
			).ok
		).toBe(true)
		expect((await session.save()).ok).toBe(true)
		session.close()
	})

	it("refuses an encrypted package as an encryption it does not implement", async () => {
		const host = inThreadSheetHost()
		const result = await host.open(
			odsBytes({ body: table("One", NUMBERS([1])), manifestEntries: encryptedEntry("settings.xml") }),
			{ kind: "ods", slicing: IMMEDIATE },
			() => undefined
		)

		expect(result).toEqual({ kind: "refused", reason: "unsupported" })
	})

	it("shows annotations as notes with their author", async () => {
		const { session, sheet } = await open({
			body: table(
				"One",
				'<table:table-row><table:table-cell office:value-type="float" office:value="1"><office:annotation><dc:creator>Ann</dc:creator><dc:date>2023-01-01T00:00:00</dc:date><text:p>first<text:s/>note</text:p><text:p>second line</text:p></office:annotation><text:p>1</text:p></table:table-cell></table:table-row>'
			)
		})

		expect(await session.query("note.get", { sheet, row: 0, col: 0 })).toMatchObject({ text: "first note\nsecond line", author: "Ann" })
		session.close()
	})

	it("shows text:a links, to the web and into the workbook", async () => {
		const { session, sheet, info } = await open({
			body:
				table(
					"One",
					'<table:table-row><table:table-cell office:value-type="string"><text:p><text:a xlink:href="https://filen.io/">Filen</text:a></text:p></table:table-cell>' +
						'<table:table-cell office:value-type="string"><text:p><text:a xlink:href="#Two.B3">there</text:a></text:p></table:table-cell></table:table-row>'
				) + table("Two", NUMBERS([1]))
		})

		expect(await session.query("link.get", { sheet, row: 0, col: 0 })).toMatchObject({ url: "https://filen.io/" })
		expect((await session.query("link.get", { sheet, row: 0, col: 1 }))?.place).toEqual({
			sheet: info.sheets[1]?.id,
			range: { startRow: 2, startCol: 1, endRow: 2, endCol: 1 }
		})
		session.close()
	})

	it("offers a content validation's list and shows its help message", async () => {
		const { session, sheet } = await open({
			body:
				'<table:content-validations><table:content-validation table:name="val1" table:condition="of:cell-content-is-in-list(&quot;Yes&quot;;&quot;No&quot;)" table:allow-empty-cell="true" table:base-cell-address="One.A1">' +
				'<table:help-message table:title="Pick" table:display="true"><text:p>yes or no</text:p></table:help-message><table:error-message table:message-type="warning" table:display="true"/></table:content-validation>' +
				'<table:content-validation table:name="val2" table:condition="of:cell-content-is-whole-number() and cell-content-is-between(1;10)" table:base-cell-address="One.B1"/></table:content-validations>' +
				table(
					"One",
					'<table:table-row table:number-rows-repeated="3"><table:table-cell table:content-validation-name="val1"/><table:table-cell table:content-validation-name="val2"/></table:table-row>'
				)
		})
		const layout = await session.layout(sheet)

		expect(layout.extensions?.validations?.entries).toEqual([{ dropdown: true, promptTitle: "Pick", prompt: "yes or no" }])
		// One range (a quad) for the one entry laid out: the whole-number rule offers no list and shows no message.
		expect([...(layout.extensions?.validations?.ranges ?? [])]).toEqual([0, 0, 2, 0])
		expect((await session.query("validation.list", { sheet, row: 2, col: 0 }))?.items.map(item => item.text)).toEqual(["Yes", "No"])
		session.close()
	})

	it("shows a database range's filter buttons as the sheet's autofilter", async () => {
		const { session, sheet } = await open({
			body:
				table(
					"One",
					'<table:table-row><table:table-cell office:value-type="string"><text:p>h</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>i</text:p></table:table-cell></table:table-row>' +
						NUMBERS([1, 2])
				) +
				'<table:database-ranges><table:database-range table:name="__Anonymous_Sheet_DB__0" table:target-range-address="One.A1:One.B3" table:display-filter-buttons="true"/></table:database-ranges>'
		})
		const layout = await session.layout(sheet)

		// A button on each column of the header row, neither filtering.
		expect([...(layout.extensions?.filters?.ranges[0]?.buttons ?? [])]).toEqual([1, 1])
		session.close()
	})

	it("paints calcext conditional formats with their style's look", async () => {
		const { session, tile, look } = await open({
			styles: '<style:style style:name="Default" style:family="table-cell"/><style:style style:name="Bad" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ffc7ce"/><style:text-properties fo:color="#9c0006" fo:font-weight="bold"/></style:style>',
			body: table("One", NUMBERS([1, 7, 3]), "", "").replace(
				"</table:table>",
				'<calcext:conditional-formats><calcext:conditional-format calcext:target-range-address="One.A1:One.A3"><calcext:condition calcext:apply-style-name="Bad" calcext:value="&gt;5" calcext:base-cell-address="One.A1"/></calcext:conditional-format></calcext:conditional-formats></table:table>'
			)
		})
		const first = await tile()

		expect(look(first, 1, 0)).toMatchObject({ bold: true, color: 0x9c0006, fill: 0xffc7ce })
		expect(look(first, 0, 0).fill).toBeUndefined()
		session.close()
	})

	it("gives the print range and the header rows as the print area and titles", async () => {
		const { session, sheet } = await open({
			body: table(
				"One",
				`<table:table-header-rows>${NUMBERS([0])}</table:table-header-rows>${NUMBERS([1, 2, 3])}`,
				"",
				' table:print-ranges="One.A1:One.B3"'
			)
		})
		const answer = await session.query("print.settings", { sheet })

		expect(answer?.setup).toMatchObject({
			titleRows: { first: 0, last: 0 },
			printArea: [{ startRow: 0, startCol: 0, endRow: 2, endCol: 1 }]
		})
		session.close()
	})

	it("lays out a protected sheet with what it allows", async () => {
		const { session, sheet } = await open({
			body: table(
				"One",
				NUMBERS([1]),
				"",
				' table:protected="true" table:protection-key="abc" table:protection-key-digest-algorithm="http://www.w3.org/2000/09/xmldsig#sha256"'
			).replace(
				"<table:table-row>",
				'<loext:table-protection loext:select-unprotected-cells="true" loext:select-protected-cells="false"/><table:table-row>'
			)
		})
		const layout = await session.layout(sheet)

		expect(layout.protection?.hasPassword).toBe(true)
		expect([...(layout.protection?.allows ?? [])]).toEqual(["selectUnlockedCells"])
		session.close()
	})
})

describe("an ODS save under way", () => {
	it("stops at its next slice once the session is closed", { timeout: 60_000 }, async () => {
		let rows = ""

		for (let k = 0; k < 4000; k++)
			rows += `<table:table-row><table:table-cell office:value-type="float" office:value="${k}"><text:p>${k}</text:p></table:table-cell></table:table-row>`

		let pauses = 0
		let close: (() => void) | null = null
		let pausesAfterClose = -1
		const slicing = {
			sliceMs: 0,
			now: () => performance.now(),
			pause: (): Promise<void> => {
				pauses++

				if (pausesAfterClose >= 0) pausesAfterClose++

				// Closed in the save's third slice.
				if (close !== null && pauses === 3) {
					close()
					pausesAfterClose = 0
				}

				return new Promise(resolve => setTimeout(resolve, 0))
			}
		}
		const host = inThreadSheetHost()
		const result = await host.open(
			odsBytes({ body: table("S", rows) }),
			{ kind: "ods", slicing, settings: { author: "Test" } },
			() => undefined
		)

		if (result.kind !== "opened") throw new Error(result.kind)

		const session = result.session

		await session.intent()
		await session.command({ type: "axis.insert", sheet: result.info.sheets[0]?.id ?? 0, axis: "cols", at: 0, count: 1 })

		pauses = 0
		close = () => session.close()

		const saved = await session.save()

		expect(saved.ok ? "ok" : saved.reason).toBe("closed")
		// The slice under way when it closed ends it: no further slice of the save runs.
		expect(pausesAfterClose).toBeLessThanOrEqual(1)
	})
})

describe("the check of an ODS edit", () => {
	const RULE = {
		type: "whole",
		operator: "between",
		value1: "1",
		value2: "10",
		allowBlank: true,
		inCellDropdown: true,
		showInputMessage: false,
		promptTitle: "",
		prompt: "",
		showErrorMessage: false,
		errorStyle: "stop",
		errorTitle: "",
		error: ""
	} as const

	const set = (sheet: number, row: number, col: number, input: string): SheetCommand => ({
		type: "cells.set",
		sheet,
		cells: { rows: Uint32Array.of(row), cols: Uint16Array.of(col), inputs: [input] }
	})

	async function writable(parts: OdsParts) {
		const opened = await open(parts, "Test")

		expect(await opened.session.intent()).toEqual({ state: "writable" })

		const run = async (command: SheetCommand): Promise<boolean> => (await opened.session.command(command)).ok

		return { ...opened, run }
	}

	it("does not write a note's drawing again for a later edit that left the notes alone", async () => {
		const original = ChangeLog.prototype.writePart
		let drawn = 0
		const spy = vi.spyOn(ChangeLog.prototype, "writePart").mockImplementation(function (
			this: ChangeLog,
			name: string,
			write: XlsxPartWrite
		) {
			original.call(
				this,
				name,
				name.endsWith(".vml")
					? {
							contentType: write.contentType,
							write: (...args: Parameters<XlsxPartWrite["write"]>) => {
								drawn++

								return write.write(...args)
							}
						}
					: write
			)
		})

		try {
			const { session, sheet, run } = await writable({ body: table("One", NUMBERS([1, 2, 3])) })

			expect(await run({ type: "note.set", sheet, row: 0, col: 0, text: "a note" })).toBe(true)
			expect(drawn).toBeGreaterThan(0)

			const before = drawn

			expect(await run(set(sheet, 1, 0, "5"))).toBe(true)
			expect(await run(set(sheet, 2, 0, "6"))).toBe(true)
			expect(drawn).toBe(before)

			// A note shown all the time is still refused: the edit that shows it marks the drawing.
			expect(await run({ type: "note.show", sheet, row: 0, col: 0, shown: true })).toBe(false)
			session.close()
		} finally {
			spy.mockRestore()
		}
	})

	it("says a sheet's validations again only for an edit that changed them or renamed a sheet", async () => {
		const { session, sheet, run } = await writable({ body: table("One", NUMBERS([1, 2, 3])) })

		expect(await run({ type: "validation.set", sheet, ranges: [{ startRow: 0, startCol: 1, endRow: 2, endCol: 1 }], rule: RULE })).toBe(
			true
		)

		const afterRule = counted.validations

		expect(await run(set(sheet, 1, 0, "5"))).toBe(true)
		expect(counted.validations).toBe(afterRule)

		// A rename changes the sheet name the rules are said under: they are said again.
		expect(await run({ type: "sheet.rename", sheet, name: "Renamed" })).toBe(true)
		expect(counted.validations).toBeGreaterThan(afterRule)

		// A rule ODF cannot say is refused as before.
		expect(
			await run({
				type: "validation.set",
				sheet,
				ranges: [{ startRow: 0, startCol: 2, endRow: 0, endCol: 2 }],
				rule: { ...RULE, type: "list", value1: "=Sheet9:Sheet10!A1:A3", value2: "" }
			})
		).toBe(false)

		// Undone and done again, the session saves what the checks accepted.
		await session.undo()
		await session.redo()
		expect((await session.save()).ok).toBe(true)
		session.close()
	})

	it("keeps a bounded number of formula texts and gives the same verdicts once it starts over", async () => {
		const { session, sheet } = await writable({ body: table("One", NUMBERS([1])) })
		const count = ODS_CHECK_BOUNDS.formulas + 8
		const inputs = Array.from({ length: count }, (_, i) => `=A1+${String(i)}`)
		const filled = await session.command({
			type: "cells.set",
			sheet,
			cells: { rows: Uint32Array.from({ length: count }, (_, i) => i + 1), cols: new Uint16Array(count).fill(1), inputs }
		})

		expect(filled.ok).toBe(true)

		// The first text was forgotten when the cache started over: said again, with the same verdict.
		const said = counted.formulas.length
		const again = await session.command(set(sheet, 0, 2, "=A1+0"))

		expect(again.ok).toBe(true)
		expect(counted.formulas.length).toBe(said + 1)

		// The last ones are still known.
		const known = await session.command(set(sheet, 0, 3, `=A1+${String(count - 1)}`))

		expect(known.ok).toBe(true)
		expect(counted.formulas.length).toBe(said + 1)
		session.close()
	})

	it("starts its style writer over past its bound and keeps each format's verdict", async () => {
		const { session, sheet } = await writable({ body: table("One", NUMBERS([1])) })
		const firstWriter = counted.writers.length

		for (let i = 0; i <= ODS_CHECK_BOUNDS.styles + 4; i++) {
			const result = await session.command({
				type: "format.apply",
				sheet,
				ranges: [{ startRow: i, startCol: 0, endRow: i, endCol: 0 }],
				patch: { fill: 0x100000 + i }
			})

			expect(result.ok).toBe(true)
		}

		const writers = counted.writers.slice(firstWriter)

		expect(writers.length).toBeGreaterThan(1)

		for (const writer of writers) expect(writer.written).toBeLessThanOrEqual(ODS_CHECK_BOUNDS.styles + 4)

		// A format checked before, given to another cell: its verdict is reused, nothing is planned.
		const planned = counted.planned
		const reused = await session.command({
			type: "format.apply",
			sheet,
			ranges: [{ startRow: 0, startCol: 3, endRow: 0, endCol: 3 }],
			patch: { fill: 0x100000 }
		})

		expect(reused.ok).toBe(true)
		expect(counted.planned).toBe(planned)
		session.close()
	})
})
