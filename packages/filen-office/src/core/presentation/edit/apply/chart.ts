import { drawingTheme } from "../../../drawingml/color"
import { bytesSource } from "../../../opc/io"
import { partKey } from "../../../opc/index"
import { chartObject } from "../../../ods/convert/chart"
import {
	AXIS_STYLE,
	LOCAL_TABLE as ODP_LOCAL_TABLE,
	isFormatted,
	localTableStyles,
	odpLocalTable,
	ownTableStyle,
	type TableCell
} from "../../../odp/write/chartObject"
import { OdfStyleSheet } from "../../../odf/styles"
import { dataStyleCode } from "../../../ods/styles/dataStyle"
import { dateValue, NULL_DATE_1899 } from "../../../ods/read/values"
import { chartOf, translateChart } from "../../../ods/charts/read"
import { ChartRefused, patchObject } from "../../../ods/charts/write"
import { formatValue } from "../../../sheet/numfmt/index"
import type { SheetRange } from "../../../sheet/protocol"
import type { Slicing } from "../../../slicing"
import { cellsWorkbookXlsx } from "../../../xlsx/convert/text"
import { refreshChartCaches, type ChartCell, type ChartCells, type ChartSheetCells } from "../../../xlsx/charts/cache"
import { chartLayout, chartSource, newChartPart } from "../../../xlsx/charts/create"
import { applyChartEdit, ChartEditRefused, type ChartEditType, type ChartFormulaHost, type SheetChartEdit } from "../../../xlsx/charts/edit"
import { cellsFormulaHost } from "../../../xlsx/charts/formulas"
import { readChartInfo, type ChartInfo } from "../../../xlsx/charts/model"
import { chartAreas } from "../../../xlsx/charts/refs"
import type { SheetStore } from "../../../xlsx/model/store"
import { decodeXstring } from "../../../xlsx/model/strings"
import { CellKind, type XlsxSheetModel } from "../../../xlsx/model/types"
import type { XlsxWorkbook } from "../../../xlsx/model/workbook"
import { openXlsx } from "../../../xlsx/package/open"
import { Namespaces, NodeKind, decodeUtf8, encodeUtf8, parseXml, XmlEditor, XmlError, type XmlDocument } from "../../../xml/index"
import {
	refused,
	type Deck,
	type FrameRef,
	type Refused,
	type ShapeNode,
	type ShapeRef,
	type SlideNode,
	type SlideRef,
	slideRef
} from "../../model"
import type { ApplyContext, ApplyFamily, ApplyResult, Touch } from "../apply"
import { findShape } from "../changes"
import type { ChartOp, DeckOp } from "../ops"
import { applyShape, isRefused } from "./shape"

// The chart ops on the model, in place. A chart frame names its chart (`frame.part`); every edit makes a new version
// of it that the session holds under a "chart:N" name (the renderer reads it through chartDocument, the emitters write
// it) and points the frame at it. A version never changes once made: an undo points the frame back at the version it
// named before (restore), a redo at the one the op made.
//
// Every version belongs to a lineage: one chart, written into one package part, its home, once it has one. The home
// is the source's chart part (pptx "/ppt/charts/chart2.xml"; ODP the chart object, "Object 1") or, for an inserted
// chart, the part the first committed save wrote. The registry knows which version each home holds (the source's, or
// one a committed save wrote), so a save writes a version into its home only when the home holds another, and names
// the home as it is otherwise: nothing is written twice across undo and redo past a save.
//
// A pptx chart's data is its embedded workbook (ECMA-376 Part 1 §21.2.2.63 c:externalData): Edit Data replaces it
// (setWorkbook) and the chart's caches are read again from its cells (refreshChartCaches). An embedded .xls (an OLE
// object) becomes an embedded .xlsx part on its first Edit Data. An ODP chart's data is the object's own table
// (ODF 1.3 Part 3 §11.1): Edit Data writes the cells back into it, and the other edits are made on the object through
// core/ods/charts/write (patchObject), which proves each by reading the object back.

type ChartFrame = Extract<FrameRef, { kind: "chart" }>
type InsertOp = Extract<ChartOp, { kind: "insert" }>
// A cell of a chart's data: text, a number, a number in a format of its own (a date, a percentage), or empty.
export type Cell = TableCell

export type WorkbookKind = "xlsx" | "xls" | "odfTable"

export const XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const XLS_CONTENT_TYPE = "application/vnd.ms-excel"
const HELD_CHART_PREFIX = "chart:"
// The sheet an inserted chart's data is on (PowerPoint's own name for it), and an ODP object's own table.
const CHART_DATA_SHEET = "Sheet1"
// The largest chart part, object or embedded workbook read here.
const MAX_CHART_BYTES = 16 * 1024 * 1024
// The cells a chart's own data may hold (a slide's chart, not a sheet).
const MAX_CHART_CELLS = 100_000
// The c:externalData relationship an inserted chart names its workbook by (ECMA-376 Part 1 §21.2.2.63).
export const INSERTED_WORKBOOK_ID = "rId1"

export interface ChartWorkbook {
	readonly bytes: Uint8Array
	readonly contentType: string
	readonly kind: WorkbookKind
}

// A relationship of a source chart part (pptx), carried over when the chart is written into a new part.
export interface ChartRelationship {
	readonly id: string
	readonly type: string
	// A part name ("/ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx"), or an external target.
	readonly target: string
	readonly external: boolean
}

export interface ChartLineage {
	readonly format: "pptx" | "odp"
	// The package part the chart is in (pptx: the chart part; ODP: the object's path, "Object 1"), once it has one.
	home: string | undefined
	// pptx: its embedded workbook part and kind, once it has one.
	workbookHome: string | undefined
	workbookKind: WorkbookKind | undefined
	// pptx: the source chart part's relationships; ODP: the object's other streams (styles.xml, meta.xml) by name.
	readonly rels: readonly ChartRelationship[]
	readonly streams: ReadonlyMap<string, Uint8Array>
	// The source's workbook as read when Edit Data first replaced it: a version that keeps the source's workbook
	// writes it back once a save wrote another into its home.
	original: ChartWorkbook | undefined
	// The frame the home belongs to (chartOwner); undefined until an inserted chart's first save.
	owner: string | undefined
	// A duplicated frame's own chart, made from its source's at its first edit: written into the part the save copied
	// for the frame (pptx), else into a new part or object of its own, never into its source's.
	readonly copy?: true
}

// One version of a chart.
export interface HeldChart {
	readonly name: string
	readonly lineage: ChartLineage
	// The chart as DrawingML (pptx: the part; ODP: the object's translation): what renders and what edits read.
	readonly document: XmlDocument
	// pptx: the chart part's bytes.
	readonly bytes: Uint8Array
	// pptx: this version's workbook; undefined: the lineage's own.
	readonly workbook: ChartWorkbook | undefined
	// ODP: the object's content.xml.
	readonly object: Uint8Array | undefined
	// The source as read: its home holds it until a save writes another version there.
	readonly pristine: boolean
}

// What prepare read for one op: a new workbook's cells, an inserted chart's workbook.
interface Prepared {
	readonly workbook?: Uint8Array
	readonly cells?: WorkbookCells
}

// A chart of the package as prepare read it.
interface SourceChart {
	readonly bytes: Uint8Array
	readonly document: XmlDocument
	readonly object: Uint8Array | undefined
	readonly rels: readonly ChartRelationship[]
	readonly streams: ReadonlyMap<string, Uint8Array>
	readonly workbook: ChartWorkbook | undefined
}

export type ChartWriteRole = "chart" | "workbook" | "object"

interface Registry {
	readonly held: Map<string, HeldChart>
	// Lineages by their home.
	readonly lineages: Map<string, ChartLineage>
	// Home → the version its package part holds now.
	readonly holds: Map<string, string>
	// Workbook home → the workbook its part holds now (absent: the source's).
	readonly workbookHolds: Map<string, ChartWorkbook>
	// What a save's emits handed the writer, by the bytes object (identity names the entry it became).
	readonly writes: WeakMap<object, { readonly version: string; readonly role: ChartWriteRole; readonly owner: string }>
	readonly prepared: WeakMap<object, Prepared>
	readonly sources: Map<string, SourceChart>
	// The version an op made, by the op as applied (a redo names it again).
	readonly made: WeakMap<object, string>
	next: number
}

