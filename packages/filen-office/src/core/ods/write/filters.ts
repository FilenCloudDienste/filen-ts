import { parseRangeRef } from "../../xlsx/write/text"
import { columnName } from "../../sheet/refs/cellRef"
import { ofSheetName } from "../formula/toOf"
import { encodeUtf8, escapeAttribute, parseXml, type XmlDocument } from "../../xml/index"

// A sheet's autoFilter as the table:database-range LibreOffice keeps it in (ODF 1.3 Part 3 §9.4.15): its range with
// filter buttons, and its criteria as table:filter conditions (§9.5), the inverse of features.ts filterColumns. A
// criterion the reader cannot take back (top ten, dynamic, colour filters, "or" across columns) is refused.

export class FilterRefused extends Error {}

const OPERATORS: Readonly<Record<string, string>> = {
	equal: "=",
	notEqual: "!=",
	lessThan: "<",
	lessThanOrEqual: "<=",
	greaterThan: ">",
	greaterThanOrEqual: ">="
}

function elements(document: XmlDocument, node: number, local: string): number[] {
	const out: number[] = []

	for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child))
		if (document.localName(child) === local) out.push(child)

	return out
}

function condition(field: number, operator: string, value: string, items: readonly string[] = []): string {
	const set = items.map(item => `<table:filter-set-item table:value="${escapeAttribute(item)}"/>`).join("")
	const open = `<table:filter-condition table:field-number="${field}" table:value="${escapeAttribute(value)}" table:operator="${escapeAttribute(operator)}"`

	return set === "" ? `${open}/>` : `${open}>${set}</table:filter-condition>`
}

// The database range of an autoFilter section on `sheet` (its name as table:name shows it), null without one.
export function filterRange(markup: string, sheet: string, name: string): string | null {
	if (markup.trim() === "") return null

	const document = parseXml(encodeUtf8(markup))
	const root = document.documentElement()
	const range = parseRangeRef(document.attribute(root, "ref") ?? "")

	if (range === undefined || range === null) throw new FilterRefused("An autoFilter range")

	const quoted = ofSheetName(sheet)
	const address = `${quoted}.${columnName(range.startCol)}${range.startRow + 1}:${quoted}.${columnName(range.endCol)}${range.endRow + 1}`
	const conditions: string[] = []
	let combined = "and"

	for (const filterColumn of elements(document, root, "filterColumn")) {
		const field = Number(document.attribute(filterColumn, "colId") ?? "0")
		const values = elements(document, filterColumn, "filters")[0]
		const customs = elements(document, filterColumn, "customFilters")[0]

		if (values !== undefined) {
			if (document.attribute(values, "blank") === "1" || elements(document, values, "dateGroupItem").length > 0)
				throw new FilterRefused("A blank or date-group filter")

			const items = elements(document, values, "filter").map(node => document.attribute(node, "val") ?? "")

			if (items.length === 0) continue

			conditions.push(condition(field, "=", items[0] ?? "", items.length > 1 ? items : []))
		} else if (customs !== undefined) {
			const list = elements(document, customs, "customFilter")

			if (list.length > 2) throw new FilterRefused("More than two custom filters")

			const and = document.attribute(customs, "and") === "1"

			if (!and && list.length > 1) {
				if (elements(document, root, "filterColumn").length > 1)
					throw new FilterRefused("Custom filters joined by or with other columns")

				combined = "or"
			}

			for (const custom of list) {
				const operator = OPERATORS[document.attribute(custom, "operator") ?? "equal"]

				if (operator === undefined) throw new FilterRefused("A custom filter's operator")

				conditions.push(condition(field, operator, document.attribute(custom, "val") ?? ""))
			}
		} else {
			throw new FilterRefused("A top ten, dynamic or colour filter")
		}
	}

	const filter =
		conditions.length === 0
			? ""
			: conditions.length === 1
				? `<table:filter>${conditions[0] ?? ""}</table:filter>`
				: `<table:filter><table:filter-${combined}>${conditions.join("")}</table:filter-${combined}></table:filter>`

	return `<table:database-range table:name="${escapeAttribute(name)}" table:target-range-address="${escapeAttribute(address)}" table:display-filter-buttons="true">${filter}</table:database-range>`
}
