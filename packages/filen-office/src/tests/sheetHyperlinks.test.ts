import { describe, expect, it } from "vitest"
import { CellFlag } from "../core/sheet/protocol"
import { hyperlinkArguments, stringLiteral } from "../core/xlsx/hyperlinks/location"
import { subtract } from "../core/xlsx/hyperlinks/links"
import { SML, buildFixture, firstTile, savedBytes, tileEntry } from "./sheetSessionFixtures"
import { changeOf, entries, openAnnotated, range, refusalOf } from "./sheetNotesFixtures"

// Hyperlinks: their flag, where they go (external targets, places in the workbook, HYPERLINK formulas), and their
// edits through the hyperlinks section and external relationships, saved through the gate.

const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

const LINKS = buildFixture({
	sheets: [
		{
			name: "One",
			body:
				'<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>site</t></is></c><c r="B1" t="inlineStr"><is><t>jump</t></is></c>' +
				'<c r="C1" t="str"><f>HYPERLINK("https://example.com/x","go")</f><v>go</v></c>' +
				'<c r="D1" t="str"><f>HYPERLINK("#\'Sheet Two\'!B3")</f><v>#\'Sheet Two\'!B3</v></c>' +
				'<c r="E1" t="str"><f>HYPERLINK(F1,"via")</f><v>via</v></c><c r="F1" t="inlineStr"><is><t>mailto:a@b.c</t></is></c></row></sheetData>' +
				'<hyperlinks><hyperlink ref="A1:A3" r:id="rId1" tooltip="Example" display="site"/><hyperlink ref="B1" location="\'Sheet Two\'!A2"/></hyperlinks>',
			rels: `<Relationship Id="rId1" Type="${R}/hyperlink" Target="https://example.com/" TargetMode="External"/>`
		},
		{ name: "Sheet Two", body: "<sheetData/>" }
	],
	workbookTail: "<definedNames><definedName name=\"Target\">'Sheet Two'!$C$4:$D$5</definedName></definedNames>"
})

