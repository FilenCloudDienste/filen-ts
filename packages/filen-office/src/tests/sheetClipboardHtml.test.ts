import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { clipboardHtml, parseClipboardHtml, type ClipCell, type ClipTable } from "../core/sheet/clipboard/html"
import { r1c1ToA1 } from "../core/sheet/clipboard/r1c1"
import { SHEET_MAX_EDIT_CELLS, type SheetSessionApi } from "../core/sheet/protocol"
import { firstTile, openFixture, savedBytes, tileEntry } from "./sheetSessionFixtures"
import { openKeys, sheetBody } from "./sheetKeysFixtures"
import { budget } from "./timing"

// Clipboard HTML in and out: LibreOffice's (captured from 7.5 and 26.8, "HTML (StarCalc)", the filter its clipboard
// uses, from fixtures/sheet-clipboard/source.fods), Google Sheets' attributes (data-sheets-*, as LibreOffice 26.8
// also writes them), Excel's HTML conventions (x:num, class rules with mso-number-format; built by hand, Excel is
// never run here), a plain web table, and this app's own; R1C1 formulas; and sessions pasting and copying.

const FIXTURES = join(import.meta.dirname, "fixtures", "sheet-clipboard")

function table(html: string): ClipTable {
	const parsed = parseClipboardHtml(html, SHEET_MAX_EDIT_CELLS)

	if (parsed === null || parsed === "tooLarge") throw new Error(`no table: ${String(parsed)}`)

	return parsed
}

function at(parsed: ClipTable, row: number, col: number): ClipCell {
	const cell = parsed.cells.find(found => found.row === row && found.col === col)

	if (cell === undefined) throw new Error(`no cell ${String(row)},${String(col)}`)

	return cell
}

describe("LibreOffice clipboard HTML", () => {
	for (const version of ["7.5", "26.8"])
		it(`reads ${version}'s values, number formats and formats`, () => {
			const parsed = table(readFileSync(join(FIXTURES, `libreoffice-${version}.html`), "utf8"))

			expect([parsed.rows, parsed.cols]).toEqual([3, 4])
			expect(at(parsed, 0, 0).value).toEqual({ kind: version === "7.5" ? "typed" : "text", text: "Name & <id>" })
			expect(at(parsed, 0, 0).format).toMatchObject({ bold: true, color: 0xc00000 })
			expect(at(parsed, 0, 1).value).toEqual({ kind: "number", value: 1234.5678 })
			expect(at(parsed, 0, 1).format).toMatchObject({ fill: 0xffff00, numFmt: "#,##0.00" })
			expect(at(parsed, 0, 1).borders).toEqual({
				top: { style: "thin", color: 0 },
				right: { style: "thin", color: 0 },
				bottom: { style: "thin", color: 0 },
				left: { style: "thin", color: 0 }
			})
			expect(at(parsed, 0, 2).value).toEqual({ kind: "number", value: 45306 })
			expect(at(parsed, 0, 2).format).toMatchObject({ italic: true, align: "center", numFmt: "yyyy-mm-dd" })
			expect(at(parsed, 0, 3).value).toEqual({ kind: "number", value: 0.125 })
			expect(at(parsed, 0, 3).format?.numFmt).toBe("0.0%")
			expect(at(parsed, 1, 0).value).toEqual(version === "7.5" ? { kind: "typed", text: "007" } : { kind: "text", text: "007" })
			expect(at(parsed, 1, 1).formula).toEqual(version === "7.5" ? null : { kind: "r1c1", text: "=R[-1]C*2" })
			expect(at(parsed, 1, 2).value).toEqual(
				version === "7.5" ? { kind: "typed", text: "line one\nline two" } : { kind: "text", text: "line one\nline two" }
			)
			expect(at(parsed, 1, 2).format?.underline).toBe("single")
			expect(at(parsed, 1, 3).value).toEqual({ kind: "boolean", value: true })
			expect(at(parsed, 1, 3).format?.numFmt).toBeUndefined()
			// colspan=2: the covered cell is there, empty, and the next cell after it.
			expect(at(parsed, 2, 1).value).toEqual({ kind: "empty" })
			expect(at(parsed, 2, 2).value).toEqual({ kind: "number", value: -3 })
		})
})

