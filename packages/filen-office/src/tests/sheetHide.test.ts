import { describe, expect, it } from "vitest"
import { AxisFlag } from "../core/sheet/protocol"
import { withHidden } from "../core/xlsx/edit/hide"
import { ColFlag } from "../core/xlsx/model/types"
import { parts } from "./xlsxWriteFixtures"
import { openFixture, savedBytes, changeOf } from "./sheetSessionFixtures"
import { budget } from "./timing"

// Rows and columns hidden and shown: the row and col records written, the layout's flags, protection.

const SHEET = {
	sheets: [
		{
			name: "One",
			body: '<sheetFormatPr defaultRowHeight="15"/><cols><col min="2" max="4" width="12" customWidth="1"/></cols><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="3" ht="0" customHeight="1"><c r="A3"><v>3</v></c></row></sheetData>'
		}
	]
}

describe("column ranges hidden and shown", () => {
	it("splits a range where the flag changes and gives a gap its own range", () => {
		const cols = withHidden([{ first: 1, last: 3, width: 12, style: -1, flags: ColFlag.CUSTOM_WIDTH }], 0, 2, true, 9)

		expect(cols).toEqual([
			{ first: 0, last: 0, width: 9, style: -1, flags: ColFlag.HIDDEN },
			{ first: 1, last: 2, width: 12, style: -1, flags: ColFlag.CUSTOM_WIDTH | ColFlag.HIDDEN },
			{ first: 3, last: 3, width: 12, style: -1, flags: ColFlag.CUSTOM_WIDTH }
		])
	})

	it("drops a range left with nothing of its own when shown", () => {
		expect(withHidden([{ first: 5, last: 5, width: Number.NaN, style: -1, flags: ColFlag.HIDDEN }], 5, 5, false, 9)).toEqual([])
	})
})

describe("sheet session: rows and columns hidden", () => {
	it("hides rows and columns, writes them, shows them in the layout and undoes to the source", async () => {
		const { session, info, bytes } = await openFixture(SHEET)
		const sheet = info.sheets[0]!.id
		const rows = changeOf(
			await session.command({ type: "axis.hide", sheet, axis: "rows", spans: [{ start: 0, end: 1 }], hidden: true })
		)
		const cols = changeOf(
			await session.command({ type: "axis.hide", sheet, axis: "cols", spans: [{ start: 2, end: 2 }], hidden: true })
		)
		const rowLayout = rows.layouts[0]?.layout.rows
		const colLayout = cols.layouts[0]?.layout.cols

		expect(
			rowLayout === undefined ? [] : [...rowLayout.indices].filter((_, k) => ((rowLayout.flags[k] ?? 0) & AxisFlag.HIDDEN) !== 0)
		).toEqual([0, 1])
		expect(
			colLayout === undefined ? [] : [...colLayout.indices].filter((_, k) => ((colLayout.flags[k] ?? 0) & AxisFlag.HIDDEN) !== 0)
		).toEqual([2])

		const saved = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(saved).toContain('<row r="1" hidden="1">')
		expect(saved).toContain('<row r="2" hidden="1"/>')
		expect(saved).toContain('<col min="3" max="3" width="12" hidden="1" customWidth="1"/>')

		changeOf(await session.undo())
		changeOf(await session.undo())
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
		session.close()
	})

	it("stores a hidden default column at the default width, which it shows at again", async () => {
		const { session, info } = await openFixture({
			sheets: [{ name: "One", body: '<sheetData><row r="1"><c r="C1"><v>1</v></c></row></sheetData>' }]
		})
		const sheet = info.sheets[0]!.id

		changeOf(await session.command({ type: "axis.hide", sheet, axis: "cols", spans: [{ start: 2, end: 2 }], hidden: true }))
		// Excel's default 64 px column, its padding counted (ECMA-376 Part 1 §18.3.1.13).
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toMatch(/<col [^>]*min="3"[^>]*width="9.140625"/)

		const shown = changeOf(
			await session.command({ type: "axis.hide", sheet, axis: "cols", spans: [{ start: 2, end: 2 }], hidden: false })
		)
		const cols = shown.layouts[0]?.layout.cols
		const at = cols === undefined ? -1 : [...cols.indices].indexOf(2)

		expect(at < 0 ? cols?.defaultSize : cols?.sizes[at]).toBe(64)
		session.close()
	})

	it("hides 20,000 rows across row blocks in one pass", { timeout: 20_000 }, async () => {
		let rows = ""

		for (let r = 1; r <= 20_000; r++) rows += `<row r="${String(r)}"><c r="A${String(r)}"><v>${String(r)}</v></c></row>`

		const { session, info } = await openFixture({ sheets: [{ name: "One", body: `<sheetData>${rows}</sheetData>` }] })
		const started = performance.now()
		const change = changeOf(
			await session.command({
				type: "axis.hide",
				sheet: info.sheets[0]!.id,
				axis: "rows",
				spans: [{ start: 0, end: 19_999 }],
				hidden: true
			})
		)

		// One row at a time rebuilt each row's block: seconds.
		expect(performance.now() - started).toBeLessThan(budget(3000))

		const layout = change.layouts[0]?.layout.rows
		const hidden = (row: number): boolean => {
			const at = layout === undefined ? -1 : [...layout.indices].indexOf(row)

			return at >= 0 && ((layout?.flags[at] ?? 0) & AxisFlag.HIDDEN) !== 0
		}

		expect([hidden(0), hidden(1024), hidden(19_999)]).toEqual([true, true, true])
		session.close()
	})

	it("shows a row of no height at the default height, as Excel unhides it", async () => {
		const { session, info } = await openFixture(SHEET)

		changeOf(
			await session.command({
				type: "axis.hide",
				sheet: info.sheets[0]!.id,
				axis: "rows",
				spans: [{ start: 0, end: 5 }],
				hidden: false
			})
		)
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain('<row r="3"><c r="A3"><v>3</v></c></row>')
		session.close()
	})

	it("refuses under sheet protection that does not allow formatting rows, and past the rows one command hides", async () => {
		const protectedSheet = await openFixture({
			sheets: [{ name: "One", body: '<sheetData/><sheetProtection sheet="1"/>' }]
		})
		const refused = await protectedSheet.session.command({
			type: "axis.hide",
			sheet: protectedSheet.info.sheets[0]!.id,
			axis: "rows",
			spans: [{ start: 0, end: 0 }],
			hidden: true
		})

		expect(refused.ok ? null : refused.refusal).toEqual({ reason: "protectedSheet", detail: "formatRows" })
		protectedSheet.session.close()

		const { session, info } = await openFixture(SHEET)
		const tooMany = await session.command({
			type: "axis.hide",
			sheet: info.sheets[0]!.id,
			axis: "rows",
			spans: [{ start: 0, end: 70_000 }],
			hidden: true
		})

		expect(tooMany.ok ? null : tooMany.refusal.reason).toBe("tooLarge")
		session.close()
	})
})
