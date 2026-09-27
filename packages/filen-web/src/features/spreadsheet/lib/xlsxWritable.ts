import type { RoundtripWorkbook } from "hucre/xlsx"
import { isWorksheet } from "@/features/spreadsheet/lib/xlsxView"

// Whether saveXlsx can write this workbook back without breaking it. It rewrites the workbook and every
// worksheet from the model but keeps the parts it does not model (charts' drawings, pivot tables, threaded
// comments, slicers) as the file had them, and re-attaches those to sheets by POSITION: the n-th sheet
// gets xl/worksheets/sheet{n}.xml's relationships and threadedComment{n}.xml. It also writes a chart sheet
// as an empty worksheet, and keeps only the workbook relationships it knows. Where any of that would move,
// drop or orphan a part, the workbook opens view-only. When in doubt, it does.

interface Relationship {
	id: string
	type: string
	target: string
}

const decoder = new TextDecoder()

function decodeXml(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (_match, entity: string) => {
		switch (entity.toLowerCase()) {
			case "amp":
				return "&"
			case "lt":
				return "<"
			case "gt":
				return ">"
			case "quot":
				return '"'
			case "apos":
				return "'"
			default:
				return String.fromCodePoint(
					entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
				)
		}
	})
}

function attributes(text: string): Map<string, string> {
	const found = new Map<string, string>()

	for (const [, name = "", double, single] of text.matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
		found.set(name, decodeXml(double ?? single ?? ""))
	}

	return found
}

