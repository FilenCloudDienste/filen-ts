import { partKey } from "../../opc/partNames"
import { SHEET_MAX_COLS, type SheetColorInput, type SheetId, type SheetState } from "../../sheet/protocol"
import { defineSheetFeature, type SheetChangeSink, type SheetHandled } from "../../sheet/registry"
import { ChangeLog } from "../model/changes"
import { FormulaTable } from "../model/formulas"
import type { SheetStore } from "../model/store"
import {
	FormulaKind,
	type XlsxColor,
	type XlsxDefinedName,
	type XlsxPartWrite,
	type XlsxSheetEntry,
	type XlsxWorkbookModel
} from "../model/types"
import { planRefEdit, type RefPlan } from "../refs/plan"
import { liveRelationships } from "../refs/state"
import type { XlsxDocument } from "./document"
import { reportLogged, xlsxColor } from "./format"
import { CellLog, cellState } from "./history"
import { cellBounds, planBytes, planCellsOf } from "./structure-basic"
import { setSheetView } from "./structure-view"

// Sheets deleted, moved, hidden and shown, and their tab colours (sheet duplication: sheetCopy.ts). A delete or a
// move goes through the references catalogue: references to a deleted sheet become #REF! as in Excel
// (support.microsoft.com, "#REF! error"), its local names go, 3-D spans narrow; what refers to sheets by position
// follows the new order or refuses.

declare module "../../sheet/protocol" {
	interface SheetCommandMap {
		"sheet.delete": { readonly sheet: SheetId }
		// `to`: the sheet's position in the order after the move.
		"sheet.move": { readonly sheet: SheetId; readonly to: number }
		// Hidden or shown (veryHidden: only code shows it again, as in Excel).
		"sheet.state": { readonly sheet: SheetId; readonly state: SheetState }
		// null takes the colour off.
		"sheet.tabColor": { readonly sheet: SheetId; readonly color: SheetColorInput | null }
	}
}

const RELS = /(^|\/)_rels\/([^/]*)\.rels$/

// The part a relationships part belongs to ("" for the package's own).
function relsSource(name: string): string | null {
	const match = RELS.exec(name)

	if (match === null) return null

	return `${name.slice(0, match.index)}${match[1] ?? ""}${match[2] ?? ""}`
}

// The parts only `entry` reaches: its own part and what its relationships lead to (drawings, their charts,
// comments, tables, ...) when nothing outside them refers to it too.
export async function ownedParts(workbook: XlsxWorkbookModel, entry: XlsxSheetEntry): Promise<string[]> {
	const owned = new Map<string, string>([[partKey(entry.part), entry.part]])
	const queue = [entry.part]

	while (queue.length > 0) {
		const source = queue.shift() as string
		const read = (await workbook.parts.relationships(source)).all

		for (const relationship of liveRelationships(workbook, source, read)) {
			if (relationship.external || relationship.partName === undefined) continue

			const key = partKey(relationship.partName)

			if (owned.has(key)) continue

			owned.set(key, relationship.partName)
			queue.push(relationship.partName)
		}
	}

	// Parts something else reaches stay.
	const shared = new Set<string>()
	const sources = new Set<string>()

	for (const part of workbook.parts.parts()) {
		const source = relsSource(part.name)

		if (source !== null) sources.add(source)
	}

	for (const source of workbook.changes.relationships.keys()) sources.add(source)

	for (const source of sources) {
		if (owned.has(partKey(source))) continue

		const read = (await workbook.parts.relationships(source)).all

		for (const relationship of liveRelationships(workbook, source, read))
			if (!relationship.external && relationship.partName !== undefined) shared.add(partKey(relationship.partName))
	}

	// What a part that stays reaches stays too (a pivot cache the workbook lists keeps its records).
	const kept = [...owned].filter(([key]) => key !== partKey(entry.part) && shared.has(key)).map(([, name]) => name)

	while (kept.length > 0) {
		const source = kept.shift() as string

		for (const relationship of liveRelationships(workbook, source, (await workbook.parts.relationships(source)).all)) {
			if (relationship.external || relationship.partName === undefined) continue

			const key = partKey(relationship.partName)

			if (shared.has(key) || key === partKey(entry.part)) continue

			shared.add(key)

			if (owned.has(key)) kept.push(relationship.partName)
		}
	}

	return [...owned].filter(([key]) => key === partKey(entry.part) || !shared.has(key)).map(([, name]) => name)
}

