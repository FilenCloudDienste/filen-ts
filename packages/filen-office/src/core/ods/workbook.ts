import { Relationships } from "../opc/relationships"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetProtectedAction, type SheetRange } from "../sheet/protocol"
import type { AxisShift } from "../xlsx/refs/axis"
import { columnName } from "../sheet/refs/cellRef"
import { SourceAxis } from "./write/axis"
import { DEFAULT_FORMAT, DEFAULT_VIEW, XlsxSheet } from "../xlsx/read/worksheet"
import { SheetStore } from "../xlsx/model/store"
import { SheetStrings } from "../xlsx/model/strings"
import { FormulaTable } from "../xlsx/model/formulas"
import {
	rowRunAt,
	type XlsxDefinedName,
	type XlsxSection,
	type XlsxSheetEntry,
	type XlsxSheetModel,
	type XlsxSheetProtection,
	type XlsxSheetView,
	type XlsxRowRun,
	type XlsxStyleRuns,
	type XlsxWorkbookProtection
} from "../xlsx/model/types"
import type { OdsIssues } from "./issues"
import type { OdsSource, OdsTableSource } from "./source"
import { rangeAddresses, sheetRef, withoutSheet } from "./formula/toXlsx"
import type { OdsContent, OdsTable, OdsTableProtection } from "./read/content"
import { NULL_DATE_1899, NULL_DATE_1904 } from "./read/values"
import type { OdsCellStyles } from "./styles/cell"
import type { OdsSettings, OdsTableView } from "./settings"
import { featurePartsSteps, type OdsFeatureParts } from "./features"
import { NO_CHARTS, type OdsChartParts } from "./charts/read"

// The read content as the xlsx workbook model: one sheet entry and model per table, the workbook's names, and an
// in-memory package of the parts the sheet features read (notes, link targets) in their SpreadsheetML form.

// A sheet of an OpenDocument source: the xlsx sheet model with the run index of formats and the runs of rows the
// store does not hold, and where its rows and columns came from in the source table (moved by structure edits), which
// the writer copies unchanged rows and cells from.
export class OdsSheet extends XlsxSheet {
	styleRuns?: XlsxStyleRuns
	readonly recalculate?: ReadonlySet<number>
	rowAxis = SourceAxis.identity(SHEET_MAX_ROWS)
	colAxis = SourceAxis.identity(SHEET_MAX_COLS)
	// The runs of rows as read or moved since, and the same without the rows the store has come to hold since
	// (a row an edit gave a cell takes its run's properties and holds them itself), as of the store's version.
	private ownRuns: readonly XlsxRowRun[] = []
	private apartRuns: readonly XlsxRowRun[] | null = null
	private apartVersion = -1

	get rowRuns(): readonly XlsxRowRun[] | undefined {
		if (this.ownRuns.length === 0) return undefined

		const store = this.store as SheetStore

		if (this.apartRuns === null || this.apartVersion !== store.version) {
			this.apartRuns = runsApart(this.ownRuns, store)
			this.apartVersion = store.version
		}

		return this.apartRuns.length === 0 ? undefined : this.apartRuns
	}

	set rowRuns(runs: readonly XlsxRowRun[] | undefined) {
		this.ownRuns = runs ?? []
		this.apartRuns = null
	}

	constructor(
		init: ConstructorParameters<typeof XlsxSheet>[0] & {
			readonly styleRuns: XlsxStyleRuns | undefined
			readonly rowRuns: readonly XlsxRowRun[]
			readonly recalculate: ReadonlySet<number>
		}
	) {
		super(init)

		if (init.styleRuns !== undefined) this.styleRuns = init.styleRuns
		if (init.rowRuns.length > 0) this.rowRuns = init.rowRuns
		if (init.recalculate.size > 0) this.recalculate = init.recalculate

		// A row the store adds inside a run starts with the run's properties.
		const store = this.store as SheetStore

		store.rowBase = row => rowRunAt(this.ownRuns, row)
	}

	// Rows from here on hold cells an edit moved between rows or within them (cells shifted in a band), which the
	// writer writes again whatever their source.
	movedFrom = SHEET_MAX_ROWS

