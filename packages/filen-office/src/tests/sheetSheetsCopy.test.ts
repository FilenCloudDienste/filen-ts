import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bytesSource } from "../core/opc/index"
import type { SheetChange, SheetCommandResult } from "../core/sheet/protocol"
import { openXlsx } from "../core/xlsx/read/index"
import { CORPUS_DIR } from "./corpusDir"
import { OpenXmlSdk, openXmlSdkMissing, sdkErrorCounts } from "./oracles/openXmlSdk"
import { parts } from "./xlsxWriteFixtures"
import { cells, firstTile, openFixture, savedBytes, tileEntry } from "./sheetSessionFixtures"
import { R, TYPES, relationship } from "./xlsxRefsFixtures"

// Sheets duplicated: cells, formats, sections, local names, and the parts cloned for the copy (drawings with their
// charts retargeted, notes, tables under new names), each save passing the gate and reading back.

function changeOf(result: SheetCommandResult): SheetChange {
	if (!result.ok)
		throw new Error(`refused: ${result.refusal.reason}${result.refusal.detail === undefined ? "" : ` (${result.refusal.detail})`}`)

	return result.change
}

function corpus(name: string): Uint8Array | null {
	const path = join(CORPUS_DIR, name)

	return existsSync(path) ? new Uint8Array(readFileSync(path)) : null
}

async function reread(bytes: Uint8Array): Promise<string[]> {
	const opened = await openXlsx(bytesSource(bytes))

	if (!opened.ok) throw new Error(opened.reason)

	return opened.workbook.sheets.map(sheet => sheet.name)
}

