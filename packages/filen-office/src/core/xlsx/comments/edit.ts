import { relativeTarget } from "../../opc/partNames"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetId, type SheetRange, type SheetRefusal } from "../../sheet/protocol"
import type { SheetChangeSink, SheetHandled } from "../../sheet/registry"
import { decodeUtf8, escapeAttribute, parseXml } from "../../xml/index"
import type { XlsxDocument } from "../edit/document"
import { cellKeyOf } from "../edit/history"
import { newGuid } from "../edit/sheetCopy"
import type { XlsxSheetModel, XlsxWorkbookModel } from "../model/types"
import { namespacesOf } from "../write/namespaces"
import { emptyComments, readComments, removeNotes, writeNotes, type CommentsPart, type NoteWrite } from "./notes"
import { AnnotationWrites, COMMENTS_TYPE, commentsRelationship, freePartName, partFolder, VML_TYPE, vmlRelationship } from "./parts"
import { annotationStore, type AnnotationStore } from "./store"
import { addNoteShapes, idBlocks, newVml, removeNoteShapes, showNoteShape, type VmlPart } from "./vml"

// Notes edited: the comments part and the note shapes of the legacy drawing changed together, and both created
// (with their relationships and the sheet's legacyDrawing) when the sheet has none. Excel's limit on a note's text
// is a cell's (32,767 characters).

export const MAX_NOTE_TEXT = 32_767

function unavailable(store: AnnotationStore, sheet: SheetId): SheetRefusal | null {
	const reason = store.failure(sheet, "notes") ?? store.failure(sheet, "drawing")

	return reason === null ? null : { reason: "notesUnavailable", detail: reason }
}

// Why notes cannot be edited on a sheet now (before its parts were read: nothing known against it).
export function notesRefusal(document: XlsxDocument, sheet: SheetId): SheetRefusal | null {
	const entry = document.entry(sheet)

	if (entry === undefined || entry.kind !== "worksheet") return { reason: "unsupported", detail: "sheet" }

	return unavailable(annotationStore(document.workbook), sheet)
}

// The id block for a new legacy drawing or a full one: past every block a legacy drawing of the workbook uses.
async function spareBlock(store: AnnotationStore, workbook: XlsxWorkbookModel): Promise<number> {
	const names = new Set<string>()

	for (const part of workbook.parts.parts())
		if (part.contentType === VML_TYPE || part.name.toLowerCase().endsWith(".vml")) names.add(part.name)
	for (const [name, write] of workbook.changes.parts)
		if (write !== null && (write.contentType === VML_TYPE || name.toLowerCase().endsWith(".vml"))) names.add(name)

	let highest = 0

	for (const name of names) {
		const bytes = await store.current(name)

		if (bytes === null) continue

		for (const match of decodeUtf8(bytes).matchAll(/<(?:[\w.-]+:)?idmap\b[^>]*\sdata\s*=\s*"([^"]*)"/g))
			for (const block of idBlocks(match[1] ?? "")) highest = Math.max(highest, block)
	}

	return highest + 1
}

export interface NoteTarget {
	readonly sheet: SheetId
	readonly model: XlsxSheetModel
	readonly part: string
}

// A sheet ready for a note edit: its parts read, nothing in the way.
export async function noteTarget(document: XlsxDocument, sheet: SheetId): Promise<NoteTarget | { readonly refused: SheetRefusal }> {
	const entry = document.entry(sheet)

	if (entry === undefined || entry.kind !== "worksheet") return { refused: { reason: "unsupported", detail: "sheet" } }

	const store = annotationStore(document.workbook)

	try {
		await store.load(document, sheet)
		await document.ready(sheet)
	} catch (error) {
		// The sheet itself does not read: nothing on it can be edited.
		return { refused: { reason: "notesUnavailable", detail: error instanceof Error ? error.message : String(error) } }
	}

	const refusal = unavailable(store, sheet)

	if (refusal !== null) return { refused: refusal }

	const model = document.model(sheet)

	if (model === null) return { refused: { reason: "unsupported", detail: "sheet" } }

	await document.workbook.parts.relationships(entry.part)

	return { sheet, model, part: entry.part }
}

// Notes written into a sheet's parts, creating them when it has none; new notes get shapes. Returns false when the
// legacy drawing cannot take another shape.
export async function writeSheetNotes(
	document: XlsxDocument,
	target: NoteTarget,
	notes: readonly NoteWrite[],
	writes: AnnotationWrites
): Promise<boolean> {
	const workbook = document.workbook
	const store = annotationStore(workbook)
	const parts = store.parts(target.sheet)
	const main = namespacesOf(workbook.strict).main
	let comments = parts.comments
	let current: CommentsPart

	if (comments === null) {
		comments = freePartName(workbook, n => `${partFolder(workbook)}comments${String(n)}.xml`)
		writes.addRelationship(target.part, { type: commentsRelationship(workbook), target: relativeTarget(target.part, comments) })
		current = readComments(parseXml(emptyComments(main)))
	} else {
		const found = store.commentsOf(target.sheet)

		if (found === null) return false

		current = found
	}

	const fresh = notes.filter(note => !current.notes.has(cellKeyOf(note.row, note.col)))

	writes.setPart(comments, COMMENTS_TYPE, writeNotes(current, notes, workbook.styles.fonts[0]))

	if (fresh.length === 0) return true

	// Read once: nothing between here and its use below changes the sheet's parts.
	const vml = store.vmlOf(target.sheet)
	const shapes = fresh.filter(note => vml?.notes.has(cellKeyOf(note.row, note.col)) !== true)

	if (shapes.length === 0) return true

	if (parts.vml === null) {
		if (parts.vmlRelationship !== null) return false

		const name = freePartName(workbook, n => `${partFolder(workbook)}drawings/vmlDrawing${String(n)}.vml`)
		const block = await spareBlock(store, workbook)
		const relationship = writes.addRelationship(target.part, {
			type: vmlRelationship(workbook),
			target: relativeTarget(target.part, name)
		})
		const prefix = target.model.prefix
		const p = prefix === "" ? "" : `${prefix}:`

		writes.setPart(name, VML_TYPE, newVml(block, shapes))
		writes.setSection(target.model, "legacyDrawing", [
			`<${p}legacyDrawing xmlns:r="${namespacesOf(workbook.strict).relationships}" r:id="${escapeAttribute(relationship.id)}"/>`
		])

		return true
	}

	if (vml === null) return false

	const added = addNoteShapes(vml, shapes, null) ?? addNoteShapes(vml, shapes, await spareBlock(store, workbook))

	if (added === null) return false

	writes.setPart(parts.vml, VML_TYPE, added)

	return true
}

