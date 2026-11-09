import { strFromU8, unzipSync } from "fflate"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { odsProof } from "../core/ods/write/save"
import type { SheetCommand, SheetCommandResult } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { odsBytes, table, type OdsParts } from "./odsFixtures"
import { IMMEDIATE } from "./sheetSessionFixtures"
import { budget, cpuMs } from "./timing"

// An OpenDocument sheet's conditional formats (LibreOffice's calcext:conditional-formats) follow rows and columns
// inserted or deleted, the sheet renamed or moved, as LibreOffice moves them: every other byte of them kept (style
// names, rules the model cannot show). An edit that changes them otherwise is refused, never saved without them.

const STYLES =
	'<style:style style:name="Default" style:family="table-cell"/>' +
	'<style:style style:name="Bad" style:family="table-cell" style:parent-style-name="Default"><style:text-properties fo:font-weight="bold"/></style:style>' +
	'<style:style style:name="Good" style:family="table-cell" style:parent-style-name="Default"><style:table-cell-properties fo:background-color="#ccffcc"/></style:style>'
const COLUMNS = '<table:table-column table:number-columns-repeated="4"/>'
const ROWS = ["1", "2", "3", "5", "4", "6"]
	.map(
		v =>
			`<table:table-row><table:table-cell table:number-columns-repeated="2"/><table:table-cell office:value-type="float" office:value="${v}"><text:p>${v}</text:p></table:table-cell></table:table-row>`
	)
	.join("")
// A comparison, a formula relative to its base cell, a colour scale, a data bar with LibreOffice's own colours and an
// icon set: those the model reads and those it carries only in part.
const FORMATS =
	"<calcext:conditional-formats>" +
	'<calcext:conditional-format calcext:target-range-address="S.C1:S.C6">' +
	'<calcext:condition calcext:apply-style-name="Bad" calcext:value="&gt;3" calcext:base-cell-address="S.C1"/>' +
	'<calcext:condition calcext:apply-style-name="Good" calcext:value="formula-is([.C1]&gt;[.$C$2])" calcext:base-cell-address="S.C1"/>' +
	"</calcext:conditional-format>" +
	'<calcext:conditional-format calcext:target-range-address="S.D1:S.D6">' +
	'<calcext:color-scale><calcext:color-scale-entry calcext:value="0" calcext:type="minimum" calcext:color="#ff0000"/><calcext:color-scale-entry calcext:value="0" calcext:type="maximum" calcext:color="#00ff00"/></calcext:color-scale>' +
	"</calcext:conditional-format>" +
	'<calcext:conditional-format calcext:target-range-address="S.B1:S.B6">' +
	'<calcext:data-bar calcext:positive-color="#638ec6" calcext:negative-color="#ff0000" calcext:axis-color="#000000"><calcext:formatting-entry calcext:value="0" calcext:type="auto-minimum"/><calcext:formatting-entry calcext:value="0" calcext:type="auto-maximum"/></calcext:data-bar>' +
	"</calcext:conditional-format>" +
	'<calcext:conditional-format calcext:target-range-address="S.A1:S.A6">' +
	'<calcext:icon-set calcext:icon-set-type="3Arrows"><calcext:formatting-entry calcext:value="0" calcext:type="percent"/><calcext:formatting-entry calcext:value="33" calcext:type="percent"/><calcext:formatting-entry calcext:value="67" calcext:type="percent"/></calcext:icon-set>' +
	"</calcext:conditional-format>" +
	"</calcext:conditional-formats>"
const PARTS: OdsParts = { styles: STYLES, body: table("S", ROWS + FORMATS, COLUMNS) }

async function open(parts: OdsParts = PARTS) {
	const host = inThreadSheetHost()
	const result = await host.open(odsBytes(parts), { kind: "ods", slicing: IMMEDIATE, settings: { author: "Test" } }, () => undefined)

	if (result.kind !== "opened") throw new Error(result.kind === "failed" ? result.message : result.kind)

	return { session: result.session, sheet: result.info.sheets[0]?.id ?? 0 }
}

type Session = Awaited<ReturnType<typeof open>>["session"]

async function run(session: Session, command: SheetCommand): Promise<SheetCommandResult> {
	return session.command(command)
}

async function ok(session: Session, command: SheetCommand): Promise<void> {
	const result = await run(session, command)

	if (!result.ok) throw new Error(`${command.type}: ${JSON.stringify(result.refusal)}`)
}