const registries = new WeakMap<Deck, Registry>()

function registryOf(deck: Deck): Registry {
	let registry = registries.get(deck)

	if (registry === undefined) {
		registry = {
			held: new Map(),
			lineages: new Map(),
			holds: new Map(),
			workbookHolds: new Map(),
			writes: new WeakMap(),
			prepared: new WeakMap(),
			sources: new Map(),
			made: new WeakMap(),
			next: 1
		}
		registries.set(deck, registry)
	}

	return registry
}

export function isHeldChart(part: string): boolean {
	return part.startsWith(HELD_CHART_PREFIX)
}

export function heldChart(deck: Deck, part: string): HeldChart | undefined {
	return registries.get(deck)?.held.get(part)
}

// A held version's chart as the renderer reads it (undefined for a package part).
export function chartDocument(deck: Deck, part: string): XmlDocument | undefined {
	return isHeldChart(part) ? registries.get(deck)?.held.get(part)?.document : undefined
}

// The part a held version's references (pictures in its fills) resolve against: its home.
export function chartRelationshipOwner(deck: Deck, part: string): string | undefined {
	return isHeldChart(part) ? registries.get(deck)?.held.get(part)?.lineage.home : undefined
}

// The version a home holds now.
export function chartHeldBy(deck: Deck, home: string): string | undefined {
	return registries.get(deck)?.holds.get(home)
}

// Whether the workbook part `home` holds `workbook` now (a version without its own workbook: the source's).
export function workbookHeld(deck: Deck, home: string, workbook: ChartWorkbook | undefined): boolean {
	const held = registries.get(deck)?.workbookHolds.get(home)

	if (held === undefined) return workbook === undefined || workbook === heldOriginal(deck, home)

	return held === workbook || (workbook === undefined && held === heldOriginal(deck, home))
}

function heldOriginal(deck: Deck, home: string): ChartWorkbook | undefined {
	for (const lineage of registries.get(deck)?.lineages.values() ?? []) if (lineage.workbookHome === home) return lineage.original

	return undefined
}

// The workbook a version has: its own, else its lineage's (the source's, when read).
export function versionWorkbook(version: HeldChart): ChartWorkbook | undefined {
	return version.workbook ?? version.lineage.original
}

// The frame a chart is written for: its slide and its shape id. A lineage's home belongs to one frame (a duplicated
// slide's copy of a chart frame gets parts of its own).
export function chartOwner(slide: SlideRef, shape: number): string {
	return `${String(slide)}#${String(shape)}`
}

// Whether the frame `owner` writes into its lineage's home (the frame the home belongs to, or any while none does).
export function ownsHome(lineage: ChartLineage, owner: string): boolean {
	return lineage.owner === undefined || lineage.owner === owner
}

// An emit hands the writer these bytes for `version` written for the frame `owner` (each write a view of its own: the
// save's changes name the entry it became by identity).
export function noteChartWrite(deck: Deck, bytes: object, version: string, role: ChartWriteRole, owner: string): void {
	registryOf(deck).writes.set(bytes, { version, role, owner })
}

// The chart versions among a save's added and replaced entries, with the name each was written to.
export interface ChartWrites {
	readonly entries: readonly {
		readonly version: string
		readonly role: ChartWriteRole
		readonly owner: string
		readonly name: string
	}[]
}

// `names`: the entry name (pptx "/ppt/charts/chart3.xml", ODP "Object 3/content.xml") by the bytes object written.
export function chartWritesOf(deck: Deck, names: ReadonlyMap<object, string>): ChartWrites | undefined {
	const registry = registries.get(deck)

	if (registry === undefined) return undefined

	const entries: ChartWrites["entries"][number][] = []

	for (const [bytes, name] of names) {
		const write = registry.writes.get(bytes)

		if (write !== undefined) entries.push({ ...write, name })
	}

	return entries.length === 0 ? undefined : { entries }
}

// After a save committed: each version it wrote is what its home holds from now on, and an inserted chart's
// lineage has the parts the save added as its home, owned by the frame they were written for. A frame that wrote its
// lineage's version into parts of its own (a duplicated slide's copy) is a chart of its own from now on (fork).
export function commitChartWrites(deck: Deck, writes: ChartWrites | undefined): void {
	const registry = registries.get(deck)

	if (registry === undefined || writes === undefined) return

	const workbooks = new Map<string, string>()

	for (const entry of writes.entries) if (entry.role === "workbook") workbooks.set(`${entry.owner}\u0000${entry.version}`, entry.name)

	for (const { version, role, name, owner } of writes.entries) {
		const held = registry.held.get(version)

		if (held === undefined || role === "workbook") continue

		const lineage = held.lineage
		const home = role === "object" ? name.slice(0, name.lastIndexOf("/")) : name
		const workbook = workbooks.get(`${owner}\u0000${version}`)

		if (!ownsHome(lineage, owner)) {
			fork(deck, owner, held, home, workbook)

			continue
		}

		if (lineage.home !== home) {
			if (lineage.home !== undefined && registry.lineages.get(lineage.home) === lineage) registry.lineages.delete(lineage.home)

			lineage.home = home
			registry.lineages.set(home, lineage)
		}

		lineage.owner = owner
		registry.holds.set(home, version)

		if (workbook !== undefined) {
			const written = versionWorkbook(held)

			lineage.workbookHome = workbook
			lineage.workbookKind = written?.kind ?? lineage.workbookKind

			if (written !== undefined) registry.workbookHolds.set(workbook, written)
		}
	}
}

// The frame `owner` wrote its lineage's version into parts of its own: from now on it is a chart of its own, its
// lineage those parts (owned by it), its version what they hold.
function fork(deck: Deck, owner: string, held: HeldChart, home: string, workbook: string | undefined): void {
	const registry = registryOf(deck)
	const at = owner.lastIndexOf("#")
	const node = deck.nodes.get(slideRef(Number(owner.slice(0, at))))
	const shape = node === undefined ? undefined : findShape(node.shapes, Number(owner.slice(at + 1)))?.shape

	if (shape?.frame?.kind !== "chart" || shape.frame.part !== held.name) return

	const written = versionWorkbook(held)
	const lineage: ChartLineage = {
		...held.lineage,
		home,
		owner,
		workbookHome: workbook,
		workbookKind: written?.kind ?? held.lineage.workbookKind,
		original: written
	}
	const version = newVersion(deck, lineage, {
		document: held.document,
		bytes: held.bytes,
		...(held.workbook === undefined ? {} : { workbook: held.workbook }),
		...(held.object === undefined ? {} : { object: held.object })
	})

	registry.lineages.set(home, lineage)
	registry.holds.set(home, version.name)

	if (workbook !== undefined && written !== undefined) registry.workbookHolds.set(workbook, written)

	shape.frame = frameOf(version)
}

// ———— Prepare: what the ops read before they apply (apply is synchronous).

interface RelationshipLike {
	readonly id: string
	readonly type: string
	readonly target: string
	readonly external: boolean
	readonly partName?: string | undefined
}

// What prepare reads the package through: the engine's parts of either format.
export interface ChartPartSource {
	readonly opc: {
		entry(name: string): { readonly uncompressedSize: number } | undefined
		read(name: string, slicing?: Slicing): Promise<Uint8Array>
		relationships?(name: string): Promise<{ readonly all: readonly RelationshipLike[] }>
	}
	// A document the deck's parts hold (ODP: a chart object's translation, "Object 1/chart.xml").
	document?(part: string): XmlDocument | undefined
}

function zipName(part: string): string {
	return part.startsWith("/") ? part.slice(1) : part
}

async function readEntry(source: ChartPartSource, part: string, slicing: Slicing | undefined): Promise<Uint8Array | undefined> {
	const name = zipName(part)
	const entry = source.opc.entry(name)

	if (entry === undefined || entry.uncompressedSize > MAX_CHART_BYTES) return undefined

	return source.opc.read(name, slicing)
}

// The ODP object a translated chart is, as its zip entries name it ("/Object 1/chart.xml" → "Object 1").
function objectPathOf(part: string): string {
	const slash = part.lastIndexOf("/")
	const path = slash < 0 ? part : part.slice(0, slash)

	return path.startsWith("/") ? path.slice(1) : path
}

const ODP_OBJECT_STREAMS = ["styles.xml", "meta.xml"]

