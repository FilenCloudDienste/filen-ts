import { escapeAttribute, decodeUtf8, encodeUtf8 } from "../../xml/index"
import type { SheetId, SheetRange } from "../../sheet/protocol"
import { inBand, shiftRange, straddles, type AxisShift } from "./axis"
import { refuse } from "./catalogue"
import { childByLocal, childElements, editMarkup, type RefJob } from "./markup"
import { autoFilter, sortState } from "./sections"
import { formatRef, parseRef } from "./sqref"
import type { TableEdit } from "./structured"

// Tables (ECMA-376 Part 1 §18.5): the range, its autofilter and sort state, and the columns. Rows inserted inside
// a table grow it, as Excel does; columns inserted inside it become new table columns named "ColumnN" (the first
// unused N), whose header cells take the name (Excel repairs a table whose header cell differs from its column's
// name). A table whose every row or column is deleted goes, and so do the structured references to it. Deleting the header row, the totals row or every data row alone is refused.

export interface TableColumn {
	readonly id: number
	readonly name: string
}

export interface TableInfo {
	readonly part: string
	readonly contentType: string
	readonly sheet: SheetId
	// The sheet's relationship to the part.
	readonly relationship: string
	readonly id: number
	readonly name: string
	readonly ref: SheetRange
	readonly headerRows: number
	readonly totalsRows: number
	readonly columns: readonly TableColumn[]
	readonly bytes: Uint8Array
	// Related parts (a query table): removed with the table.
	readonly related: readonly string[]
}

export function readTable(
	part: string,
	contentType: string,
	sheet: SheetId,
	relationship: string,
	bytes: Uint8Array,
	related: readonly string[]
): TableInfo {
	const { document } = editMarkup(bytes, `table ${part}`)
	const root = document.documentElement()
	const ref = parseRef(document.attribute(root, "ref") ?? "")

	if (ref === null) refuse("structureLocked", `tables: range of ${part}`)

	const columns: TableColumn[] = []
	const container = childByLocal(document, root, "tableColumns")

	for (const column of container < 0 ? [] : childElements(document, container)) {
		if (document.localName(column) === "tableColumn")
			columns.push({ id: Number(document.attribute(column, "id") ?? "0"), name: document.attribute(column, "name") ?? "" })
	}

	return {
		part,
		contentType,
		sheet,
		relationship,
		id: Number(document.attribute(root, "id") ?? "0"),
		name: document.attribute(root, "name") ?? document.attribute(root, "displayName") ?? "",
		ref,
		headerRows: Number(document.attribute(root, "headerRowCount") ?? "1"),
		totalsRows: Number(document.attribute(root, "totalsRowCount") ?? "0"),
		columns,
		bytes,
		related
	}
}

export interface TableShift {
	readonly table: TableInfo
	// null: the table goes.
	readonly ref: SheetRange | null
	// New columns: their names, from `at` on (0-based inside the table), and the header row to write them to.
	readonly added: { readonly at: number; readonly names: readonly string[]; readonly headerRow: number } | null
	readonly removed: readonly TableColumn[]
}

function freshNames(columns: readonly TableColumn[], count: number): string[] {
	const taken = new Set(columns.map(column => column.name.toUpperCase()))
	const names: string[] = []

	for (let n = 1; names.length < count; n++) {
		const name = `Column${n}`

		if (!taken.has(name.toUpperCase())) names.push(name)
	}

	return names
}

// How the edit moves a table on the edited sheet; refuses what Excel would not do. Cells shifted in a band move a
// table they lie across as whole rows or columns would, and refuse to move part of one, whose columns would no
// longer hold its cells.
export function shiftTable(table: TableInfo, shift: AxisShift): TableShift {
	if (straddles(table.ref, shift)) refuse("structureLocked", "tables: part of a table")
	if (!inBand(table.ref, shift)) return { table, ref: table.ref, added: null, removed: [] }

	const ref = shiftRange(table.ref, shift)

	if (ref === null) return { table, ref: null, added: null, removed: table.columns }

	if (shift.axis === "rows") {
		if (shift.type === "delete") {
			const last = shift.at + shift.count - 1
			const inside = (row: number) => row >= shift.at && row <= last
			const dataStart = table.ref.startRow + table.headerRows
			const dataEnd = table.ref.endRow - table.totalsRows

			if (table.headerRows > 0 && inside(table.ref.startRow)) refuse("structureLocked", "tables: header row")
			if (table.totalsRows > 0 && inside(table.ref.endRow)) refuse("structureLocked", "tables: totals row")
			if (dataEnd >= dataStart && shift.at <= dataStart && last >= dataEnd) refuse("structureLocked", "tables: every data row")
		}

		return { table, ref, added: null, removed: [] }
	}

	if (shift.type === "insert") {
		const inside = shift.at > table.ref.startCol && shift.at <= table.ref.endCol

		return {
			table,
			ref,
			added: inside
				? {
						at: shift.at - table.ref.startCol,
						names: freshNames(table.columns, shift.count),
						headerRow: table.headerRows > 0 ? table.ref.startRow : -1
					}
				: null,
			removed: []
		}
	}

	const removed = table.columns.filter((_, index) => {
		const col = table.ref.startCol + index

		return col >= shift.at && col < shift.at + shift.count
	})

	return { table, ref, added: null, removed }
}

