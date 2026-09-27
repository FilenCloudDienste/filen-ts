import type { CellValue } from "hucre"

// What a typed entry becomes, the way spreadsheets read it: a leading "=" starts a formula, a leading "'"
// keeps the rest as text whatever it looks like, and otherwise numbers (with thousands separators, a
// percent sign, an exponent), TRUE/FALSE and ISO dates are recognised, with the format they imply for a
// cell that has none. Anything else is text, as typed.
export type ParsedInput =
	{ type: "empty" } | { type: "formula"; formula: string } | { type: "value"; value: Exclude<CellValue, null>; impliedFormat?: string }

const NUMBER = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i
const GROUPED = /^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/
const PERCENT = /^[-+]?(\d+\.?\d*|\.\d+)%$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export function parseCellInput(input: string): ParsedInput {
	if (input === "") {
		return { type: "empty" }
	}

	if (input.startsWith("=") && input.length > 1) {
		return { type: "formula", formula: input.slice(1) }
	}

	if (input.startsWith("'")) {
		return { type: "value", value: input.slice(1) }
	}

	const trimmed = input.trim()

	if (NUMBER.test(trimmed)) {
		return { type: "value", value: Number(trimmed) }
	}

	if (GROUPED.test(trimmed)) {
		return { type: "value", value: Number(trimmed.replaceAll(",", "")), impliedFormat: trimmed.includes(".") ? "#,##0.00" : "#,##0" }
	}

	if (PERCENT.test(trimmed)) {
		return { type: "value", value: Number(trimmed.slice(0, -1)) / 100, impliedFormat: trimmed.includes(".") ? "0.00%" : "0%" }
	}

	const upper = trimmed.toUpperCase()

	if (upper === "TRUE" || upper === "FALSE") {
		return { type: "value", value: upper === "TRUE" }
	}

	const date = ISO_DATE.exec(trimmed)

	if (date !== null) {
		const [, year = "", month = "", day = ""] = date
		const value = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))

		if (value.getUTCMonth() === Number(month) - 1 && value.getUTCDate() === Number(day)) {
			return { type: "value", value, impliedFormat: "yyyy-mm-dd" }
		}
	}

	return { type: "value", value: input }
}