function workbookType(kind: WorkbookKind): string {
	return kind === "xlsx" ? XLSX_CONTENT_TYPE : XLS_CONTENT_TYPE
}

async function readSource(
	deck: Deck,
	frame: ChartFrame,
	source: ChartPartSource,
	slicing: Slicing | undefined,
	withWorkbook: boolean
): Promise<SourceChart | undefined> {
	const registry = registryOf(deck)
	const held = registry.sources.get(frame.part)
	const wantsWorkbook = withWorkbook && frame.workbook !== undefined && frame.workbook.kind !== "odfTable"

	if (held !== undefined && (!wantsWorkbook || held.workbook !== undefined)) return held

	if (deck.format === "odp") {
		const document = source.document?.(frame.part)
		const path = objectPathOf(frame.part)
		const object = await readEntry(source, `${path}/content.xml`, slicing)

		if (document === undefined || object === undefined) return undefined

		const streams = new Map<string, Uint8Array>()

		for (const stream of ODP_OBJECT_STREAMS) {
			const bytes = await readEntry(source, `${path}/${stream}`, slicing)

			if (bytes !== undefined) streams.set(stream, bytes)
		}

		const read: SourceChart = { bytes: object, document, object, rels: [], streams, workbook: undefined }

		registry.sources.set(frame.part, read)

		return read
	}

	const bytes = held?.bytes ?? (await readEntry(source, frame.part, slicing))

	if (bytes === undefined) return undefined

	const document = held?.document ?? parsedOrUndefined(bytes)

	if (document === undefined) return undefined

	const rels: ChartRelationship[] = held === undefined ? [] : [...held.rels]

	if (held === undefined)
		for (const relationship of (await source.opc.relationships?.(zipName(frame.part)))?.all ?? [])
			rels.push({
				id: relationship.id,
				type: relationship.type,
				target:
					relationship.external || relationship.partName === undefined
						? relationship.target
						: `/${zipName(relationship.partName)}`,
				external: relationship.external
			})

	let workbook: ChartWorkbook | undefined

	if (wantsWorkbook && frame.workbook !== undefined) {
		const read = await readEntry(source, frame.workbook.part, slicing)

		if (read !== undefined) workbook = { bytes: read, contentType: workbookType(frame.workbook.kind), kind: frame.workbook.kind }
	}

	const read: SourceChart = { bytes, document, object: undefined, rels, streams: new Map(), workbook }

	registry.sources.set(frame.part, read)

	return read
}

function parsedOrUndefined(bytes: Uint8Array): XmlDocument | undefined {
	try {
		return parseXml(bytes)
	} catch (error) {
		if (error instanceof XmlError) return undefined

		throw error
	}
}

function isSeriesEdit(edit: SheetChartEdit): boolean {
	return edit.kind === "series.add" || edit.kind === "series.remove" || edit.kind === "series.move" || edit.kind === "series.set"
}

// Reads what `op` needs before it applies: the chart (and its workbook, for Edit Data and series edits), a new
// workbook's cells, an inserted chart's workbook. What cannot be read leaves nothing prepared: the op is refused when
// it applies.
export async function prepareChartOp(deck: Deck, op: DeckOp, source: ChartPartSource, slicing?: Slicing): Promise<void> {
	if (op.family === "batch") {
		for (const each of op.ops) await prepareChartOp(deck, each, source, slicing)

		return
	}

	if (op.family !== "chart") return

	const registry = registryOf(deck)

	switch (op.kind) {
		case "insert": {
			if (deck.format === "odp" || registry.prepared.has(op) || heldPartOf(op.shape) !== undefined) return
			if (cellCount(op.cells) > MAX_CHART_CELLS) return

			const built = await rowsWorkbook(op.cells, CHART_DATA_SHEET, slicing)

			if (!isRefused(built)) registry.prepared.set(op, { workbook: built })

			return
		}
		case "edit":
		case "setWorkbook": {
			const found = chart(deck, op.target)

			if (isRefused(found)) return

			const frame = found.frame
			const series = op.kind === "edit" && isSeriesEdit(op.edit)
			const base = isHeldChart(frame.part) ? registry.held.get(frame.part) : undefined
			// A frame that makes a chart of its own takes its source's workbook with it (its own copy is written).
			const read =
				base === undefined
					? await readSource(deck, frame, source, slicing, op.kind === "setWorkbook" || series || sharesHome(deck, found))
					: undefined

			if (op.kind === "setWorkbook") {
				if (op.contentType !== XLSX_CONTENT_TYPE || op.workbook.length > MAX_CHART_BYTES) return

				// The source's workbook, while its part still holds it: a version keeping it writes it back after a save.
				const lineage = base?.lineage
				const workbookHome = lineage?.workbookHome

				if (lineage?.original === undefined && workbookHome !== undefined && !registry.workbookHolds.has(workbookHome)) {
					const bytes = await readEntry(source, workbookHome, slicing)
					const kind = lineage?.workbookKind

					if (bytes !== undefined && lineage !== undefined && (kind === "xlsx" || kind === "xls"))
						lineage.original = { bytes, contentType: workbookType(kind), kind }
				}

				const cells = await workbookCells(op.workbook, slicing)

				if (!isRefused(cells)) registry.prepared.set(op, { cells })

				return
			}

			if (!series || deck.format === "odp") return

			const workbook = base === undefined ? read?.workbook : versionWorkbook(base)

			if (workbook?.kind !== "xlsx") return

			const cells = await workbookCells(workbook.bytes, slicing)

			if (!isRefused(cells)) registry.prepared.set(op, { cells })

			return
		}
		case "restore":
			return
	}
}

function heldPartOf(shape: ShapeNode): string | undefined {
	return shape.frame?.kind === "chart" && isHeldChart(shape.frame.part) ? shape.frame.part : undefined
}

function cellCount(rows: readonly (readonly Cell[])[]): number {
	return rows.length * rows.reduce((max, row) => Math.max(max, row.length), 0)
}

// Rows of cells as a one-sheet .xlsx named `sheet`, every number exact and in its own format (Edit Data's workbook of
// an ODP chart's own table, an inserted chart's embedded workbook); refused when it cannot be built.
export async function rowsWorkbook(rows: readonly (readonly Cell[])[], sheet: string, slicing?: Slicing): Promise<Uint8Array | Refused> {
	const built = await cellsWorkbookXlsx(rows, sheet, slicing === undefined ? {} : { slicing })

	return built.ok
		? built.bytes
		: refused(built.refusal.reason === "tooLarge" ? "tooLarge" : "unsupported", built.refusal.detail ?? built.refusal.reason)
}

// ———— A workbook's cells as charts read them: the values the file caches (no formula is computed here).

const EMPTY: ChartCell = { kind: "empty", number: Number.NaN, text: "", format: "General" }

export type WorkbookCells = ChartCells & { readonly sheets: readonly string[] }

function sheetCellsOf(workbook: XlsxWorkbook, model: XlsxSheetModel): ChartSheetCells {
	const store = model.store as SheetStore
	let lastRow = -1
	let lastCol = -1

	for (const block of store.blocks) {
		if (block.rowCount === 0) continue

		lastRow = Math.max(lastRow, block.firstRow + (block.rows[block.rowCount - 1] ?? 0))
		lastCol = Math.max(lastCol, block.colExtent - 1)
	}

	const formatOf = (slot: number): string => {
		const xf = workbook.styles.cellXfs[store.style(slot)]

		return xf === undefined ? "General" : (workbook.styles.numberFormat(xf.numFmtId) ?? "General")
	}
	const options = { date1904: workbook.date1904 }

	return {
		lastRow,
		lastCol,
		hidden: () => false,
		cell(row, col) {
			const slot = store.locate(row, col)

			if (slot < 0) return EMPTY

			const kind = store.kind(slot)
			const value = store.value(slot)
			const format = formatOf(slot)

			switch (kind) {
				case CellKind.NUMBER:
					return { kind: "number", number: value, text: formatValue(value, format, options).text, format }
				case CellKind.SHARED_STRING:
				case CellKind.INLINE_STRING:
				case CellKind.FORMULA_STRING: {
					const text = decodeXstring(
						kind === CellKind.SHARED_STRING ? workbook.sharedStrings.text(value) : store.strings.text(value)
					)

					return text === "" ? EMPTY : { kind: "text", number: Number.NaN, text, format }
				}
				case CellKind.BOOLEAN:
					return { kind: "boolean", number: value === 0 ? 0 : 1, text: value === 0 ? "FALSE" : "TRUE", format }
				case CellKind.ERROR:
					return { kind: "error", number: Number.NaN, text: store.strings.text(value), format }
				default:
					return EMPTY
			}
		}
	}
}

