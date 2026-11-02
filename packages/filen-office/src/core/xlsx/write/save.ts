import { appendAll } from "../../arrays"
import {
	BytePieces,
	CONTENT_TYPES_PART,
	OpcError,
	OpcPackage,
	ZipError,
	editContentTypes,
	partKey,
	relationshipsPartName,
	relativeTarget,
	type ByteSink,
	type ByteSource,
	type PartBytes,
	type PartChange,
	type Relationship,
	type WriteZipOptions
} from "../../opc/index"
import { XmlError } from "../../xml/index"
import { sliceClock, type SliceClock, type Slicing } from "../../slicing"
import { DocxSaveError } from "../../docx/write/failure"
import { equalBytes } from "../../docx/write/bytes"
import { zipDocxSave } from "../../docx/write/zip"
import { CellKind, RowFlag, type XlsxRelationshipChanges, type XlsxWorkbookModel } from "../model/types"
import { verifyXlsxParts } from "../verify/verify"
import { XlsxWriteError, type XlsxSaveFailure, type XlsxSaveRefusal } from "./failure"
import { utf8Part, type Pieces } from "./markup"
import { editRelationships, freeRelationshipId, relationshipIds } from "./parts"
import { SHEET_CONTENT_TYPES, namespacesOf, relationshipType } from "./namespaces"
import { SHARED_STRINGS_CONTENT_TYPE, writeSharedStrings, type WrittenSharedStrings } from "./sharedStrings"
import { writeSheet, type WrittenSheet } from "./sheet"
import { STYLES_CONTENT_TYPE, formatZeroImplied, stylesExtent, stylesGrow, writeStyles, type StylesExtent } from "./styles"
import { writeWorkbook, type WrittenWorkbook } from "./workbook"

// The xlsx save: the splice writer over the model's change log, the part half of the gate, then the zip with
// every untouched entry copied as its compressed bytes and the zip half of the gate. It never throws: a
// failure comes back as a refusal with its reason, and the session stays dirty.

export interface XlsxSaveInput {
	// The package the model was read from: untouched entries are copied from it.
	readonly opc: OpcPackage
	readonly workbook: XlsxWorkbookModel
}

export interface XlsxSaveOptions {
	readonly slicing?: Slicing
	readonly zip?: WriteZipOptions
	// Where the file goes (default: memory, returned as `bytes`).
	readonly sink?: ByteSink
	// Random access to what `sink` received, for the zip half of the gate; required with a sink.
	readonly readBack?: () => Promise<ByteSource>
}

export interface XlsxSaveTimings {
	readonly writeMs: number
	readonly verifyPartsMs: number
	readonly zipMs: number
	readonly verifyZipMs: number
}

export interface XlsxSaved {
	readonly ok: true
	// The file, when no sink was given.
	readonly bytes: Uint8Array | undefined
	// Parts rewritten or added; every other entry was copied as it was, compressed bytes included.
	readonly changedParts: readonly string[]
	readonly timings: XlsxSaveTimings
}

export type XlsxSaveResult = XlsxSaved | XlsxSaveRefusal

const WORKSHEET_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"

// Everything a save writes, before the zip: what the gate checks.
export interface XlsxDraft {
	readonly input: XlsxSaveInput
	readonly sheets: readonly WrittenSheet[]
	readonly workbook: WrittenWorkbook | null
	readonly sharedStrings: (WrittenSharedStrings & { readonly part: string }) | null
	readonly styles: { readonly part: string; readonly bytes: Uint8Array; readonly extent: StylesExtent } | null
	// The shared strings and cell formats the package holds after the save: the source's when their parts were not
	// written.
	readonly sharedStringCount: number
	readonly cellXfCount: number
	// Relationship parts written, by name.
	readonly relationships: ReadonlyMap<string, Uint8Array>
	readonly contentTypes: Uint8Array | null
	// Parts written by an edit's own writer (comments, drawings), by name.
	readonly others: ReadonlyMap<string, { readonly bytes: PartBytes; readonly contentType: string }>
	readonly replace: readonly PartChange[]
	readonly add: readonly PartChange[]
	readonly remove: readonly string[]
	// The calcChain part dropped, if any.
	readonly calcChain: string | null
}

