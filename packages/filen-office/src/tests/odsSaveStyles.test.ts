import { describe, expect, it } from "vitest"
import { strFromU8, unzipSync } from "fflate"
import type { SheetCommand } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { odsBytes, odsContent, table, type OdsParts } from "./odsFixtures"
import { IMMEDIATE } from "./sheetSessionFixtures"

// The automatic styles an ODS save adds: only those the content names, the same ones again on the next save of the
// same content, so saving a saved file with the same edit writes the same bytes.

async function open(bytes: Uint8Array) {
	const result = await inThreadSheetHost().open(bytes.slice(), { kind: "ods", slicing: IMMEDIATE }, () => undefined)

	if (result.kind !== "opened") throw new Error(result.kind === "failed" ? result.message : result.kind)

	await result.session.intent()

	return { session: result.session, sheet: result.info.sheets[0]?.id ?? 0 }
}

function set(sheet: number, row: number, col: number, input: string): SheetCommand {
	return { type: "cells.set", sheet, cells: { rows: Uint32Array.of(row), cols: Uint16Array.of(col), inputs: [input] } }
}

async function save(bytes: Uint8Array, commands: (sheet: number) => readonly SheetCommand[]): Promise<Uint8Array> {
	const { session, sheet } = await open(bytes)

	for (const command of commands(sheet)) {
		const result = await session.command(command)

		if (!result.ok) throw new Error(`${command.type} refused`)
	}

	const saved = await session.save()

	session.close()

	if (!saved.ok) throw new Error(`${saved.reason}: ${saved.message}`)

	return saved.bytes
}