// An embedded workbook's cells (every worksheet read) and its worksheet names in order; refused when it does not
// open.
export async function workbookCells(bytes: Uint8Array, slicing?: Slicing): Promise<WorkbookCells | Refused> {
	const opened = await openXlsx(bytesSource(bytes), slicing === undefined ? {} : { slicing })

	if (!opened.ok) return refused(opened.reason === "tooLarge" ? "tooLarge" : "malformed", `the chart's workbook: ${opened.message}`)

	const workbook = opened.workbook
	const sheets = new Map<string, ChartSheetCells>()
	const worksheets = workbook.sheets.filter(entry => entry.kind === "worksheet")

	for (const entry of worksheets) {
		try {
			sheets.set(entry.name.toUpperCase(), sheetCellsOf(workbook, await workbook.load(entry.id, slicing)))
		} catch {
			// A sheet that does not read reads no cells: the caches naming it stay as they are.
		}
	}

	return {
		sheets: worksheets.map(entry => entry.name),
		names: (name, sheet) => {
			const upper = name.toUpperCase()
			const own = sheet === null ? undefined : worksheets.find(entry => entry.name.toUpperCase() === sheet.toUpperCase())?.id
			const local =
				own === undefined
					? undefined
					: workbook.definedNames.find(entry => entry.sheet === own && entry.name.toUpperCase() === upper)
			const global = workbook.definedNames.find(entry => entry.sheet === null && entry.name.toUpperCase() === upper)

			return (local ?? global)?.formula
		},
		sheet: name => sheets.get(name.toUpperCase()) ?? null
	}
}

// Rows of cells as one sheet named `name`.
export function rowsCells(rows: readonly (readonly Cell[])[], name: string): WorkbookCells {
	const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
	const sheet: ChartSheetCells = {
		lastRow: rows.length - 1,
		lastCol: width - 1,
		hidden: () => false,
		cell(row, col) {
			const value = rows[row]?.[col] ?? null

			if (value === null || value === "") return EMPTY
			if (typeof value === "number")
				return { kind: "number", number: value, text: formatValue(value, "General").text, format: "General" }
			if (isFormatted(value))
				return { kind: "number", number: value.number, text: formatValue(value.number, value.format).text, format: value.format }

			return { kind: "text", number: Number.NaN, text: value, format: "General" }
		}
	}

	return { sheets: [name], names: () => undefined, sheet: requested => (requested.toUpperCase() === name.toUpperCase() ? sheet : null) }
}

// A sheet's cells as rows (an ODP chart's own table for Edit Data, the table written back from a workbook).
function sheetRows(sheet: ChartSheetCells): Cell[][] {
	const rows: Cell[][] = []

	for (let row = 0; row <= sheet.lastRow; row++) {
		const line: Cell[] = []

		for (let col = 0; col <= sheet.lastCol; col++) {
			const cell = sheet.cell(row, col)

			line.push(
				cell.kind === "number"
					? cell.format === "General"
						? cell.number
						: { number: cell.number, format: cell.format }
					: cell.kind === "empty"
						? null
						: cell.text
			)
		}

		rows.push(line)
	}

	return rows
}

// ———— Apply.

interface Found {
	readonly node: SlideNode
	readonly shape: ShapeNode
	readonly frame: ChartFrame
}

function chart(deck: Deck, target: ShapeRef): Found | Refused {
	const node = deck.nodes.get(target.slide)

	if (node === undefined) return refused("notFound", `slide ${String(target.slide)} is not parsed`)

	const shape = findShape(node.shapes, target.id)?.shape

	if (shape === undefined) return refused("notFound", `shape ${String(target.id)}`)
	if (shape.frame?.kind !== "chart") return refused("unsupported", `shape ${String(target.id)} is not a chart`)
	if (shape.lock !== undefined) return refused("locked", shape.lock)

	return { node, shape, frame: shape.frame }
}

function newVersion(
	deck: Deck,
	lineage: ChartLineage,
	parts: { readonly document: XmlDocument; readonly bytes: Uint8Array; readonly workbook?: ChartWorkbook; readonly object?: Uint8Array },
	pristine = false
): HeldChart {
	const registry = registryOf(deck)
	const name = `${HELD_CHART_PREFIX}${String(registry.next++)}`
	const version: HeldChart = {
		name,
		lineage,
		document: parts.document,
		bytes: parts.bytes,
		workbook: parts.workbook,
		object: parts.object,
		pristine
	}

	registry.held.set(name, version)

	return version
}

// Whether a frame naming a package chart is not its home's: a duplicated slide's copy, which reads its source slide's
// markup until a save writes it (pptx; the save copies the chart for it), or a frame whose object another frame names
// too (ODP: a duplicate's frame names its source's object, before and after a save). Its first edit makes a chart of
// its own, so the other frame's chart is never written.
function sharesHome(deck: Deck, found: Found): boolean {
	const src = found.shape.src

	if (deck.format !== "odp") return src?.format === "pptx" && partKey(src.part) !== partKey(found.node.part)

	const path = objectPathOf(found.frame.part)
	const elsewhere = (shapes: readonly ShapeNode[]): boolean =>
		shapes.some(
			shape =>
				(shape !== found.shape &&
					shape.frame?.kind === "chart" &&
					!isHeldChart(shape.frame.part) &&
					objectPathOf(shape.frame.part) === path) ||
				(shape.children !== undefined && elsewhere(shape.children))
		)

	for (const ref of [...deck.slides, ...deck.layouts, ...deck.masters]) {
		const node = deck.nodes.get(ref)

		if (node !== undefined && elsewhere(node.shapes)) return true
	}

	return false
}

// The version a frame names: a held one, or the source chart as prepare read it (its lineage and pristine version
// made on first use: an undo past a save that rewrote its home writes the source's bytes back). A frame that shares
// its home (sharesHome) gets a lineage of its own instead, with no home yet.
function baseVersion(deck: Deck, found: Found): HeldChart | Refused {
	const registry = registryOf(deck)
	const frame = found.frame

	if (isHeldChart(frame.part)) return registry.held.get(frame.part) ?? refused("stale", `the chart version ${frame.part} is not held`)

	const home = deck.format === "odp" ? objectPathOf(frame.part) : frame.part
	const source = registry.sources.get(frame.part)

	if (sharesHome(deck, found)) {
		if (source === undefined) return refused("notFound", `the chart ${frame.part} was not read`)

		const own: ChartLineage = {
			format: deck.format === "odp" ? "odp" : "pptx",
			home: undefined,
			workbookHome: undefined,
			workbookKind: frame.workbook?.kind,
			rels: source.rels,
			streams: source.streams,
			original: source.workbook,
			owner: undefined,
			copy: true
		}

		return newVersion(deck, own, {
			document: source.document,
			bytes: source.bytes,
			...(source.object === undefined ? {} : { object: source.object })
		})
	}

	const owner = chartOwner(found.node.ref, found.shape.id)
	const lineage = registry.lineages.get(home)

	for (const version of registry.held.values())
		if (version.pristine && version.lineage === lineage && lineage !== undefined) return withOriginal(version, source)

	if (source === undefined) return refused("notFound", `the chart ${frame.part} was not read`)

	const made: ChartLineage = lineage ?? {
		format: deck.format === "odp" ? "odp" : "pptx",
		home,
		workbookHome: frame.workbook?.kind === "odfTable" ? undefined : frame.workbook?.part,
		workbookKind: frame.workbook?.kind,
		rels: source.rels,
		streams: source.streams,
		original: source.workbook,
		owner
	}

	registry.lineages.set(home, made)

	const created = newVersion(
		deck,
		made,
		{ document: source.document, bytes: source.bytes, ...(source.object === undefined ? {} : { object: source.object }) },
		true
	)

	if (!registry.holds.has(home)) registry.holds.set(home, created.name)

	return created
}

// The lineage keeps the source's workbook once a read of it is at hand.
function withOriginal(version: HeldChart, source: SourceChart | undefined): HeldChart {
	if (version.lineage.original === undefined && source?.workbook !== undefined) version.lineage.original = source.workbook

	return version
}

