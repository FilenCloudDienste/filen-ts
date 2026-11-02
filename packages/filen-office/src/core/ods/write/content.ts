import { appendAll } from "../../arrays"
import { OdfNs } from "../../odf/namespaces"
import { declaresCalcext } from "./cells"
import { runSliced, type SliceClock } from "../../slicing"
import { SHEET_MAX_ROWS } from "../../sheet/protocol"
import type { XlsxDocument } from "../../xlsx/edit/document"
import {
	RowFlag,
	type XlsxProtectionHash,
	type XlsxSheetEntry,
	type XlsxSheetModel,
	type XlsxSheetProtection,
	type XlsxWorkbookProtection
} from "../../xlsx/model/types"
import { decodeUtf8, encodeUtf8, escapeAttribute } from "../../xml/index"
import type { OdsSource, OdsTableSource } from "../source"
import { SourceAxis } from "./axis"
import { SheetView } from "./sheet"
import { TagKind, TagStream, tagAttributes, type StreamHandler } from "./stream"
import { OdsStyleWriter } from "./styles"
import { NO_NEW_TABLE, TableWriter, type NewTable, type TableContext } from "./table"
import { NO_FEATURES, type SheetFeatures } from "./features"
import type { ScopeNames } from "./names"
import { nameKey } from "../features"
import { ADDRESS_ATTRIBUTES, patchAttributes, type Shifter } from "../unheld"

// content.xml as a save writes it, streamed from the source's: everything an edit left alone passes through as its
// bytes; the automatic styles new formats need go at the end of office:automatic-styles; each table:table goes
// through its TableWriter, in the workbook's order now (a table the order moved is held until its turn), a deleted
// sheet's left out and a new sheet's written from the model.

export class ContentRefused extends Error {}

// Bytes of the source content.xml streamed through between two looks at the slice clock.
const WRITE_SLICE = 32 * 1024

// Names the writer acts on (ids from 1, in this order).
const NAMES = [
	"office:document-content",
	"office:automatic-styles",
	"office:body",
	"office:spreadsheet",
	"table:table",
	"table:table-column",
	"table:table-columns",
	"table:table-column-group",
	"table:table-header-columns",
	"table:table-row",
	"table:table-rows",
	"table:table-row-group",
	"table:table-header-rows",
	"table:shapes",
	"loext:table-protection",
	"table:table-protection",
	"table:content-validations",
	"table:database-ranges",
	"table:data-pilot-tables",
	"table:consolidation",
	"table:dde-links",
	"office:font-face-decls",
	"table:named-expressions",
	"table:label-ranges"
] as const

const N = Object.fromEntries(NAMES.map((name, index) => [name, index + 1])) as Record<(typeof NAMES)[number], number>
const COLUMN_NAMES: ReadonlySet<number> = new Set([
	N["table:table-column"],
	N["table:table-columns"],
	N["table:table-column-group"],
	N["table:table-header-columns"]
])
// office:spreadsheet's children after its tables.
const AFTER_TABLES: ReadonlySet<number> = new Set([
	N["table:named-expressions"],
	N["table:database-ranges"],
	N["table:data-pilot-tables"],
	N["table:consolidation"],
	N["table:dde-links"]
])
const ROW_WRAPPERS: ReadonlySet<number> = new Set([N["table:table-rows"], N["table:table-row-group"], N["table:table-header-rows"]])

// Prefixes the writer's own markup uses, with the namespaces they must name.
const WRITTEN: readonly (readonly [string, string])[] = [
	["office", OdfNs.office],
	["style", OdfNs.style],
	["table", OdfNs.table],
	["text", OdfNs.text],
	["fo", OdfNs.fo],
	["number", OdfNs.number],
	["xlink", OdfNs.xlink],
	["dc", OdfNs.dc],
	["svg", OdfNs.svg],
	["calcext", OdfNs.calcext],
	["of", OdfNs.of]
]

export interface ContentPlan {
	readonly source: OdsSource
	readonly document: XlsxDocument
	readonly styles: OdsStyleWriter
	// table:shapes written again, by source table index (charts moved or changed).
	readonly shapes?: ReadonlyMap<number, string>
	// Notes and links an edit changed, by sheet.
	readonly features?: ReadonlyMap<number, SheetFeatures>
	// Defined names an edit changed, by scope (null: the workbook's, else the sheet's id).
	readonly names?: ReadonlyMap<number | null, ScopeNames>
	// AutoFilters an edit changed: each changed sheet's database range (null: none any more) by the name its sheet had
	// in the source, and those of sheets that had none.
	readonly filters?: { readonly replaced: ReadonlyMap<string, string | null>; readonly added: readonly string[] }
	// Days from 1970-01-01 to the null date.
	readonly nullDate: number
	// Slices for the work before the stream (the styles every table will name).
	readonly clock?: SliceClock | undefined
	// How the sheets moved, where what names cells by address outside the model (unheld.ts) follows; null for none.
	readonly shifter?: Shifter | null
	// What new tables hold beyond the model, by sheet.
	readonly newTables?: ReadonlyMap<number, NewTable>
	// The styles planned for every row that could name one, not only those whose tag changes: the plan when the exact
	// one missed a style (StyleUnplanned).
	readonly broadStyles?: boolean
}

// The declarations the root lacks for the prefixes the writer uses; a prefix bound to another namespace refuses.
export function missingDeclarations(prefixes: ReadonlyMap<string, string>): string {
	let out = ""

	for (const [prefix, uri] of WRITTEN) {
		const bound = prefixes.get(prefix)

		if (bound === undefined) out += ` xmlns:${prefix}="${escapeAttribute(uri)}"`
		else if (bound !== uri) throw new ContentRefused(`The prefix ${prefix} names another namespace`)
	}

	return out
}

interface TableState {
	readonly writer: TableWriter | null
	// Where in the target order its output goes; -1 for a deleted sheet's (left out).
	readonly slot: number
	readonly depth: number
	// The columns region: where it started, and what was seen of it.
	columnsStart: number
	columnsDone: boolean
	rowsDone: boolean
	// Row groups open (each one's depth), for outline levels.
	readonly groups: number[]
	captureStart: number
	captureDepth: number
	// The table's index in the source, and the depth of a table:shapes being replaced (-1: none).
	readonly index: number
	shapesDepth: number
	// Its protection is written anew: the source's protection element is not copied.
	readonly protectionChanged: boolean
}

