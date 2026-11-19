import { partKey } from "../../opc/partNames"
import type { NewRelationship, Relationship } from "../../opc/relationships"
import type { SheetChangeSink, SheetEditStep } from "../../sheet/registry"
import type { ChangeLog } from "../model/changes"
import type { XlsxSheetModel, XlsxWorkbookModel } from "../model/types"
import { refState } from "../refs/state"
import { relationshipType } from "../write/namespaces"

// The parts notes, threaded comments and hyperlinks live in, and the one way their edits change the package: every
// part and section through the refs catalogue's state (refState), so structure edits move what an annotation edit
// wrote and an undo puts the bytes back; relationships through the change log, whose retired relationships come back
// with their ids on redo.

// ECMA-376 Part 1 §18.7 (comments), Part 4 §14.6 and [MS-OI29500] §2.1.1716 (the legacy drawing notes are shapes of),
// [MS-XLSX] §2.1.17 and §2.1.18 (threaded comments and persons).
export const COMMENTS_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"
export const VML_TYPE = "application/vnd.openxmlformats-officedocument.vmlDrawing"
export const THREADED_TYPE = "application/vnd.ms-excel.threadedcomments+xml"
export const PERSON_TYPE = "application/vnd.ms-excel.person+xml"
export const THREADED_RELATIONSHIP = "http://schemas.microsoft.com/office/2017/10/relationships/threadedComment"
export const PERSON_RELATIONSHIP = "http://schemas.microsoft.com/office/2017/10/relationships/person"
export const THREADED_NAMESPACE = "http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"
export const REVISION_NAMESPACE = "http://schemas.microsoft.com/office/spreadsheetml/2014/revision"
export const MC_NAMESPACE = "http://schemas.openxmlformats.org/markup-compatibility/2006"

export const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

export function commentsRelationship(workbook: XlsxWorkbookModel): string {
	return relationshipType(workbook.strict, "comments")
}

export function vmlRelationship(workbook: XlsxWorkbookModel): string {
	return relationshipType(workbook.strict, "vmlDrawing")
}

export function hyperlinkRelationship(workbook: XlsxWorkbookModel): string {
	return relationshipType(workbook.strict, "hyperlink")
}

// The last segment of a relationship type: the same for Transitional and Strict.
export function relationshipKind(type: string): string {
	return type.slice(type.lastIndexOf("/") + 1)
}

// The folder the workbook part is in ("xl/"): where Excel puts the parts it adds.
export function partFolder(workbook: XlsxWorkbookModel): string {
	return workbook.workbookPart.slice(0, workbook.workbookPart.lastIndexOf("/") + 1)
}

// A part name that is free in the package and among the parts edits added (`pattern(n)` from n = 1).
export function freePartName(workbook: XlsxWorkbookModel, pattern: (n: number) => string): string {
	const taken = new Set<string>()

	for (const part of workbook.parts.parts()) taken.add(partKey(part.name))
	for (const name of workbook.changes.parts.keys()) taken.add(partKey(name))

	for (let n = 1; ; n++) {
		const name = pattern(n)

		if (!taken.has(partKey(name))) return name
	}
}

// A part's current bytes: as an edit left it (held by the catalogue), null when an edit removed it, the source's
// as loaded, or undefined when the source's was never read.
export function heldOrSource(
	workbook: XlsxWorkbookModel,
	name: string,
	source: ReadonlyMap<string, Uint8Array>
): Uint8Array | null | undefined {
	const held = refState(workbook).heldPart(name)

	if (held !== undefined) return held

	for (const [changed, write] of workbook.changes.parts) if (partKey(changed) === partKey(name) && write === null) return null

	return source.get(partKey(name))
}

// The writes of one annotation edit, made forward once, then undone and redone as recorded.
export class AnnotationWrites {
	private readonly workbook: XlsxWorkbookModel
	private readonly parts: { name: string; contentType: string; before: Uint8Array | undefined; after: Uint8Array }[] = []
	private readonly added: { source: string; relationship: Relationship }[] = []
	// A relationship removed, with itself when an edit had added it (an undo adds it back with its id).
	private readonly removed: { source: string; id: string; added: Relationship | undefined }[] = []
	private readonly sections: { model: XlsxSheetModel; name: string; before: readonly string[]; after: readonly string[] }[] = []
	private bytesKept = 0

	constructor(workbook: XlsxWorkbookModel) {
		this.workbook = workbook
	}

	get bytes(): number {
		return this.bytesKept + 256
	}

	setPart(name: string, contentType: string, bytes: Uint8Array): void {
		const state = refState(this.workbook)
		const before = state.heldPart(name)

		this.parts.push({ name, contentType, before, after: bytes })
		this.bytesKept += bytes.length + (before?.length ?? 0)
		state.setPart(name, contentType, bytes)
	}

	addRelationship(source: string, relationship: NewRelationship): Relationship {
		const added = this.workbook.changes.addRelationship(source, relationship)

		this.added.push({ source, relationship: added })

		return added
	}

	removeRelationship(source: string, id: string): void {
		const added = this.workbook.changes.relationships.get(source)?.added.find(relationship => relationship.id === id)

		this.workbook.changes.removeRelationship(source, id)
		this.removed.push({ source, id, added })
	}

	setSection(model: XlsxSheetModel, name: string, occurrences: readonly string[]): void {
		const state = refState(this.workbook)
		const before = state.sectionMarkup(model, name)

		this.sections.push({ model, name, before, after: occurrences })
		this.bytesKept += occurrences.reduce((sum, markup) => sum + markup.length, 0)
		state.setSection(model, name, occurrences)
	}

	undo(): void {
		const state = refState(this.workbook)
		const changes = this.workbook.changes as ChangeLog

		for (let k = this.sections.length - 1; k >= 0; k--) {
			const section = this.sections[k]

			if (section !== undefined) state.setSection(section.model, section.name, section.before)
		}

		for (let k = this.removed.length - 1; k >= 0; k--) {
			const removed = this.removed[k]

			if (removed === undefined) continue

			if (removed.added === undefined) changes.restoreRelationship(removed.source, removed.id)
			else changes.readdRelationship(removed.source, removed.added)
		}

		for (let k = this.added.length - 1; k >= 0; k--) {
			const added = this.added[k]

			if (added !== undefined) changes.removeRelationship(added.source, added.relationship.id)
		}

		for (let k = this.parts.length - 1; k >= 0; k--) {
			const part = this.parts[k]

			if (part !== undefined) state.setPart(part.name, part.contentType, part.before)
		}
	}

	redo(): void {
		const state = refState(this.workbook)
		const changes = this.workbook.changes

		for (const part of this.parts) state.setPart(part.name, part.contentType, part.after)

		for (const added of this.added) changes.readdRelationship(added.source, added.relationship)

		for (const removed of this.removed) changes.removeRelationship(removed.source, removed.id)
		for (const section of this.sections) state.setSection(section.model, section.name, section.after)
	}

	// The edit as a history step; `report` tells the session what to repaint, forward and back.
	step(report: (changes: SheetChangeSink) => void): SheetEditStep {
		return {
			bytes: this.bytes,
			undo: changes => {
				this.undo()
				report(changes)
			},
			redo: changes => {
				this.redo()
				report(changes)
			}
		}
	}
}