function directory(part: string): string {
	return part.slice(0, part.lastIndexOf("/") + 1)
}

async function piecesBytes(pieces: Pieces, clock: SliceClock | undefined): Promise<BytePieces> {
	return clock === undefined ? BytePieces.of(pieces.items) : BytePieces.build(pieces.items, () => clock.due, clock.pause)
}

interface PartPlan {
	readonly replace: PartChange[]
	readonly add: PartChange[]
	readonly remove: Set<string>
	// Content types of the parts added, by name.
	readonly types: Map<string, string>
}

// Whether new content is its source's bytes (an edit and its undo): the entry is then copied as stored.
function unchanged(bytes: PartBytes, source: Uint8Array | null): boolean {
	if (source === null || bytes.length !== source.length) return false
	if (bytes instanceof Uint8Array) return equalBytes(bytes, 0, source, 0, source.length)
	if (!(bytes instanceof BytePieces)) return false

	return bytes.visit(0, bytes.length, (piece, from, count, at) => equalBytes(piece, from, source, at, count))
}

function put(
	plan: PartPlan,
	opc: OpcPackage,
	name: string,
	bytes: PartBytes,
	contentType?: string,
	source: Uint8Array | null = null
): void {
	if (unchanged(bytes, source)) return

	if (opc.has(name)) {
		plan.replace.push({ name, bytes })

		return
	}

	plan.add.push({ name, bytes })

	if (contentType !== undefined) plan.types.set(name, contentType)
}