describe("sheet session: sheets duplicated", () => {
	it("copies cells, formats, merges, conditional formats and local names next to the source, and undoes to it", async () => {
		const { session, info, bytes } = await openFixture({
			sheets: [
				{
					name: "One",
					body:
						'<sheetPr codeName="Sheet1"><tabColor rgb="FFFF0000"/></sheetPr><sheetData><row r="1" ht="30" customHeight="1"><c r="A1" s="1"><v>45000</v></c><c r="B1"><f>A1+1</f><v>45001</v></c></row></sheetData>' +
						'<mergeCells count="1"><mergeCell ref="C1:D1"/></mergeCells><conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>A1&gt;0</formula></cfRule></conditionalFormatting>'
				},
				{ name: "Two", body: "<sheetData/>" }
			],
			workbookTail: '<definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">One!$A$1:$B$2</definedName></definedNames>'
		})
		const one = info.sheets[0]!.id
		const change = changeOf(await session.command({ type: "sheet.duplicate", sheet: one }))

		expect(change.sheets?.map(sheet => sheet.name)).toEqual(["One", "One (2)", "Two"])

		const copy = change.sheets?.[1]?.id ?? -1

		expect(tileEntry(await firstTile(session, copy), 0, 1)?.input).toBe("=A1+1")

		const saved = parts(await savedBytes(session))
		const workbook = saved["xl/workbook.xml"] ?? ""
		const sheet = saved["xl/worksheets/sheet3.xml"] ?? ""

		expect(workbook).toContain('<definedName name="_xlnm.Print_Area" localSheetId="1">\'One (2)\'!$A$1:$B$2</definedName>')
		expect(sheet).toContain('<tabColor rgb="FFFF0000"/>')
		expect(sheet).not.toContain("codeName")
		expect(sheet).toContain('<row r="1" ht="30" customHeight="1">')
		expect(sheet).toContain('<c r="A1" s="1"><v>45000</v></c><c r="B1"><f>A1+1</f><v>45001</v></c>')
		expect(sheet).toContain('<mergeCell ref="C1:D1"/>')
		expect(sheet).toContain("<formula>A1&gt;0</formula>")

		// The copy edits on its own, and its rows move with the catalogue.
		changeOf(await session.command({ type: "cells.set", sheet: copy, cells: cells([[0, 0, "7"]]) }))
		changeOf(await session.command({ type: "axis.insert", sheet: copy, axis: "rows", at: 0, count: 1 }))

		const edited = parts(await savedBytes(session))["xl/worksheets/sheet3.xml"] ?? ""

		expect(edited).toContain('<conditionalFormatting sqref="A2">')
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])

		for (let k = 0; k < 3; k++) changeOf(await session.undo())

		const undone = parts(await savedBytes(session))

		expect(undone["xl/worksheets/sheet3.xml"]).toBeUndefined()
		expect(undone["xl/workbook.xml"]).toBe(parts(bytes)["xl/workbook.xml"])
		expect(undone["xl/_rels/workbook.xml.rels"]).toBe(parts(bytes)["xl/_rels/workbook.xml.rels"])
		session.close()
	})

	it("clones a table under a new name, and the copy's structured references follow it", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body:
						'<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>K</t></is></c></row><row r="2"><c r="A2"><v>1</v></c><c r="C2"><f>SUM(T[K])</f><v>1</v></c></row></sheetData>' +
						'<tableParts count="1"><tablePart r:id="rId1"/></tableParts>',
					rels: relationship("rId1", "table", "../tables/table1.xml")
				}
			],
			parts: {
				"xl/tables/table1.xml": {
					text:
						'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T" displayName="T" ref="A1:A2">' +
						'<autoFilter ref="A1:A2"/><tableColumns count="1"><tableColumn id="1" name="K"/></tableColumns></table>',
					type: TYPES.table
				}
			}
		})

		changeOf(await session.command({ type: "sheet.duplicate", sheet: info.sheets[0]!.id }))

		const saved = parts(await savedBytes(session))

		expect(saved["xl/tables/table2.xml"]).toContain('id="2" name="T_2" displayName="T_2"')
		expect(saved["xl/worksheets/sheet2.xml"]).toContain("<f>SUM(T_2[K])</f>")
		expect(saved["xl/worksheets/sheet2.xml"]).toContain('<tablePart r:id="rId1"/>')
		expect(saved["xl/worksheets/_rels/sheet2.xml.rels"]).toContain('Target="/xl/tables/table2.xml"')
		expect(saved["[Content_Types].xml"]).toContain("/xl/tables/table2.xml")
		session.close()
	})

	it("shows the results the session calculated for formulas the file keeps none for", async () => {
		const { session, info } = await openFixture({
			sheets: [{ name: "One", body: '<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>A1*2</f></c></row></sheetData>' }]
		})
		const one = info.sheets[0]!.id

		// An edit builds the engine, which calculates B1.
		changeOf(await session.command({ type: "cells.set", sheet: one, cells: cells([[5, 5, "x"]]) }))
		expect(tileEntry(await firstTile(session, one), 0, 1)?.text).toBe("2")

		const change = changeOf(await session.command({ type: "sheet.duplicate", sheet: one }))

		expect(tileEntry(await firstTile(session, change.sheets?.[1]?.id ?? -1), 0, 1)?.text).toBe("2")
		session.close()
	})

	it("gives a copy of a sheet added since open a part of its own", async () => {
		const { session } = await openFixture({ sheets: [{ name: "One", body: "<sheetData/>" }] })
		const added = changeOf(await session.command({ type: "sheet.add", name: "Two" }))
		const two = added.sheets?.find(sheet => sheet.name === "Two")?.id ?? -1
		const copied = changeOf(await session.command({ type: "sheet.duplicate", sheet: two }))
		const bytes = await savedBytes(session)

		expect(await reread(bytes)).toEqual(copied.sheets?.map(sheet => sheet.name))
		session.close()
	})

	it("refuses what it cannot clone, naming it", async () => {
		const { session, info } = await openFixture({
			sheets: [{ name: "One", body: "<sheetData/>", rels: relationship("rId1", "pivotTable", "../pivotTables/pivotTable1.xml") }],
			parts: {
				"xl/pivotTables/pivotTable1.xml": {
					text: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="P" cacheId="1"><location ref="A1:B2" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/></pivotTableDefinition>',
					type: TYPES.pivotTable
				}
			}
		})
		const result = await session.command({ type: "sheet.duplicate", sheet: info.sheets[0]!.id })

		expect(result.ok ? null : result.refusal).toEqual({ reason: "structureLocked", detail: "relationship pivotTable" })
		session.close()
	})

	for (const [name, check] of [
		[
			"xlsx/xlsxwriter__chart_pie01.xlsx",
			(files: Record<string, string>) =>
				expect(Object.keys(files).filter(file => /^xl\/charts\/chart\d+\.xml$/.test(file)).length).toBe(2)
		],
		[
			"xlsx/xlsxwriter__comment01.xlsx",
			(files: Record<string, string>) => expect(Object.keys(files).filter(file => /^xl\/comments\d+\.xml$/.test(file)).length).toBe(2)
		],
		[
			"xlsx/xlsxwriter__table10.xlsx",
			(files: Record<string, string>) =>
				expect(Object.keys(files).filter(file => /^xl\/tables\/table\d+\.xml$/.test(file)).length).toBe(2)
		]
	] as const) {
		it.skipIf(corpus(name) === null)(`duplicates a corpus sheet with its parts: ${name}`, async () => {
			const { session, info } = await openFixture(corpus(name) as Uint8Array)
			const change = changeOf(await session.command({ type: "sheet.duplicate", sheet: info.sheets[0]!.id }))
			const bytes = await savedBytes(session)
			const files = parts(bytes)

			check(files)
			expect(await reread(bytes)).toEqual(change.sheets?.map(sheet => sheet.name))

			if (name.includes("chart")) {
				const charts = Object.keys(files).filter(file => /^xl\/charts\/chart\d+\.xml$/.test(file))
				const copyName = change.sheets?.[1]?.name ?? ""

				expect(charts.some(file => (files[file] ?? "").includes(`'${copyName}'!`))).toBe(true)
			}

			if (name.includes("comment")) {
				const vml = Object.keys(files)
					.filter(file => file.endsWith(".vml"))
					.map(file => /data="(\d+)"/.exec(files[file] ?? "")?.[1])

				expect(new Set(vml).size).toBe(vml.length)
			}

			session.close()
		})
	}
})

