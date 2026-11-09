import type { SheetCommand, SheetId, SheetRange, SheetRefusal } from "../../sheet/protocol"
import type { XlsxDocument } from "../../xlsx/edit/document"
import type { SheetStore } from "../../xlsx/model/store"
import { decodeUtf8 } from "../../xml/index"
import { relationshipsPartName } from "../../opc/partNames"
import { odsChartsRefusal } from "../charts/write"
import { openFormula } from "../formula/toOf"
import { odsSource, type OdsSource } from "../source"
import { movedText, namedBoxes, shifterOf, type OdsUnheld, type Shifter } from "../unheld"
import { conditionsRefusal } from "./conditions"
import { CellRefused, declaresCalcext, paragraphText, STRICT_ERRORS, storeValue, Value } from "./cells"
import { OdsStyleWriter, StyleRefused } from "./styles"
import { printRanges } from "./content"
import { sheetValidations, ValidationRefused } from "./validations"
import { currentSection } from "./features"
import { filterRange, FilterRefused } from "./filters"
import { NameRefused, namesPlan, scopeSheetName } from "./names"
import { OdfNs } from "../../odf/namespaces"
import type { XlsxDefinedName, XlsxProtectionHash } from "../../xlsx/model/types"

// Whether the OpenDocument writer can hold what an edit just did, asked once the edit ran (and undone at once when
// it cannot): what it changed is among what the writer writes, and each cell it touched has a formula OpenFormula
// can say, a format a style can say and text a paragraph can hold. A refusal names the first thing that cannot.

// Sheet sections the writer writes from the model.
const SECTIONS: ReadonlySet<string> = new Set([
	"cols",
	"mergeCells",
	"hyperlinks",
	"sheetPr",
	"dimension",
	"legacyDrawing",
	"sheetViews",
	"sheetProtection",
	"dataValidations",
	"autoFilter",
	// Written as the source's calcext:conditional-formats moved with the cells (conditions.ts).
	"conditionalFormatting"
])
// Workbook sections (defined names: print areas, checked below).
const WORKBOOK_SECTIONS: ReadonlySet<string> = new Set(["sheets", "bookViews", "workbookProtection", "definedNames"])
const PRINT_AREA = "_XLNM.PRINT_AREA"
// Names the writer keeps with what they name: a sheet's print area on its table, its filter's range with its database
// range.
const OWN_NAMES: ReadonlySet<string> = new Set([PRINT_AREA, "_XLNM._FILTERDATABASE"])
// Parts written through what they hold (a sheet's notes), and sheets' own parts added or taken away with them.
const PARTS = /^xl\/(?:comments\d*\.xml|drawings\/vmlDrawing\d*\.vml|worksheets\/(?:_rels\/)?sheet\d+\.xml(?:\.rels)?)$/

// What each document's checks found already, by what they checked.
const known = new WeakMap<
	XlsxDocument,
	{ formulas: Map<string, boolean>; styles: Map<number, string | null>; writer: OdsStyleWriter; calcext: boolean }
>()

function unsupported(detail: string): SheetRefusal {
	return { reason: "unsupported", detail }
}