function frameOf(version: HeldChart): ChartFrame {
	const kind = versionWorkbook(version)?.kind ?? version.lineage.workbookKind

	return {
		kind: "chart",
		part: version.name,
		...(kind === undefined ? {} : { workbook: { part: version.lineage.workbookHome ?? `${version.name}#workbook`, kind } })
	}
}

// Points the frame at `frame`; its inverse points it back at the version it named (a package chart's pristine
// version, so an undo past a save that rewrote the chart's home shows and writes the source's chart again).
function point(
	found: Found,
	op: Extract<ChartOp, { readonly target: ShapeRef }>,
	frame: ChartFrame,
	base?: HeldChart
): ApplyResult<ChartOp> {
	const prior = isHeldChart(found.frame.part) || base === undefined ? found.frame : frameOf(base)
	const back: ChartOp = { family: "chart", kind: "restore", target: op.target, frame: prior }

	found.shape.frame = frame
	found.node.revision++

	return { kind: "applied", inverse: { ops: [back], bytes: 0 }, op }
}

// The host series edits read references through: the workbook's cells, its first sheet the chart's own.
function hostOf(cells: WorkbookCells | undefined): ChartFormulaHost {
	if (cells === undefined)
		return {
			reference: () => {
				throw new ChartEditRefused("formula", "the chart's workbook was not read")
			},
			numeric: () => false
		}

	return cellsFormulaHost(cells, cells.sheets, cells.sheets[0] ?? CHART_DATA_SHEET)
}

function parsed(bytes: Uint8Array): XmlDocument | Refused {
	return parsedOrUndefined(bytes) ?? refused("malformed", "a chart part")
}

function edited<T>(make: () => T): T | Refused {
	try {
		return make()
	} catch (error) {
		if (error instanceof ChartEditRefused) return refused(error.reason === "tooLarge" ? "tooLarge" : "unsupported", error.message)
		if (error instanceof ChartRefused) return refused("unsupported", error.message)

		throw error
	}
}

// The version an op made before (a redo of the op as applied), pointed at again.
function redone(deck: Deck, found: Found, op: Extract<ChartOp, { readonly target: ShapeRef }>): ApplyResult<ChartOp> | undefined {
	const registry = registryOf(deck)
	const name = registry.made.get(op)
	const version = name === undefined ? undefined : registry.held.get(name)

	return version === undefined ? undefined : point(found, op, frameOf(version))
}

function made(
	deck: Deck,
	found: Found,
	op: Extract<ChartOp, { readonly target: ShapeRef }>,
	version: HeldChart,
	base: HeldChart
): ApplyResult<ChartOp> {
	const result = point(found, op, frameOf(version), base)

	registryOf(deck).made.set(op, version.name)

	return result
}

function edit(deck: Deck, op: Extract<ChartOp, { kind: "edit" }>): ApplyResult<ChartOp> {
	const found = chart(deck, op.target)

	if (isRefused(found)) return found

	const again = redone(deck, found, op)

	if (again !== undefined) return again
	if (deck.format === "odp" && isSeriesEdit(op.edit)) return refused("unsupported", "a series edit of a chart's own table")

	const base = baseVersion(deck, found)

	if (isRefused(base)) return base

	const bytes = edited(() => applyChartEdit(base.document, op.edit, hostOf(registryOf(deck).prepared.get(op)?.cells)))

	if (isRefused(bytes)) return bytes

	const document = parsed(bytes)

	if (isRefused(document)) return document

	if (deck.format !== "odp") return made(deck, found, op, newVersion(deck, base.lineage, { document, bytes, ...workbookOf(base) }), base)

	if (base.object === undefined) return refused("unsupported", "a chart object that does not read")

	// The object is patched as core/ods/charts reads it (its own references, not the reader's laid-out table): the same
	// edit made on that reading says what the object becomes.
	const object = edited(() => {
		const reading = objectReading(base.object as Uint8Array)
		const was = reading === undefined ? null : readChartInfo(reading)
		const now = reading === undefined ? null : readChartInfo(parseXml(applyChartEdit(reading, op.edit, hostOf(undefined))))

		if (was === null || now === null) throw new ChartRefused("a chart object that does not read")

		return patchObject(base.object as Uint8Array, was, now, ODP_LOCAL_TABLE)
	})

	if (isRefused(object)) return object

	return made(deck, found, op, newVersion(deck, base.lineage, { document, bytes, object }), base)
}

// An ODP chart object as DrawingML, read as core/ods/charts reads one.
function objectReading(object: Uint8Array): XmlDocument | undefined {
	const document = parsedOrUndefined(object)
	const chart = document === undefined ? null : chartOf(document)

	return chart === null ? undefined : parsedOrUndefined(encodeUtf8(translateChart(chart.chart, chart.styles).markup))
}

function workbookOf(version: HeldChart): { readonly workbook?: ChartWorkbook } {
	return version.workbook === undefined ? {} : { workbook: version.workbook }
}

function setWorkbook(deck: Deck, op: Extract<ChartOp, { kind: "setWorkbook" }>): ApplyResult<ChartOp> {
	const found = chart(deck, op.target)

	if (isRefused(found)) return found

	const again = redone(deck, found, op)

	if (again !== undefined) return again
	if (op.contentType !== XLSX_CONTENT_TYPE) return refused("unsupported", `a chart workbook of type ${op.contentType}`)
	if (op.workbook.length === 0 || op.workbook.length > MAX_CHART_BYTES) return refused("tooLarge", "the chart's workbook")

	const cells = registryOf(deck).prepared.get(op)?.cells

	if (cells === undefined) return refused("malformed", "the chart's workbook was not read")

	const base = baseVersion(deck, found)

	if (isRefused(base)) return base

	if (deck.format === "odp") {
		const written = objectWithData(base, cells)

		if (isRefused(written)) return written

		return made(
			deck,
			found,
			op,
			newVersion(deck, base.lineage, { document: written.document, bytes: base.bytes, object: written.object }),
			base
		)
	}

	const fitted = edited(() => fittedToData(base, cells))

	if (isRefused(fitted)) return fitted

	const refreshed = refreshChartCaches(fitted.bytes, cells, {}, fitted.document)
	const document = refreshed.changed ? parsed(refreshed.bytes) : (fitted.document ?? parsed(fitted.bytes))

	if (isRefused(document)) return document

	const workbook: ChartWorkbook = { bytes: op.workbook, contentType: op.contentType, kind: "xlsx" }

	return made(deck, found, op, newVersion(deck, xlsxLineage(base.lineage), { document, bytes: refreshed.bytes, workbook }), base)
}

// The lineage an .xlsx version of a chart is in: its own, or for a chart whose data is an embedded .xls (an OLE
// object) a new one with no home, as an inserted chart's: the .xlsx and the chart naming it are written into new parts,
// and the .xls chart's lineage keeps the parts it was in (an undo past the save points the frame back at them).
function xlsxLineage(lineage: ChartLineage): ChartLineage {
	if (lineage.workbookKind !== "xls") return lineage

	return {
		format: "pptx",
		home: undefined,
		workbookHome: undefined,
		workbookKind: "xlsx",
		rels: lineage.rels,
		streams: lineage.streams,
		original: undefined,
		owner: undefined,
		...(lineage.copy === true ? { copy: true as const } : {})
	}
}

const EDITABLE_TYPES: ReadonlySet<string> = new Set(["column", "bar", "line", "area", "pie", "doughnut", "scatter"])

function editableType(type: string): type is ChartEditType {
	return EDITABLE_TYPES.has(type)
}

// ———— Edit Data's range: a chart over one table of the workbook follows the table's size.

interface Block {
	readonly sheet: string
	// The series are the table's rows (else its columns). Lines below are along the series: with `rows` a "row" is a
	// column of the sheet and a "column" a row (flip).
	readonly rows: boolean
	// The table's first row (the series' names, else their first value) and column (the categories, else the first
	// series), and the series' first value row.
	readonly top: number
	readonly left: number
	readonly first: number
	readonly names: boolean
	readonly categories: boolean
	readonly series: number
}

function single(formula: string | null, names: WorkbookCells["names"]): { readonly sheet: string; readonly range: SheetRange } | undefined {
	if (formula === null) return undefined

	const areas = chartAreas(formula, names)

	return areas?.length === 1 ? areas[0] : undefined
}

