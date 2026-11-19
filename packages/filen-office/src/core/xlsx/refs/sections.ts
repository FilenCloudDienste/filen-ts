import { cellName } from "../../sheet/refs/cellRef"
import { decodeUtf8, encodeUtf8 } from "../../xml/index"
import { axisLimit, inBand, shiftAxisSpan, shiftIndex, straddles } from "./axis"
import { shiftSplit, shiftViewStart, viewIndex } from "./views"
import { refuse } from "./catalogue"
import { shiftAnchor } from "./anchors"
import {
	childByLocal,
	childElements,
	descendants,
	editMarkup,
	shiftCellAttribute,
	shiftFormulaAttribute,
	shiftFormulaText,
	shiftRefAttribute,
	shiftSqrefAttribute,
	shiftSqrefText,
	shiftedIndex,
	type Edited,
	type RangeAnchor,
	type RefJob
} from "./markup"
import { parseRef } from "./sqref"

// The worksheet's own sections (children of <worksheet>, ECMA-376 Part 1 §18.3.1.99) that refer to cells, each
// rewritten as a splice of its source markup. sheetData, cols, mergeCells, sheetViews and the dimension are moved
// through the model; the sections below have no model and are moved here.

// Sections that hold no reference to cells, rows, columns or sheets.
export const PLAIN_SECTIONS: ReadonlySet<string> = new Set([
	"sheetPr",
	"sheetFormatPr",
	"sheetCalcPr",
	"sheetProtection",
	"phoneticPr",
	"printOptions",
	"pageMargins",
	"pageSetup",
	"headerFooter",
	"customProperties",
	"drawing",
	"legacyDrawing",
	"legacyDrawingHF",
	"drawingHF",
	"picture",
	"tableParts"
])

// Sections moved through the model (or the writer's own serialisation).
export const MODEL_SECTIONS: ReadonlySet<string> = new Set(["sheetData", "dimension", "sheetViews", "cols", "mergeCells"])

// Worksheet extensions (MS-XLSX §2.2.4 / the ext uri of each CT_Extension) and how they are moved.
const EXT_CONDITIONAL_FORMATTINGS = "{78C0D931-6437-407d-A8EE-F0AAD7539E65}"
const EXT_DATA_VALIDATIONS = "{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}"
const EXT_SPARKLINE_GROUPS = "{05C60535-1F16-4fd2-B633-F4F36F0B64E0}"
// slicerList (x14, x15), timelineRefs and the Mac page layout view hold relationship ids only.
const PLAIN_EXTENSIONS: ReadonlySet<string> = new Set([
	"{A8765BA9-456A-4DAB-B4F3-ACF838C121DE}",
	"{3A4CF648-6AED-40F4-86FF-DC5316D8AED3}",
	"{7E03D99C-DC04-49D9-9315-930204A7B6E9}",
	"{64002731-A6B0-56B0-2670-7721B7C09600}",
	"HTTP://SCHEMAS.MICROSOFT.COM/OFFICE/MAC/EXCEL/2008/MAIN"
])

export function sectionKnown(name: string): boolean {
	return PLAIN_SECTIONS.has(name) || MODEL_SECTIONS.has(name) || REWRITERS.has(name)
}

type Rewriter = (edited: Edited, root: number, job: RefJob) => boolean

// Rewrites one occurrence of a section: the new markup, "" when it goes, the same string when nothing changed.
export function rewriteSection(name: string, markup: string, job: RefJob): string {
	// Positions on another sheet do not move here: only formulas that name the edited sheet can change.
	if (
		job.shift === null &&
		!job.formulas.markupMayChange(markup, job.own) &&
		!(name === "dataConsolidate" && job.formulas.namesTarget(markup))
	)
		return markup

	const rewrite = REWRITERS.get(name)

	if (rewrite === undefined) refuse("structureLocked", `section ${name}`)

	const edited = editMarkup(encodeUtf8(markup), `section ${name}`)
	const keep = rewrite(edited, edited.document.documentElement(), job)

	if (!keep) return ""

	return edited.editor.changed ? decodeUtf8(edited.editor.serialize()) : markup
}