// The defined names an edit changed or dropped, upper case: `before` against the workbook's names now.
export function changedNames(document: XlsxDocument, before: readonly XlsxDefinedName[]): Set<string> {
	const key = (name: XlsxDefinedName): string => `${name.name.toUpperCase()}\n${String(name.sheet)}`
	const after = new Map(document.workbook.definedNames.map(name => [key(name), name.formula]))
	const changed = new Set<string>()

	for (const name of before) if (after.get(key(name)) !== name.formula) changed.add(name.name.toUpperCase())

	return changed
}

// `names` (upper case) with every defined name whose formula names one of them, through any number of others (Total =
// SUM(N) changes with N): what reads those is read by the same test of a formula's text. Over-inclusive as that test is
// (text, not tokens), which costs a recalculation, never a missed one.
function withReaders(document: XlsxDocument, names: ReadonlySet<string>): Set<string> {
	const all = new Set(names)
	const defined = document.workbook.definedNames.map(name => ({ name: name.name.toUpperCase(), text: name.formula.toUpperCase() }))

	for (let added = true; added;) {
		added = false

		for (const { name, text } of defined) {
			if (all.has(name)) continue

			for (const known of all) {
				if (!text.includes(known)) continue

				all.add(name)
				added = true

				break
			}
		}
	}

	return all
}

// After the engine's sheets changed (a sheet deleted or added, formulas rewritten): it is built again, and the
// formulas the plan rewrote, those naming a changed name (or a name defined through one) and those calling INDIRECT
// (whose sheet names may name another sheet now) are recalculated (logged), with every formula reading any of them
// whose stored result is no longer the engine's; with none of them the next edit builds it.
export function rebuildEngine(
	document: XlsxDocument,
	plan: RefPlan,
	changed: ReadonlySet<string>,
	log: CellLog,
	changes: SheetChangeSink
): void {
	const cells = document.indirectCells()

	document.dropEngine()

	if ((plan.formulaCells.size === 0 && changed.size === 0 && cells.size === 0) || !document.hasFormulas || !document.allReady) return

	// What the session shows before the build: the build shows results of its own (volatile formulas calculated
	// again, formulas the file stores none for), logged here as they were so an undo gives those back too.
	const shownBefore = new Map([...document.shownResults].map(([sheet, shown]) => [sheet, new Map(shown)]))

	document.buildEngine(changes)

	for (const [sheet, shown] of document.shownResults) {
		const model = document.model(sheet)
		const before = shownBefore.get(sheet)

		if (model === null) continue

		for (const [key, result] of shown) {
			const was = before?.get(key)

			if (
				was !== undefined &&
				was.value === result.value &&
				was.error === result.error &&
				was.edited === result.edited &&
				was.recalculated === result.recalculated
			)
				continue

			const row = Math.floor(key / SHEET_MAX_COLS)
			const col = key % SHEET_MAX_COLS

			log.touch(sheet, row, col, () => cellState(model.store, row, col, was), false)
		}
	}

	for (const [sheet] of plan.formulaCells) cells.set(sheet, [...(cells.get(sheet) ?? []), ...planCellsOf(plan, sheet)])

	if (changed.size > 0) {
		const named = [...withReaders(document, changed)]
		const naming = (text: string): boolean => {
			const upper = text.toUpperCase()

			return named.some(name => upper.includes(name))
		}

		for (const entry of document.workbook.sheets) {
			const store = entry.model?.store as SheetStore | undefined

			if (store === undefined) continue

			const list = cells.get(entry.id) ?? []
			const formulas = store.formulas
			// A shared formula's cells by its index, tested once on the master's text: a child stores none, and a
			// defined name is not moved with the relative references.
			const sharedNaming = new Map<number, boolean>()

			for (const block of store.blocks) {
				if (block.formulas === null) continue

				for (let i = 0; i < block.rowCount; i++) {
					for (let k = block.rowStarts[i] ?? 0; k < (block.rowStarts[i + 1] ?? 0); k++) {
						const id = block.formulas[k] ?? -1

						if (id < 0) continue

						const kind = formulas.kind(id)
						let hit: boolean

						if (kind === FormulaKind.SHARED_CHILD || kind === FormulaKind.SHARED_MASTER) {
							const shared = formulas.sharedIndex(id)
							const known = sharedNaming.get(shared)

							if (known === undefined) {
								const master = formulas instanceof FormulaTable ? formulas.master(shared) : id

								hit = naming(master < 0 ? "" : formulas.text(master))
								sharedNaming.set(shared, hit)
							} else hit = known
						} else hit = naming(formulas.text(id))

						if (hit) list.push({ row: block.firstRow + (block.rows[i] ?? 0), col: block.cols[k] ?? 0 })
					}
				}
			}

			if (list.length > 0) cells.set(entry.id, list)
		}
	}

	// The engine built again holds the new values already: setting these cells reports them only, so what reads them
	// (a changed name or formula, through any number of others) is compared with the store here.
	for (const [sheet, list] of document.staleReaders(cells)) cells.set(sheet, [...(cells.get(sheet) ?? []), ...list])

	for (const [sheet, list] of cells) document.recalculate(sheet, list, log, changes)

	log.seal((s, r, c) => document.state(s, r, c))
}