// A row written again: its markup, rendered when it goes out; the source's bytes where they are what it says.
class DeferredRow {
	readonly render: () => string
	readonly source: Uint8Array

	constructor(render: () => string, source: Uint8Array) {
		this.render = render
		this.source = source
	}
}

// Markup made as the stream takes it (a table written from the model), so it is never held whole.
class LazyPieces {
	readonly pieces: () => Iterable<string>

	constructor(pieces: () => Iterable<string>) {
		this.pieces = pieces
	}
}

type Piece = string | Uint8Array | DeferredRow | LazyPieces

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false

	for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false

	return true
}

export class ContentWriter implements StreamHandler {
	private readonly plan: ContentPlan
	private readonly stream: TagStream
	private readonly context: TableContext
	private readonly order: readonly XlsxSheetEntry[]
	// Source table index → target slot.
	private readonly slotOf = new Map<number, number>()
	private readonly entries: (XlsxSheetEntry | undefined)[]
	private readonly declarations: string
	// Output: pieces for the stream, and per target slot those held until its turn.
	private out: Piece[] = []
	private readonly held = new Map<number, Piece[]>()
	private nextSlot = 0
	// Source bytes from here on pass through (-1: what comes is not copied).
	private copyFrom = 0
	private readonly stack: number[] = []
	private table: TableState | null = null
	private sourceTable = 0
	private tablesDone = false
	private rootSeen = false
	// Whether anything but the source's bytes was written.
	changed = false
	// New table:content-validation elements, written once (into the source's table:content-validations, or a new one
	// before the first table).
	private validations: string
	// table:named-expressions under way (its start, -1 for none; its depth), the scopes whose names are written.
	private namesStart = -1
	private namesDepth = -1
	private readonly namesDone = new Set<number | null>()
	// table:database-ranges under way (its start, -1 for none), and whether the changed filters are written.
	private rangesStart = -1
	private filtersDone: boolean
	// What outside the model moves with the sheets: the shifter, names' keys and their scopes, database ranges by
	// name, which of DataPilot tables, consolidation and label ranges hold addresses; and such an element under way.
	private readonly shifter: Shifter | null
	private readonly nameKeys = new Set<string>()
	private readonly nameScopes = new Set<number | null>()
	private readonly databaseRanges = new Set<string>()
	private readonly patchedElements = new Set<number>()
	private patchStart = -1
	private patchDepth = -1

	constructor(plan: ContentPlan) {
		this.plan = plan
		this.stream = new TagStream(this, NAMES)
		this.context = {
			styles: plan.styles,
			cellStyles: plan.source.styles,
			prefixes: plan.source.prefixes,
			nullDate: plan.nullDate,
			calcext: declaresCalcext(plan.source.prefixes)
		}
		this.order = plan.document.workbook.sheets.filter(entry => entry.kind === "worksheet")
		this.entries = [...this.order]
		this.order.forEach((entry, slot) => {
			const source = this.sourceOf(entry)

			if (source !== undefined) this.slotOf.set(source.index, slot)
		})
		this.declarations = missingDeclarations(plan.source.prefixes)
		this.validations = [...(plan.features?.values() ?? [])].flatMap(features => features.validations?.fresh ?? []).join("")
		this.shifter = plan.shifter ?? null

		const elements: Readonly<Record<string, number>> = {
			pilot: N["table:data-pilot-tables"],
			consolidation: N["table:consolidation"],
			label: N["table:label-ranges"]
		}

		if (this.shifter !== null) {
			for (const item of plan.source.unheld.items) {
				const [kind = "", first = ""] = item.key.split("\u0000")

				if (kind === "name") {
					this.nameKeys.add(item.key)
					this.nameScopes.add(first === "" ? null : Number(first))
				} else if (kind === "db") this.databaseRanges.add(first)
				else if (elements[kind] !== undefined) this.patchedElements.add(elements[kind])
			}
		}

		this.filtersDone =
			this.databaseRanges.size === 0 &&
			(plan.filters === undefined || (plan.filters.replaced.size === 0 && plan.filters.added.length === 0))
	}

	// Whether a prefix names the table namespace (the writer's own "table" does).
	private readonly tablePrefix = (prefix: string): boolean => this.plan.source.prefixes.get(prefix) === OdfNs.table

	// An element outside the tables with its addresses moved as the sheets were.
	private moved(markup: string, attribute: (local: string, value: string, shifter: Shifter) => string | null | undefined): string {
		const shifter = this.shifter

		if (shifter === null) return markup

		const patched = patchAttributes(markup, this.tablePrefix, (local, value) => attribute(local, value, shifter))

		if (patched === null) throw new ContentRefused("A range outside the cells cannot be moved with them")

		return patched
	}

	private sourceOf(entry: XlsxSheetEntry): OdsTableSource | undefined {
		const source = this.plan.source.tables[entry.id]

		return source !== undefined && source.id === entry.id && entry.model !== null && "rowAxis" in entry.model ? source : undefined
	}

	private writerFor(entry: XlsxSheetEntry): TableWriter {
		const model = entry.model as XlsxSheetModel
		const source = this.sourceOf(entry) ?? null
		const writer = new TableWriter(this.context, entry, model, new SheetView(this.plan.document, model), source)
		const rows = source === null ? undefined : this.plan.source.unheld.rows.get(source.name)

		writer.features = this.plan.features?.get(entry.id) ?? NO_FEATURES

		if (source === null) writer.fresh = this.plan.newTables?.get(entry.id) ?? NO_NEW_TABLE
		writer.unheldRows = rows ?? null

		if (this.shifter !== null && source !== null && rows !== undefined)
			writer.unheld = {
				rows,
				own: source.name,
				shifter: this.shifter,
				formulas: this.plan.source.unheld.formulas,
				tablePrefix: this.tablePrefix
			}
		this.tableWriters.set(entry.id, writer)

		return writer
	}

