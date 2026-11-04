import type { SheetId, SheetState } from "../../sheet/protocol"
import { Namespaces, type XmlDocument } from "../../xml/index"
import type { XlsxCalcProperties, XlsxDefinedName, XlsxFileSharing, XlsxSection, XlsxWorkbookProtection } from "../model/types"
import { XlsxReadError } from "./errors"
import type { XlsxLimits } from "./limits"
import { booleanAttribute, childByLocal, childElements, intAttribute, intValue, numberAttribute, parseBoolean } from "./styleRecords"
import { readProtectionHash } from "./worksheet"

// workbook.xml (ECMA-376 Part 1 §18.2.27 CT_Workbook): its children as sections, the sheet list, the defined
// names and the properties the model exposes.

export const SPREADSHEETML_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
export const STRICT_SPREADSHEETML_NAMESPACE = "http://purl.oclc.org/ooxml/spreadsheetml/main"
const RELATIONSHIP_NAMESPACES = [
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships",
	"http://purl.oclc.org/ooxml/officeDocument/relationships"
]

export interface WorkbookSheetRecord {
	readonly name: string
	readonly sheetId: number
	readonly state: SheetState
	readonly relationshipId: string
}

export interface WorkbookNameRecord {
	readonly name: string
	// localSheetId: an index into the sheet list; -1 for a workbook-wide name.
	readonly localSheetId: number
	readonly formula: string
	readonly hidden: boolean
	// The element's bytes: [start, end) of its section's copy, which every name of the section shares.
	readonly section: Uint8Array
	readonly start: number
	readonly end: number
}

export interface WorkbookFacts {
	readonly strict: boolean
	readonly sections: readonly XlsxSection[]
	readonly sheets: readonly WorkbookSheetRecord[]
	readonly names: readonly WorkbookNameRecord[]
	readonly calc: XlsxCalcProperties
	readonly protection: XlsxWorkbookProtection | null
	readonly fileSharing: XlsxFileSharing | null
	readonly activeTab: number
	readonly date1904: boolean
}

const CALC_MODES: ReadonlySet<string> = new Set(["auto", "manual", "autoNoTable"])
const DEFINED_NAME_ATTRIBUTES = ["name", "localSheetId", "hidden"]

const SECTION = Symbol("section")
const START = Symbol("start")
const END = Symbol("end")

interface SourcedName {
	readonly [SECTION]: Uint8Array
	readonly [START]: number
	readonly [END]: number
}

function sourceOf(this: SourcedName): Uint8Array {
	return this[SECTION].subarray(this[START], this[END])
}

// An enumerable own accessor, so a spread or a copy still gets the bytes; one getter for every name.
const SOURCE: PropertyDescriptor = { get: sourceOf, enumerable: true, configurable: true }

// A defined name read from the workbook part: its source element is made on access from the section's one copy,
// where a view held per name would cost about as much as the name's decoded text.
export function sourcedName(record: WorkbookNameRecord, sheet: SheetId | null): XlsxDefinedName {
	const name = { name: record.name, sheet, formula: record.formula, hidden: record.hidden }

	Object.defineProperty(name, "source", SOURCE)

	const sourced = name as unknown as { -readonly [K in keyof SourcedName]: SourcedName[K] }

	sourced[SECTION] = record.section
	sourced[START] = record.start
	sourced[END] = record.end

	return name as unknown as XlsxDefinedName
}

