import { classifyLink } from "@filen/shared/linkPolicy"
import { SHEET_MAX_CELL_TEXT, type SheetId, type SheetRange, type SheetRefusal } from "../../sheet/protocol"
import type { SheetChangeSink, SheetEditStep, SheetHandled } from "../../sheet/registry"
import { decodeUtf8 } from "../../xml/index"
import { AnnotationWrites, hyperlinkRelationship } from "../comments/parts"
import { setCells } from "../edit/cells"
import type { XlsxDocument } from "../edit/document"
import { applyFormat } from "../edit/format"
import { RefRefused } from "../refs/catalogue"
import { refState } from "../refs/state"
import { inGrid } from "../refs/sqref"
import type { XlsxSheetModel, XlsxWorkbookModel } from "../model/types"
import { namespacesOf } from "../write/namespaces"
import { cutLinks, editLinks, readLinks, subtract, type LinksSection } from "./links"
import { resolvePlace } from "./location"

// Hyperlinks inserted, edited and removed (Ctrl+K): the sheet's hyperlinks section with an external target's
// relationship (TargetMode External), the text the cell shows, and the look Excel gives a link (the theme's hyperlink
// colour, underlined) or takes away with it. Limits from Excel's "Excel specifications and limits"
// (support.microsoft.com): 65,530 hyperlinks in a worksheet; a ScreenTip of 255 characters.

export const MAX_SHEET_LINKS = 65_530
export const MAX_TOOLTIP = 255
// The theme's hyperlink colour (§20.1.6.2 clrScheme: dk1, lt1, dk2, lt2, accent1-6, hlink).
const HYPERLINK_THEME_COLOR = 10

const sources = new WeakMap<XlsxSheetModel, string[]>()

// A sheet's links as edits left them; null when another edit holds the section (nothing known about them).
export function linksOf(workbook: XlsxWorkbookModel, model: XlsxSheetModel): LinksSection | null | undefined {
	const marked = workbook.changes.sheets.get(model.id)?.sections.has("hyperlinks") === true

	if (!marked) {
		let occurrences = sources.get(model)

		if (occurrences === undefined) {
			occurrences = model.sections
				.filter(section => section.name === "hyperlinks")
				.map(section => decodeUtf8(section.bytes ?? new Uint8Array(0)))
			sources.set(model, occurrences)
		}

		return readLinks(occurrences)
	}

	try {
		return readLinks(refState(workbook).sectionMarkup(model, "hyperlinks"))
	} catch (error) {
		if (error instanceof RefRefused) return undefined

		throw error
	}
}

export type LinkTarget = { readonly url: string } | { readonly location: string }

function combine(steps: readonly SheetEditStep[]): SheetEditStep {
	return {
		bytes: steps.reduce((sum, step) => sum + step.bytes, 0),
		undo: async changes => {
			for (let k = steps.length - 1; k >= 0; k--) await steps[k]?.undo(changes)
		},
		redo: async changes => {
			for (const step of steps) await step.redo(changes)
		}
	}
}

interface Prepared {
	readonly model: XlsxSheetModel
	readonly part: string
	readonly section: LinksSection | null
}

async function prepare(
	document: XlsxDocument,
	sheet: SheetId,
	ranges: readonly SheetRange[]
): Promise<Prepared | { refused: SheetRefusal }> {
	const entry = document.entry(sheet)

	if (entry === undefined || entry.kind !== "worksheet") return { refused: { reason: "unsupported", detail: "sheet" } }
	if (ranges.length === 0 || !ranges.every(inGrid)) return { refused: { reason: "tooLarge" } }

	const model = await document.ready(sheet)

	await document.workbook.parts.relationships(entry.part)

	const section = linksOf(document.workbook, model)

	if (section === undefined) return { refused: { reason: "structureLocked", detail: "hyperlinks" } }

	return { model, part: entry.part, section }
}

// A step another edit gives, kept; its refusal returned.
async function addSteps(steps: SheetEditStep[], handled: SheetHandled | Promise<SheetHandled>): Promise<SheetRefusal | null> {
	const result = await handled

	if (result === null) return null
	if ("refused" in result) return result.refused

	steps.push(result)

	return null
}

async function rollback(steps: readonly SheetEditStep[], changes: SheetChangeSink): Promise<void> {
	for (let k = steps.length - 1; k >= 0; k--) await steps[k]?.undo(changes)
}