	// Every style a written row, column or sheet may name, before office:automatic-styles ends (the body comes after it).
	// A generator: it yields after each row, for write() to give the host a turn when the slice is up.
	private *precompute(): Generator<void, void> {
		const styles = this.plan.styles

		for (const entry of this.order) {
			const model = entry.model

			if (model === null) continue

			const source = this.sourceOf(entry) ?? null
			const view = new SheetView(this.plan.document, model)
			const axes = model as { rowAxis?: SourceAxis; colAxis?: SourceAxis }
			const rowAxis = source === null ? null : (axes.rowAxis ?? SourceAxis.identity(SHEET_MAX_ROWS))
			const movedFrom = (model as { movedFrom?: number }).movedFrom ?? SHEET_MAX_ROWS
			const allRows = source === null || axes.colAxis?.identity === false
			const sourceRows = source?.rows ?? 0
			const fresh = (row: number): boolean => {
				if (rowAxis === null) return true

				const at = rowAxis.source(row)

				return at < 0 || at >= sourceRows
			}
			const markedRows = new Set(view.marked)
			const rows = new Set<number>([...view.marked, ...(this.plan.features?.get(entry.id)?.rows ?? [])])
			const added = source === null ? this.plan.newTables?.get(entry.id) : undefined

			// A new table's page breaks: their rows, and their columns' styles.
			for (const row of added?.rowBreaks ?? []) rows.add(row)
			for (const col of added?.colBreaks ?? [])
				styles.column(view.columnPx(model.cols.find(range => col >= range.first && col <= range.last)), true)

			for (const block of view.store.blocks) {
				for (let i = 0; i < block.rowCount; i++) {
					const row = block.firstRow + (block.rows[i] ?? 0)

					// A row whose cells only moved along (columns inserted or deleted) names the styles it did.
					if ((allRows && (source === null || markedRows.has(row))) || fresh(row) || row >= movedFrom) rows.add(row)
				}
			}

			for (const run of model.rowRuns ?? []) {
				if (allRows || fresh(run.first)) rows.add(run.first)
				if (allRows || fresh(run.last)) rows.add(run.last)
			}

			model.styleRuns?.forEach(
				{ startRow: 0, startCol: 0, endRow: SHEET_MAX_ROWS - 1, endCol: 0x3fff },
				(startRow, _c, endRow, _e, xf) => {
					if (allRows || fresh(startRow) || fresh(endRow) || endRow >= movedFrom) styles.cell(xf)
				}
			)

			// Rows inserted, past the source's, or of a new sheet: written whole, a row without properties at the
			// sheet's default height.
			const plainFresh =
				rowAxis === null || !rowAxis.identity || view.store.rowExtent > sourceRows || (model.styleRuns?.rowExtent ?? 0) > sourceRows

			if (plainFresh) styles.row(view.height({ heightPt: Number.NaN, flags: 0 }), false, false)

			const writer = new TableWriter(this.context, entry, model, view, source)

			writer.features = this.plan.features?.get(entry.id) ?? NO_FEATURES

			if (source === null) writer.fresh = added ?? NO_NEW_TABLE

			// Rows past the source's (a merge, a note or a link reaching there): written whole, a row without
			// properties at the sheet's default height.
			if (!plainFresh && writer.lastModelRow() >= sourceRows)
				styles.row(view.height({ heightPt: Number.NaN, flags: 0 }), false, false)

			// The source's rows are planned exactly, from their tags; fresh ones, or every row when planning broadly,
			// with all a row could name.
			const broad = this.plan.broadStyles === true

			if (!broad) yield* writer.sourceRowStyles((heightPt, custom, pageBreak) => styles.row(heightPt, custom, pageBreak))

			for (const row of rows) {
				const props = view.rowProps(row)
				const rowXf = broad ? null : writer.plannedRowXf(row)

				if (rowXf === null) {
					const custom = (props.flags & RowFlag.CUSTOM_HEIGHT) !== 0

					// A fresh row starts a page only in a new table, at one of its breaks.
					if (broad || added?.rowBreaks?.has(row) !== true) styles.row(view.height(props), custom, false)
					if (broad || added?.rowBreaks?.has(row) === true) styles.row(view.height(props), custom, true)
				}

				const rowStyle = view.rowStyle(row)

				if (rowStyle >= 0) styles.cell(rowStyle)

				for (const col of view.cellCols(row)) {
					const cell = view.cell(row, col)

					if (rowXf === null || writer.namesStyle(cell.xf, col, rowXf)) styles.cell(cell.xf)

					for (const run of cell.runs ?? []) if (run.font !== null) styles.text(run.font)
				}

				yield
			}

			if (writer.columnsChanged) {
				for (const range of model.cols) {
					styles.column(view.columnPx(range), false)

					if (range.style > 0) styles.cell(range.style)
				}

				styles.column(view.defaultColumnPx(), false)
				styles.cell(0)
			}

			this.tableStyle(entry, source)
		}
	}

	// table:database-ranges written again: every range but the changed sheets' autoFilters as it was, those as they are
	// now, new ones after them.
	private endRanges(end: number): void {
		const element = decodeUtf8(this.stream.bytes(this.rangesStart, end))
		const filters = this.plan.filters
		const open = /^<[^>]*>/.exec(element)?.[0] ?? "<table:database-ranges>"
		const inner = open.endsWith("/>") ? "" : element.slice(open.length, element.lastIndexOf("<"))
		const seen = new Set<string>()
		const out: string[] = []

		for (const child of topElements(inner)) {
			const tag = /^<[^>]*>/.exec(child)?.[0] ?? ""
			const attributes = tagAttributes(encodeTag(tag))
			const sheet = rangeSheet(attributes.get("table:target-range-address") ?? "")

			if (
				attributes.get("table:display-filter-buttons") === "true" &&
				sheet !== undefined &&
				!seen.has(sheet) &&
				filters?.replaced.has(sheet) === true
			) {
				seen.add(sheet)

				const replacement = filters.replaced.get(sheet)

				if (replacement !== null && replacement !== undefined) out.push(replacement)

				continue
			}

			if (sheet !== undefined && attributes.get("table:display-filter-buttons") === "true") seen.add(sheet)

			out.push(
				this.databaseRanges.has(attributes.get("table:name") ?? "")
					? this.moved(child, (local, value, shifter) =>
							local === "target-range-address" || local === "condition-source-range-address"
								? shifter.address(value)
								: undefined
						)
					: child
			)
		}

		appendAll(out, filters?.added ?? [])
		this.ownStructure(out.length === 0 ? "" : `<table:database-ranges>${out.join("")}</table:database-ranges>`)
		this.filtersDone = true
		this.rangesStart = -1
		this.copyFrom = end
	}