function reportPlan(plan: RefPlan, sink: SheetChangeSink, log: CellLog): void {
	for (const [sheet] of plan.formulaCells) {
		const bounds = cellBounds(planCellsOf(plan, sheet))

		if (bounds !== null) sink.content(sheet, bounds)
	}

	reportLogged(log, sink, "content")
	sink.sheets()
}

// The tab shown after the sheet at `index` goes or hides: the next visible one, else the one before.
function nextVisible(sheets: readonly XlsxSheetEntry[], index: number): number {
	for (let k = index + 1; k < sheets.length; k++) if (sheets[k]?.state === "visible") return k
	for (let k = index - 1; k >= 0; k--) if (sheets[k]?.state === "visible") return k

	return -1
}

// The views' selected tab follows the active sheet (a hidden sheet is never the selected one). Returns the undo.
function selectTab(document: XlsxDocument, from: XlsxSheetEntry | undefined, to: XlsxSheetEntry | undefined): () => void {
	const undos: (() => void)[] = []

	for (const [entry, selected] of [
		[from, false],
		[to, true]
	] as const) {
		const model = entry?.model ?? null

		if (model === null || model.view.tabSelected === selected) continue

		undos.push(setSheetView(document.workbook, model, { ...model.view, tabSelected: selected }))
	}

	return () => {
		for (const undo of undos.reverse()) undo()
	}
}

function setActive(document: XlsxDocument, index: number): void {
	const workbook = document.workbook

	if (workbook.activeTab === index) return

	workbook.activeTab = index
	workbook.changes.workbookSection("bookViews")
}

