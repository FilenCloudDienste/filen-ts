import { partKey, resolvePartName } from "../../opc/partNames"
import type { Relationship } from "../../opc/relationships"
import { parseCellRef, parseRangeRef } from "../../xlsx/write/text"
import { CellKind, type XlsxSection, type XlsxSheetModel, type XlsxWorkbookModel } from "../../xlsx/model/types"
import type { SheetStore } from "../../xlsx/model/store"
import type { SheetRange } from "../../sheet/protocol"
import { decodeUtf8, encodeUtf8, escapeText, NodeKind, parseXml, type XmlDocument } from "../../xml/index"
import type { OdsSource, OdsTableSource } from "../source"
import { SourceAxis } from "./axis"
import { OdsSheet } from "../workbook"
import { paragraphText } from "./cells"
import { sheetValidationsSteps, validationRects, type Rect, type SheetValidations } from "./validations"
import { runSliced, type SliceClock } from "../../slicing"

// The cell features an edit changed, as the writer needs them: each sheet's notes and links as they are now, by
// cell, and the rows where they differ from what the source held there (written again). A feature an edit left alone
// is not read: its cells are copied with the rest.

const COMMENTS_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments"
const HYPERLINK_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"

export interface NoteState {
	readonly text: string
	readonly author: string
}

export interface SheetFeatures {
	// Null: as the source has them.
	readonly notes: ReadonlyMap<string, NoteState> | null
	readonly links: ReadonlyMap<string, string> | null
	readonly validations: SheetValidations | null
	// Target rows a change of these is on.
	readonly rows: ReadonlySet<number>
}

export const NO_FEATURES: SheetFeatures = { notes: null, links: null, validations: null, rows: new Set() }

function key(row: number, col: number): string {
	return `${row},${col}`
}

function children(document: XmlDocument, node: number, local: string): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
		if (document.localName(child) === local) out.push(child)

	return out
}

function text(document: XmlDocument, node: number): string {
	let out = ""

	const walk = (parent: number): void => {
		for (let child = document.firstChild(parent); child >= 0; child = document.nextSibling(child)) {
			const kind = document.kind(child)

			if (kind === NodeKind.Text || kind === NodeKind.CData) out += document.text(child)
			else if (kind === NodeKind.Element && document.localName(child) !== "rPh") walk(child)
		}
	}

	walk(node)

	return out
}

// A comments part's notes by cell.
function readNotes(bytes: Uint8Array | undefined): Map<string, NoteState> {
	const out = new Map<string, NoteState>()

	if (bytes === undefined) return out

	const document = parseXml(bytes)
	const root = document.documentElement()
	const authors = children(document, children(document, root, "authors")[0] ?? -1, "author").map(node => document.textContent(node))

	for (const list of children(document, root, "commentList")) {
		for (const comment of children(document, list, "comment")) {
			const ref = parseCellRef(document.attribute(comment, "ref") ?? "")

			if (ref === null || ref === undefined) continue

			const body = children(document, comment, "text")[0]

			out.set(key(ref.row, ref.col), {
				text: body === undefined ? "" : text(document, body),
				author: authors[Number(document.attribute(comment, "authorId") ?? "0")] ?? ""
			})
		}
	}

	return out
}

// The cells of a range a link can be on, as the save has them: each one holding text (an OpenDocument link is a
// text:a of its cell's text), never the whole rectangle, which a whole-column or whole-sheet link makes millions.
// Overlapping links visit a cell once each, so the visits of a sheet's links are bounded by its cells and this much
// over them: far above any real sheet's overlaps, it stops thousands of whole-sheet links over the same cells.
const MAX_LINK_OVERLAP = 1_048_576

export class LinksRefused extends Error {}

// Counts one visit of a link's cell, refusing past a store's cells and the overlap allowed over them.
export function linkVisits(store: SheetStore): () => void {
	let left = store.cellCount + MAX_LINK_OVERLAP

	return () => {
		if (--left < 0) throw new LinksRefused("The links of a sheet overlap on more cells than the limit")
	}
}

type LinkCells = (range: SheetRange, visit: (row: number, col: number) => void) => void