	private endPatched(end: number): void {
		const element = decodeUtf8(this.stream.bytes(this.patchStart, end))

		this.ownStructure(
			this.moved(element, (local, value, shifter) =>
				ADDRESS_ATTRIBUTES.get(local) === "address" ? shifter.address(value) : undefined
			)
		)
		this.patchStart = -1
		this.patchDepth = -1
		this.copyFrom = end
	}

	private namesChanged(scope: number | null): boolean {
		const plan = this.plan.names?.get(scope)

		if (this.namesDone.has(scope)) return false

		return this.nameScopes.has(scope) || (plan !== undefined && (plan.replaced.size > 0 || plan.added.length > 0))
	}

	// table:named-expressions written again: each name as it was but those an edit changed, new ones after them.
	private endNames(scope: number | null, end: number): void {
		const element = decodeUtf8(this.stream.bytes(this.namesStart, end))
		const plan = this.plan.names?.get(scope)
		const open = /^<[^>]*>/.exec(element)?.[0] ?? "<table:named-expressions>"
		const inner = open.endsWith("/>") ? "" : element.slice(open.length, element.lastIndexOf("<"))
		const out: string[] = []

		for (const child of topElements(inner)) {
			const tag = /^<[^>]*>/.exec(child)?.[0] ?? ""
			const name = tagAttributes(encodeTag(tag)).get("table:name")?.toUpperCase()
			const replacement = name === undefined ? undefined : plan?.replaced.get(name)

			if (replacement === undefined)
				out.push(
					name === undefined
						? child
						: this.moved(child, (local, value, shifter) => {
								if (!this.nameKeys.has(nameKey(scope, name, local))) return undefined

								return local === "expression" ? shifter.formula(value, "", "name") : shifter.address(value, "name")
							})
				)
			else if (replacement !== null) out.push(replacement)
		}

		appendAll(out, plan?.added ?? [])
		this.ownStructure(out.length === 0 ? "" : `<table:named-expressions>${out.join("")}</table:named-expressions>`)
		this.namesDone.add(scope)
		this.namesStart = -1
		this.namesDepth = -1
		this.copyFrom = end
	}

	// A table:named-expressions for new names of a scope whose source element has none.
	private newNames(scope: number | null, at: number): void {
		if (!this.namesChanged(scope)) return

		this.namesDone.add(scope)

		const added = this.plan.names?.get(scope)?.added ?? []

		if (added.length > 0) {
			this.flush(at)
			this.ownStructure(`<table:named-expressions>${added.join("")}</table:named-expressions>`)
		}
	}

	// A table:database-ranges for new filters where the source has none.
	private newRanges(): void {
		this.filtersDone = true

		const added = this.plan.filters?.added ?? []

		if (added.length > 0) this.ownStructure(`<table:database-ranges>${added.join("")}</table:database-ranges>`)
	}

	// A sheet's print area as table:print-ranges (§19.687), undefined for none.
	private printArea(entry: XlsxSheetEntry): string | undefined {
		const name = this.plan.document.workbook.definedNames.find(
			defined => defined.sheet === entry.id && defined.name.toUpperCase() === "_XLNM.PRINT_AREA"
		)

		return name === undefined ? undefined : printRanges(name.formula, entry.name)
	}

	private sourcePrintArea(source: OdsTableSource): string | undefined {
		const name = this.plan.source.definedNames.find(
			defined => defined.sheet === source.id && defined.name.toUpperCase() === "_XLNM.PRINT_AREA"
		)

		return name === undefined ? undefined : printRanges(name.formula, source.name)
	}

	// The style a sheet's table:table names: the source's while its look is unchanged.
	private tableStyle(entry: XlsxSheetEntry, source: OdsTableSource | null): string | undefined {
		const model = entry.model as XlsxSheetModel
		const hidden = entry.state !== "visible"
		const rightToLeft = model.view.rightToLeft
		const tab = model.tabColor?.argb === undefined ? -1 : model.tabColor.argb & 0xffffff

		if (source !== null && source.hidden === hidden && source.rightToLeft === rightToLeft && source.tabColor === tab)
			return source.styleName

		return this.plan.styles.table(
			source?.styleName,
			!hidden,
			rightToLeft,
			tab,
			source === null ? this.plan.newTables?.get(entry.id)?.masterPage : undefined
		)
	}

	// New validations without the source's element: one of their own, before the tables (§9.4.1).
	private ownValidations(): void {
		if (this.validations === "") return

		this.ownStructure(`<table:content-validations>${this.validations}</table:content-validations>`)
		this.validations = ""
	}

	// The automatic styles added, as they go out: none may be added after.
	private automaticMarkup(): string {
		this.plan.styles.seal()

		return this.plan.styles.markup()
	}

	// --- Output ---

	private emit(piece: string | Uint8Array): void {
		if (piece.length > 0) this.out.push(piece)
	}

	// Markup of the writer's own beyond rows and styles (a table's tag, columns, names, ranges, validations, shapes):
	// the save is proved by reading it all back.
	private ownStructure(piece: string): void {
		if (piece.length > 0) this.spanBlocked = true

		this.own(piece)
	}

	// Set once the content holds a change past rows and styles (ownStructure, a table written anew).
	spanBlocked = false
	// The writer of each table it wrote, by sheet id.
	readonly tableWriters = new Map<number, TableWriter>()

	// Markup of the writer's own.
	private own(piece: string): void {
		if (piece.length === 0) return

		this.changed = true
		this.out.push(piece)
	}

	// Source bytes up to `to`, as they are.
	private flush(to: number): void {
		if (this.copyFrom >= 0 && to > this.copyFrom) this.emit(this.stream.bytes(this.copyFrom, to).slice())

		if (this.copyFrom >= 0) this.copyFrom = Math.max(this.copyFrom, to)
	}

	private updateKeep(): void {
		let keep = this.stream.offset

		if (this.copyFrom >= 0) keep = Math.min(keep, this.copyFrom)
		// Elements taken whole to be written again: their bytes stay until their end.
		for (const start of [this.namesStart, this.rangesStart, this.patchStart]) if (start >= 0) keep = Math.min(keep, start)
		if (this.table !== null && this.table.columnsStart >= 0 && !this.table.columnsDone) keep = Math.min(keep, this.table.columnsStart)
		if (this.table !== null && this.table.captureStart >= 0) keep = Math.min(keep, this.table.captureStart)

		this.stream.keep = keep
	}

