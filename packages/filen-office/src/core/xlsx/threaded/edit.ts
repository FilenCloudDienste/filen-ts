import { relativeTarget } from "../../opc/partNames"
import { SHEET_MAX_COLS, SHEET_MAX_ROWS, type SheetId, type SheetRefusal } from "../../sheet/protocol"
import type { SheetChangeSink, SheetHandled } from "../../sheet/registry"
import { cellKeyCol, cellKeyRow } from "../../sheet/model/model"
import { parseXml } from "../../xml/index"
import { noteTarget, writeSheetNotes, MAX_NOTE_TEXT, type NoteTarget } from "../comments/edit"
import { removeNotes } from "../comments/notes"
import {
	AnnotationWrites,
	COMMENTS_TYPE,
	freePartName,
	partFolder,
	PERSON_RELATIONSHIP,
	PERSON_TYPE,
	THREADED_RELATIONSHIP,
	THREADED_TYPE,
	VML_TYPE
} from "../comments/parts"
import { annotationStore, type AnnotationStore } from "../comments/store"
import { removeNoteShapes } from "../comments/vml"
import type { XlsxDocument } from "../edit/document"
import { cellKeyOf } from "../edit/history"
import { newGuid } from "../edit/sheetCopy"
import { namespacesOf } from "../write/namespaces"
import {
	addComment,
	addPerson,
	editComment,
	emptyPersons,
	emptyThreaded,
	findPerson,
	placeholderText,
	readPersons,
	readThreaded,
	removeComments,
	type Thread,
	type ThreadedPart
} from "./threads"

// Threaded comments edited: the sheet's threaded comments part (created with its relationship when it has none),
// the author's person in the workbook's persons part (created likewise), and the thread's placeholder note in the
// legacy comments part with its shape, kept to the thread's text as Excel keeps it.

function pad(value: number, width = 2): string {
	return String(value).padStart(width, "0")
}