function cellRange(row: number, col: number): SheetRange {
	return { startRow: row, startCol: col, endRow: row, endCol: col }
}

function report(
	sheet: SheetId,
	cells: readonly { readonly row: number; readonly col: number }[],
	layout: boolean
): (changes: SheetChangeSink) => void {
	return changes => {
		for (const cell of cells) changes.look(sheet, cellRange(cell.row, cell.col))

		if (layout) changes.layout(sheet)
	}
}

function inGrid(row: number, col: number): boolean {
	return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0 && row < SHEET_MAX_ROWS && col < SHEET_MAX_COLS
}

// A cell's note written: its text replaced, or a new note under the session's author.
export async function setNote(
	document: XlsxDocument,
	sheet: SheetId,
	row: number,
	col: number,
	text: string,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	if (!inGrid(row, col)) return { refused: { reason: "tooLarge" } }
	if (text.length > MAX_NOTE_TEXT) return { refused: { reason: "tooLarge", detail: "note" } }

	const author = document.settings.author

	if (author === undefined || author === "") return { refused: { reason: "authorNeeded" } }

	const target = await noteTarget(document, sheet)

	if ("refused" in target) return target

	const store = annotationStore(document.workbook)
	const key = cellKeyOf(row, col)
	const existing = store.commentsOf(sheet)?.notes.get(key)

	// A thread's placeholder is the thread's: it is edited through the thread.
	const thread = existing?.thread ?? null

	if (thread !== null && store.threadedOf(sheet)?.comments.has(thread) === true)
		return { refused: { reason: "unsupported", detail: "thread" } }
	if (existing !== undefined && existing.text === text) return null

	const writes = new AnnotationWrites(document.workbook)

	if (!(await writeSheetNotes(document, target, [{ row, col, author, text, uid: newGuid() }], writes))) {
		writes.undo()

		return { refused: { reason: "notesUnavailable", detail: "legacy drawing" } }
	}

	const tell = report(sheet, [{ row, col }], false)

	tell(changes)

	return writes.step(tell)
}

// The notes of the cells in `ranges` removed, with their shapes (a thread's placeholder stays with its thread).
export async function deleteNotes(
	document: XlsxDocument,
	sheet: SheetId,
	ranges: readonly SheetRange[],
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const target = await noteTarget(document, sheet)

	if ("refused" in target) return target

	const store = annotationStore(document.workbook)
	const part = store.commentsOf(sheet)
	const threads = store.threadedOf(sheet)
	const vml = store.vmlOf(sheet)
	const keys = new Set<number>()
	const cells: { row: number; col: number }[] = []
	let shown = false

	for (const [key, note] of part?.notes ?? []) {
		if (
			!ranges.some(
				range => note.row >= range.startRow && note.row <= range.endRow && note.col >= range.startCol && note.col <= range.endCol
			)
		)
			continue
		if (note.thread !== null && threads?.comments.has(note.thread) === true) continue

		keys.add(key)
		cells.push({ row: note.row, col: note.col })
		shown ||= vml?.notes.get(key)?.shown === true
	}

	if (part === null || keys.size === 0) return null

	const parts = store.parts(sheet)
	const writes = new AnnotationWrites(document.workbook)

	if (parts.comments !== null) writes.setPart(parts.comments, COMMENTS_TYPE, removeNotes(part, keys))

	if (vml !== null && parts.vml !== null && [...keys].some(key => vml.notes.has(key)))
		writes.setPart(parts.vml, VML_TYPE, removeNoteShapes(vml, keys))

	const tell = report(sheet, cells, shown)

	tell(changes)

	return writes.step(tell)
}

// A note shown all the time, or only when its cell is pointed at.
export async function showNote(
	document: XlsxDocument,
	sheet: SheetId,
	row: number,
	col: number,
	shown: boolean,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	if (!inGrid(row, col)) return { refused: { reason: "tooLarge" } }

	const target = await noteTarget(document, sheet)

	if ("refused" in target) return target

	const store = annotationStore(document.workbook)
	const key = cellKeyOf(row, col)
	const vml: VmlPart | null = store.vmlOf(sheet)
	const vmlName = store.parts(sheet).vml

	if (store.commentsOf(sheet)?.notes.has(key) !== true || vml === null || vmlName === null) return null

	const bytes = showNoteShape(vml, key, shown)

	if (bytes === null) return null

	const writes = new AnnotationWrites(document.workbook)

	writes.setPart(vmlName, VML_TYPE, bytes)

	const tell = report(sheet, [{ row, col }], true)

	tell(changes)

	return writes.step(tell)
}
