import { ISO_1900 } from "../../numfmt/date"
import { CellError, EmptyValue, FunctionArgumentType, SimpleRangeValue, type ImplementedFunctions } from "hyperformula"
import { formatValue, NUMFMT_EN_US, type NumFmtOptions } from "../../numfmt"
import {
	dateBaseOf,
	MAX_TEXT,
	naError,
	rawNumber,
	SheetFunctionPlugin,
	textOf,
	valueError,
	type PluginCall,
	type PluginScalar,
	type PluginState,
	type PluginValue
} from "./plugin"
import { flatten, rowsOf } from "./values"

// Text functions as Excel calculates them.

// Delimiters given as text or an array of texts.
function delimitersOf(value: PluginValue): string[] | CellError {
	const out: string[] = []

	for (const item of flatten(rowsOf(value))) {
		const text = textOf(item)

		if (text instanceof CellError) return text

		out.push(text)
	}

	return out
}

interface Occurrence {
	readonly start: number
	readonly end: number
}

// Where delimiters occur in text, without overlapping, from the start or (fromEnd) from the end; at each place the
// longest delimiter that matches.
function occurrences(text: string, delimiters: readonly string[], caseless: boolean, fromEnd: boolean): Occurrence[] {
	const subject = caseless ? text.toLowerCase() : text
	const needles = delimiters.map(delimiter => (caseless ? delimiter.toLowerCase() : delimiter)).sort((a, z) => z.length - a.length)
	const found: Occurrence[] = []

	if (needles.some(needle => needle === "")) return found

	if (!fromEnd) {
		for (let index = 0; index < subject.length;) {
			const needle = needles.find(candidate => subject.startsWith(candidate, index))

			if (needle === undefined) {
				index++
				continue
			}

			found.push({ start: index, end: index + needle.length })
			index += needle.length
		}

		return found
	}

	for (let end = subject.length; end > 0;) {
		const needle = needles.find(candidate => end - candidate.length >= 0 && subject.startsWith(candidate, end - candidate.length))

		if (needle === undefined) {
			end--
			continue
		}

		found.push({ start: end - needle.length, end })
		end -= needle.length
	}

	return found
}

const OPTIONS_1900: NumFmtOptions = { locale: NUMFMT_EN_US }
const OPTIONS_1904: NumFmtOptions = { locale: NUMFMT_EN_US, date1904: true }
const OPTIONS_ISO_1900: NumFmtOptions = { locale: NUMFMT_EN_US, date1904: ISO_1900 }

const PIECES = {
	parameters: [
		{ argumentType: FunctionArgumentType.STRING },
		{ argumentType: FunctionArgumentType.ANY },
		{ argumentType: FunctionArgumentType.INTEGER, defaultValue: 1, emptyAsDefault: true },
		{ argumentType: FunctionArgumentType.INTEGER, defaultValue: 0, emptyAsDefault: true },
		{ argumentType: FunctionArgumentType.INTEGER, defaultValue: 0, emptyAsDefault: true },
		{ argumentType: FunctionArgumentType.SCALAR, optionalArg: true, emptyAsDefault: true }
	],
	vectorizationForbidden: true
}

// One added to a string of decimal digits.
function increment(digits: string): string {
	let at = digits.length - 1

	while (at >= 0 && digits[at] === "9") at--

	return at < 0
		? `1${"0".repeat(digits.length)}`
		: `${digits.slice(0, at)}${String(Number(digits[at]) + 1)}${"0".repeat(digits.length - at - 1)}`
}

// The decimal digits of |value|, at Excel's 15 significant digits, rounded half up to `places` decimals (left of
// the point when negative): the whole part and `max(0, places)` fraction digits. Built from the digits, as toFixed
// takes at most 100 decimals, writes 1e21 and up in exponent form and rounds the binary value (2.675 to 2.67).
function decimalDigits(value: number, places: number): { readonly whole: string; readonly fraction: string } {
	const decimals = Math.max(0, places)

	if (value === 0) return { whole: "0", fraction: "0".repeat(decimals) }

	const [mantissa = "0", exponent = "0"] = Math.abs(value).toExponential(14).split("e")
	const digits = mantissa.replace(".", "")
	let point = Number(exponent) + 1
	const keep = point + places
	let kept: string

	if (keep < 0) return { whole: "0", fraction: "0".repeat(decimals) }

	if (keep >= digits.length) kept = digits + "0".repeat(keep - digits.length)
	else {
		kept = digits.slice(0, keep)

		if ((digits[keep] ?? "0") >= "5") {
			const next = increment(kept)

			if (next.length > kept.length) point++

			kept = next
		}
	}

	if (kept === "" || /^0*$/.test(kept)) return { whole: "0", fraction: "0".repeat(decimals) }
	if (point <= 0) return { whole: "0", fraction: "0".repeat(-point) + kept }
	if (kept.length <= point) return { whole: kept + "0".repeat(point - kept.length), fraction: "" }

	return { whole: kept.slice(0, point), fraction: kept.slice(point) }
}

