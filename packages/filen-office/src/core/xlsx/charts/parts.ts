import { partKey } from "../../opc/partNames"
import type { Relationship } from "../../opc/relationships"
import type { XlsxDocument } from "../edit/document"
import type { XlsxWorkbookModel } from "../model/types"
import { liveRelationships } from "../refs/state"
import { relationshipKind } from "../comments/parts"
import type { DrawingWrites } from "../drawings/writes"

// Chart parts (ECMA-376 Part 1 §21.2, §14.2.1) and the parts only a chart has: its style and colours (Office 2013,
// [MS-ODRAWXML] §2.1.48, §2.1.30) and the drawing of shapes drawn over it (§14.2.3).

export const CHART_TYPE = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
export const CHART_STYLE_TYPE = "application/vnd.ms-office.chartstyle+xml"
export const CHART_COLORS_TYPE = "application/vnd.ms-office.chartcolorstyle+xml"
export const CHART_SHAPES_TYPE = "application/vnd.openxmlformats-officedocument.drawingml.chartshapes+xml"
export const CHART_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/chart"
export const CHART_STRICT_NAMESPACE = "http://purl.oclc.org/ooxml/drawingml/chart"
// The chart's relationship from a drawing (Transitional or Strict, by its last segment).
export function chartRelationship(workbook: XlsxWorkbookModel): string {
	return `${workbook.strict ? "http://purl.oclc.org/ooxml/officeDocument/relationships" : "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}/chart`
}

// The relationships of a part as they now are; none for a part whose relationships do not read.
export async function partRelationships(workbook: XlsxWorkbookModel, part: string): Promise<Relationship[]> {
	let read: readonly Relationship[] = []

	try {
		if (workbook.parts.get(part) !== undefined) read = (await workbook.parts.relationships(part)).all
	} catch {
		read = []
	}

	return liveRelationships(workbook, part, read)
}

// The parts a chart's own relationships name that belong to it alone: its style, its colours and the drawing of its
// user shapes. Pictures and other media may be shared, and stay.
const OWN_KINDS: ReadonlyMap<string, string> = new Map([
	["chartStyle", CHART_STYLE_TYPE],
	["chartColorStyle", CHART_COLORS_TYPE],
	["chartUserShapes", CHART_SHAPES_TYPE]
])

// Removes a chart's part and the parts only it has, through the drawing feature's edit (the frame and the drawing's
// relationship to the chart are the drawing feature's to remove). A part the workbook does not hold is skipped.
export async function deleteChartParts(document: XlsxDocument, writes: DrawingWrites, chartPart: string): Promise<void> {
	const workbook = document.workbook
	const relationships = await partRelationships(workbook, chartPart)
	const removed = new Set<string>()

	for (const relationship of relationships) {
		const name = relationship.partName

		const type = OWN_KINDS.get(relationshipKind(relationship.type))

		if (relationship.external || name === undefined || type === undefined || removed.has(partKey(name))) continue

		removed.add(partKey(name))
		writes.removePart(name, workbook.parts.get(name)?.contentType ?? type)
	}

	writes.removePart(chartPart, workbook.parts.get(chartPart)?.contentType ?? CHART_TYPE)
}