// Google Sheets' clipboard markup (its attributes as LibreOffice 26.8 reproduces them above).
const SHEETS =
	'<google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}br {mso-data-placement:same-cell;}--></style>' +
	'<table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1" style="table-layout:fixed;font-size:10pt;font-family:Arial;width:0px;border-collapse:collapse;border:none">' +
	'<colgroup><col width="100"/><col width="100"/></colgroup><tbody>' +
	'<tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;text-align:right;" data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:2.5}">2.5</td>' +
	'<td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;font-weight:bold;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;0042&quot;}">0042</td></tr>' +
	'<tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;text-align:right;" data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:5}" data-sheets-formula="=R[-1]C[0]*2">5</td>' +
	'<td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;background-color:#d9ead3;" data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:0.25}" data-sheets-numberformat="{&quot;1&quot;:3,&quot;2&quot;:&quot;0.00%&quot;,&quot;3&quot;:1}" data-sheets-formula="=SUM(R[-1]C[-1]:R[0]C[-1])/10">25.00%</td></tr>' +
	"</tbody></table></google-sheets-html-origin>"

describe("Google Sheets clipboard HTML", () => {
	it("reads typed values, R1C1 formulas, number formats, the table's font, and no gridline borders", () => {
		const parsed = table(SHEETS)

		expect(at(parsed, 0, 0).value).toEqual({ kind: "number", value: 2.5 })
		expect(at(parsed, 0, 0).format).toMatchObject({ font: "Arial", size: 10, align: "right", valign: "bottom" })
		expect(at(parsed, 0, 0).borders).toBeNull()
		expect(at(parsed, 0, 1).value).toEqual({ kind: "text", text: "0042" })
		expect(at(parsed, 0, 1).format?.bold).toBe(true)
		expect(at(parsed, 1, 0).formula).toEqual({ kind: "r1c1", text: "=R[-1]C[0]*2" })
		expect(at(parsed, 1, 1).format).toMatchObject({ fill: 0xd9ead3, numFmt: "0.00%" })
	})
})

// Excel's HTML conventions: class rules in the style element, x:num values, CSS-escaped mso-number-format.
const EXCEL =
	'<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head>' +
	'<style><!--table {mso-displayed-decimal-separator:"\\.";}\n' +
	"td {padding-top:1px; color:black; font-size:11.0pt; font-family:Calibri, sans-serif; vertical-align:bottom; white-space:nowrap;}\n" +
	'.xl65 {mso-number-format:"\\#\\,\\#\\#0\\.00_ \\;\\[Red\\]\\-\\#\\,\\#\\#0\\.00\\ "; font-weight:700;}\n' +
	'.xl66 {mso-number-format:"Short Date"; text-align:center; border:.5pt solid windowtext; background:#FFC000; mso-pattern:black none;}\n' +
	".xl67 {white-space:normal; font-style:italic; text-decoration:underline; text-underline-style:double;}\n" +
	"--></style></head><body><table border=0 cellpadding=0 cellspacing=0 width=128>" +
	'<tr height=20><td class=xl65 align=right x:num="-1234.5">-1,234.50 </td><td class=xl66 x:num="45306">1/15/2024</td></tr>' +
	'<tr height=40><td class=xl67>two<br style="mso-data-placement:same-cell" />lines</td><td x:str="=not a formula">=not a formula</td></tr>' +
	"</table></body></html>"

describe("Excel-style clipboard HTML", () => {
	it("reads class rules, escaped number formats, x:num and x:str", () => {
		const parsed = table(EXCEL)

		expect(at(parsed, 0, 0).value).toEqual({ kind: "number", value: -1234.5 })
		expect(at(parsed, 0, 0).format).toMatchObject({ bold: true, numFmt: "#,##0.00_ ;[Red]-#,##0.00 ", font: "Calibri", size: 11 })
		// Black (Excel's "color:black" default) is automatic text: no colour.
		expect(at(parsed, 0, 0).format?.color).toBeUndefined()
		expect(at(parsed, 0, 1).value).toEqual({ kind: "number", value: 45306 })
		expect(at(parsed, 0, 1).format).toMatchObject({ numFmt: "m/d/yyyy", align: "center", fill: 0xffc000 })
		expect(at(parsed, 0, 1).borders?.left).toEqual({ style: "thin" })
		expect(at(parsed, 1, 0).value).toEqual({ kind: "typed", text: "two\nlines" })
		expect(at(parsed, 1, 0).format).toMatchObject({ wrap: true, italic: true, underline: "double" })
		expect(at(parsed, 1, 1).value).toEqual({ kind: "text", text: "=not a formula" })
	})
})