// sheet.delete: the sheet and the parts only it reaches go; references to it become #REF!.
export async function deleteSheet(document: XlsxDocument, sheet: SheetId, changes: SheetChangeSink): Promise<SheetHandled> {
	const workbook = document.workbook
	const sheets = workbook.sheets
	const index = sheets.findIndex(entry => entry.id === sheet)
	const entry = sheets[index]

	if (entry === undefined) return { refused: { reason: "unsupported", detail: "sheet" } }
	if (!sheets.some(other => other !== entry && other.state === "visible")) return { refused: { reason: "lastSheet" } }

	await document.readyAllSheets()

	if (!document.allReady) return { refused: { reason: "structureLocked", detail: "unreadSheet" } }

	const planned = await planRefEdit(workbook, { kind: "deleteSheet", sheet })

	if (!planned.ok) return { refused: planned.refusal }

	const plan = planned.plan
	const namesBefore = workbook.definedNames.slice()
	const parts = await ownedParts(workbook, entry)
	const changeLog = workbook.changes
	// What each part was before (an earlier edit may have written it).
	const previous = parts.map(name => ({ name, write: changeLog.parts.get(name) }))
	// A sheet added since open has a relationship the change log added (an undo adds it again).
	const relationship = changeLog.relationships.get(workbook.workbookPart)?.added.find(added => added.id === entry.relationshipId)
	const activeBefore = workbook.activeTab
	const active = sheets[activeBefore]
	const shownAfter = active === entry ? nextVisible(sheets, index) : activeBefore
	const nextActive = sheets[shownAfter]
	const results = document.shownResults.get(sheet)
	const log = new CellLog()
	let unselect: () => void = () => undefined

	const forward = (): void => {
		plan.apply()
		sheets.splice(index, 1)

		for (const name of parts) changeLog.removePart(name)

		changeLog.removeRelationship(workbook.workbookPart, entry.relationshipId)
		changeLog.workbookSection("sheets")
		document.shownResults.delete(sheet)
		setActive(document, nextActive === undefined ? 0 : sheets.indexOf(nextActive))
		unselect = active === entry ? selectTab(document, undefined, nextActive) : () => undefined
		document.structureChanged()
	}

	forward()
	await document.loadTables()
	rebuildEngine(document, plan, changedNames(document, namesBefore), log, changes)
	reportPlan(plan, changes, log)

	return {
		bytes: planBytes(plan) + log.bytes,
		undo: async sink => {
			log.restore(document.restoreCell, "before")
			unselect()
			document.dropEngine()

			if (results !== undefined) document.shownResults.set(sheet, results)

			if (relationship !== undefined) changeLog.readdRelationship(workbook.workbookPart, relationship)
			else if (changeLog instanceof ChangeLog) changeLog.restoreRelationship(workbook.workbookPart, entry.relationshipId)

			for (const { name, write } of previous) {
				if (write === undefined) changeLog.restorePart(name)
				else if (write === null) changeLog.removePart(name)
				else changeLog.writePart(name, write as XlsxPartWrite)
			}

			sheets.splice(index, 0, entry)
			workbook.activeTab = activeBefore
			plan.revert()
			document.structureChanged()
			await document.loadTables()
			reportPlan(plan, sink, log)
		},
		redo: async sink => {
			forward()
			document.dropEngine()
			await document.loadTables()
			log.restore(document.restoreCell, "after")
			reportPlan(plan, sink, log)
		}
	}
}

// sheet.move: the sheet to position `to`; 3-D spans whose ends swapped are written in the new order.
export async function moveSheet(document: XlsxDocument, sheet: SheetId, to: number, changes: SheetChangeSink): Promise<SheetHandled> {
	const workbook = document.workbook
	const sheets = workbook.sheets
	const index = sheets.findIndex(entry => entry.id === sheet)
	const entry = sheets[index]

	if (entry === undefined) return { refused: { reason: "unsupported", detail: "sheet" } }
	if (!Number.isInteger(to) || to < 0 || to >= sheets.length) return { refused: { reason: "tooLarge" } }
	if (to === index) return null

	await document.readyAllSheets()

	if (!document.allReady) return { refused: { reason: "structureLocked", detail: "unreadSheet" } }

	const planned = await planRefEdit(workbook, { kind: "moveSheet", sheet, to })

	if (!planned.ok) return { refused: planned.refusal }

	const plan = planned.plan
	const namesBefore = workbook.definedNames.slice()
	const active = sheets[workbook.activeTab]
	const activeBefore = workbook.activeTab
	const log = new CellLog()
	const order = (which: "before" | "after"): void => {
		sheets.splice(sheets.indexOf(entry), 1)
		sheets.splice(which === "after" ? to : index, 0, entry)
		workbook.changes.workbookSection("sheets")

		if (which === "before") workbook.activeTab = activeBefore
		else if (active !== undefined) setActive(document, sheets.indexOf(active))
	}

	plan.apply()
	order("after")

	const names = changedNames(document, namesBefore)

	if (plan.formulaCells.size > 0 || names.size > 0) rebuildEngine(document, plan, names, log, changes)

	reportPlan(plan, changes, log)

	return {
		bytes: planBytes(plan) + log.bytes,
		undo: sink => {
			log.restore(document.restoreCell, "before")
			order("before")
			plan.revert()

			if (plan.formulaCells.size > 0 || names.size > 0) document.dropEngine()

			reportPlan(plan, sink, log)
		},
		redo: sink => {
			plan.apply()
			order("after")

			if (plan.formulaCells.size > 0 || names.size > 0) document.dropEngine()

			log.restore(document.restoreCell, "after")
			reportPlan(plan, sink, log)
		}
	}
}