	// Output of a sheet whose turn has not come is held; once it has, held ones that follow go out after it.
	private beginSlot(slot: number): void {
		if (slot === this.nextSlot) return

		this.changed = true
		this.held.set(slot, [])
		this.out = this.held.get(slot) ?? []
	}

	private main: Piece[] = []

	private endSlot(slot: number): void {
		if (slot !== this.nextSlot) {
			this.out = this.main

			return
		}

		this.nextSlot++
		this.drainSlots(false)
	}

	// Sheets whose turn has come: held ones, and new ones written from the model; with `all` every one left.
	private drainSlots(all: boolean): void {
		for (;;) {
			const held = this.held.get(this.nextSlot)

			if (held !== undefined) {
				for (const piece of held) this.main.push(piece)

				this.held.delete(this.nextSlot)
				this.nextSlot++

				continue
			}

			const entry = this.entries[this.nextSlot]

			if (entry === undefined) return
			if (this.sourceOf(entry) !== undefined && !all) return
			if (this.sourceOf(entry) === undefined) {
				this.changed = true
				this.spanBlocked = true
				this.main.push(this.freshTable(entry))
			}

			this.nextSlot++
		}
	}

	private freshTable(entry: XlsxSheetEntry): LazyPieces {
		const writer = this.writerFor(entry)
		const style = this.tableStyle(entry, null)
		const protection = (entry.model as XlsxSheetModel).protection
		const tag = protectedTag(
			replaceAttribute(
				`<table:table table:name="${escapeAttribute(entry.name)}"${style === undefined ? "" : ` table:style-name="${escapeAttribute(style)}"`}>`,
				"table:print-ranges",
				this.printArea(entry)
			),
			protection
		)

		const head = `${tag}${protectionChild(protection, this.plan.source.prefixes)}${writer.columns()}`
		// The sheet's own names, after its rows (ODF 1.3 Part 3 §9.1.2).
		const names = this.namesChanged(entry.id) ? (this.plan.names?.get(entry.id)?.added ?? []) : []
		const end = this.plan.newTables?.get(entry.id)?.end ?? ""

		this.namesDone.add(entry.id)

		return new LazyPieces(function* () {
			yield head
			yield* writer.rowsEndPieces()
			yield `${names.length === 0 ? "" : `<table:named-expressions>${names.join("")}</table:named-expressions>`}${end}</table:table>`
		})
	}

	// --- Stream ---

