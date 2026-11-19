import { equalBytes } from "../../docx/write/bytes"
import { decodeUtf8, encodeUtf8, escapeText, parseXml } from "../../xml/index"
import type { XlsxChangeLog, XlsxSection, XlsxWorkbookModel } from "../model/types"
import { assembleSections } from "./assemble"
import { XlsxWriteError } from "./failure"
import { attr, qualify, rootTag, toBytes } from "./markup"
import { WORKBOOK } from "./order.generated"
import { booleanField, childElement, hashFields, join, numberField, syncAttributes, textField, type AttributeField } from "./sections"
import { STRICT, TRANSITIONAL } from "./namespaces"

// workbook.xml: the sections edits marked, each written from the model as a splice of its source element.

export interface WorkbookContext {
	readonly prefix: string
	// The prefix the part binds to the relationships namespace, or null when it binds none.
	readonly relationshipsPrefix: string | null
}

type OwnWriter = (workbook: XlsxWorkbookModel, section: Uint8Array | null, context: WorkbookContext, changes: XlsxChangeLog) => Uint8Array

const WORKBOOK_HASH = {
	algorithm: "workbookAlgorithmName",
	hash: "workbookHashValue",
	salt: "workbookSaltValue",
	spin: "workbookSpinCount",
	legacy: "workbookPassword"
}
const SHARING_HASH = {
	algorithm: "algorithmName",
	hash: "hashValue",
	salt: "saltValue",
	spin: "spinCount",
	legacy: "reservationPassword"
}

export function relationshipIdName(context: WorkbookContext): string {
	return `${context.relationshipsPrefix ?? "r"}:id`
}

function sheetFields(workbook: XlsxWorkbookModel, index: number): AttributeField[] {
	const sheet = workbook.sheets[index]

	if (sheet === undefined) return []

	return [textField("name", sheet.name), textField("state", sheet.state, "visible")]
}

function writeSheets(workbook: XlsxWorkbookModel, section: Uint8Array | null, context: WorkbookContext): Uint8Array {
	const document = section === null ? null : parseXml(section)
	const id = relationshipIdName(context)
	const byRelationship = new Map<string, number>()
	const name = qualify(context.prefix, "sheets")

	if (document !== null) {
		for (let node = document.firstChildElement(document.documentElement()); node >= 0; node = document.nextSiblingElement(node)) {
			const relationship = document.attribute(node, id)

			if (document.localName(node) === "sheet" && relationship !== undefined) byRelationship.set(relationship, node)
		}
	}

	// The sheets as the source lists them (an edit and its undo): the section as written.
	if (document !== null) {
		const listed: number[] = []

		for (let node = document.firstChildElement(document.documentElement()); node >= 0; node = document.nextSiblingElement(node))
			if (document.localName(node) === "sheet") listed.push(node)

		const same =
			listed.length === workbook.sheets.length &&
			workbook.sheets.every((sheet, index) => {
				const node = listed[index] as number
				const raw = document.raw(node)

				return (
					byRelationship.get(sheet.relationshipId) === node &&
					syncAttributes(raw, document.name(node), sheetFields(workbook, index)) === raw
				)
			})

		if (same && section !== null) return section
	}

	const root = document === null ? -1 : document.documentElement()
	const open =
		document === null || document.isSelfClosing(root)
			? encodeUtf8(`<${document === null ? name : document.name(root)}>`)
			: document.bytes.subarray(0, document.openEnd(root))
	const close = encodeUtf8(`</${document === null ? name : document.name(root)}>`)
	const chunks: Uint8Array[] = [open]

	workbook.sheets.forEach((sheet, index) => {
		const node = byRelationship.get(sheet.relationshipId)

		if (document !== null && node !== undefined) {
			chunks.push(syncAttributes(document.raw(node), document.name(node), sheetFields(workbook, index)))

			return
		}

		const declare = context.relationshipsPrefix === null ? attr("xmlns:r", (workbook.strict ? STRICT : TRANSITIONAL).relationships) : ""

		chunks.push(
			encodeUtf8(
				`<${qualify(context.prefix, "sheet")}${attr("name", sheet.name)}${attr("sheetId", sheet.sheetId)}${sheet.state === "visible" ? "" : attr("state", sheet.state)}${declare}${attr(id, sheet.relationshipId)}/>`
			)
		)
	})

	chunks.push(close)

	return join(chunks)
}

// Whether every name is its source element, in the source's order and with its sheet: an edit and its undo.
function unchangedNames(workbook: XlsxWorkbookModel, section: Uint8Array): boolean {
	const document = parseXml(section)
	const index = new Map(workbook.sheets.map((sheet, position) => [sheet.id, position]))
	let k = 0

	for (let node = document.firstChildElement(document.documentElement()); node >= 0; node = document.nextSiblingElement(node)) {
		if (document.localName(node) !== "definedName") continue

		const defined = workbook.definedNames[k++]
		const raw = document.raw(node)
		const local = document.attribute(node, "localSheetId")

		if (defined === undefined || defined.source === null || defined.source.length !== raw.length) return false
		if (!equalBytes(defined.source, 0, raw, 0, raw.length)) return false
		if ((local === undefined ? undefined : Number(local)) !== (defined.sheet === null ? undefined : index.get(defined.sheet)))
			return false
	}

	return k === workbook.definedNames.length
}