// The splice writer: every changed part, the relationships and content types they need.
export async function writeXlsx(input: XlsxSaveInput, slicing?: Slicing): Promise<XlsxDraft> {
	const { opc, workbook } = input
	const changes = workbook.changes
	const clock = slicing === undefined ? undefined : sliceClock(slicing)
	const plan: PartPlan = { replace: [], add: [], remove: new Set(), types: new Map() }
	const relationshipChanges = new Map<string, { added: Relationship[]; removed: Set<string> }>()
	const relationshipEdit = (source: string): { added: Relationship[]; removed: Set<string> } => {
		let edit = relationshipChanges.get(source)

		if (edit === undefined) {
			edit = { added: [], removed: new Set() }
			relationshipChanges.set(source, edit)
		}

		return edit
	}

	for (const [source, change] of changes.relationships as ReadonlyMap<string, XlsxRelationshipChanges>) {
		const edit = relationshipEdit(source)

		appendAll(edit.added, change.added)
		for (const id of change.removed) edit.removed.add(id)
	}

	const workbookRelationships = await workbook.parts.relationships(workbook.workbookPart)
	const workbookIds = relationshipIds(workbookRelationships)

	for (const relationship of relationshipChanges.get(workbook.workbookPart)?.added ?? []) workbookIds.add(relationship.id)

	const workbookPartFor = (type: string, fallback: string): { name: string; fresh: boolean } => {
		const existing = workbookRelationships
			.byType(type)
			.find(relationship => relationship.partName !== undefined && opc.has(relationship.partName))

		if (existing?.partName !== undefined) return { name: existing.partName, fresh: false }

		let name = `${directory(workbook.workbookPart)}${fallback}`

		for (let n = 2; opc.has(name); n++) name = `${directory(workbook.workbookPart)}${fallback.replace(".xml", `${n}.xml`)}`

		const id = freeRelationshipId(workbookIds)

		relationshipEdit(workbook.workbookPart).added.push({
			id,
			type,
			target: relativeTarget(workbook.workbookPart, name),
			external: false,
			partName: name
		})

		return { name, fresh: true }
	}

	// Parts an edit wrote or removed itself.
	const others = new Map<string, { bytes: PartBytes; contentType: string }>()

	for (const [name, write] of changes.parts) {
		if (write === null) {
			if (opc.has(name)) plan.remove.add(name)

			continue
		}

		const bytes = await write.write(workbook, clock)

		others.set(name, { bytes, contentType: write.contentType })
		put(plan, opc, name, bytes, write.contentType)
	}

	// Sheets: those with changes, and any added since open.
	const sheets: WrittenSheet[] = []

	for (const entry of workbook.sheets) {
		const sheetChanges = changes.sheets.get(entry.id)
		// A sheet added since open (loaded, its part not in the source); a sheet whose part the source lacks
		// stays as it is.
		const fresh = entry.model !== null && entry.part !== "" && !opc.has(entry.part)

		if (changes.parts.has(entry.part) || (sheetChanges === undefined && !fresh)) continue
		if (!fresh && !opc.has(entry.part)) continue

		const source = fresh ? null : await workbook.parts.read(entry.part, clock)
		const written = await writeSheet(entry, workbook, sheetChanges, source === null ? null : utf8Part(source), clock)

		sheets.push(written)
		put(plan, opc, entry.part, await piecesBytes(written.pieces, clock), WORKSHEET_CONTENT_TYPE, source)
	}

	// Shared strings and styles: what the written sheets refer to (an edit undone writes nothing).
	const used = await appendedUsage(workbook, sheets, clock)
	let sharedStrings: (WrittenSharedStrings & { part: string }) | null = null

	if (changes.sharedStrings && (used.strings > workbook.sharedStrings.sourceLength || workbook.sharedStrings.referenceDelta !== 0)) {
		const { name, fresh } = workbookPartFor(relationshipType(workbook.strict, "sharedStrings"), "sharedStrings.xml")
		const source = fresh ? null : await workbook.parts.read(name, clock)
		const written = writeSharedStrings(
			workbook.sharedStrings,
			used.strings,
			source === null ? null : utf8Part(source),
			namespacesOf(workbook.strict).main
		)

		sharedStrings = { ...written, part: name }
		put(plan, opc, name, await piecesBytes(written.pieces, clock), SHARED_STRINGS_CONTENT_TYPE, source)
	}

	let styles: { part: string; bytes: Uint8Array; extent: StylesExtent } | null = null
	const extent = stylesExtent(workbook.styles, used.xfs)

	if (changes.styles && stylesGrow(workbook.styles, extent)) {
		const { name, fresh } = workbookPartFor(relationshipType(workbook.strict, "styles"), "styles.xml")
		const source = fresh ? null : await workbook.parts.read(name, clock)
		const bytes = await writeStyles(
			workbook.styles,
			extent,
			source === null ? null : utf8Part(source),
			namespacesOf(workbook.strict).main,
			name,
			clock
		)

		styles = { part: name, bytes, extent }
		put(plan, opc, name, bytes, STYLES_CONTENT_TYPE, source)
	}

	// calcChain goes when the formula cells it names changed (it is optional, and a stale one makes Excel repair the
	// file): as the written parts hold them, so an edit undone keeps it. A rewritten row added, changed, moved or
	// dropped a formula, or a sheet with its cells went.
	let calcChain: string | null = null
	const sheetRemoved = [...plan.remove].some(name => SHEET_CONTENT_TYPES.has(workbook.parts.get(name)?.contentType.toLowerCase() ?? ""))

	if (sheets.some(sheet => sheet.formulasChanged) || sheetRemoved) {
		for (const relationship of workbookRelationships.byType(relationshipType(workbook.strict, "calcChain"))) {
			relationshipEdit(workbook.workbookPart).removed.add(relationship.id)

			if (relationship.partName !== undefined && opc.has(relationship.partName)) {
				plan.remove.add(relationship.partName)
				calcChain = relationship.partName
			}
		}
	}

	// workbook.xml.
	let writtenWorkbook: WrittenWorkbook | null = null

	if (changes.workbookSections.size > 0 || changes.fullCalcOnLoad) {
		const source = await workbook.parts.read(workbook.workbookPart, clock)

		writtenWorkbook = writeWorkbook(workbook, changes, utf8Part(source))
		put(plan, opc, workbook.workbookPart, writtenWorkbook.bytes, undefined, source)
	}

	// The relationships of removed parts go with them, a part added since open and removed again too (a copied sheet
	// deleted, whose relationships the change log alone holds).
	for (const name of plan.remove) {
		const rels = relationshipsPartName(name)

		if (opc.has(rels)) plan.remove.add(rels)

		relationshipChanges.delete(name)
	}

	const removed = new Set([...changes.parts].flatMap(([name, write]) => (write === null ? [partKey(name)] : [])))

	for (const source of [...relationshipChanges.keys()]) if (removed.has(partKey(source))) relationshipChanges.delete(source)

	const relationships = new Map<string, Uint8Array>()

	for (const [source, edit] of relationshipChanges) {
		if (edit.added.length === 0 && edit.removed.size === 0) continue

		const name = relationshipsPartName(source)
		const bytes = editRelationships(opc.has(name) ? await opc.read(name) : null, edit.added, edit.removed)

		relationships.set(name, bytes)
		put(plan, opc, name, bytes)
	}

	// Content types: an override for every added part, none for a removed one.
	let contentTypes: Uint8Array | null = null
	const types = await opc.contentTypes()
	const overrides: { partName: string; contentType: string }[] = []
	const defaults: { extension: string; contentType: string }[] = []

	for (const [name, contentType] of plan.types) if (types.typeOf(name) !== contentType) overrides.push({ partName: name, contentType })

	for (const change of plan.add) {
		if (change.name.endsWith(".rels") && types.typeOf(change.name) === undefined && defaults.length === 0) {
			defaults.push({ extension: "rels", contentType: "application/vnd.openxmlformats-package.relationships+xml" })
		}
	}

	const removeOverrides = [...plan.remove].filter(name => types.overrides.has(partKey(name)))

	if (overrides.length > 0 || defaults.length > 0 || removeOverrides.length > 0) {
		contentTypes = editContentTypes(await opc.read(CONTENT_TYPES_PART), { overrides, defaults, removeOverrides })
		put(plan, opc, CONTENT_TYPES_PART, contentTypes)
	}

	// A part removed and written again in the same save is written.
	const written = new Set([...plan.replace, ...plan.add].map(change => partKey(change.name)))

	return {
		input,
		sheets,
		workbook: writtenWorkbook,
		sharedStrings,
		styles,
		sharedStringCount: sharedStrings?.length ?? workbook.sharedStrings.sourceLength,
		cellXfCount: styles?.extent.cellXfs ?? workbook.styles.sourceCounts.cellXfs,
		relationships,
		contentTypes,
		others,
		replace: plan.replace,
		add: plan.add,
		remove: [...plan.remove].filter(name => !written.has(partKey(name))),
		calcChain
	}
}