async function saved(session: Session): Promise<string> {
	const result = await session.save()

	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

	return strFromU8(unzipSync(result.bytes)["content.xml"] ?? new Uint8Array(0))
}

// The element with its attributes' text decoded, however the writer escapes it.
const decoded = (xml: string): string => xml.replaceAll("&gt;", ">").replaceAll("&apos;", "'")
const formats = (xml: string): string =>
	decoded(/<calcext:conditional-formats>[\s\S]*?<\/calcext:conditional-formats>/.exec(xml)?.[0] ?? "")

beforeAll(() => {
	odsProof.whole = true
})
afterAll(() => {
	odsProof.whole = false
})

describe("ODS conditional formats moved with the cells", () => {
	it("moves every range, base cell and reference when a row is inserted above, keeping the rest", async () => {
		const { session, sheet } = await open()

		await ok(session, { type: "axis.insert", sheet, axis: "rows", at: 0, count: 1 })

		const written = formats(await saved(session))

		expect(written).toBe(
			decoded(FORMATS)
				.replaceAll(/([A-D])1:S\.([A-D])6/g, "$12:S.$27")
				.replaceAll("S.C1", "S.C2")
				.replace("[.C1]>[.$C$2]", "[.C2]>[.$C$3]")
		)
		session.close()
	})

	it("widens the ranges when a row is inserted inside them", async () => {
		const { session, sheet } = await open()

		await ok(session, { type: "axis.insert", sheet, axis: "rows", at: 3, count: 2 })

		const written = formats(await saved(session))

		expect(written).toContain('calcext:target-range-address="S.C1:S.C8"')
		expect(written).toContain('calcext:target-range-address="S.A1:S.A8"')
		expect(written).toContain('calcext:base-cell-address="S.C1"')
		expect(written).toContain('calcext:negative-color="#ff0000" calcext:axis-color="#000000"')
		session.close()
	})

	it("moves the ranges right when a column is inserted before them", async () => {
		const { session, sheet } = await open()

		await ok(session, { type: "axis.insert", sheet, axis: "cols", at: 0, count: 1 })

		const written = formats(await saved(session))

		expect(written).toContain('calcext:target-range-address="S.D1:S.D6"')
		expect(written).toContain('calcext:target-range-address="S.B1:S.B6"')
		expect(written).toContain("formula-is([.D1]>[.$D$2])")
		expect(written).toContain('calcext:apply-style-name="Bad"')
		expect(written).toContain('calcext:apply-style-name="Good"')
		session.close()
	})

	it("narrows the ranges when a row inside them is deleted", async () => {
		const { session, sheet } = await open()

		await ok(session, { type: "axis.delete", sheet, axis: "rows", at: 4, count: 1 })

		const written = formats(await saved(session))

		expect(written).toContain('calcext:target-range-address="S.C1:S.C5"')
		expect(written).toContain('calcext:target-range-address="S.D1:S.D5"')
		session.close()
	})

	it("drops a format whose cells were all deleted, as the model does", async () => {
		const { session, sheet } = await open()

		await ok(session, { type: "axis.delete", sheet, axis: "cols", at: 0, count: 1 })

		const written = formats(await saved(session))

		expect(written).not.toContain("icon-set")
		expect(written).toContain('calcext:target-range-address="S.B1:S.B6"')
		expect(written).toContain("formula-is([.B1]>[.$B$2])")
		session.close()
	})

	it("renames the sheet in its addresses", async () => {
		const { session, sheet } = await open()

		await ok(session, { type: "sheet.rename", sheet, name: "Data 1" })

		const written = formats(await saved(session))

		expect(written).toContain("calcext:target-range-address=\"'Data 1'.C1:'Data 1'.C6\"")
		expect(written).toContain("calcext:base-cell-address=\"'Data 1'.C1\"")
		session.close()
	})

	it("writes the source's bytes when nothing moved", async () => {
		const { session, sheet } = await open()

		await ok(session, { type: "cells.set", sheet, cells: { rows: Uint32Array.of(9), cols: Uint16Array.of(0), inputs: ["x"] } })

		expect(formats(await saved(session))).toBe(decoded(FORMATS))
		session.close()
	})

	it("refuses an edit that moves a format otherwise than LibreOffice would", async () => {
		const { session, sheet } = await open()
		const result = await run(session, {
			type: "cells.shift",
			sheet,
			range: { startRow: 0, startCol: 2, endRow: 0, endCol: 2 },
			edit: "insert",
			axis: "rows"
		})

		expect(result.ok ? "ok" : result.refusal).toEqual({ reason: "unsupported", detail: "conditionalFormatting" })
		session.close()
	})

	it("refuses a copy of the sheet, which would be written without them", async () => {
		const { session, sheet } = await open()
		const result = await run(session, { type: "sheet.duplicate", sheet })

		expect(result.ok ? "ok" : result.refusal).toEqual({ reason: "unsupported", detail: "conditionalFormatting" })
		session.close()
	})

	it("takes a format's first cell now as its base cell when that row is deleted", async () => {
		const only =
			'<calcext:conditional-formats><calcext:conditional-format calcext:target-range-address="S.C1:S.C6"><calcext:condition calcext:apply-style-name="Bad" calcext:value="&gt;3" calcext:base-cell-address="S.C1"/></calcext:conditional-format></calcext:conditional-formats>'
		const { session, sheet } = await open({ styles: STYLES, body: table("S", ROWS + only, COLUMNS) })

		await ok(session, { type: "axis.delete", sheet, axis: "rows", at: 0, count: 1 })

		const written = formats(await saved(session))

		expect(written).toContain('calcext:target-range-address="S.C1:S.C5"')
		expect(written).toContain('calcext:base-cell-address="S.C1"')
		session.close()
	})

	it("refuses deleting the row a relative reference names, which LibreOffice would turn to an error", async () => {
		const { session, sheet } = await open()
		const result = await run(session, { type: "axis.delete", sheet, axis: "rows", at: 0, count: 1 })

		expect(result.ok ? "ok" : result.refusal).toEqual({ reason: "unsupported", detail: "conditionalFormatting" })
		session.close()
	})

	it("follows a sheet another sheet's format names when it is renamed", async () => {
		const other =
			'<calcext:conditional-formats><calcext:conditional-format calcext:target-range-address="T.A1:T.A3"><calcext:condition calcext:apply-style-name="Bad" calcext:value="formula-is([.A1]&gt;[S.$C$2])" calcext:base-cell-address="T.A1"/></calcext:conditional-format></calcext:conditional-formats>'
		const host = await open({ styles: STYLES, body: table("S", ROWS, COLUMNS) + table("T", ROWS + other, COLUMNS) })

		await ok(host.session, { type: "sheet.rename", sheet: host.sheet, name: "Data" })

		expect(formats(await saved(host.session))).toContain("formula-is([.A1]>[Data.$C$2])")
		host.session.close()
	})

	it("keeps another sheet's formats when one sheet is deleted or moved", async () => {
		const { session, sheet } = await open({ styles: STYLES, body: table("A", ROWS, COLUMNS) + table("S", ROWS + FORMATS, COLUMNS) })

		await ok(session, { type: "sheet.move", sheet, to: 1 })

		expect(formats(await saved(session))).toBe(decoded(FORMATS))

		await ok(session, { type: "sheet.delete", sheet })

		expect(formats(await saved(session))).toBe(decoded(FORMATS))
		session.close()
	})

	it("takes edits again once a refused one is undone, and writes the moved formats", async () => {
		const { session, sheet } = await open()
		const refused = await run(session, {
			type: "cells.shift",
			sheet,
			range: { startRow: 0, startCol: 2, endRow: 0, endCol: 2 },
			edit: "insert",
			axis: "rows"
		})

		expect(refused.ok).toBe(false)

		await ok(session, { type: "axis.insert", sheet, axis: "rows", at: 2, count: 1 })

		expect(formats(await saved(session))).toContain('calcext:target-range-address="S.C1:S.C7"')
		session.close()
	})

	it("decides a row insert on a sheet of many formats within budget", async () => {
		const many = Array.from(
			{ length: 400 },
			(_, k) =>
				`<calcext:conditional-format calcext:target-range-address="S.C${k + 1}:S.C${k + 1}"><calcext:condition calcext:apply-style-name="Bad" calcext:value="&gt;${k}" calcext:base-cell-address="S.C${k + 1}"/></calcext:conditional-format>`
		).join("")
		const { session, sheet } = await open({
			styles: STYLES,
			body: table("S", ROWS + `<calcext:conditional-formats>${many}</calcext:conditional-formats>`, COLUMNS)
		})
		const started = cpuMs()

		await ok(session, { type: "axis.insert", sheet, axis: "rows", at: 0, count: 1 })

		expect(cpuMs() - started).toBeLessThan(budget(400))
		expect(formats(await saved(session))).toContain('calcext:target-range-address="S.C401:S.C401"')
		session.close()
	})
})
