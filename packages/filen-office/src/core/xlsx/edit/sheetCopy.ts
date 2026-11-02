import { spliceAll } from "../../arrays"
import { partKey } from "../../opc/partNames"
import { joinBytes } from "../../opc/pieces"
import { Relationships, type Relationship } from "../../opc/relationships"
import { sliceClock, type Slicing } from "../../slicing"
import type { SheetId, SheetRefusal } from "../../sheet/protocol"
import { defineSheetFeature, type SheetChangeSink, type SheetHandled } from "../../sheet/registry"
import { renameSheetInFormula } from "../../sheet/refs/formulaRefs"
import { XmlEditor, decodeUtf8, encodeUtf8, parseXml } from "../../xml/index"
import { ChangeLog } from "../model/changes"
import { FormulaTable } from "../model/formulas"
import { RowBlock, SheetStore } from "../model/store"
import { SheetStrings } from "../model/strings"
import {
	CellKind,
	NO_SPAN,
	RowFlag,
	ROW_MARKS,
	SLOT_BLOCK,
	rowRunAt,
	type XlsxDefinedName,
	type XlsxSection,
	type XlsxSheetEntry,
	type XlsxSheetModel,
	type XlsxWorkbookModel
} from "../model/types"
import { XlsxSheet } from "../read/index"
import { RefRefused } from "../refs/catalogue"
import { FormulaShift } from "../refs/formulas"
import { rewriteChart } from "../refs/parts"
import { nameWithFormula } from "../refs/plan"
import { liveRelationships, refState } from "../refs/state"
import { renameTables } from "../refs/structured"
import { relationshipType } from "../write/index"
import { utf8Part } from "../write/markup"
import { OWN_SHEET_SECTIONS } from "../write/sheet"
import type { XlsxDocument } from "./document"
import { newSheetPart, relativeTarget, sheetNameRefusal } from "./structure-basic"

// A sheet duplicated (Excel's "Move or Copy" with "Create a copy"): its cells, formats, sizes, merges, views,
// protection, conditional formats, validations, hyperlinks and page setup, with its drawings (charts reading the
// copy, as Excel retargets them), notes and tables (new unique names; the copy's structured references follow) as
// parts of its own, and its local names copied to it. Formulas naming the source sheet keep naming it, as in
// Excel. What cannot be cloned is refused, naming it: pivot tables, slicers, timelines, threaded comments, form
// controls, embedded objects and named sheet views.

declare module "../../sheet/protocol" {
	interface SheetCommandMap {
		// A copy of the sheet at `index` (by default right after it), named as asked or "Name (2)".
		"sheet.duplicate": { readonly sheet: SheetId; readonly name?: string; readonly index?: number }
	}
}

const RELATIONSHIPS_NS = [
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships",
	"http://purl.oclc.org/ooxml/officeDocument/relationships"
]

// Relationship types (last segment) whose target the copy refers to as well (binaries, pictures, printer settings).
const SHARED: ReadonlySet<string> = new Set(["printerSettings", "image", "package", "hyperlink", "audio", "video", "media"])
// Parts cloned for the copy, with what they relate to.
const CLONED: ReadonlySet<string> = new Set([
	"drawing",
	"vmlDrawing",
	"comments",
	"table",
	"chart",
	"chartEx",
	"chartUserShapes",
	"chartStyle",
	"chartColorStyle",
	"themeOverride",
	"diagramData",
	"diagramLayout",
	"diagramQuickStyle",
	"diagramColors",
	"diagramDrawing"
])

// Sections the copy's model writes anew: its cells, and the dimension they cover.
const MODEL_WRITTEN: ReadonlySet<string> = new Set(["sheetData", "dimension"])

function refused(detail: string): { refused: SheetRefusal } {
	return { refused: { reason: "structureLocked", detail } }
}

function lastSegment(type: string): string {
	return type.slice(type.lastIndexOf("/") + 1)
}

