import { appendAll, spliceAll } from "../../arrays"
import { partKey } from "../../opc/partNames"
import type { Relationship } from "../../opc/relationships"
import type { SheetId, SheetRefusal } from "../../sheet/protocol"
import { sameSheet } from "../../sheet/refs/formulaRefs"
import {
	CellKind,
	type XlsxDefinedName,
	type XlsxFormula,
	type XlsxSheetEntry,
	type XlsxSheetModel,
	type XlsxSheetView,
	type XlsxWorkbookModel
} from "../model/types"
import { readView } from "../read/worksheet"
import { XmlEditor, XmlError, decodeUtf8, encodeUtf8, parseXml } from "../../xml/index"
import { ChangeLog } from "../model/changes"
import { FormulaTable } from "../model/formulas"
import type { RowBlock, SheetStore } from "../model/store"
import { StoreSnapshot } from "../edit/history"
import { axisLimit, shiftRange, type AxisShift } from "./axis"
import { RefRefused, refuse, type RefConstruct } from "./catalogue"
import { SheetFormulas, sharedStringCells, type FormulaChange } from "./cells"
import { FormulaShift, hasUnqualifiedArea, type FormulaOp } from "./formulas"
import { childElements, descendants, editMarkup, shiftFormulaAttribute, type RefJob } from "./markup"
import {
	checkPivotSource,
	checkPivotTable,
	pivotSource,
	renamePivotSource,
	rewriteChart,
	rewriteComments,
	rewriteConnections,
	rewriteControlProperties,
	rewriteDrawing,
	rewriteSingleCells,
	rewriteThreadedComments,
	rewriteVml,
	rewriteVolatileDependencies,
	slicerSource,
	type PivotSource
} from "./parts"
import { MODEL_SECTIONS, PLAIN_SECTIONS, rewriteSection, sectionKnown } from "./sections"
import { formatRef, parseRef } from "./sqref"
import { liveRelationships, refState } from "./state"
import { readTable, rewriteTable, shiftTable, tableEdit, withoutTablePart, type TableInfo, type TableShift } from "./tables"
import type { TableEdit } from "./structured"
import { shiftCols, shiftMerges, shiftRowRuns, shiftView } from "./views"

// A structure edit's effect on every construct of the catalogue, planned before anything changes: a plan to apply
// (and to revert exactly, as the undo applied in order), or the typed refusal of the first construct that cannot
// move. Planning reads the parts that refer to cells (proportional to what the workbook holds); applying writes
// only what moves.

export type RefEdit =
	| { readonly kind: "axis"; readonly sheet: SheetId; readonly shift: AxisShift }
	| { readonly kind: "deleteSheet"; readonly sheet: SheetId }
	| { readonly kind: "renameSheet"; readonly sheet: SheetId; readonly name: string }
	// `to`: the sheet's position in the order after the move.
	| { readonly kind: "moveSheet"; readonly sheet: SheetId; readonly to: number }

export interface RefPlan {
	readonly edit: RefEdit
	// The constructs the edit changes.
	readonly touched: ReadonlySet<RefConstruct>
	// Cells whose formula changed, per sheet, as positions after the edit (rows, cols).
	readonly formulaCells: ReadonlyMap<SheetId, readonly number[]>
	// Cells shifted in a band: the plan moves no cell (the caller does), and these header cells name the table
	// columns the edit adds, each formatted as the cell at `styleFrom` (a column of the header row).
	readonly headers: readonly TableHeader[]
	apply(): void
	revert(): void
}

export interface TableHeader {
	readonly row: number
	readonly col: number
	readonly name: string
	readonly styleFrom: number
}

export type RefPlanResult = { readonly ok: true; readonly plan: RefPlan } | { readonly ok: false; readonly refusal: SheetRefusal }

// Part content types by what the catalogue does with them (the subtype after the last "." or "/", lower case).
export type PartKind =
	| "sheet"
	| "drawing"
	| "chart"
	| "vml"
	| "comments"
	| "threaded"
	| "controlProperties"
	| "table"
	| "pivotTable"
	| "pivotCache"
	| "slicerCache"
	| "timelineCache"
	| "connections"
	| "volatile"
	| "singleCells"
	| "namedSheetView"
	| "revisions"
	| "externalLink"
	| "plain"

const KINDS: ReadonlyMap<string, PartKind> = new Map<string, PartKind>([
	["worksheet+xml", "sheet"],
	["chartsheet+xml", "sheet"],
	["dialogsheet+xml", "sheet"],
	["macrosheet+xml", "sheet"],
	["intlmacrosheet+xml", "sheet"],
	["drawing+xml", "drawing"],
	["chart+xml", "chart"],
	["chartex+xml", "chart"],
	["chartshapes+xml", "chart"],
	["vmldrawing", "vml"],
	["comments+xml", "comments"],
	["threadedcomments+xml", "threaded"],
	["controlproperties+xml", "controlProperties"],
	["table+xml", "table"],
	["pivottable+xml", "pivotTable"],
	["pivotcachedefinition+xml", "pivotCache"],
	["slicercache+xml", "slicerCache"],
	["timelinecache+xml", "timelineCache"],
	["connections+xml", "connections"],
	["volatiledependencies+xml", "volatile"],
	["tablesinglecells+xml", "singleCells"],
	["namedsheetviews+xml", "namedSheetView"],
	["revisionheaders+xml", "revisions"],
	["revisionlog+xml", "revisions"],
	["externallink+xml", "externalLink"]
])