export function odsEditRefusal(
	document: XlsxDocument,
	touched: ReadonlyMap<SheetId, readonly SheetRange[]>,
	command?: SheetCommand
): SheetRefusal | null {
	const source = odsSource(document.workbook)

	if (source === undefined) return null

	const changes = document.workbook.changes
	// What this edit marked (an edit refused before and undone leaves its marks in the cumulative log: they are not
	// this edit's); every mark since open where no journal was begun.
	const journal = changes.endJournal?.() ?? null
	// Charts and their drawings: written through the chart objects and table:shapes (charts/write.ts).
	const charts = new Set(
		source.charts.flatMap(chart => [chart.part, chart.drawing, relationshipsPartName(chart.part), relationshipsPartName(chart.drawing)])
	)
	const part = (name: string): SheetRefusal | null => (PARTS.test(name) || charts.has(name) ? null : unsupported(name))

	if (journal === null) {
		for (const [, sheet] of changes.sheets) for (const name of sheet.sections.keys()) if (!SECTIONS.has(name)) return unsupported(name)
		for (const name of changes.workbookSections.keys()) if (!WORKBOOK_SECTIONS.has(name)) return unsupported(name)
		for (const name of changes.parts.keys()) if (part(name) !== null) return unsupported(name)
	} else {
		for (const mark of journal) {
			const [kind = "", first = "", second = ""] = mark.split("\u0000")

			if (kind === "s" && !SECTIONS.has(second)) return unsupported(second)
			if (kind === "w" && !WORKBOOK_SECTIONS.has(first)) return unsupported(first)
			if (kind === "p" && part(first) !== null) return unsupported(first)
		}
	}

	const kept = unheldRefusal(document, touched, command)

	if (kept !== null) return kept

	const conditions = conditionsVerdict(document, source, journal)

	if (conditions !== null) return conditions

	const chart = odsChartsRefusal(document)

	if (chart !== null) return { reason: "chartUnsupported", detail: chart }

	// Validations: each rule as a table:content-validation can say it.
	for (const [id, sheet] of changes.sheets) {
		if (!sheet.sections.has("dataValidations")) continue

		const entry = document.workbook.sheets.find(candidate => candidate.id === id)
		const model = entry?.model

		if (entry === undefined || model === null || model === undefined) continue

		try {
			sheetValidations(
				document.workbook,
				model,
				entry.name,
				null,
				currentSection(document.workbook, model, "dataValidations"),
				new Set()
			)
		} catch (error) {
			if (error instanceof ValidationRefused) return { reason: "unsupported", detail: "validation" }

			throw error
		}
	}

	// Filters: criteria a table:filter can say.
	for (const [id, sheet] of changes.sheets) {
		if (!sheet.sections.has("autoFilter")) continue

		const entry = document.workbook.sheets.find(candidate => candidate.id === id)
		const model = entry?.model

		if (entry === undefined || model === null || model === undefined) continue

		try {
			filterRange(currentSection(document.workbook, model, "autoFilter") ?? "", entry.name, "check")
		} catch (error) {
			if (error instanceof FilterRefused) return { reason: "filterCriteria", detail: "openDocument" }

			throw error
		}
	}

	// A password hash ODF holds (its key and the key's digest): not one salted and spun as Excel's are.
	const hashRefusal = (hash: XlsxProtectionHash): SheetRefusal | null =>
		(hash.saltValue ?? "") !== "" || (hash.spinCount ?? 0) > 0 || (hash.legacy ?? "") !== "" ? unsupported("passwordHash") : null

	for (const entry of document.workbook.sheets) {
		const protection = entry.model?.protection

		if (protection !== null && protection !== undefined) {
			const refusal = hashRefusal(protection.hash)

			if (refusal !== null) return refusal

			// Beyond selecting cells, what stays allowed is LibreOffice's own attributes.
			const extra = [...protection.allows].some(action => action !== "selectLockedCells" && action !== "selectUnlockedCells")

			if (extra && ![...source.prefixes.values()].includes(OdfNs.loext)) return unsupported("protectionAllows")
		}
	}

	if (document.workbook.protection !== null) {
		if (document.workbook.protection.windows) return unsupported("windowsProtection")

		const refusal = hashRefusal(document.workbook.protection.hash)

		if (refusal !== null) return refusal
	}

	// Defined names: print areas the writer puts on their tables; any other name as it was.
	if (changes.workbookSections.has("definedNames")) {
		const others = (names: readonly XlsxDefinedName[]): string =>
			JSON.stringify(
				names
					.filter(name => !OWN_NAMES.has(name.name.toUpperCase()))
					.map(name => [name.name, name.sheet, name.formula, name.hidden])
					.sort()
			)

		const builtIn = (names: readonly XlsxDefinedName[]): readonly XlsxDefinedName[] => names.filter(name => /^_xlnm\./i.test(name.name))

		if (others(builtIn(document.workbook.definedNames)) !== others(builtIn(source.definedNames))) return unsupported("definedNames")

		if (others(document.workbook.definedNames) !== others(source.definedNames)) {
			try {
				namesPlan(document.workbook.definedNames, source.definedNames, scopeSheetName(document))
			} catch (error) {
				if (error instanceof NameRefused) return unsupported("definedNames")

				throw error
			}
		}

		for (const name of document.workbook.definedNames) {
			const sheet = document.workbook.sheets.find(entry => entry.id === name.sheet)

			if (name.name.toUpperCase() === PRINT_AREA && sheet !== undefined && printRanges(name.formula, sheet.name) === undefined)
				return unsupported("printArea")
		}
	}

	// A note shown all the time: an office:annotation's office:display, which the reader does not take back.
	for (const [name, write] of changes.parts) {
		if (write === null || !name.endsWith(".vml")) continue

		const bytes = write.write(document.workbook)

		if (bytes instanceof Uint8Array && /<x:Visible\s*\/?>/.test(decodeUtf8(bytes))) return unsupported("shownNote")
	}

	let state = known.get(document)

	if (state === undefined) {
		state = {
			formulas: new Map(),
			styles: new Map(),
			writer: new OdsStyleWriter(source.styles, document.styles),
			calcext: declaresCalcext(source.prefixes)
		}
		known.set(document, state)
	}

	for (const [sheet, ranges] of touched) {
		const model = document.model(sheet)

		if (model === null) continue

		const store = model.store as SheetStore

		for (const range of ranges) {
			let refusal: SheetRefusal | null = null

			store.forEachCell(range, (_row, _col, slot) => {
				if (refusal !== null) return

				refusal = cellRefusal(document, store, slot, state)
			})

			if (refusal !== null) return refusal
		}
	}

	return null
}

