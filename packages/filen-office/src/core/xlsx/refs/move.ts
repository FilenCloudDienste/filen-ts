import { appendAll } from "../../arrays"
import { partKey } from "../../opc/partNames"
import type { SheetRange, SheetRefusal } from "../../sheet/protocol"
import { formulaTranslator, sameSheet } from "../../sheet/refs/formulaRefs"
import { sliceClock, type Slicing } from "../../slicing"
import { decodeUtf8, encodeUtf8 } from "../../xml/index"
import type { XlsxSheetEntry, XlsxSheetModel, XlsxWorkbookModel } from "../model/types"
import { RefRefused, refuse } from "./catalogue"
import { FormulaShift } from "./formulas"
import { childElements, descendants, editMarkup, type Edited, type RefJob } from "./markup"
import { contains, intersects, type CellMove } from "./moveRefs"
import { pivotSource, rewriteChart, rewriteConnections, rewriteControlProperties, rewriteDrawing, rewriteVml } from "./parts"
import { partKind } from "./plan"
import { MODEL_SECTIONS, PLAIN_SECTIONS, rewriteSection } from "./sections"
import { formatRef, formatSqref, overlapRange, parseRef, parseSqref, subtractRange, topLeft } from "./sqref"
import { liveRelationships, refState } from "./state"
import { readTable, rewriteTable } from "./tables"

// What a cut and paste (cells moved) does outside the cells themselves, planned before anything changes. As Excel
// and LibreOffice move cells: the conditional formats, validations, hyperlinks and merges of the cut cells go with
// them, and those of the cells the paste writes over go (a conditional format or validation keeps the rest of its
// range); the formulas of sections and parts move as moveReference says. What the move cannot carry refuses: a merge
// or a hyperlink only partly cut or written over, formats moving to another sheet, notes, a table's header, a pivot
// table, real-time data, a pivot source wholly cut.

export interface MovePlan {
	apply(): void
	revert(): void
}

export type MovePlanResult = { readonly ok: true; readonly plan: MovePlan } | { readonly ok: false; readonly refusal: SheetRefusal }

interface Step {
	readonly apply: () => void
	readonly revert: () => void
}

// Sections of the cut's and the paste's sheets whose ranges travel with the cells.
const TRAVELLING_SECTIONS: ReadonlySet<string> = new Set(["conditionalFormatting", "dataValidations", "hyperlinks", "extLst"])

function lastSegment(type: string): string {
	return type.slice(type.lastIndexOf("/") + 1)
}

// One sheet's view of the move.
class SheetMove {
	readonly move: CellMove
	readonly onSource: boolean
	readonly onDestination: boolean
	readonly rows: number
	readonly cols: number

	constructor(entry: XlsxSheetEntry, move: CellMove) {
		this.move = move
		this.onSource = sameSheet(entry.name, move.sheet)
		this.onDestination = sameSheet(entry.name, move.to)
		this.rows = move.destination.startRow - move.range.startRow
		this.cols = move.destination.startCol - move.range.startCol
	}

	get touched(): readonly SheetRange[] {
		return [...(this.onSource ? [this.move.range] : []), ...(this.onDestination ? [this.move.destination] : [])]
	}

	offset(range: SheetRange): SheetRange {
		return {
			startRow: range.startRow + this.rows,
			startCol: range.startCol + this.cols,
			endRow: range.endRow + this.rows,
			endCol: range.endCol + this.cols
		}
	}

	// A range list after the move: what is left of it, then the part the cut takes, moved. Its part going to another
	// sheet refuses (`what`).
	ranges(ranges: readonly SheetRange[], what: string): SheetRange[] {
		const move = this.move
		let kept = ranges.slice()

		if (this.onSource) kept = kept.flatMap(range => subtractRange(range, move.range))
		if (this.onDestination) kept = kept.flatMap(range => subtractRange(range, move.destination))

		const moved = this.onSource
			? ranges.filter(range => intersects(range, move.range)).map(range => this.offset(overlapRange(range, move.range)))
			: []

		if (moved.length > 0 && !this.onDestination) refuse("structureLocked", `${what}: another sheet`)

		return [...kept, ...moved]
	}