// Parts that hold no reference to cells: the workbook's records, properties, themes, styles, binaries, media,
// rich data, chart styles and diagrams, slicers and timelines themselves (their caches hold the sources), query
// tables (checked with their table) and pivot records.
const PLAIN_TYPES: ReadonlySet<string> = new Set([
	"main+xml",
	"styles+xml",
	"sharedstrings+xml",
	"theme+xml",
	"themeoverride+xml",
	"calcchain+xml",
	"core-properties+xml",
	"extended-properties+xml",
	"custom-properties+xml",
	"relationships+xml",
	"customxmlproperties+xml",
	"sheetmetadata+xml",
	"person+xml",
	"rdrichvalue+xml",
	"rdrichvaluestructure+xml",
	"rdrichvaluetypes+xml",
	"rdrichvaluewebimage+xml",
	"rdarray+xml",
	"rdsupportingpropertybag+xml",
	"rdsupportingpropertybagstructure+xml",
	"featurepropertybag+xml",
	"classificationlabels+xml",
	"chartstyle+xml",
	"chartcolorstyle+xml",
	"diagramdata+xml",
	"diagramlayout+xml",
	"diagramstyle+xml",
	"diagramcolors+xml",
	"diagramdrawing+xml",
	"slicer+xml",
	"timeline+xml",
	"querytable+xml",
	"pivotcacherecords+xml",
	"usernames+xml",
	"activex+xml",
	"model+data",
	"digital-signature-xmlsignature+xml",
	"digital-signature-origin",
	"printersettings",
	"vbaproject",
	"vbaprojectsignature",
	"activex",
	"oleobject",
	"customproperty",
	"webextension+xml",
	"taskpanes+xml"
])

// Folders of binaries, media and embedded objects, and Office's "[trash]" of discarded parts.
const PLAIN_FOLDERS = [
	"/xl/media/",
	"/xl/embeddings/",
	"/xl/printersettings/",
	"/xl/activex/",
	"/customxml/",
	"/docprops/",
	"/xl/theme/",
	"/[trash]/"
]

function subtype(contentType: string): string {
	const type = contentType.toLowerCase().split(";")[0]?.trim() ?? ""
	const cut = Math.max(type.lastIndexOf("."), type.lastIndexOf("/"))

	return type.slice(cut + 1)
}

export function partKind(name: string, contentType: string): PartKind | null {
	const type = subtype(contentType)
	const kind = KINDS.get(type)

	if (kind !== undefined) return kind
	if (PLAIN_TYPES.has(type)) return "plain"

	const lower = `/${name.replace(/^\//, "").toLowerCase()}`
	const main = contentType.toLowerCase()

	// Media and opaque binaries hold no markup a reference could live in.
	if (main.startsWith("image/") || main.startsWith("video/") || main.startsWith("audio/")) return "plain"
	if (main === "application/binary" || main === "application/octet-stream") return "plain"
	if (PLAIN_FOLDERS.some(folder => lower.startsWith(folder))) return "plain"
	if (main === "application/xml" && (lower === "/xl/xmlmaps.xml" || lower.startsWith("/customxml/"))) return "plain"

	return null
}

// Sheet relationships whose targets the catalogue knows (the last segment of the relationship type).
const SHEET_RELATIONSHIPS: ReadonlySet<string> = new Set([
	"drawing",
	"vmlDrawing",
	"comments",
	"threadedComment",
	"table",
	"pivotTable",
	"ctrlProp",
	"tableSingleCells",
	"namedSheetView",
	"slicer",
	"timeline",
	"printerSettings",
	"image",
	"hyperlink",
	"oleObject",
	"package",
	"control",
	"customProperty",
	"activeXControlBinary"
])

interface OwnedPart {
	readonly name: string
	readonly contentType: string
	readonly kind: PartKind
	// The sheet whose relationship reaches it (drawings, comments, tables, controls), null for a workbook part.
	readonly owner: XlsxSheetEntry | null
	readonly relationship: Relationship | null
}

interface Step {
	readonly apply: () => void
	readonly revert: () => void
}

function lastSegment(type: string): string {
	return type.slice(type.lastIndexOf("/") + 1)
}

export async function planRefEdit(workbook: XlsxWorkbookModel, edit: RefEdit): Promise<RefPlanResult> {
	try {
		return { ok: true, plan: await plan(workbook, edit) }
	} catch (error) {
		if (error instanceof RefRefused) return { ok: false, refusal: error.refusal }

		throw error
	}
}