// Drops the children `drop` says go; false when none is left (and `required` says the parent needs one).
function filterChildren(edited: Edited, parent: number, local: string, drop: (node: number) => boolean): { left: number; dropped: number } {
	let left = 0
	let dropped = 0

	for (const child of childElements(edited.document, parent)) {
		if (edited.document.localName(child) !== local) continue

		if (drop(child)) {
			edited.editor.remove(child)
			dropped++
		} else {
			left++
		}
	}

	return { left, dropped }
}

function setCount(edited: Edited, node: number, name: string, value: number): void {
	const current = edited.document.attribute(node, name)

	if (current !== undefined && Number(current) !== value) edited.editor.setAttribute(node, name, String(value))
}

// --- Range lists ---

function protectedRanges(edited: Edited, root: number, job: RefJob): boolean {
	const { left } = filterChildren(edited, root, "protectedRange", node => {
		const moved = shiftSqrefAttribute(edited, node, "sqref", job, "protectedRanges")

		return moved !== null && moved.ranges.length === 0
	})

	return left > 0
}

function ignoredErrors(edited: Edited, root: number, job: RefJob): boolean {
	const { left } = filterChildren(edited, root, "ignoredError", node => {
		const moved = shiftSqrefAttribute(edited, node, "sqref", job, "ignoredErrors")

		return moved !== null && moved.ranges.length === 0
	})

	return left > 0
}

function scenarios(edited: Edited, root: number, job: RefJob): boolean {
	const { document } = edited

	shiftSqrefAttribute(edited, root, "sqref", job, "scenarios")

	for (const scenario of childElements(document, root)) {
		for (const input of childElements(document, scenario)) {
			if (document.localName(input) !== "inputCells") continue
			if (!shiftCellAttribute(edited, input, "r", job, "scenarios")) refuse("structureLocked", "scenarios: changing cell deleted")
		}
	}

	return true
}

function cellList(construct: "cellWatches" | "smartTags", local: string): Rewriter {
	return (edited, root, job) =>
		filterChildren(edited, root, local, node => !shiftCellAttribute(edited, node, "r", job, construct)).left > 0
}

// --- Autofilter and sort state ---

// An autofilter (the sheet's, a custom view's or a table's): ref, filter column ids (relative to the range's first
// column) and its sort state. False when its range was deleted.
export function autoFilter(edited: Edited, node: number, job: RefJob, construct: "autoFilter" | "tables" | "customSheetViews"): boolean {
	const { document, editor } = edited
	const text = document.attribute(node, "ref")
	const range = text === undefined ? null : parseRef(text)

	if (text !== undefined && range === null) refuse("structureLocked", `${construct}: autofilter range "${text}"`)

	// Cells shifted in a band: a filtered range they do not lie across stays, unless they move part of it.
	if (job.shift?.band !== undefined && range !== null && !inBand(range, job.shift)) {
		if (straddles(range, job.shift)) refuse("structureLocked", `${construct}: part of the filtered range`)

		return true
	}

	if (!shiftRefAttribute(edited, node, "ref", job, construct)) return false

	const shift = job.shift

	if (shift !== null && shift.axis === "cols" && range !== null) {
		const start = shiftIndex(range.startCol, shift)
		// A delete from the first column on: the range now starts at `at`.
		const first = start >= 0 ? start : shift.at

		filterChildren(edited, node, "filterColumn", column => {
			const id = Number(document.attribute(column, "colId") ?? "0")
			const moved = shiftIndex(range.startCol + id, shift)

			if (moved < 0) {
				job.touch(construct)

				return true
			}

			if (moved - first !== id) {
				job.touch(construct)
				editor.setAttribute(column, "colId", String(moved - first))
			}

			return false
		})
	}

	const sort = childByLocal(document, node, "sortState")

	if (sort >= 0 && !sortState(edited, sort, job, construct)) editor.remove(sort)

	return true
}