// The store's cells with text in a range.
function textCells(store: SheetStore): LinkCells {
	return (range, visit) =>
		store.forEachCell(range, (row, col, slot) => {
			if (store.kind(slot) !== CellKind.EMPTY) visit(row, col)
		})
}

// The cells with text now of a range of source cells (deleted rows and columns left out, inserted ones not in it), at
// where they are now. The axes keep order, so the range now runs from its first kept cell to its last.
function movedTextCells(store: SheetStore, rows: SourceAxis, cols: SourceAxis): LinkCells {
	const cells = textCells(store)

	return (range, visit) => {
		const startRow = rows.target(rows.nextKept(range.startRow))
		const endRow = rows.target(rows.previousKept(range.endRow))
		const startCol = cols.target(cols.nextKept(range.startCol))
		const endCol = cols.target(cols.previousKept(range.endCol))

		if (startRow < 0 || endRow < startRow || startCol < 0 || endCol < startCol) return

		cells({ startRow, startCol, endRow, endCol }, (row, col) => {
			if (rows.source(row) >= 0 && cols.source(col) >= 0) visit(row, col)
		})
	}
}

// A hyperlinks section's links by cell, as text:a's xlink:href (a place in the workbook as "#Sheet.A1"), on the
// cells `cells` gives; a link on none of them keeps its first cell (where it is now, `first`), so that a link the
// save cannot write still differs from what it reads back.
function readLinks(
	markup: string,
	relationships: ReadonlyMap<string, string>,
	store: SheetStore,
	cells: LinkCells,
	first: (row: number, col: number) => readonly [number, number] | null
): Map<string, string> {
	const out = new Map<string, string>()

	if (markup.trim() === "") return out

	const document = parseXml(encodeUtf8(markup))
	const root = document.documentElement()
	const visited = linkVisits(store)

	for (const link of children(document, root, "hyperlink")) {
		const range = parseRangeRef(document.attribute(link, "ref") ?? "")

		if (range === null || range === undefined) continue

		const location = document.attribute(link, "location")
		let id: string | undefined

		for (const { name, value } of document.attributes(link)) if (name.endsWith(":id")) id = value

		const href = location !== undefined ? `#${placeHref(location)}` : id === undefined ? undefined : relationships.get(id)

		if (href === undefined) continue

		let any = false

		cells(range, (row, col) => {
			visited()
			any = true
			out.set(key(row, col), href)
		})

		const at = any ? null : first(range.startRow, range.startCol)

		if (at !== null) out.set(key(at[0], at[1]), href)
	}

	return out
}

const IN_PLACE = (row: number, col: number): readonly [number, number] => [row, col]

// A place in the workbook ("Sheet 2!A1", a name) as LibreOffice writes it after "#" ("Sheet 2.A1").
function placeHref(location: string): string {
	const bang = location.lastIndexOf("!")

	if (bang < 0) return encodeURI(location)

	const sheet = location
		.slice(0, bang)
		.replace(/^'(.*)'$/, "$1")
		.replaceAll("''", "'")

	return encodeURI(`${sheet}.${location.slice(bang + 1).replaceAll("$", "")}`)
}

export function sectionText(sections: readonly XlsxSection[], name: string): string {
	return sections
		.filter(section => section.name === name)
		.map(section => decodeUtf8(section.bytes ?? new Uint8Array(0)))
		.join("")
}

// A sheet section's markup as the save has it: its writer's, or the model's own.
export function currentSection(workbook: XlsxWorkbookModel, model: XlsxSheetModel, name: string): string | null {
	const marked = workbook.changes.sheets.get(model.id)?.sections

	if (marked?.has(name) !== true) return null

	const writer = marked.get(name)

	if (writer === null || writer === undefined) return null

	const markup = writer(model, workbook)

	return typeof markup === "string" ? markup : decodeUtf8(markup)
}

// The sheet part's relationships as the save has them, by id.
function relationshipsOf(workbook: XlsxWorkbookModel, model: XlsxSheetModel): Relationship[] {
	const change = workbook.changes.relationships.get(model.part)
	const removed = change?.removed ?? new Set<string>()

	return [...model.relationships.all.filter(relationship => !removed.has(relationship.id)), ...(change?.added ?? [])]
}