	shiftSource(shift: AxisShift): { readonly apply: () => void; readonly revert: () => void } | null {
		const before = { rowAxis: this.rowAxis, colAxis: this.colAxis, movedFrom: this.movedFrom }
		const band = shift.band
		const moved = band === undefined ? this.movedFrom : Math.min(this.movedFrom, shift.axis === "rows" ? shift.at : band.start)
		const after = {
			rowAxis: this.rowAxis.shifted(shift, "rows", SHEET_MAX_ROWS),
			colAxis: this.colAxis.shifted(shift, "cols", SHEET_MAX_COLS),
			movedFrom: moved
		}

		if (after.rowAxis === before.rowAxis && after.colAxis === before.colAxis && after.movedFrom === before.movedFrom) return null

		const set = (values: typeof before): void => {
			this.rowAxis = values.rowAxis
			this.colAxis = values.colAxis
			this.movedFrom = values.movedFrom
		}

		return { apply: () => set(after), revert: () => set(before) }
	}
}

// The source table a sheet is still the one read from: the table of its id, its model an OdsSheet (a copied or new
// sheet's is a plain XlsxSheet). Null for a sheet with no source table.
export function sourceTableOf(source: OdsSource, entry: XlsxSheetEntry): OdsTableSource | null {
	const table = source.tables[entry.id]

	return table !== undefined && table.id === entry.id && entry.model instanceof OdsSheet ? table : null
}

// Runs without the rows the store holds (each such row holds its own properties).
function runsApart(runs: readonly XlsxRowRun[], store: SheetStore): readonly XlsxRowRun[] {
	const out: XlsxRowRun[] = []

	for (const run of runs) {
		let first = run.first

		for (let b = Math.max(0, store.blockOf(run.first)); b < store.blocks.length; b++) {
			const block = store.blocks[b]

			if (block === undefined || block.firstRow > run.last) break

			// The block's rows ascend: start at the first one at or after `first`, stop past the run.
			const relative = first - block.firstRow
			let low = 0
			let high = block.rowCount

			while (low < high) {
				const mid = (low + high) >>> 1

				if ((block.rows[mid] ?? 0) < relative) low = mid + 1
				else high = mid
			}

			for (let i = low; i < block.rowCount; i++) {
				const row = block.firstRow + (block.rows[i] ?? 0)

				if (row > run.last) break
				if (row > first) out.push({ ...run, first, last: row - 1 })

				first = row + 1
			}
		}

		if (first <= run.last) out.push(first === run.first ? run : { ...run, first })
	}

	return out
}

export interface OdsWorkbookParts {
	readonly entries: XlsxSheetEntry[]
	readonly models: XlsxSheetModel[]
	readonly definedNames: XlsxDefinedName[]
	readonly date1904: boolean
	readonly protection: XlsxWorkbookProtection | null
	readonly activeTab: number
	readonly iterate: { readonly enabled: boolean; readonly count: number; readonly delta: number }
	// Parts by name, with [Content_Types].xml.
	readonly parts: Map<string, Uint8Array>
	// Per sheet, its validations' rules to the names they came from.
	readonly validationNames: readonly ReadonlyMap<string, string>[]
}

const SELECTABLE: readonly SheetProtectedAction[] = ["selectLockedCells", "selectUnlockedCells"]

function sheetProtection(protection: OdsTableProtection | null): XlsxSheetProtection | null {
	if (protection === null) return null

	const allows = new Set<SheetProtectedAction>()

	for (const action of SELECTABLE) if (protection.allows.get(action) !== false) allows.add(action)
	for (const [action, allowed] of protection.allows)
		if (allowed && !SELECTABLE.includes(action as SheetProtectedAction)) allows.add(action as SheetProtectedAction)

	return {
		hash: {
			...(protection.key !== undefined && protection.key !== "" && { hashValue: protection.key }),
			...(protection.algorithm !== undefined && { algorithmName: protection.algorithm })
		},
		allows
	}
}