// False when its range was deleted or no condition is left.
export function sortState(
	edited: Edited,
	node: number,
	job: RefJob,
	construct: "sortState" | "autoFilter" | "tables" | "customSheetViews"
): boolean {
	const range = parseRef(edited.document.attribute(node, "ref") ?? "")

	if (job.shift?.band !== undefined && range !== null && straddles(range, job.shift))
		refuse("structureLocked", `${construct}: part of the sorted range`)
	if (!shiftRefAttribute(edited, node, "ref", job, construct)) return false

	const { left, dropped } = filterChildren(
		edited,
		node,
		"sortCondition",
		condition => !shiftRefAttribute(edited, condition, "ref", job, construct)
	)

	return left > 0 || dropped === 0
}

// --- Breaks ---

function breaks(edited: Edited, root: number, job: RefJob, rowBreaks: boolean): boolean {
	const shift = job.shift

	// Cells shifted in a band leave page breaks where they are.
	if (shift === null || shift.band !== undefined) return true

	const { document, editor } = edited
	const own = (rowBreaks ? "rows" : "cols") === shift.axis
	let manual = 0
	const { left, dropped } = filterChildren(edited, root, "brk", node => {
		if (own) {
			const id = shiftedIndex(document.attribute(node, "id"), shift)

			if (id === -1) {
				job.touch("breaks")

				return true
			}

			if (id !== null && String(id) !== document.attribute(node, "id")) {
				job.touch("breaks")
				editor.setAttribute(node, "id", String(id))
			}
		} else {
			const min = Number(document.attribute(node, "min") ?? "0")
			const max = document.attribute(node, "max")

			// A break across the whole sheet (min 0, max the last index) stays so.
			if (max !== undefined && !(min === 0 && Number(max) === axisLimit(shift.axis) - 1)) {
				const span = shiftAxisSpan(min, Number(max), shift)

				if (span !== null && (span[0] !== min || String(span[1]) !== max)) {
					job.touch("breaks")
					if (span[0] !== min) editor.setAttribute(node, "min", String(span[0]))
					if (String(span[1]) !== max) editor.setAttribute(node, "max", String(span[1]))
				}
			}
		}

		if (document.attribute(node, "man") === "1" || document.attribute(node, "man") === "true") manual++

		return false
	})

	if (dropped > 0) {
		setCount(edited, root, "count", left)
		setCount(edited, root, "manualBreakCount", manual)
	}

	return left > 0 || dropped === 0
}

// --- Views ---

