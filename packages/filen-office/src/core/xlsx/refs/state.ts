import { partKey } from "../../opc/partNames"
import type { PartBytes } from "../../opc/pieces"
import type { Relationship } from "../../opc/relationships"
import type { SheetId } from "../../sheet/protocol"
import { decodeUtf8, encodeUtf8, type Markup } from "../../xml/index"
import type { XlsxPartWrite, XlsxSectionWriter, XlsxSheetModel, XlsxWorkbookModel, XlsxWorkbookSectionWriter } from "../model/types"
import { editedRange, usedRange } from "../write/cells"
import { readDimension, writeDimension } from "../write/sections"
import { refuse } from "./catalogue"
import { contains } from "./moveRefs"

// What the catalogue wrote, per workbook: the current markup of each worksheet section it rewrote (every
// occurrence of the name, in order) and the current bytes of each part. Its writers serialise from here, so an
// undo puts the previous markup back and the writer, finding the source again, copies it.

interface PartWrite extends XlsxPartWrite {
	readonly name: string
}

export class RefState {
	private readonly sections = new Map<SheetId, Map<string, readonly string[]>>()
	private readonly writers = new Map<string, XlsxSectionWriter>()
	private readonly ownWriters = new Set<XlsxSectionWriter>()
	private readonly parts = new Map<string, Uint8Array>()
	private readonly partWrites = new Map<string, PartWrite>()
	private readonly ownPartWrites = new Set<XlsxPartWrite>()
	private readonly workbookSections = new Map<string, string>()
	private readonly workbookWriters = new Map<string, XlsxWorkbookSectionWriter>()
	private readonly workbook: XlsxWorkbookModel

	constructor(workbook: XlsxWorkbookModel) {
		this.workbook = workbook
	}

	// The occurrences of a section as they now are. A section another edit serialises is refused: the catalogue
	// cannot move what it does not hold.
	sectionMarkup(sheet: XlsxSheetModel, name: string): readonly string[] {
		const held = this.sections.get(sheet.id)?.get(name)

		if (held !== undefined) return held

		const marked = this.workbook.changes.sheets.get(sheet.id)?.sections

		if (marked?.has(name) === true && !this.ownWriters.has(marked.get(name) as XlsxSectionWriter))
			refuse("structureLocked", `section ${name}: edited`)

		return sheet.sections.filter(section => section.name === name).map(section => decodeUtf8(section.bytes ?? new Uint8Array(0)))
	}

	// The sections held for a sheet (written by the catalogue or through setSection), by name.
	heldSections(sheet: XlsxSheetModel): readonly string[] {
		return [...(this.sections.get(sheet.id)?.keys() ?? [])]
	}

	setSection(sheet: XlsxSheetModel, name: string, occurrences: readonly string[]): void {
		let held = this.sections.get(sheet.id)

		if (held === undefined) {
			held = new Map()
			this.sections.set(sheet.id, held)
		}

		held.set(name, occurrences)
		this.workbook.changes.sheetSection(sheet.id, name, this.writer(name))
	}

	private writer(name: string): XlsxSectionWriter {
		let writer = this.writers.get(name)

		if (writer === undefined) {
			const created: XlsxSectionWriter =
				name === "dimension"
					? sheet => coveringDimension(sheet, (this.sections.get(sheet.id)?.get(name) ?? []).join(""))
					: sheet => (this.sections.get(sheet.id)?.get(name) ?? []).join("")

			writer = created
			this.writers.set(name, created)
			this.ownWriters.add(created)
		}

		return writer
	}

	ownsSection(writer: XlsxSectionWriter | null | undefined): boolean {
		return writer !== null && writer !== undefined && this.ownWriters.has(writer)
	}

	// A workbook child as it now is ("" when absent). One another edit serialises is refused.
	workbookMarkup(name: string): string {
		const held = this.workbookSections.get(name)

		if (held !== undefined) return held

		const marked = this.workbook.changes.workbookSections

		if (marked.has(name) && !this.isOwnWorkbookWriter(marked.get(name))) refuse("structureLocked", `workbook ${name}: edited`)

		const section = this.workbook.workbookSections.find(candidate => candidate.name === name)

		return section === undefined ? "" : decodeUtf8(section.bytes ?? new Uint8Array(0))
	}