// A number rounded to `decimals` (left of the point when negative), with its digits grouped by thousands or not.
// support.microsoft.com "FIXED function": decimals as large as 127, numbers of at most 15 significant digits.
function fixedText(value: number, decimals: number, grouped: boolean, prefix = ""): string | CellError {
	const places = Math.trunc(decimals)

	if (places > 127) return valueError()

	const { whole, fraction } = decimalDigits(value, places)
	const integer = grouped ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole
	const text = fraction === "" ? integer : `${integer}.${fraction}`
	const zero = whole === "0" && !/[1-9]/.test(fraction)

	return value < 0 && !zero ? (prefix === "" ? `-${text}` : `(${prefix}${text})`) : `${prefix}${text}`
}

export class TextFunctions extends SheetFunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		TEXT: {
			method: "text",
			parameters: [{ argumentType: FunctionArgumentType.SCALAR }, { argumentType: FunctionArgumentType.STRING }]
		},
		CONCAT: {
			method: "concat",
			parameters: [{ argumentType: FunctionArgumentType.ANY }],
			repeatLastArgs: 1,
			enableArrayArithmeticForArguments: true,
			vectorizationForbidden: true
		},
		TEXTBEFORE: { method: "textbefore", ...PIECES },
		TEXTAFTER: { method: "textafter", ...PIECES },
		TEXTSPLIT: {
			method: "textsplit",
			parameters: [
				{ argumentType: FunctionArgumentType.STRING },
				{ argumentType: FunctionArgumentType.ANY, optionalArg: true, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.ANY, optionalArg: true, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.BOOLEAN, defaultValue: false, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.INTEGER, defaultValue: 0, emptyAsDefault: true },
				{ argumentType: FunctionArgumentType.SCALAR, optionalArg: true, emptyAsDefault: true }
			],
			vectorizationForbidden: true
		},
		NUMBERVALUE: {
			method: "numbervalue",
			parameters: [
				{ argumentType: FunctionArgumentType.STRING },
				{ argumentType: FunctionArgumentType.STRING, optionalArg: true },
				{ argumentType: FunctionArgumentType.STRING, optionalArg: true }
			]
		},
		DOLLAR: {
			method: "dollar",
			parameters: [{ argumentType: FunctionArgumentType.NUMBER }, { argumentType: FunctionArgumentType.NUMBER, defaultValue: 2 }]
		},
		FIXED: {
			method: "fixed",
			parameters: [
				{ argumentType: FunctionArgumentType.NUMBER },
				{ argumentType: FunctionArgumentType.NUMBER, defaultValue: 2 },
				{ argumentType: FunctionArgumentType.BOOLEAN, defaultValue: false }
			]
		}
	}

	private get formatOptions(): NumFmtOptions {
		const base = dateBaseOf(this.config)

		return base === true ? OPTIONS_1904 : base === ISO_1900 ? OPTIONS_ISO_1900 : OPTIONS_1900
	}

	// TEXT(value, format_text): the value as the number format shows it (support.microsoft.com "TEXT function"),
	// through the same format engine the cells use: a number, or text that reads as one, through its number
	// section; other text through the text section. No fill: a "*" repeat shows nothing. A date the format
	// cannot show is #VALUE!.
	text(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("TEXT"), (value: PluginScalar, code: string) => {
			if (value instanceof CellError) return value
			if (code === "") return ""
			if (typeof value === "boolean") return value ? "TRUE" : "FALSE"

			let number = value === EmptyValue ? 0 : rawNumber(value)

			if (number === undefined && typeof value === "string") {
				const read = this.arithmeticHelper.coerceToMaybeNumber(value)

				number = read === undefined ? undefined : rawNumber(read)
			}

			const shown = formatValue(number ?? (typeof value === "string" ? value : ""), code, this.formatOptions)

			return shown.text === "" && shown.repeat?.char === "#" ? valueError() : shown.text
		})
	}

	// CONCAT(text1, ...): the texts one after the other, a range's or array's cells row by row.
	concat(ast: PluginCall, state: PluginState): unknown {
		if (ast.args.length === 0) return naError()

		let out = ""

		for (const arg of ast.args) {
			for (const value of flatten(rowsOf(this.evaluateAst(arg, state)))) {
				const text = textOf(value)

				if (text instanceof CellError) return text

				out += text

				if (out.length > MAX_TEXT) return valueError()
			}
		}

		return out
	}

	// TEXTBEFORE and TEXTAFTER(text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found])
	// (support.microsoft.com): the text before or after the instance_num-th delimiter (from the end when negative),
	// any of several delimiters, without regard to case for match_mode 1; match_end 1 counts the end (from the start)
	// or the start (from the end) as one more delimiter. #N/A (or if_not_found) when there is no such delimiter.
	private piece(ast: PluginCall, state: PluginState, before: boolean): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata(before ? "TEXTBEFORE" : "TEXTAFTER"),
			(
				text: string,
				delimiter: PluginValue,
				instance: number,
				matchMode: number,
				matchEnd: number,
				notFound: PluginScalar | undefined
			) => {
				const delimiters = delimitersOf(delimiter)

				if (delimiters instanceof CellError) return delimiters
				if (
					instance === 0 ||
					Math.abs(instance) > text.length + 1 ||
					(matchMode !== 0 && matchMode !== 1) ||
					(matchEnd !== 0 && matchEnd !== 1)
				)
					return valueError()

				const fromEnd = instance < 0
				const wanted = Math.abs(instance)
				let found: Occurrence | undefined

				if (delimiters.some(item => item === "")) found = fromEnd ? { start: text.length, end: text.length } : { start: 0, end: 0 }
				else {
					const all = occurrences(text, delimiters, matchMode === 1, fromEnd)

					if (matchEnd === 1) all.push(fromEnd ? { start: 0, end: 0 } : { start: text.length, end: text.length })

					found = all[wanted - 1]
				}

				if (found === undefined) return notFound ?? naError()

				return before ? text.slice(0, found.start) : text.slice(found.end)
			}
		)
	}

	textbefore(ast: PluginCall, state: PluginState): unknown {
		return this.piece(ast, state, true)
	}

	textafter(ast: PluginCall, state: PluginState): unknown {
		return this.piece(ast, state, false)
	}

	// TEXTSPLIT(text, col_delimiter, [row_delimiter], [ignore_empty], [match_mode], [pad_with]): the pieces as an
	// array, rows split by row_delimiter and each row by col_delimiter; short rows padded with pad_with (#N/A).
	textsplit(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("TEXTSPLIT"),
			(
				text: string,
				columns: PluginValue | undefined,
				rows: PluginValue | undefined,
				ignoreEmpty: boolean,
				matchMode: number,
				pad: PluginScalar | undefined
			) => {
				const columnDelimiters = columns === undefined || columns === EmptyValue ? [] : delimitersOf(columns)
				const rowDelimiters = rows === undefined || rows === EmptyValue ? [] : delimitersOf(rows)

				if (columnDelimiters instanceof CellError) return columnDelimiters
				if (rowDelimiters instanceof CellError) return rowDelimiters
				if (matchMode !== 0 && matchMode !== 1) return valueError()
				if (columnDelimiters.every(item => item === "") && rowDelimiters.every(item => item === "")) return valueError()

				const split = (subject: string, delimiters: readonly string[]): string[] => {
					const live = delimiters.filter(item => item !== "")

					if (live.length === 0) return [subject]

					const pieces: string[] = []
					let start = 0

					for (const occurrence of occurrences(subject, live, matchMode === 1, false)) {
						pieces.push(subject.slice(start, occurrence.start))
						start = occurrence.end
					}

					pieces.push(subject.slice(start))

					return ignoreEmpty ? pieces.filter(piece => piece !== "") : pieces
				}
				const lines = split(text, rowDelimiters).map(line => split(line, columnDelimiters))
				const width = Math.max(1, ...lines.map(line => line.length))
				const filler: PluginScalar = pad ?? naError()
				const data: PluginScalar[][] = (lines.length === 0 ? [[""]] : lines).map(line => {
					const row: PluginScalar[] = [...line]

					while (row.length < width) row.push(filler)

					return row
				})

				return SimpleRangeValue.onlyValues(data)
			}
		)
	}

	// NUMBERVALUE(text, [decimal_separator], [group_separator]): text read as a number with the given separators (the
	// first character of each; "." and "," by default): spaces left out, group separators before the decimal one
	// ignored, each "%" at the end a hundredth. "" is 0; anything else is #VALUE!.
	numbervalue(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("NUMBERVALUE"), (text: string, decimalArg?: string, groupArg?: string) => {
			const decimal = (decimalArg ?? ".").charAt(0)
			const group = (groupArg ?? ",").charAt(0)

			if (decimalArg === "" || groupArg === "" || decimal === group) return valueError()

			let body = text.replace(/\s+/g, "")
			let percent = 0

			while (body.endsWith("%")) {
				body = body.slice(0, -1)
				percent++
			}

			if (body === "") return percent > 0 ? valueError() : 0

			const point = body.indexOf(decimal)

			if (point >= 0 && body.indexOf(decimal, point + 1) >= 0) return valueError()
			if (point >= 0 && body.indexOf(group, point) >= 0) return valueError()

			const plain = (point < 0 ? body : body.slice(0, point)).split(group).join("") + (point < 0 ? "" : `.${body.slice(point + 1)}`)

			if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(plain)) return valueError()

			return Number(plain) / 100 ** percent
		})
	}

	// DOLLAR(number, [decimals]): the number as currency text, $#,##0.00_);($#,##0.00) rounded to decimals
	// (support.microsoft.com "DOLLAR function"); en-US's symbol.
	dollar(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("DOLLAR"), (number: number, decimals: number) =>
			fixedText(number, decimals, true, "$")
		)
	}

	// FIXED(number, [decimals], [no_commas]): the number rounded to decimals as text, grouped unless no_commas.
	fixed(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("FIXED"), (number: number, decimals: number, noCommas: boolean) =>
			fixedText(number, decimals, !noCommas)
		)
	}
}