// A view's cells (its top-left, the panes' top-left cells, the selections) and frozen splits after the edit (the
// sheet's views and the custom views alike). A view cell that was deleted goes to the first row (column) after the
// deletion, as the selection does; a pane whose frozen rows and columns are all deleted goes.
function selectionAndPane(edited: Edited, view: number, job: RefJob, construct: "sheetView" | "customSheetViews"): void {
	const { document, editor } = edited
	const shift = job.shift

	// Cells shifted in a band leave the views as they are.
	if (shift === null || shift.band !== undefined) return

	const moveCell = (node: number, name: string): string | null => {
		const text = document.attribute(node, name)
		const range = text === undefined ? null : parseRef(text)

		if (text === undefined || range === null) return null

		const rows = shift.axis === "rows"
		const index = viewIndex(rows ? range.startRow : range.startCol, shift)
		const next = rows ? cellName(index, range.startCol) : cellName(range.startRow, index)

		if (next !== text.replaceAll("$", "")) {
			job.touch(construct)
			editor.setAttribute(node, name, next)
		}

		return next
	}

	// The view's first row (column): an index the frozen block counts from, moved as one (shiftViewStart).
	const topLeft = document.attribute(view, "topLeftCell")
	const origin = topLeft === undefined ? null : parseRef(topLeft)
	const first = origin === null ? 0 : shift.axis === "rows" ? origin.startRow : origin.startCol

	if (topLeft !== undefined && origin !== null) {
		const index = shiftViewStart(first, shift)
		const next = shift.axis === "rows" ? cellName(index, origin.startCol) : cellName(origin.startRow, index)

		if (next !== topLeft.replaceAll("$", "")) {
			job.touch(construct)
			editor.setAttribute(view, "topLeftCell", next)
		}
	}

	for (const child of childElements(document, view)) {
		switch (document.localName(child)) {
			case "pane": {
				const state = document.attribute(child, "state")
				let gone = false

				if (state === "frozen" || state === "frozenSplit") {
					const name = shift.axis === "rows" ? "ySplit" : "xSplit"
					const other = shift.axis === "rows" ? "xSplit" : "ySplit"
					const split = Math.floor(Number(document.attribute(child, name) ?? "0"))
					const next = shiftSplit(split, shift, first)

					if (next !== split) {
						job.touch(construct)

						if (next === 0 && Math.floor(Number(document.attribute(child, other) ?? "0")) === 0) {
							editor.remove(child)
							gone = true
						} else {
							editor.setAttribute(child, name, String(next))
						}
					}
				}

				if (!gone) moveCell(child, "topLeftCell")
				break
			}
			case "selection": {
				const active = moveCell(child, "activeCell")
				const moved = shiftSqrefAttribute(edited, child, "sqref", job, construct)

				if (moved !== null && moved.ranges.length === 0) editor.setAttribute(child, "sqref", active ?? "A1")
				break
			}
			case "rowBreaks":
			case "colBreaks":
				if (!breaks(edited, child, job, document.localName(child) === "rowBreaks")) editor.remove(child)
				break
			case "autoFilter":
				if (!autoFilter(edited, child, job, "customSheetViews")) editor.remove(child)
				break
		}
	}
}

// The sheet's views, when the catalogue (not the model) writes them: every view, pane and selection moved.
export function sheetViews(edited: Edited, root: number, job: RefJob): boolean {
	for (const view of childElements(edited.document, root))
		if (edited.document.localName(view) === "sheetView") selectionAndPane(edited, view, job, "sheetView")

	return true
}

function customSheetViews(edited: Edited, root: number, job: RefJob): boolean {
	for (const view of childElements(edited.document, root))
		if (edited.document.localName(view) === "customSheetView") selectionAndPane(edited, view, job, "customSheetViews")

	return true
}

// --- Conditional formats and validations ---

function conditionalFormatting(edited: Edited, root: number, job: RefJob): boolean {
	const moved = shiftSqrefAttribute(edited, root, "sqref", job, "conditionalFormatting")

	if (moved !== null && moved.ranges.length === 0) return false

	const anchor = moved?.anchor ?? null

	for (const rule of childElements(edited.document, root)) {
		if (edited.document.localName(rule) !== "cfRule") continue

		for (const node of descendants(edited.document, rule)) {
			const local = edited.document.localName(node)

			if (local === "formula") shiftFormulaText(edited, node, job, "conditionalFormatting", anchor)
			else if (local === "cfvo") shiftFormulaAttribute(edited, node, "val", job, "conditionalFormatting", anchor)
		}
	}

	return true
}

function dataValidations(edited: Edited, root: number, job: RefJob): boolean {
	const { document } = edited
	const { left, dropped } = filterChildren(edited, root, "dataValidation", node => {
		const moved = shiftSqrefAttribute(edited, node, "sqref", job, "dataValidations", "cells")

		if (moved !== null && moved.ranges.length === 0) return true

		for (const child of childElements(document, node)) {
			const local = document.localName(child)

			if (local === "formula1" || local === "formula2") shiftFormulaText(edited, child, job, "dataValidations", moved?.anchor ?? null)
		}

		return false
	})

	if (dropped > 0) setCount(edited, root, "count", left)

	return left > 0 || dropped === 0
}

