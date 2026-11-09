import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import { openOds } from "../core/ods/open"
import type { SheetCommand } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { ODS_NS, odsBytes, odsDocument, shownRows, table, type OdsParts } from "./odsFixtures"
import { IMMEDIATE } from "./sheetSessionFixtures"
import { unzipSync, strFromU8 } from "fflate"

// Saving an OpenDocument spreadsheet: an untouched save is the source, an edit rewrites only what it changed, and
// every save reads back as the session shows it.

async function open(parts: OdsParts | Uint8Array) {
	const host = inThreadSheetHost()
	const bytes = parts instanceof Uint8Array ? parts : odsBytes(parts)
	const result = await host.open(
		bytes,
		{ kind: "ods", slicing: IMMEDIATE, settings: { clock: () => Date.UTC(2023, 2, 15, 12), author: "Test" } },
		() => undefined
	)

	if (result.kind !== "opened") throw new Error(result.kind === "failed" ? result.message : result.kind)

	const session = result.session
	const verdict = await session.intent()

	return { session, bytes, verdict, sheet: result.info.sheets[0]?.id ?? 0 }
}

function set(sheet: number, row: number, col: number, input: string): SheetCommand {
	return { type: "cells.set", sheet, cells: { rows: Uint32Array.of(row), cols: Uint16Array.of(col), inputs: [input] } }
}

async function saved(session: Awaited<ReturnType<typeof open>>["session"]): Promise<Uint8Array> {
	const result = await session.save()

	if (!result.ok) throw new Error(`${result.reason}: ${result.message}`)

	return result.bytes
}

async function rows(bytes: Uint8Array, sheet = 0): Promise<string[][]> {
	const opened = await openOds(bytesSource(bytes))

	if (!opened.ok) throw new Error(opened.message)

	const document = odsDocument(opened)

	await document.readyAllSheets()

	return shownRows(document, sheet)
}

function content(bytes: Uint8Array): string {
	return strFromU8(unzipSync(bytes)["content.xml"] ?? new Uint8Array(0))
}

const ROWS =
	'<table:table-column table:number-columns-repeated="3"/><table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>a</text:p></table:table-cell><table:table-cell table:formula="of:=[.A1]*2" office:value-type="float" office:value="2"><text:p>2</text:p></table:table-cell></table:table-row><table:table-row table:number-rows-repeated="3"><table:table-cell office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/></table:table-row>'