function view(table: OdsTableView | undefined, settings: OdsSettings, active: boolean): XlsxSheetView {
	if (table === undefined) return { ...DEFAULT_VIEW, gridLines: settings.showGrid, headings: settings.headings, tabSelected: active }

	const frozenCols = table.horizontalSplitMode === 2 ? Math.max(0, table.horizontalSplitPosition - table.positionLeft) : 0
	const frozenRows = table.verticalSplitMode === 2 ? Math.max(0, table.verticalSplitPosition - table.positionTop) : 0
	const row = Math.max(0, table.cursorRow)
	const col = Math.max(0, table.cursorCol)

	return {
		frozen:
			frozenCols > 0 || frozenRows > 0
				? {
						rows: frozenRows,
						cols: frozenCols,
						topLeftRow: frozenRows > 0 ? table.positionBottom : table.positionTop,
						topLeftCol: frozenCols > 0 ? table.positionRight : table.positionLeft
					}
				: null,
		topRow: table.positionTop,
		leftCol: table.positionLeft,
		activeRow: row,
		activeCol: col,
		selection: [{ startRow: row, startCol: col, endRow: row, endCol: col }],
		zoom: table.zoom > 0 ? table.zoom : 100,
		gridLines: table.showGrid ?? settings.showGrid,
		headings: settings.headings,
		rightToLeft: false,
		tabSelected: active,
		view: "normal"
	}
}

// "$A$1:$D$20" for a range: every part anchored (print areas and titles are absolute).
function absolute(range: SheetRange): string {
	return `$${columnName(range.startCol)}$${range.startRow + 1}:$${columnName(range.endCol)}$${range.endRow + 1}`
}