async function plan(workbook: XlsxWorkbookModel, edit: RefEdit): Promise<RefPlan> {
	const state = refState(workbook)
	const target = workbook.sheet(edit.sheet)

	if (target === undefined) refuse("structureLocked", "sheet")

	const touched = new Set<RefConstruct>()
	const touch = (construct: RefConstruct): void => {
		touched.add(construct)
	}
	const order = workbook.sheets.map(sheet => sheet.name)
	let op: FormulaOp

	switch (edit.kind) {
		case "axis": {
			const { shift } = edit
			const limit = axisLimit(shift.axis)

			if (target.kind !== "worksheet") refuse("structureLocked", target.kind)
			if (
				!Number.isInteger(shift.at) ||
				!Number.isInteger(shift.count) ||
				shift.at < 0 ||
				shift.count <= 0 ||
				shift.at + shift.count > limit
			)
				refuse("tooLarge", "axis")

			const band = shift.band

			if (
				band !== undefined &&
				(!Number.isInteger(band.start) ||
					!Number.isInteger(band.end) ||
					band.start < 0 ||
					band.start > band.end ||
					band.end >= axisLimit(shift.axis === "rows" ? "cols" : "rows"))
			)
				refuse("tooLarge", "band")

			op = { kind: "axis", target: target.name, shift }
			break
		}
		case "deleteSheet":
			op = { kind: "deleteSheet", target: target.name, order }
			break
		case "renameSheet":
			op = { kind: "renameSheet", target: target.name, name: edit.name }
			break
		case "moveSheet": {
			const after = order.filter((_, index) => workbook.sheets[index]?.id !== edit.sheet)

			after.splice(Math.max(0, Math.min(edit.to, after.length)), 0, target.name)
			op = { kind: "moveSheet", order: after }
			break
		}
	}

	// Every sheet's formulas can name the edited sheet: all are read.
	for (const entry of workbook.sheets) {
		if (entry.kind === "chartsheet" || entry.model !== null) continue

		try {
			await workbook.load(entry.id)
		} catch {
			refuse("structureLocked", `sheet ${entry.name}: unreadable`)
		}
	}

	const shift = edit.kind === "axis" ? edit.shift : null
	const targetModel = target.model

	// Excel will not push cells off the sheet (cells shifted in a band: the caller checks the band's own cells).
	if (shift !== null && shift.band === undefined && targetModel !== null) {
		const store = targetModel.store
		const extent = shift.axis === "rows" ? store.rowExtent : store.colExtent

		if (shift.type === "insert" && extent + shift.count > axisLimit(shift.axis)) refuse("tooLarge", "cells")
	}

	// The parts, classified, with the sheet whose relationships reach them.
	const owners = new Map<string, { entry: XlsxSheetEntry; relationship: Relationship }>()

	for (const entry of workbook.sheets) {
		const read = entry.model?.relationships ?? (entry.part === "" ? undefined : await workbook.parts.relationships(entry.part))

		// A sheet added since open (a copy) has its relationships in the change log alone.
		for (const relationship of liveRelationships(workbook, entry.part, read?.all ?? [])) {
			if (relationship.external || relationship.partName === undefined) continue

			owners.set(partKey(relationship.partName), { entry, relationship })

			if (entry.id === edit.sheet && shift !== null && !SHEET_RELATIONSHIPS.has(lastSegment(relationship.type)))
				refuse("structureLocked", `relationship ${lastSegment(relationship.type)}`)
		}
	}

	const parts: OwnedPart[] = []
	const seen = new Set<string>()
	const add = (name: string, contentType: string): void => {
		const key = partKey(name)

		if (seen.has(key)) return

		seen.add(key)

		const kind = partKind(name, contentType)

		if (kind === null) refuse("structureLocked", `part ${contentType || name}`)
		if (kind === "plain" || kind === "sheet") return

		const owner = owners.get(key)

		parts.push({ name, contentType, kind, owner: owner?.entry ?? null, relationship: owner?.relationship ?? null })
	}

	for (const [name, write] of workbook.changes.parts) {
		if (write === null) seen.add(partKey(name))
		else add(name, write.contentType)
	}

	for (const part of workbook.parts.parts()) add(part.name, part.contentType)

	// Drawings relate to their charts: a chart's owner is the drawing's sheet (for a rename or a delete it does not
	// matter; charts hold qualified formulas).
	const steps: Step[] = []
	const formulaCells = new Map<SheetId, number[]>()
	const tableEdits = new Map<string, TableEdit>()
	const tables: TableInfo[] = []
	const tableShifts = new Map<string, TableShift>()

	for (const part of parts) {
		if (part.kind === "revisions") refuse("structureLocked", "revisions")
		if (part.kind === "namedSheetView" && shift !== null && part.owner?.id === edit.sheet) refuse("structureLocked", "namedSheetView")
		if (part.kind !== "table" || part.owner === null || part.relationship === null) continue

		const bytes = await state.partBytes(part.name)

		if (bytes === null) continue

		const related = liveRelationships(workbook, part.name, (await workbook.parts.relationships(part.name)).all).flatMap(relationship =>
			relationship.external || relationship.partName === undefined ? [] : [relationship.partName]
		)
		const table = readTable(part.name, part.contentType, part.owner.id, part.relationship.id, bytes, related)

		tables.push(table)

		if (edit.kind === "deleteSheet" && table.sheet === edit.sheet) {
			tableEdits.set(table.name.toUpperCase(), { deleted: true })
		} else if (shift !== null && table.sheet === edit.sheet) {
			const moved = shiftTable(table, shift)
			const change = tableEdit(moved)

			tableShifts.set(partKey(table.part), moved)

			if (change !== null) tableEdits.set(table.name.toUpperCase(), change)
			if ((moved.added !== null || moved.removed.length > 0) && related.length > 0) refuse("structureLocked", "queryTables")
		}
	}

	const formulas = new FormulaShift(op, tableEdits, () => touch("structuredReferences"))
	const deletedSheet = edit.kind === "deleteSheet" ? target : null

	// Pivot caches, slicers and timelines: locked sources.
	const pivotSources: { part: OwnedPart; source: PivotSource }[] = []

	for (const part of parts) {
		if (part.kind !== "pivotCache" && part.kind !== "slicerCache" && part.kind !== "timelineCache") continue

		const bytes = await state.partBytes(part.name)

		if (bytes === null) continue

		if (part.kind === "pivotCache") {
			const source = pivotSource(bytes, part.name)

			if (source === null) continue

			pivotSources.push({ part, source })

			if (source.name !== null && tableEdits.get(source.name.toUpperCase())?.deleted === true)
				refuse("pivot", "pivotSources: table deleted")
			if (deletedSheet !== null && source.sheet !== null && sameSheet(source.sheet, deletedSheet.name))
				refuse("pivot", "pivotSources: sheet deleted")
			if (shift !== null) checkPivotSource(source, target.name, shift, touch)

			continue
		}

		const construct = part.kind === "slicerCache" ? "slicerSources" : "timelineSources"
		const source = slicerSource(bytes, part.name)

		touch(construct)

		if (deletedSheet !== null && source.pivotSheets.includes(deletedSheet.sheetId)) refuse("structureLocked", construct)

		if (source.table !== null) {
			const table = tables.find(candidate => candidate.id === source.table?.id)

			if (table !== undefined) {
				const change = tableEdits.get(table.name.toUpperCase())
				const column = table.columns.find(candidate => candidate.id === source.table?.column)

				if (change?.deleted === true) refuse("structureLocked", construct)
				if (change?.deleted === false && column !== undefined && change.columns.has(column.name.toUpperCase()))
					refuse("structureLocked", construct)
			}
		}
	}

	// --- Sheets: cells, formulas, model sections and the sections without a model ---

	for (const entry of workbook.sheets) {
		const model = entry.model

		if (model === null || entry === deletedSheet) continue

		const own = shift !== null && entry.id === edit.sheet ? shift : null
		const job: RefJob = { own: entry.name, shift: own, formulas, touch }

		planSheet(workbook, entry, model, job, steps, formulaCells, touch)
	}

	const headers: TableHeader[] = []

	if (shift !== null && targetModel !== null) {
		if (shift.band === undefined) planCells(workbook, target, targetModel, shift, [...tableShifts.values()], steps, touch)
		else appendAll(headers, tableHeaders(shift, [...tableShifts.values()]))
	}

	// --- Defined names and the workbook's other children ---

	planNames(workbook, edit, formulas, steps, touch)
	planWorkbookSections(workbook, formulas, steps, touch)

	// --- Parts ---

	for (const part of parts) {
		const ownerName = part.owner?.name ?? null
		const onTarget = shift !== null && part.owner?.id === edit.sheet
		const job: RefJob = { own: ownerName, shift: onTarget ? shift : null, formulas, touch }
		let rewrite: ((bytes: Uint8Array) => Uint8Array) | null = null

		if (deletedSheet !== null && part.owner === deletedSheet) continue

		switch (part.kind) {
			case "drawing":
				rewrite = bytes => rewriteDrawing(bytes, job, part.name)
				break
			case "chart":
				rewrite = bytes => rewriteChart(bytes, job, part.name)
				break
			case "vml":
				rewrite = bytes => rewriteVml(bytes, job, part.name)
				break
			case "comments":
				if (onTarget) rewrite = bytes => rewriteComments(bytes, job, part.name)
				break
			case "threaded":
				if (onTarget) rewrite = bytes => rewriteThreadedComments(bytes, job, part.name)
				break
			case "controlProperties":
				rewrite = bytes => rewriteControlProperties(bytes, job, part.name)
				break
			case "connections":
				rewrite = bytes => rewriteConnections(bytes, job, part.name)
				break
			case "volatile":
				rewrite = bytes =>
					rewriteVolatileDependencies(bytes, { ...job, shift }, target.sheetId, edit.kind === "deleteSheet", part.name)
				break
			case "singleCells":
				if (onTarget) rewrite = bytes => rewriteSingleCells(bytes, job, part.name)
				break
			case "pivotTable":
				if (onTarget && shift !== null) {
					const bytes = await state.partBytes(part.name)

					if (bytes !== null) checkPivotTable(bytes, shift, part.name, touch)
				}
				break
			case "pivotCache":
				if (edit.kind === "renameSheet") {
					const source = pivotSources.find(candidate => candidate.part === part)?.source

					if (source?.sheet !== null && source?.sheet !== undefined && sameSheet(source.sheet, target.name)) {
						touch("pivotSources")
						rewrite = bytes => renamePivotSource(bytes, target.name, edit.name, part.name)
					}
				}
				break
			case "table": {
				const table = tables.find(candidate => partKey(candidate.part) === partKey(part.name))

				if (table === undefined) break

				const moved = tableShifts.get(partKey(part.name)) ?? null

				if (moved?.ref === null) {
					planTableRemoval(workbook, table, steps, touch)

					break
				}

				rewrite = () => rewriteTable(table, moved, job)
				break
			}
			case "externalLink":
				touch("externalLinks")
				break
			default:
				break
		}

		if (rewrite === null) continue

		const before = await state.partBytes(part.name)

		if (before === null) continue

		const after = rewrite(before)

		if (after === before) continue

		const held = state.heldPart(part.name)
		const contentType = part.contentType

		steps.push({
			apply: () => state.setPart(part.name, contentType, after),
			revert: () => state.setPart(part.name, contentType, held)
		})
	}

	if (shift !== null || formulaCells.size > 0) {
		if ([...workbook.parts.parts()].some(part => subtype(part.contentType) === "calcchain+xml")) touch("calcChain")

		steps.push({ apply: () => workbook.changes.formulasChanged(), revert: () => undefined })
	}

	return {
		edit,
		touched,
		formulaCells,
		headers,
		apply: () => {
			for (const step of steps) step.apply()
		},
		revert: () => {
			for (let k = steps.length - 1; k >= 0; k--) steps[k]?.revert()
		}
	}
}

