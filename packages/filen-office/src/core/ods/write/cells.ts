import type { SheetRange } from "../../sheet/protocol"
import { decodeXstring } from "../../xlsx/model/strings"
import type { SheetStore } from "../../xlsx/model/store"
import { CellKind, FormulaKind, type XlsxRichRun, type XlsxSharedStrings } from "../../xlsx/model/types"
import { escapeAttribute, escapeText } from "../../xml/index"
import { OdfNs } from "../../odf/namespaces"
import { canonicalFormula, openFormula } from "../formula/toOf"
import { dateValue, durationValue } from "../read/values"

// A cell as the writer compares and writes it: its value in one of a few kinds (text however the store keeps it),
// its format, and its formula. Two cells equal here read back the same.

export const Value = {
	EMPTY: 0,
	NUMBER: 1,
	TEXT: 2,
	// Text with runs of their own fonts.
	RICH: 3,
	BOOLEAN: 4,
	ERROR: 5
} as const

export type Value = (typeof Value)[keyof typeof Value]

export interface CellValue {
	readonly value: Value
	readonly number: number
	readonly text: string
	readonly runs: readonly XlsxRichRun[] | null
	readonly xf: number
	readonly formula: string | null
	// An array formula's range, anchored at this cell.
	readonly matrix: SheetRange | null
}

export const EMPTY_CELL: CellValue = { value: Value.EMPTY, number: 0, text: "", runs: null, xf: 0, formula: null, matrix: null }

export class CellRefused extends Error {
	readonly detail: string

	constructor(detail: string) {
		super(`A cell cannot be written: ${detail}`)
		this.detail = detail
	}
}

function plainRuns(runs: readonly XlsxRichRun[] | null): boolean {
	return runs === null || runs.every(run => run.font === null)
}

// The value a store slot holds, with `shown` a result the session shows for a formula the file keeps none of.
export function storeValue(
	store: SheetStore,
	shared: XlsxSharedStrings,
	slot: number,
	xf: number,
	shown: { readonly value: number | string | boolean | null; readonly error: boolean } | undefined
): CellValue {
	const kind = store.kind(slot)
	const raw = store.value(slot)
	const formulaId = store.formula(slot)
	let formula: string | null = null
	let matrix: SheetRange | null = null

	if (formulaId >= 0) {
		const formulas = store.formulas
		const formulaKind = formulas.kind(formulaId)

		if (formulaKind === FormulaKind.SHARED_CHILD || formulaKind === FormulaKind.SHARED_MASTER || formulaKind === FormulaKind.DATA_TABLE)
			throw new CellRefused("shared formula")

		formula = formulas.text(formulaId)

		if (formulaKind === FormulaKind.ARRAY) matrix = formulas.formula(formulaId).ref
	}

	if (shown !== undefined && shown.value !== null) {
		const value = shown.value

		if (shown.error) return { value: Value.ERROR, number: 0, text: String(value), runs: null, xf, formula, matrix }
		if (typeof value === "number") return { value: Value.NUMBER, number: value, text: "", runs: null, xf, formula, matrix }
		if (typeof value === "boolean") return { value: Value.BOOLEAN, number: value ? 1 : 0, text: "", runs: null, xf, formula, matrix }

		return { value: Value.TEXT, number: 0, text: value, runs: null, xf, formula, matrix }
	}

	switch (kind) {
		case CellKind.NUMBER:
			return { value: Value.NUMBER, number: raw, text: "", runs: null, xf, formula, matrix }
		case CellKind.BOOLEAN:
			return { value: Value.BOOLEAN, number: raw === 0 ? 0 : 1, text: "", runs: null, xf, formula, matrix }
		case CellKind.SHARED_STRING: {
			const runs = shared.runs(raw)
			const text = decodeXstring(shared.text(raw))

			return plainRuns(runs)
				? { value: Value.TEXT, number: 0, text, runs: null, xf, formula, matrix }
				: {
						value: Value.RICH,
						number: 0,
						text,
						runs: (runs ?? []).map(run => ({ ...run, text: decodeXstring(run.text) })),
						xf,
						formula,
						matrix
					}
		}
		case CellKind.INLINE_STRING:
		case CellKind.FORMULA_STRING:
			return { value: Value.TEXT, number: 0, text: decodeXstring(store.strings.text(raw)), runs: null, xf, formula, matrix }
		case CellKind.ERROR:
			return { value: Value.ERROR, number: 0, text: store.strings.text(raw), runs: null, xf, formula, matrix }
		case CellKind.EMPTY:
			return { value: Value.EMPTY, number: 0, text: "", runs: null, xf, formula, matrix }
		default:
			throw new CellRefused("a date written as text")
	}
}

