import type { NewRelationship, Relationship, Relationships } from "../../opc/relationships"
import { partKey, resolvePartName } from "../../opc/partNames"
import type { SheetId } from "../../sheet/protocol"
import { XlsxReadError } from "../read/errors"
import type {
	WorksheetSection,
	XlsxChangeLog,
	XlsxPartWrite,
	XlsxRelationshipChanges,
	XlsxSectionWriter,
	XlsxSheetChanges,
	XlsxWorkbookSection,
	XlsxWorkbookSectionWriter
} from "./types"

interface SheetChanges extends XlsxSheetChanges {
	rows: boolean
	readonly sections: Map<WorksheetSection | (string & {}), XlsxSectionWriter | null>
}

interface RelationshipChanges extends XlsxRelationshipChanges {
	readonly added: Relationship[]
	readonly removed: Set<string>
}

// What changed since open, as the edits record it. `relationshipsOf` answers a part's source relationships once
// they were read (the part map caches them), so ids are allocated without a wait.
export class ChangeLog implements XlsxChangeLog {
	readonly sheets = new Map<SheetId, SheetChanges>()
	readonly workbookSections = new Map<XlsxWorkbookSection | (string & {}), XlsxWorkbookSectionWriter | null>()
	readonly parts = new Map<string, XlsxPartWrite | null>()
	readonly relationships = new Map<string, RelationshipChanges>()
	sharedStrings = false
	styles = false
	dropCalcChain = false
	fullCalcOnLoad = false
	// Highest numeric rId handed out per source part (removed ones included), so an id is never reused.
	private readonly highest = new Map<string, number>()
	// Added relationships removed again, by source and identity, latest last: added once more without an id, each
	// gets one of theirs back; readdRelationship puts back the very one a step recorded.
	private readonly retired = new Map<string, Relationship[]>()
	// Every part written or given relationships since open, removed again or not (partKey).
	private readonly named = new Set<string>()
	private readonly relationshipsOf: (source: string) => Relationships | undefined
	// What one edit marks (sections and parts, each once, re-marks too), from beginJournal to endJournal, and of
	// those the ones it marked first (forgetJournal takes them back).
	private journal: Set<string> | null = null
	private fresh: string[] = []

	constructor(relationshipsOf: (source: string) => Relationships | undefined) {
		this.relationshipsOf = relationshipsOf
	}

	get empty(): boolean {
		return (
			this.sheets.size === 0 &&
			this.workbookSections.size === 0 &&
			this.parts.size === 0 &&
			this.relationships.size === 0 &&
			!this.sharedStrings &&
			!this.styles &&
			!this.dropCalcChain &&
			!this.fullCalcOnLoad
		)
	}

	private sheet(id: SheetId): SheetChanges {
		let changes = this.sheets.get(id)

		if (changes === undefined) {
			changes = { rows: false, sections: new Map() }
			this.sheets.set(id, changes)
		}

		return changes
	}

	sheetRows(sheet: SheetId): void {
		this.sheet(sheet).rows = true
	}

	sheetSection(sheet: SheetId, section: WorksheetSection | (string & {}), writer?: XlsxSectionWriter): void {
		const sections = this.sheet(sheet).sections

		this.mark(sheetMark(sheet, section), sections.has(section))
		sections.set(section, writer ?? null)
	}

	workbookSection(section: XlsxWorkbookSection | (string & {}), writer?: XlsxWorkbookSectionWriter): void {
		this.mark(workbookMark(section), this.workbookSections.has(section))
		this.workbookSections.set(section, writer ?? null)
	}

	private mark(key: string, known: boolean): void {
		if (this.journal === null) return

		if (!known && !this.journal.has(key)) this.fresh.push(key)

		this.journal.add(key)
	}

	beginJournal(): void {
		this.journal = new Set()
		this.fresh = []
	}

	endJournal(): ReadonlySet<string> | null {
		const journal = this.journal

		this.journal = null

		return journal
	}

	// The marks the last journal's edit made first, taken back: it was undone, and before it they were unmarked.
	forgetJournal(): void {
		for (const key of this.fresh) {
			const [kind = "", first = "", second = ""] = key.split("\u0000")

			if (kind === "w") this.workbookSections.delete(first)
			if (kind === "p") this.parts.delete(first)

			if (kind === "s") {
				const changes = this.sheets.get(Number(first))

				changes?.sections.delete(second)

				if (changes !== undefined && !changes.rows && changes.sections.size === 0) this.sheets.delete(Number(first))
			}
		}

		this.fresh = []
	}

	sharedStringsAppended(): void {
		this.sharedStrings = true
	}