// Edits that move cells within a sheet, cells and all (a formula the model holds only the result of would land
// elsewhere as that result).
const MOVING: ReadonlySet<string> = new Set(["sort.apply", "clipboard.paste", "clipboard.pasteHtml", "fill.copy"])

// The session's latest copy as it was before the edit under way ran (a paste moves a cut's to where it went).
const clips = new WeakMap<
	XlsxDocument,
	{ readonly id: number; readonly sheet: SheetId; readonly range: SheetRange; readonly cut: boolean; readonly tsv: string } | null
>()

export function odsEditBegins(document: XlsxDocument): void {
	const clip = document.clip

	clips.set(
		document,
		clip === null ? null : { id: clip.id, sheet: clip.sheet, range: clip.grid.range, cut: clip.grid.cut, tsv: clip.grid.tsv }
	)
}

const lineEnds = (text: string): string => text.replace(/\r\n?/g, "\n")

function intersects(a: SheetRange, b: SheetRange): boolean {
	return a.startRow <= b.endRow && b.startRow <= a.endRow && a.startCol <= b.endCol && b.startCol <= a.endCol
}

// What the last structure verdict was given for: each table's sheet name and axes now.
const verdicts = new WeakMap<XlsxDocument, { readonly state: readonly unknown[]; readonly refusal: SheetRefusal | null }>()