async function partBytes(workbook: XlsxWorkbookModel, source: OdsSource, name: string): Promise<Uint8Array | undefined> {
	const write = workbook.changes.parts.get(name)

	if (write === null) return undefined
	if (write !== undefined) {
		const bytes = await write.write(workbook)

		return bytes instanceof Uint8Array ? bytes : await joined(bytes)
	}

	for (const [part, bytes] of source.parts) if (partKey(part) === partKey(name)) return bytes

	return undefined
}

async function joined(bytes: { chunks(): AsyncIterable<Uint8Array> }): Promise<Uint8Array> {
	const pieces: Uint8Array[] = []
	let size = 0

	for await (const chunk of bytes.chunks()) {
		pieces.push(chunk)
		size += chunk.length
	}

	const out = new Uint8Array(size)
	let at = 0

	for (const piece of pieces) {
		out.set(piece, at)
		at += piece.length
	}

	return out
}

// Source cells' entries moved to where they are now (deleted ones gone).
function moved<T>(entries: ReadonlyMap<string, T>, rows: SourceAxis, cols: SourceAxis): Map<string, T> {
	const out = new Map<string, T>()

	for (const [cell, value] of entries) {
		const [row = 0, col = 0] = cell.split(",").map(Number)
		const targetRow = rows.target(row)
		const targetCol = cols.target(col)

		if (targetRow >= 0 && targetCol >= 0) out.set(key(targetRow, targetCol), value)
	}

	return out
}

function differing<T>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>, same: (x: T, y: T) => boolean, into: Set<number>): void {
	for (const [cell, value] of a) {
		const other = b.get(cell)

		if (other === undefined || !same(value, other)) into.add(Number(cell.split(",")[0]))
	}

	for (const cell of b.keys()) if (!a.has(cell)) into.add(Number(cell.split(",")[0]))
}

// A sheet's notes as the save has them, by cell.
export async function currentNotes(workbook: XlsxWorkbookModel, source: OdsSource, model: XlsxSheetModel): Promise<Map<string, NoteState>> {
	const comments = relationshipsOf(workbook, model).find(relationship => relationship.type === COMMENTS_TYPE)
	const part = comments === undefined ? undefined : resolvePartName(model.part, comments.target)

	return readNotes(part === undefined ? undefined : await partBytes(workbook, source, part))
}

// A sheet's links as the save has them, by cell (as text:a's xlink:href).
export function currentLinks(workbook: XlsxWorkbookModel, model: XlsxSheetModel): Map<string, string> {
	const external = new Map<string, string>()

	for (const relationship of relationshipsOf(workbook, model))
		if (relationship.type === HYPERLINK_TYPE) external.set(relationship.id, relationship.target)

	const store = model.store as SheetStore

	return readLinks(
		currentSection(workbook, model, "hyperlinks") ?? sectionText(model.sections, "hyperlinks"),
		external,
		store,
		textCells(store),
		IN_PLACE
	)
}

