import type { RoundtripWorkbook } from "hucre/xlsx"
import { decodeXml, dirname, relationshipTypeName, relsPath, resolvePart } from "@/features/spreadsheet/lib/opcPaths"
import { isWorksheet } from "@/features/spreadsheet/lib/xlsxView"

// Whether saveXlsx can write this workbook back without breaking it. It rewrites the workbook and every
// worksheet from the model but keeps the parts it does not model (charts' drawings, pivot tables, threaded
// comments) as the file had them, and re-attaches those to sheets by POSITION: the n-th sheet gets
// xl/worksheets/sheet{n}.xml's relationships and threadedComment{n}.xml. It writes a chart sheet as an
// empty worksheet, and only the relationships it knows. So every relationship must be of a kind it writes
// back whole (a whitelist, with drawings and VML checked for what they hold), or the workbook opens
// view-only. When in doubt, it does.

interface Relationship {
	id: string
	type: string
	target: string
}

const decoder = new TextDecoder()

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

export function rawEntries(workbook: RoundtripWorkbook): Map<string, Uint8Array> | null {
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

// The package relationships saveXlsx writes again. A thumbnail it would orphan is dropped (a preview
// picture, nothing of the workbook), and so are custom properties while they hold none (as LibreOffice
// writes them); saveXlsx cannot write back ones that hold something.
const ROOT_TYPES = new Set(["officeDocument", "core-properties", "extended-properties", "thumbnail", "custom-properties"])

// The workbook relationships saveXlsx writes again (calcChain it drops, which Excel rebuilds).
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

// The sheet relationships saveXlsx writes again or keeps: drawings and legacy VML only as checked below,
// printer settings dropped (saveXlsx no longer points at them).
const SHEET_TYPES = new Set([
	"hyperlink",
	"drawing",
	"vmlDrawing",
	"comments",
	"table",
	"image",
	"threadedComment",
	"pivotTable",
	"printerSettings"
])

// Sheet relationships to parts saveXlsx keeps rather than writes.
const PRESERVED_SHEET_TYPES = new Set(["drawing", "pivotTable", "threadedComment"])

// A drawing that holds a chart, as saveXlsx tells (a c:chart element).
function hasChart(xml: string | undefined): boolean {
	return xml !== undefined && /:chart[\s>/]/.test(xml)
}

function count(xml: string, pattern: RegExp): number {
	return xml.match(pattern)?.length ?? 0
}

// A drawing without charts is written anew from the sheet's pictures: it must hold nothing else (shapes,
// connectors, groups, text boxes, which it would lose), and no picture detail it would lose (a crop, a
// rotation, a link).
function picturesOnly(xml: string, pictures: number): boolean {
	const anchors = count(xml, /<(?:[\w.-]+:)?(?:twoCellAnchor|oneCellAnchor|absoluteAnchor)\b/g)

	return (
		anchors === pictures &&
		count(xml, /<(?:[\w.-]+:)?pic\b/g) === pictures &&
		!/<(?:[\w.-]+:)?(?:sp|cxnSp|grpSp|graphicFrame|contentPart|AlternateContent)\b/.test(xml) &&
		!/<(?:[\w.-]+:)?srcRect\s+[a-z]/i.test(xml) &&
		!/\brot="-?[1-9]/.test(xml) &&
		!/hlinkClick|hlinkHover/.test(xml)
	)
}

function numbered(path: string, pattern: RegExp): number | null {
	const match = pattern.exec(path)

	return match === null ? null : Number(match[1])
}

// What saving needs to know: whether the workbook can be written back intact, the parts to drop from what
// saveXlsx copies (it would leave them orphaned), and whether the workbook lacks the theme saveXlsx always
// points it at.
export interface SavePlan {
	writable: boolean
	drop: string[]
	addTheme: boolean
	// The worksheet parts, in the workbook's order.
	sheets: string[]
}

const VIEW_ONLY: SavePlan = { writable: false, drop: [], addTheme: false, sheets: [] }

export function xlsxSavePlan(workbook: RoundtripWorkbook): SavePlan {
	const raw = rawEntries(workbook)

	if (raw === null) {
		return VIEW_ONLY
	}

	// Part names compare case-insensitively; `paths` gives back each one as stored.
	const entries = new Map<string, Uint8Array>()
	const stored = new Map<string, string>()

	for (const [path, bytes] of raw) {
		entries.set(path.toLowerCase(), bytes)
		stored.set(path.toLowerCase(), path)
	}

	const text = (path: string): string | undefined => {
		const bytes = entries.get(path.toLowerCase())

		return bytes === undefined ? undefined : decoder.decode(bytes)
	}

	const drop: string[] = []
	const dropPart = (path: string) => {
		const original = stored.get(path.toLowerCase())

		if (original !== undefined) drop.push(original)
	}

	const rootRels = relationships(text("_rels/.rels"))
	const office = rootRels.find(rel => relationshipTypeName(rel.type) === "officeDocument")

	if (
		office === undefined ||
		resolvePart("", office.target) !== "xl/workbook.xml" ||
		rootRels.some(rel => !ROOT_TYPES.has(relationshipTypeName(rel.type)))
	) {
		return VIEW_ONLY
	}

	for (const rel of rootRels) {
		const type = relationshipTypeName(rel.type)
		const path = resolvePart("", rel.target)

		if (type === "custom-properties" && /<(?:[\w.-]+:)?property\b/.test(text(path) ?? "")) {
			return VIEW_ONLY
		}

		if (type === "custom-properties" || type === "thumbnail") {
			dropPart(path)
		}
	}

	const workbookXml = text("xl/workbook.xml")
	const workbookRels = relationships(text("xl/_rels/workbook.xml.rels"))

	if (workbookXml === undefined || workbookRels.some(rel => !WORKBOOK_TYPES.has(relationshipTypeName(rel.type)))) {
		return VIEW_ONLY
	}

	// saveXlsx drops calcPr: iterative calculation (and a workbook set to calculate by hand) would be lost.
	const calc = elements(workbookXml, "calcPr")[0]
	const iterate = calc?.get("iterate")

	if (iterate === "1" || iterate === "true" || calc?.get("calcMode") === "manual") {
		return VIEW_ONLY
	}

	const byId = new Map(workbookRels.map(rel => [rel.id, rel]))
	const theme = workbookRels.find(rel => relationshipTypeName(rel.type) === "theme")

	// saveXlsx always points the workbook at theme/theme1.xml; one without a theme (LibreOffice writes
	// none) gets a default one added.
	if (theme !== undefined && (resolvePart("xl", theme.target) !== "xl/theme/theme1.xml" || !entries.has("xl/theme/theme1.xml"))) {
		return VIEW_ONLY
	}

	const sheets = elements(workbookXml, "sheet")

	if (sheets.length !== workbook.sheets.length || workbook.sheets.some(sheet => !isWorksheet(sheet))) {
		return VIEW_ONLY
	}

	const paths: string[] = []

	for (const attrs of sheets) {
		const id = relationshipId(attrs)
		const rel = id === undefined ? undefined : byId.get(id)

		if (rel === undefined || relationshipTypeName(rel.type) !== "worksheet") {
			return VIEW_ONLY
		}

		paths.push(resolvePart("xl", rel.target))
	}

	const positional = paths.every((path, index) => path === `xl/worksheets/sheet${String(index + 1)}.xml`)
	const sheetRels = paths.map(path => relationships(text(relsPath(path))))
	const preserved =
		[...entries.keys()].some(path => path.startsWith("xl/threadedcomments/")) ||
		sheetRels.some(rels => rels.some(rel => PRESERVED_SHEET_TYPES.has(relationshipTypeName(rel.type))))

	if (preserved && !positional) {
		return VIEW_ONLY
	}

	for (const [index, rels] of sheetRels.entries()) {
		const sheet = workbook.sheets[index]
		const path = paths[index] ?? ""
		const base = dirname(path)
		const pictures = sheet?.images?.length ?? 0

		if ((sheet?.textBoxes?.length ?? 0) > 0) {
			return VIEW_ONLY
		}

		for (const rel of rels) {
			const type = relationshipTypeName(rel.type)
			const target = resolvePart(base, rel.target)

			if (!SHEET_TYPES.has(type)) {
				return VIEW_ONLY
			}

			switch (type) {
				// Written anew from the model: the file's own parts go, whatever they were named.
				case "printerSettings":
				case "comments":
					dropPart(target)
					break
				// Threaded comments come back as threadedComment{n}.xml of the n-th sheet only.
				case "threadedComment":
					if (target !== `xl/threadedcomments/threadedcomment${String(index + 1)}.xml`) return VIEW_ONLY
					break
				// Legacy VML is written anew from the cell notes: it may hold nothing but notes (no form
				// controls, no header or footer pictures).
				case "vmlDrawing": {
					const vml = text(target) ?? ""

					if (count(vml, /<(?:[\w.-]+:)?shape\b/g) !== count(vml, /ObjectType\s*=\s*["']Note["']/g)) return VIEW_ONLY
					dropPart(target)
					break
				}
				case "drawing": {
					const drawing = text(target)

					if (drawing === undefined) return VIEW_ONLY

					if (hasChart(drawing)) {
						// Kept as it is, with its charts: nothing either points at may be one of the parts
						// saveXlsx writes anew (pictures, drawings).
						if (pictures > 0) return VIEW_ONLY

						for (const drawingRel of relationships(text(relsPath(target)))) {
							const part = resolvePart(dirname(target), drawingRel.target)

							if (relationshipTypeName(drawingRel.type) !== "chart") return VIEW_ONLY

							for (const chartRel of relationships(text(relsPath(part)))) {
								if (/^xl\/(media|drawings)\//.test(resolvePart(dirname(part), chartRel.target))) return VIEW_ONLY
							}
						}
					} else if (!picturesOnly(drawing, pictures)) {
						return VIEW_ONLY
					}

					break
				}
			}
		}

		// A sheet with pictures gets its drawing written anew as drawing{n}.xml: another sheet's chart
		// drawing of that number would be dropped.
		if (pictures > 0 && hasChart(text(`xl/drawings/drawing${String(index + 1)}.xml`))) {
			return VIEW_ONLY
		}
	}

	for (const path of entries.keys()) {
		const comment = numbered(path, /^xl\/threadedcomments\/threadedcomment(\d+)\.xml$/)

		if (comment !== null && !sheetRels[comment - 1]?.some(rel => relationshipTypeName(rel.type) === "threadedComment")) {
			return VIEW_ONLY
		}

		// Slicers and timelines lose the workbook's reference to their caches.
		if (/^xl\/(slicers|slicercaches|timelines|timelinecaches)\//.test(path)) {
			return VIEW_ONLY
		}
	}

	// Pivot caches are renumbered 0, 1, … in the order of their part numbers, and external links are
	// listed in part-number order, which formulas count ([1], [2]): the file must already have both so.
	const ordered = (element: string, pattern: RegExp, idAttribute?: string): boolean => {
		const numbers = elements(workbookXml, element).map(attrs => {
			const id = relationshipId(attrs)
			const rel = id === undefined ? undefined : byId.get(id)
			const number = rel === undefined ? null : numbered(resolvePart("xl", rel.target), pattern)

			return { number, id: idAttribute === undefined ? undefined : attrs.get(idAttribute) }
		})

		return numbers.every(
			(entry, index) =>
				entry.number !== null &&
				(index === 0 || entry.number > (numbers[index - 1]?.number ?? Infinity)) &&
				(entry.id === undefined || entry.id === String(index))
		)
	}

	if (
		!ordered("pivotCache", /^xl\/pivotcache\/pivotcachedefinition(\d+)\.xml$/, "cacheId") ||
		!ordered("externalReference", /^xl\/externallinks\/externallink(\d+)\.xml$/)
	) {
		return VIEW_ONLY
	}

	return { writable: true, drop, addTheme: theme === undefined, sheets: paths.map(path => stored.get(path) ?? path) }
}
