import { readEntry, setCells, sharedString, splitsArray, tableHeaders, writeLogged } from "../../xlsx/edit/cells"
import type { XlsxDocument } from "../../xlsx/edit/document"
import { ABSENT, CellLog, type CellState } from "../../xlsx/edit/history"
import type { SheetStore } from "../../xlsx/model/store"
import { CellKind, FormulaKind, type XlsxSheetModel } from "../../xlsx/model/types"
import { dateSerial, MAX_SERIAL_1900, MAX_SERIAL_1904, serialDate, type DateParts } from "../numfmt/date"
import { isTimeFormat } from "../numfmt/edit"
import type { NumFmt } from "../numfmt/parse"
import { defineSheetFeature, type SheetChangeSink, type SheetHandled } from "../registry"
import type { Slicing } from "../../slicing"
import { formulaTranslator } from "../refs/formulaRefs"
import { SHEET_MAX_CELL_TEXT, type SheetId, type SheetRange } from "../protocol"
import { filteredOutRows } from "../../xlsx/edit/filter"
import { visibleRanges } from "../visibleRows"
import { autoFillWrites, entryCells, seriesWrites, visibleFillPlan, type FillDirection, type FillPlan, type FillWrites } from "./fill"
import { fillSeries, seriesLine, type FillCalendar, type FillSourceCell, type FillTemporal, type FillValue } from "./series"

// Fill over an xlsx sheet: each target takes its source cell as it is (its value of whatever type, its format), a
// formula moved by the target's offset, so a copy is exact where a typed entry would be read again. Refused where a
// paste would be: locked cells, part of an array formula, a table header's text; and where merged cells are in the
// way, or the source holds an array formula or a dynamic array (whose range a copy cannot carry).

function intersects(a: SheetRange, startRow: number, startCol: number, endRow: number, endCol: number): boolean {
	return a.startRow <= endRow && startRow <= a.endRow && a.startCol <= endCol && startCol <= a.endCol
}

// Whether a source holds a formula a copy cannot carry: an array formula's, a data table's or a dynamic array's.
function arraySource(model: XlsxSheetModel, formula: number): boolean {
	if (formula < 0) return false

	const kind = model.store.formulas.kind(formula)

	return kind === FormulaKind.ARRAY || kind === FormulaKind.DATA_TABLE || model.store.formulas.formula(formula).cellMetadata >= 0
}

function temporal(format: NumFmt): FillTemporal {
	return !format.isDate ? "none" : isTimeFormat(format) ? "time" : "date"
}

// What a fill reads a source cell as (series.ts).
function sourceCell(document: XlsxDocument, model: XlsxSheetModel, sheet: SheetId, row: number, col: number): FillSourceCell {
	const state = document.state(sheet, row, col)

	if (!state.present) return { kind: "empty" }
	if (state.formula >= 0) return { kind: "formula" }

	switch (state.kind) {
		case CellKind.EMPTY:
			return { kind: "empty" }
		case CellKind.NUMBER:
			return { kind: "number", value: state.value, temporal: temporal(document.numFmt(state.style)) }
		case CellKind.SHARED_STRING:
		case CellKind.INLINE_STRING:
		case CellKind.FORMULA_STRING:
			return { kind: "text", text: document.stringOf(model, state.kind, state.value) }
		default:
			return { kind: "other" }
	}
}

function calendar(document: XlsxDocument): FillCalendar {
	const date1904 = document.date1904
	const parts: DateParts = { year: 0, month: 0, day: 0, weekday: 0 }

	return {
		date: serial => ({ ...serialDate(serial, date1904, parts) }),
		serial: (year, month, day) => dateSerial(year, month, day, date1904),
		maxSerial: date1904 ? MAX_SERIAL_1904 : MAX_SERIAL_1900
	}
}