// Whether the addresses of what the model does not carry (unheld.ts) can follow the edit: moved as LibreOffice
// moves them where that is certain, the edit refused where it is not.
function unheldRefusal(
	document: XlsxDocument,
	touched: ReadonlyMap<SheetId, readonly SheetRange[]>,
	command: SheetCommand | undefined
): SheetRefusal | null {
	const source = odsSource(document.workbook)

	if (source === undefined) return null

	const unheld = source.unheld

	if (unheld.items.length === 0 && unheld.pinned.size === 0 && unheld.opaque === null) return null

	const keptReferences: SheetRefusal = { reason: "unsupported", detail: "keptReferences" }
	const type = command?.type

	// Cells shifted within a band of rows or columns, or dragged (a cut or copy whose clip is the drag's own, an
	// insert): nothing outside the model is moved so.
	if (type === "cells.shift" || type === "cells.move") return keptReferences

	if (type === "sheet.duplicate") {
		const table = source.tables.find(candidate => candidate.id === command?.sheet)

		// The copy is written from the model: what it does not carry would not be in it.
		if (table !== undefined && (unheld.rows.has(table.name) || unheld.pinned.has(table.name))) return keptReferences
	}

	const shifter = shifterOf(document.workbook, source.tables)

	// A paste of the session's own copy: from where it was copied (the paste handler takes it so, ownClip). A values
	// paste writes results and moves nothing.
	const clip = clips.get(document) ?? null
	const pasted =
		((command?.type === "clipboard.paste" && command.values !== true) || command?.type === "clipboard.pasteHtml") &&
		clip !== null &&
		command.clip === clip.id &&
		lineEnds(command.text) === lineEnds(clip.tsv)
			? clip
			: null

	if (pasted !== null) {
		const sheetName = document.workbook.sheets.find(entry => entry.id === pasted.sheet)?.name

		// A formula the model holds only the result of would be pasted as that result.
		for (const item of unheld.items) {
			if (item.kind !== "formula") continue

			const move = shifter.moves.get(item.sheet)

			if (move === null || move === undefined || move.name !== sheetName) continue

			const row = move.rows.target(item.row)
			const col = move.cols.target(item.col)

			if (
				row >= 0 &&
				col >= 0 &&
				intersects(pasted.range, { startRow: row, startCol: col, endRow: row + item.rows - 1, endCol: col + item.cols - 1 })
			)
				return { reason: "formula", detail: "keptFormula" }
		}

		// A cut moves its cells: what names them outside the model would name where they were.
		if (pasted.cut) {
			for (const item of unheld.items) {
				const boxes = namedBoxes(item, shifter)

				if (boxes === null) return keptReferences

				for (const box of boxes)
					if ((box.sheet === "" || box.sheet === sheetName) && intersects(box, pasted.range)) return keptReferences
			}

			if (unheld.opaque !== null) return { reason: "unsupported", detail: unheld.opaque }

			for (const [name, move] of shifter.moves) {
				const reason = unheld.pinned.get(name)

				if (reason !== undefined && move !== null && move.name === sheetName) return { reason: "unsupported", detail: reason }
			}
		}
	}

	// A fill copies its first row or column over the rest: a formula there would be copied as its result.
	if (command?.type === "fill.copy" && unheld.formulas.size > 0) {
		const table = source.tables.find(candidate => candidate.id === command.sheet)
		const move = table === undefined ? undefined : shifter.moves.get(table.name)

		if (move !== null && move !== undefined)
			for (const item of unheld.items) {
				if (item.kind !== "formula" || item.sheet !== table?.name) continue

				const row = move.rows.target(item.row)
				const col = move.cols.target(item.col)

				if (
					row >= 0 &&
					col >= 0 &&
					command.ranges.some(range => intersects(range, { startRow: row, startCol: col, endRow: row, endCol: col }))
				)
					return { reason: "formula", detail: "keptFormula" }
			}
	}

	if (type !== undefined && MOVING.has(type) && unheld.formulas.size > 0) {
		for (const item of unheld.items) {
			if (item.kind !== "formula") continue

			const table = source.tables.find(candidate => candidate.name === item.sheet)
			const move = shifter.moves.get(item.sheet)
			const ranges = table === undefined ? undefined : touched.get(table.id)

			if (ranges === undefined || move === null || move === undefined) continue

			const row = move.rows.target(item.row)
			const col = move.cols.target(item.col)

			if (row < 0 || col < 0) continue

			for (const range of ranges)
				if (range.startRow < row + item.rows && range.endRow >= row && range.startCol < col + item.cols && range.endCol >= col)
					return { reason: "formula", detail: "keptFormula" }
		}
	}

	if (!shifter.changed) return null

	const state = [...shifter.moves.values()].flatMap(move => (move === null ? [null] : [move.name, move.rows, move.cols]))
	const last = verdicts.get(document)

	if (last !== undefined && last.state.length === state.length && last.state.every((value, index) => value === state[index]))
		return last.refusal

	const refusal = structureRefusal(unheld, shifter)

	verdicts.set(document, { state, refusal })

	return refusal
}

