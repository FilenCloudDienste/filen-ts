import type { ByteSource } from "../opc/io"
import type { InflateHook } from "../opc/zipReader"
import { RenderStyleTable } from "../sheet/session"
import { XlsxDocument } from "../xlsx/edit/document"
import { ColFlag, RowFlag, type XlsxSheetModel } from "../xlsx/model/types"
import { openOds } from "./open"
import { sameContent } from "./write/cells"
import { sameShown } from "./write/dataStyle"
import { SheetView } from "./write/sheet"
import { currentLinks, currentNotes, currentSection, currentValidations, sectionText } from "./write/features"
import { filterRange } from "./write/filters"
import { sameRects } from "./write/validations"
import { currentConditions, sameConditions } from "./write/conditions"
import { sameView } from "./write/settings"
import { printRanges } from "./write/content"
import { odsSource } from "./source"
import { cellPrint, unheldDifference } from "./unheld"
import type { SheetStyles } from "../sheet/style/resolve"
import { runSliced, type SliceClock } from "../slicing"
import { canonicalFormula } from "./formula/toOf"

// The proof of an OpenDocument save: the written file read back by the reader, every sheet compared with the
// session's model as the cells show (values, formulas, formats as they look), rows, columns and merges. A save whose
// file reads back otherwise is refused, naming the first difference.

export type OdsProof = { readonly ok: true } | { readonly ok: false; readonly message: string }

// What a format shows of itself, but its number format (compared by what values show through it).
function lookKey(styles: SheetStyles, xf: number): string {
	const protection = styles.protection(xf)
	const base = styles.renderStyle(0)
	const own = styles.renderStyle(xf)
	// A font of no name, size or colour has the base font's.
	const render = { ...own, font: own.font ?? base.font, size: own.size ?? base.size, color: own.color ?? base.color }

	return JSON.stringify([
		Object.keys(render)
			.sort()
			.map(key => [key, render[key as keyof typeof render]]),
		protection?.locked !== false,
		protection?.hidden === true,
		protection?.hideAll === true
	])
}

export class Styles {
	private readonly a: SheetStyles
	private readonly b: SheetStyles
	private readonly memo = new Map<number, boolean>()
	private readonly keysA = new Map<number, string>()
	private readonly keysB = new Map<number, string>()

	constructor(a: SheetStyles, b: SheetStyles) {
		this.a = a
		this.b = b
	}

	same(xfA: number, xfB: number): boolean {
		const key = xfA * 0x10000 + xfB
		let same = this.memo.get(key)

		if (same === undefined) {
			let left = this.keysA.get(xfA)
			let right = this.keysB.get(xfB)

			if (left === undefined) this.keysA.set(xfA, (left = lookKey(this.a, xfA)))
			if (right === undefined) this.keysB.set(xfB, (right = lookKey(this.b, xfB)))

			same =
				left === right &&
				sameShown(this.a.numFmtCode(xfA), this.b.numFmtCode(xfB), { palette: this.a.palette }, { palette: this.b.palette })
			this.memo.set(key, same)
		}

		return same
	}
}

function storeRows(view: SheetView): number[] {
	return view.storeRowsIn(0, Number.MAX_SAFE_INTEGER)
}

// Row bounds where what a row holds of its own may change: stored rows (and the row after each), the runs' bounds.
function rowBounds(view: SheetView, into: Set<number>): void {
	for (const row of storeRows(view)) {
		into.add(row)
		into.add(row + 1)
	}

	view.model.styleRuns?.forEach({ startRow: 0, startCol: 0, endRow: 0xfffff, endCol: 0x3fff }, (startRow, _c, endRow) => {
		into.add(startRow)
		into.add(endRow + 1)
	})

	for (const run of view.model.rowRuns ?? []) {
		into.add(run.first)
		into.add(run.last + 1)
	}
}