describe("an ODS save", () => {
	it("is writable and saves untouched as the source's bytes", async () => {
		const { session, bytes, verdict } = await open({ body: table("One", "", ROWS) })

		expect(verdict.state).toBe("writable")
		expect(await saved(session)).toEqual(bytes)
		session.close()
	})

	it("writes an edited cell, copying the rows it left alone", async () => {
		const { session, sheet } = await open({ body: table("One", "", ROWS) })
		const result = await session.command(set(sheet, 0, 1, "hello"))

		expect(result.ok).toBe(true)

		const written = await saved(session)

		expect(await rows(written)).toEqual([["1", "hello", "2"], ["7"], ["7"], ["7"]])
		expect(content(written)).toContain(
			'<table:table-row table:number-rows-repeated="3"><table:table-cell office:value-type="float" office:value="7"><text:p>7</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/></table:table-row>'
		)
		session.close()
	})

	it("splits a repeated row an edit cut into", async () => {
		const { session, sheet } = await open({ body: table("One", "", ROWS) })

		await session.command(set(sheet, 2, 0, "8"))

		const written = await saved(session)

		expect(await rows(written)).toEqual([["1", "a", "2"], ["7"], ["8"], ["7"]])
		session.close()
	})

	it("recalculates and writes a formula's result and keeps its OpenFormula", async () => {
		const { session, sheet } = await open({ body: table("One", "", ROWS) })

		await session.command(set(sheet, 0, 0, "5"))

		const written = await saved(session)

		expect(await rows(written)).toEqual([["5", "a", "10"], ["7"], ["7"], ["7"]])
		expect(content(written)).toContain('table:formula="of:=[.A1]*2"')
		session.close()
	})

	it("marks an error result with LibreOffice's calcext only where the document already declares it", async () => {
		const strict = ODS_NS.split(" ")
			.filter(declaration => !declaration.startsWith("xmlns:calcext="))
			.join(" ")

		for (const [namespaces, marked] of [
			[ODS_NS, true],
			[strict, false]
		] as const) {
			const { session, sheet } = await open({ namespaces, body: table("One", "", ROWS) })

			await session.command(set(sheet, 1, 1, "=1/0"))

			const written = await saved(session)

			expect(content(written).includes('calcext:value-type="error"')).toBe(marked)
			expect((await rows(written))[1]).toEqual(["7", "#DIV/0!"])
			session.close()
		}
	})

	it("writes an error typed in a document without calcext as a formula of that error alone, reading back as it", async () => {
		const strict = ODS_NS.split(" ")
			.filter(declaration => !declaration.startsWith("xmlns:calcext="))
			.join(" ")
		const { session, sheet } = await open({ namespaces: strict, body: table("One", "", ROWS) })

		for (const [row, error] of ["#N/A", "#DIV/0!", "#NAME?", "#NUM!", "#REF!", "#VALUE!"].entries()) {
			expect((await session.command(set(sheet, 4 + row, 0, error))).ok).toBe(true)
		}

		const written = await saved(session)
		const xml = content(written)

		expect(xml).toContain('table:formula="of:=#N/A" office:value-type="float" office:value="0"><text:p>#N/A</text:p>')
		expect(xml).not.toContain("calcext:value-type")
		expect((await rows(written)).slice(4)).toEqual([["#N/A"], ["#DIV/0!"], ["#NAME?"], ["#NUM!"], ["#REF!"], ["#VALUE!"]])
		session.close()
	})

	it("refuses there #NULL!, which LibreOffice does not read back from its OpenFormula constant as the same error", async () => {
		const strict = ODS_NS.split(" ")
			.filter(declaration => !declaration.startsWith("xmlns:calcext="))
			.join(" ")
		const { session, sheet } = await open({ namespaces: strict, body: table("One", "", ROWS) })

		for (const error of ["#NULL!"]) {
			const result = await session.command(set(sheet, 1, 1, error))

			expect([error, result.ok ? null : result.refusal]).toEqual([error, { reason: "unsupported", detail: "errorValue" }])
		}

		expect(await saved(session)).toEqual(odsBytes({ namespaces: strict, body: table("One", "", ROWS) }))
		session.close()
	})

	it("keeps a frame anchored to a cell written again once, its image inside it", async () => {
		const frame =
			'<draw:frame draw:name="Image 1" svg:width="1cm" svg:height="1cm" svg:x="0cm" svg:y="0cm"><draw:image xlink:href="Pictures/a.png" xlink:type="simple"><text:p/></draw:image></draw:frame>'
		const { session, sheet } = await open({
			body: table(
				"One",
				`<table:table-row><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p>${frame}</table:table-cell></table:table-row>`
			)
		})

		await session.command(set(sheet, 0, 0, "2"))

		const xml = content(await saved(session))

		expect(xml).toContain(`<text:p>2</text:p>${frame}</table:table-cell>`)
		expect(xml.split("<draw:image").length - 1).toBe(1)
		session.close()
	})

	it("keeps a date cell's calendar date under any null date (ODF 1.3 Part 3 §19.379, §19.639)", async () => {
		const body =
			'<table:calculation-settings><table:null-date table:date-value="1900-01-01"/></table:calculation-settings>' +
			table(
				"One",
				'<table:table-row><table:table-cell office:value-type="date" office:date-value="2024-01-01"><text:p>2024-01-01</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="1"><text:p>1</text:p></table:table-cell></table:table-row>'
			)
		const { session, sheet } = await open({ body })

		// The date (45292 on the engine's 1899-12-30 base) shows in the standard date format: it has no data style.
		expect((await rows(odsBytes({ body })))[0]?.[0]).toBe("1/1/2024")

		await session.command(set(sheet, 0, 1, "2"))

		const unrelated = content(await saved(session))

		expect(unrelated).toContain('office:date-value="2024-01-01"')
		expect(unrelated).toContain('<table:null-date table:date-value="1900-01-01"/>')

		await session.command(set(sheet, 0, 0, "2024-02-01"))

		const typed = content(await saved(session))

		expect(typed).toContain('office:date-value="2024-02-01"')
		expect(typed).not.toContain('office:date-value="2024-01-01"')
		session.close()
	})
})

// ODF 1.3 Part 2 §3.8: the preview shows the document as it opens; a save that rewrites it cannot redraw it.
describe("an ODS save's preview image", () => {
	const THUMBNAIL = "Thumbnails/thumbnail.png"
	const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
	const withPreview = (parts: Partial<OdsParts> = {}): Uint8Array =>
		odsBytes({ body: table("One", "", ROWS), extra: [{ name: THUMBNAIL, data: PNG }], ...parts })
	const manifest = (bytes: Uint8Array): string => strFromU8(unzipSync(bytes)["META-INF/manifest.xml"] ?? new Uint8Array(0))

	it("is dropped with its manifest entry once a cell is edited", async () => {
		const { session, sheet } = await open(withPreview())

		await session.command(set(sheet, 0, 1, "hello"))

		const written = await saved(session)

		expect(Object.keys(unzipSync(written))).not.toContain(THUMBNAIL)
		expect(manifest(written)).not.toContain(THUMBNAIL)
		expect(manifest(written)).toContain('manifest:full-path="content.xml"')
		expect(await rows(written)).toEqual([["1", "hello", "2"], ["7"], ["7"], ["7"]])
		session.close()
	})

	it("is kept by a save that writes nothing new", async () => {
		const { session, sheet, bytes } = await open(withPreview())

		expect(await saved(session)).toEqual(bytes)

		await session.command(set(sheet, 0, 1, "hello"))
		await session.undo()

		const written = await saved(session)

		expect(unzipSync(written)[THUMBNAIL]).toEqual(PNG)
		expect(manifest(written)).toContain(THUMBNAIL)
		session.close()
	})

	it("is dropped while a new settings.xml is listed in the same manifest", async () => {
		const { session, sheet } = await open(withPreview())

		await session.command({ type: "view.freeze", sheet, rows: 2, cols: 0 })

		const written = await saved(session)
		const files = unzipSync(written)

		expect(Object.keys(files)).toContain("settings.xml")
		expect(Object.keys(files)).not.toContain(THUMBNAIL)
		expect(manifest(written)).toContain('manifest:full-path="settings.xml"')
		expect(manifest(written)).not.toContain(THUMBNAIL)
		session.close()
	})
})