// One past the highest appended shared string and cell format the written sheets' rewritten rows and columns refer
// to (at least the source's counts). Rows not rewritten hold the source's references only.
async function appendedUsage(
	workbook: XlsxWorkbookModel,
	sheets: readonly WrittenSheet[],
	clock: SliceClock | undefined
): Promise<{ strings: number; xfs: number }> {
	const scanStrings = workbook.sharedStrings.length > workbook.sharedStrings.sourceLength
	const scanXfs = workbook.styles.cellXfs.length > workbook.styles.sourceCounts.cellXfs
	let strings = workbook.sharedStrings.sourceLength
	let xfs = workbook.styles.sourceCounts.cellXfs

	if (!scanStrings && !scanXfs) return { strings, xfs }

	const stringsEnd = scanStrings ? workbook.sharedStrings.length : strings
	const xfsEnd = scanXfs ? workbook.styles.cellXfs.length : xfs
	// Format 0 needs nothing written while it is what an unformatted cell shows (formatZeroImplied).
	const floor = formatZeroImplied(workbook.styles) ? 0 : -1

	for (const sheet of sheets) {
		const model = sheet.entry.model

		if (model === null) continue

		for (const range of model.cols) if (range.style > floor) xfs = Math.max(xfs, range.style + 1)

		for (const block of model.store.blocks) {
			for (let index = 0; index < block.rowCount; index++) {
				if (((block.rowFlags[index] ?? 0) & (RowFlag.DIRTY | RowFlag.NEW)) === 0) continue

				const rowStyle = block.rowStyles[index] ?? -1

				if (rowStyle >= xfs && rowStyle > floor) xfs = rowStyle + 1

				const end = block.rowStarts[index + 1] ?? 0

				// Plain comparisons per cell: only a higher reference than seen so far does any work.
				for (let k = block.rowStarts[index] ?? 0; k < end; k++) {
					const style = block.styles[k] ?? 0

					if (style >= xfs && style > floor) xfs = style + 1
					if (scanStrings && block.kinds[k] === CellKind.SHARED_STRING && (block.values[k] ?? 0) >= strings)
						strings = (block.values[k] ?? 0) + 1
				}
			}

			// Nothing past the last appended record can be referred to.
			if (strings >= stringsEnd && xfs >= xfsEnd) return { strings, xfs }
			if (clock?.due === true) await clock.pause()
		}
	}

	return { strings, xfs }
}