// A generator: it yields after each row, for the caller to give the host a turn when the slice is up.
function* compareSheet(name: string, a: SheetView, b: SheetView, styles: Styles): Generator<void, string | null> {
	const bounds = new Set<number>([0])

	rowBounds(a, bounds)
	rowBounds(b, bounds)

	const rows = [...bounds].sort((x, y) => x - y)
	const last = Math.max(rows[rows.length - 1] ?? 0, 0)

	for (const row of rows) {
		if (row > last) break

		const propsA = a.rowProps(row)
		const propsB = b.rowProps(row)
		const mask = RowFlag.HIDDEN | RowFlag.OUTLINE_MASK

		if ((propsA.flags & mask) !== (propsB.flags & mask)) return `${name} row ${row + 1}: hidden or outline level`
		if (a.height(propsA) !== b.height(propsB)) return `${name} row ${row + 1}: height ${a.height(propsA)} → ${b.height(propsB)}`

		const cols = new Set<number>([0])

		for (const view of [a, b]) {
			for (const col of view.cellCols(row)) {
				cols.add(col)
				cols.add(col + 1)
			}

			view.styleBounds(row, cols)
		}

		for (const col of [...cols].sort((x, y) => x - y)) {
			if (col > 0x3fff) continue

			const left = a.cell(row, col)
			const right = b.cell(row, col)

			if (!sameContent(left, right)) return `${name} ${cellName(row, col)}: ${describe(left)} → ${describe(right)}`
			if (!styles.same(left.xf, right.xf)) return `${name} ${cellName(row, col)}: format`
		}

		yield
	}

	// Columns: widths, visibility and formats.
	const colBounds = new Set<number>([0])

	for (const view of [a, b])
		for (const range of view.model.cols) {
			colBounds.add(range.first)
			colBounds.add(range.last + 1)
		}

	for (const col of colBounds) {
		if (col > 0x3fff) continue

		const left = column(a, col)
		const right = column(b, col)

		if (left.px !== right.px) return `${name} column ${col + 1}: width ${left.px} → ${right.px}`
		if (left.hidden !== right.hidden) return `${name} column ${col + 1}: hidden`
		if (!styles.same(left.style, right.style)) return `${name} column ${col + 1}: format`
	}

	const merges = (model: XlsxSheetModel): string =>
		JSON.stringify([...Array(model.merges.length / 4).keys()].map(k => [...model.merges.slice(k * 4, k * 4 + 4)].join(",")).sort())

	if (merges(a.model) !== merges(b.model)) return `${name}: merged cells`

	return null
}

export function column(view: SheetView, col: number): { px: number; hidden: boolean; style: number } {
	for (const range of view.model.cols) {
		if (col >= range.first && col <= range.last)
			return { px: view.columnPx(range), hidden: (range.flags & ColFlag.HIDDEN) !== 0, style: Math.max(0, range.style) }
	}

	return { px: view.defaultColumnPx(), hidden: false, style: 0 }
}

function cellName(row: number, col: number): string {
	let text = ""

	for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + ((n - 1) % 26)) + text

	return `${text}${row + 1}`
}

function describe(cell: {
	readonly value: number
	readonly number: number
	readonly text: string
	readonly formula: string | null
}): string {
	return JSON.stringify([cell.value, cell.number, cell.text.slice(0, 40), cell.formula?.slice(0, 60) ?? null])
}

function protectionKey(protection: XlsxSheetModel["protection"]): string {
	if (protection === null) return ""

	return JSON.stringify([protection.hash.hashValue ?? "", protection.hash.algorithmName ?? "", [...protection.allows].sort()])
}

function printArea(document: XlsxDocument, sheet: number, name: string): string | undefined {
	const defined = document.workbook.definedNames.find(entry => entry.sheet === sheet && entry.name.toUpperCase() === "_XLNM.PRINT_AREA")

	return defined === undefined ? undefined : printRanges(defined.formula, name)
}

// The first cell two maps differ at, null when they hold the same.
function sameMaps<T>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>, same: (x: T, y: T) => boolean): string | null {
	for (const [cell, value] of a) {
		const other = b.get(cell)

		if (other === undefined || !same(value, other)) return cell
	}

	for (const cell of b.keys()) if (!a.has(cell)) return cell

	return null
}

// Defined names but those the writer keeps elsewhere (print areas on their tables, filters as database ranges), by
// scope's sheet name, formulas canonical.
function namesKey(document: XlsxDocument): string {
	const sheets = new Map(document.workbook.sheets.map(entry => [entry.id, entry.name]))

	return JSON.stringify(
		document.workbook.definedNames
			.filter(name => !/^_xlnm\.(print_area|_filterdatabase)$/i.test(name.name))
			.map(name => [
				name.sheet === null ? "" : (sheets.get(name.sheet) ?? "?"),
				name.name.toUpperCase(),
				canonicalFormula(name.formula),
				name.hidden === true
			])
			.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1))
	)
}