	async *write(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array | string> {
		// Every style the tables will name, before office:automatic-styles goes out.
		await runSliced(this.precompute(), this.plan.clock)

		this.out = this.main

		for await (const chunk of chunks) {
			// In pieces, the clock looked at after each: rows written again cost more than reading them.
			for (let at = 0; at < chunk.length; at += WRITE_SLICE) {
				this.stream.push(at === 0 && chunk.length <= WRITE_SLICE ? chunk : chunk.subarray(at, at + WRITE_SLICE))
				this.flush(this.stream.scannedOffset)
				this.updateKeep()

				yield* this.take()

				if (this.plan.clock?.due === true) await this.plan.clock.pause()
			}
		}

		this.stream.end()
		this.flush(this.stream.offset)

		yield* this.take()
	}

	// A row written again, rendered as it goes out (the rows captured with it are read back together on the first).
	private rendered(piece: DeferredRow): Uint8Array {
		const bytes = encodeUtf8(piece.render())

		if (sameBytes(bytes, piece.source)) return piece.source

		this.changed = true

		return bytes
	}

	private *take(): Generator<Uint8Array | string> {
		if (this.main.length === 0) return

		const pieces = this.main

		this.main = []

		if (this.out === pieces) this.out = this.main

		for (const piece of pieces) {
			if (piece instanceof LazyPieces) yield* piece.pieces()
			else yield piece instanceof DeferredRow ? this.rendered(piece) : piece
		}
	}

	// Where the empty tag being handled starts (its end is handled at once), -1 for none.
	private emptyStart = -1
	private automaticSeen = false
	private facesSeen = false

	tag(kind: TagKind, name: number, start: number, end: number): void {
		this.emptyStart = kind === TagKind.EMPTY ? start : -1

		if (kind === TagKind.END) {
			this.end(name, start, end)
			this.stack.pop()

			return
		}

		this.stack.push(name)
		this.start(name, start, end, kind === TagKind.EMPTY)

		if (kind === TagKind.EMPTY) {
			this.end(name, start, end)
			this.stack.pop()
		}
	}

	private parent(): number {
		return this.stack[this.stack.length - 2] ?? 0
	}

	private start(name: number, start: number, end: number, empty: boolean): void {
		const depth = this.stack.length

		// Inside an element taken whole: nothing to look at.
		if (this.patchStart >= 0) return

		if (!this.rootSeen && name === N["office:document-content"]) {
			this.rootSeen = true

			if (this.declarations !== "") {
				this.flush(start)

				const tag = decodeUtf8(this.stream.bytes(start, end))
				const close = empty ? "/>" : ">"

				this.own(`${tag.slice(0, tag.length - close.length)}${this.declarations}${close}`)
				this.copyFrom = end
			}

			return
		}

		// A content.xml without font face declarations: the new faces' go before the styles.
		if ((name === N["office:automatic-styles"] || name === N["office:body"]) && depth === 2 && !this.facesSeen) {
			this.facesSeen = true

			const faces = this.plan.styles.fontFaces()

			if (faces !== "") {
				this.flush(start)
				this.own(`<office:font-face-decls>${faces}</office:font-face-decls>`)
			}
		}

		// A content.xml without automatic styles: they go before the body.
		if (name === N["office:body"] && depth === 2 && !this.automaticSeen) {
			this.automaticSeen = true
			this.flush(start)

			const automatic = this.automaticMarkup()

			if (automatic !== "") this.own(`<office:automatic-styles>${automatic}</office:automatic-styles>`)
		}

		// A spreadsheet of no table: the new ones (their validations before them) go before the first element that
		// follows the tables (ODF 1.3 Part 3 §9.1.1).
		if (
			this.plan.source.tables.length === 0 &&
			!this.tablesDone &&
			this.parent() === N["office:spreadsheet"] &&
			AFTER_TABLES.has(name)
		) {
			this.flush(start)
			this.tablesDone = true
			this.ownValidations()
			this.drainSlots(true)
		}

		const table = this.table

		if (table !== null) {
			this.inTable(table, name, start, end, empty, depth)

			return
		}

		if (name === N["table:table"] && this.parent() === N["office:spreadsheet"]) {
			this.flush(start)
			this.ownValidations()

			this.openTable(start, end, empty, depth)

			return
		}

		if (name === N["table:named-expressions"] && this.parent() === N["office:spreadsheet"] && this.namesChanged(null)) {
			this.flush(start)
			this.copyFrom = -1
			this.namesStart = start
			this.namesDepth = depth

			if (empty) this.endNames(null, end)

			return
		}

		// Where the workbook's names go when the source has none: before the database ranges and what follows them.
		if (
			(name === N["table:database-ranges"] ||
				name === N["table:data-pilot-tables"] ||
				name === N["table:consolidation"] ||
				name === N["table:dde-links"]) &&
			this.parent() === N["office:spreadsheet"]
		)
			this.newNames(null, start)

		if (name === N["table:database-ranges"] && this.parent() === N["office:spreadsheet"] && !this.filtersDone) {
			this.flush(start)
			this.copyFrom = -1
			this.rangesStart = start

			if (empty) this.endRanges(end)

			return
		}

		// Past where table:database-ranges would be: new filters' element there.
		if (
			(name === N["table:data-pilot-tables"] || name === N["table:consolidation"] || name === N["table:dde-links"]) &&
			this.parent() === N["office:spreadsheet"] &&
			!this.filtersDone
		) {
			this.flush(start)
			this.newRanges()
		}

		// DataPilot tables, consolidation and label ranges naming cells that moved: taken whole and written again.
		if (this.patchedElements.has(name) && this.parent() === N["office:spreadsheet"]) {
			this.flush(start)
			this.copyFrom = -1
			this.patchStart = start
			this.patchDepth = depth

			if (empty) this.endPatched(end)

			return
		}

		if (name === N["table:content-validations"] && this.parent() === N["office:spreadsheet"] && empty && this.validations !== "") {
			this.flush(start)
			this.ownStructure(`<table:content-validations>${this.validations}</table:content-validations>`)
			this.validations = ""
			this.copyFrom = end

			return
		}

		if (name === N["office:spreadsheet"]) {
			const protection = this.plan.document.workbook.protection

			if (!sameWorkbookProtection(protection, this.plan.source.protection)) {
				this.flush(start)

				let tag = decodeUtf8(this.stream.bytes(start, end))

				tag = replaceAttribute(tag, "table:structure-protected", protection?.structure === true ? "true" : undefined)
				tag = replaceAttribute(tag, "table:protection-key", protection?.structure === true ? protection.hash.hashValue : undefined)
				tag = replaceAttribute(
					tag,
					"table:protection-key-digest-algorithm",
					protection?.structure === true ? protection.hash.algorithmName : undefined
				)
				this.ownStructure(tag)
				this.copyFrom = end
			}

			return
		}

		// The first element after the tables: every sheet still to come goes before it.
		if (this.parent() === N["office:spreadsheet"] && this.sourceTable > 0 && !this.tablesDone) {
			this.flush(start)
			this.tablesDone = true
			this.drainSlots(true)
		}
	}

	private end(name: number, start: number, end: number): void {
		const table = this.table

		if (this.patchStart >= 0) {
			if (this.stack.length === this.patchDepth) this.endPatched(end)

			return
		}

		if (table !== null) {
			if (name === N["table:table"] && this.stack.length === table.depth) this.closeTable(table, start, end)
			else this.endInTable(table, name, end)

			return
		}

		if (name === N["table:content-validations"] && this.stack.length === 4 && this.validations !== "") {
			this.flush(start)
			this.ownStructure(this.validations)
			this.validations = ""

			return
		}

		if (name === N["office:font-face-decls"] && this.stack.length === 2) {
			this.facesSeen = true
			this.flush(start)

			if (start === this.emptyStart) {
				const faces = this.plan.styles.fontFaces()

				if (faces !== "") {
					this.own(`<office:font-face-decls>${faces}</office:font-face-decls>`)
					this.copyFrom = end
				}
			} else {
				this.own(this.plan.styles.fontFaces())
			}

			return
		}

		if (name === N["office:automatic-styles"] && this.stack.length === 2) {
			this.automaticSeen = true

			if (start === this.emptyStart) {
				// <office:automatic-styles/>: written open, with the styles.
				this.flush(start)
				this.own(`<office:automatic-styles>${this.automaticMarkup()}</office:automatic-styles>`)
				this.copyFrom = end
			} else {
				this.flush(start)
				this.own(this.automaticMarkup())
			}

			return
		}

		if (name === N["table:named-expressions"] && this.namesStart >= 0 && this.stack.length === this.namesDepth && this.table === null) {
			this.endNames(null, end)

			return
		}

		if (name === N["table:database-ranges"] && this.stack.length === 4 && this.rangesStart >= 0) {
			this.endRanges(end)

			return
		}

		if (name === N["office:spreadsheet"]) {
			this.flush(start)

			if (!this.tablesDone) {
				this.tablesDone = true
				this.ownValidations()
				this.drainSlots(true)
			}

			this.newNames(null, start)

			if (!this.filtersDone) this.newRanges()
		}
	}

	private openTable(start: number, end: number, empty: boolean, depth: number): void {
		const index = this.sourceTable++
		const slot = this.slotOf.get(index) ?? -1

		this.flush(start)

		// New sheets that come before this one in the order now.
		this.drainSlots(false)

		const entry = slot < 0 ? undefined : this.entries[slot]

		if (entry === undefined) {
			// A deleted sheet: nothing of it is written.
			this.changed = true
			this.copyFrom = -1
			this.table = {
				writer: null,
				slot: -1,
				depth,
				columnsStart: -1,
				columnsDone: true,
				rowsDone: true,
				groups: [],
				captureStart: -1,
				captureDepth: -1,
				index,
				shapesDepth: -1,
				protectionChanged: false
			}

			if (empty) this.closeTable(this.table, end, end)

			return
		}

		this.beginSlot(slot)

		const writer = this.writerFor(entry)
		const source = this.sourceOf(entry) ?? null
		let tag = decodeUtf8(this.stream.bytes(start, end))

		if (source !== null && entry.name !== source.name) tag = replaceAttribute(tag, "table:name", entry.name)

		const style = this.tableStyle(entry, source)

		if (style !== source?.styleName) tag = replaceAttribute(tag, "table:style-name", style)

		const model = entry.model as XlsxSheetModel
		const printArea = this.printArea(entry)

		if (source === null || printArea !== this.sourcePrintArea(source)) tag = replaceAttribute(tag, "table:print-ranges", printArea)

		const protectionChanged = source === null || !sameProtection(model.protection, source.protection)

		if (protectionChanged) tag = protectedTag(tag, model.protection)

		const original = decodeUtf8(this.stream.bytes(start, end))

		if (empty && tag.endsWith("/>")) tag = `${tag.slice(0, -2)}>`

		if (tag === original) this.emit(this.stream.bytes(start, end).slice())
		else this.ownStructure(tag)

		// What stays allowed under protection (LibreOffice's loext:table-protection, its first child).
		if (protectionChanged && !empty) this.ownStructure(protectionChild(model.protection, this.plan.source.prefixes))

		this.copyFrom = end
		this.table = {
			writer,
			slot,
			depth,
			columnsStart: -1,
			columnsDone: false,
			rowsDone: false,
			groups: [],
			captureStart: -1,
			captureDepth: -1,
			index,
			shapesDepth: -1,
			protectionChanged
		}

		if (source !== null) writer.sourceColumns = source.columns
		if (empty) this.closeTable(this.table, end, end)
	}

	private inTable(table: TableState, name: number, start: number, end: number, empty: boolean, depth: number): void {
		const writer = table.writer

		if (writer === null) return

		// Inside a row being taken whole, shapes or names written again: nothing to look at.
		if (table.captureStart >= 0 || table.shapesDepth >= 0 || this.namesStart >= 0) return

		const child = depth === table.depth + 1
		const shapes = this.plan.shapes?.get(table.index)

		if (child && name === N["table:named-expressions"] && writer.entry !== undefined && this.namesChanged(writer.entry.id)) {
			if (!table.rowsDone && writer.hasRowsStarted) {
				this.flush(start)
				this.own(writer.rowsEnd())
				table.rowsDone = true
			}

			this.flush(start)
			this.copyFrom = -1
			this.namesStart = start
			this.namesDepth = depth

			if (empty) this.endNames(writer.entry.id, end)

			return
		}

		if (child && table.protectionChanged && (name === N["loext:table-protection"] || name === N["table:table-protection"])) {
			this.flush(start)
			this.copyFrom = -1

			if (empty) this.copyFrom = end
			else table.shapesDepth = depth

			return
		}

		if (child && name === N["table:shapes"] && shapes !== undefined) {
			this.flush(start)
			this.ownStructure(shapes)
			this.copyFrom = -1

			if (empty) this.copyFrom = end
			else table.shapesDepth = depth

			return
		}
		const inRows = depth > table.depth && this.stack.slice(table.depth, depth - 1).every(id => ROW_WRAPPERS.has(id))

		if (child && COLUMN_NAMES.has(name) && !table.columnsDone) {
			if (table.columnsStart < 0) {
				this.flush(start)
				table.columnsStart = start

				// Columns written again: the source's are not copied.
				if (writer.columnsChanged) this.copyFrom = -1
			}

			return
		}

		if (child && table.columnsStart >= 0 && !table.columnsDone) this.endColumns(table, writer, start)
		if (child && !table.columnsDone && (name === N["table:table-row"] || ROW_WRAPPERS.has(name))) this.endColumns(table, writer, start)

		if (name === N["table:table-row"] && inRows) {
			const tag = this.stream.bytes(start, end)
			const decision = writer.rowStart(tag, table.groups.length)

			// Nothing inside a row matters here (its cells are the writer's): its end is looked for alone.
			if (!empty) {
				let nameEnd = 1

				while (
					nameEnd < tag.length &&
					tag[nameEnd] !== 32 &&
					tag[nameEnd] !== 62 &&
					tag[nameEnd] !== 47 &&
					tag[nameEnd] !== 9 &&
					tag[nameEnd] !== 10 &&
					tag[nameEnd] !== 13
				)
					nameEnd++

				this.stream.skipTo(tag.slice(1, nameEnd))
			}

			if (decision === "capture") {
				this.flush(start)
				this.copyFrom = -1
				table.captureStart = start
				table.captureDepth = depth

				if (empty) this.endRow(table, writer, end)
			}

			return
		}

		if (inRows && name === N["table:table-row-group"] && !empty) table.groups.push(depth)

		// The first element after the rows: rows past the source's go before it.
		if (child && !table.rowsDone && !ROW_WRAPPERS.has(name) && name !== N["table:table-row"] && writer.hasRowsStarted) {
			this.flush(start)
			this.own(writer.rowsEnd())
			table.rowsDone = true
		}
	}

	private endColumns(table: TableState, writer: TableWriter, at: number): void {
		if (table.columnsDone) return

		table.columnsDone = true

		if (table.columnsStart >= 0) {
			writer.columnsMarkup = this.stream.bytes(table.columnsStart, at).slice()

			if (writer.columnsChanged) {
				const columns = writer.columns()

				if (columns === decodeUtf8(writer.columnsMarkup)) this.emit(writer.columnsMarkup)
				else {
					writer.writtenColumns = columns
					this.own(columns)
				}

				this.copyFrom = at
			}
		} else if (writer.columnsChanged) {
			this.flush(at)
			writer.writtenColumns = writer.columns()
			this.own(writer.writtenColumns)
		}

		writer.hasRowsStarted = true
	}

	private endInTable(table: TableState, name: number, end: number): void {
		const writer = table.writer

		if (writer === null) return

		if (table.captureStart >= 0) {
			if (name === N["table:table-row"] && this.stack.length === table.captureDepth) this.endRow(table, writer, end)

			return
		}

		if (this.namesStart >= 0 && name === N["table:named-expressions"] && this.stack.length === this.namesDepth) {
			this.endNames(writer.entry.id, end)

			return
		}

		if (table.shapesDepth >= 0) {
			if (this.stack.length === table.shapesDepth) {
				table.shapesDepth = -1
				this.copyFrom = end
			}

			return
		}

		if (name === N["table:table-row-group"] && table.groups[table.groups.length - 1] === this.stack.length) table.groups.pop()
	}

	private endRow(table: TableState, writer: TableWriter, end: number): void {
		const element = this.stream.bytes(table.captureStart, end)
		const written = writer.rowEnd(element)

		if (written instanceof Uint8Array) {
			if (written.length === element.length && written.every((byte, index) => byte === element[index])) this.emit(element.slice())
			else {
				this.changed = true
				this.out.push(written)
			}
		} else if (typeof written !== "string") {
			const piece = new DeferredRow(written, element.slice())

			this.out.push(piece)
		} else if (written === decodeUtf8(element)) this.emit(element.slice())
		else this.own(written)
		table.captureStart = -1
		table.captureDepth = -1
		this.copyFrom = end
	}

	private closeTable(table: TableState, start: number, end: number): void {
		const writer = table.writer

		if (writer === null) {
			// A deleted sheet's table: its bytes are dropped, copying goes on after it.
			this.copyFrom = end
			this.table = null

			return
		}

		if (!table.columnsDone) this.endColumns(table, writer, start)

		this.flush(start)

		if (!table.rowsDone) this.own(writer.rowsEnd())

		this.newNames(writer.entry.id, start)

		this.flush(end)
		this.table = null
		this.endSlot(table.slot)
	}
}

// "Sheet1!$A$1:$D$20,..." as table:print-ranges ("$Sheet1.$A$1:$Sheet1.$D$20 ..."): each area on its sheet.
export function printRanges(formula: string, sheet: string): string | undefined {
	const parts: string[] = []

	for (const area of formula.split(",")) {
		const text = area.trim()
		const bang = text.lastIndexOf("!")
		const name =
			bang < 0
				? sheet
				: text
						.slice(0, bang)
						.replace(/^'(.*)'$/, "$1")
						.replaceAll("''", "'")
		const range = bang < 0 ? text : text.slice(bang + 1)
		const [from = "", to] = range.split(":")
		const quoted = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replaceAll("'", "''")}'`

		if (!/^\$?[A-Z]{1,3}\$?\d+$/.test(from) || (to !== undefined && !/^\$?[A-Z]{1,3}\$?\d+$/.test(to))) return undefined

		parts.push(to === undefined ? `$${quoted}.${from}` : `$${quoted}.${from}:$${quoted}.${to}`)
	}