// A link put on every cell of `ranges` (replacing the links there). `text`: what the first cell of each range shows
// (Excel's "Text to display"), written when given.
export async function setLinks(
	document: XlsxDocument,
	sheet: SheetId,
	ranges: readonly SheetRange[],
	target: LinkTarget,
	tooltip: string | undefined,
	text: string | undefined,
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const prepared = await prepare(document, sheet, ranges)

	if ("refused" in prepared) return prepared

	const workbook = document.workbook
	let url: string | null = null
	let location: string | null = null

	if ("url" in target) {
		const verdict = classifyLink(target.url)

		if (verdict.kind !== "external" || verdict.url.length > SHEET_MAX_CELL_TEXT) return { refused: { reason: "linkTarget" } }

		url = verdict.url
	} else {
		if (resolvePlace(workbook, sheet, target.location) === null) return { refused: { reason: "linkTarget" } }

		location = target.location.trim().replace(/^#/, "")
	}

	if (tooltip !== undefined && tooltip.length > MAX_TOOLTIP) return { refused: { reason: "tooLarge", detail: "tooltip" } }
	if (text !== undefined && text.length > SHEET_MAX_CELL_TEXT) return { refused: { reason: "tooLarge" } }

	// Counted after the edit: a link the ranges cut through stays as up to four pieces.
	const cut = cutLinks(prepared.section, ranges)

	if (cut.kept.length + ranges.length > MAX_SHEET_LINKS) return { refused: { reason: "tooLarge", detail: "hyperlinks" } }

	const writes = new AnnotationWrites(workbook)
	const relationship =
		url === null ? null : writes.addRelationship(prepared.part, { type: hyperlinkRelationship(workbook), target: url, external: true })
	const edited = editLinks(
		prepared.section,
		ranges,
		ranges.map(range => ({
			range,
			relationshipId: relationship?.id ?? null,
			location,
			tooltip: tooltip === undefined || tooltip === "" ? null : tooltip,
			display: text === undefined || text === "" ? null : text
		})),
		namespacesOf(workbook.strict).relationships,
		elementPrefix(prepared.model),
		cut
	)

	for (const id of edited.released) writes.removeRelationship(prepared.part, id)

	writes.setSection(prepared.model, "hyperlinks", edited.occurrences)

	const tell = lookAt(sheet, ranges)
	const steps: SheetEditStep[] = [writes.step(tell)]

	tell(changes)

	let refusal: SheetRefusal | null = null

	if (text !== undefined && text !== "") {
		const rows = Uint32Array.from(ranges, range => range.startRow)
		const cols = Uint16Array.from(ranges, range => range.startCol)
		const input = /^[=+\-@']/.test(text) ? `'${text}` : text

		refusal = await addSteps(steps, setCells(document, sheet, { rows, cols, inputs: ranges.map(() => input) }, changes))
	}

	if (refusal === null && document.protects(sheet, "formatCells") === null)
		refusal = await addSteps(
			steps,
			applyFormat(document, sheet, ranges, { underline: "single", color: { theme: HYPERLINK_THEME_COLOR } }, changes)
		)

	if (refusal !== null) {
		await rollback(steps, changes)

		return { refused: refusal }
	}

	return steps.length === 1 ? (steps[0] ?? null) : combine(steps)
}

// The links over `ranges` removed, and the look a link has taken off where they were.
export async function removeLinks(
	document: XlsxDocument,
	sheet: SheetId,
	ranges: readonly SheetRange[],
	changes: SheetChangeSink
): Promise<SheetHandled> {
	const prepared = await prepare(document, sheet, ranges)

	if ("refused" in prepared) return prepared

	const cleared: SheetRange[] = []

	for (const link of prepared.section?.links ?? [])
		for (const range of ranges) {
			if (link.range.startRow < 0 || subtract(link.range, range)[0] === link.range) continue

			cleared.push({
				startRow: Math.max(link.range.startRow, range.startRow),
				startCol: Math.max(link.range.startCol, range.startCol),
				endRow: Math.min(link.range.endRow, range.endRow),
				endCol: Math.min(link.range.endCol, range.endCol)
			})
		}

	if (cleared.length === 0) return null

	const workbook = document.workbook
	const writes = new AnnotationWrites(workbook)
	const edited = editLinks(prepared.section, ranges, [], namespacesOf(workbook.strict).relationships, elementPrefix(prepared.model))

	for (const id of edited.released) writes.removeRelationship(prepared.part, id)

	writes.setSection(prepared.model, "hyperlinks", edited.occurrences)

	const tell = lookAt(sheet, cleared)
	const steps: SheetEditStep[] = [writes.step(tell)]

	tell(changes)

	if (document.protects(sheet, "formatCells") === null) {
		const refusal = await addSteps(steps, applyFormat(document, sheet, cleared, { underline: null, color: null }, changes))

		if (refusal !== null) {
			await rollback(steps, changes)

			return { refused: refusal }
		}
	}

	return steps.length === 1 ? (steps[0] ?? null) : combine(steps)
}

// The sheet's prefix as element names take it: "x:", or "" for the default namespace.
function elementPrefix(model: XlsxSheetModel): string {
	return model.prefix === "" ? "" : `${model.prefix}:`
}

function lookAt(sheet: SheetId, ranges: readonly SheetRange[]): (changes: SheetChangeSink) => void {
	return changes => {
		for (const range of ranges) changes.look(sheet, range)
	}
}