// A name no sheet has: `base` itself, else "base (2)", "base (3)", ... cut to fit 31 characters.
export function copyName(document: XlsxDocument, base: string): string {
	for (let n = 2; ; n++) {
		const suffix = ` (${String(n)})`
		const name = base.slice(0, 31 - suffix.length) + suffix

		if (sheetNameRefusal(document, name, null) === null) return name
	}
}

// Relationship ids in markup remapped: every attribute in the relationships namespace (and VML's o:relid) whose
// value is an old id. `prefixes` are the root's; those the markup binds on its own elements (a link or drawing an
// edit added to a root that binds none) count too.
function remapIds(markup: string, ids: ReadonlyMap<string, string>, prefixes: readonly string[]): string {
	if (ids.size === 0) return markup

	const names = [...new Set([...prefixes, ...relationshipPrefixes(markup)])].map(prefix => `${prefix.replaceAll(".", "\\.")}:[A-Za-z]+`)

	names.push("o:relid")

	return markup.replace(
		new RegExp(`(\\s(?:${names.join("|")})\\s*=\\s*(["']))(.*?)(\\2)`, "g"),
		(whole, open: string, _quote: string, value: string, close: string) => {
			const next = ids.get(value)

			return next === undefined ? whole : `${open}${next}${close}`
		}
	)
}