	return parts.length === 0 ? undefined : parts.join(" ")
}

function sameHash(a: XlsxProtectionHash | undefined, b: XlsxProtectionHash | undefined): boolean {
	return (a?.hashValue ?? "") === (b?.hashValue ?? "") && (a?.algorithmName ?? "") === (b?.algorithmName ?? "")
}

function sameProtection(a: XlsxSheetProtection | null, b: XlsxSheetProtection | null): boolean {
	if (a === null || b === null) return a === b

	return sameHash(a.hash, b.hash) && [...a.allows].sort().join() === [...b.allows].sort().join()
}

function sameWorkbookProtection(a: XlsxWorkbookProtection | null, b: XlsxWorkbookProtection | null): boolean {
	return (a?.structure === true) === (b?.structure === true) && (a?.structure !== true || sameHash(a.hash, b?.hash))
}

// A table:table start tag protected as `protection` says: table:protected, its key and the key's digest (§9.1.2).
function protectedTag(tag: string, protection: XlsxSheetProtection | null): string {
	const key = protection?.hash.hashValue
	const algorithm = protection?.hash.algorithmName
	let next = replaceAttribute(tag, "table:protected", protection === null ? undefined : "true")

	next = replaceAttribute(next, "table:protection-key", key === undefined || key === "" ? undefined : key)

	return replaceAttribute(
		next,
		"table:protection-key-digest-algorithm",
		algorithm === undefined || algorithm === "" ? undefined : algorithm
	)
}