// A range with rows and columns swapped (its own inverse).
function flip(range: SheetRange, rows: boolean): SheetRange {
	return rows ? { startRow: range.startCol, startCol: range.startRow, endRow: range.endCol, endCol: range.endRow } : range
}

// The table a chart's one plot reads when its series are its columns, side by side over the same rows, their names
// in the row above and their categories in the column to the left (as Insert ▸ Chart and PowerPoint lay one out), or
// likewise its rows, their names in the column to the left and their categories in the row above.
function tableOf(info: ChartInfo, cells: WorkbookCells): Block | undefined {
	return tableAlong(info, cells, false) ?? tableAlong(info, cells, true)
}

function tableAlong(info: ChartInfo, cells: WorkbookCells, rows: boolean): Block | undefined {
	const plot = info.plots.length === 1 ? info.plots[0] : undefined

	if (plot === undefined || plot.series.length === 0) return undefined

	let block: Block | undefined
	let extent: SheetRange | undefined

	for (const [index, series] of plot.series.entries()) {
		const values = single(series.values, cells.names)
		const name = series.nameRef === null ? undefined : single(series.nameRef, cells.names)
		const categories = series.categories === null ? undefined : single(series.categories, cells.names)

		if (values === undefined) return undefined

		const range = flip(values.range, rows)
		const nameRange = name === undefined ? undefined : flip(name.range, rows)
		const categoryRange = categories === undefined ? undefined : flip(categories.range, rows)

		if (range.startCol !== range.endCol) return undefined
		if (series.nameRef !== null && (name === undefined || name.sheet !== values.sheet)) return undefined
		if (series.categories !== null && (categories === undefined || categories.sheet !== values.sheet)) return undefined

		if (block === undefined) {
			const left = categoryRange?.startCol ?? range.startCol

			if (categoryRange !== undefined && (categoryRange.startCol !== range.startCol - 1 || categoryRange.endCol !== left))
				return undefined

			extent = range
			block = {
				sheet: values.sheet,
				rows,
				top: nameRange === undefined ? range.startRow : range.startRow - 1,
				left,
				first: range.startRow,
				names: nameRange !== undefined,
				categories: categoryRange !== undefined,
				series: plot.series.length
			}
		}

		if (
			values.sheet !== block.sheet ||
			range.startRow !== extent?.startRow ||
			range.endRow !== extent.endRow ||
			range.startCol !== (block.categories ? block.left + 1 : block.left) + index ||
			(nameRange !== undefined && (nameRange.startRow !== block.top || nameRange.startCol !== range.startCol)) ||
			(categoryRange !== undefined && (categoryRange.startRow !== extent.startRow || categoryRange.endRow !== extent.endRow))
		)
			return undefined
	}

	return block
}

// The chart with its series made the table's columns (or rows) as the workbook now holds them (the table starting
// where it did, ending at the sheet's last cell): points and series added or taken away, each series' references set
// again. The chart as it was when it reads no such table.
function fittedToData(
	chart: { readonly document: XmlDocument; readonly bytes: Uint8Array },
	cells: WorkbookCells
): { readonly bytes: Uint8Array; readonly document?: XmlDocument } {
	const info = readChartInfo(chart.document)
	const block = info === null ? undefined : tableOf(info, cells)
	const sheet = block === undefined ? null : cells.sheet(block.sheet)
	const plot = info?.plots[0]

	if (block === undefined || sheet === null || plot === undefined || !editableType(plot.type)) return { bytes: chart.bytes }

	const rows = block.rows
	const lastRow = Math.max(rows ? sheet.lastCol : sheet.lastRow, block.first)
	const lastCol = Math.max(rows ? sheet.lastRow : sheet.lastCol, block.categories ? block.left + 1 : block.left)
	const range = flip({ startRow: block.top, startCol: block.left, endRow: lastRow, endCol: lastCol }, rows)
	const source = chartSource(block.sheet, range, { byColumns: !rows, nameLine: block.names, categoryLine: block.categories }, plot.type)
	const edits: SheetChartEdit[] = []

	for (let index = 0; index < source.series.length; index++) {
		const line = source.series[index] as (typeof source.series)[number]
		const reference = (text: string | null): string | null => (text === null ? null : `=${text}`)

		if (index < plot.series.length)
			edits.push({
				kind: "series.set",
				series: index,
				id: (plot.series[index] as (typeof plot.series)[number]).idx,
				values: `=${line.values}`,
				...(block.categories ? { categories: reference(source.categories) } : {}),
				...(block.names ? { name: reference(line.name) } : {})
			})
		else
			edits.push({
				kind: "series.add",
				plot: 0,
				name: reference(line.name),
				categories: reference(source.categories),
				values: `=${line.values}`
			})
	}

	for (let index = plot.series.length - 1; index >= source.series.length; index--)
		edits.push({ kind: "series.remove", series: index, id: (plot.series[index] as (typeof plot.series)[number]).idx })

	const host = hostOf(cells)
	let document = chart.document
	let bytes = chart.bytes

	for (const edit of edits) {
		bytes = applyChartEdit(document, edit, host)
		document = parseXml(bytes)
	}

	return edits.length === 0 ? { bytes } : { bytes, document }
}

function restore(deck: Deck, op: Extract<ChartOp, { kind: "restore" }>): ApplyResult<ChartOp> {
	const found = chart(deck, op.target)

	if (isRefused(found)) return found
	if (isHeldChart(op.frame.part) && registryOf(deck).held.get(op.frame.part) === undefined)
		return refused("stale", `the chart version ${op.frame.part} is not held`)

	return point(found, op, op.frame)
}

// ———— Insert.

// A new chart's DrawingML over `cells` (its first row and column the names, as Excel reads a selection), its caches
// read from them; `external`: it names its embedded workbook (pptx).
function newChart(
	cells: readonly (readonly Cell[])[],
	type: InsertOp["type"],
	grouping: InsertOp["grouping"],
	sheetName: string,
	external: boolean
): { readonly bytes: Uint8Array; readonly cells: WorkbookCells } | Refused {
	const rows = cells.length
	const cols = cells.reduce((max, row) => Math.max(max, row.length), 0)

	if (rows < 1 || cols < 1) return refused("malformed", "a chart without cells")
	if (rows * cols > MAX_CHART_CELLS) return refused("tooLarge", `${String(rows)} × ${String(cols)} cells`)

	const read = rowsCells(cells, sheetName)
	const sheet = read.sheet(sheetName) as ChartSheetCells
	const range: SheetRange = { startRow: 0, startCol: 0, endRow: rows - 1, endCol: cols - 1 }
	const layout = chartLayout(sheet, range, type)
	const source = chartSource(sheetName, range, layout, type)

	if (source.series.length === 0) return refused("malformed", "a chart without a series")

	const first = layout.byColumns ? sheet.cell(layout.nameLine ? 1 : 0, 0) : sheet.cell(0, layout.nameLine ? 1 : 0)
	let bytes = newChartPart(source, type, grouping, {
		strict: false,
		date1904: false,
		numericCategories: layout.categoryLine && first.kind === "number"
	})

	if (external) bytes = withExternalData(bytes)

	return { bytes: refreshChartCaches(bytes, read).bytes, cells: read }
}

// c:externalData at the chart space's end (newChartPart writes nothing after c:chart).
function withExternalData(bytes: Uint8Array): Uint8Array {
	const document = parseXml(bytes)
	const editor = new XmlEditor(document)

	editor.append(document.documentElement(), `<c:externalData r:id="${INSERTED_WORKBOOK_ID}"><c:autoUpdate val="0"/></c:externalData>`)

	return editor.serialize()
}