// The workbook's sheets and parts from what was read, in steps (featurePartsSteps' turns), for a sliced open.
export function* buildSheetsSteps(
	content: OdsContent,
	styles: OdsCellStyles,
	settings: OdsSettings,
	issues: OdsIssues,
	prefixes: ReadonlyMap<string, string>,
	charts: OdsChartParts = NO_CHARTS
): Generator<void, OdsWorkbookParts> {
	const entries: XlsxSheetEntry[] = []
	const models: XlsxSheetModel[] = []
	const definedNames: XlsxDefinedName[] = []
	const activeName = settings.activeTable
	let activeTab = Math.max(
		0,
		content.tables.findIndex(table => table.name === activeName)
	)
	const features: OdsFeatureParts = yield* featurePartsSteps(content, styles, issues, prefixes, charts, content.unheld)

	content.tables.forEach((table: OdsTable, index) => {
		const id = index
		const part = `xl/worksheets/sheet${index + 1}.xml`
		const tableStyle = styles.sheetStyle(table.styleName)
		const built = table.built
		const sheetFeatures = features.sheets[index]
		const sections: XlsxSection[] = sheetFeatures?.sections ?? []
		const model = new OdsSheet({
			id,
			part,
			store: built.store,
			sections,
			relationships: new Relationships(sheetFeatures?.relationships ?? []),
			rootStart: 0,
			rootOpenEnd: 0,
			rootEnd: 0,
			prefix: "",
			utf16: false,
			styleRuns: built.styleRuns,
			rowRuns: built.rowRuns,
			recalculate: built.recalculate
		})

		model.cols = built.cols
		model.merges = built.merges
		model.format = {
			...DEFAULT_FORMAT,
			defaultRowHeight: built.defaultRowHeight,
			customHeight: built.defaultRowSet,
			defaultColPx: built.defaultColPx
		}
		model.view = { ...view(settings.tables.get(table.name), settings, index === activeTab), rightToLeft: tableStyle.rightToLeft }
		model.protection = sheetProtection(table.protection)
		model.tabColor = tableStyle.tabColor < 0 ? null : { argb: (0xff000000 | tableStyle.tabColor) >>> 0 }
		entries.push({
			id,
			name: table.name,
			state: tableStyle.display ? "visible" : "hidden",
			kind: "worksheet",
			sheetId: index + 1,
			relationshipId: `rId${index + 1}`,
			part,
			model: null
		})
		models.push(model)

		if (table.printRanges !== undefined && table.printRanges.trim() !== "") {
			const translated = rangeAddresses(table.printRanges)

			if ("parts" in translated) {
				definedNames.push({
					name: "_xlnm.Print_Area",
					sheet: id,
					formula: anchored(translated.parts, table.name),
					hidden: false,
					source: null
				})
			} else {
				issues.add("name", table.name, `print range: ${translated.refused}`)
				// Kept as written: not moved with the rows.
				content.unheld.pin(table.name, "printRange")
			}
		}

		const titles: string[] = []

		if (built.headerRows !== null) titles.push(`${sheetRef(table.name)}$${built.headerRows[0] + 1}:$${built.headerRows[1] + 1}`)

		if (built.headerCols !== null) {
			const range = absolute({ startRow: 0, startCol: built.headerCols[0], endRow: 0, endCol: built.headerCols[1] })

			titles.push(`${sheetRef(table.name)}${range.replace(/\$1(?=:|$)/g, "")}`)
		}

		if (titles.length > 0)
			definedNames.push({ name: "_xlnm.Print_Titles", sheet: id, formula: titles.join(","), hidden: false, source: null })
	})

	// A spreadsheet of no table (the schema allows none) opens as one empty sheet, as LibreOffice opens it; a save
	// writes it as a new table.
	if (entries.length === 0) {
		const part = "xl/worksheets/sheet1.xml"

		entries.push({ id: 0, name: "Sheet1", state: "visible", kind: "worksheet", sheetId: 1, relationshipId: "rId1", part, model: null })
		models.push(
			new XlsxSheet({
				id: 0,
				part,
				store: new SheetStore([], new SheetStrings(), new FormulaTable()),
				sections: [],
				relationships: new Relationships([]),
				rootStart: 0,
				rootOpenEnd: 0,
				rootEnd: 0,
				prefix: "",
				utf16: false
			})
		)
	}

	if (activeTab >= entries.length) activeTab = 0

	// A name is defined once in its scope: the first definition stands (a database range and a named range may share
	// a name; LibreOffice keeps them apart, a workbook cannot).
	const seen = new Set(definedNames.map(name => `${name.sheet ?? ""}\u0000${name.name.toUpperCase()}`))

	for (const name of features.definedNames) {
		const key = `${name.sheet ?? ""}\u0000${name.name.toUpperCase()}`

		if (seen.has(key)) {
			issues.add("name", undefined, `${name.name}: defined twice`)

			continue
		}

		seen.add(key)
		definedNames.push(name)
	}

	const date1904 = content.nullDate === NULL_DATE_1904

	if (content.nullDate !== NULL_DATE_1899 && !date1904) issues.add("nullDate", undefined)

	const iteration = content.calculation?.children.find(child => child.name === "table:iteration")

	return {
		entries,
		models,
		definedNames,
		date1904,
		protection: content.structureProtected
			? {
					structure: true,
					windows: false,
					hash: {
						...(content.protectionKey !== undefined && { hashValue: content.protectionKey }),
						...(content.protectionAlgorithm !== undefined && { algorithmName: content.protectionAlgorithm })
					}
				}
			: null,
		activeTab,
		iterate: {
			enabled: iteration?.attributes.get("table:status") === "enable",
			count: Number(iteration?.attributes.get("table:steps") ?? "100") || 100,
			// table:maximum-difference (ODF 1.3 Part 3 §19.635); earlier saves of ours wrote table:minimum-difference.
			delta:
				Number(
					iteration?.attributes.get("table:maximum-difference") ??
						iteration?.attributes.get("table:minimum-difference") ??
						"0.001"
				) || 0.001
		},
		parts: features.parts,
		validationNames: features.sheets.map(sheet => sheet.validationNames)
	}
}

// A print range as Excel's absolute references on its sheet ("Sheet1!$A$1:$D$20").
function anchored(parts: readonly string[], sheet: string): string {
	return parts
		.map(part => {
			const area = withoutSheet(part)
			const prefix = area.length === part.length ? sheetRef(sheet) : part.slice(0, part.length - area.length)

			return prefix + area.replace(/\$?([A-Z]{1,3})\$?(\d+)/g, "$$$1$$$2")
		})
		.join(",")
}