describe("hyperlinks", () => {
	it("flags linked cells and HYPERLINK formulas, and says where each goes", async () => {
		const { session, sheets } = await openAnnotated(LINKS)
		const sheet = sheets[0] ?? 0
		const tile = await firstTile(session, sheet)

		for (const col of [0, 1, 2, 3, 4]) expect((tileEntry(tile, 0, col)?.flags ?? 0) & CellFlag.HYPERLINK).toBe(CellFlag.HYPERLINK)

		expect((tileEntry(tile, 0, 5)?.flags ?? 0) & CellFlag.HYPERLINK).toBe(0)
		expect(await session.query("link.get", { sheet, row: 1, col: 0 })).toEqual({
			url: "https://example.com/",
			location: null,
			place: null,
			tooltip: "Example",
			display: "site",
			range: range(0, 0, 2, 0),
			formula: false
		})
		expect((await session.query("link.get", { sheet, row: 0, col: 1 }))?.place).toEqual({ sheet: sheets[1], range: range(1, 0) })
		expect(await session.query("link.get", { sheet, row: 0, col: 2 })).toMatchObject({ url: "https://example.com/x", formula: true })
		expect(await session.query("link.get", { sheet, row: 0, col: 3 })).toMatchObject({
			url: null,
			location: "'Sheet Two'!B3",
			place: { sheet: sheets[1], range: range(2, 1) }
		})
		expect(await session.query("link.get", { sheet, row: 0, col: 4 })).toMatchObject({ url: "mailto:a@b.c", formula: true })
		expect(await session.query("link.get", { sheet, row: 0, col: 5 })).toBeNull()
		session.close()
	})

	it("inserts an external link with its relationship, the text and the hyperlink look, and undoes to the source", async () => {
		const { session, sheets } = await openAnnotated(LINKS)
		const sheet = sheets[1] ?? 0

		changeOf(
			await session.command({
				type: "link.set",
				sheet,
				ranges: [range(1, 1)],
				target: { url: "https://filen.io/a?b=1&c" },
				text: "Filen",
				tooltip: "Go"
			})
		)

		const files = entries(await savedBytes(session))
		const id = /Id="(rId\d+)" Type="[^"]*\/hyperlink" Target="https:\/\/filen\.io\/a\?b=1&amp;c" TargetMode="External"/.exec(
			files["xl/worksheets/_rels/sheet2.xml.rels"] ?? ""
		)?.[1]

		expect(id).toBeDefined()
		expect(files["xl/worksheets/sheet2.xml"]).toContain(
			`<hyperlinks><hyperlink ref="B2" xmlns:r="${R}" r:id="${id ?? ""}" tooltip="Go" display="Filen"/></hyperlinks>`
		)
		expect(files["xl/worksheets/sheet2.xml"]).toMatch(/<c r="B2" s="(\d+)" t="s"><v>\d+<\/v><\/c>/)
		expect(files["xl/styles.xml"]).toContain('<font><u/><sz val="11"/><color theme="10"/><name val="Calibri"/></font>')

		const tile = await firstTile(session, sheet)

		expect(tileEntry(tile, 1, 1)?.text).toBe("Filen")
		expect((tileEntry(tile, 1, 1)?.flags ?? 0) & CellFlag.HYPERLINK).toBe(CellFlag.HYPERLINK)

		changeOf(await session.undo())
		expect(await savedBytes(session)).toEqual(LINKS)
		session.close()
	})

	it("links to a place in the workbook by reference or defined name, and refuses one that names nothing", async () => {
		const { session, sheets } = await openAnnotated(LINKS)
		const sheet = sheets[1] ?? 0

		changeOf(await session.command({ type: "link.set", sheet, ranges: [range(0, 0)], target: { location: "Target" } }))
		expect((await session.query("link.get", { sheet, row: 0, col: 0 }))?.place).toEqual({ sheet, range: range(3, 2, 4, 3) })
		expect(
			refusalOf(await session.command({ type: "link.set", sheet, ranges: [range(0, 1)], target: { location: "Nowhere!A1" } }))
		).toBe("linkTarget")
		session.close()
	})

	it("refuses targets the shared link policy blocks", async () => {
		const { session, sheets } = await openAnnotated(LINKS)
		const sheet = sheets[1] ?? 0

		for (const url of ["javascript:alert(1)", "java\tscript:x", "https:/nohost", "file:///etc/passwd", " "])
			expect(refusalOf(await session.command({ type: "link.set", sheet, ranges: [range(0, 0)], target: { url } }))).toBe("linkTarget")

		session.close()
	})

	it("replaces part of a link: the rest keeps its target, the cut piece gets the new one", async () => {
		const { session, sheets } = await openAnnotated(LINKS)
		const sheet = sheets[0] ?? 0

		changeOf(await session.command({ type: "link.set", sheet, ranges: [range(1, 0)], target: { location: "B1" } }))

		const xml = entries(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(xml).toContain(
			'<hyperlink ref="A1" r:id="rId1" tooltip="Example" display="site"/><hyperlink ref="A3" r:id="rId1" tooltip="Example" display="site"/>'
		)
		expect(xml).toContain('<hyperlink ref="A2" location="B1"/>')
		session.close()
	})

	it("removes links with their relationship and look; a link partly removed keeps the rest", async () => {
		const { session, sheets } = await openAnnotated(LINKS)
		const sheet = sheets[0] ?? 0

		changeOf(await session.command({ type: "link.remove", sheet, ranges: [range(0, 0, 0, 1)] }))

		let files = entries(await savedBytes(session))

		expect(files["xl/worksheets/sheet1.xml"]).toContain(
			'<hyperlinks><hyperlink ref="A2:A3" r:id="rId1" tooltip="Example" display="site"/></hyperlinks>'
		)
		expect((tileEntry(await firstTile(session, sheet), 0, 1)?.flags ?? 0) & CellFlag.HYPERLINK).toBe(0)

		changeOf(await session.command({ type: "link.remove", sheet, ranges: [range(0, 0, 9, 0)] }))
		files = entries(await savedBytes(session))
		expect(files["xl/worksheets/sheet1.xml"]).not.toContain("<hyperlinks")
		expect(files["xl/worksheets/_rels/sheet1.xml.rels"] ?? "").not.toContain("example.com")
		// HYPERLINK formulas are their formulas' to change.
		expect((tileEntry(await firstTile(session, sheet), 0, 2)?.flags ?? 0) & CellFlag.HYPERLINK).toBe(CellFlag.HYPERLINK)

		changeOf(await session.undo())
		changeOf(await session.undo())
		expect(await savedBytes(session)).toEqual(LINKS)
		session.close()
	})

	it("flags a wide link's cells in a far tile, and a HYPERLINK formula typed after the first tiles", async () => {
		const { session, sheets } = await openAnnotated(LINKS)
		const sheet = sheets[1] ?? 0

		await firstTile(session, sheet)
		changeOf(await session.command({ type: "link.set", sheet, ranges: [range(0, 0, 9999, 3)], target: { url: "https://filen.io/" } }))
		changeOf(
			await session.command({
				type: "cells.set",
				sheet,
				cells: { rows: Uint32Array.of(5000), cols: Uint16Array.of(2), inputs: ["x"] }
			})
		)

		const far = (await session.tiles(sheet, Uint32Array.of(78, 0))).tiles[0]

		expect(far === undefined ? 0 : (tileEntry(far, 5000, 2)?.flags ?? 0) & CellFlag.HYPERLINK).toBe(CellFlag.HYPERLINK)

		changeOf(
			await session.command({
				type: "cells.set",
				sheet,
				cells: { rows: Uint32Array.of(0), cols: Uint16Array.of(9), inputs: ['=HYPERLINK("https://filen.io/b")'] }
			})
		)
		expect((tileEntry(await firstTile(session, sheet), 0, 9)?.flags ?? 0) & CellFlag.HYPERLINK).toBe(CellFlag.HYPERLINK)
		expect(await session.query("link.get", { sheet, row: 0, col: 9 })).toMatchObject({ url: "https://filen.io/b", formula: true })
		session.close()
	})

	it("puts back a link it added and removed, with its relationship's id, on undo and redo", async () => {
		const { session, sheets } = await openAnnotated(LINKS)
		const sheet = sheets[1] ?? 0

		changeOf(await session.command({ type: "link.set", sheet, ranges: [range(0, 0)], target: { url: "https://filen.io/a" } }))

		const added = entries(await savedBytes(session))

		changeOf(await session.command({ type: "link.remove", sheet, ranges: [range(0, 0)] }))
		expect(entries(await savedBytes(session))["xl/worksheets/_rels/sheet2.xml.rels"] ?? "").not.toContain("filen.io")
		changeOf(await session.undo())
		expect(entries(await savedBytes(session))["xl/worksheets/_rels/sheet2.xml.rels"]).toBe(added["xl/worksheets/_rels/sheet2.xml.rels"])
		expect(entries(await savedBytes(session))["xl/worksheets/sheet2.xml"]).toBe(added["xl/worksheets/sheet2.xml"])
		changeOf(await session.redo())
		changeOf(await session.undo())
		changeOf(await session.undo())
		expect(await savedBytes(session)).toEqual(LINKS)
		session.close()
	})

	it("gives two links to one URL their own relationships back through undo and redo", async () => {
		const { session, sheets } = await openAnnotated(LINKS)
		const sheet = sheets[1] ?? 0

		for (const col of [0, 1])
			changeOf(await session.command({ type: "link.set", sheet, ranges: [range(0, col)], target: { url: "https://filen.io/same" } }))

		changeOf(await session.undo())
		changeOf(await session.undo())
		changeOf(await session.redo())
		changeOf(await session.redo())

		const files = entries(await savedBytes(session))
		const ids = [...(files["xl/worksheets/sheet2.xml"] ?? "").matchAll(/<hyperlink [^>]*r:id="([^"]+)"/g)].map(match => match[1])
		const related = [
			...(files["xl/worksheets/_rels/sheet2.xml.rels"] ?? "").matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*\/hyperlink"/g)
		].map(match => match[1])

		expect(ids).toHaveLength(2)
		expect([...ids].sort()).toEqual([...related].sort())
		expect(await session.query("link.get", { sheet, row: 0, col: 1 })).toMatchObject({ url: "https://filen.io/same" })
		session.close()
	})

	it("declares the relationships prefix for every link it adds to a sheet whose root does not", async () => {
		const bare = buildFixture({
			sheets: [
				{
					name: "One",
					xml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${SML}"><sheetData/></worksheet>`
				}
			]
		})
		const { session, sheets } = await openAnnotated(bare)
		const sheet = sheets[0] ?? 0

		for (const row of [0, 2, 4])
			changeOf(
				await session.command({
					type: "link.set",
					sheet,
					ranges: [range(row, 2)],
					target: { url: `https://filen.io/${String(row)}` }
				})
			)

		const sheetXml = entries(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""
		const links = [...sheetXml.matchAll(/<hyperlink [^>]*\/>/g)].map(match => match[0])

		expect(links).toHaveLength(3)

		for (const link of links) expect(link).toContain(`xmlns:r="${R}" r:id="`)

		changeOf(await session.command({ type: "link.remove", sheet, ranges: [range(0, 2)] }))
		changeOf(await session.command({ type: "sheet.duplicate", sheet }))

		const files = entries(await savedBytes(session))
		const copyIds = new Set([...(files["xl/worksheets/_rels/sheet2.xml.rels"] ?? "").matchAll(/Id="(rId\d+)"/g)].map(match => match[1]))
		const copyLinks = [...(files["xl/worksheets/sheet2.xml"] ?? "").matchAll(/<hyperlink [^>]*r:id="(rId\d+)"/g)].map(match => match[1])

		expect(copyLinks).toHaveLength(2)

		for (const id of copyLinks) expect(copyIds.has(id)).toBe(true)

		session.close()
	})

	it("reads HYPERLINK's arguments and string literals as written", () => {
		expect(hyperlinkArguments('HYPERLINK("a,b", IF(A1,"x","y"))')).toEqual(['"a,b"', 'IF(A1,"x","y")'])
		expect(hyperlinkArguments("_xlfn.HYPERLINK({1,2})")).toEqual(["{1,2}"])
		expect(hyperlinkArguments('HYPERLINK("a")&"b"')).toBeNull()
		expect(hyperlinkArguments("SUM(A1)")).toBeNull()
		expect(stringLiteral('"say ""hi"""')).toBe('say "hi"')
		expect(stringLiteral("A1")).toBeNull()
		expect(subtract(range(0, 0, 4, 4), range(1, 1, 2, 2))).toEqual([
			range(0, 0, 0, 4),
			range(3, 0, 4, 4),
			range(1, 0, 2, 0),
			range(1, 3, 2, 4)
		])
	})
})