// Names a file can hold that Excel would refuse: no " (n)" suffix cures them, so the copy's name is cleaned first.
describe("sheet session: duplicating sheets whose names Excel would refuse", () => {
	const valid = (name: string): boolean =>
		/^[^\\/?*[\]:]{1,31}$/.test(name) &&
		!name.startsWith("'") &&
		!name.endsWith("'") &&
		!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(name)

	for (const [source, first, second] of [
		["Report 01/2024", "Report 01_2024 (2)", "Report 01_2024 (3)"],
		["a:b", "a_b (2)", "a_b (3)"],
		["'x", "x (2)", "x (3)"],
		["A".repeat(26) + "\u{1f600}BBB", `${"A".repeat(26)} (2)`, `${"A".repeat(26)} (3)`]
	] as const)
		it(`gives a copy of ${JSON.stringify(source)} a valid, unique name`, { timeout: 5_000 }, async () => {
			const { session, info } = await openFixture({ sheets: [{ name: source, body: "<sheetData/>" }] })
			const id = info.sheets[0]!.id
			const once = changeOf(await session.command({ type: "sheet.duplicate", sheet: id })).sheets?.map(sheet => sheet.name)
			const twice = changeOf(await session.command({ type: "sheet.duplicate", sheet: id })).sheets?.map(sheet => sheet.name)

			expect(once).toEqual([source, first])
			expect(twice).toEqual([source, second, first])
			expect([first, second].every(valid)).toBe(true)
			session.close()
		})
})

describe("sheet session: a duplicate undone and redone", () => {
	it("gives the copy back the very relationships its markup names, two to one target included", async () => {
		const link = (id: string): string =>
			`<Relationship Id="${id}" Type="${R}/hyperlink" Target="https://filen.io/" TargetMode="External"/>`
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetData/><hyperlinks><hyperlink ref="A1" r:id="rId1"/><hyperlink ref="B1" r:id="rId2"/></hyperlinks>',
					rels: link("rId1") + link("rId2")
				}
			]
		})

		changeOf(await session.command({ type: "sheet.duplicate", sheet: info.sheets[0]!.id }))
		changeOf(await session.undo())
		changeOf(await session.redo())

		const files = parts(await savedBytes(session))
		const part = sheetPartOf(files, "One (2)")
		const ids = [...(files[part] ?? "").matchAll(/<hyperlink [^>]*r:id="([^"]+)"/g)].map(match => match[1])
		const relsPart = part.replace(/([^/]+)$/, "_rels/$1.rels")
		const related = [...(files[relsPart] ?? "").matchAll(/<Relationship [^>]*Id="([^"]+)"/g)].map(match => match[1])

		expect(ids).toHaveLength(2)
		expect([...ids].sort()).toEqual([...related].sort())
		session.close()
	})
})