// Automatic styles content.xml declares that nothing in it names.
function unreferenced(xml: string): string[] {
	const start = xml.indexOf("<office:automatic-styles")
	const end = xml.indexOf("</office:automatic-styles>")
	const automatic = end < 0 ? "" : xml.slice(start, end)
	const rest = xml.slice(0, start) + xml.slice(end < 0 ? start : end)
	const names = [...automatic.matchAll(/<style:style style:name="([^"]+)"/g)].map(match => match[1] ?? "")
	const named = new Set([...rest.matchAll(/:(?:style-name|default-cell-style-name)="([^"]+)"/g)].map(match => match[1] ?? ""))

	for (const match of automatic.matchAll(/style:(?:data-style-name|parent-style-name)="([^"]+)"/g)) named.add(match[1] ?? "")

	return names.filter(name => !named.has(name))
}

// Row, column and cell style names content.xml gives that neither it nor styles.xml defines.
function undefinedNames(bytes: Uint8Array): string[] {
	const files = unzipSync(bytes)
	const defined = new Set(
		[strFromU8(files["content.xml"] ?? new Uint8Array(0)), strFromU8(files["styles.xml"] ?? new Uint8Array(0))].flatMap(xml =>
			[...xml.matchAll(/<style:style style:name="([^"]+)"/g)].map(match => match[1] ?? "")
		)
	)
	const body = odsContent(bytes).slice(odsContent(bytes).indexOf("<office:body"))

	return [...new Set([...body.matchAll(/table:(?:style-name|default-cell-style-name)="([^"]+)"/g)].map(match => match[1] ?? ""))].filter(
		name => !defined.has(name)
	)
}

const ROWS = Array.from(
	{ length: 6 },
	(_, row) =>
		`<table:table-row${row % 2 === 0 ? ' table:style-name="ro1"' : ""}><table:table-cell office:value-type="float" office:value="${String(row)}"><text:p>${String(row)}</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>r${String(row)}</text:p></table:table-cell></table:table-row>`
).join("")

// As LibreOffice writes one: a Default cell style and automatic row and column styles.
const LIBRE: OdsParts = {
	automatic:
		'<style:style style:name="co1" style:family="table-column"><style:table-column-properties fo:break-before="auto" style:column-width="0.889in"/></style:style><style:style style:name="ro1" style:family="table-row"><style:table-row-properties style:row-height="0.178in" fo:break-before="auto" style:use-optimal-row-height="true"/></style:style>',
	body: table(
		"One",
		ROWS,
		'<table:table-column table:style-name="co1" table:number-columns-repeated="2" table:default-cell-style-name="Default"/>'
	)
}

// As other writers do: no cell style at all, rows and columns without styles.
const BARE: OdsParts = {
	styles: "",
	body: table("One", ROWS.replaceAll(' table:style-name="ro1"', ""), '<table:table-column table:number-columns-repeated="2"/>')
}

const EDITS = (sheet: number): readonly SheetCommand[] => [
	set(sheet, 0, 3, "RT 42"),
	set(sheet, 1, 3, "12.5"),
	{ type: "format.apply", sheet, ranges: [{ startRow: 1, startCol: 3, endRow: 1, endCol: 3 }], patch: { bold: true, numFmt: "0.00" } },
	{ type: "axis.insert", sheet, axis: "rows", at: 3, count: 1 },
	{ type: "axis.delete", sheet, axis: "rows", at: 3, count: 1 }
]

const REWRITE = (sheet: number): readonly SheetCommand[] => [set(sheet, 0, 3, "x"), set(sheet, 0, 3, "RT 42")]

describe("the automatic styles of an ODS save", () => {
	for (const [label, parts] of [
		["a LibreOffice file", LIBRE],
		["a file without cell styles", BARE]
	] as const) {
		it(`are each named by the content, in ${label}`, async () => {
			const first = await save(odsBytes(parts), EDITS)

			expect(unreferenced(odsContent(first))).toEqual([])
			expect(undefinedNames(first)).toEqual([])
		})

		it(`name only defined styles for rows past the source's that a merge reaches, in ${label}`, async () => {
			const merged: OdsParts = {
				...parts,
				body: parts.body.replace(
					"</table:table-cell></table:table-row>",
					'</table:table-cell><table:table-cell table:number-rows-spanned="40" office:value-type="string"><text:p>m</text:p></table:table-cell></table:table-row>'
				)
			}
			const first = await save(odsBytes(merged), sheet => [{ type: "axis.insert", sheet, axis: "cols", at: 0, count: 1 }])

			expect(undefinedNames(first)).toEqual([])
			expect(unreferenced(odsContent(first))).toEqual([])
		})

		it(`name only defined styles where rows the edit left alone change height or hide, in ${label}`, async () => {
			const first = await save(odsBytes(parts), sheet => [
				{ type: "axis.resize", sheet, axis: "rows", indices: Uint32Array.of(3, 9), sizes: Float32Array.of(40, 30) },
				{ type: "axis.resize", sheet, axis: "rows", indices: Uint32Array.of(4), sizes: Float32Array.of(Number.NaN) }
			])

			expect(undefinedNames(first)).toEqual([])
			expect(unreferenced(odsContent(first))).toEqual([])
		})

		it(`come out the same when the saved file is saved again with the same content, in ${label}`, async () => {
			const first = await save(odsBytes(parts), EDITS)
			const second = await save(first, REWRITE)

			expect(odsContent(second)).toBe(odsContent(first))
			expect(second).toEqual(first)
		})

		it(`do not grow over repeated saves, in ${label}`, async () => {
			let bytes = odsBytes(parts)
			const sizes: number[] = []

			for (let round = 0; round < 3; round++) {
				bytes = await save(bytes, sheet => [set(sheet, 0, 5, "x"), set(sheet, 0, 5, "")])
				sizes.push(odsContent(bytes).length)
			}

			expect(sizes[2]).toBe(sizes[1])
			expect(unreferenced(odsContent(bytes))).toEqual([])
		})
	}

	it("reuse a style the source already has for the same row look", async () => {
		const first = await save(odsBytes(LIBRE), sheet => [set(sheet, 0, 3, "RT 42")])

		expect(odsContent(first)).not.toContain('style:family="table-row"><style:table-row-properties style:row-height="12.816')
		expect(unreferenced(odsContent(first))).toEqual([])
	})
})

describe("a sheet an ODS save created", () => {
	// Saved, then the saved file saved again with the same content: the rows the first save wrote fresh are the second
	// save's source rows. `target` is the sheet edited, by id (a reopened file numbers its sheets in order).
	async function twice(bytes: Uint8Array, target: number, before: readonly SheetCommand[] = []) {
		const first = await save(bytes, () => [...before, set(target, 0, 1, "RT 42"), set(target, 1, 1, "12.5")])
		const second = await save(first, () => [set(target, 0, 1, "x"), set(target, 0, 1, "RT 42")])

		return { first, second }
	}

	it("writes its rows again as they were, in a spreadsheet that had no table", async () => {
		const { first, second } = await twice(odsBytes({ body: "" }), 0)

		expect(odsContent(second)).toBe(odsContent(first))
		expect(second).toEqual(first)
	})

	it("writes its rows again as they were, for a sheet added to a file", async () => {
		const { first, second } = await twice(odsBytes(LIBRE), 1, [{ type: "sheet.add" }])

		expect(unzipSync(first)["content.xml"]).toBeDefined()
		expect(odsContent(first).split("<table:table ").length - 1).toBe(2)
		expect(odsContent(second)).toBe(odsContent(first))
		expect(second).toEqual(first)
	})
})

describe("a number format an ODS data style cannot hold", () => {
	// "?" placeholders are blanks a number:number element has no attribute for: written, they read back as "#" or "0".
	for (const code of ["?.??", "??0.00"]) {
		it(`is refused when applied, not at save, for ${code}`, async () => {
			const bytes = odsBytes(LIBRE)
			const { session, sheet } = await open(bytes)
			const result = await session.command({
				type: "format.apply",
				sheet,
				ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }],
				patch: { numFmt: code }
			})

			expect(result.ok ? null : result.refusal).toEqual({ reason: "unsupported", detail: `the number format ${code} (read back)` })

			const saved = await session.save()

			session.close()
			expect(saved.ok).toBe(true)
		})
	}

	it("is accepted when its data style reads back as it, with optional decimals", async () => {
		const first = await save(odsBytes(LIBRE), sheet => [
			{ type: "format.apply", sheet, ranges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 0 }], patch: { numFmt: "#,##0.0#" } }
		])

		expect(odsContent(first)).toContain('number:min-decimal-places="1"')
	})
})