// The notes and links of a sheet, where an edit changed them.
export async function sheetFeatures(
	workbook: XlsxWorkbookModel,
	source: OdsSource,
	model: XlsxSheetModel,
	sheetName: string,
	table: OdsTableSource | null,
	taken: Set<string>,
	clock?: SliceClock
): Promise<SheetFeatures> {
	// A sheet with no source table holds no source cells: every source row and column is gone.
	const rowAxis = model instanceof OdsSheet ? model.rowAxis : SourceAxis.identity(0)
	const colAxis = model instanceof OdsSheet ? model.colAxis : SourceAxis.identity(0)
	const rows = new Set<number>()
	const relationships = relationshipsOf(workbook, model)
	let notes: Map<string, NoteState> | null = null
	let links: Map<string, string> | null = null

	// Notes: the comments part the sheet relates to now, against the source's.
	const comments = relationships.find(relationship => relationship.type === COMMENTS_TYPE)
	const commentsPart = comments === undefined ? undefined : resolvePartName(model.part, comments.target)
	const sourceComments = table === null ? undefined : `xl/comments${table.index + 1}.xml`
	const commentsChanged =
		table === null ||
		(commentsPart !== undefined && workbook.changes.parts.has(commentsPart)) ||
		commentsPart !== (source.parts.has(sourceComments ?? "") ? sourceComments : undefined) ||
		!rowAxis.identity ||
		!colAxis.identity

	if (commentsChanged) {
		const now = readNotes(commentsPart === undefined ? undefined : await partBytes(workbook, source, commentsPart))
		const before =
			table === null ? new Map<string, NoteState>() : moved(readNotes(source.parts.get(sourceComments ?? "")), rowAxis, colAxis)

		differing(now, before, (a, b) => a.text === b.text && a.author === b.author, rows)

		if (rows.size > 0 || table === null) notes = now
	}

	// Links: the hyperlinks section now, against the source's.
	const linkMarkup = currentSection(workbook, model, "hyperlinks")

	if (linkMarkup !== null || table === null || !rowAxis.identity || !colAxis.identity) {
		const external = new Map<string, string>()

		for (const relationship of relationships)
			if (relationship.type === HYPERLINK_TYPE) external.set(relationship.id, relationship.target)

		const sourceExternal = new Map<string, string>()

		for (const relationship of table?.relationships ?? [])
			if (relationship.type === HYPERLINK_TYPE) sourceExternal.set(relationship.id, relationship.target)

		const store = model.store as SheetStore
		const now = readLinks(linkMarkup ?? sectionText(model.sections, "hyperlinks"), external, store, textCells(store), IN_PLACE)
		// The source's, on its cells where they are now.
		const before =
			table === null
				? new Map<string, string>()
				: readLinks(
						sectionText(table.sections, "hyperlinks"),
						sourceExternal,
						store,
						movedTextCells(store, rowAxis, colAxis),
						(row, col) => {
							const targetRow = rowAxis.target(row)
							const targetCol = colAxis.target(col)

							return targetRow < 0 || targetCol < 0 ? null : [targetRow, targetCol]
						}
					)
		const linkRows = new Set<number>()

		differing(now, before, (a, b) => a === b, linkRows)

		if (linkRows.size > 0 || table === null) {
			links = now

			for (const row of linkRows) rows.add(row)
		}
	}

	// Merges: the rows of each one that differs from the source's (its anchor's spans, its covered cells).
	if (table === null || model.merges !== table.merges) {
		const quads = (merges: Uint32Array, map: (row: number, col: number) => [number, number] | null): Map<string, readonly number[]> => {
			const out = new Map<string, readonly number[]>()

			for (let k = 0; k + 3 < merges.length; k += 4) {
				const start = map(merges[k] ?? 0, merges[k + 1] ?? 0)
				const end = map(merges[k + 2] ?? 0, merges[k + 3] ?? 0)

				if (start === null || end === null) continue

				out.set(`${start[0]},${start[1]},${end[0]},${end[1]}`, [start[0], end[0]])
			}

			return out
		}
		const now = quads(model.merges, (row, col) => [row, col])
		const before =
			table === null
				? new Map<string, readonly number[]>()
				: quads(table.merges, (row, col) => {
						const r = rowAxis.target(row)
						const c = colAxis.target(col)

						return r < 0 || c < 0 ? null : [r, c]
					})
		const mark = (span: readonly number[]): void => {
			for (let row = span[0] ?? 0; row <= (span[1] ?? -1); row++) rows.add(row)
		}

		for (const [key, span] of now) if (!before.has(key)) mark(span)
		for (const [key, span] of before) if (!now.has(key)) mark(span)
	}

	const validations = await runSliced(
		sheetValidationsSteps(model, sheetName, table, currentSection(workbook, model, "dataValidations"), taken),
		clock
	)

	for (const row of validations?.rows ?? []) rows.add(row)

	return { notes, links, validations, rows }
}

// A sheet's validations as the save has them, as rectangles naming their rules.
export function currentValidations(workbook: XlsxWorkbookModel, model: XlsxSheetModel): Rect[] {
	return validationRects(currentSection(workbook, model, "dataValidations") ?? sectionText(model.sections, "dataValidations"))
}

// An office:annotation of a note (ODF 1.3 Part 3 §14.1): its author and its lines as paragraphs.
export function annotationMarkup(note: NoteState): string {
	const author = note.author === "" ? "" : `<dc:creator>${escapeText(note.author)}</dc:creator>`
	const lines = note.text.split("\n").map(line => `<text:p>${paragraphText(line)}</text:p>`)

	return `<office:annotation>${author}${lines.join("")}</office:annotation>`
}
