import { referenceSpans, referenceText, type RefArea, type ReferenceSpan } from "../refs/formulaRefs"
import { ARGUMENT_LABELS, sheetFunctions, type ArgumentId, type SheetFunction } from "./catalogue"
import { skipQuoted } from "../refs/scan"

// What the formula being typed offers at the caret, from its text alone (no engine): the function names a word
// could become (autocomplete), the call the caret is in and which argument (signature help), whether a click on a
// cell would put a reference there (pointing, as Excel's Point mode), and the references to highlight. The text
// is the whole entry, its "=" included; the caret an offset into it. `separator` is the argument separator the user
// types ("," or ";", from the locale).

const QUOTE = 34
const APOSTROPHE = 39
const BRACKET_OPEN = 91
const BRACKET_CLOSE = 93

export interface FormulaWord {
	readonly start: number
	readonly end: number
	readonly text: string
}

export interface FormulaCall {
	// Upper case, without a file's _xlfn. prefix.
	readonly name: string
	// The open parenthesis.
	readonly open: number
	// The argument the caret is in, from 0.
	readonly argument: number
}

export interface FormulaContext {
	// The name typed up to the caret, when it may be a function's.
	readonly word: FormulaWord | null
	readonly call: FormulaCall | null
	// A click on a cell would put its reference at the caret.
	readonly points: boolean
}

function isNameStart(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code > 127
}

function isNameChar(code: number): boolean {
	return isNameStart(code) || (code >= 48 && code <= 57) || code === 46
}

// Characters after which a reference may start: an operator, a separator, an open parenthesis or the "=".
const POINT_AFTER = new Set(["=", "(", "+", "-", "*", "/", "^", "&", "<", ">", ":", "{", "%"])

// The context at `caret`, or null when the entry is no formula.
export function formulaContext(text: string, caret: number, separator = ","): FormulaContext | null {
	if (!text.startsWith("=")) return null

	const end = Math.max(1, Math.min(caret, text.length))
	const calls: { name: string; open: number; argument: number; braces: number }[] = []
	let braces = 0
	let index = 1
	let pendingName = ""

	// Up to the caret: strings, quoted sheet names and structured references skipped; calls stacked.
	while (index < end) {
		const code = text.charCodeAt(index)

		if (code === QUOTE || code === APOSTROPHE) {
			const close = skipQuoted(text, index, code)

			// The caret inside a string or a quoted sheet name: nothing to offer.
			if (close > end || (close === text.length && text.charCodeAt(close - 1) !== code)) {
				const open = calls.at(-1)

				return {
					word: null,
					call: open === undefined ? null : { name: open.name, open: open.open, argument: open.argument },
					points: false
				}
			}

			index = close
			pendingName = ""
			continue
		}

		if (code === BRACKET_OPEN) {
			let depth = 0

			while (index < end) {
				const inner = text.charCodeAt(index)

				if (inner === BRACKET_OPEN) depth++
				else if (inner === BRACKET_CLOSE && --depth === 0) break

				index++
			}

			index++
			pendingName = ""
			continue
		}

		if (isNameStart(code)) {
			const start = index

			while (index < text.length && isNameChar(text.charCodeAt(index))) index++

			pendingName = text.slice(start, Math.min(index, end))

			if (index > end) index = end

			continue
		}

		if (code === 40) {
			calls.push({ name: pendingName.replace(/^(?:_xlfn\.|_xlws\.)+/i, "").toUpperCase(), open: index, argument: 0, braces })
		} else if (code === 41) {
			calls.pop()
		} else if (code === 123) braces++
		else if (code === 125) braces = Math.max(0, braces - 1)
		else if (text[index] === separator) {
			const call = calls.at(-1)

			if (call !== undefined && call.braces === braces) call.argument++
		}

		pendingName = ""
		index++
	}

	const top = calls.at(-1)
	const call = top === undefined || top.name === "" ? null : { name: top.name, open: top.open, argument: top.argument }

	// The word ending at the caret.
	let start = end

	while (start > 1 && isNameChar(text.charCodeAt(start - 1))) start--

	while (start < end && !isNameStart(text.charCodeAt(start))) start++

	const word =
		start < end && text.charCodeAt(end) !== 40 && !isNameChar(text.charCodeAt(end)) && text.charCodeAt(start - 1) !== 33
			? { start, end, text: text.slice(start, end) }
			: null

	let before = end - 1

	while (before > 0 && text[before] === " ") before--

	const last = text[before] ?? ""

	return { word, call, points: POINT_AFTER.has(last) || last === separator || (before === 0 && last === "=") }
}