// xsd:dateTime as Excel writes dT: local time to hundredths, no zone.
export function commentTime(ms: number): string {
	const date = new Date(ms)

	return (
		`${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
		`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(Math.floor(date.getMilliseconds() / 10))}`
	)
}

function threadsUnavailable(store: AnnotationStore, sheet: SheetId): SheetRefusal | null {
	const reason = store.failure(sheet, "threads")

	return reason === null ? null : { reason: "notesUnavailable", detail: reason }
}

export function threadsRefusal(document: XlsxDocument, sheet: SheetId): SheetRefusal | null {
	const entry = document.entry(sheet)

	if (entry === undefined || entry.kind !== "worksheet") return { reason: "unsupported", detail: "sheet" }

	const store = annotationStore(document.workbook)

	return (
		threadsUnavailable(store, sheet) ??
		((store.failure(sheet, "notes") ?? store.failure(sheet, "drawing")) ? { reason: "notesUnavailable" } : null)
	)
}

async function threadTarget(document: XlsxDocument, sheet: SheetId): Promise<NoteTarget | { readonly refused: SheetRefusal }> {
	const target = await noteTarget(document, sheet)

	if ("refused" in target) return target

	const refusal = threadsUnavailable(annotationStore(document.workbook), sheet)

	return refusal === null ? target : { refused: refusal }
}

// The placeholder cut to a note's limit (never inside a surrogate pair): only readers without threads see it, and
// the threaded part keeps every comment whole.
function noteSized(text: string): string {
	if (text.length <= MAX_NOTE_TEXT) return text

	const code = text.charCodeAt(MAX_NOTE_TEXT - 1)

	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? MAX_NOTE_TEXT - 1 : MAX_NOTE_TEXT)
}

// The thread's placeholder note brought to its comments (written, or removed with its shape when the thread went).
async function syncPlaceholder(
	document: XlsxDocument,
	target: NoteTarget,
	row: number,
	col: number,
	rootId: string,
	writes: AnnotationWrites
): Promise<boolean> {
	const store = annotationStore(document.workbook)
	const thread = store.threadedOf(target.sheet)?.threads.get(cellKeyOf(row, col))

	if (thread !== undefined && thread.root.id === rootId) {
		return writeSheetNotes(
			document,
			target,
			[
				{
					row,
					col,
					author: `tc=${rootId}`,
					text: noteSized(placeholderText([thread.root.text, ...thread.replies.map(reply => reply.text)])),
					uid: rootId,
					plain: true
				}
			],
			writes
		)
	}

	const comments = store.commentsOf(target.sheet)
	const parts = store.parts(target.sheet)
	const key = cellKeyOf(row, col)

	if (comments === null || parts.comments === null || comments.notes.get(key)?.thread !== rootId) return true

	writes.setPart(parts.comments, COMMENTS_TYPE, removeNotes(comments, new Set([key])))

	const vml = store.vmlOf(target.sheet)

	if (vml !== null && parts.vml !== null && vml.notes.has(key)) writes.setPart(parts.vml, VML_TYPE, removeNoteShapes(vml, new Set([key])))

	return true
}

// The id of the session author's person, added to the persons part (made when there is none) when it is not there;
// null when the part is there but was not read.
function personFor(document: XlsxDocument, author: string, writes: AnnotationWrites): string | null {
	const workbook = document.workbook
	const store = annotationStore(workbook)
	let name = store.personsPart()
	const existing = findPerson(store.personsOf(), author)

	if (existing !== undefined) return existing.id

	let part = store.personsOf()

	if (name === null) {
		name = freePartName(workbook, n => `${partFolder(workbook)}persons/person${n === 1 ? "" : String(n)}.xml`)
		writes.addRelationship(workbook.workbookPart, { type: PERSON_RELATIONSHIP, target: relativeTarget(workbook.workbookPart, name) })
		part = readPersons(parseXml(emptyPersons(namespacesOf(workbook.strict).main)))
	}

	if (part === null) return null

	const id = newGuid()

	writes.setPart(name, PERSON_TYPE, addPerson(part, { id, displayName: author, userId: author, providerId: "None" }))

	return id
}

function inGrid(row: number, col: number): boolean {
	return Number.isInteger(row) && Number.isInteger(col) && row >= 0 && col >= 0 && row < SHEET_MAX_ROWS && col < SHEET_MAX_COLS
}

function look(sheet: SheetId, row: number, col: number): (changes: SheetChangeSink) => void {
	return changes => changes.look(sheet, { startRow: row, startCol: col, endRow: row, endCol: col })
}

function finish(writes: AnnotationWrites, ok: boolean, tell: (changes: SheetChangeSink) => void, changes: SheetChangeSink): SheetHandled {
	if (!ok) {
		writes.undo()

		return { refused: { reason: "notesUnavailable", detail: "legacy drawing" } }
	}

	tell(changes)

	return writes.step(tell)
}

// A comment on a cell: a new thread, or a reply to the cell's thread.
export async function addThreadComment(
	document: XlsxDocument,
	sheet: SheetId,
	row: number,
	col: number,
	text: string,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	if (!inGrid(row, col)) return { refused: { reason: "tooLarge" } }
	if (text.length > MAX_NOTE_TEXT) return { refused: { reason: "tooLarge", detail: "comment" } }
	if (text.trim() === "") return null

	const author = document.settings.author

	if (author === undefined || author === "") return { refused: { reason: "authorNeeded" } }

	const target = await threadTarget(document, sheet)

	if ("refused" in target) return target

	const workbook = document.workbook
	const store = annotationStore(workbook)
	const key = cellKeyOf(row, col)
	const current = store.threadedOf(sheet)
	const thread: Thread | undefined = current?.threads.get(key)
	const note = store.commentsOf(sheet)?.notes.get(key)

	// A cell holds a note or a thread, not both.
	if (thread === undefined && note !== undefined && (note.thread === null || current?.comments.has(note.thread) !== true))
		return { refused: { reason: "unsupported", detail: "note" } }

	const writes = new AnnotationWrites(workbook)
	const personId = personFor(document, author, writes)

	if (personId === null) return { refused: { reason: "notesUnavailable", detail: "persons" } }

	let name = store.parts(sheet).threaded
	let part: ThreadedPart | null = current

	if (name === null) {
		name = freePartName(workbook, n => `${partFolder(workbook)}threadedComments/threadedComment${String(n)}.xml`)
		writes.addRelationship(target.part, { type: THREADED_RELATIONSHIP, target: relativeTarget(target.part, name) })
		part = readThreaded(parseXml(emptyThreaded(namespacesOf(workbook.strict).main)))
	}

	if (part === null) return { refused: { reason: "notesUnavailable", detail: "threaded comments" } }

	const id = newGuid()
	const rootId = thread?.root.id ?? id

	writes.setPart(
		name,
		THREADED_TYPE,
		addComment(part, {
			row,
			col,
			id,
			parentId: thread === undefined ? null : rootId,
			personId,
			date: commentTime(document.settings.clock?.() ?? Date.now()),
			text
		})
	)

	return finish(writes, await syncPlaceholder(document, target, row, col, rootId, writes), look(sheet, row, col), changes)
}

function isOwn(store: AnnotationStore, personId: string, author: string | undefined): boolean {
	const person = store.personsOf()?.persons.get(personId)

	return author !== undefined && author !== "" && person !== undefined && person.displayName === author
}

// A comment of the session's author edited.
export async function editThreadComment(
	document: XlsxDocument,
	sheet: SheetId,
	id: string,
	text: string,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	if (text.length > MAX_NOTE_TEXT) return { refused: { reason: "tooLarge", detail: "comment" } }

	const target = await threadTarget(document, sheet)

	if ("refused" in target) return target

	const store = annotationStore(document.workbook)
	const part = store.threadedOf(sheet)
	const name = store.parts(sheet).threaded
	const found = part?.comments.get(id.toUpperCase())

	if (part === null || name === null || found === undefined) return { refused: { reason: "unsupported", detail: "comment" } }
	if (!isOwn(store, found.comment.personId, document.settings.author)) return { refused: { reason: "notOwnComment" } }
	// Mentions point into the text by offsets: an edit would leave them pointing at other text.
	if (found.comment.mentions) return { refused: { reason: "unsupported", detail: "mentions" } }
	if (found.comment.text === text || text.trim() === "") return null

	const bytes = editComment(part, id, text)

	if (bytes === null) return null

	const writes = new AnnotationWrites(document.workbook)

	writes.setPart(name, THREADED_TYPE, bytes)

	const row = cellKeyRow(found.key)
	const col = cellKeyCol(found.key)
	const rootId = found.comment.parentId ?? found.comment.id

	return finish(writes, await syncPlaceholder(document, target, row, col, rootId, writes), look(sheet, row, col), changes)
}

// A reply deleted, or a whole thread with its first comment.
export async function deleteThreadComment(
	document: XlsxDocument,
	sheet: SheetId,
	id: string,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const target = await threadTarget(document, sheet)

	if ("refused" in target) return target

	const store = annotationStore(document.workbook)
	const part = store.threadedOf(sheet)
	const name = store.parts(sheet).threaded
	const found = part?.comments.get(id.toUpperCase())

	if (part === null || name === null || found === undefined) return null

	const writes = new AnnotationWrites(document.workbook)

	writes.setPart(name, THREADED_TYPE, removeComments(part, new Set([found.comment.id])))

	const row = cellKeyRow(found.key)
	const col = cellKeyCol(found.key)

	return finish(
		writes,
		await syncPlaceholder(document, target, row, col, found.comment.parentId ?? found.comment.id, writes),
		look(sheet, row, col),
		changes
	)
}