const TABLE_SHEET = {
	sheets: [
		{
			name: "One",
			body:
				'<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>K</t></is></c></row><row r="2"><c r="A2"><v>1</v></c><c r="C2"><f>SUM(T[K])</f><v>1</v></c></row></sheetData>' +
				'<tableParts count="1"><tablePart r:id="rId1"/></tableParts>',
			rels: relationship("rId1", "table", "../tables/table1.xml")
		}
	],
	parts: {
		"xl/tables/table1.xml": {
			text:
				'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="T" displayName="T" ref="A1:A2">' +
				'<autoFilter ref="A1:A2"/><tableColumns count="1"><tableColumn id="1" name="K"/></tableColumns></table>',
			type: TYPES.table
		}
	}
}

function savedTables(files: Record<string, string>): { part: string; id: string; name: string; ref: string }[] {
	return Object.keys(files)
		.filter(file => /^xl\/tables\/table\d+\.xml$/.test(file))
		.sort()
		.map(file => {
			const root = /<table\b[^>]*>/.exec(files[file] ?? "")?.[0] ?? ""

			return {
				part: file,
				id: /\sid="(\d+)"/.exec(root)?.[1] ?? "",
				name: /\sdisplayName="([^"]*)"/.exec(root)?.[1] ?? "",
				ref: /\sref="([^"]*)"/.exec(root)?.[1] ?? ""
			}
		})
}

