import { CellError, EmptyValue, ErrorType, FunctionArgumentType, SimpleRangeValue, type ImplementedFunctions } from "hyperformula"
import {
	genericErrorText,
	MAX_TEXT,
	numberText,
	rawNumber,
	SheetFunctionPlugin,
	valueError,
	type PluginCall,
	type PluginScalar,
	type PluginState
} from "./plugin"

// Text functions as support.microsoft.com defines them: ARRAYTOTEXT, VALUETOTEXT, BAHTTEXT and ENCODEURL.

const ERROR_TEXT: Readonly<Partial<Record<ErrorType, string>>> = {
	[ErrorType.DIV_BY_ZERO]: "#DIV/0!",
	[ErrorType.NAME]: "#NAME?",
	[ErrorType.VALUE]: "#VALUE!",
	[ErrorType.NUM]: "#NUM!",
	[ErrorType.NA]: "#N/A",
	[ErrorType.REF]: "#REF!",
	[ErrorType.SPILL]: "#SPILL!"
}

function errorText(error: CellError): string {
	return genericErrorText(error) ?? ERROR_TEXT[error.type] ?? "#VALUE!"
}

// A value as text: concise as a cell in the General format shows it (a number at 15 significant digits, as ""&A1
// gives it), strict as the formula bar reads it back (text, and an empty cell, in quotes with quotes doubled).
function valueText(value: PluginScalar, strict: boolean): string {
	if (value instanceof CellError) return errorText(value)
	if (typeof value === "boolean") return value ? "TRUE" : "FALSE"

	const number = rawNumber(value)

	if (number !== undefined) return numberText(number)

	const text = value === EmptyValue ? "" : String(value)

	return strict ? `"${text.replaceAll('"', '""')}"` : text
}

// The format argument of ARRAYTOTEXT and VALUETOTEXT: 0 concise, 1 strict, anything else null (#VALUE!).
function strictFormat(format: number): boolean | null {
	return format === 0 ? false : format === 1 ? true : null
}

const DIGITS = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"]
// The places of a group of six digits, from the units up.
const PLACES = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"]
const MILLION = "ล้าน"

// Thai words for 1 to 999,999: a 1 in the tens is สิบ and a 2 ยี่สิบ; a 1 in the units of a number above 10 is เอ็ด.
function groupWords(value: number): string {
	let out = ""
	let rest = value

	for (let place = 5; place >= 0; place--) {
		const scale = 10 ** place
		const digit = Math.floor(rest / scale)

		rest -= digit * scale

		if (digit === 0) continue
		if (place === 1) out += digit === 1 ? "สิบ" : digit === 2 ? "ยี่สิบ" : `${DIGITS[digit] ?? ""}สิบ`
		else if (place === 0) out += digit === 1 && value > 10 ? "เอ็ด" : (DIGITS[digit] ?? "")
		else out += `${DIGITS[digit] ?? ""}${PLACES[place] ?? ""}`
	}

	return out
}

// Thai words for a whole number above 0, by groups of six digits joined with ล้าน (a million).
function thaiWords(value: number): string {
	if (value < 1_000_000) return groupWords(value)

	const high = Math.floor(value / 1_000_000)
	const low = value - high * 1_000_000

	return `${thaiWords(high)}${MILLION}${low === 0 ? "" : groupWords(low)}`
}

// BAHTTEXT's words: baht then satang (the number rounded to hundredths), บาทถ้วน (baht exactly) when there are no
// satang, ลบ before a negative number.
export function bahtText(value: number): string {
	const hundredths = Math.round(Math.abs(value) * 100)
	const baht = Math.floor(hundredths / 100)
	const satang = hundredths - baht * 100
	const sign = value < 0 && hundredths > 0 ? "ลบ" : ""

	if (baht === 0 && satang === 0) return `${DIGITS[0] ?? ""}บาทถ้วน`

	const bahtPart = baht === 0 ? "" : `${thaiWords(baht)}บาท`

	return `${sign}${bahtPart}${satang === 0 ? "ถ้วน" : `${thaiWords(satang)}สตางค์`}`
}

// ENCODEURL's encoding: the text's UTF-8 bytes, each but the unreserved characters of RFC 3986 (letters, digits,
// "-", ".", "_" and "~") as % and two hexadecimal digits; the page's example keeps "." and encodes ":", "/" and " ".
export function encodeUrl(text: string): string {
	return encodeURIComponent(text).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

export class Text2Functions extends SheetFunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		ARRAYTOTEXT: {
			method: "arraytotext",
			parameters: [
				{ argumentType: FunctionArgumentType.RANGE },
				{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 0, emptyAsDefault: true }
			],
			enableArrayArithmeticForArguments: true,
			vectorizationForbidden: true
		},
		VALUETOTEXT: {
			method: "valuetotext",
			parameters: [
				{ argumentType: FunctionArgumentType.SCALAR },
				{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 0, emptyAsDefault: true }
			]
		},
		BAHTTEXT: { method: "bahttext", parameters: [{ argumentType: FunctionArgumentType.NUMBER }] },
		ENCODEURL: { method: "encodeurl", parameters: [{ argumentType: FunctionArgumentType.SCALAR }] }
	}

	// ARRAYTOTEXT(array, [format]): the values of array as one text, concise (", " between them, row by row) or strict
	// (as an array constant: "," between values, ";" between rows, in braces).
	arraytotext(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("ARRAYTOTEXT"), (array: SimpleRangeValue, format: number) => {
			const strict = strictFormat(format)

			if (strict === null) return valueError()

			const rows = array.data.map(row => row.map(value => valueText(value, strict)).join(strict ? "," : ", "))
			const text = strict ? `{${rows.join(";")}}` : rows.join(", ")

			return text.length > MAX_TEXT ? valueError() : text
		})
	}

	// VALUETOTEXT(value, [format]): the value as text, concise or strict; an error gives its own text.
	valuetotext(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("VALUETOTEXT"), (value: PluginScalar, format: number) => {
			const strict = strictFormat(format)

			return strict === null ? valueError() : valueText(value, strict)
		})
	}

	bahttext(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("BAHTTEXT"), bahtText)
	}

	encodeurl(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("ENCODEURL"), (value: PluginScalar) => {
			if (value instanceof CellError) return value

			const text = encodeUrl(valueText(value, false))

			return text.length > MAX_TEXT ? valueError() : text
		})
	}
}