	// Whether something placed over one range is moved whole, written over whole, or neither; partly refuses.
	placed(range: SheetRange, what: string): "moved" | "gone" | "kept" {
		const move = this.move

		if (this.onSource && intersects(range, move.range)) {
			if (!contains(move.range, range)) refuse("structureLocked", what)
			if (!this.onDestination) refuse("structureLocked", `${what}: another sheet`)

			return "moved"
		}

		if (this.onDestination && intersects(range, move.destination)) {
			if (!contains(move.destination, range)) refuse("structureLocked", what)

			return "gone"
		}

		return "kept"
	}
}

// The formulas below `node` of a range list whose first cell moved by (rows, cols): their references moved, then
// written from the new first cell.
function moveFormulas(edited: Edited, node: number, job: RefJob, rows: number, cols: number, done: Set<number>): void {
	const { document, editor } = edited
	const shift = (text: string): string => {
		const moved = job.formulas.shift(text, job.own)

		return rows === 0 && cols === 0 ? moved : formulaTranslator(moved)(rows, cols)
	}

	for (const child of descendants(document, node)) {
		done.add(child)

		const local = document.localName(child)

		if (
			(local === "formula" || local === "formula1" || local === "formula2" || local === "f") &&
			document.firstChildElement(child) < 0
		) {
			const text = document.textContent(child)
			const next = shift(text)

			if (next !== text) editor.setText(child, next)
		} else if (local === "cfvo") {
			const text = document.attribute(child, "val")
			const next = text === undefined || text === "" ? text : shift(text)

			if (next !== undefined && next !== text) editor.setAttribute(child, "val", next)
		}
	}
}

// A range list (an sqref attribute, or the text of an sqref child) carried by the move; false when none is left.
function travel(edited: Edited, node: number, sheet: SheetMove, job: RefJob, what: string, done: Set<number>): boolean {
	const { document, editor } = edited
	const child = childElements(document, node).find(candidate => document.localName(candidate) === "sqref")
	const text = child === undefined ? document.attribute(node, "sqref") : document.textContent(child)
	const ranges = text === undefined ? null : parseSqref(text)

	if (ranges === null || ranges.length === 0) refuse("structureLocked", `${what}: range`)

	const next = ranges.some(range => sheet.touched.some(touched => intersects(range, touched))) ? sheet.ranges(ranges, what) : ranges

	if (next.length === 0) return false

	// Formulas are written for the top-left of the rectangle around the list's ranges.
	const first = topLeft(ranges)
	const now = topLeft(next)

	if (next !== ranges) {
		if (child === undefined) editor.setAttribute(node, "sqref", formatSqref(next))
		else editor.setText(child, formatSqref(next))
	}

	moveFormulas(edited, node, job, now.row - first.row, now.col - first.col, done)

	return true
}

function setCount(edited: Edited, node: number, value: number): void {
	const current = edited.document.attribute(node, "count")

	if (current !== undefined && Number(current) !== value) edited.editor.setAttribute(node, "count", String(value))
}