// Elements by local name, namespace prefix or not.
function elements(xml: string, name: string): Map<string, string>[] {
	return [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*)>`, "g"))].map(([, attrs = ""]) => attributes(attrs))
}

// The relationship id attribute (r:id, whatever its prefix).
function relationshipId(attrs: Map<string, string>): string | undefined {
	for (const [name, value] of attrs) {
		if (name.endsWith(":id")) return value
	}

	return undefined
}

function relationships(xml: string | undefined): Relationship[] {
	return xml === undefined
		? []
		: elements(xml, "Relationship").map(attrs => ({
				id: attrs.get("Id") ?? "",
				type: attrs.get("Type") ?? "",
				target: attrs.get("Target") ?? ""
			}))
}

// A relationship target as a part path, as hucre resolves it.
function resolve(base: string, target: string): string {
	if (target.startsWith("/")) {
		return target.slice(1)
	}

	const parts = base.split("/").filter(Boolean)

	for (const part of target.split("/").filter(Boolean)) {
		if (part === "..") parts.pop()
		else if (part !== ".") parts.push(part)
	}

	return parts.join("/")
}

function typeName(type: string): string {
	return type.slice(type.lastIndexOf("/") + 1)
}

function rawEntries(workbook: RoundtripWorkbook): Map<string, Uint8Array> | null {
	for (const symbol of Object.getOwnPropertySymbols(workbook)) {
		if (symbol.description !== "hucre.xlsx.roundtripState") {
			continue
		}

		const state: unknown = Reflect.get(workbook, symbol)

		if (typeof state === "object" && state !== null && "rawEntries" in state && state.rawEntries instanceof Map) {
			return state.rawEntries as Map<string, Uint8Array>
		}
	}

	return null
}

// The package relationships saveXlsx writes again (it writes no others, and no content type for their parts).
const ROOT_TYPES = new Set(["officeDocument", "core-properties", "extended-properties"])

// The workbook relationships saveXlsx writes again (calcChain it drops, which Excel rebuilds). Slicer and
// timeline caches it writes too, but not the workbook's references to them.
const WORKBOOK_TYPES = new Set([
	"worksheet",
	"styles",
	"sharedStrings",
	"theme",
	"sheetMetadata",
	"vbaProject",
	"featurePropertyBag",
	"person",
	"externalLink",
	"cellimage",
	"pivotCacheDefinition",
	"calcChain"
])

// Sheet relationships to parts saveXlsx keeps rather than writes.
const PRESERVED_SHEET_TYPES = new Set(["drawing", "pivotTable", "slicer", "timeline", "threadedComment"])

// A drawing that holds a chart, as saveXlsx tells (a c:chart element).
function hasChart(bytes: Uint8Array | undefined): boolean {
	return bytes !== undefined && /:chart[\s>/]/.test(decoder.decode(bytes))
}

function numbered(path: string, pattern: RegExp): number | null {
	const match = pattern.exec(path)

	return match === null ? null : Number(match[1])
}

export function xlsxWritable(workbook: RoundtripWorkbook): boolean {
	const raw = rawEntries(workbook)

	if (raw === null) {
		return false
	}

	// Part names compare case-insensitively.
	const entries = new Map<string, Uint8Array>()

	for (const [path, bytes] of raw) {
		entries.set(path.toLowerCase(), bytes)
	}

	const text = (path: string): string | undefined => {
		const bytes = entries.get(path.toLowerCase())

		return bytes === undefined ? undefined : decoder.decode(bytes)
	}

	const rootRels = relationships(text("_rels/.rels"))
	const office = rootRels.find(rel => typeName(rel.type) === "officeDocument")

	if (
		office === undefined ||
		resolve("", office.target).toLowerCase() !== "xl/workbook.xml" ||
		rootRels.some(rel => !ROOT_TYPES.has(typeName(rel.type)))
	) {
		return false
	}

	const workbookXml = text("xl/workbook.xml")
	const workbookRels = relationships(text("xl/_rels/workbook.xml.rels"))

	if (workbookXml === undefined || workbookRels.some(rel => !WORKBOOK_TYPES.has(typeName(rel.type)))) {
		return false
	}

	const byId = new Map(workbookRels.map(rel => [rel.id, rel]))
	const theme = workbookRels.find(rel => typeName(rel.type) === "theme")

	// saveXlsx always points the workbook at theme/theme1.xml.
	if (theme === undefined || resolve("xl", theme.target).toLowerCase() !== "xl/theme/theme1.xml" || !entries.has("xl/theme/theme1.xml")) {
		return false
	}

	const sheets = elements(workbookXml, "sheet")

	if (sheets.length !== workbook.sheets.length || workbook.sheets.some(sheet => !isWorksheet(sheet))) {
		return false
	}

	const paths: string[] = []

	for (const attrs of sheets) {
		const id = relationshipId(attrs)
		const rel = id === undefined ? undefined : byId.get(id)

		if (rel === undefined || typeName(rel.type) !== "worksheet") {
			return false
		}

		paths.push(resolve("xl", rel.target).toLowerCase())
	}

	const positional = paths.every((path, index) => path === `xl/worksheets/sheet${String(index + 1)}.xml`)
	const sheetRels = paths.map(path => {
		const slash = path.lastIndexOf("/")

		return relationships(text(`${path.slice(0, slash)}/_rels/${path.slice(slash + 1)}.rels`))
	})
	const preserved =
		[...entries.keys()].some(path => path.startsWith("xl/threadedcomments/")) ||
		[...entries.keys()].some(
			path =>
				/^xl\/worksheets\/_rels\/[^/]+\.rels$/.test(path) &&
				relationships(text(path)).some(rel => PRESERVED_SHEET_TYPES.has(typeName(rel.type)))
		)

	if (preserved && !positional) {
		return false
	}

	for (const [index, rels] of sheetRels.entries()) {
		const sheet = workbook.sheets[index]
		const path = paths[index] ?? ""
		const base = path.slice(0, path.lastIndexOf("/"))

		// Threaded comments come back as threadedComment{n}.xml of the n-th sheet only.
		for (const rel of rels) {
			if (
				typeName(rel.type) === "threadedComment" &&
				resolve(base, rel.target).toLowerCase() !== `xl/threadedcomments/threadedcomment${String(index + 1)}.xml`
			) {
				return false
			}
		}

		// A sheet with pictures gets its drawing written anew as drawing{n}.xml: charts in its own drawing
		// would be rewritten from the model, and another sheet's chart drawing of that number dropped.
		if (sheet !== undefined && ((sheet.images?.length ?? 0) > 0 || (sheet.textBoxes?.length ?? 0) > 0)) {
			const own = rels.filter(rel => typeName(rel.type) === "drawing").map(rel => resolve(base, rel.target).toLowerCase())

			if (hasChart(entries.get(`xl/drawings/drawing${String(index + 1)}.xml`)) || own.some(path => hasChart(entries.get(path)))) {
				return false
			}
		}
	}

	for (const path of entries.keys()) {
		const comment = numbered(path, /^xl\/threadedcomments\/threadedcomment(\d+)\.xml$/)

		if (comment !== null && !sheetRels[comment - 1]?.some(rel => typeName(rel.type) === "threadedComment")) {
			return false
		}

		// Slicers and timelines lose the workbook's reference to their caches.
		if (/^xl\/(slicers|slicercaches|timelines|timelinecaches)\//.test(path)) {
			return false
		}
	}

	// Pivot caches are renumbered 0, 1, … in the order of their part numbers, and external links are
	// listed in part-number order, which formulas count ([1], [2]): the file must already have both so.
	const ordered = (element: string, pattern: RegExp, idAttribute?: string): boolean => {
		const numbers = elements(workbookXml, element).map(attrs => {
			const id = relationshipId(attrs)
			const rel = id === undefined ? undefined : byId.get(id)
			const number = rel === undefined ? null : numbered(resolve("xl", rel.target).toLowerCase(), pattern)

			return { number, id: idAttribute === undefined ? undefined : attrs.get(idAttribute) }
		})

		return numbers.every(
			(entry, index) =>
				entry.number !== null &&
				(index === 0 || entry.number > (numbers[index - 1]?.number ?? Infinity)) &&
				(entry.id === undefined || entry.id === String(index))
		)
	}

	return (
		ordered("pivotCache", /^xl\/pivotcache\/pivotcachedefinition(\d+)\.xml$/, "cacheId") &&
		ordered("externalReference", /^xl\/externallinks\/externallink(\d+)\.xml$/)
	)
}