// LibreOffice's loext:table-protection: what a protected sheet still allows beyond selecting its cells.
const ALLOWS: readonly (readonly [string, string])[] = [
	["selectLockedCells", "select-protected-cells"],
	["selectUnlockedCells", "select-unprotected-cells"],
	["insertColumns", "insert-columns"],
	["insertRows", "insert-rows"],
	["deleteColumns", "delete-columns"],
	["deleteRows", "delete-rows"]
]

function protectionChild(protection: XlsxSheetProtection | null, prefixes: ReadonlyMap<string, string>): string {
	if (protection === null) return ""

	const loext = [...prefixes].find(([, uri]) => uri === OdfNs.loext)?.[0]

	if (loext === undefined) return ""

	const allows = protection.allows as ReadonlySet<string>
	const attributes = ALLOWS.map(([action, name]) => ` ${loext}:${name}="${allows.has(action) ? "true" : "false"}"`).join("")

	return `<${loext}:table-protection${attributes}/>`
}

// The top-level elements of markup, as written.
function topElements(markup: string): string[] {
	const out: string[] = []
	let depth = 0
	let start = -1

	for (let at = markup.indexOf("<"); at >= 0; at = markup.indexOf("<", at + 1)) {
		const close = markup.indexOf(">", at)

		if (close < 0) break

		const next = markup[at + 1]

		if (next === "!" || next === "?") continue

		if (next === "/") {
			depth--

			if (depth === 0 && start >= 0) {
				out.push(markup.slice(start, close + 1))
				start = -1
			}
		} else {
			if (depth === 0) start = at

			if (markup[close - 1] === "/") {
				if (depth === 0) {
					out.push(markup.slice(start, close + 1))
					start = -1
				}
			} else {
				depth++
			}
		}

		at = close
	}

	return out
}

function encodeTag(tag: string): Uint8Array {
	return new TextEncoder().encode(tag)
}

// The sheet a table:target-range-address names ("Sheet1.A1:Sheet1.D9", "'My sheet'.A1:..."), undefined for none.
function rangeSheet(address: string): string | undefined {
	const first = address.trim().split(/[:\s]/)[0] ?? ""
	const text = first.replace(/^\$/, "")

	if (text.startsWith("'")) {
		const close = text.indexOf("'.", 1)

		return close < 0 ? undefined : text.slice(1, close).replaceAll("''", "'")
	}

	const dot = text.lastIndexOf(".")

	return dot <= 0 ? undefined : text.slice(0, dot)
}

function replaceAttribute(tag: string, name: string, value: string | undefined): string {
	const pattern = new RegExp(`\\s${name}="[^"]*"`)
	const close = tag.endsWith("/>") ? "/>" : ">"
	const without = tag.replace(pattern, "")

	if (value === undefined) return without

	return `${without.slice(0, without.length - close.length)} ${name}="${escapeAttribute(value)}"${close}`
}

export { tagAttributes }