// One sheet: its formulas, its model sections (when its cells move) and every section that refers to cells.
function planSheet(
	workbook: XlsxWorkbookModel,
	entry: XlsxSheetEntry,
	model: XlsxSheetModel,
	job: RefJob,
	steps: Step[],
	formulaCells: Map<SheetId, number[]>,
	touch: (construct: RefConstruct) => void
): void {
	const state = refState(workbook)
	const shift = job.shift
	const plan = new SheetFormulas(model, entry.name, job.formulas, shift, touch).plan()

	if (plan.changes.length > 0) {
		formulaCells.set(entry.id, [...plan.cells])
		steps.push(formulaStep(workbook, model, plan.changes, plan.cells))
	}

	if (shift !== null) {
		for (const section of model.sections) if (!sectionKnown(section.name)) refuse("structureLocked", `section ${section.name}`)

		// The views: written by the catalogue (every view, pane and selection moved, the model read back from them),
		// unless another edit has the writer serialise them from the model, which holds the first view only.
		const marked = workbook.changes.sheets.get(model.id)?.sections
		const views = model.sections.find(section => section.name === "sheetViews")
		// A sheet of another format holds its view in the model alone (an OpenDocument sheet's settings.xml view).
		const viewsByModel =
			(marked?.has("sheetViews") === true && !state.ownsSection(marked.get("sheetViews"))) ||
			(views === undefined && model.shiftSource !== undefined)
		let viewStep: Step | null = null

		if (views !== undefined && !viewsByModel) {
			const before = state.sectionMarkup(model, "sheetViews")
			const after = before.map(markup => rewriteSection("sheetViews", markup, job))
			const markup = after.join("")
			const view = after.every((text, k) => text === before[k]) ? null : firstView(markup)

			if (view !== null) {
				const previous = model.view

				viewStep = {
					apply: () => {
						state.setSection(model, "sheetViews", after)
						model.view = view
					},
					revert: () => {
						state.setSection(model, "sheetViews", before)
						model.view = previous
					}
				}
			}
		}

		if (views !== undefined && viewsByModel && shift.band === undefined) {
			const { document } = editMarkup(views.bytes ?? new Uint8Array(0), "section sheetViews")
			const all = childElements(document, document.documentElement()).filter(view => document.localName(view) === "sheetView")

			if (all.length > 1) refuse("structureLocked", "sheetViews: more than one view")
		}

		steps.push(modelStep(workbook, model, shift, viewsByModel, touch))

		if (viewStep !== null) steps.push(viewStep)
	}

	// Sections without a model, every occurrence of each name together; with the ones an edit added (a sheet that had
	// no data validations given one).
	const names = [...new Set([...model.sections.map(section => section.name), ...state.heldSections(model)])]

	for (const name of names) {
		if (PLAIN_SECTIONS.has(name) || (MODEL_SECTIONS.has(name) && name !== "dimension")) continue
		if (name === "dimension" && (shift === null || workbook.changes.sheets.get(model.id)?.sections.get("dimension") === null)) continue

		const before = state.sectionMarkup(model, name)
		const after =
			name === "dimension"
				? before.map(markup => shiftDimension(markup, job))
				: before.map(markup => rewriteSection(name, markup, job))

		if (after.every((markup, k) => markup === before[k])) continue

		const positions = model.sections.flatMap((section, index) => (section.name === name ? [index] : []))

		if (positions.some((position, k) => k > 0 && position !== (positions[k - 1] ?? 0) + 1))
			refuse("structureLocked", `section ${name}: not together`)

		steps.push({ apply: () => state.setSection(model, name, after), revert: () => state.setSection(model, name, before) })
	}
}

