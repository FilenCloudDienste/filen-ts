import { decodeUtf8, encodeUtf8 } from "../../xml/index"
import { mayReturnArray } from "../../sheet/refs/formulaRefs"
import type { XlsxWorkbookModel } from "../model/types"
import { refState } from "../refs/state"

// Dynamic arrays in a workbook (support.microsoft.com "Dynamic array formulas and spilled array behavior"; [MS-XLSX]
// 2.6.97 dynamicArrayProperties): a dynamic-array formula is an array formula (t="array") whose cell metadata (cm)
// points at a cell metadata record of type XLDAPR with fDynamic set, in the workbook's metadata part
// (ECMA-376 Part 1 §18.9). Its ref is what it spills over; the values there are stored in their cells.

export const SHEET_METADATA_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata"
export const SHEET_METADATA_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"

const XLDAPR = "XLDAPR"
// The future metadata extension Excel writes for XLDAPR ([MS-XLSX] 2.6.97).
const DYNAMIC_ARRAY_EXTENSION = "{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"
const DYNAMIC_ARRAY_NAMESPACE = "http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray"

// The workbook's cell metadata as dynamic arrays read it: the cm values that mark one, and the cm a new one is
// written with (null when the workbook has a metadata part this cannot add one to).
export interface DynamicArrays {
	readonly dynamic: ReadonlySet<number>
	readonly cm: number | null
	// The metadata part to create with the first dynamic array (none yet).
	readonly create: string | null
}

const NONE: DynamicArrays = { dynamic: new Set(), cm: null, create: "xl/metadata.xml" }

// OpenDocument has no dynamic-array metadata: a dynamic array is written as a matrix formula over its spill (ODF 1.3
// Part 3 §19.680-§19.681), read back as one whose formula may give an array (typedSpills). The session marks those
// with this cm, which no part holds.
export const ODS_DYNAMIC_CM = 1
export const ODS_DYNAMIC_ARRAYS: DynamicArrays = { dynamic: new Set([ODS_DYNAMIC_CM]), cm: ODS_DYNAMIC_CM, create: null }

function attribute(tag: string, name: string): string | undefined {
	return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]
}

// The blocks (bk) of one element of the metadata part, each block's text.
function blocks(text: string, element: string, name?: string): string[] {
	const pattern = new RegExp(`<(?:\\w+:)?${element}\\b([^>]*)>([\\s\\S]*?)</(?:\\w+:)?${element}>`, "g")

	for (const match of text.matchAll(pattern)) {
		if (name !== undefined && attribute(match[1] ?? "", "name") !== name) continue

		return [...(match[2] ?? "").matchAll(/<(?:\w+:)?bk\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?bk>)/g)].map(block => block[1] ?? "")
	}

	return []
}

// The cm values a metadata part marks dynamic: cm n is the n-th cellMetadata block (Excel writes them from 1), whose
// record's type (t, from 1) is XLDAPR and whose value (v, from 0) is a future metadata block with fDynamic="1".
export function dynamicCellMetadata(text: string): DynamicArrays {
	const types = [...text.matchAll(/<(?:\w+:)?metadataType\b[^>]*>/g)].map(match => attribute(match[0], "name") ?? "")
	const future = blocks(text, "futureMetadata", XLDAPR).map(block => {
		const properties = /<(?:\w+:)?dynamicArrayProperties\b[^>]*>/.exec(block)?.[0] ?? ""
		const flag = attribute(properties, "fDynamic")

		return flag === "1" || flag === "true"
	})
	const dynamic = new Set<number>()

	blocks(text, "cellMetadata").forEach((block, index) => {
		const record = /<(?:\w+:)?rc\b[^>]*>/.exec(block)?.[0] ?? ""
		const type = Number(attribute(record, "t"))
		const value = Number(attribute(record, "v"))

		if (types[type - 1] === XLDAPR && future[value] === true) dynamic.add(index + 1)
	})

	const first = [...dynamic][0]

	return { dynamic, cm: first ?? null, create: null }
}

// Reads the workbook's metadata part, as edits left it.
export async function readDynamicArrays(workbook: XlsxWorkbookModel): Promise<DynamicArrays> {
	const relationships = await workbook.parts.relationships(workbook.workbookPart)
	const added = workbook.changes.relationships.get(workbook.workbookPart)
	const relationship = [...relationships.all.filter(entry => added?.removed.has(entry.id) !== true), ...(added?.added ?? [])].find(
		entry => entry.type === SHEET_METADATA_TYPE && !entry.external && entry.partName !== undefined
	)

	if (relationship?.partName === undefined) return NONE

	const bytes = await refState(workbook).partBytes(relationship.partName)

	return bytes === null ? NONE : dynamicCellMetadata(decodeUtf8(bytes))
}

// The metadata part Excel writes for dynamic arrays alone: one XLDAPR record, cm 1.
const METADATA =
	'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
	'<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
	`xmlns:xda="${DYNAMIC_ARRAY_NAMESPACE}">` +
	`<metadataTypes count="1"><metadataType name="${XLDAPR}" minSupportedVersion="120000" copy="1" pasteAll="1" ` +
	'pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" ' +
	'cellMeta="1"/></metadataTypes>' +
	`<futureMetadata name="${XLDAPR}" count="1"><bk><extLst><ext uri="${DYNAMIC_ARRAY_EXTENSION}">` +
	'<xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata>' +
	'<cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata></metadata>'

// The metadata part made for a workbook's first dynamic array: taken away again (an undo of the edit that made it)
// and made again (its redo).
export interface MadeMetadata {
	readonly remove: () => void
	readonly add: () => void
}

// The cm a new dynamic array is written with, the metadata part made for it first when the workbook has none (`made`);
// null when its metadata part has no XLDAPR record (another feature's part, which this does not rewrite).
export function dynamicArrayCm(
	workbook: XlsxWorkbookModel,
	arrays: DynamicArrays
): { cm: number; arrays: DynamicArrays; made?: MadeMetadata } | null {
	if (arrays.cm !== null) return { cm: arrays.cm, arrays }
	if (arrays.create === null) return null

	let name = arrays.create
	const taken = (part: string): boolean => workbook.parts.get(part) !== undefined || workbook.changes.parts.get(part) !== undefined

	for (let index = 2; taken(name); index++) name = `xl/metadata${String(index)}.xml`

	let relationship = ""
	const add = (): void => {
		refState(workbook).setPart(name, SHEET_METADATA_CONTENT_TYPE, encodeUtf8(METADATA))
		relationship = workbook.changes.addRelationship(workbook.workbookPart, {
			type: SHEET_METADATA_TYPE,
			target: name.slice("xl/".length)
		}).id
	}
	const remove = (): void => {
		workbook.changes.removeRelationship(workbook.workbookPart, relationship)
		refState(workbook).setPart(name, SHEET_METADATA_CONTENT_TYPE, undefined)
	}

	add()

	return { cm: 1, arrays: { dynamic: new Set([1]), cm: 1, create: null }, made: { remove, add } }
}

// Whether a formula typed now is written as a dynamic array: one that may give an array (an array function, a range
// alone, a range in an operation), which Excel calculates as an array and stores as one.
export function typedSpills(formula: string): boolean {
	return mayReturnArray(formula)
}