// The prefixes a start tag (or markup) binds to the relationships namespace.
function relationshipPrefixes(rootTag: string): string[] {
	const out: string[] = []

	for (const match of rootTag.matchAll(/\sxmlns:([A-Za-z_][\w.-]*)\s*=\s*(["'])(.*?)\2/g))
		if (RELATIONSHIPS_NS.includes(match[3] ?? "")) out.push(match[1] ?? "")

	return out
}

// Prefixes a root's start tag binds to the revision namespaces, whose uid attributes ([MS-XLSX] §2.5.10) each
// identify one object.
function revisionPrefixes(rootTag: string): string[] {
	const out: string[] = []

	for (const match of rootTag.matchAll(/\sxmlns:([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g))
		if (/^http:\/\/schemas\.microsoft\.com\/office\/spreadsheetml\/20\d\d\/revision\d*$/.test(match[2] ?? "")) out.push(match[1] ?? "")

	return out
}

// A new GUID as SpreadsheetML writes one ({XXXXXXXX-XXXX-4XXX-YXXX-XXXXXXXXXXXX}, upper-case).
export function newGuid(): string {
	const bytes = new Uint8Array(16)
	const crypto: unknown = Reflect.get(globalThis, "crypto")

	// Hermes has no Web Crypto without a polyfill; a uid only has to be unlikely to repeat.
	if (typeof crypto === "object" && crypto !== null && "getRandomValues" in crypto && typeof crypto.getRandomValues === "function")
		crypto.getRandomValues(bytes)
	else for (let k = 0; k < bytes.length; k++) bytes[k] = Math.floor(Math.random() * 256)

	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

	let hex = ""

	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")

	hex = hex.toUpperCase()

	return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}}`
}

// Every uid of the revision namespaces in markup replaced by a new one: a copy's objects are not its source's.
function freshUids(markup: string, prefixes: readonly string[]): string {
	if (prefixes.length === 0) return markup

	const names = prefixes.map(prefix => prefix.replaceAll(".", "\\.")).join("|")

	return markup.replace(
		new RegExp(`(\\s(?:${names}):uid\\s*=\\s*")[^"]*(")`, "g"),
		(_, open: string, close: string) => `${open}${newGuid()}${close}`
	)
}

interface PartOp {
	readonly name: string
	readonly contentType: string
	readonly bytes: Uint8Array
}

interface RelationshipOp {
	readonly source: string
	readonly type: string
	readonly target: string
	readonly external: boolean
}

class CopyPlan {
	readonly parts: PartOp[] = []
	readonly relationships: RelationshipOp[] = []
	private readonly taken = new Set<string>()
	private readonly changes: XlsxWorkbookModel["changes"]

	constructor(workbook: XlsxWorkbookModel) {
		for (const part of workbook.parts.parts()) this.taken.add(partKey(part.name))
		// Sheets added since open have parts no package or change holds yet.
		for (const sheet of workbook.sheets) if (sheet.part !== "") this.taken.add(partKey(sheet.part))
		for (const name of workbook.changes.parts.keys()) this.taken.add(partKey(name))

		this.changes = workbook.changes
	}

	// Taken, or a part's name since open (an undone copy's): its retired relationships keep their ids.
	private used(name: string): boolean {
		return this.taken.has(partKey(name)) || (this.changes instanceof ChangeLog && this.changes.hadName(name))
	}

	take(name: string): void {
		this.taken.add(partKey(name))
	}

	// A free name beside `name`: its digits before the extension replaced by the first free number.
	freeName(name: string): string {
		const match = /^(.*?)(\d*)(\.[^./]*)$/.exec(name)
		const stem = match?.[1] ?? name
		const extension = match?.[3] ?? ""

		for (let n = 1; ; n++) {
			const candidate = `${stem}${String(n)}${extension}`

			if (!this.used(candidate)) {
				this.taken.add(partKey(candidate))

				return candidate
			}
		}
	}
}

interface CopyContext {
	readonly document: XlsxDocument
	readonly plan: CopyPlan
	readonly source: XlsxSheetEntry
	readonly name: string
	// The copy's table names by the source's (upper-case), and every name a table or defined name has (upper-case).
	readonly tables: Map<string, string>
	readonly tableNames: Set<string>
	readonly tableIds: { next: number }
	readonly vmlBlocks: { next: number }
}

// The part `name` cloned (and what it relates to, as its relationship types say), under a free name; returns it.
async function clonePart(context: CopyContext, name: string, kind: string): Promise<string> {
	const { document, plan } = context
	const workbook = document.workbook
	const state = refState(workbook)
	const bytes = await state.partBytes(name)
	const contentType = workbook.parts.get(name)?.contentType ?? (workbook.changes.parts.get(name) ?? null)?.contentType

	if (bytes === null || contentType === undefined) throw new CopyRefused(`part ${name}`)

	const cloned = plan.freeName(name)
	const ids = new Map<string, string>()

	// Read (empty) now, so relationships can be added to it without a wait.
	await workbook.parts.relationships(cloned)

	const relationships = liveRelationships(workbook, name, (await workbook.parts.relationships(name)).all)
	let markup = decodeUtf8(bytes)

	// Its own relationships: ids allocated in order from rId1.
	relationships.forEach((relationship, k) => ids.set(relationship.id, `rId${String(k + 1)}`))

	for (const relationship of relationships) {
		const type = lastSegment(relationship.type)

		if (relationship.external || relationship.partName === undefined) {
			plan.relationships.push({
				source: cloned,
				type: relationship.type,
				target: relationship.target,
				external: relationship.external
			})

			continue
		}

		let target = relationship.partName

		if (CLONED.has(type)) target = await clonePart(context, relationship.partName, type)
		else if (!SHARED.has(type) && !/(^|\/)(media|embeddings)\//i.test(relationship.partName))
			throw new CopyRefused(`relationship ${type}`)

		plan.relationships.push({ source: cloned, type: relationship.type, target: relativeTarget(cloned, target), external: false })
	}

	const root = /<[^?!][^>]*>/.exec(markup)?.[0] ?? ""

	markup = freshUids(remapIds(markup, ids, relationshipPrefixes(root)), revisionPrefixes(root))

	if (kind === "chart" || kind === "chartEx") {
		if (/<(?:\w+:)?pivotSource\b/.test(markup)) throw new CopyRefused("pivot chart")

		const formulas = new FormulaShift({ kind: "renameSheet", target: context.source.name, name: context.name })

		markup = decodeUtf8(rewriteChart(encodeUtf8(markup), { own: null, shift: null, formulas, touch: () => undefined }, cloned))
	} else if (kind === "vmlDrawing") {
		markup = renumberVml(markup, context.vmlBlocks)
	} else if (kind === "table") {
		markup = renameTable(context, markup)
	}

	plan.parts.push({ name: cloned, contentType, bytes: encodeUtf8(markup) })

	return cloned
}

class CopyRefused extends Error {
	readonly detail: string

	constructor(detail: string) {
		super(detail)
		this.detail = detail
	}
}

// A legacy drawing's shape ids live in blocks of 1,024 its idmap names, unique in the workbook: the copy takes the
// next free block.
function renumberVml(markup: string, blocks: { next: number }): string {
	const idmap = /(<o:idmap\b[^>]*\sdata\s*=\s*")([^"]*)(")/.exec(markup)
	const old = Number((idmap?.[2] ?? "").split(",")[0])

	if (idmap === null || !Number.isInteger(old)) return markup

	const block = blocks.next++
	const shapes = (text: string): string =>
		text.replace(/_x0000_s(\d+)/g, (_, id: string) => `_x0000_s${String(Number(id) - old * 1024 + block * 1024)}`)

	return shapes(markup.replace(idmap[0], `${idmap[1] ?? ""}${String(block)}${idmap[3] ?? ""}`))
}

// A table's copy: the next free id, and a name no table or defined name has ("Name_2", ...).
function renameTable(context: CopyContext, markup: string): string {
	const document = parseXml(encodeUtf8(markup))
	const root = document.documentElement()
	const name = document.attribute(root, "displayName") ?? document.attribute(root, "name") ?? "Table"
	let next = ""

	for (let n = 2; ; n++) {
		next = `${name}_${String(n)}`

		if (!context.tableNames.has(next.toUpperCase())) break
	}

	context.tables.set(name.toUpperCase(), next)
	context.tableNames.add(next.toUpperCase())

	const editor = new XmlEditor(document)

	editor.setAttribute(root, "id", String(context.tableIds.next++))
	editor.setAttribute(root, "displayName", next)

	if (document.attribute(root, "name") !== undefined) editor.setAttribute(root, "name", next)

	// Its own formulas that name it (calculated and totals) follow it.
	return renameTables(decodeUtf8(editor.serialize()), new Map([[name.toUpperCase(), next]]))
}

// The workbook's highest table id and legacy drawing block and its table names, so the copy's are new: the
// source package's parts (removed ones too: an undo brings them back) and every part edits wrote, earlier copies'
// among them (ECMA-376 Part 1 §18.5.1.2: a table's id and name are unique in the workbook).
async function usedIds(workbook: XlsxWorkbookModel): Promise<{ table: number; vml: number; names: Set<string> }> {
	const names = new Set<string>()
	let table = 0
	let vml = 0
	const relevant = (contentType: string): boolean => {
		const type = contentType.toLowerCase()

		return type.endsWith("table+xml") || type.endsWith("vmldrawing")
	}
	const scan = (contentType: string, bytes: Uint8Array): void => {
		const text = decodeUtf8(bytes)

		if (contentType.toLowerCase().endsWith("table+xml")) {
			const root = /<(?:\w+:)?table\b[^>]*>/.exec(text)?.[0] ?? ""

			table = Math.max(table, Number(/\sid="(\d+)"/.exec(root)?.[1] ?? "0"))

			for (const match of root.matchAll(/\s(?:displayName|name)="([^"]*)"/g)) names.add((match[1] ?? "").toUpperCase())
		} else {
			for (const match of text.matchAll(/<o:idmap\b[^>]*\sdata\s*=\s*"([^"]*)"/g))
				for (const block of (match[1] ?? "").split(",")) vml = Math.max(vml, Number(block) || 0)
		}
	}

	for (const part of workbook.parts.parts()) {
		if (!relevant(part.contentType)) continue

		const bytes = await workbook.parts.read(part.name).catch(() => null)

		if (bytes !== null) scan(part.contentType, bytes)
	}

	for (const write of workbook.changes.parts.values())
		if (write !== null && relevant(write.contentType)) scan(write.contentType, await joinBytes(await write.write(workbook)))

	for (const defined of workbook.definedNames) names.add(defined.name.toUpperCase())

	return { table, vml, names }
}

export async function duplicateSheet(
	document: XlsxDocument,
	sheet: SheetId,
	requested: string | undefined,
	index: number | undefined,
	changes: SheetChangeSink,
	slicing?: Slicing
): Promise<SheetHandled> {
	const workbook = document.workbook
	const sheets = workbook.sheets
	const clock = slicing === undefined ? undefined : sliceClock(slicing)
	const position = sheets.findIndex(entry => entry.id === sheet)
	const source = sheets[position]

	if (source === undefined) return { refused: { reason: "unsupported", detail: "sheet" } }
	if (source.kind !== "worksheet") return refused(source.kind)
	if (sheets.length >= workbook.limits.maxSheets) return { refused: { reason: "tooLarge" } }

	await document.readyAllSheets()

	const model = source.model

	if (!document.allReady || model === null) return refused("unreadSheet")

	const name = requested ?? copyName(document, source.name)
	const nameRefusal = sheetNameRefusal(document, name, null)

	if (nameRefusal !== null) return { refused: nameRefusal }

	const at = index === undefined ? position + 1 : Math.max(0, Math.min(sheets.length, Math.floor(index)))
	const state = refState(workbook)
	const plan = new CopyPlan(workbook)
	const used = await usedIds(workbook)
	const part = newSheetPart(document)

	plan.take(part)
	const context: CopyContext = {
		document,
		plan,
		source,
		name,
		tables: new Map(),
		tableNames: used.names,
		tableIds: { next: used.table + 1 },
		vmlBlocks: { next: used.vml + 1 }
	}
	const sourceRelationships = liveRelationships(workbook, source.part, model.relationships.all)
	const ids = new Map<string, string>()
	const relationships: RelationshipOp[] = []

	await workbook.parts.relationships(workbook.workbookPart)
	await workbook.parts.relationships(part)

	// The copy's own name of each table, so structured references in the copy follow its tables.
	const renamedTables = context.tables

	try {
		sourceRelationships.forEach((relationship, k) => ids.set(relationship.id, `rId${String(k + 1)}`))

		for (const relationship of sourceRelationships) {
			const type = lastSegment(relationship.type)

			if (relationship.external || relationship.partName === undefined) {
				relationships.push({ source: part, type: relationship.type, target: relationship.target, external: relationship.external })

				continue
			}

			let target = relationship.partName

			if (CLONED.has(type)) target = await clonePart(context, relationship.partName, type)
			else if (!SHARED.has(type)) throw new CopyRefused(`relationship ${type}`)

			relationships.push({ source: part, type: relationship.type, target: relativeTarget(part, target), external: false })
		}
	} catch (error) {
		if (error instanceof CopyRefused) return refused(error.detail)
		// A part another edit wrote, which the copy cannot read as it now is.
		if (error instanceof RefRefused) return { refused: error.refusal }

		throw error
	}

	// The copy's cells, rows and formulas: the source's blocks cloned array by array (new rows, no source spans),
	// its own strings and formula records re-made, cells carrying markup the model does not carrying it on.
	const sourceStore = model.store as SheetStore
	const formulas = new FormulaTable()
	const strings = new SheetStrings()
	const formulaIds = new Map<number, number>()
	const blocks: RowBlock[] = []
	const carried: { block: number; k: number; slot: number }[] = []
	let sharedStrings = 0

	for (let b = 0; b < sourceStore.blocks.length; b++) {
		// A block at a time: the in-thread host's slices end between blocks (calls wait in the session's order).
		if (clock?.due === true) await clock.pause()

		const block = sourceStore.blocks[b] as RowBlock
		const values = block.values.slice()
		const kinds = block.kinds
		let ids: Int32Array | null = null

		for (let k = 0; k < kinds.length; k++) {
			const kind = kinds[k] as CellKind

			if (kind === CellKind.SHARED_STRING) sharedStrings++
			else if (kind !== CellKind.EMPTY && kind !== CellKind.NUMBER && kind !== CellKind.BOOLEAN)
				values[k] = strings.intern(sourceStore.strings.text(values[k] ?? 0))
		}

		if (block.formulas !== null) {
			ids = new Int32Array(block.formulas.length)

			for (let k = 0; k < ids.length; k++) {
				const old = block.formulas[k] ?? -1
				let mapped = old < 0 ? -1 : formulaIds.get(old)

				if (mapped === undefined) {
					const record = sourceStore.formulas.formula(old)

					mapped = formulas.add({ ...record, text: renameTables(record.text, renamedTables) })
					formulaIds.set(old, mapped)
				}

				ids[k] = mapped
			}
		}

		const flags = new Uint16Array(block.rowCount)

		for (let i = 0; i < block.rowCount; i++) flags[i] = ((block.rowFlags[i] ?? 0) & ~ROW_MARKS) | RowFlag.DIRTY | RowFlag.NEW

		const origins = new Uint32Array(kinds.length)

		for (let i = 0; i < block.rowCount; i++)
			for (let k = block.rowStarts[i] ?? 0; k < (block.rowStarts[i + 1] ?? 0); k++) {
				const slot = b * SLOT_BLOCK + k

				if (sourceStore.carriesMarkup(slot)) carried.push({ block: b, k, slot })
			}

		blocks.push(
			new RowBlock(
				block.firstRow,
				block.firstRow,
				block.rows.slice(),
				block.rowStarts.slice(),
				new Uint32Array(block.rowCount * 2).fill(NO_SPAN),
				flags,
				block.rowHeights.slice(),
				block.rowStyles.slice(),
				block.cols.slice(),
				kinds.slice(),
				values,
				block.styles.slice(),
				ids,
				origins
			)
		)
	}

	const store = new SheetStore(blocks, strings, formulas)

	for (const { block, k, slot } of carried) {
		const origin = sourceStore.sourceCell(slot, model.part)
		const target = blocks[block]?.origins

		if (origin !== null && target !== undefined && target !== null) target[k] = store.carry(origin)
	}

	// The source's sections as it now writes them, for the copy: ids remapped, namespaces declared. Those the writer
	// serialises from the model (tab colour, view, formats, column ranges, merges, protection) keep what the model
	// does not hold (other views, split panes, attributes): the copy's model is written into them, and a fresh part's
	// writer edits them as the source's edits its own. The others are held as they are.
	const sourceBytes = await workbook.parts.read(source.part).catch(() => null)
	const sourcePart = sourceBytes === null ? null : utf8Part(sourceBytes)
	// The source root's start tag: the copy's root takes it (its namespaces and mc:Ignorable cover the markup it
	// copies, ECMA-376 Part 3 §10.2.1), its uid new. A source that is itself a copy has the root it took.
	const rootTag =
		model.freshRoot !== undefined
			? model.freshRoot
			: sourcePart === null
				? ""
				: model instanceof XlsxSheet && model.rootOpenEnd > model.rootStart
					? decodeUtf8(sourcePart.subarray(model.rootStart, model.rootOpenEnd))
					: (/<[A-Za-z_][^>]*>/.exec(decodeUtf8(sourcePart.subarray(0, Math.min(sourcePart.length, 8192))))?.[0] ?? "")
	const sourcePrefix = model instanceof XlsxSheet ? model.prefix : ""
	const prefixes = relationshipPrefixes(rootTag)
	const uids = revisionPrefixes(rootTag)
	const copied: { name: string; markup: string; own: boolean }[] = []
	const marked = workbook.changes.sheets.get(model.id)?.sections

	try {
		// The source's sections, and the ones an edit added (a validation given to a sheet that had none).
		for (const section of new Set([...model.sections.map(candidate => candidate.name), ...state.heldSections(model)])) {
			if (MODEL_WRITTEN.has(section)) continue

			// The model's own sections as read (the model is written into them below), unless the catalogue holds them.
			const own = OWN_SHEET_SECTIONS.has(section)
			const markup =
				own && !state.ownsSection(marked?.get(section))
					? model.sections
							.filter(candidate => candidate.name === section)
							.map(candidate => decodeUtf8(candidate.bytes ?? new Uint8Array(0)))
							.join("")
					: state.sectionMarkup(model, section).join("")
			let next = freshUids(remapIds(markup, ids, prefixes), uids)

			if (section === "sheetPr") next = next.replace(/\scodeName\s*=\s*"[^"]*"/, "")

			copied.push({ name: section, markup: next, own })
		}
	} catch (error) {
		if (error instanceof RefRefused) return { refused: error.refusal }

		throw error
	}

	const id = workbook.allocateSheetId()
	const copySections: XlsxSection[] = []
	const copy = new XlsxSheet({
		id,
		part,
		store,
		sections: copySections,
		relationships: new Relationships([]),
		rootStart: 0,
		rootOpenEnd: 0,
		rootEnd: 0,
		prefix: rootTag === "" ? "" : sourcePrefix,
		utf16: false,
		...(rootTag !== "" && { freshRoot: freshUids(rootTag, uids) })
	})

	copy.cols = model.cols
	copy.merges = model.merges.slice()
	copy.format = model.format
	copy.view = { ...model.view, tabSelected: false }
	copy.protection = model.protection
	copy.tabColor = model.tabColor

	// An OpenDocument sheet's formats of empty cells and runs of rows are its copy's too (immutable, so shared).
	const runs: XlsxSheetModel = copy

	if (model.styleRuns !== undefined) runs.styleRuns = model.styleRuns

	if (model.rowRuns !== undefined) {
		runs.rowRuns = model.rowRuns
		store.rowBase = row => rowRunAt(runs.rowRuns, row)
	}

	if (model.fitToPage !== undefined) {
		const copied: XlsxSheetModel = copy

		copied.fitToPage = model.fitToPage
	}

	for (const section of copied) {
		const writer = section.own ? OWN_SHEET_SECTIONS.get(section.name) : undefined

		if (writer !== undefined) {
			const written = writer(copy, encodeUtf8(section.markup), copy.prefix)

			section.markup = written === null ? "" : decodeUtf8(written)
		}

		if (section.markup !== "") copySections.push({ name: section.name, start: 0, end: 0, bytes: encodeUtf8(section.markup) })
	}

	const entry: XlsxSheetEntry = {
		id,
		name,
		state: "visible",
		kind: "worksheet",
		sheetId: sheets.reduce((highest, other) => Math.max(highest, other.sheetId), 0) + 1,
		relationshipId: "",
		part,
		model: copy
	}

	// Local names of the source go with the copy, naming it.
	const names = { before: workbook.definedNames.slice(), after: workbook.definedNames.slice() }

	// Workbook names that refer to the source get a local copy referring to the copy (as LibreOffice and Excel copy a
	// sheet), unless the source has a local name of its own by that name.
	const local = new Set(names.before.filter(defined => defined.sheet === sheet).map(defined => defined.name.toUpperCase()))

	for (const defined of names.before) {
		if (defined.sheet === null && !local.has(defined.name.toUpperCase())) {
			const formula = renameSheetInFormula(defined.formula, source.name, name)

			if (formula === defined.formula) continue

			const copied = nameWithFormula({ ...defined, sheet: id }, formula)

			if (copied === null) return refused(`definedNames: ${defined.name}`)

			names.after.push(copied)

			continue
		}

		if (defined.sheet !== sheet) continue

		const formula = renameTables(renameSheetInFormula(defined.formula, source.name, name), renamedTables)
		const copied: XlsxDefinedName | null = nameWithFormula({ ...defined, sheet: id }, formula)

		if (copied === null) return refused(`definedNames: ${defined.name}`)

		names.after.push(copied)
	}

	// Each relationship added, with its source part.
	const added: { source: string; relationship: Relationship }[] = []
	const activeBefore = workbook.activeTab
	const activeAfter = at <= activeBefore ? activeBefore + 1 : activeBefore
	const forward = (sink: SheetChangeSink): void => {
		const changeLog = workbook.changes

		// Held by the catalogue, so later structure edits move them as they move the source's.
		for (const op of plan.parts) state.setPart(op.name, op.contentType, op.bytes)

		added.length = 0

		const sheetRelationship = changeLog.addRelationship(workbook.workbookPart, {
			type: relationshipType(workbook.strict, "worksheet"),
			target: relativeTarget(workbook.workbookPart, part)
		})

		added.push({ source: workbook.workbookPart, relationship: sheetRelationship })

		for (const op of [...relationships, ...plan.relationships])
			added.push({
				source: op.source,
				relationship: changeLog.addRelationship(op.source, {
					type: op.type,
					target: op.target,
					...(op.external && { external: true })
				})
			})

		;(entry as { relationshipId: string }).relationshipId = sheetRelationship.id
		sheets.splice(at, 0, entry)
		workbook.activeTab = activeAfter
		changeLog.workbookSection("sheets")

		if (activeAfter !== activeBefore) changeLog.workbookSection("bookViews")
		if (names.after.length !== names.before.length) {
			spliceAll(workbook.definedNames, 0, workbook.definedNames.length, names.after)
			changeLog.workbookSection("definedNames")
		}
		if (sharedStrings > 0) {
			workbook.sharedStrings.adjustReferences(sharedStrings)
			changeLog.sharedStringsAppended()
		}

		for (const section of copied) if (!section.own) state.setSection(copy, section.name, [section.markup])

		// Results shown for formulas the file keeps none for show in the copy too.
		const shown = document.shownResults.get(sheet)

		if (shown !== undefined && shown.size > 0) document.shownResults.set(id, new Map(shown))

		document.dropEngine()
		document.structureChanged()
		sink.sheets()
	}

	forward(changes)

	return {
		bytes: 4096 + store.estimateBytes() + plan.parts.reduce((sum, op) => sum + op.bytes.length, 0),
		undo: async sink => {
			const changeLog = workbook.changes
			const at = sheets.indexOf(entry)

			if (at >= 0) sheets.splice(at, 1)

			for (const { source, relationship } of [...added].reverse()) changeLog.removeRelationship(source, relationship.id)

			for (const op of plan.parts) state.setPart(op.name, op.contentType, undefined)

			workbook.activeTab = activeBefore
			spliceAll(workbook.definedNames, 0, workbook.definedNames.length, names.before)
			document.shownResults.delete(id)

			if (names.after.length !== names.before.length) changeLog.workbookSection("definedNames")
			if (sharedStrings > 0) workbook.sharedStrings.adjustReferences(-sharedStrings)

			document.dropEngine()
			document.structureChanged()
			await document.loadTables()
			sink.sheets()
		},
		redo: async sink => {
			forward(sink)
			await document.loadTables()
		}
	}
}

export const sheetCopyFeature = defineSheetFeature<XlsxDocument>({
	id: "sheetCopy",
	commands: {
		"sheet.duplicate": {
			info: { write: true, structure: true },
			run: (context, command) =>
				duplicateSheet(context.doc, command.sheet, command.name, command.index, context.changes, context.slicing)
		}
	}
})