	setWorkbookSection(name: string, markup: string): void {
		this.workbookSections.set(name, markup)

		let writer = this.workbookWriters.get(name)

		if (writer === undefined) {
			const created: XlsxWorkbookSectionWriter = () => this.workbookSections.get(name) ?? ""

			writer = created
			this.workbookWriters.set(name, created)
		}

		this.workbook.changes.workbookSection(name, writer)
	}

	private isOwnWorkbookWriter(writer: XlsxWorkbookSectionWriter | null | undefined): boolean {
		return writer !== null && writer !== undefined && [...this.workbookWriters.values()].includes(writer)
	}

	// A part's bytes as they now are: null when another edit removed it. One another edit writes is refused.
	async partBytes(name: string): Promise<Uint8Array | null> {
		const key = partKey(name)
		const held = this.parts.get(key)

		if (held !== undefined) return held

		const changes = this.workbook.changes.parts

		for (const [changed, write] of changes) {
			if (partKey(changed) !== key) continue
			if (write === null) return null
			if (!this.ownPartWrites.has(write)) refuse("structureLocked", `part ${name}: edited`)
		}

		return this.workbook.parts.read(name)
	}

	heldPart(name: string): Uint8Array | undefined {
		return this.parts.get(partKey(name))
	}

	// `bytes` undefined: back to the source.
	setPart(name: string, contentType: string, bytes: Uint8Array | undefined): void {
		const key = partKey(name)

		if (bytes === undefined) {
			this.parts.delete(key)
			this.workbook.changes.restorePart(name)

			return
		}

		this.parts.set(key, bytes)

		let write = this.partWrites.get(key)

		if (write === undefined) {
			const created: PartWrite = {
				name,
				contentType,
				write: (): PartBytes => this.parts.get(key) ?? new Uint8Array(0)
			}

			write = created
			this.partWrites.set(key, created)
			this.ownPartWrites.add(created)
		}

		this.workbook.changes.writePart(name, write)
	}
}

// The dimension as moved, widened to the cells when they reach past it (a dimension too small makes a reader drop
// cells). Moved back to the source's own, it stays as the source wrote it unless rows edits changed reach past it:
// an undone edit saves the source again, even one whose dimension was already too small.
function coveringDimension(sheet: XlsxSheetModel, markup: string): Markup {
	if (markup === "") return markup

	const bytes = encodeUtf8(markup)
	const recorded = readDimension(bytes)
	const source = sheet.sections.find(section => section.name === "dimension")?.bytes ?? null

	if (source !== null && recorded !== null && decodeUtf8(source) === markup) {
		const edited = editedRange(sheet)

		if (edited === null || contains(recorded, edited)) return source
	}

	const used = usedRange(sheet)

	if (used === null || (recorded !== null && contains(recorded, used))) return bytes

	const range =
		recorded === null
			? used
			: {
					startRow: Math.min(recorded.startRow, used.startRow),
					startCol: Math.min(recorded.startCol, used.startCol),
					endRow: Math.max(recorded.endRow, used.endRow),
					endCol: Math.max(recorded.endCol, used.endCol)
				}

	return writeDimension(range, bytes, sheet.prefix)
}

// A part's relationships as they now are: those read, less the ones edits removed, with the ones they added.
export function liveRelationships(workbook: XlsxWorkbookModel, source: string, read: readonly Relationship[]): Relationship[] {
	const edits = workbook.changes.relationships.get(source)

	if (edits === undefined) return read.slice()

	return [...read.filter(relationship => !edits.removed.has(relationship.id)), ...edits.added]
}

const states = new WeakMap<XlsxWorkbookModel, RefState>()

export function refState(workbook: XlsxWorkbookModel): RefState {
	let state = states.get(workbook)

	if (state === undefined) {
		state = new RefState(workbook)
		states.set(workbook, state)
	}

	return state
}