describe("clipboard HTML reading", () => {
	it("reads a plain web table as typed text, its whitespace laid out, a cell wholly in <b> bold", () => {
		const parsed = table(
			"<p>before</p><table><tr><th>  Price\n </th><th><b>Qty</b></th></tr><tr><td>1,250.00</td><td><b>x</b> y</td></tr></table>"
		)

		expect(at(parsed, 0, 0).value).toEqual({ kind: "typed", text: "Price" })
		expect(at(parsed, 0, 1).format?.bold).toBe(true)
		expect(at(parsed, 1, 0).value).toEqual({ kind: "typed", text: "1,250.00" })
		expect(at(parsed, 1, 1).format).toBeNull()
	})

	it("skips scripts, comments and nested tables' structure, and lays out row spans", () => {
		const parsed = table(
			"<table><tr><td rowspan=2>a<script>alert(1)</script><!-- <td>x</td> --></td><td>b<table><tr><td>in</td></tr></table></td></tr><tr><td>c</td></tr></table>"
		)

		expect(at(parsed, 0, 0).value).toEqual({ kind: "typed", text: "a" })
		expect(at(parsed, 0, 1).value).toEqual({ kind: "typed", text: "bin" })
		expect(at(parsed, 1, 0).value).toEqual({ kind: "empty" })
		expect(at(parsed, 1, 1).value).toEqual({ kind: "typed", text: "c" })
	})

	it("is null without a table and refuses more cells than one edit takes", () => {
		expect(parseClipboardHtml("<p>text only</p>", 10)).toBeNull()
		expect(parseClipboardHtml("<table><tr><td>1</td><td>2</td><td>3</td></tr></table>", 2)).toBe("tooLarge")
	})

	it("leaves out a number format or font a workbook cannot hold", () => {
		const parsed = table(
			"<table><tr><td style=\"mso-number-format:&quot;0.00&quot;0&quot;;font-family:'\u0001bad'\">1</td></tr></table>"
		)

		expect(at(parsed, 0, 0).format?.numFmt).toBeUndefined()
		expect(at(parsed, 0, 0).format?.font).toBeUndefined()
	})

	it("reads pathological markup in linear time", () => {
		const started = performance.now()

		expect(parseClipboardHtml("<".repeat(400_000) + "<table".repeat(50_000) + '<td x="'.repeat(20_000), 1000)).not.toBe("tooLarge")
		expect(performance.now() - started).toBeLessThan(budget(2000))
	})
})

describe("R1C1 formulas", () => {
	it("become A1 for the cell they are pasted into", () => {
		expect(r1c1ToA1("R[-1]C[0]*2", 4, 2)).toBe("C4*2")
		expect(r1c1ToA1("SUM(R[-3]C:R[-1]C)", 10, 0)).toBe("SUM(A8:A10)")
		expect(r1c1ToA1("R1C1+R2C[1]", 0, 0)).toBe("$A$1+B$2")
		expect(r1c1ToA1("SUM(C[-1]:C[-1])", 0, 3)).toBe("SUM(C:C)")
		expect(r1c1ToA1("SUM(R[1]:R[2])", 0, 0)).toBe("SUM(2:3)")
		expect(r1c1ToA1("'Sheet R1C1'!R[0]C[0]&\"R1C1\"", 1, 1)).toBe("'Sheet R1C1'!B2&\"R1C1\"")
		expect(r1c1ToA1("ROUND(RC[-1],2)+COUNT(R1C)", 2, 2)).toBe("ROUND(B3,2)+COUNT(C$1)")
		expect(r1c1ToA1("R[-5]C", 2, 0)).toBe("#REF!")
	})
})

