import { describe, expect, it } from "vitest"
import { XLSX_FEATURES } from "../core/sheet/commands"
import type { SheetChange, SheetRenderStyle, SheetSessionApi, SheetTile } from "../core/sheet/protocol"
import { borderPresetEdges, type SheetBorderPreset } from "../core/sheet/style/borders"
import { formattingFeature } from "../core/xlsx/edit/formatFeature"
import { inThreadSheetHost } from "../dom/sheet/host"
import { IMMEDIATE, buildFixture, cells, savedBytes, tileEntry, changeOf } from "./sheetSessionFixtures"
import { STYLES, parts, type Fixture } from "./xlsxWriteFixtures"

async function open(fixture: Fixture | Uint8Array): Promise<{ session: SheetSessionApi; sheet: number; looks: Looks }> {
	const bytes = fixture instanceof Uint8Array ? fixture : buildFixture(fixture)
	const result = await inThreadSheetHost().open(bytes.slice(), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

	if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

	const looks = new Looks()

	looks.add(result.info)

	return { session: result.session, sheet: result.info.activeSheet, looks }
}

function grid(rows: number, cols: number, styles?: string): Fixture {
	const body = Array.from({ length: rows }, (_, r) => {
		const row = Array.from(
			{ length: cols },
			(_, c) => `<c r="${String.fromCharCode(65 + c)}${String(r + 1)}"><v>${String(r * cols + c)}</v></c>`
		)

		return `<row r="${String(r + 1)}">${row.join("")}</row>`
	}).join("")

	return { sheets: [{ name: "One", body: `<sheetData>${body}</sheetData>` }], ...(styles !== undefined && { styles }) }
}

// Each cell's look in a tile, by "row,col".
class Looks {
	private readonly styles = new Map<number, SheetRenderStyle>()

	add(change: { readonly styles?: { readonly from: number; readonly styles: readonly SheetRenderStyle[] } }): void {
		change.styles?.styles.forEach((style, i) => this.styles.set((change.styles?.from ?? 0) + i, style))
	}

	of(tile: SheetTile, row: number, col: number): SheetRenderStyle {
		return this.styles.get(tileEntry(tile, row, col)?.style ?? 0) ?? {}
	}
}

async function tile(session: SheetSessionApi, sheet: number, looks: Looks): Promise<SheetTile> {
	const answer = await session.tiles(sheet, Uint32Array.of(0, 0))

	looks.add(answer)

	return answer.tiles[0] as SheetTile
}

const range = (startRow: number, startCol: number, endRow: number, endCol: number) => ({ startRow, startCol, endRow, endCol })

async function preset(session: SheetSessionApi, sheet: number, name: SheetBorderPreset, at = range(1, 1, 2, 2)): Promise<SheetChange> {
	return changeOf(await session.command({ type: "format.borders", sheet, ranges: [at], edges: borderPresetEdges(name) }))
}

function sides(style: SheetRenderStyle): string {
	return (["top", "right", "bottom", "left"] as const)
		.filter(side => style[side] !== undefined)
		.map(side => `${side[0] ?? ""}:${style[side]?.style ?? ""}`)
		.join(" ")
}

describe("borders", () => {
	it("registers with every workbook session", () => {
		expect(XLSX_FEATURES).toContain(formattingFeature)
	})

	it("draws all borders on every cell, each line on both cells that share it", async () => {
		const { session, sheet, looks } = await open(grid(4, 4))

		await tile(session, sheet, looks)
		looks.add(await preset(session, sheet, "all"))

		const shown = await tile(session, sheet, looks)

		for (const [row, col] of [
			[1, 1],
			[1, 2],
			[2, 1],
			[2, 2]
		] as const)
			expect(sides(looks.of(shown, row, col))).toBe("t:thin r:thin b:thin l:thin")
		expect(sides(looks.of(shown, 0, 1))).toBe("")
		expect(sides(looks.of(shown, 3, 3))).toBe("")
		session.close()
	})

	it("puts the outline on the range's outer cells only", async () => {
		const { session, sheet, looks } = await open(grid(4, 4))

		looks.add(await preset(session, sheet, "outside"))

		const shown = await tile(session, sheet, looks)

		expect(sides(looks.of(shown, 1, 1))).toBe("t:thin l:thin")
		expect(sides(looks.of(shown, 1, 2))).toBe("t:thin r:thin")
		expect(sides(looks.of(shown, 2, 1))).toBe("b:thin l:thin")
		expect(sides(looks.of(shown, 2, 2))).toBe("r:thin b:thin")
		session.close()
	})

	it("keeps the thick and double presets' own styles", async () => {
		const { session, sheet, looks } = await open(grid(4, 4))

		looks.add(await preset(session, sheet, "thickOutside", range(1, 1, 1, 1)))
		looks.add(await preset(session, sheet, "topDoubleBottom", range(2, 2, 2, 2)))

		const shown = await tile(session, sheet, looks)

		expect(sides(looks.of(shown, 1, 1))).toBe("t:thick r:thick b:thick l:thick")
		expect(sides(looks.of(shown, 2, 2))).toBe("t:thin b:double")
		session.close()
	})

	it("clears the outline and the facing lines of the cells beside it, keeping lines elsewhere", async () => {
		const { session, sheet, looks } = await open(grid(4, 4))

		await preset(session, sheet, "all", range(0, 0, 3, 3))
		looks.add(await preset(session, sheet, "none", range(1, 1, 2, 2)))

		const shown = await tile(session, sheet, looks)

		expect(sides(looks.of(shown, 1, 1))).toBe("")
		// Above, below and beside the cleared range: the facing line went, the others stayed.
		expect(sides(looks.of(shown, 0, 1))).toBe("t:thin r:thin l:thin")
		expect(sides(looks.of(shown, 3, 2))).toBe("r:thin b:thin l:thin")
		expect(sides(looks.of(shown, 1, 0))).toBe("t:thin b:thin l:thin")
		expect(sides(looks.of(shown, 2, 3))).toBe("t:thin r:thin b:thin")
		expect(sides(looks.of(shown, 0, 0))).toBe("t:thin r:thin b:thin l:thin")
		session.close()
	})

	it("writes border records and cell formats Excel reads, automatic lines in the system foreground", async () => {
		const { session, sheet } = await open(grid(2, 2, STYLES))

		await session.command({
			type: "format.borders",
			sheet,
			ranges: [range(0, 0, 0, 0)],
			edges: {
				bottom: { style: "medium" },
				top: { style: "dashed", color: { theme: 4, tint: -0.25 } },
				left: { style: "thin", color: 0xff0000 }
			}
		})

		const styles = parts(await savedBytes(session))["xl/styles.xml"] ?? ""

		expect(styles).toContain(
			'<border><left style="thin"><color rgb="FFFF0000"/></left><right/><top style="dashed"><color theme="4" tint="-0.25"/></top><bottom style="medium"><color indexed="64"/></bottom><diagonal/></border>'
		)
		expect(styles).toMatch(/<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"\/><\/cellXfs>/u)
		session.close()
	})

	it("holds both diagonals in one line and drops it with the last direction", async () => {
		const { session, sheet, looks } = await open(grid(2, 2))
		const at = [range(0, 0, 0, 0)]

		await session.command({ type: "format.borders", sheet, ranges: at, edges: { diagonalUp: { style: "thin" } } })
		looks.add(
			changeOf(await session.command({ type: "format.borders", sheet, ranges: at, edges: { diagonalDown: { style: "dashed" } } }))
		)

		let shown = await tile(session, sheet, looks)

		expect(parts(await savedBytes(session))["xl/styles.xml"]).toContain('<border diagonalUp="1" diagonalDown="1">')
		expect(looks.of(shown, 0, 0).diagonalUp?.style).toBe("dashed")
		expect(looks.of(shown, 0, 0).diagonalDown?.style).toBe("dashed")

		looks.add(changeOf(await session.command({ type: "format.borders", sheet, ranges: at, edges: { diagonalUp: null } })))
		shown = await tile(session, sheet, looks)

		expect(looks.of(shown, 0, 0).diagonalUp).toBeUndefined()
		expect(looks.of(shown, 0, 0).diagonalDown?.style).toBe("dashed")

		await session.command({ type: "format.borders", sheet, ranges: at, edges: { diagonalDown: null } })

		// No line left: the cell is back to the default format.
		expect(parts(await savedBytes(session))["xl/worksheets/sheet1.xml"]).toContain('<c r="A1"><v>0</v></c>')
		session.close()
	})

	it("undoes and redoes as one step", async () => {
		const { session, sheet, looks } = await open(grid(3, 3))

		await preset(session, sheet, "all", range(0, 0, 2, 2))
		looks.add(changeOf(await session.undo()))

		let shown = await tile(session, sheet, looks)

		expect(sides(looks.of(shown, 1, 1))).toBe("")

		looks.add(changeOf(await session.redo()))
		shown = await tile(session, sheet, looks)

		expect(sides(looks.of(shown, 1, 1))).toBe("t:thin r:thin b:thin l:thin")
		session.close()
	})

	it("adds one cell format per distinct format and place, however many cells", async () => {
		const { session, sheet } = await open(grid(40, 20, STYLES))

		await preset(session, sheet, "all", range(0, 0, 39, 19))

		const styles = parts(await savedBytes(session))["xl/styles.xml"] ?? ""

		// One format: every cell of an "all" range takes the same four lines.
		expect(styles).toContain('<cellXfs count="3">')
		session.close()
	})

	it("gives a cell without content the format of its row or column, bordered", async () => {
		const { session, sheet, looks } = await open({ sheets: [{ name: "One", body: "<sheetData/>" }] })

		looks.add(await preset(session, sheet, "bottom", range(5, 5, 5, 5)))
		await session.command({ type: "cells.set", sheet, cells: cells([[5, 5, "x"]]) })

		const shown = await tile(session, sheet, looks)

		expect(sides(looks.of(shown, 5, 5))).toBe("b:thin")
		session.close()
	})

	it("draws a whole column's bottom line on one cell in the grid's last row, as Excel writes it", async () => {
		const { session, sheet, looks } = await open(grid(3, 3))
		const column = range(0, 1, 1_048_575, 1)

		looks.add(
			changeOf(await session.command({ type: "format.borders", sheet, ranges: [column], edges: { bottom: { style: "thin" } } }))
		)

		const sheetXml = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""
		const shown = await tile(session, sheet, looks)

		expect(sheetXml).toMatch(/<row r="1048576"[^>]*><c r="B1048576" s="\d+"\/><\/row>/u)
		expect(sides(looks.of(shown, 2, 1))).toBe("")
		session.close()
	})

	it("clears the facing line of a bordered column's empty cells beside a range losing its borders", async () => {
		const { session, sheet, looks } = await open(grid(1, 1))

		looks.add(
			changeOf(
				await session.command({
					type: "format.borders",
					sheet,
					ranges: [range(0, 1, 1_048_575, 1)],
					edges: borderPresetEdges("all")
				})
			)
		)
		looks.add(await preset(session, sheet, "none", range(0, 0, 2, 0)))

		const shown = await tile(session, sheet, looks)

		// B2 has no cell of its own: it gets one, without the line column B gives it.
		for (const row of [0, 1, 2]) expect(sides(looks.of(shown, row, 1))).toBe("t:thin r:thin b:thin")
		session.close()
	})

	it("gives cells their own format back when a change undoes another, empty ones going", async () => {
		const { session, sheet } = await open(grid(1, 1, STYLES))

		await preset(session, sheet, "all", range(6, 3, 7, 4))
		await preset(session, sheet, "none", range(6, 3, 7, 4))
		changeOf(await session.command({ type: "format.apply", sheet, ranges: [range(0, 0, 0, 0)], patch: { bold: true } }))
		changeOf(await session.command({ type: "format.apply", sheet, ranges: [range(0, 0, 0, 0)], patch: { bold: false } }))

		const sheetXml = parts(await savedBytes(session))["xl/worksheets/sheet1.xml"] ?? ""

		expect(sheetXml).not.toContain('r="D7"')
		expect(sheetXml).toContain('<c r="A1"><v>0</v></c>')
		session.close()
	})

	it("is refused on a protected sheet that does not allow formatting cells", async () => {
		const fixture = grid(2, 2)
		const { session, sheet } = await open({
			sheets: [{ name: "One", body: `${fixture.sheets[0]?.body ?? ""}<sheetProtection sheet="1"/>` }]
		})
		const result = await session.command({
			type: "format.borders",
			sheet,
			ranges: [range(0, 0, 0, 0)],
			edges: borderPresetEdges("all")
		})

		expect(result.ok ? null : result.refusal).toEqual({ reason: "protectedSheet", detail: "formatCells" })
		session.close()
	})

	it("reopens with the lines it saved", async () => {
		const { session, sheet } = await open(grid(3, 3))

		await preset(session, sheet, "outside", range(0, 0, 1, 1))

		const reopened = await open(await savedBytes(session))
		const shown = await tile(reopened.session, reopened.sheet, reopened.looks)

		expect(sides(reopened.looks.of(shown, 0, 0))).toBe("t:thin l:thin")
		expect(sides(reopened.looks.of(shown, 1, 1))).toBe("r:thin b:thin")
		session.close()
		reopened.session.close()
	})
})
