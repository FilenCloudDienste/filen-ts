import {
	MAX_VALIDATION_LIST,
	type DvErrorStyle,
	type DvOperator,
	type DvType,
	type SheetRefusalReason,
	type SheetValidationRule
} from "@filen/office/core/sheet"
import type { PreviewKey } from "@/lib/i18n"

// What the Data validation dialog offers and shows, as Excel's dialog: the kinds of value, the comparisons, which
// fields each kind takes, and the messages a refused rule shows.

export const VALIDATION_TYPES: readonly { readonly value: DvType; readonly key: PreviewKey }[] = [
	{ value: "none", key: "previewSheetValidationAny" },
	{ value: "whole", key: "previewSheetValidationWhole" },
	{ value: "decimal", key: "previewSheetValidationDecimal" },
	{ value: "list", key: "previewSheetValidationList" },
	{ value: "date", key: "previewSheetValidationDate" },
	{ value: "time", key: "previewSheetValidationTime" },
	{ value: "textLength", key: "previewSheetValidationTextLength" },
	{ value: "custom", key: "previewSheetValidationCustom" }
]

export const VALIDATION_OPERATORS: readonly { readonly value: DvOperator; readonly key: PreviewKey }[] = [
	{ value: "between", key: "previewSheetValidationBetween" },
	{ value: "notBetween", key: "previewSheetValidationNotBetween" },
	{ value: "equal", key: "previewSheetValidationEqual" },
	{ value: "notEqual", key: "previewSheetValidationNotEqual" },
	{ value: "greaterThan", key: "previewSheetValidationGreater" },
	{ value: "lessThan", key: "previewSheetValidationLess" },
	{ value: "greaterThanOrEqual", key: "previewSheetValidationGreaterOrEqual" },
	{ value: "lessThanOrEqual", key: "previewSheetValidationLessOrEqual" }
]

export const ERROR_STYLES: readonly { readonly value: DvErrorStyle; readonly key: PreviewKey }[] = [
	{ value: "stop", key: "previewSheetValidationStop" },
	{ value: "warning", key: "previewSheetValidationWarning" },
	{ value: "information", key: "previewSheetValidationInformation" }
]

// A new rule as Excel's dialog starts one: any value, Ignore blank, an in-cell list, the error alert on.
export const NEW_RULE: SheetValidationRule = {
	type: "none",
	operator: "between",
	value1: "",
	value2: "",
	allowBlank: true,
	inCellDropdown: true,
	showInputMessage: true,
	promptTitle: "",
	prompt: "",
	showErrorMessage: true,
	errorStyle: "stop",
	errorTitle: "",
	error: ""
}

export type ValidationField = "operator" | "minimum" | "maximum" | "value" | "source" | "formula"

// The fields a kind of rule takes, in the dialog's order.
export function validationFields(rule: Pick<SheetValidationRule, "type" | "operator">): ValidationField[] {
	switch (rule.type) {
		case "none":
			return []
		case "list":
			return ["source"]
		case "custom":
			return ["formula"]
		default:
			return rule.operator === "between" || rule.operator === "notBetween"
				? ["operator", "minimum", "maximum"]
				: ["operator", "value"]
	}
}

// Whether the rule has what its kind needs before it can be applied.
export function validationComplete(rule: SheetValidationRule): boolean {
	const fields = validationFields(rule)
	const filled = (value: string): boolean => value.trim() !== ""

	if (fields.includes("source") || fields.includes("formula") || fields.includes("value") || fields.includes("minimum"))
		if (!filled(rule.value1)) return false

	return !fields.includes("maximum") || filled(rule.value2)
}

// What a refused rule tells the user.
export function validationRefusalKey(reason: SheetRefusalReason, rule: SheetValidationRule): PreviewKey | null {
	switch (reason) {
		case "formula":
			return "previewSheetValidationInvalidValue"
		case "tooLarge":
			return rule.type === "list" && !rule.value1.trim().startsWith("=") && rule.value1.trim().length > MAX_VALIDATION_LIST
				? "previewSheetValidationListTooLong"
				: "previewSheetValidationTextTooLong"
		default:
			return null
	}
}