describe("clipboard HTML writing", () => {
	it("escapes text, writes formats, values and formulas as the readers above take them back", () => {
		const html = clipboardHtml(
			1,
			3,
			{ row: 4, col: 2 },
			(_row, col) =>
				col === 0
					? {
							text: "a<b>&\nc",
							value: { kind: "text", text: "a<b>&\nc" },
							formula: null,
							style: { bold: true, fill: 0xffff00 },
							numFmt: "General"
						}
					: col === 1
						? {
								text: "12.50",
								value: { kind: "number", value: 12.5 },
								formula: "=C5*2",
								style: { font: 'Odd "Font";', top: { style: "medium", color: 0xff0000 } },
								numFmt: '0.00;"neg"'
							}
						: null,
			1_000_000
		)

		expect(html).not.toBeNull()

		const parsed = table(html ?? "")

		expect(at(parsed, 0, 0).value).toEqual({ kind: "text", text: "a<b>&\nc" })
		expect(at(parsed, 0, 0).format).toMatchObject({ bold: true, fill: 0xffff00 })
		expect(at(parsed, 0, 1).value).toEqual({ kind: "number", value: 12.5 })
		expect(at(parsed, 0, 1).formula).toEqual({ kind: "a1", text: "=C5*2", row: 4, col: 3 })
		expect(at(parsed, 0, 1).format).toMatchObject({ font: 'Odd "Font";', numFmt: '0.00;"neg"' })
		expect(at(parsed, 0, 1).borders).toEqual({ top: { style: "medium", color: 0xff0000 } })
		expect(at(parsed, 0, 2).value).toEqual({ kind: "empty" })
	})

	it("gives up past its length", () => {
		expect(
			clipboardHtml(
				100,
				1,
				{ row: 0, col: 0 },
				() => ({ text: "x", value: { kind: "typed", text: "x" }, formula: null, style: {}, numFmt: "General" }),
				500
			)
		).toBeNull()
	})
})

async function texts(
	session: SheetSessionApi,
	cells: readonly (readonly [number, number])[]
): Promise<{ text: string; input: string | null }[]> {
	const tile = await firstTile(session, 0)

	return cells.map(([row, col]) => {
		const entry = tileEntry(tile, row, col)

		return { text: entry?.text ?? "", input: entry?.input ?? null }
	})
}