// The state a target takes from its source: the source as it is, or a value of its own in the source's format.
function copied(
	document: XlsxDocument,
	model: XlsxSheetModel,
	plan: FillPlan,
	i: number,
	sheet: SheetId,
	value: FillValue | undefined
): CellState {
	const row = plan.rows[i] ?? 0
	const col = plan.cols[i] ?? 0
	const sourceRow = plan.sourceRows[i] ?? 0
	const sourceCol = plan.sourceCols[i] ?? 0
	const source = document.state(sheet, sourceRow, sourceCol)

	if (value !== undefined && value.kind !== "copy") {
		const style = source.present ? source.style : document.startingStyle(model, sourceRow, sourceCol)

		return value.kind === "number"
			? { present: true, kind: CellKind.NUMBER, value: value.value, style, formula: -1, shown: undefined }
			: {
					present: true,
					kind: CellKind.SHARED_STRING,
					value: sharedString(document, value.text),
					style,
					formula: -1,
					shown: undefined
				}
	}

	if (!source.present) {
		// An empty source still gives its format (its row's or column's).
		const style = document.startingStyle(model, sourceRow, sourceCol)

		return style === 0 ? ABSENT : { present: true, kind: CellKind.EMPTY, value: 0, style, formula: -1, shown: undefined }
	}

	if (source.formula < 0)
		return { present: true, kind: source.kind, value: source.value, style: source.style, formula: -1, shown: undefined }

	const formulas = model.store.formulas
	const text = formulaTranslator(document.formulaText(model, source.formula, sourceRow, sourceCol))(row - sourceRow, col - sourceCol)
	const formula = formulas.add({ kind: FormulaKind.NORMAL, text, sharedIndex: -1, ref: null, flags: 0, cellMetadata: -1 })

	return { present: true, kind: CellKind.EMPTY, value: 0, style: source.style, formula, shown: undefined }
}

export async function fillCells(
	document: XlsxDocument,
	sheet: SheetId,
	ranges: readonly SheetRange[],
	direction: FillDirection,
	changes: SheetChangeSink,
	slicing?: Slicing
): Promise<SheetHandled> {
	const model = await document.ready(sheet)

	return writeFill(document, sheet, visibleFillPlan(ranges, direction, filteredOutRows(document, model)), changes, slicing)
}

// Writes a fill: each target its source cell, or its own value in its source's format.
async function writeFill(
	document: XlsxDocument,
	sheet: SheetId,
	plan: FillPlan | FillWrites | "tooLarge" | null,
	changes: SheetChangeSink,
	slicing: Slicing | undefined
): Promise<SheetHandled> {
	const model = await document.ready(sheet)

	if (plan === null) return null
	if (plan === "tooLarge") return { refused: { reason: "tooLarge" } }

	const values = "values" in plan ? plan.values : undefined
	const count = plan.rows.length

	for (const value of values ?? [])
		if (
			(value.kind === "number" && !Number.isFinite(value.value)) ||
			(value.kind === "text" && value.text.length > SHEET_MAX_CELL_TEXT)
		)
			return { refused: { reason: "tooLarge" } }

	for (let i = 0; i < count; i++)
		if (document.locked(sheet, plan.rows[i] ?? 0, plan.cols[i] ?? 0)) return { refused: { reason: "protectedSheet" } }

	for (let m = 0; m + 3 < model.merges.length; m += 4) {
		const merge = {
			startRow: model.merges[m] ?? 0,
			startCol: model.merges[m + 1] ?? 0,
			endRow: model.merges[m + 2] ?? 0,
			endCol: model.merges[m + 3] ?? 0
		}

		if (plan.ranges.some(range => intersects(merge, range.startRow, range.startCol, range.endRow, range.endCol)))
			return { refused: { reason: "merged" } }
	}

	if (splitsArray(model, plan.rows, plan.cols)) return { refused: { reason: "arrayFormula" } }

	if (model.relationships.all.some(relationship => relationship.type.endsWith("/table"))) {
		const headers = await tableHeaders(document, model)

		for (let i = 0; i < count; i++) {
			const row = plan.rows[i] ?? 0
			const col = plan.cols[i] ?? 0

			const value = values?.[i]
			const text =
				value === undefined || value.kind === "copy"
					? document.cellView(sheet, plan.sourceRows[i] ?? 0, plan.sourceCols[i] ?? 0).text
					: value.kind === "text"
						? value.text
						: null

			if (headers.some(range => intersects(range, row, col, row, col)) && document.cellView(sheet, row, col).text !== text)
				return { refused: { reason: "tableHeader" } }
		}
	}

	const store = model.store as SheetStore
	let formulas = false

	for (let i = 0; i < count; i++) {
		if (values !== undefined && values[i]?.kind !== "copy") continue

		const formula = store.formula(store.locate(plan.sourceRows[i] ?? 0, plan.sourceCols[i] ?? 0))

		if (arraySource(model, formula)) return { refused: { reason: "arrayFormula" } }

		formulas ||= formula >= 0
	}

	// Built from the cells as they stand before this edit, so the edit is what it recalculates.
	if (document.engine === null && document.allReady && (document.hasFormulas || formulas)) {
		await document.loadTables()
		document.buildEngine(changes)
	}

	// Every source is read before any target is written: a target never feeds another.
	const states: CellState[] = []

	for (let i = 0; i < count; i++) states.push(copied(document, model, plan, i, sheet, values?.[i]))

	return writeLogged(document, sheet, plan.rows, plan.cols, states, new CellLog(), changes, slicing)
}