// The functions whose name starts with `prefix` (without regard to case), in alphabetical order; at most `limit`.
export function functionSuggestions(prefix: string, limit = 12): readonly SheetFunction[] {
	const upper = prefix.toUpperCase()

	if (upper === "") return []

	const out: SheetFunction[] = []

	for (const entry of sheetFunctions()) {
		if (!entry.name.startsWith(upper)) continue

		out.push(entry)

		if (out.length >= limit) break
	}

	return out
}

// The entry with `word` replaced by the function's name and an open parenthesis, the caret after it.
export function acceptSuggestion(text: string, word: FormulaWord, name: string): { readonly text: string; readonly caret: number } {
	const insert = `${name}(`
	const rest = text.slice(word.end)
	const skip = rest.startsWith("(") ? 1 : 0

	return { text: text.slice(0, word.start) + insert + rest.slice(skip), caret: word.start + insert.length }
}

export interface SignaturePart {
	// English, an optional argument in brackets: what shows where the app has no translation of the label.
	readonly text: string
	// The argument this part names (its index in the call), when it names one.
	readonly argument?: number
	// That argument's catalogue id, which keys its label for translation, and whether it is optional.
	readonly id?: ArgumentId
	readonly optional?: boolean
}

// A function's syntax as signature help shows it: NAME(first, [second], ...) with each argument's label, split so
// the argument the caret is in (argumentAt) can be marked.
export function signatureParts(entry: SheetFunction, separator = ","): readonly SignaturePart[] {
	const parts: SignaturePart[] = [{ text: `${entry.name}(` }]
	const between = separator === ";" ? "; " : ", "

	entry.args.forEach((arg, index) => {
		if (index > 0) parts.push({ text: between })

		const label = ARGUMENT_LABELS[arg.id]

		parts.push({ text: arg.optional ? `[${label}]` : label, argument: index, id: arg.id, optional: arg.optional })
	})

	if (entry.args.some(arg => arg.repeats)) parts.push({ text: `${between}…` })

	parts.push({ text: ")" })

	return parts
}

// Which of a function's catalogue arguments a call's n-th argument is: past the last, the repeating group again;
// -1 when the function takes no more.
export function argumentAt(entry: SheetFunction, argument: number): number {
	if (argument < entry.args.length) return argument
	if (argument >= entry.maxArgs) return -1

	const group = entry.args.filter(arg => arg.repeats).length

	if (group === 0) return -1

	const first = entry.args.length - group

	return first + ((argument - first) % group)
}

// The entry with a reference put at the caret, or over `replacing` (the reference the same pointing put there a
// moment ago, which a further click or drag moves), the caret after it.
export function insertReference(
	text: string,
	caret: number,
	reference: string,
	replacing?: { readonly start: number; readonly end: number }
): { readonly text: string; readonly caret: number; readonly span: { readonly start: number; readonly end: number } } {
	const start = replacing?.start ?? caret
	const end = replacing?.end ?? caret
	const next = text.slice(0, start) + reference + text.slice(end)

	return { text: next, caret: start + reference.length, span: { start, end: start + reference.length } }
}

// A cell or range as a pointed reference: relative, behind its sheet's name when it is on another sheet.
export function pointedReference(area: RefArea, sheet: string | null): string {
	return referenceText(area, sheet)
}

export interface HighlightedReference extends ReferenceSpan {
	// Which of the highlight colours: one per distinct reference text, in the order they first appear.
	readonly color: number
}

// The references of an entry to highlight while it is typed (its "=" included in the offsets), each with its colour.
export function highlightedReferences(text: string, colors: number): readonly HighlightedReference[] {
	if (!text.startsWith("=") || colors <= 0) return []

	const seen = new Map<string, number>()

	return referenceSpans(text.slice(1)).map(span => {
		const key = text
			.slice(span.start + 1, span.end + 1)
			.replaceAll("$", "")
			.toUpperCase()
		let color = seen.get(key)

		if (color === undefined) {
			color = seen.size % colors
			seen.set(key, color)
		}

		return { ...span, start: span.start + 1, end: span.end + 1, color }
	})
}