// sheet.state: hidden or shown. The last visible sheet stays; a hidden active sheet gives way to the next one.
export async function setSheetState(
	document: XlsxDocument,
	sheet: SheetId,
	state: SheetState,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const workbook = document.workbook
	const sheets = workbook.sheets
	const index = sheets.findIndex(entry => entry.id === sheet)
	const entry = sheets[index]

	if (entry === undefined) return { refused: { reason: "unsupported", detail: "sheet" } }
	if (state !== "visible" && state !== "hidden" && state !== "veryHidden") return { refused: { reason: "unsupported", detail: "state" } }
	if (entry.state === state) return null
	if (state !== "visible" && !sheets.some(other => other !== entry && other.state === "visible"))
		return { refused: { reason: "lastSheet" } }

	await document.ready(sheet).catch(() => undefined)

	const before = entry.state
	const activeBefore = workbook.activeTab
	const active = sheets[activeBefore]
	let unselect: () => void = () => undefined
	const apply = (which: "before" | "after"): void => {
		entry.state = which === "after" ? state : before
		workbook.changes.workbookSection("sheets")

		if (which === "before") {
			unselect()
			workbook.activeTab = activeBefore
		} else if (active === entry && state !== "visible") {
			const next = sheets[nextVisible(sheets, index)]

			setActive(document, next === undefined ? 0 : sheets.indexOf(next))
			unselect = selectTab(document, entry, next)
		}
	}

	apply("after")
	changes.sheets()

	return {
		bytes: 128,
		undo: sink => {
			apply("before")
			sink.sheets()
		},
		redo: sink => {
			apply("after")
			sink.sheets()
		}
	}
}

function sameColor(a: XlsxColor | null, b: XlsxColor | null): boolean {
	if (a === null || b === null) return a === b

	return a.argb === b.argb && a.theme === b.theme && a.tint === b.tint && a.indexed === b.indexed && a.auto === b.auto
}

// sheet.tabColor: written into the sheet's properties (§18.3.1.82 sheetPr tabColor).
export async function setTabColor(
	document: XlsxDocument,
	sheet: SheetId,
	color: SheetColorInput | null,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const entry = document.entry(sheet)

	if (entry === undefined || entry.kind !== "worksheet") return { refused: { reason: "unsupported", detail: "sheet" } }

	const model = await document.ready(sheet)
	const before = model.tabColor
	const after = color === null ? null : xlsxColor(color)

	if (sameColor(before, after)) return null

	const apply = (value: typeof before, sink: SheetChangeSink): void => {
		model.tabColor = value
		document.workbook.changes.sheetSection(sheet, "sheetPr")
		sink.sheets()
	}

	apply(after, changes)

	return { bytes: 64, undo: sink => apply(before, sink), redo: sink => apply(after, sink) }
}

export const sheetOpsFeature = defineSheetFeature<XlsxDocument>({
	id: "sheetOps",
	commands: {
		"sheet.delete": {
			info: { write: true, structure: true },
			run: (context, command) => deleteSheet(context.doc, command.sheet, context.changes)
		},
		"sheet.move": {
			info: { write: true, structure: true },
			run: (context, command) => moveSheet(context.doc, command.sheet, command.to, context.changes)
		},
		"sheet.state": {
			info: { write: true, structure: true },
			run: (context, command) => setSheetState(context.doc, command.sheet, command.state, context.changes)
		},
		"sheet.tabColor": {
			info: { write: true, structure: true },
			run: (context, command) => setTabColor(context.doc, command.sheet, command.color, context.changes)
		}
	}
})