export async function verifyOds(document: XlsxDocument, written: ByteSource, inflate?: InflateHook, clock?: SliceClock): Promise<OdsProof> {
	const opened = await openOds(written, { ...(inflate !== undefined && { inflate }), ...(clock !== undefined && { slicing: clock }) })

	if (!opened.ok) return { ok: false, message: `The save does not open: ${opened.reason}: ${opened.message}` }

	const again = new XlsxDocument(opened.workbook, new RenderStyleTable(), { kind: document.kind })
	const styles = new Styles(document.styles, again.styles)
	const sheetsA = document.workbook.sheets.filter(entry => entry.kind === "worksheet")
	const sheetsB = again.workbook.sheets

	if (sheetsA.length !== sheetsB.length) return { ok: false, message: `${sheetsB.length} sheets read back, not ${sheetsA.length}` }

	for (let k = 0; k < sheetsA.length; k++) {
		const entryA = sheetsA[k]
		const entryB = sheetsB[k]

		if (entryA === undefined || entryB === undefined) continue
		if (entryA.name !== entryB.name) return { ok: false, message: `Sheet ${k + 1} reads back as ${entryB.name}, not ${entryA.name}` }
		if ((entryA.state === "visible") !== (entryB.state === "visible")) return { ok: false, message: `${entryA.name}: visibility` }

		const modelA = entryA.model
		const modelB = entryB.model

		if (modelA === null || modelB === null) return { ok: false, message: `${entryA.name}: not read` }

		const difference = await runSliced(
			compareSheet(entryA.name, new SheetView(document, modelA), new SheetView(again, modelB), styles),
			clock
		)

		if (difference !== null) return { ok: false, message: difference }

		if (!sameView(modelA.view, modelB.view)) return { ok: false, message: `${entryA.name}: view (panes, position, active cell, zoom)` }
		if (protectionKey(modelA.protection) !== protectionKey(modelB.protection))
			return { ok: false, message: `${entryA.name}: protection` }
		if (printArea(document, entryA.id, entryA.name) !== printArea(again, entryB.id, entryB.name))
			return { ok: false, message: `${entryA.name}: print area` }

		const sourceA = odsSource(document.workbook)
		const sourceB = odsSource(again.workbook)

		if (sourceA !== undefined && sourceB !== undefined) {
			const notes = sameMaps(
				await currentNotes(document.workbook, sourceA, modelA),
				await currentNotes(again.workbook, sourceB, modelB),
				(x, y) => x.text === y.text && x.author === y.author
			)

			if (notes !== null) return { ok: false, message: `${entryA.name} ${notes}: note` }

			const links = sameMaps(currentLinks(document.workbook, modelA), currentLinks(again.workbook, modelB), (x, y) => x === y)

			if (links !== null) return { ok: false, message: `${entryA.name} ${links}: link` }
			if (!sameRects(currentValidations(document.workbook, modelA), currentValidations(again.workbook, modelB)))
				return { ok: false, message: `${entryA.name}: validations` }

			const filter = (workbook: XlsxDocument["workbook"], model: XlsxSheetModel): string | null =>
				filterRange(
					currentSection(workbook, model, "autoFilter") ?? sectionText(model.sections, "autoFilter"),
					entryA.name,
					"filter"
				)

			if (filter(document.workbook, modelA) !== filter(again.workbook, modelB))
				return { ok: false, message: `${entryA.name}: filter` }

			// Conditional formats of a source table (a new one's are a conversion's, which reports what it could not say).
			const table = sourceA.tables[entryA.id]

			if (
				table !== undefined &&
				table.id === entryA.id &&
				"rowAxis" in modelA &&
				!sameConditions(
					currentConditions(document.workbook, modelA),
					document.workbook.styles.dxfs,
					currentConditions(again.workbook, modelB),
					again.workbook.styles.dxfs
				)
			)
				return { ok: false, message: `${entryA.name}: conditional formatting` }
		}
	}

	if ((document.workbook.protection?.structure === true) !== (again.workbook.protection?.structure === true))
		return { ok: false, message: "The workbook's protection" }

	const activeA = document.workbook.sheets.find(entry => entry.id === document.activeSheet())?.name
	const activeB = again.workbook.sheets.find(entry => entry.id === again.activeSheet())?.name

	if (activeA !== activeB) return { ok: false, message: `The active sheet reads back as ${activeB ?? ""}, not ${activeA ?? ""}` }

	const namesA = namesKey(document)
	const namesB = namesKey(again)

	if (namesA !== namesB) return { ok: false, message: "Defined names" }

	// What names cells by address outside the model: moved as the sheets were, never left as it was.
	const sourceA = odsSource(document.workbook)
	const sourceB = odsSource(again.workbook)

	if (sourceA !== undefined && sourceB !== undefined) {
		const stale = unheldDifference(document.workbook, sourceA, sourceB, (sheet, row, col) =>
			cellPrint(document.workbook.sheets.find(entry => entry.name === sheet)?.model, document.workbook.sharedStrings, row, col)
		)

		if (stale !== null) return { ok: false, message: stale }
	}

	return { ok: true }
}