// What the last conditional formatting verdict was given for: each table's sheet name and axes now.
const conditionVerdicts = new WeakMap<XlsxDocument, readonly unknown[]>()

// The conditional formatting check (conditions.ts), where this edit marked it or moved or renamed a sheet.
function conditionsVerdict(document: XlsxDocument, source: OdsSource, journal: ReadonlySet<string> | null): SheetRefusal | null {
	const marked =
		journal === null
			? [...document.workbook.changes.sheets.values()].some(sheet => sheet.sections.has("conditionalFormatting"))
			: [...journal].some(mark => mark.startsWith("s\u0000") && mark.endsWith("\u0000conditionalFormatting"))
	const shifter = shifterOf(document.workbook, source.tables)
	const state = [...shifter.moves.values()].flatMap(move => (move === null ? [null] : [move.name, move.rows, move.cols]))
	const last = conditionVerdicts.get(document)

	if (!marked && last !== undefined && last.length === state.length && last.every((value, index) => value === state[index])) return null
	if (!marked && last === undefined && !shifter.changed) return null

	conditionVerdicts.set(document, state)

	return conditionsRefusal(document, source, shifter)
}

function structureRefusal(unheld: OdsUnheld, shifter: Shifter): SheetRefusal | null {
	const refused = (detail: string): SheetRefusal => ({ reason: "unsupported", detail })

	if (unheld.opaque !== null) return refused(unheld.opaque)

	for (const [sheet, reason] of unheld.pinned) {
		const move = shifter.moves.get(sheet)

		// What is kept as written names its cells by the sheet's name too.
		if (move !== null && move !== undefined && (!move.rows.identity || !move.cols.identity || move.name !== sheet))
			return refused(reason)
	}

	for (const item of unheld.items) {
		if (item.row >= 0) {
			const move = shifter.moves.get(item.sheet)

			// Its cell deleted (or its sheet): it goes with it.
			if (move === null || move === undefined || move.rows.nextKept(item.row) < 0) continue
			if (move.rows.previousKept(item.row + item.rows - 1) < item.row) continue
			if (move.cols.nextKept(item.col) < 0 || move.cols.previousKept(item.col + item.cols - 1) < item.col) continue
		}

		if (movedText(item, shifter) === null) return refused("keptReferences")
	}

	return null
}

function cellRefusal(
	document: XlsxDocument,
	store: SheetStore,
	slot: number,
	state: { formulas: Map<string, boolean>; styles: Map<number, string | null>; writer: OdsStyleWriter; calcext: boolean }
): SheetRefusal | null {
	let cell

	try {
		cell = storeValue(store, document.workbook.sharedStrings, slot, store.style(slot), undefined)
	} catch (error) {
		if (error instanceof CellRefused) return unsupported(error.detail)

		throw error
	}

	// Only LibreOffice's calcext:value-type says a value is an error; a strict document has no way to.
	if (cell.value === Value.ERROR && (cell.formula === null || cell.formula === "") && !state.calcext && !STRICT_ERRORS.has(cell.text))
		return unsupported("errorValue")

	if (cell.formula !== null) {
		let writable = state.formulas.get(cell.formula)

		if (writable === undefined) {
			writable = "text" in openFormula(cell.formula)
			state.formulas.set(cell.formula, writable)
		}

		if (!writable) return { reason: "formula", detail: "openFormula" }
	}

	let style = state.styles.get(cell.xf)

	if (style === undefined) {
		style = null

		try {
			state.writer.cell(cell.xf)
		} catch (error) {
			if (!(error instanceof StyleRefused)) throw error

			style = error.property
		}

		state.styles.set(cell.xf, style)
	}

	if (style !== null) return unsupported(style)

	try {
		if (cell.text !== "") paragraphText(cell.text)
	} catch (error) {
		if (error instanceof CellRefused) return { reason: "encoding", detail: error.detail }

		throw error
	}

	return null
}