function shiftDimension(markup: string, job: RefJob): string {
	if (job.shift === null || markup === "") return markup

	const ref = /\sref\s*=\s*"([^"]*)"/.exec(markup)
	const range = ref === null ? null : parseRef(ref[1] ?? "")

	if (ref === null || range === null) return markup

	const next = shiftRange(range, job.shift)
	const text = next === null ? "A1" : formatRef(next)

	if (next === range) return markup

	job.touch("dimension")

	return markup.slice(0, ref.index) + ref[0].replace(ref[1] ?? "", text) + markup.slice(ref.index + ref[0].length)
}

function formulaStep(
	workbook: XlsxWorkbookModel,
	model: XlsxSheetModel,
	changes: readonly FormulaChange[],
	cells: readonly number[]
): Step {
	const table = model.store.formulas
	const store = model.store as SheetStore
	const mark = (): void => {
		for (let k = 0; k + 1 < cells.length; k += 2) {
			const row = cells[k] ?? 0
			const col = cells[k + 1] ?? 0
			const slot = store.locate(row, col)

			if (slot < 0) continue

			store.setCell(row, col, store.kind(slot), store.value(slot), store.style(slot), store.formula(slot))
		}

		workbook.changes.sheetRows(model.id)
	}

	const set = (id: number, formula: XlsxFormula | string): void => {
		if (typeof formula !== "string") table.set(id, formula)
		else if (table instanceof FormulaTable) table.setText(id, formula)
		else table.set(id, { ...table.formula(id), text: formula })
	}

	return {
		apply: () => {
			for (const change of changes) set(change.id, change.after)

			mark()
		},
		revert: () => {
			for (let k = changes.length - 1; k >= 0; k--) {
				const change = changes[k] as FormulaChange

				set(change.id, change.before)
			}
		}
	}
}