function sameFont(a: XlsxRichRun["font"], b: XlsxRichRun["font"]): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

function sameRuns(a: readonly XlsxRichRun[] | null, b: readonly XlsxRichRun[] | null): boolean {
	if (a === null || b === null) return a === b
	if (a.length !== b.length) return false

	return a.every((run, k) => run.text === b[k]?.text && sameFont(run.font, b[k]?.font ?? null))
}

function sameMatrix(a: SheetRange | null, b: SheetRange | null): boolean {
	if (a === null || b === null) return a === b

	return a.startRow - a.endRow === b.startRow - b.endRow && a.startCol - a.endCol === b.startCol - b.endCol
}

// What a cell holds, its format aside.
// An error constant written as a strict document holds one: a formula of that error alone (ODF 1.3 Part 4 §5.12),
// which LibreOffice 7.5 reads as the same error (ERROR.TYPE alike). #NULL! it reads otherwise, and Excel's newer
// errors (#SPILL!, #CALC!, ...) it does not know.
export const STRICT_ERRORS: ReadonlySet<string> = new Set(["#N/A", "#DIV/0!", "#NAME?", "#NUM!", "#REF!", "#VALUE!"])

// An error constant, or the formula of that error alone it is written as in a strict document.
function errorConstant(cell: CellValue): string | null {
	if (cell.value !== Value.ERROR) return null
	if (cell.formula === null || cell.formula === "") return cell.text

	return cell.formula.replace(/^=/u, "") === cell.text ? cell.text : null
}

export function sameContent(a: CellValue, b: CellValue): boolean {
	const constant = errorConstant(a)

	if (constant !== null && constant === errorConstant(b) && ((a.formula ?? "") === "") !== ((b.formula ?? "") === "")) return true
	if (a.value !== b.value || !sameMatrix(a.matrix, b.matrix)) return false
	if ((a.formula === null) !== (b.formula === null)) return false
	if (a.formula !== null && b.formula !== null && a.formula !== b.formula && canonicalFormula(a.formula) !== canonicalFormula(b.formula))
		return false

	switch (a.value) {
		case Value.NUMBER:
		case Value.BOOLEAN:
			return Object.is(a.number, b.number) || a.number === b.number
		case Value.TEXT:
		case Value.ERROR:
			return a.text === b.text
		case Value.RICH:
			return a.text === b.text && sameRuns(a.runs, b.runs)
		default:
			return true
	}
}

// --- Writing ---

// Text for a text:p (ODF 1.3 Part 3 §6.1.2): its white space as elements where collapsing would lose it.
export function paragraphText(text: string): string {
	let out = ""
	let k = 0

	while (k < text.length) {
		const c = text[k] ?? ""

		if (c === "\t") {
			out += "<text:tab/>"
			k++
		} else if (c === " ") {
			let n = k

			while (text[n] === " ") n++

			const count = n - k
			// A single space between words is itself; the first space of a run inside the text stays as text, the
			// rest (and any space at either end) become text:s.
			const inner = k > 0 && n < text.length
			const literal = inner ? 1 : 0

			if (literal === 1) out += " "
			if (count - literal > 0) out += count - literal === 1 ? "<text:s/>" : `<text:s text:c="${count - literal}"/>`

			k = n
		} else {
			const code = c.charCodeAt(0)

			if ((code < 0x20 && code !== 0x0a) || code === 0xfffe || code === 0xffff) throw new CellRefused("a control character")

			let n = k

			while (n < text.length && text[n] !== " " && text[n] !== "\t") n++

			out += escapeText(text.slice(k, n))
			k = n
		}
	}

	return out
}

// Past the text:tab or text:s element (as paragraphText writes them) starting at `at`, -1 for none there.
function whiteSpaceElementEnd(body: string, at: number): number {
	if (!body.startsWith("<text:", at)) return -1

	const name = body.startsWith("tab", at + 6) ? at + 9 : body.startsWith("s", at + 6) ? at + 7 : -1

	if (name < 0 || /\w/.test(body.charAt(name))) return -1

	const close = body.indexOf(">", name)

	return close < 0 || body[close - 1] !== "/" ? -1 : close + 1
}

// Body markup split as [leading white space elements, the rest, trailing ones]: two linear walks, one from each end.
export function whiteSpaceEdges(body: string): readonly [string, string, string] {
	let start = 0

	for (let next = whiteSpaceElementEnd(body, 0); next >= 0; next = whiteSpaceElementEnd(body, start)) start = next

	let end = body.length

	while (end > start) {
		const open = body.lastIndexOf("<", end - 1)

		if (open < start || whiteSpaceElementEnd(body, open) !== end) break

		end = open
	}

	return [body.slice(0, start), body.slice(start, end), body.slice(end)]
}

