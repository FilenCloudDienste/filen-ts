import type { SheetRange } from "../protocol"
import { parseSqref } from "../../xlsx/refs/sqref"
import { booleanAttribute, childByLocal, childElements } from "../../xlsx/read/styleRecords"
import type { XmlDocument } from "../../xml/index"
import { parseSections } from "../cf/rules"

// A sheet's data validations (ECMA-376 Part 1 §18.3.1.32 dataValidation, §18.3.1.33 dataValidations) and the
// Excel 2010 ones in the worksheet's extLst ([MS-XLSX] §2.6.65 x14:dataValidations, uri
// {CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}), which Excel writes for rules that name other sheets.

// §18.18.21 ST_DataValidationType.
export type DvType = "none" | "whole" | "decimal" | "list" | "date" | "time" | "textLength" | "custom"

// §18.18.20 ST_DataValidationOperator.
export type DvOperator =
	"between" | "notBetween" | "equal" | "notEqual" | "lessThan" | "lessThanOrEqual" | "greaterThan" | "greaterThanOrEqual"

// §18.18.18 ST_DataValidationErrorStyle.
export type DvErrorStyle = "stop" | "warning" | "information"

export interface DvRule {
	readonly ranges: readonly SheetRange[]
	readonly type: DvType
	readonly operator: DvOperator
	// As stored (no "="), null when absent.
	readonly formula1: string | null
	readonly formula2: string | null
	readonly allowBlank: boolean
	// The file's showDropDown: true HIDES the in-cell list (§18.3.1.32 names it the other way round; Excel and
	// LibreOffice read it so).
	readonly hideDropDown: boolean
	readonly showInputMessage: boolean
	readonly showErrorMessage: boolean
	readonly errorStyle: DvErrorStyle
	readonly errorTitle: string | null
	readonly error: string | null
	readonly promptTitle: string | null
	readonly prompt: string | null
	// Written in the extLst (x14).
	readonly extended: boolean
}

export const MAX_DV_RULES = 65_534
const MAX_DV_RANGES = 10_000
const DV_EXT = "{CCE6A557-97BC-4B89-ADB6-D9C93CAAB3DF}"

const TYPES: ReadonlySet<string> = new Set(["none", "whole", "decimal", "list", "date", "time", "textLength", "custom"])
const OPERATORS: ReadonlySet<string> = new Set([
	"between",
	"notBetween",
	"equal",
	"notEqual",
	"lessThan",
	"lessThanOrEqual",
	"greaterThan",
	"greaterThanOrEqual"
])

function formulaOf(document: XmlDocument, node: number, local: "formula1" | "formula2"): string | null {
	const child = childByLocal(document, node, local)

	if (child < 0) return null

	// x14 keeps the formula in an xm:f child.
	const f = childByLocal(document, child, "f")

	return document.textContent(f >= 0 ? f : child)
}

function ruleOf(document: XmlDocument, node: number, extended: boolean): DvRule | null {
	const type = document.attribute(node, "type") ?? "none"
	const operator = document.attribute(node, "operator") ?? "between"
	const style = document.attribute(node, "errorStyle")
	const sqref = extended ? document.textContent(childByLocal(document, node, "sqref")) : (document.attribute(node, "sqref") ?? "")
	const ranges = (parseSqref(sqref) ?? []).slice(0, MAX_DV_RANGES)

	if (ranges.length === 0) return null

	return {
		ranges,
		type: TYPES.has(type) ? (type as DvType) : "none",
		operator: OPERATORS.has(operator) ? (operator as DvOperator) : "between",
		formula1: formulaOf(document, node, "formula1"),
		formula2: formulaOf(document, node, "formula2"),
		allowBlank: booleanAttribute(document, node, "allowBlank", false),
		hideDropDown: booleanAttribute(document, node, "showDropDown", false),
		showInputMessage: booleanAttribute(document, node, "showInputMessage", false),
		showErrorMessage: booleanAttribute(document, node, "showErrorMessage", false),
		errorStyle: style === "warning" || style === "information" ? style : "stop",
		errorTitle: document.attribute(node, "errorTitle") ?? null,
		error: document.attribute(node, "error") ?? null,
		promptTitle: document.attribute(node, "promptTitle") ?? null,
		prompt: document.attribute(node, "prompt") ?? null,
		extended
	}
}

// The validations of a sheet from its dataValidations section and its extLst (markup as written), the 2007 ones
// first. Malformed sections show nothing.
export function readValidations(sections: readonly string[], extLst: string | null): DvRule[] {
	const rules: DvRule[] = []

	for (const markup of sections) {
		const document = parseSections(markup)

		if (document === null) continue

		for (const section of childElements(document, document.documentElement())) {
			if (document.localName(section) !== "dataValidations") continue

			for (const node of childElements(document, section)) {
				if (document.localName(node) !== "dataValidation" || rules.length >= MAX_DV_RULES) continue

				const rule = ruleOf(document, node, false)

				if (rule !== null) rules.push(rule)
			}
		}
	}

	const ext = extLst === null ? null : parseSections(extLst)

	for (const list of ext === null ? [] : childElements(ext, ext.documentElement())) {
		if (ext === null || ext.localName(list) !== "extLst") continue

		for (const item of childElements(ext, list)) {
			if ((ext.attribute(item, "uri") ?? "").toUpperCase() !== DV_EXT) continue

			const section = childByLocal(ext, item, "dataValidations")

			for (const node of section < 0 ? [] : childElements(ext, section)) {
				if (ext.localName(node) !== "dataValidation" || rules.length >= MAX_DV_RULES) continue

				const rule = ruleOf(ext, node, true)

				if (rule !== null) rules.push(rule)
			}
		}
	}

	return rules
}

// The validation of a cell: the first rule whose ranges hold it.
export function validationAt(rules: readonly DvRule[], row: number, col: number): DvRule | null {
	for (const rule of rules)
		for (const range of rule.ranges)
			if (row >= range.startRow && row <= range.endRow && col >= range.startCol && col <= range.endCol) return rule

	return null
}