function refusal(reason: XlsxSaveFailure, message: string): XlsxSaveRefusal {
	return { ok: false, reason, message }
}

function refusalOf(error: unknown): XlsxSaveRefusal {
	if (error instanceof XlsxWriteError) return refusal(error.reason, error.message)
	if (error instanceof DocxSaveError) {
		const reason: XlsxSaveFailure = error.reason === "invalidPackage" || error.reason === "untouchedChanged" ? error.reason : "write"

		return refusal(reason, error.message)
	}
	if (error instanceof XmlError) return refusal("malformedPart", error.message)
	if (error instanceof OpcError || error instanceof ZipError) return refusal("invalidPackage", error.message)

	return refusal("write", error instanceof Error ? error.message : String(error))
}

// Writes the workbook: an unedited one comes out as its source bytes. Every failure is a refusal.
export async function saveXlsx(input: XlsxSaveInput, options: XlsxSaveOptions = {}): Promise<XlsxSaveResult> {
	try {
		const { workbook } = input

		const clock = options.slicing === undefined ? undefined : sliceClock(options.slicing)
		let started = Date.now()
		const draft = workbook.changes.empty ? null : await writeXlsx(input, clock)
		const writeMs = Date.now() - started

		started = Date.now()

		if (draft !== null) await verifyXlsxParts(draft, clock)

		const verifyPartsMs = Date.now() - started
		const zipped = await zipDocxSave(
			input.opc,
			{ replace: draft?.replace ?? [], add: draft?.add ?? [], remove: draft?.remove ?? [] },
			{
				...(options.zip === undefined && clock === undefined
					? {}
					: { zip: { ...options.zip, ...(clock === undefined ? {} : { slicing: clock }) } }),
				...(options.sink === undefined ? {} : { sink: options.sink }),
				...(options.readBack === undefined ? {} : { readBack: options.readBack })
			}
		)

		return {
			ok: true,
			bytes: zipped.bytes,
			changedParts: zipped.changedParts,
			timings: { writeMs, verifyPartsMs, zipMs: zipped.zipMs, verifyZipMs: zipped.verifyZipMs }
		}
	} catch (error) {
		return refusalOf(error)
	}
}