function insert(deck: Deck, op: InsertOp, context: ApplyContext): ApplyResult<ChartOp> {
	if (op.shape.xfrm === undefined) return refused("malformed", "a chart needs a box")

	const registry = registryOf(deck)
	// A redo names the version the op made.
	const again = heldPartOf(op.shape)
	let version = again === undefined ? undefined : registry.held.get(again)

	if (again !== undefined && version === undefined) return refused("stale", `the chart version ${again} is not held`)

	if (version === undefined) {
		const odp = deck.format === "odp"
		const chartMade = newChart(op.cells, op.type, op.grouping, odp ? ODP_LOCAL_TABLE : CHART_DATA_SHEET, !odp)

		if (isRefused(chartMade)) return chartMade

		const document = parsed(chartMade.bytes)

		if (isRefused(document)) return document

		const lineage: ChartLineage = {
			format: odp ? "odp" : "pptx",
			home: undefined,
			workbookHome: undefined,
			workbookKind: odp ? "odfTable" : "xlsx",
			rels: [],
			streams: new Map(),
			original: undefined,
			owner: undefined
		}

		if (odp) {
			const object = newObject(document, op.cells, op.shape)

			if (isRefused(object)) return object

			version = newVersion(deck, lineage, { document, bytes: chartMade.bytes, object })
		} else {
			const workbook = registry.prepared.get(op)?.workbook

			if (workbook === undefined) return refused("failed", "the chart's workbook was not made")

			version = newVersion(deck, lineage, {
				document,
				bytes: chartMade.bytes,
				workbook: { bytes: workbook, contentType: XLSX_CONTENT_TYPE, kind: "xlsx" }
			})
		}
	}

	const shape: ShapeNode = { ...op.shape, kind: "frame", frame: frameOf(version) }
	const result = applyShape.apply(deck, { family: "shape", kind: "insert", slide: op.slide, shape }, context)

	if (result.kind === "refused") return result

	const id = result.op.family === "shape" && result.op.kind === "insert" ? result.op.shape.id : op.shape.id

	return { kind: "applied", inverse: result.inverse, op: { ...op, shape: { ...shape, id } } }
}

// ———— ODP chart objects.

const OFFICE_NS = "urn:oasis:names:tc:opendocument:xmlns:office:1.0"
const TABLE_NS = "urn:oasis:names:tc:opendocument:xmlns:table:1.0"
const TEXT_NS = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
const NO_THEME = drawingTheme(undefined, () => undefined)

function cm(emu: number): string {
	return `${String(Math.round(emu / 360) / 1000)}cm`
}

// The object (its content.xml) of an inserted ODP chart: the chart as core/ods/convert/chart writes one, reading its
// own table (core/odp/write/chartObject odpLocalTable, the one writer of a chart's own table).
function newObject(document: XmlDocument, rows: readonly (readonly Cell[])[], shape: ShapeNode): Uint8Array | Refused {
	const xfrm = shape.xfrm

	if (xfrm === undefined) return refused("malformed", "a chart needs a box")

	const object = chartObject(document, NO_THEME, ODP_LOCAL_TABLE, cm(xfrm.cx), cm(xfrm.cy))

	if (object === null) return refused("unsupported", "a chart the object cannot hold")

	const end = object.content.lastIndexOf("</chart:chart>")

	if (end < 0) return refused("failed", "the chart object has no chart")

	return encodeUtf8(`${object.content.slice(0, end)}${odpLocalTable(rows)}${object.content.slice(end)}`)
}

// The chart's own table:table in an object's content.xml (the first table:table under office:chart).
function ownTable(document: XmlDocument): number {
	for (let node = 0; node < document.count; node++)
		if (document.kind(node) === NodeKind.Element && document.localName(node) === "table" && document.prefix(node) === "table")
			return node

	return -1
}

// The object with its own table set to the first sheet of `cells` (its formatted numbers' styles written with it, a
// table's own styles of before dropped) and the rows written.
function withTableCells(object: Uint8Array, cells: WorkbookCells): { readonly object: Uint8Array; readonly rows: Cell[][] } | Refused {
	const sheet = cells.sheet(cells.sheets[0] ?? "")

	if (sheet === null) return refused("malformed", "a workbook without a sheet")
	if ((sheet.lastRow + 1) * (sheet.lastCol + 1) > MAX_CHART_CELLS) return refused("tooLarge", "the chart's table")

	const rows = sheetRows(sheet)
	const document = parsed(object)

	if (isRefused(document)) return document

	const table = ownTable(document)

	if (table < 0) return refused("unsupported", "a chart object without its own table")

	const editor = new XmlEditor(document)
	const name = document.attribute(table, "table:name") ?? ODP_LOCAL_TABLE
	const styles = localTableStyles(rows)
	const root = document.documentElement()
	let automatic = -1

	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		if (document.localName(child) === "automatic-styles") automatic = child
		if (document.localName(child) === "body" && automatic < 0) {
			if (styles.markup !== "") editor.insertBefore(child, `<office:automatic-styles>${styles.markup}</office:automatic-styles>`)

			break
		}
	}

	if (automatic >= 0) {
		const axes = axisStyles(document, automatic, editor, rows, styles)

		for (let child = document.firstChildElement(automatic); child >= 0; child = document.nextSiblingElement(child))
			if (ownTableStyle(document.attribute(child, "style:name") ?? "")) editor.remove(child)

		if (styles.markup !== "" || axes !== "") editor.append(automatic, `${styles.markup}${axes}`)
	}

	editor.replace(
		table,
		odpLocalTable(rows, name, ` xmlns:table="${TABLE_NS}" xmlns:office="${OFFICE_NS}" xmlns:text="${TEXT_NS}"`, styles)
	)

	return { object: editor.serialize(), rows }
}

// The format a column of a table's rows shows: its first number's, General when that has none.
function columnFormat(rows: readonly (readonly Cell[])[], col: number): string {
	for (let row = 1; row < rows.length; row++) {
		const cell = rows[row]?.[col] ?? null

		if (typeof cell === "number") return "General"
		if (isFormatted(cell)) return cell.format
	}

	return "General"
}

// Axes linked to their cells' number format state the format their cells now have (the categories' column for the x
// axis, the first series' for the y axis): a chart's own table is no source an ODF consumer links a format to, as
// LibreOffice reads it. Each such axis gets a style of its own (a copy of its style, `ltA…`), its markup returned for
// the automatic styles; an axis whose format is stated in the object keeps its style.
function axisStyles(
	document: XmlDocument,
	automatic: number,
	editor: XmlEditor,
	rows: readonly (readonly Cell[])[],
	styles: ReturnType<typeof localTableStyles>
): string {
	const byName = new Map<string, number>()

	for (let child = document.firstChildElement(automatic); child >= 0; child = document.nextSiblingElement(child)) {
		const name = document.attribute(child, "style:name")

		if (name !== undefined && document.attribute(child, "style:family") === "chart") byName.set(name, child)
	}

	let markup = ""
	let count = 0

	for (let node = 0; node < document.count; node++) {
		if (document.kind(node) !== NodeKind.Element || document.prefix(node) !== "chart" || document.localName(node) !== "axis") continue

		const dimension = document.attribute(node, "chart:dimension")
		const name = document.attribute(node, "chart:style-name")
		const style = name === undefined ? undefined : byName.get(name)

		if ((dimension !== "x" && dimension !== "y") || name === undefined || style === undefined) continue

		const bytes = document.raw(style)
		const raw = decodeUtf8(bytes, 0, bytes.length)
		const linked = !/chart:link-data-style-to-source="false"/u.test(raw)

		if (!linked && !ownTableStyle(name)) continue

		const format = columnFormat(rows, dimension === "x" ? 0 : 1)
		const data = styles.cells.get(format)?.dataStyle
		const own = `${AXIS_STYLE}${String(++count)}`
		const unlinked = data === undefined ? "" : ' chart:link-data-style-to-source="false"'
		let copy = raw
			.replace(/\sstyle:data-style-name="[^"]*"/u, "")
			.replace(/\schart:link-data-style-to-source="[^"]*"/u, "")
			.replace(/style:name="[^"]*"/u, `style:name="${own}"${data === undefined ? "" : ` style:data-style-name="${data}"`}`)

		if (copy.includes("<style:chart-properties")) copy = copy.replace(/<style:chart-properties/u, `<style:chart-properties${unlinked}`)
		else if (unlinked !== "")
			copy = copy.endsWith("/>")
				? `${copy.slice(0, -2)}><style:chart-properties${unlinked}/></style:style>`
				: copy.replace(/<\/style:style>$/u, `<style:chart-properties${unlinked}/></style:style>`)

		markup += copy
		editor.setAttribute(node, "chart:style-name", own)
	}

	return markup
}