// Lines of text as text:p elements, each line's runs as text:span with their text styles, each line's text inside
// the cell's link when it has one.
export function paragraphs(
	text: string,
	runs: readonly { readonly text: string; readonly style: string | undefined }[] | null,
	link?: string
): string {
	// A link is a field of the text it holds: around spans LibreOffice reads it without their text, and it drops the
	// white space elements a field starts or ends with, so those stay outside it.
	const linked = (body: string): string => {
		if (link === undefined || body === "") return body

		const [lead, inner, trail] = whiteSpaceEdges(body)

		return `${lead}${inner === "" ? "" : `<text:a xlink:href="${escapeAttribute(link)}" xlink:type="simple">${inner}</text:a>`}${trail}`
	}
	const paragraph = (line: string): string => `<text:p>${linked(line)}</text:p>`

	if (runs === null)
		return text
			.split("\n")
			.map(line => paragraph(paragraphText(line)))
			.join("")

	const lines: string[] = [""]

	for (const run of runs) {
		const parts = run.text.split("\n")

		parts.forEach((part, k) => {
			if (k > 0) lines.push("")
			if (part === "") return

			const body = linked(paragraphText(part))

			lines[lines.length - 1] +=
				run.style === undefined ? body : `<text:span text:style-name="${escapeAttribute(run.style)}">${body}</text:span>`
		})
	}

	return lines.map(line => `<text:p>${line}</text:p>`).join("")
}

function pad(value: number, width = 2): string {
	return String(value).padStart(width, "0")
}