// One occurrence of a travelling section on the cut's or the paste's sheet: the new markup, "" when it goes.
function travelSection(name: string, markup: string, sheet: SheetMove, job: RefJob): string {
	const edited = editMarkup(encodeUtf8(markup), `section ${name}`)
	const { document, editor } = edited
	const root = document.documentElement()
	const done = new Set<number>()

	if (name === "conditionalFormatting") {
		if (!travel(edited, root, sheet, job, name, done)) return ""
	} else if (name === "dataValidations") {
		let left = 0

		for (const node of childElements(document, root)) {
			if (document.localName(node) !== "dataValidation") continue
			if (travel(edited, node, sheet, job, name, done)) left++
			else editor.remove(node)
		}

		if (left === 0) return ""

		setCount(edited, root, left)
	} else if (name === "hyperlinks") {
		let left = 0

		for (const node of childElements(document, root)) {
			if (document.localName(node) !== "hyperlink") continue

			const range = parseRef(document.attribute(node, "ref") ?? "")

			if (range === null) refuse("structureLocked", "hyperlinks: range")

			const placed = sheet.placed(range, "hyperlinks")

			if (placed === "gone") {
				editor.remove(node)

				continue
			}

			left++

			if (placed === "moved") editor.setAttribute(node, "ref", formatRef(sheet.offset(range)))

			const location = document.attribute(node, "location")
			const next = location === undefined || location === "" ? location : job.formulas.shift(location, job.own)

			if (next !== undefined && next !== location) editor.setAttribute(node, "location", next)
		}

		if (left === 0) return ""
	} else {
		// extLst: x14 conditional formats and validations travel; sparklines over the cells refuse; any other formula
		// moves in place.
		for (const node of descendants(document, root)) {
			if (done.has(node)) continue

			const local = document.localName(node)
			const hasRange = childElements(document, node).some(child => document.localName(child) === "sqref")

			if ((local === "conditionalFormatting" || local === "dataValidation") && hasRange) {
				if (!travel(edited, node, sheet, job, local === "dataValidation" ? "dataValidations" : "conditionalFormatting", done)) {
					editor.remove(node)

					const parent = document.parent(node)

					if (local === "dataValidation")
						setCount(
							edited,
							parent,
							childElements(document, parent).filter(
								other => other !== node && document.localName(other) === "dataValidation"
							).length
						)
				}
			} else if (local === "sparkline" && hasRange) {
				const range = parseRef(
					document.textContent(childElements(document, node).find(child => document.localName(child) === "sqref") ?? node)
				)

				if (range === null || sheet.touched.some(touched => intersects(range, touched))) refuse("structureLocked", "sparklines")
			} else if (local === "f" && document.firstChildElement(node) < 0) {
				const text = document.textContent(node)
				const next = job.formulas.shift(text, job.own)

				if (next !== text) editor.setText(node, next)
			}
		}
	}

	return editor.changed ? decodeUtf8(editor.serialize()) : markup
}

function mergesOf(model: XlsxSheetModel): SheetRange[] {
	const out: SheetRange[] = []

	for (let i = 0; i + 3 < model.merges.length; i += 4)
		out.push({
			startRow: model.merges[i] ?? 0,
			startCol: model.merges[i + 1] ?? 0,
			endRow: model.merges[i + 2] ?? 0,
			endCol: model.merges[i + 3] ?? 0
		})

	return out
}

function mergeArray(ranges: readonly SheetRange[]): Uint32Array {
	return Uint32Array.from(ranges.flatMap(range => [range.startRow, range.startCol, range.endRow, range.endCol]))
}

