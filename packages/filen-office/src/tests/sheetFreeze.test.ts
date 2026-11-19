import { describe, expect, it } from "vitest"
import { openTextSession } from "../core/sheet/text"
import { encodeUtf8 } from "../core/xml/index"
import { parts } from "./xlsxWriteFixtures"
import { IMMEDIATE, cells, openFixture, savedBytes, changeOf } from "./sheetSessionFixtures"

// Frozen panes: written into the sheet's first view (§18.3.1.66), shown in the layout; a text file keeps them in
// the session alone.

describe("sheet session: frozen panes", () => {
	it("freezes rows and columns into the first view, unfreezes, and undoes to the source", async () => {
		const { session, info, bytes } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetViews><sheetView tabSelected="1" workbookViewId="0"><selection activeCell="C4" sqref="C4"/></sheetView></sheetViews><sheetData/>'
				}
			]
		})
		const sheet = info.sheets[0]!.id
		const frozen = changeOf(await session.command({ type: "view.freeze", sheet, rows: 3, cols: 2 }))

		expect(frozen.layouts[0]?.layout.pane).toEqual({ rows: 3, cols: 2, firstRow: 0, firstCol: 0, topRow: 3, leftCol: 2 })
		expect(frozen.state.dirty).toBe(true)

		const saved = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(saved).toContain('<pane xSplit="2" ySplit="3" topLeftCell="C4" activePane="bottomRight" state="frozen"/>')
		expect(saved).toContain('<selection pane="bottomRight" activeCell="C4" sqref="C4"/>')

		const top = changeOf(await session.command({ type: "view.freeze", sheet, rows: 1, cols: 0 }))

		expect(top.layouts[0]?.layout.pane).toEqual({ rows: 1, cols: 0, firstRow: 0, firstCol: 0, topRow: 1, leftCol: 0 })
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain(
			'<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
		)

		const none = changeOf(await session.command({ type: "view.freeze", sheet, rows: 0, cols: 0 }))

		expect(none.layouts[0]?.layout.pane).toBeNull()
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).not.toContain("<pane")

		for (let k = 0; k < 3; k++) changeOf(await session.undo())

		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toBe(parts(bytes)["xl/worksheets/sheet1.xml"])
		session.close()
	})

	it("freezes after rows were inserted, keeping the views as the insert left them", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetViews><sheetView workbookViewId="0"><selection activeCell="A5" sqref="A5"/></sheetView><sheetView workbookViewId="1"><selection activeCell="B9" sqref="B9"/></sheetView></sheetViews><sheetData/>'
				}
			]
		})
		const sheet = info.sheets[0]!.id

		changeOf(await session.command({ type: "axis.insert", sheet, axis: "rows", at: 0, count: 2 }))
		changeOf(await session.command({ type: "view.freeze", sheet, rows: 1, cols: 0 }))

		const saved = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		// The second view (workbook view 1) moved with the insert; the first is frozen.
		expect(saved).toContain('activeCell="B11" sqref="B11"')
		expect(saved).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>')
		session.close()
	})

	it("starts a frozen view at the first row and column it freezes, as the panes it writes count from there", async () => {
		// ySplit and xSplit count the rows and columns of the top-left pane, which starts at the view's topLeftCell
		// (ECMA-376 Part 1 §18.3.1.66, §18.3.1.87); the frozen rows and columns here start at A1.
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetViews><sheetView workbookViewId="0" topLeftCell="C40"><selection activeCell="D45" sqref="D45"/></sheetView></sheetViews><sheetData/>'
				}
			]
		})
		const sheet = info.sheets[0]!.id
		const view = async (): Promise<string> =>
			/<sheetView\b[^>]*>/.exec(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? "")?.[0] ?? ""

		changeOf(await session.command({ type: "view.freeze", sheet, rows: 1, cols: 0 }))
		// Columns are not frozen: the view keeps its horizontal scroll.
		expect(await view()).toBe('<sheetView workbookViewId="0" topLeftCell="C1">')

		changeOf(await session.command({ type: "view.freeze", sheet, rows: 2, cols: 1 }))
		expect(await view()).toBe('<sheetView workbookViewId="0">')

		changeOf(await session.undo())
		changeOf(await session.undo())
		expect(await view()).toBe('<sheetView workbookViewId="0" topLeftCell="C40">')
		session.close()
	})

	// Excel freezes the rows (columns) shown when the view is scrolled: the view's topLeftCell is the first frozen one,
	// ySplit (xSplit) counts from it (MS-OI29500 §2.1.640 d), and the pane's topLeftCell is where the scrolling
	// pane starts ([MS-XLS] Pane rwTop, colLeft).
	for (const [name, view, pane] of [
		[
			"frozen rows of a scrolled view",
			'<sheetView workbookViewId="0" topLeftCell="A4"><pane ySplit="2" topLeftCell="A6" activePane="bottomLeft" state="frozen"/></sheetView>',
			{ rows: 2, cols: 0, firstRow: 3, firstCol: 0, topRow: 5, leftCol: 0 }
		],
		[
			"frozen columns of a view scrolled down",
			'<sheetView workbookViewId="0" topLeftCell="A16"><pane xSplit="2" topLeftCell="C1" activePane="topRight" state="frozen"/></sheetView>',
			{ rows: 0, cols: 2, firstRow: 0, firstCol: 0, topRow: 15, leftCol: 2 }
		],
		[
			"frozen rows and columns, the scrolling pane scrolled on",
			'<sheetView workbookViewId="0" topLeftCell="A12"><pane xSplit="2" ySplit="3" topLeftCell="C33" activePane="bottomRight" state="frozen"/></sheetView>',
			{ rows: 3, cols: 2, firstRow: 11, firstCol: 0, topRow: 32, leftCol: 2 }
		],
		[
			"frozen rows of a view scrolled right",
			'<sheetView workbookViewId="0" topLeftCell="B1"><pane ySplit="5" topLeftCell="A365" activePane="bottomLeft" state="frozen"/></sheetView>',
			{ rows: 5, cols: 0, firstRow: 0, firstCol: 0, topRow: 364, leftCol: 1 }
		]
	] as const) {
		it(`shows ${name} as Excel does, and saves it as it was`, async () => {
			const { session, info, bytes } = await openFixture({
				sheets: [
					{ name: "One", body: `<sheetViews>${view}</sheetViews><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>` }
				]
			})
			const sheet = info.sheets[0]!.id

			expect((await session.layout(sheet)).pane).toEqual(pane)

			// An edit elsewhere keeps the view as written.
			changeOf(await session.command({ type: "cells.set", sheet, cells: cells([[0, 5, "x"]]) }))
			expect(/<sheetViews>[\s\S]*<\/sheetViews>/.exec(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? "")?.[0]).toBe(
				/<sheetViews>[\s\S]*<\/sheetViews>/.exec(parts(bytes)["xl/worksheets/sheet1.xml"] ?? "")?.[0]
			)
			session.close()
		})
	}

	it("moves a frozen block that starts past the first row with rows inserted above and in it", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body: '<sheetViews><sheetView workbookViewId="0" topLeftCell="A4"><pane ySplit="2" topLeftCell="A6" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData>'
				}
			]
		})
		const sheet = info.sheets[0]!.id
		const pane = async (): Promise<unknown> => (await session.layout(sheet)).pane

		changeOf(await session.command({ type: "axis.insert", sheet, axis: "rows", at: 0, count: 2 }))
		expect(await pane()).toEqual({ rows: 2, cols: 0, firstRow: 5, firstCol: 0, topRow: 7, leftCol: 0 })
		changeOf(await session.command({ type: "axis.insert", sheet, axis: "rows", at: 6, count: 1 }))
		expect(await pane()).toEqual({ rows: 3, cols: 0, firstRow: 5, firstCol: 0, topRow: 8, leftCol: 0 })
		changeOf(await session.command({ type: "axis.delete", sheet, axis: "rows", at: 4, count: 2 }))
		expect(await pane()).toEqual({ rows: 2, cols: 0, firstRow: 4, firstCol: 0, topRow: 6, leftCol: 0 })

		const saved = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(saved).toContain('<sheetView workbookViewId="0" topLeftCell="A5"><pane ySplit="2" topLeftCell="A7"')
		session.close()
	})

	it("drops the selections of panes a smaller split no longer has", async () => {
		const { session, info } = await openFixture({
			sheets: [
				{
					name: "One",
					body:
						'<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>' +
						'<selection pane="topRight" activeCell="B1" sqref="B1"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/><selection pane="bottomRight" activeCell="C3" sqref="C3"/></sheetView></sheetViews><sheetData/>'
				}
			]
		})

		changeOf(await session.command({ type: "view.freeze", sheet: info.sheets[0]!.id, rows: 1, cols: 0 }))

		const saved = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(saved).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>')
		expect(saved).not.toContain('pane="topRight"')
		expect(saved).not.toContain('pane="bottomRight"')
		expect([...saved.matchAll(/<selection\b/g)].length).toBe(1)
		session.close()
	})

	it("refuses a split past the sheet", async () => {
		const { session, info } = await openFixture({ sheets: [{ name: "One", body: "<sheetData/>" }] })
		const result = await session.command({ type: "view.freeze", sheet: info.sheets[0]!.id, rows: 1_048_576, cols: 0 })

		expect(result.ok ? null : result.refusal.reason).toBe("tooLarge")
		session.close()
	})

	it("keeps a text file's panes in the session: the file stays as it was", async () => {
		const bytes = encodeUtf8("a,b\n1,2\n")
		const opened = await openTextSession(bytes.slice(), { kind: "csv", slicing: IMMEDIATE }, () => undefined)

		if (opened.kind !== "opened") throw new Error(opened.kind)

		const change = changeOf(await opened.session.command({ type: "view.freeze", sheet: 0, rows: 1, cols: 0 }))

		expect(change.layouts[0]?.layout.pane).toEqual({ rows: 1, cols: 0, firstRow: 0, firstCol: 0, topRow: 1, leftCol: 0 })
		expect(change.state.dirty).toBe(false)
		expect((await opened.session.layout(0)).pane).toEqual({ rows: 1, cols: 0, firstRow: 0, firstCol: 0, topRow: 1, leftCol: 0 })
		opened.session.close()
	})
})