// The sheet's merges, column ranges and view, moved through the model.
// The model's first view as a reader reads it from the views' markup.
function firstView(markup: string): XlsxSheetView | null {
	const { document } = editMarkup(encodeUtf8(markup), "section sheetViews")
	const view = childElements(document, document.documentElement()).find(node => document.localName(node) === "sheetView")

	return view === undefined ? null : readView(document, view)
}

function modelStep(
	workbook: XlsxWorkbookModel,
	model: XlsxSheetModel,
	shift: AxisShift,
	viewsByModel: boolean,
	touch: (construct: RefConstruct) => void
): Step {
	const before = { merges: model.merges, cols: model.cols, view: model.view, styleRuns: model.styleRuns, rowRuns: model.rowRuns }
	const after = {
		merges: shiftMerges(model.merges, shift),
		cols: shiftCols(model.cols, shift),
		view: viewsByModel ? shiftView(model.view, shift) : model.view,
		styleRuns: model.styleRuns?.shifted(shift),
		rowRuns: model.rowRuns === undefined ? undefined : shiftRowRuns(model.rowRuns, shift)
	}
	const changes = workbook.changes
	// What a source of another format keeps beside the model (an OpenDocument sheet's runs and source axes).
	const source = model.shiftSource?.(shift) ?? null

	if (after.merges !== before.merges) touch("merges")
	if (after.cols !== before.cols) touch("cols")
	if (after.view !== before.view) touch("sheetView")

	const set = (values: typeof before): void => {
		model.merges = values.merges
		model.cols = values.cols
		model.view = values.view

		if (after.styleRuns !== before.styleRuns) {
			if (values.styleRuns === undefined) delete model.styleRuns
			else model.styleRuns = values.styleRuns
		}

		if (after.rowRuns !== before.rowRuns) model.rowRuns = values.rowRuns ?? []

		if (after.merges !== before.merges) changes.sheetSection(model.id, "mergeCells")
		if (after.cols !== before.cols) changes.sheetSection(model.id, "cols")
		if (after.view !== before.view) changes.sheetSection(model.id, "sheetViews")
	}

	return {
		apply: () => {
			set(after)
			source?.apply()
		},
		revert: () => {
			source?.revert()
			set(before)
		}
	}
}