export function tableEdit(shift: TableShift): TableEdit | null {
	if (shift.ref === null) return { deleted: true }
	if (shift.removed.length > 0) return { deleted: false, columns: new Set(shift.removed.map(column => column.name.toUpperCase())) }

	return null
}

// The table part after the edit (`shift` null: only its formulas, for an edit elsewhere). The same bytes when
// nothing changed.
export function rewriteTable(table: TableInfo, shift: TableShift | null, job: RefJob): Uint8Array {
	const edited = editMarkup(table.bytes, `table ${table.part}`)
	const { document, editor } = edited
	const root = document.documentElement()

	if (shift !== null && shift.ref !== null && shift.ref !== table.ref) {
		job.touch("tables")
		editor.setAttribute(root, "ref", formatRef(shift.ref))
	}

	for (const child of childElements(document, root)) {
		const local = document.localName(child)

		if (local === "autoFilter" && shift !== null && !autoFilter(edited, child, job, "tables")) editor.remove(child)
		if (local === "sortState" && shift !== null && !sortState(edited, child, job, "tables")) editor.remove(child)
		if (local !== "tableColumns") continue

		const columns = childElements(document, child).filter(column => document.localName(column) === "tableColumn")
		const removed = new Set(shift?.removed.map(column => column.id) ?? [])
		let left = 0

		for (const column of columns) {
			if (removed.has(Number(document.attribute(column, "id") ?? "0"))) {
				job.touch("tableColumns")
				editor.remove(column)

				continue
			}

			left++

			for (const formula of childElements(document, column)) {
				const name = document.localName(formula)

				if (name === "calculatedColumnFormula" || name === "totalsRowFormula") shiftTableFormula(edited, formula, job, table.name)
			}
		}

		const added = shift?.added ?? null

		if (added !== null) {
			const neighbour = columns[added.at - 1]
			const qualified = neighbour === undefined ? "tableColumn" : document.name(neighbour)
			let next = table.columns.reduce((highest, column) => Math.max(highest, column.id), 0)
			let markup = ""

			for (const name of added.names) markup += `<${qualified} id="${String(++next)}" name="${escapeAttribute(name)}"/>`

			if (neighbour !== undefined) editor.insertAfter(neighbour, markup)
			else editor.prepend(child, markup)

			job.touch("tableColumns")
			left += added.names.length
		}

		if (document.attribute(child, "count") !== undefined && Number(document.attribute(child, "count")) !== left)
			editor.setAttribute(child, "count", String(left))
	}

	return editor.changed ? editor.serialize() : table.bytes
}

function shiftTableFormula(edited: ReturnType<typeof editMarkup>, node: number, job: RefJob, table: string): void {
	const text = edited.document.textContent(node)
	const next = job.formulas.shift(text, job.own, table)

	if (next !== text) {
		job.touch("tableColumns")
		edited.editor.setText(node, next)
	}
}

// The tableParts section without the relationships `ids` ("" when none is left).
export function withoutTableParts(markup: string, ids: ReadonlySet<string>): string {
	const edited = editMarkup(encodeUtf8(markup), "section tableParts")
	const { document, editor } = edited
	const root = document.documentElement()
	let left = 0

	for (const part of childElements(document, root)) {
		const rid = document.attributes(part).find(attribute => attribute.name.endsWith(":id") || attribute.name === "id")?.value

		if (rid !== undefined && ids.has(rid)) editor.remove(part)
		else left++
	}

	if (left === 0) return ""
	if (document.attribute(root, "count") !== undefined) editor.setAttribute(root, "count", String(left))

	return editor.changed ? decodeUtf8(editor.serialize()) : markup
}