export function readWorkbook(document: XmlDocument, part: string, limits: XlsxLimits): WorkbookFacts {
	const namespaces = new Namespaces(document, { lenient: true })
	const root = document.documentElement()
	const rootUri = namespaces.elementUri(root)

	if (document.localName(root) !== "workbook" || (rootUri !== SPREADSHEETML_NAMESPACE && rootUri !== STRICT_SPREADSHEETML_NAMESPACE)) {
		throw new XlsxReadError("malformed", "The workbook part has no SpreadsheetML workbook root", part)
	}

	const rootPrefix = document.prefix(root)
	const sections: XlsxSection[] = []
	let children = 0

	// Counted before any is copied.
	for (let child = document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		if (++children > limits.maxSections)
			throw new XlsxReadError("tooLarge", "The workbook part holds more sections than the limit", part)
	}

	for (const child of childElements(document, root)) {
		const name = document.prefix(child) === rootPrefix ? document.localName(child) : document.name(child)

		sections.push({ name, start: document.start(child), end: document.end(child), bytes: document.raw(child).slice() })
	}

	const sheets: WorkbookSheetRecord[] = []
	const sheetsNode = childByLocal(document, root, "sheets")

	for (const sheet of sheetsNode < 0 ? [] : childElements(document, sheetsNode)) {
		if (document.localName(sheet) !== "sheet") continue
		if (sheets.length >= limits.maxSheets) throw new XlsxReadError("tooLarge", "Too many sheets", part)

		const state = document.attribute(sheet, "state")

		sheets.push({
			name: document.attribute(sheet, "name") ?? "",
			sheetId: intAttribute(document, sheet, "sheetId", 0),
			state: state === "hidden" || state === "veryHidden" ? state : "visible",
			relationshipId: RELATIONSHIP_NAMESPACES.map(uri => namespaces.attribute(sheet, uri, "id")).find(id => id !== undefined) ?? ""
		})
	}

	const names: WorkbookNameRecord[] = []
	const namesNode = childByLocal(document, root, "definedNames")
	const namesStart = namesNode < 0 ? -1 : document.start(namesNode)
	const namesBytes = sections.find(section => section.start === namesStart)?.bytes ?? new Uint8Array(0)

	for (const node of namesNode < 0 ? [] : childElements(document, namesNode)) {
		if (document.localName(node) !== "definedName") continue
		if (names.length >= limits.maxDefinedNames) throw new XlsxReadError("tooLarge", "Too many defined names", part)

		const [name, localSheetId, hidden] = document.attributeValues(node, DEFINED_NAME_ATTRIBUTES)

		names.push({
			name: name ?? "",
			localSheetId: intValue(localSheetId, -1),
			formula: document.textContent(node),
			hidden: parseBoolean(hidden) ?? false,
			section: namesBytes,
			start: document.start(node) - namesStart,
			end: document.end(node) - namesStart
		})
	}

	const calcNode = childByLocal(document, root, "calcPr")
	const mode = calcNode < 0 ? undefined : document.attribute(calcNode, "calcMode")
	const calc: XlsxCalcProperties = {
		calcId: calcNode < 0 ? 0 : intAttribute(document, calcNode, "calcId", 0),
		mode: mode !== undefined && CALC_MODES.has(mode) ? (mode as XlsxCalcProperties["mode"]) : "auto",
		fullCalcOnLoad: calcNode >= 0 && booleanAttribute(document, calcNode, "fullCalcOnLoad", false),
		iterate: calcNode >= 0 && booleanAttribute(document, calcNode, "iterate", false),
		iterateCount: calcNode < 0 ? 100 : intAttribute(document, calcNode, "iterateCount", 100),
		iterateDelta: (calcNode < 0 ? undefined : numberAttribute(document, calcNode, "iterateDelta")) ?? 0.001
	}

	const protectionNode = childByLocal(document, root, "workbookProtection")
	const protection: XlsxWorkbookProtection | null =
		protectionNode < 0
			? null
			: {
					structure: booleanAttribute(document, protectionNode, "lockStructure", false),
					windows: booleanAttribute(document, protectionNode, "lockWindows", false),
					hash: readProtectionHash(document, protectionNode, "workbook", "workbookPassword")
				}

	const sharingNode = childByLocal(document, root, "fileSharing")
	const userName = sharingNode < 0 ? undefined : document.attribute(sharingNode, "userName")
	const fileSharing: XlsxFileSharing | null =
		sharingNode < 0
			? null
			: {
					readOnlyRecommended: booleanAttribute(document, sharingNode, "readOnlyRecommended", false),
					...(userName !== undefined && { userName }),
					hash: readProtectionHash(document, sharingNode, "", "reservationPassword")
				}

	const bookViews = childByLocal(document, root, "bookViews")
	const view = childByLocal(document, bookViews, "workbookView")
	const workbookPr = childByLocal(document, root, "workbookPr")

	return {
		strict: rootUri === STRICT_SPREADSHEETML_NAMESPACE,
		sections,
		sheets,
		names,
		calc,
		protection,
		fileSharing,
		activeTab: view < 0 ? 0 : Math.max(0, intAttribute(document, view, "activeTab", 0)),
		date1904: workbookPr >= 0 && booleanAttribute(document, workbookPr, "date1904", false)
	}
}
