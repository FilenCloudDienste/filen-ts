import type { OdfElement } from "../../odf/tree"
import type { SheetRefusal } from "../../sheet/protocol"
import type { XlsxDocument } from "../../xlsx/edit/document"
import type { XlsxDxf, XlsxWorkbookModel, XlsxSheetModel } from "../../xlsx/model/types"
import { encodeUtf8, parseXml } from "../../xml/index"
import { conditionalSections } from "../features"
import { OdsIssues } from "../issues"
import type { OdsSource } from "../source"
import { addressBoxes, splitList, type Shifter } from "../unheld"
import { currentSection, sectionText } from "./features"

// A table's calcext:conditional-formats moved with its cells as LibreOffice moves them: each format's target ranges,
// its conditions' base cells and the references in their values; a range whose cells were all deleted left out, a
// format left with none dropped. Every other attribute and element stays as written (style names, rules the model
// cannot show). An edit is taken only where that, read back, is the model's conditional formatting.

// A format's target range list moved: the list now and its first cell, "gone" when every range was deleted, null
// where a range cannot be moved for sure.
export type MovedTarget = { readonly target: string; readonly corner: string } | "gone" | null

// Whether every cell an address names was deleted (its sheet, or all its rows or all its columns).
function deleted(text: string, shifter: Shifter, own: string): boolean {
	const boxes = addressBoxes(text, own)

	if (boxes === null || boxes.length === 0) return false

	return boxes.every(box => {
		const move = shifter.moves.get(box.sheet)

		if (move === null) return true
		if (move === undefined) return false

		const gone = (axis: typeof move.rows, low: number, high: number): boolean => {
			const first = axis.nextKept(low)
			const last = axis.previousKept(high)

			return first < 0 || last < 0 || first > last
		}

		return gone(move.rows, box.startRow, box.endRow) || gone(move.cols, box.startCol, box.endCol)
	})
}

// A range's first cell as written ("'My sheet'.C1" of "'My sheet'.C1:'My sheet'.C6").
function firstCell(range: string): string {
	for (let k = 0; k < range.length; k++) {
		if (range[k] === "'") {
			k++

			while (k < range.length && !(range[k] === "'" && range[k + 1] !== "'")) k += range[k] === "'" ? 2 : 1
		} else if (range[k] === ":") return range.slice(0, k)
	}

	return range
}

export function movedTarget(text: string, shifter: Shifter, own: string): MovedTarget {
	if (!shifter.changed) return { target: text, corner: firstCell(splitList(text)?.[0] ?? text) }

	const parts = splitList(text)

	if (parts === null) return null

	const kept: string[] = []

	for (const part of parts) {
		const moved = shifter.address(part, "formula", own)

		if (moved !== null) kept.push(moved)
		else if (!deleted(part, shifter, own)) return null
	}

	const first = kept[0]

	return first === undefined ? "gone" : { target: kept.join(" "), corner: firstCell(first) }
}

// One attribute of a format or of a rule in it (by its calcext local name) moved; undefined for one that names no
// cell. A base cell deleted while its format's cells are not is the format's first cell now.
export function movedAttribute(
	local: string,
	value: string,
	target: { readonly target: string; readonly corner: string },
	shifter: Shifter,
	own: string
): string | null | undefined {
	switch (local) {
		case "target-range-address":
			return target.target
		case "base-cell-address": {
			const moved = shifter.address(value, "formula", own)

			return moved !== null ? moved : deleted(value, shifter, own) ? target.corner : null
		}
		case "value":
			return shifter.formula(value, own, "formula")
		default:
			return undefined
	}
}

const CALCEXT = "calcext:"

function movedElement(element: OdfElement, target: { target: string; corner: string }, shifter: Shifter, own: string): OdfElement | null {
	let attributes: Map<string, string> | null = null

	for (const [name, value] of element.attributes) {
		if (!name.startsWith(CALCEXT)) continue

		const moved = movedAttribute(name.slice(CALCEXT.length), value, target, shifter, own)

		if (moved === null) return null
		if (moved === undefined || moved === value) continue

		attributes ??= new Map(element.attributes)
		attributes.set(name, moved)
	}

	let children: OdfElement[] | null = null

	for (const [index, child] of element.children.entries()) {
		const moved = movedElement(child, target, shifter, own)

		if (moved === null) return null
		if (moved === child) continue

		children ??= [...element.children]
		children[index] = moved
	}

	return attributes === null && children === null
		? element
		: { ...element, attributes: attributes ?? element.attributes, children: children ?? element.children }
}