export const xlsxFillFeature = defineSheetFeature<XlsxDocument>({
	id: "fill",
	commands: {
		"fill.auto": {
			info: { write: true },
			run: async (context, command) => {
				const document = context.doc
				const model = await document.ready(command.sheet)
				const read = (row: number, col: number): FillSourceCell => sourceCell(document, model, command.sheet, row, col)
				const dates = calendar(document)
				const handled = await writeFill(
					document,
					command.sheet,
					autoFillWrites(command.source, command.target, command.mode, read, (cells, mode, backward) =>
						fillSeries(cells, mode, backward, dates)
					),
					context.changes,
					context.slicing
				)

				if (handled !== null && !("refused" in handled))
					context.changes.select(command.sheet, {
						activeRow: command.source.startRow,
						activeCol: command.source.startCol,
						ranges: [command.target]
					})

				return handled
			}
		},
		"fill.series": {
			info: { write: true },
			run: async (context, command) => {
				const document = context.doc
				const model = await document.ready(command.sheet)
				const read = (row: number, col: number): FillSourceCell => sourceCell(document, model, command.sheet, row, col)
				const dates = calendar(document)
				// The stop value read as a cell entry would be: a number, a date, a time.
				const stop =
					command.options.stop === null
						? null
						: readEntry(command.options.stop.trim(), false, document.date1904, document.settings.locale)

				if (stop !== null && stop.type !== "number") return { refused: { reason: "unsupported", detail: "stop" } }

				const options = { ...command.options, stop: stop === null ? null : stop.value }

				return writeFill(
					document,
					command.sheet,
					seriesWrites(command.range, command.orientation, read, cells => seriesLine(cells, options, dates)),
					context.changes,
					context.slicing
				)
			}
		},
		"fill.copy": {
			info: { write: true },
			run: (context, command) =>
				fillCells(context.doc, command.sheet, command.ranges, command.direction, context.changes, context.slicing)
		},
		"fill.entry": {
			info: { write: true },
			run: async (context, command) => {
				const model = await context.doc.ready(command.sheet)
				const ranges = visibleRanges(command.ranges, filteredOutRows(context.doc, model))
				const cells = entryCells(ranges, model.merges, command.entry, command.from)

				if (cells === null) return null
				if (cells === "tooLarge") return { refused: { reason: "tooLarge" } }

				return setCells(context.doc, command.sheet, { ...cells, typed: true }, context.changes, undefined, context.slicing)
			}
		}
	}
})