describe("the names of the automatic styles an ODS save adds", () => {
	it("count up past those the source holds, without probing every earlier name, for thousands of styles", async () => {
		const count = 6000
		const held: OdsParts = {
			automatic: `${LIBRE.automatic ?? ""}<style:style style:name="ceF2" style:family="table-cell"><style:table-cell-properties fo:background-color="#010203"/></style:style><style:style style:name="ceF5" style:family="table-cell"><style:table-cell-properties fo:background-color="#040506"/></style:style>`,
			body: LIBRE.body
		}
		const { session, sheet } = await open(odsBytes(held))

		for (let i = 0; i < count; i++) {
			const result = await session.command({
				type: "format.apply",
				sheet,
				ranges: [{ startRow: 10 + i, startCol: 0, endRow: 10 + i, endCol: 0 }],
				patch: { fill: 0x100000 + i }
			})

			expect(result.ok).toBe(true)
		}

		// Each name tried is first looked up among those taken: the k-th new style must not try the k-1 before it again.
		const has = Set.prototype.has
		let tried = 0

		Set.prototype.has = function (this: Set<unknown>, value: unknown): boolean {
			tried++

			return has.call(this, value)
		}

		const saved = await session.save().finally(() => {
			Set.prototype.has = has
		})

		session.close()

		if (!saved.ok) throw new Error(`${saved.reason}: ${saved.message}`)

		const names = [...odsContent(saved.bytes).matchAll(/<style:style style:name="(ceF\d+)"/g)].map(match => match[1] ?? "")
		const added = names.filter(name => name !== "ceF2" && name !== "ceF5")
		const expected: string[] = []

		for (let n = 1; expected.length < added.length; n++) if (n !== 2 && n !== 5) expected.push(`ceF${String(n)}`)

		expect(added.length).toBeGreaterThanOrEqual(count)
		expect(added).toEqual(expected)
		expect(undefinedNames(saved.bytes)).toEqual([])
		expect(tried).toBeLessThan(count * 100)
	})
})