function writeDefinedNames(workbook: XlsxWorkbookModel, section: Uint8Array | null, context: WorkbookContext): Uint8Array {
	// Before the empty case: a source's own empty element stays.
	if (section !== null && unchangedNames(workbook, section)) return section
	if (workbook.definedNames.length === 0) return new Uint8Array(0)

	const index = new Map(workbook.sheets.map((sheet, position) => [sheet.id, position]))
	const name = qualify(context.prefix, "definedName")
	const chunks: Uint8Array[] = [encodeUtf8(`<${qualify(context.prefix, "definedNames")}>`)]

	for (const defined of workbook.definedNames) {
		const local = defined.sheet === null ? undefined : index.get(defined.sheet)

		if (defined.sheet !== null && local === undefined)
			throw new XlsxWriteError("reference", `The name ${defined.name} belongs to a sheet that is gone`)

		if (defined.source !== null) {
			const document = parseXml(defined.source)

			chunks.push(
				syncAttributes(defined.source, document.name(document.documentElement()), [
					textField("localSheetId", local === undefined ? undefined : String(local))
				])
			)

			continue
		}

		chunks.push(
			encodeUtf8(
				`<${name}${attr("name", defined.name)}${local === undefined ? "" : attr("localSheetId", local)}${defined.hidden ? attr("hidden", 1) : ""}>${escapeText(defined.formula)}</${name}>`
			)
		)
	}

	chunks.push(encodeUtf8(`</${qualify(context.prefix, "definedNames")}>`))

	return join(chunks)
}

function calcFields(workbook: XlsxWorkbookModel, changes: XlsxChangeLog): AttributeField[] {
	const calc = workbook.calc

	return [
		numberField("calcId", calc.calcId),
		textField("calcMode", calc.mode, "auto"),
		booleanField("fullCalcOnLoad", calc.fullCalcOnLoad || changes.fullCalcOnLoad, false),
		booleanField("iterate", calc.iterate, false),
		numberField("iterateCount", calc.iterateCount, 100),
		numberField("iterateDelta", calc.iterateDelta, 0.001)
	]
}

function protectionFields(workbook: XlsxWorkbookModel): AttributeField[] | null {
	const protection = workbook.protection

	if (protection === null) return null

	return [
		...hashFields(protection.hash, WORKBOOK_HASH),
		booleanField("lockStructure", protection.structure, false),
		booleanField("lockWindows", protection.windows, false)
	]
}

function sharingFields(workbook: XlsxWorkbookModel): AttributeField[] | null {
	const sharing = workbook.fileSharing

	if (sharing === null) return null

	return [
		booleanField("readOnlyRecommended", sharing.readOnlyRecommended, false),
		textField("userName", sharing.userName),
		...hashFields(sharing.hash, SHARING_HASH)
	]
}

// The first workbookView: the active tab, and the first tab shown kept within the sheets. Without a view to hold it,
// the first tab (the default) needs none: the source's markup, or its absence, stays.
function writeBookViews(workbook: XlsxWorkbookModel, section: Uint8Array | null, context: WorkbookContext): Uint8Array {
	const last = Math.max(0, workbook.sheets.length - 1)
	const created = (): string => `<${qualify(context.prefix, "workbookView")}${attr("activeTab", workbook.activeTab)}/>`

	if (section === null) {
		if (workbook.activeTab === 0) return new Uint8Array(0)

		return encodeUtf8(`<${qualify(context.prefix, "bookViews")}>${created()}</${qualify(context.prefix, "bookViews")}>`)
	}

	const document = parseXml(section)
	const root = document.documentElement()
	const view = childElement(document, root, "workbookView")

	if (view < 0) {
		if (workbook.activeTab === 0) return section

		const open = document.openEnd(root)

		// <bookViews/> opens with its own start tag, "/>" made ">".
		if (document.isSelfClosing(root))
			return join([section.subarray(0, open - 2), encodeUtf8(`>${created()}</${document.name(root)}>`), section.subarray(open)])

		return join([section.subarray(0, open), encodeUtf8(created()), section.subarray(open)])
	}

	const firstSheet = Number(document.attribute(view, "firstSheet") ?? 0) || 0
	const fields = [numberField("activeTab", workbook.activeTab, 0), numberField("firstSheet", Math.max(0, Math.min(firstSheet, last)), 0)]
	const raw = document.raw(view)
	const written = syncAttributes(raw, document.name(view), fields)

	if (written === raw) return section

	return join([section.subarray(0, document.start(view)), written, section.subarray(document.end(view))])
}