// The formats of an object's table cells by cell style name (table:style-name → its data style as a format code).
function cellFormats(document: XmlDocument): (style: string | undefined) => string {
	let sheet: OdfStyleSheet | undefined
	const known = new Map<string, string>()

	return style => {
		if (style === undefined) return "General"

		let format = known.get(style)

		if (format === undefined) {
			sheet ??= new OdfStyleSheet(undefined, {
				document,
				namespaces: new Namespaces(document, { lenient: true }),
				root: document.documentElement(),
				bodyStart: -1,
				sliced: false
			})

			const data = sheet.style("table-cell", style, "content")?.attributes.get("style:data-style-name")
			const dataStyle = data === undefined ? undefined : sheet.dataStyle(data, "content")

			format = dataStyle === undefined ? "General" : dataStyleCode(sheet, dataStyle, "content").code || "General"
			known.set(style, format)
		}

		return format
	}
}

// An ODP object's own table as rows (Edit Data opens them as a one-sheet workbook): numbers exact, in the format of
// their cell's data style; a date its serial day (as a sheet holds one).
export function objectRows(object: Uint8Array): Cell[][] | Refused {
	const document = parsed(object)

	if (isRefused(document)) return document

	const table = ownTable(document)

	if (table < 0) return refused("unsupported", "a chart object without its own table")

	const formatOf = cellFormats(document)
	const rows: Cell[][] = []
	const read = (cell: number): Cell => {
		const type = document.attribute(cell, "office:value-type")
		const number =
			type === "float" || type === "percentage" || type === "currency"
				? Number(document.attribute(cell, "office:value"))
				: type === "date"
					? dateValue(document.attribute(cell, "office:date-value") ?? "") - NULL_DATE_1899
					: undefined

		if (number === undefined) return document.textContent(cell) || null
		if (!Number.isFinite(number)) return null

		const format = formatOf(document.attribute(cell, "table:style-name"))
		const own = format !== "General" ? format : type === "percentage" ? "0%" : type === "date" ? "yyyy-mm-dd" : "General"

		return own === "General" ? number : { number, format: own }
	}
	const visit = (node: number, depth: number): void => {
		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const local = document.localName(child)

			if (local === "table-row") {
				const line: Cell[] = []
				const repeat = Math.min(Number(document.attribute(child, "table:number-rows-repeated") ?? "1") || 1, MAX_CHART_CELLS)

				for (let cell = document.firstChildElement(child); cell >= 0; cell = document.nextSiblingElement(cell)) {
					if (document.localName(cell) !== "table-cell" && document.localName(cell) !== "covered-table-cell") continue

					const times = Math.min(Number(document.attribute(cell, "table:number-columns-repeated") ?? "1") || 1, 1024)
					const value = read(cell)

					for (let k = 0; k < times && line.length < 1024; k++) line.push(value)
				}

				for (let k = 0; k < repeat && rows.length * Math.max(1, line.length) < MAX_CHART_CELLS; k++) rows.push([...line])
			} else if (depth < 4) visit(child, depth + 1)
		}
	}

	visit(table, 0)

	// Trailing empty cells and rows are no data.
	for (const line of rows) while (line.length > 0 && line[line.length - 1] === null) line.pop()
	while (rows.length > 0 && (rows[rows.length - 1] as Cell[]).length === 0) rows.pop()

	return rows
}

// Edit Data of an ODP chart: the object's table set to the workbook's first sheet, the object's series fitted to it
// (fittedToData on the object's own reading, written by patchObject: rows and series added or taken away), and the
// chart drawn from the object's references with their caches read from the table.
function objectWithData(base: HeldChart, cells: WorkbookCells): { readonly object: Uint8Array; readonly document: XmlDocument } | Refused {
	if (base.object === undefined) return refused("unsupported", "a chart object that does not read")

	const written = withTableCells(base.object, cells)

	if (isRefused(written)) return written

	const table = rowsCells(written.rows, ODP_LOCAL_TABLE)

	return edited(() => {
		const reading = objectReading(written.object)
		const was = reading === undefined ? null : readChartInfo(reading)

		if (reading === undefined || was === null) throw new ChartRefused("a chart object that does not read")

		const fitted = fittedToData({ document: reading, bytes: reading.bytes }, table)
		const now = fitted.document === undefined ? was : readChartInfo(fitted.document)

		if (now === null) throw new ChartRefused("a chart object that does not read")

		const object = fitted.document === undefined ? written.object : patchObject(written.object, was, now, ODP_LOCAL_TABLE)
		const refreshed = refreshChartCaches(fitted.bytes, table, {}, fitted.document ?? reading)

		return { object, document: refreshed.changed ? parseXml(refreshed.bytes) : (fitted.document ?? reading) }
	})
}

// ———— The family.

function apply(deck: Deck, op: ChartOp, context: ApplyContext): ApplyResult<ChartOp> {
	switch (op.kind) {
		case "insert":
			return insert(deck, op, context)
		case "edit":
			return edit(deck, op)
		case "setWorkbook":
			return setWorkbook(deck, op)
		case "restore":
			return restore(deck, op)
	}
}

export const applyChart: ApplyFamily<ChartOp> = {
	apply: (deck, op, context) => apply(deck, op, context),
	touches: (op): readonly Touch[] =>
		op.kind === "insert"
			? applyShape.touches({ family: "shape", kind: "insert", slide: op.slide, shape: op.shape })
			: [{ kind: "shape", slide: op.target.slide, shape: op.target.id, dirt: { kind: "node" } }]
}

// What the page's Chart tab and Edit Data read of a chart frame: what the chart holds (null when it does not read)
// and, asked for, its data as a workbook (pptx: the embedded .xlsx, or the .xls the first Edit Data turns into an
// .xlsx; ODP: the object's own table as a one-sheet .xlsx).
export interface ChartData {
	readonly info: ChartInfo | null
	// Edit Data can open the chart's data (an embedded workbook, an ODP chart's own table; not a linked file).
	readonly data: boolean
	readonly workbook?: { readonly bytes: Uint8Array; readonly kind: "xlsx" | "xls" }
}

// A frame's chart for the page: a held version, or the package's chart read now (with its workbook).
export async function chartDataOf(
	deck: Deck,
	frame: ChartFrame,
	source: ChartPartSource,
	options: { readonly workbook?: boolean } = {},
	slicing?: Slicing
): Promise<ChartData | Refused> {
	const registry = registryOf(deck)
	const held = isHeldChart(frame.part) ? registry.held.get(frame.part) : undefined

	if (isHeldChart(frame.part) && held === undefined) return refused("stale", `the chart version ${frame.part} is not held`)

	const read = held === undefined ? await readSource(deck, frame, source, slicing, options.workbook === true) : undefined
	const document = held?.document ?? read?.document
	const data =
		deck.format === "odp"
			? (held?.object ?? read?.object) !== undefined
			: held === undefined
				? frame.workbook !== undefined && frame.workbook.kind !== "odfTable"
				: held.workbook !== undefined || held.lineage.workbookHome !== undefined

	if (document === undefined) return { info: null, data: false }

	const info = readChartInfo(document)

	if (options.workbook !== true) return { info, data }

	if (deck.format === "odp") {
		const object = held?.object ?? read?.object

		if (object === undefined) return { info, data }

		const rows = objectRows(object)

		if (isRefused(rows)) return rows

		const built = await rowsWorkbook(rows, CHART_DATA_SHEET, slicing)

		return isRefused(built) ? built : { info, data, workbook: { bytes: built, kind: "xlsx" } }
	}

	const workbook = held === undefined ? read?.workbook : (versionWorkbook(held) ?? (await originalWorkbook(deck, held, source, slicing)))

	return workbook === undefined || workbook.kind === "odfTable"
		? { info, data }
		: { info, data, workbook: { bytes: workbook.bytes, kind: workbook.kind } }
}

// A held version's workbook when it has none of its own: the source's, read while its part still holds it.
async function originalWorkbook(
	deck: Deck,
	version: HeldChart,
	source: ChartPartSource,
	slicing: Slicing | undefined
): Promise<ChartWorkbook | undefined> {
	const lineage = version.lineage
	const home = lineage.workbookHome
	const kind = lineage.workbookKind

	if (lineage.original !== undefined || home === undefined || registryOf(deck).workbookHolds.has(home)) return lineage.original
	if (kind !== "xlsx" && kind !== "xls") return undefined

	const bytes = await readEntry(source, home, slicing)

	if (bytes !== undefined) lineage.original = { bytes, contentType: workbookType(kind), kind }

	return lineage.original
}