function sheetPartOf(files: Record<string, string>, name: string): string {
	const workbook = files["xl/workbook.xml"] ?? ""
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const id = new RegExp(`<sheet [^>]*name="${escaped}"[^>]*r:id="([^"]+)"`).exec(workbook)?.[1] ?? ""
	const rels = files["xl/_rels/workbook.xml.rels"] ?? ""
	const target = new RegExp(`<Relationship [^>]*Id="${id}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? ""

	return target.startsWith("/") ? target.slice(1) : `xl/${target}`
}

describe("sheet session: duplicated sheets edited again", () => {
	it("gives every duplicate of a sheet with a table a table name and id of its own", async () => {
		const { session, info } = await openFixture(TABLE_SHEET)
		const one = info.sheets[0]!.id

		changeOf(await session.command({ type: "sheet.duplicate", sheet: one }))
		changeOf(await session.command({ type: "sheet.duplicate", sheet: one }))

		const files = parts(await savedBytes(session))
		const found = savedTables(files)

		expect(found.map(table => table.name).sort()).toEqual(["T", "T_2", "T_3"])
		expect(new Set(found.map(table => table.id)).size).toBe(3)

		// Each copy's formula reads its own table.
		const formulas = [1, 2].map(
			k => /<f>([^<]*)<\/f>/.exec(files[sheetPartOf(files, info.sheets[0]!.name + ` (${String(k + 1)})`)] ?? "")?.[1]
		)

		expect(formulas.sort()).toEqual(["SUM(T_2[K])", "SUM(T_3[K])"])
		session.close()
	})

	it("never gives a copied table a name another table of the copy keeps", async () => {
		const table = (id: number, name: string, ref: string, column: string): string =>
			'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
			`id="${String(id)}" name="${name}" displayName="${name}" ref="${ref}"><autoFilter ref="${ref}"/><tableColumns count="1"><tableColumn id="1" name="${column}"/></tableColumns></table>`
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body:
						'<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>K</t></is></c><c r="C1" t="inlineStr"><is><t>L</t></is></c></row><row r="2"><c r="A2"><v>1</v></c><c r="C2"><v>2</v></c></row></sheetData>' +
						'<tableParts count="2"><tablePart r:id="rId1"/><tablePart r:id="rId2"/></tableParts>',
					rels: relationship("rId1", "table", "../tables/table1.xml") + relationship("rId2", "table", "../tables/table2.xml")
				}
			],
			parts: {
				"xl/tables/table1.xml": { text: table(1, "A_2", "A1:A2", "K"), type: TYPES.table },
				"xl/tables/table2.xml": { text: table(2, "A", "C1:C2", "L"), type: TYPES.table }
			}
		})

		changeOf(await session.command({ type: "sheet.duplicate", sheet: info.sheets[0]!.id }))

		const names = savedTables(parts(await savedBytes(session))).map(found => found.name.toUpperCase())

		expect(new Set(names).size).toBe(4)
		session.close()
	})

	it("moves the copy's table with rows inserted and deleted on the copy", async () => {
		const { session, info } = await openFixture(TABLE_SHEET)
		const change = changeOf(await session.command({ type: "sheet.duplicate", sheet: info.sheets[0]!.id }))
		const copy = change.sheets?.[1]?.id ?? -1

		changeOf(await session.command({ type: "axis.insert", sheet: copy, axis: "rows", at: 0, count: 2 }))

		let found = savedTables(parts(await savedBytes(session)))

		expect(found.find(table => table.name === "T_2")?.ref).toBe("A3:A4")
		expect(found.find(table => table.name === "T")?.ref).toBe("A1:A2")

		changeOf(await session.command({ type: "axis.delete", sheet: copy, axis: "rows", at: 0, count: 1 }))
		found = savedTables(parts(await savedBytes(session)))
		expect(found.find(table => table.name === "T_2")?.ref).toBe("A2:A3")

		changeOf(await session.undo())
		changeOf(await session.undo())
		found = savedTables(parts(await savedBytes(session)))
		expect(found.find(table => table.name === "T_2")?.ref).toBe("A1:A2")
		session.close()
	})

	it.skipIf(corpus("xlsx/xlsxwriter__chart_pie01.xlsx") === null)(
		"moves the copy's drawing and chart with an insert on the copy, and the source's with one on the source",
		async () => {
			const { session, info } = await openFixture(corpus("xlsx/xlsxwriter__chart_pie01.xlsx") as Uint8Array)
			const one = info.sheets[0]!.id
			const change = changeOf(await session.command({ type: "sheet.duplicate", sheet: one }))
			const copy = change.sheets?.[1]?.id ?? -1
			const anchorRow = (markup: string | undefined): string | undefined =>
				/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/.exec(markup ?? "")?.[1]

			changeOf(await session.command({ type: "axis.insert", sheet: copy, axis: "rows", at: 0, count: 3 }))

			let files = parts(await savedBytes(session))

			expect(anchorRow(files["xl/drawings/drawing1.xml"])).toBe("8")
			expect(anchorRow(files["xl/drawings/drawing2.xml"])).toBe("11")
			expect(files["xl/charts/chart2.xml"]).toContain("<c:f>'Sheet1 (2)'!$A$4:$A$6</c:f>")
			expect(files["xl/charts/chart1.xml"]).toContain("<c:f>Sheet1!$A$1:$A$3</c:f>")

			changeOf(await session.command({ type: "axis.insert", sheet: one, axis: "rows", at: 0, count: 1 }))
			files = parts(await savedBytes(session))
			expect(anchorRow(files["xl/drawings/drawing1.xml"])).toBe("9")
			expect(anchorRow(files["xl/drawings/drawing2.xml"])).toBe("11")
			expect(files["xl/charts/chart1.xml"]).toContain("<c:f>Sheet1!$A$2:$A$4</c:f>")

			// The copy is renamed, deleted and duplicated in turn.
			changeOf(await session.command({ type: "sheet.rename", sheet: copy, name: "Copy" }))
			expect(parts(await savedBytes(session))["xl/charts/chart2.xml"]).toContain("<c:f>Copy!$A$4:$A$6</c:f>")

			const again = changeOf(await session.command({ type: "sheet.duplicate", sheet: copy }))

			expect(again.sheets?.map(sheet => sheet.name)).toEqual([
				"Sheet1",
				"Copy",
				"Copy (2)",
				...again.sheets!.slice(3).map(sheet => sheet.name)
			])

			const third = parts(await savedBytes(session))
			const charts = Object.keys(third).filter(file => /^xl\/charts\/chart\d+\.xml$/.test(file))

			expect(charts.length).toBe(3)
			expect(charts.some(file => (third[file] ?? "").includes("<c:f>'Copy (2)'!$A$4:$A$6</c:f>"))).toBe(true)
			expect(await reread(await savedBytes(session))).toEqual(again.sheets?.map(sheet => sheet.name))
			session.close()
		}
	)

	it("gives a copy made after another was undone relationships of its own, each where its markup points", async () => {
		const links = '<sheetData/><hyperlinks><hyperlink ref="A1" r:id="rId1"/><hyperlink ref="A2" r:id="rId2"/></hyperlinks>'
		const rel = (id: string, url: string) => `<Relationship Id="${id}" Type="${R}/hyperlink" Target="${url}" TargetMode="External"/>`
		const { session, info } = await openFixture({
			sheets: [
				{ name: "One", body: links, rels: rel("rId1", "https://a.example/") + rel("rId2", "https://b.example/") },
				{ name: "Two", body: links, rels: rel("rId1", "https://b.example/") + rel("rId2", "https://a.example/") }
			]
		})

		changeOf(await session.command({ type: "sheet.duplicate", sheet: info.sheets[0]!.id }))
		changeOf(await session.undo())

		const copy = changeOf(await session.command({ type: "sheet.duplicate", sheet: info.sheets[1]!.id })).sheets?.[2]?.name ?? ""
		const files = parts(await savedBytes(session))
		const part = sheetPartOf(files, copy)
		const rels = files[part.replace(/([^/]+)$/, "_rels/$1.rels")] ?? ""
		const target = (ref: string): string => {
			const id = new RegExp(`<hyperlink ref="${ref}" r:id="([^"]*)"`).exec(files[part] ?? "")?.[1] ?? ""

			return new RegExp(`Id="${id}"[^>]*Target="([^"]*)"`).exec(rels)?.[1] ?? ""
		}

		expect(target("A1")).toBe("https://b.example/")
		expect(target("A2")).toBe("https://a.example/")
		session.close()
	})

	it.skipIf(corpus("xlsx/xlsxwriter__comment01.xlsx") === null)(
		"saves after a copy with notes is deleted again, its relationships gone with it",
		async () => {
			const { session, info } = await openFixture(corpus("xlsx/xlsxwriter__comment01.xlsx") as Uint8Array)
			const copy = changeOf(await session.command({ type: "sheet.duplicate", sheet: info.sheets[0]!.id })).sheets?.[1]?.id ?? -1

			changeOf(await session.command({ type: "sheet.delete", sheet: copy }))

			const files = parts(await savedBytes(session))

			expect(Object.keys(files).filter(file => /^xl\/worksheets\/_rels\//.test(file))).toEqual([
				"xl/worksheets/_rels/sheet1.xml.rels"
			])
			expect(Object.keys(files).filter(file => /^xl\/comments\d+\.xml$/.test(file))).toEqual(["xl/comments1.xml"])
			session.close()
		}
	)

	it.skipIf(corpus("xlsx/xlsxwriter__comment01.xlsx") === null)(
		"moves the copy's notes with an insert on the copy, and gives each duplicate a shape block of its own",
		async () => {
			const { session, info } = await openFixture(corpus("xlsx/xlsxwriter__comment01.xlsx") as Uint8Array)
			const one = info.sheets[0]!.id
			const change = changeOf(await session.command({ type: "sheet.duplicate", sheet: one }))
			const copy = change.sheets?.[1]?.id ?? -1

			changeOf(await session.command({ type: "axis.insert", sheet: copy, axis: "rows", at: 0, count: 3 }))
			changeOf(await session.command({ type: "sheet.duplicate", sheet: one }))

			const files = parts(await savedBytes(session))
			const copyPart = sheetPartOf(files, change.sheets?.[1]?.name ?? "")
			const copyRels = files[copyPart.replace(/([^/]+)$/, "_rels/$1.rels")] ?? ""
			const comments = /Target="[^"]*?(comments\d+\.xml)"/.exec(copyRels)?.[1] ?? ""
			const vml = /Target="[^"]*?(vmlDrawing\d+\.vml)"/.exec(copyRels)?.[1] ?? ""

			expect(files["xl/comments1.xml"]).toContain('ref="B2"')
			expect(files[`xl/${comments}`]).toContain('ref="B5"')
			expect(files[`xl/drawings/${vml}`]).toContain("<x:Row>4</x:Row>")

			const blocks = Object.keys(files)
				.filter(file => file.endsWith(".vml"))
				.map(file => /data="(\d+)"/.exec(files[file] ?? "")?.[1])

			expect(blocks.length).toBe(3)
			expect(new Set(blocks).size).toBe(3)
			session.close()
		}
	)

	it("keeps the view and format attributes the model does not hold", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body:
						'<sheetPr codeName="Sheet1"><outlinePr summaryBelow="0"/></sheetPr><sheetViews><sheetView tabSelected="1" showZeros="0" showFormulas="1" zoomScaleNormal="85" showOutlineSymbols="0" workbookViewId="0"><pane xSplit="2000" ySplit="1500" topLeftCell="C4"/><selection pane="bottomRight" activeCell="C4" sqref="C4"/></sheetView>' +
						'<sheetView workbookViewId="1"/></sheetViews>' +
						'<sheetFormatPr defaultRowHeight="15" zeroHeight="1" outlineLevelRow="2" thickBottom="1"/>' +
						'<sheetData><row r="1"><c r="A1"><v>0</v></c></row></sheetData><sheetProtection formatCells="0" selectLockedCells="1"/>'
				}
			]
		})

		changeOf(await session.command({ type: "sheet.duplicate", sheet: info.sheets[0]!.id }))

		const copy = parts(await savedBytes(session))["xl/worksheets/sheet2.xml"] ?? ""

		expect(copy).toContain(
			'<sheetViews><sheetView showZeros="0" showFormulas="1" zoomScaleNormal="85" showOutlineSymbols="0" workbookViewId="0"><pane xSplit="2000" ySplit="1500" topLeftCell="C4"/><selection pane="bottomRight" activeCell="C4" sqref="C4"/></sheetView><sheetView workbookViewId="1"/></sheetViews>'
		)
		expect(copy).toContain('<sheetFormatPr defaultRowHeight="15" zeroHeight="1" outlineLevelRow="2" thickBottom="1"/>')
		expect(copy).toContain('<sheetPr><outlinePr summaryBelow="0"/></sheetPr>')
		expect(copy).toContain('<sheetProtection formatCells="0" selectLockedCells="1"/>')
		session.close()
	})

	it("keeps the copy's other sheetPr children when its tab colour is set", async () => {
		const { session, info } = await openFixture({
			sheets: [{ name: "One", body: '<sheetPr><outlinePr summaryBelow="0"/></sheetPr><sheetData/>' }]
		})
		const change = changeOf(await session.command({ type: "sheet.duplicate", sheet: info.sheets[0]!.id }))

		changeOf(await session.command({ type: "sheet.tabColor", sheet: change.sheets?.[1]?.id ?? -1, color: 0x00ff00 }))

		expect(parts(await savedBytes(session))["xl/worksheets/sheet2.xml"]).toContain(
			'<sheetPr><tabColor rgb="FF00FF00"/><outlinePr summaryBelow="0"/></sheetPr>'
		)
		session.close()
	})

	it("duplicates a sheet whose tab colour was just set, with that colour", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetPr codeName="Sheet1"><pageSetUpPr fitToPage="1"/></sheetPr><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'
				}
			]
		})
		const one = info.sheets[0]!.id

		changeOf(await session.command({ type: "sheet.tabColor", sheet: one, color: 0xff0000 }))
		changeOf(await session.command({ type: "sheet.duplicate", sheet: one }))

		expect(parts(await savedBytes(session))["xl/worksheets/sheet2.xml"]).toContain(
			'<sheetPr><tabColor rgb="FFFF0000"/><pageSetUpPr fitToPage="1"/></sheetPr>'
		)
		session.close()
	})
})