// The cells: moved in the store (exactly restored on revert), shared string references counted, and header
// cells written for new table columns.
function planCells(
	workbook: XlsxWorkbookModel,
	entry: XlsxSheetEntry,
	model: XlsxSheetModel,
	shift: AxisShift,
	tables: readonly TableShift[],
	steps: Step[],
	touch: (construct: RefConstruct) => void
): void {
	const store = model.store as SheetStore
	const strings = shift.type === "delete" ? sharedStringCells(model, shift) : 0
	const headers = tableHeaders(shift, tables)

	let snapshot: StoreSnapshot | null = null
	// An insert of columns marks the rows it moves as changed, and so does the delete that reverts it: their flags as
	// they were are put back, so rows as the source has them stay its own (the dimension and the rows keep their bytes).
	let flags: { readonly block: RowBlock; readonly flags: Uint16Array }[] = []
	const shared = workbook.sharedStrings
	// Rows are written again only when some row or cell is at or past the edit.
	const moves = headers.length > 0 || (shift.axis === "rows" ? store.rowExtent : store.colExtent) > shift.at
	const appended: number[] = []

	touch("cells")

	steps.unshift({
		apply: () => {
			// An insert loses nothing: its revert deletes what it inserted, so the store's blocks are moved in place
			// rather than copied for a snapshot (a delete keeps the blocks it takes). The snapshot keeps the blocks'
			// columns too, a delete of rows as well: a later insert of columns shifts them in place, and its undo shifts
			// back a copy instead when a cell edit copied the block meanwhile.
			snapshot = shift.type === "delete" ? new StoreSnapshot(store, true) : null
			flags =
				shift.axis === "cols" && shift.type === "insert"
					? store.blocks.filter(block => block.colExtent > shift.at).map(block => ({ block, flags: block.rowFlags.slice() }))
					: []

			if (shift.axis === "rows") {
				if (shift.type === "insert") store.insertRows(shift.at, shift.count)
				else store.deleteRows(shift.at, shift.count)
			} else if (shift.type === "insert") {
				store.insertCols(shift.at, shift.count)
			} else {
				store.deleteCols(shift.at, shift.count)
			}

			let references = -strings

			for (const header of headers) {
				const source = store.locate(header.row, header.styleFrom)
				const style = source < 0 ? 0 : store.style(source)
				let index = shared.find(header.name)

				if (index < 0) {
					index = shared.append(header.name)
					appended.push(index)
				}

				store.setCell(header.row, header.col, CellKind.SHARED_STRING, index, style, -1)
				references++
			}

			if (references !== 0) {
				shared.adjustReferences(references)
				workbook.changes.sharedStringsAppended()
			}

			if (moves) workbook.changes.sheetRows(entry.id)
		},
		revert: () => {
			if (shift.type === "insert") {
				if (shift.axis === "rows") store.deleteRows(shift.at, shift.count)
				else store.deleteCols(shift.at, shift.count)

				const blocks = new Set(store.blocks)

				for (const saved of flags)
					if (blocks.has(saved.block) && saved.block.rowCount === saved.flags.length) saved.block.rowFlags.set(saved.flags)

				flags = []
			} else {
				;(snapshot as StoreSnapshot | null)?.restore(store)
			}

			const references = headers.length - strings

			if (references !== 0) shared.adjustReferences(-references)
		}
	})
}

// The header cells of the table columns an insert of columns adds.
function tableHeaders(shift: AxisShift, tables: readonly TableShift[]): TableHeader[] {
	const headers: TableHeader[] = []

	for (const moved of tables) {
		const added = moved.added

		if (added === null || added.headerRow < 0 || moved.ref === null) continue

		added.names.forEach((name, k) => headers.push({ row: added.headerRow, col: shift.at + k, name, styleFrom: shift.at - 1 }))
	}

	return headers
}

function planNames(
	workbook: XlsxWorkbookModel,
	edit: RefEdit,
	formulas: FormulaShift,
	steps: Step[],
	touch: (construct: RefConstruct) => void
): void {
	const before = workbook.definedNames.slice()
	const after: XlsxDefinedName[] = []
	let changed = false

	for (const name of before) {
		if (edit.kind === "deleteSheet" && name.sheet === edit.sheet) {
			changed = true

			continue
		}

		const own = name.sheet === null ? null : (workbook.sheet(name.sheet)?.name ?? null)

		if (edit.kind === "axis" && own === null && hasUnqualifiedArea(name.formula))
			refuse("structureLocked", `definedNames: ${name.name}`)

		const formula = formulas.shift(name.formula, own)

		if (formula === name.formula) {
			after.push(name)

			continue
		}

		changed = true
		after.push(nameWithFormula(name, formula) ?? refuse("structureLocked", `definedNames: ${name.name}`))
	}

	if (!changed) return

	touch("definedNames")

	const set = (names: readonly XlsxDefinedName[]): void => {
		spliceAll(workbook.definedNames, 0, workbook.definedNames.length, names)
		workbook.changes.workbookSection("definedNames")
	}

	steps.push({ apply: () => set(after), revert: () => set(before) })
}