// calcext:conditional-formats elements moved, null where one cannot be for sure.
export function movedFormats(containers: readonly OdfElement[], shifter: Shifter, own: string): OdfElement[] | null {
	if (!shifter.changed) return [...containers]

	const out: OdfElement[] = []

	for (const container of containers) {
		const formats: OdfElement[] = []

		for (const format of container.children) {
			const text = format.attributes.get("calcext:target-range-address")

			if (format.name !== "calcext:conditional-format" || text === undefined) {
				formats.push(format)

				continue
			}

			const target = movedTarget(text, shifter, own)

			if (target === null) return null
			if (target === "gone") continue

			const moved = movedElement(format, target, shifter, own)

			if (moved === null) return null

			formats.push(moved)
		}

		out.push({ ...container, children: formats })
	}

	return out
}

// A range list as one spelling: a range of one cell as that cell ("C2:C2" is "C2").
function sqrefKey(sqref: string): string {
	return sqref
		.trim()
		.split(/\s+/)
		.map(range => {
			const [first = "", second] = range.toUpperCase().split(":")

			return second === undefined || second === first ? first : `${first}:${second}`
		})
		.join(" ")
}

// Conditional formatting sections as they decide what cells show: ranges, rules in order with what they test and
// the look they give (a dxf by its properties, priorities aside, as the order is theirs).
export function conditionsKey(markup: string, dxfs: readonly XlsxDxf[]): string {
	if (markup.trim() === "") return ""

	const document = parseXml(encodeUtf8(`<r>${markup}</r>`))
	const key = (node: number): unknown[] => {
		const attributes: [string, string][] = []

		for (const { name, value } of document.attributes(node)) {
			if (name === "priority" || name === "xmlns" || name.startsWith("xmlns:")) continue

			attributes.push([
				name,
				name === "dxfId" ? JSON.stringify(dxfs[Number(value)] ?? null) : name === "sqref" ? sqrefKey(value) : value
			])
		}

		attributes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

		const children: unknown[] = []

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) children.push(key(child))

		return [document.localName(node), attributes, children.length === 0 ? document.textContent(node) : children]
	}

	return JSON.stringify(key(document.documentElement()))
}

// A sheet's conditional formatting as the save has it.
export function currentConditions(workbook: XlsxWorkbookModel, model: XlsxSheetModel): string {
	return currentSection(workbook, model, "conditionalFormatting") ?? sectionText(model.sections, "conditionalFormatting")
}

// What each source table's formats, moved as the sheets were, read as: null for a table whose formats cannot move.
function movedSections(source: OdsSource, shifter: Shifter, index: number): string | null {
	const table = source.tables[index]

	if (table === undefined || table.conditionalFormats.length === 0) return ""

	const moved = movedFormats(table.conditionalFormats, shifter, table.name)

	return moved === null ? null : conditionalSections(moved, table.name, source.styles, new OdsIssues()).join("")
}

// Whether the conditional formatting the model holds now is what the source's formats say moved so: a sheet whose
// formats changed otherwise (a sort, a shift of cells, a paste, a copy of the sheet) cannot be written.
export function conditionsRefusal(document: XlsxDocument, source: OdsSource, shifter: Shifter): SheetRefusal | null {
	const refused: SheetRefusal = { reason: "unsupported", detail: "conditionalFormatting" }
	const workbook = document.workbook
	const dxfs = workbook.styles.dxfs

	for (const entry of workbook.sheets) {
		const model = entry.model

		if (model === null || entry.kind !== "worksheet") continue

		const table = source.tables[entry.id]
		const own = table !== undefined && table.id === entry.id && "rowAxis" in model

		if (!own) {
			if (currentConditions(workbook, model).trim() !== "") return refused

			continue
		}

		const expected = movedSections(source, shifter, entry.id)

		if (expected === null || conditionsKey(expected, dxfs) !== conditionsKey(currentConditions(workbook, model), dxfs)) return refused
	}

	return null
}

export function sameConditions(a: string, dxfsA: readonly XlsxDxf[], b: string, dxfsB: readonly XlsxDxf[]): boolean {
	return conditionsKey(a, dxfsA) === conditionsKey(b, dxfsB)
}