describe("sheet session: a duplicated sheet's root", () => {
	const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
	const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
	const GUID = /\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}/

	it("keeps the source root's namespaces and mc:Ignorable, with uids of its own", async () => {
		const xml =
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${MAIN}" xmlns:r="${R}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac xr" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xr:uid="{00000000-0001-0000-0000-000000000000}">` +
			'<sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>' +
			'<hyperlinks><hyperlink ref="A1" location="One!A2" display="x" xr:uid="{3210318E-49B7-475D-84EB-F466F1057241}"/></hyperlinks></worksheet>'
		const { session, info } = await openFixture({ sheets: [{ name: "One", xml }] })

		changeOf(await session.command({ type: "sheet.duplicate", sheet: info.sheets[0]!.id }))

		const files = parts(await savedBytes(session))
		const copy = files["xl/worksheets/sheet2.xml"] ?? ""
		const root = /<worksheet\b[^>]*>/.exec(copy)?.[0] ?? ""
		const rootUid = /\sxr:uid="([^"]*)"/.exec(root)?.[1] ?? ""
		const linkUid = /<hyperlink [^>]*xr:uid="([^"]*)"/.exec(copy)?.[1] ?? ""

		// The extension attributes the copy carries stay ignorable (ECMA-376 Part 3 §10.2.1).
		expect(root).toMatch(/mc:Ignorable="x14ac xr"/)
		expect(root).toContain('xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"')
		expect(copy).toContain('<sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/>')
		// A uid identifies one object ([MS-XLSX] §2.5.10): the copy's are new.
		expect(rootUid).toMatch(GUID)
		expect(rootUid).not.toBe("{00000000-0001-0000-0000-000000000000}")
		expect(linkUid).toMatch(GUID)
		expect(linkUid).not.toBe("{3210318E-49B7-475D-84EB-F466F1057241}")
		expect(files["xl/worksheets/sheet1.xml"]).toBe(xml)
		session.close()
	})

	it("gives a copy of a copy the namespaces of the root the copy took", async () => {
		const xml =
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${MAIN}" xmlns:r="${R}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac">` +
			'<sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/><sheetData><row r="1" x14ac:dyDescent="0.25"><c r="A1"><v>1</v></c></row></sheetData></worksheet>'
		const { session, info } = await openFixture({ sheets: [{ name: "One", xml }] })
		const copy = changeOf(await session.command({ type: "sheet.duplicate", sheet: info.sheets[0]!.id })).sheets?.[1]?.id ?? -1

		changeOf(await session.command({ type: "sheet.duplicate", sheet: copy }))

		const saved = await savedBytes(session)
		const third = parts(saved)["xl/worksheets/sheet3.xml"] ?? ""

		expect(/<worksheet\b[^>]*>/.exec(third)?.[0]).toContain('xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"')
		expect(await reread(saved)).toEqual(["One", "One (2)", "One (2) (2)"])
		session.close()
	})

	it("writes the copy under the source root's own prefix", async () => {
		const xml =
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<x:worksheet xmlns:x="${MAIN}" xmlns:r="${R}">` +
			'<x:sheetData><x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>'
		const { session, info } = await openFixture({ sheets: [{ name: "One", xml }] })
		const copy = changeOf(await session.command({ type: "sheet.duplicate", sheet: info.sheets[0]!.id })).sheets?.[1]?.id ?? -1

		changeOf(await session.command({ type: "sheet.tabColor", sheet: copy, color: 0xff0000 }))

		const saved = await savedBytes(session)
		const text = parts(saved)["xl/worksheets/sheet2.xml"] ?? ""

		expect(text).toMatch(/^<\?xml[^>]*\?>\s*<x:worksheet xmlns:x="[^"]*" xmlns:r="[^"]*">/)
		expect(text).toContain("<x:sheetPr><x:tabColor")
		expect(text).toContain('<x:c r="A1"><x:v>1</x:v></x:c>')
		expect(text.trimEnd().endsWith("</x:worksheet>")).toBe(true)
		expect(await reread(saved)).toEqual(["One", "One (2)"])
		session.close()
	})
})

describe.skipIf(openXmlSdkMissing() !== undefined)("sheet session: duplicated sheets against the Open XML SDK", () => {
	for (const name of [
		"xlsx/govuk__BEIS_2021_Tables___Figures_in_Sixth_Carbon_Budget_Impact_Assessment.xlsx",
		"xlsx/govuk__outturn-and-forecast-tables-autumn-statement-2022.xlsx",
		"xlsx/govuk__outturn-and-forecast-tables-spring-statement-2025.xlsx"
	])
		it.skipIf(corpus(name) === null)(`adds no validation error duplicating every sheet of ${name}`, { timeout: 600_000 }, async () => {
			const bytes = corpus(name) as Uint8Array
			const { session, info } = await openFixture(bytes)
			const sdk = new OpenXmlSdk()
			const work = mkdtempSync(join(tmpdir(), "sheet-copy-sdk-"))

			try {
				for (const sheet of info.sheets.filter(entry => entry.kind === "worksheet")) {
					const result = await session.command({ type: "sheet.duplicate", sheet: sheet.id })

					if (!result.ok)
						console.log(`sheet-copy-sdk ${name} ${sheet.name}: refused ${result.refusal.reason} ${result.refusal.detail ?? ""}`)
				}

				const source = join(work, "source.xlsx")
				const saved = join(work, "saved.xlsx")

				writeFileSync(source, bytes)
				writeFileSync(saved, await savedBytes(session))

				// Errors by kind, the part names left out: a copy's part repeats its source's errors under a new name.
				const kinds = (counts: Map<string, number>): Set<string> => new Set([...counts.keys()].map(key => key.replace(/^\S+ /, "")))
				const before = kinds(sdkErrorCounts(await sdk.validate(source)))
				const after = kinds(sdkErrorCounts(await sdk.validate(saved)))

				expect([...after].filter(kind => !before.has(kind))).toEqual([])
			} finally {
				await sdk.close()
				rmSync(work, { recursive: true, force: true })
				session.close()
			}
		})
})