describe("clipboard HTML in sessions", () => {
	it("pastes LibreOffice's table with its values, formulas, number formats and formats, as one undo step", async () => {
		const { session } = await openKeys({ sheets: [{ name: "S", body: sheetBody([["old"]]) }] })
		const html = readFileSync(join(FIXTURES, "libreoffice-26.8.html"), "utf8")
		const result = await session.command({ type: "clipboard.pasteHtml", sheet: 0, at: { row: 0, col: 0 }, html, text: "" })

		expect(result.ok).toBe(true)
		expect(result.ok ? result.change.selection?.ranges : null).toEqual([{ startRow: 0, startCol: 0, endRow: 2, endCol: 3 }])
		expect(
			await texts(session, [
				[0, 0],
				[0, 1],
				[0, 2],
				[0, 3],
				[1, 0],
				[1, 1],
				[1, 3]
			])
		).toEqual([
			{ text: "Name & <id>", input: null },
			{ text: "1,234.57", input: "1234.5678" },
			{ text: "2024-01-15", input: null },
			{ text: "12.5%", input: "0.125" },
			{ text: "007", input: null },
			{ text: "2469.1356", input: "=B1*2" },
			{ text: "TRUE", input: null }
		])

		const tile = await firstTile(session, 0)

		expect(tileEntry(tile, 0, 0)?.style).not.toBe(0)

		await session.undo()
		expect((await texts(session, [[0, 0]]))[0]?.text).toBe("old")

		const reopened = await openFixture(await savedBytes(session))

		expect((await texts(reopened.session, [[0, 0]]))[0]?.text).toBe("old")
	})

	it("copies a range as HTML another session pastes with formats, formulas moved, text kept text", async () => {
		const body =
			'<sheetData><row r="1"><c r="A1" s="1"><v>45306</v></c><c r="B1" t="inlineStr"><is><t>007</t></is></c><c r="C1"><f>A1+1</f><v>45307</v></c></row></sheetData>'
		const source = await openFixture({ sheets: [{ name: "S", body }] })
		const copied = await source.session.query("copyHtml", { sheet: 0, range: { startRow: 0, startCol: 0, endRow: 0, endCol: 2 } })

		expect(copied.html).toContain("data-filen-formula")

		const target = await openKeys({ sheets: [{ name: "T", body: sheetBody([]) }] })

		await target.session.command({ type: "clipboard.pasteHtml", sheet: 0, at: { row: 3, col: 1 }, html: copied.html ?? "", text: "" })

		expect(
			await texts(target.session, [
				[3, 1],
				[3, 2],
				[3, 3]
			])
		).toEqual([
			{ text: "1/15/2024", input: expect.any(String) as string },
			{ text: "007", input: null },
			{ text: expect.any(String) as string, input: "=B4+1" }
		])
	})

	it("pastes the session's own copy as a copy when the clip still matches, and text without a table as TSV", async () => {
		const { session } = await openKeys({ sheets: [{ name: "S", body: sheetBody([[{ f: "1+1", v: 2 }]]) }] })
		const copy = await session.query("copy", { sheet: 0, range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, cut: false })

		if ("refused" in copy) throw new Error("refused")

		await session.command({
			type: "clipboard.pasteHtml",
			sheet: 0,
			at: { row: 1, col: 0 },
			html: "<table><tr><td>9</td></tr></table>",
			text: copy.text,
			clip: copy.clip
		})
		await session.command({ type: "clipboard.pasteHtml", sheet: 0, at: { row: 2, col: 0 }, html: "<p>no table</p>", text: "a\tb" })

		expect(
			await texts(session, [
				[1, 0],
				[2, 0],
				[2, 1]
			])
		).toEqual([
			{ text: "2", input: "=1+1" },
			{ text: "a", input: null },
			{ text: "b", input: null }
		])
	})

	it("pastes a table's values into a text file", async () => {
		const { session } = await openKeys("x,y\n")

		await session.command({ type: "clipboard.pasteHtml", sheet: 0, at: { row: 1, col: 0 }, html: SHEETS, text: "" })

		expect(
			await texts(session, [
				[1, 0],
				[1, 1],
				[2, 1]
			])
		).toEqual([
			{ text: "2.5", input: null },
			{ text: "0042", input: null },
			{ text: "0.25", input: null }
		])
	})

	it("pastes a Google Sheets formula showing nothing into a text file as an empty field, an own formula as its text", async () => {
		const { session } = await openKeys("x,y,z\n")
		const html =
			"<table><tr>" +
			'<td data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;&quot;}" data-sheets-formula="=IF(R[0]C[1]=&quot;&quot;,&quot;&quot;,R[0]C[1]*2)"></td>' +
			'<td data-filen-cell="0,1" data-filen-formula="=A1+1"></td>' +
			"<td>kept</td>" +
			"</tr></table>"

		await session.command({ type: "clipboard.pasteHtml", sheet: 0, at: { row: 0, col: 0 }, html, text: "" })

		expect(
			await texts(session, [
				[0, 0],
				[0, 1],
				[0, 2]
			])
		).toEqual([
			{ text: "", input: null },
			{ text: "=A1+1", input: null },
			{ text: "kept", input: null }
		])
	})

	it("keeps exact values and formulas in the file's syntax under a session locale, and reads typed text in it", async () => {
		const { session } = await openKeys({ sheets: [{ name: "S", body: sheetBody([[{ f: "SUM(1,2.5)", v: 3.5 }]]) }] })

		session.configure({ locale: { decimal: ",", group: ".", argument: ";", dateOrder: "dmy" } })

		const html =
			'<table><tr><td data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:1.5}">1,5</td><td>2,5</td>' +
			'<td data-sheets-formula="=R[0]C[-2]+0.5">2</td></tr></table>'

		await session.command({ type: "clipboard.pasteHtml", sheet: 0, at: { row: 1, col: 0 }, html, text: "" })

		const copy = await session.query("copy", { sheet: 0, range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, cut: false })

		if ("refused" in copy) throw new Error("refused")

		await session.command({ type: "clipboard.paste", sheet: 0, at: { row: 2, col: 0 }, text: copy.text, clip: copy.clip })

		// Shown in the session's locale.
		expect(
			(
				await texts(session, [
					[1, 0],
					[1, 1],
					[1, 2],
					[2, 0]
				])
			).map(cell => cell.text)
		).toEqual(["1,5", "2,5", "2", "3,5"])

		const reopened = await openFixture(await savedBytes(session))
		const tile = await firstTile(reopened.session, 0)

		expect([
			tileEntry(tile, 1, 0)?.text,
			tileEntry(tile, 1, 1)?.text,
			tileEntry(tile, 1, 2)?.input,
			tileEntry(tile, 2, 0)?.input
		]).toEqual(["1.5", "2.5", "=A2+0.5", "=SUM(1,2.5)"])
	})

	it("copies formulas in the file's syntax under a session locale", async () => {
		const { session } = await openKeys({ sheets: [{ name: "S", body: sheetBody([[{ f: "SUM(1,2.5)", v: 3.5 }]]) }] })

		session.configure({ locale: { decimal: ",", group: ".", argument: ";", dateOrder: "dmy" } })

		const copied = await session.query("copyHtml", { sheet: 0, range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 } })

		expect(copied.html).toContain('data-filen-formula="=SUM(1,2.5)"')
	})

	it("pastes a cut whose sheet was deleted as its text, and copies nothing from a sheet that is gone", async () => {
		const { session } = await openKeys({
			sheets: [
				{ name: "One", body: sheetBody([[]]) },
				{ name: "Two", body: sheetBody([["moved", { f: "1+1", v: 2 }]]) }
			]
		})
		const cut = await session.query("copy", { sheet: 1, range: { startRow: 0, startCol: 0, endRow: 0, endCol: 1 }, cut: true })

		if ("refused" in cut) throw new Error("refused")

		await session.command({ type: "sheet.delete", sheet: 1 })

		const pasted = await session.command({ type: "clipboard.paste", sheet: 0, at: { row: 0, col: 0 }, text: cut.text, clip: cut.clip })
		const html = await session.command({
			type: "clipboard.pasteHtml",
			sheet: 0,
			at: { row: 1, col: 0 },
			html: "<p>none</p>",
			text: cut.text,
			clip: cut.clip
		})

		expect([pasted.ok, html.ok]).toEqual([true, true])
		expect(
			await texts(session, [
				[0, 0],
				[0, 1],
				[1, 1]
			])
		).toEqual([
			{ text: "moved", input: null },
			{ text: "2", input: null },
			{ text: "2", input: null }
		])
		expect(
			await session.query("copy", { sheet: 1, range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 }, cut: false })
		).toMatchObject({
			text: ""
		})
		expect(await session.query("copyHtml", { sheet: 1, range: { startRow: 0, startCol: 0, endRow: 0, endCol: 0 } })).toEqual({
			html: null
		})
	})

	it("merges the cells a table's spans join, in the paste's undo step, and refuses spans across a merge", async () => {
		const body = `${sheetBody([["old", "old"], ["old"]])}<mergeCells count="1"><mergeCell ref="E1:F1"/></mergeCells>`
		const { session } = await openKeys({ sheets: [{ name: "S", body }] })
		const html = "<table><tr><td colspan=2>wide</td><td rowspan=2>tall</td></tr><tr><td>a</td><td>b</td></tr></table>"
		const pasted = await session.command({ type: "clipboard.pasteHtml", sheet: 0, at: { row: 0, col: 0 }, html, text: "" })
		// Merges as "startRow,startCol,endRow,endCol", sorted.
		const layout = async (): Promise<string[]> => {
			const quads = Array.from((await session.layout(0)).merges)

			return Array.from({ length: quads.length / 4 }, (_, k) => quads.slice(k * 4, k * 4 + 4).join(",")).sort()
		}

		expect(pasted.ok).toBe(true)
		expect(await layout()).toEqual(["0,0,0,1", "0,2,1,2", "0,4,0,5"])
		expect(
			await texts(session, [
				[0, 0],
				[0, 1],
				[0, 2],
				[1, 0],
				[1, 1]
			])
		).toEqual([
			{ text: "wide", input: null },
			{ text: "", input: null },
			{ text: "tall", input: null },
			{ text: "a", input: null },
			{ text: "b", input: null }
		])

		await session.undo()
		expect(await layout()).toEqual(["0,4,0,5"])
		expect((await texts(session, [[0, 1]]))[0]?.text).toBe("old")

		const across = await session.command({ type: "clipboard.pasteHtml", sheet: 0, at: { row: 0, col: 3 }, html, text: "" })

		expect(across.ok ? null : across.refusal.reason).toBe("merged")
	})
})