async function plan(workbook: XlsxWorkbookModel, move: CellMove, slicing: Slicing | undefined): Promise<MovePlan> {
	const state = refState(workbook)
	const formulas = new FormulaShift({ kind: "moveCells", target: move.sheet, move })
	const steps: Step[] = []
	const clock = slicing === undefined ? undefined : sliceClock(slicing)
	const touch = (): void => undefined
	const owners = new Map<string, XlsxSheetEntry>()
	const source = workbook.sheets.find(entry => sameSheet(entry.name, move.sheet))
	const destination = workbook.sheets.find(entry => sameSheet(entry.name, move.to))

	const sourceModel = source?.model ?? null
	const destinationModel = destination?.model ?? null

	if (source === undefined || destination === undefined || sourceModel === null || destinationModel === null)
		refuse("structureLocked", "unreadSheet")

	// --- Merges: those cut move; those written over go; one only partly cut or written over refuses ---

	const moving: SheetRange[] = []
	const left = (model: XlsxSheetModel, entry: XlsxSheetEntry): SheetRange[] => {
		const sheet = new SheetMove(entry, move)

		return mergesOf(model).filter(range => {
			if (sheet.onSource && intersects(range, move.range)) {
				if (!contains(move.range, range)) refuse("merged", "mergeCells")

				moving.push(sheet.offset(range))

				return false
			}

			if (sheet.onDestination && intersects(range, move.destination)) {
				if (!contains(move.destination, range)) refuse("merged", "mergeCells")

				return false
			}

			return true
		})
	}
	const sourceAfter = left(sourceModel, source)
	const destinationAfter = destination === source ? sourceAfter : left(destinationModel, destination)

	appendAll(destinationAfter, moving)

	for (const [entry, model, after] of destination === source
		? ([[source, sourceModel, sourceAfter]] as const)
		: ([
				[source, sourceModel, sourceAfter],
				[destination, destinationModel, destinationAfter]
			] as const)) {
		const next = mergeArray(after)
		const before = model.merges

		if (next.length === before.length && next.every((value, i) => value === before[i])) continue

		steps.push({
			apply: () => {
				model.merges = next
				workbook.changes.sheetSection(entry.id, "mergeCells")
			},
			revert: () => {
				model.merges = before
				workbook.changes.sheetSection(entry.id, "mergeCells")
			}
		})
	}

	// --- Sheets: what sits over the cells, sections ---

	for (const entry of workbook.sheets) {
		const model = entry.model

		if (model === null) refuse("structureLocked", "unreadSheet")

		for (const relationship of liveRelationships(workbook, entry.part, model.relationships.all))
			if (!relationship.external && relationship.partName !== undefined) owners.set(partKey(relationship.partName), entry)

		const sheet = new SheetMove(entry, move)
		const job: RefJob = { own: entry.name, shift: null, formulas, touch }

		if (sheet.touched.length > 0) await placedParts(workbook, entry, model, sheet)

		for (const name of new Set([...model.sections.map(section => section.name), ...state.heldSections(model)])) {
			if (PLAIN_SECTIONS.has(name) || MODEL_SECTIONS.has(name)) continue

			const before = state.sectionMarkup(model, name)
			const after = before.map(markup =>
				sheet.touched.length > 0 && TRAVELLING_SECTIONS.has(name)
					? named(name, () => travelSection(name, markup, sheet, job))
					: named(name, () => rewriteSection(name, markup, job))
			)

			if (after.every((markup, k) => markup === before[k])) continue

			steps.push({ apply: () => state.setSection(model, name, after), revert: () => state.setSection(model, name, before) })
		}

		if (clock?.due === true) await clock.pause()
	}

	// --- Parts ---

	const seen = new Set<string>()
	const parts: { name: string; contentType: string }[] = []

	for (const [name, write] of workbook.changes.parts) {
		seen.add(partKey(name))

		if (write !== null) parts.push({ name, contentType: write.contentType })
	}

	for (const part of workbook.parts.parts()) {
		if (seen.has(partKey(part.name))) continue

		seen.add(partKey(part.name))
		parts.push({ name: part.name, contentType: part.contentType })
	}

	for (const part of parts) {
		const kind = partKind(part.name, part.contentType)

		if (kind === null) refuse("structureLocked", `part ${part.contentType || part.name}`)
		if (kind === "revisions") refuse("structureLocked", "revisions")

		const owner = owners.get(partKey(part.name)) ?? null
		const job: RefJob = { own: owner?.name ?? null, shift: null, formulas, touch }
		let rewrite: ((bytes: Uint8Array) => Uint8Array) | null = null

		switch (kind) {
			case "drawing":
				rewrite = bytes => rewriteDrawing(bytes, job, part.name)
				break
			case "chart":
				rewrite = bytes => rewriteChart(bytes, job, part.name)
				break
			case "vml":
				rewrite = bytes => rewriteVml(bytes, job, part.name)
				break
			case "controlProperties":
				rewrite = bytes => rewriteControlProperties(bytes, job, part.name)
				break
			case "connections":
				rewrite = bytes => rewriteConnections(bytes, job, part.name)
				break
			case "table":
				if (owner !== null) {
					const relationship = liveRelationships(workbook, owner.part, owner.model?.relationships.all ?? []).find(
						candidate => candidate.partName !== undefined && partKey(candidate.partName) === partKey(part.name)
					)

					rewrite = bytes =>
						rewriteTable(readTable(part.name, part.contentType, owner.id, relationship?.id ?? "", bytes, []), null, job)
				}
				break
			case "pivotCache": {
				// A source the cut takes whole would have to follow it; one it takes in part keeps its range.
				const bytes = await state.partBytes(part.name)
				const found = bytes === null || !formulas.namesTarget(decodeUtf8(bytes)) ? null : pivotSource(bytes, part.name)

				if (
					found !== null &&
					found.sheet !== null &&
					found.ref !== null &&
					sameSheet(found.sheet, move.sheet) &&
					contains(move.range, found.ref)
				)
					refuse("pivot", "pivotSources")
				break
			}
			case "volatile": {
				const bytes = await state.partBytes(part.name)

				if (bytes !== null && volatileMeets(bytes, workbook, move)) refuse("structureLocked", "volatileDependencies")
				break
			}
			default:
				break
		}

		if (rewrite === null) continue

		const before = await state.partBytes(part.name)

		if (before === null) continue

		const transform = rewrite
		const after = named(kind, () => transform(before))

		if (after === before) continue

		const held = state.heldPart(part.name)
		const contentType = part.contentType

		steps.push({ apply: () => state.setPart(part.name, contentType, after), revert: () => state.setPart(part.name, contentType, held) })

		if (clock?.due === true) await clock.pause()
	}

	return {
		apply: () => {
			for (const step of steps) step.apply()
		},
		revert: () => {
			for (let k = steps.length - 1; k >= 0; k--) steps[k]?.revert()
		}
	}
}