	stylesAppended(): void {
		this.styles = true
	}

	writePart(name: string, write: XlsxPartWrite): void {
		this.named.add(partKey(name))
		this.mark(partMark(name), this.parts.has(name))
		this.parts.set(name, write)
	}

	// Whether a part had this name since open (an undone copy's): a new part takes another, so the ids its markup
	// is written with are the ids its relationships get, not ones the old part's retired relationships hold.
	hadName(name: string): boolean {
		return this.named.has(partKey(name))
	}

	removePart(name: string): void {
		this.mark(partMark(name), this.parts.has(name))
		this.parts.set(name, null)
	}

	restorePart(name: string): void {
		this.parts.delete(name)
	}

	private relationshipChanges(source: string): RelationshipChanges {
		let changes = this.relationships.get(source)

		if (changes === undefined) {
			changes = { added: [], removed: new Set() }
			this.relationships.set(source, changes)
		}

		return changes
	}

	addRelationship(source: string, relationship: NewRelationship): Relationship {
		this.named.add(partKey(source))

		const identity = retiredKey(source, relationship.type, relationship.target, relationship.external === true)
		const pool = this.retired.get(identity)
		const retired = pool?.pop()

		if (pool?.length === 0) this.retired.delete(identity)

		if (retired !== undefined) {
			this.relationshipChanges(source).added.push(retired)

			return retired
		}

		let highest = this.highest.get(source)

		if (highest === undefined) {
			const existing = this.relationshipsOf(source)

			if (existing === undefined) {
				throw new XlsxReadError(
					"relationshipsNotRead",
					"A relationship was added before the part's relationships were read",
					source
				)
			}

			highest = 0

			for (const { id } of existing.all) {
				const numbered = /^rId(\d+)$/.exec(id)

				if (numbered !== null) highest = Math.max(highest, Number(numbered[1]))
			}
		}

		const taken = this.relationshipsOf(source)
		let id = `rId${++highest}`

		while (taken?.byId(id) !== undefined) id = `rId${++highest}`

		this.highest.set(source, highest)

		const external = relationship.external === true
		const added: Relationship = {
			id,
			type: relationship.type,
			target: relationship.target,
			external,
			partName: external ? undefined : resolvePartName(source, relationship.target)
		}

		this.relationshipChanges(source).added.push(added)

		return added
	}

	// The undo or redo of an add or remove a step recorded: `relationship` (as addRelationship returned it) is added
	// back under its own id, which the step's markup names, whatever was retired since.
	readdRelationship(source: string, relationship: Relationship): void {
		this.named.add(partKey(source))

		const identity = retiredKey(source, relationship.type, relationship.target, relationship.external)
		const pool = this.retired.get(identity)
		const at = pool?.indexOf(relationship) ?? -1

		if (pool !== undefined && at >= 0) {
			pool.splice(at, 1)

			if (pool.length === 0) this.retired.delete(identity)
		}

		const changes = this.relationshipChanges(source)

		if (!changes.added.some(added => added.id === relationship.id)) changes.added.push(relationship)
	}

	removeRelationship(source: string, id: string): void {
		const changes = this.relationshipChanges(source)
		const index = changes.added.findIndex(relationship => relationship.id === id)

		const added = changes.added[index]

		if (added !== undefined) {
			changes.added.splice(index, 1)
			const identity = retiredKey(source, added.type, added.target, added.external)
			const pool = this.retired.get(identity)

			if (pool === undefined) this.retired.set(identity, [added])
			else pool.push(added)
		} else {
			changes.removed.add(id)
		}

		if (changes.added.length === 0 && changes.removed.size === 0) this.relationships.delete(source)
	}

	// The undo of removeRelationship for a source relationship: it stays.
	restoreRelationship(source: string, id: string): void {
		const changes = this.relationships.get(source)

		if (changes === undefined) return

		changes.removed.delete(id)

		if (changes.added.length === 0 && changes.removed.size === 0) this.relationships.delete(source)
	}

	formulasChanged(): void {
		this.dropCalcChain = true
	}

	needsFullCalc(): void {
		this.fullCalcOnLoad = true
	}
}

function retiredKey(source: string, type: string, target: string, external: boolean): string {
	return `${source}\n${type}\n${target}\n${external ? "1" : "0"}`
}

// A journal's entries: a sheet's section, a workbook section, a part.
export const sheetMark = (sheet: SheetId, section: string): string => `s\u0000${sheet}\u0000${section}`
export const workbookMark = (section: string): string => `w\u0000${section}`
export const partMark = (name: string): string => `p\u0000${name}`