export const OWN_WORKBOOK_SECTIONS: ReadonlyMap<string, OwnWriter> = new Map<string, OwnWriter>([
	["sheets", (workbook, section, context) => writeSheets(workbook, section, context)],
	["definedNames", (workbook, section, context) => writeDefinedNames(workbook, section, context)],
	[
		"calcPr",
		(workbook, section, context, changes) => syncAttributes(section, qualify(context.prefix, "calcPr"), calcFields(workbook, changes))
	],
	[
		"workbookProtection",
		(workbook, section, context) => {
			const fields = protectionFields(workbook)

			return fields === null ? new Uint8Array(0) : syncAttributes(section, qualify(context.prefix, "workbookProtection"), fields)
		}
	],
	[
		"fileSharing",
		(workbook, section, context) => {
			const fields = sharingFields(workbook)

			return fields === null ? new Uint8Array(0) : syncAttributes(section, qualify(context.prefix, "fileSharing"), fields)
		}
	],
	["bookViews", (workbook, section, context) => writeBookViews(workbook, section, context)]
])

// The prefix a root start tag binds to the relationships namespace (Transitional or Strict), "" for the
// default namespace, null for none.
export function boundPrefix(bytes: Uint8Array): string | null {
	const { tag } = rootTag(bytes)
	const spans = tag.attributes

	for (let k = 0; k < spans.length; k += 4) {
		const name = decodeUtf8(bytes, spans[k] ?? 0, spans[k + 1] ?? 0)
		const value = decodeUtf8(bytes, spans[k + 2] ?? 0, spans[k + 3] ?? 0)

		if (value !== TRANSITIONAL.relationships && value !== STRICT.relationships) continue
		if (name === "xmlns") return ""
		if (name.startsWith("xmlns:")) return name.slice(6)
	}

	return null
}

export interface WrittenWorkbook {
	readonly bytes: Uint8Array
	readonly prefix: string
	readonly context: WorkbookContext
	readonly names: readonly string[]
	readonly sourceNames: readonly string[]
	readonly written: ReadonlyMap<string, Uint8Array>
	// The source's sheets section: what the gate holds sheet names and ids against.
	readonly sourceSheets: Uint8Array | null
}

// Whether the source's first workbook view shows a tab that is no sheet (the reader clamps the model's): the
// view is then written from the model.
function viewOutOfRange(section: Uint8Array, sheets: number): boolean {
	const document = parseXml(section)
	const view = childElement(document, document.documentElement(), "workbookView")

	if (view < 0) return false

	const active = Number(document.attribute(view, "activeTab") ?? 0)
	const first = Number(document.attribute(view, "firstSheet") ?? 0)

	return !(active >= 0 && active < sheets && first >= 0 && first < sheets)
}

export function writeWorkbook(workbook: XlsxWorkbookModel, changes: XlsxChangeLog, source: Uint8Array): WrittenWorkbook {
	const { prefix } = rootTag(source)
	const context: WorkbookContext = { prefix, relationshipsPrefix: boundPrefix(source) }
	const sections: readonly XlsxSection[] = workbook.workbookSections
	const byName = new Map(sections.map(section => [section.name, section]))
	const marked = new Map(changes.workbookSections)

	if (changes.fullCalcOnLoad && !marked.has("calcPr")) marked.set("calcPr", null)
	// Sheets added, moved or removed: the first tab shown must stay within them, and a sheet's local names
	// follow it (localSheetId is its position).
	if (marked.has("sheets") && !marked.has("bookViews") && byName.has("bookViews")) marked.set("bookViews", null)
	if (marked.has("sheets") && !marked.has("definedNames") && workbook.definedNames.some(name => name.sheet !== null))
		marked.set("definedNames", null)

	const current = (name: string): Uint8Array | null => {
		const section = byName.get(name)

		return section === undefined ? null : (section.bytes ?? source.subarray(section.start, section.end))
	}
	const views = marked.has("bookViews") ? null : current("bookViews")

	if (views !== null && viewOutOfRange(views, workbook.sheets.length)) marked.set("bookViews", null)

	const replacements = new Map<string, Uint8Array>()

	for (const [name, writer] of marked) {
		const section = current(name)

		if (writer !== null) {
			replacements.set(name, toBytes(writer(workbook)))

			continue
		}

		const own = OWN_WORKBOOK_SECTIONS.get(name)

		if (own === undefined) throw new XlsxWriteError("write", `No writer for the ${name} section of the workbook`)

		const written = own(workbook, section, context, changes)

		if (written !== section) replacements.set(name, written)
	}

	const assembled = assembleSections({ bytes: source, sections, order: WORKBOOK, replacements })
	const written = new Map<string, Uint8Array>()

	for (const [name, markup] of replacements) if (markup.length > 0) written.set(name, markup)

	return {
		bytes: join(assembled.pieces.items),
		prefix,
		context,
		names: assembled.names,
		sourceNames: sections.map(section => section.name),
		written,
		sourceSheets: current("sheets")
	}
}