// A serial number as an xsd:dateTime from the null date (`nullDate`: its days since 1970-01-01), when it reads back
// as the same number; undefined otherwise (written as a float, which shows the same through the data style).
export function dateText(serial: number, nullDate: number): string | undefined {
	const total = serial + nullDate
	const days = Math.floor(total)
	const seconds = Math.round((total - days) * 86_400)

	if (seconds >= 86_400) return undefined

	// Days since 1970-01-01 to a civil date (proleptic Gregorian).
	const z = days + 719_468
	const era = Math.floor(z / 146_097)
	const doe = z - era * 146_097
	const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365)
	const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
	const mp = Math.floor((5 * doy + 2) / 153)
	const day = doy - Math.floor((153 * mp + 2) / 5) + 1
	const month = mp < 10 ? mp + 3 : mp - 9
	const year = yoe + era * 400 + (month <= 2 ? 1 : 0)

	if (year < 0 || year > 9999) return undefined

	const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`
	const text =
		seconds === 0 ? date : `${date}T${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`

	return dateValue(text) - nullDate === serial ? text : undefined
}

// A fraction of days as an xsd:duration, when it reads back as the same number.
export function durationText(days: number): string | undefined {
	const negative = days < 0
	const seconds = Math.round(Math.abs(days) * 86_400)
	const text = `${negative ? "-" : ""}PT${Math.floor(seconds / 3600)}H${pad(Math.floor((seconds % 3600) / 60))}M${pad(seconds % 60)}S`

	return durationValue(text) === days ? text : undefined
}

export type NumberKind = "float" | "percentage" | "date" | "time"

export interface CellParts {
	readonly styleName: string | undefined
	readonly repeat: number
	readonly colSpan: number
	readonly rowSpan: number
	readonly covered: boolean
	readonly validation: string | undefined
	// The source's table:formula when the formula is the one the source held: written as it was.
	readonly sourceFormula: string | undefined
	// What the number shows (text:p), and how its type is written.
	readonly shown: string
	readonly numberKind: NumberKind
	readonly nullDate: number
	// The document declares LibreOffice's calcext namespace, so is already an extended document (ODF 1.3 Part 3
	// §2.2.2, foreign attributes §3.17): an error result is marked with calcext:value-type. A conforming one (§2.2.1)
	// stays conforming: a formula's error result is written as a number with the error's text, which reads back as
	// the error and is calculated again. In both, an error constant is a formula of that error alone (STRICT_ERRORS),
	// the errors with no such form refused.
	readonly calcext: boolean
	// Runs' text styles, by run.
	readonly runStyles: readonly (string | undefined)[] | null
	readonly note: string | undefined
	readonly link: string | undefined
	// Children of the source cell the model does not hold (shapes anchored to it), kept.
	readonly kept: string
	// The source's table:formula of a cell whose formula the model does not hold (only its result): kept with the
	// result when the cell is written again for its format, a note, a link or a merge.
	readonly keptFormula?: string | undefined
}

export function declaresCalcext(prefixes: ReadonlyMap<string, string>): boolean {
	for (const uri of prefixes.values()) if (uri === OdfNs.calcext) return true

	return false
}

// One table:table-cell (or table:covered-table-cell) element.
export function cellMarkup(cell: CellValue, parts: CellParts): string {
	const tag = parts.covered ? "table:covered-table-cell" : "table:table-cell"
	let attributes = ""

	if (parts.styleName !== undefined) attributes += ` table:style-name="${escapeAttribute(parts.styleName)}"`
	if (parts.repeat > 1) attributes += ` table:number-columns-repeated="${parts.repeat}"`
	if (parts.validation !== undefined) attributes += ` table:content-validation-name="${escapeAttribute(parts.validation)}"`
	if (!parts.covered && parts.colSpan > 1) attributes += ` table:number-columns-spanned="${parts.colSpan}"`
	if (!parts.covered && parts.rowSpan > 1) attributes += ` table:number-rows-spanned="${parts.rowSpan}"`

	const kept = cell.formula === null ? parts.keptFormula : undefined

	if (kept !== undefined) attributes += ` table:formula="${escapeAttribute(kept)}"`

	if (cell.formula !== null) {
		let source = parts.sourceFormula

		if (source === undefined) {
			const written = openFormula(cell.formula)

			if ("refused" in written) throw new CellRefused(`formula: ${written.refused}`)

			source = written.text
		}

		attributes += ` table:formula="${escapeAttribute(source)}"`

		if (cell.matrix !== null) {
			attributes += ` table:number-matrix-columns-spanned="${cell.matrix.endCol - cell.matrix.startCol + 1}"`
			attributes += ` table:number-matrix-rows-spanned="${cell.matrix.endRow - cell.matrix.startRow + 1}"`
		}
	}

	let body = ""

	switch (cell.value) {
		case Value.NUMBER: {
			const kind = parts.numberKind
			const date = kind === "date" ? dateText(cell.number, parts.nullDate) : undefined
			const time = kind === "time" ? durationText(cell.number) : undefined

			if (date !== undefined) attributes += ` office:value-type="date" office:date-value="${date}"`
			else if (time !== undefined) attributes += ` office:value-type="time" office:time-value="${time}"`
			else
				attributes += ` office:value-type="${kind === "percentage" ? "percentage" : "float"}" office:value="${numberText(cell.number)}"`

			body = paragraphs(parts.shown, null, parts.link)
			break
		}
		case Value.BOOLEAN:
			attributes += ` office:value-type="boolean" office:boolean-value="${cell.number === 0 ? "false" : "true"}"`
			body = paragraphs(cell.number === 0 ? "FALSE" : "TRUE", null, parts.link)
			break
		case Value.ERROR:
			// An error with no formula of its own is that error's formula alone, as LibreOffice writes one: it reads
			// calcext:value-type only on a formula cell, and shows any other cell's value (0).
			if (kept === undefined && (cell.formula === null || cell.formula === "")) {
				if (!STRICT_ERRORS.has(cell.text)) throw new CellRefused("errorValue")

				attributes += ` table:formula="${escapeAttribute(`of:=${cell.text}`)}"`
			}

			attributes += ` office:value-type="float" office:value="0"${parts.calcext ? ' calcext:value-type="error"' : ""}`
			body = paragraphs(cell.text, null, parts.link)
			break
		case Value.TEXT:
			attributes += ' office:value-type="string"'

			// A formula's text result exactly (its text:p collapses white space); typed text is its paragraphs, but for
			// text starting with "#", which LibreOffice 7.5 takes for an error's name where no string value says it is text
			// (and aborts on one it does not know, such as "#" alone).
			if (cell.formula !== null || kept !== undefined || cell.text.startsWith("#"))
				attributes += ` office:string-value="${escapeAttribute(cell.text)}"`

			body = paragraphs(cell.text, null, parts.link)
			break
		case Value.RICH: {
			attributes += ' office:value-type="string"'

			const runs = (cell.runs ?? []).map((run, k) => ({ text: run.text, style: parts.runStyles?.[k] }))

			body = paragraphs(cell.text, runs, parts.link)
			break
		}
		default:
			break
	}

	// A link on a cell without text: on an empty paragraph (the reader takes a cell's first text:a, §6.1.8).
	if (body === "" && parts.link !== undefined)
		body = `<text:p><text:a xlink:href="${escapeAttribute(parts.link)}" xlink:type="simple"/></text:p>`

	const content = (parts.note ?? "") + body + parts.kept

	return content === "" ? `<${tag}${attributes}/>` : `<${tag}${attributes}>${content}</${tag}>`
}

// A number as office:value (xsd:double): the shortest text that reads back as it.
export function numberText(value: number): string {
	if (Number.isNaN(value)) return "NaN"
	if (!Number.isFinite(value)) return value > 0 ? "INF" : "-INF"

	return String(value)
}