// --- Hyperlinks ---

function hyperlinks(edited: Edited, root: number, job: RefJob): boolean {
	const { left, dropped } = filterChildren(edited, root, "hyperlink", node => {
		const range = parseRef(edited.document.attribute(node, "ref") ?? "")

		// A hyperlink belongs to its cells: one only partly shifted in a band cannot follow them.
		if (job.shift?.band !== undefined && range !== null && straddles(range, job.shift)) refuse("structureLocked", "hyperlinks")
		if (!shiftRefAttribute(edited, node, "ref", job, "hyperlinks")) return true

		shiftFormulaAttribute(edited, node, "location", job, "hyperlinks", null)

		return false
	})

	return left > 0 || dropped === 0
}

// --- Consolidation and web publishing ---

function dataConsolidate(edited: Edited, root: number, job: RefJob): boolean {
	const { document, editor } = edited
	const refs = childByLocal(document, root, "dataRefs")

	if (refs < 0) return true

	const formulas = job.formulas

	for (const node of childElements(document, refs)) {
		const ref = document.attribute(node, "ref")
		const sheet = document.attribute(node, "sheet")

		if (ref === undefined || document.attribute(node, "name") !== undefined || document.attribute(node, "r:id") !== undefined) continue

		// As one qualified reference: the formula shift moves, renames or deletes it.
		const qualified = `${sheet === undefined ? "" : `'${sheet.replaceAll("'", "''")}'!`}${ref}`
		const next = formulas.shift(qualified, job.own)

		if (next === qualified) continue
		if (next.includes("#REF!")) refuse("structureLocked", "dataConsolidate: source deleted")

		job.touch("dataConsolidate")

		const bang = next.lastIndexOf("!")
		const area = next.slice(bang + 1)
		const name =
			bang < 0
				? undefined
				: next
						.slice(0, bang)
						.replace(/^'(.*)'$/, "$1")
						.replaceAll("''", "'")

		if (area !== ref) editor.setAttribute(node, "ref", area)
		if (name !== undefined && name !== sheet) editor.setAttribute(node, "sheet", name)
	}

	return true
}

function webPublishItems(edited: Edited, root: number, job: RefJob): boolean {
	for (const node of childElements(edited.document, root)) {
		if (!shiftRefAttribute(edited, node, "sourceRef", job, "webPublishItems"))
			refuse("structureLocked", "webPublishItems: source deleted")
	}

	return true
}

// --- Controls and OLE objects ---

// controls and oleObjects (directly or inside mc:AlternateContent): anchors and linked cells.
function objects(edited: Edited, root: number, job: RefJob): boolean {
	const { document } = edited

	for (const node of descendants(document, root)) {
		const local = document.localName(node)

		if (local === "controlPr") {
			shiftFormulaAttribute(edited, node, "linkedCell", job, "controls", null)
			shiftFormulaAttribute(edited, node, "listFillRange", job, "controls", null)
		} else if (local === "anchor" && job.shift !== null) {
			shiftAnchor(edited, node, job, "controls")
		}
	}

	return true
}

function alternateContent(edited: Edited, root: number, job: RefJob): boolean {
	const { document } = edited

	for (const branch of childElements(document, root)) {
		for (const child of childElements(document, branch)) {
			const local = document.localName(child)

			if (local !== "controls" && local !== "oleObjects")
				refuse("structureLocked", `section mc:AlternateContent/${document.name(child)}`)
		}
	}

	return objects(edited, root, job)
}

// --- Extensions ---