// Workbook children that hold no reference to cells or sheets, or one planned elsewhere (definedNames, the sheets,
// pivotCaches through their parts).
const PLAIN_WORKBOOK_SECTIONS: ReadonlySet<string> = new Set([
	"fileVersion",
	"fileSharing",
	"workbookPr",
	"workbookProtection",
	"bookViews",
	"sheets",
	"functionGroups",
	"externalReferences",
	"definedNames",
	"calcPr",
	"oleSize",
	"customWorkbookViews",
	"pivotCaches",
	"smartTagPr",
	"smartTagTypes",
	"webPublishing",
	"fileRecoveryPr"
])

const ABS_PATH_ONLY =
	/^\s*<([\w.-]+:)?AlternateContent\b[^>]*>\s*<([\w.-]+:)?Choice\b[^>]*>\s*<[\w.-]+:absPath\b[^>]*\/>\s*<\/([\w.-]+:)?Choice>\s*<\/([\w.-]+:)?AlternateContent>\s*$/

// The workbook's other children: web publishing objects' sources moved; any other child that may name the edited
// sheet refuses.
function planWorkbookSections(
	workbook: XlsxWorkbookModel,
	formulas: FormulaShift,
	steps: Step[],
	touch: (construct: RefConstruct) => void
): void {
	const state = refState(workbook)

	for (const name of new Set(workbook.workbookSections.map(section => section.name))) {
		if (PLAIN_WORKBOOK_SECTIONS.has(name)) continue

		// Extensions and children of newer schemas (xr:revisionPtr, x15ac:absPath, calcFeatures), each occurrence (a
		// workbook can hold several AlternateContent children): refused only when one holds a reference the edit would
		// change (no edit can move what is written there).
		if (name !== "webPublishObjects") {
			const occurrences = workbook.changes.workbookSections.has(name)
				? [state.workbookMarkup(name)]
				: workbook.workbookSections
						.filter(section => section.name === name)
						.map(section => decodeUtf8(section.bytes ?? new Uint8Array(0)))

			for (const markup of occurrences) {
				// The workbook's saved path (x15ac:absPath, Excel's alternate content): a file path, never a reference.
				if (ABS_PATH_ONLY.test(markup)) continue
				if (formulas.markupReferencesEdit(markup)) refuse("structureLocked", `workbook ${name}`)
			}

			continue
		}

		const before = state.workbookMarkup(name)

		const edited = editMarkup(encodeUtf8(before), "webPublishObjects")
		const job: RefJob = { own: null, shift: null, formulas, touch }

		for (const node of descendants(edited.document, edited.document.documentElement()))
			if (edited.document.localName(node) === "webPublishObject")
				shiftFormulaAttribute(edited, node, "sourceObject", job, "webPublishItems", null)

		const after = decodeUtf8(edited.editor.serialize())

		if (after === before) continue

		steps.push({ apply: () => state.setWorkbookSection(name, after), revert: () => state.setWorkbookSection(name, before) })
	}
}

// A defined name with another formula: its element as written keeps every other attribute (comment, description,
// function, vbProcedure, shortcutKey, ...), its text replaced. Null when the element does not read.
export function nameWithFormula(name: XlsxDefinedName, formula: string): XlsxDefinedName | null {
	if (name.source === null) return { ...name, formula }

	try {
		const document = parseXml(name.source)
		const editor = new XmlEditor(document)

		editor.setText(document.documentElement(), formula)

		return { ...name, formula, source: editor.serialize() }
	} catch (error) {
		if (error instanceof XmlError) return null

		throw error
	}
}

// A table whose every row or column was deleted: its part (and related parts) removed, the sheet's relationship
// and tablePart entry with it.
function planTableRemoval(workbook: XlsxWorkbookModel, table: TableInfo, steps: Step[], touch: (construct: RefConstruct) => void): void {
	const entry = workbook.sheet(table.sheet)
	const model = entry?.model ?? null

	if (entry === undefined || model === null) refuse("structureLocked", "tables")

	const state = refState(workbook)
	const before = state.sectionMarkup(model, "tableParts")
	const after = before.map(markup => withoutTablePart(markup, table.relationship))
	const removed = [table.part, ...table.related]
	const changes = workbook.changes

	touch("tables")
	steps.push({
		apply: () => {
			for (const part of removed) changes.removePart(part)

			changes.removeRelationship(model.part, table.relationship)
			state.setSection(model, "tableParts", after)
		},
		revert: () => {
			state.setSection(model, "tableParts", before)
			if (changes instanceof ChangeLog) changes.restoreRelationship(model.part, table.relationship)

			for (const part of removed) changes.restorePart(part)
		}
	})
}