// Parts placed over the cut's or the paste's cells that cannot go with them: notes, mapped cells, a pivot table, a
// table's header (a header cell names its column).
async function placedParts(workbook: XlsxWorkbookModel, entry: XlsxSheetEntry, model: XlsxSheetModel, sheet: SheetMove): Promise<void> {
	const state = refState(workbook)

	for (const relationship of liveRelationships(workbook, entry.part, model.relationships.all)) {
		const type = lastSegment(relationship.type)

		if (relationship.external || relationship.partName === undefined) continue
		if (type !== "comments" && type !== "threadedComment" && type !== "tableSingleCells" && type !== "pivotTable" && type !== "table")
			continue

		const bytes = await state.partBytes(relationship.partName)

		if (bytes === null) continue

		if (type === "table") {
			const table = readTable(relationship.partName, "", entry.id, relationship.id, bytes, [])
			const header = { ...table.ref, endRow: table.ref.startRow + table.headerRows - 1 }

			if (sheet.onSource && table.headerRows > 0 && intersects(header, sheet.move.range)) refuse("tableHeader", "table")

			continue
		}

		const { document } = editMarkup(bytes, type)

		for (const node of descendants(document, document.documentElement())) {
			const local = document.localName(node)
			const text =
				local === "comment" || local === "threadedComment"
					? document.attribute(node, "ref")
					: local === "singleXmlCell"
						? document.attribute(node, "r")
						: local === "location"
							? document.attribute(node, "ref")
							: undefined
			const range = text === undefined ? null : parseRef(text)

			if (range !== null && sheet.touched.some(touched => intersects(range, touched)))
				refuse(type === "pivotTable" ? "pivot" : "structureLocked", type)
		}
	}
}

// A refusal from inside a rewrite names the construct it came from.
function named<T>(construct: string, run: () => T): T {
	try {
		return run()
	} catch (error) {
		if (error instanceof RefRefused && error.refusal.detail === "moved cells") refuse(error.refusal.reason, construct)

		throw error
	}
}

// Real-time data topics read cells by the sheet's id (tr r, s).
function volatileMeets(bytes: Uint8Array, workbook: XlsxWorkbookModel, move: CellMove): boolean {
	const text = decodeUtf8(bytes)

	for (const match of text.matchAll(/<(?:\w+:)?tr\b([^>]*)>/g)) {
		const attributes = match[1] ?? ""
		const r = /\sr\s*=\s*"([^"]*)"/.exec(attributes)?.[1]
		const s = Number(/\ss\s*=\s*"([^"]*)"/.exec(attributes)?.[1] ?? "-1")
		const entry = workbook.sheets.find(candidate => candidate.sheetId === s)
		const cell = r === undefined ? null : parseRef(r)

		if (entry === undefined || cell === null) continue
		if (new SheetMove(entry, move).touched.some(range => contains(range, cell))) return true
	}

	return false
}

export async function planMove(workbook: XlsxWorkbookModel, move: CellMove, slicing?: Slicing): Promise<MovePlanResult> {
	try {
		return { ok: true, plan: await plan(workbook, move, slicing) }
	} catch (error) {
		if (error instanceof RefRefused) return { ok: false, refusal: error.refusal }

		throw error
	}
}