// x14:conditionalFormatting and x14:dataValidation: the range list is the xm:sqref child, after the rules.
function x14Block(edited: Edited, node: number, job: RefJob, construct: "conditionalFormattingX14" | "dataValidationsX14"): boolean {
	const { document, editor } = edited
	const sqref = childByLocal(document, node, "sqref")
	let anchor: RangeAnchor | null = null

	if (sqref >= 0) {
		const moved = shiftSqrefText(
			document.textContent(sqref),
			job,
			construct,
			next => editor.setText(sqref, next),
			construct === "dataValidationsX14" ? "cells" : "list"
		)

		if (moved.ranges.length === 0) return false

		anchor = moved.anchor
	}

	for (const child of descendants(document, node))
		if (document.localName(child) === "f") shiftFormulaText(edited, child, job, construct, anchor)

	return true
}

function sparklineGroups(edited: Edited, groups: number, job: RefJob): boolean {
	const { document, editor } = edited
	const kept = filterChildren(edited, groups, "sparklineGroup", group => {
		for (const child of childElements(document, group)) {
			const local = document.localName(child)

			if (local === "f") shiftFormulaText(edited, child, job, "sparklines", null)

			if (local !== "sparklines") continue

			const lines = filterChildren(edited, child, "sparkline", line => {
				const location = childByLocal(document, line, "sqref")

				if (location >= 0) {
					const moved = shiftSqrefText(document.textContent(location), job, "sparklines", next => editor.setText(location, next))

					if (moved.ranges.length === 0) return true
				}

				const data = childByLocal(document, line, "f")

				if (data >= 0) shiftFormulaText(edited, data, job, "sparklines", null)

				return false
			})

			if (lines.left === 0 && lines.dropped > 0) return true
		}

		return false
	})

	return kept.left > 0 || kept.dropped === 0
}

function extLst(edited: Edited, root: number, job: RefJob): boolean {
	const { document } = edited
	const { left, dropped } = filterChildren(edited, root, "ext", ext => {
		const uri = (document.attribute(ext, "uri") ?? "").toUpperCase()

		if (PLAIN_EXTENSIONS.has(uri)) return false

		const container = document.firstChildElement(ext)

		if (container < 0) return false

		if (uri === EXT_CONDITIONAL_FORMATTINGS.toUpperCase() || uri === EXT_DATA_VALIDATIONS.toUpperCase()) {
			const conditional = uri === EXT_CONDITIONAL_FORMATTINGS.toUpperCase()
			const blocks = filterChildren(
				edited,
				container,
				conditional ? "conditionalFormatting" : "dataValidation",
				block => !x14Block(edited, block, job, conditional ? "conditionalFormattingX14" : "dataValidationsX14")
			)

			if (!conditional && blocks.dropped > 0) setCount(edited, container, "count", blocks.left)

			return blocks.left === 0 && blocks.dropped > 0
		}

		if (uri === EXT_SPARKLINE_GROUPS.toUpperCase()) return !sparklineGroups(edited, container, job)

		refuse("structureLocked", `extension ${document.attribute(ext, "uri") ?? ""}`)
	})

	return left > 0 || dropped === 0
}

const REWRITERS: ReadonlyMap<string, Rewriter> = new Map<string, Rewriter>([
	["protectedRanges", protectedRanges],
	["scenarios", scenarios],
	["autoFilter", (edited, root, job) => autoFilter(edited, root, job, "autoFilter")],
	["sortState", (edited, root, job) => sortState(edited, root, job, "sortState")],
	["dataConsolidate", dataConsolidate],
	["customSheetViews", customSheetViews],
	["sheetViews", sheetViews],
	["conditionalFormatting", conditionalFormatting],
	["dataValidations", dataValidations],
	["hyperlinks", hyperlinks],
	["rowBreaks", (edited, root, job) => breaks(edited, root, job, true)],
	["colBreaks", (edited, root, job) => breaks(edited, root, job, false)],
	["ignoredErrors", ignoredErrors],
	["cellWatches", cellList("cellWatches", "cellWatch")],
	["smartTags", cellList("smartTags", "cellSmartTags")],
	["oleObjects", objects],
	["controls", objects],
	["webPublishItems", webPublishItems],
	["mc:AlternateContent", alternateContent],
	["extLst", extLst]
])
