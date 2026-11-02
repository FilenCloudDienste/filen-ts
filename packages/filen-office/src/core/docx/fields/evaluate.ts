import { appendAll, spliceAll } from "../../arrays"
import type { Mark, MarkType, Node } from "prosemirror-model"
import { NO_SOURCE, docxSchema } from "../edit/schema"
import type { DocxEditorSession } from "../edit/session"
import type { PagedEditor } from "../paged/editor"
import type { PagedGeometry } from "../paged/geometry"
import { numberSwitchFormat, numberText } from "../layout/fields"
import { BreakType, FieldCharType, Item, RevisionView, TRANSPARENT, type StoryPart } from "../model/index"
import { Ns } from "../model/namespaces"
import { NumberingCounters, formatNumber, type Numbering } from "../numbering/index"
import { languageTag, pictureDate } from "../forms/dates"
import { bookmarkIndex, type DocxBookmark } from "./bookmarks"
import type { FieldUpdate } from "./result"

// Field codes and what updating a field computes (ECMA-376 Part 1 §17.16): the instruction parsed into its
// type, arguments and switches (§17.16.1), the general formatting switches \* (§17.16.4.3), numeric pictures
// \# (§17.16.4.2) and date-time pictures \@ (§17.16.4.1), and the results of the fields an update recomputes
// from the document as laid out: PAGE, NUMPAGES, SECTIONPAGES, SECTION, DATE, TIME, REF, PAGEREF and SEQ.
// Every other field keeps the result Word stored (Word itself cannot compute most of them without data
// outside the file). Updates are explicit (Word's F9, Update Field, Update Table), never per keystroke.

const nodes = docxSchema.nodes

// ---- field codes ------------------------------------------------------------------------------------------

export interface FieldSwitch {
	// The switch character: "*", "#", "@", "!" or a letter as written.
	readonly name: string
	readonly arg: string | undefined
}

export interface FieldCode {
	// Upper case ("PAGEREF"); "" when the instruction is empty.
	readonly type: string
	readonly args: readonly string[]
	readonly switches: readonly FieldSwitch[]
}

// Field-specific switches that take an argument, per field type (the general ones always do).
const ARGUMENT_SWITCHES: Readonly<Record<string, string>> = {
	TOC: "abcdflnopst",
	SEQ: "rs",
	REF: "d",
	HYPERLINK: "lmot",
	STYLEREF: "",
	PAGEREF: "",
	NOTEREF: "",
	DATE: "",
	TIME: ""
}

interface Token {
	readonly value: string
	readonly quoted: boolean
	readonly switch: boolean
}

function tokenize(instruction: string): Token[] {
	const out: Token[] = []
	const length = instruction.length
	let at = 0

	while (at < length) {
		const char = instruction[at] ?? ""

		if (/\s/.test(char)) {
			at++

			continue
		}

		if (char === '"') {
			let value = ""

			at++

			while (at < length && instruction[at] !== '"') {
				const next = instruction[at + 1]

				// Inside quotes a backslash escapes a quote or a backslash (§17.16.1).
				if (instruction[at] === "\\" && (next === '"' || next === "\\")) {
					value += next
					at += 2
				} else {
					value += instruction[at] ?? ""
					at++
				}
			}

			at++
			out.push({ value, quoted: true, switch: false })

			continue
		}

		if (char === "\\" && at + 1 < length) {
			out.push({ value: instruction[at + 1] ?? "", quoted: false, switch: true })
			at += 2

			continue
		}

		let end = at

		while (end < length && !/\s/.test(instruction[end] ?? "")) end++

		out.push({ value: instruction.slice(at, end), quoted: false, switch: false })
		at = end
	}

	return out
}

const CODES = new Map<string, FieldCode>()

export function parseFieldCode(instruction: string): FieldCode {
	const cached = CODES.get(instruction)

	if (cached !== undefined) return cached

	const tokens = tokenize(instruction)
	const first = tokens[0]
	const type = first === undefined || first.switch ? "" : first.value.toUpperCase()
	const own = ARGUMENT_SWITCHES[type] ?? ""
	const args: string[] = []
	const switches: FieldSwitch[] = []

	for (let index = type === "" ? 0 : 1; index < tokens.length; index++) {
		const token = tokens[index] as Token

		if (!token.switch) {
			args.push(token.value)

			continue
		}

		const name = token.value
		const next = tokens[index + 1]
		const takes = name === "*" || name === "#" || name === "@" || own.includes(name.toLowerCase())

		if (takes && next !== undefined && !next.switch) {
			switches.push({ name, arg: next.value })
			index++
		} else {
			switches.push({ name, arg: undefined })
		}
	}

	const code: FieldCode = Object.freeze({ type, args: Object.freeze(args), switches: Object.freeze(switches) })

	if (CODES.size > 4096) CODES.clear()

	CODES.set(instruction, code)

	return code
}

// A switch by its character (letters match in either case).
export function switchOf(code: FieldCode, name: string): FieldSwitch | undefined {
	const lower = name.toLowerCase()

	return code.switches.find(item => item.name.toLowerCase() === lower)
}

export function hasSwitch(code: FieldCode, name: string): boolean {
	return switchOf(code, name) !== undefined
}

// The \* arguments, in order.
function generalSwitches(code: FieldCode): string[] {
	return code.switches.filter(item => item.name === "*" && item.arg !== undefined).map(item => item.arg as string)
}

// Whether a \* MERGEFORMAT switch asks for the previous result's formatting (§17.16.4.3).
export function mergeFormat(code: FieldCode): boolean {
	return generalSwitches(code).some(name => name.toUpperCase() === "MERGEFORMAT")
}

// ---- formatting -------------------------------------------------------------------------------------------

// \* Upper, Lower, FirstCap and Caps (§17.16.4.3), applied to a result in the order written.
function caseFormat(text: string, code: FieldCode): string {
	let out = text

	for (const name of generalSwitches(code)) {
		switch (name.toLowerCase()) {
			case "upper":
				out = out.toUpperCase()

				break
			case "lower":
				out = out.toLowerCase()

				break
			case "firstcap":
				out = out.replace(/\p{L}/u, letter => letter.toUpperCase())

				break
			case "caps":
				out = out.replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_match, before: string, letter: string) => before + letter.toUpperCase())

				break
		}
	}

	return out
}

// The ST_NumberFormat of the last \* switch that formats numbers, if any.
function numberFormatOf(code: FieldCode): string | undefined {
	let format: string | undefined

	for (const name of generalSwitches(code)) format = numberSwitchFormat(name) ?? format

	return format
}

// The most decimal places Number.prototype.toFixed accepts.
const MAX_FIXED_DIGITS = 100

// Digits with a comma before every group of three from the right.
function groupThousands(digits: string): string {
	let out = digits.slice(0, digits.length % 3 || 3)

	for (let at = out.length; at < digits.length; at += 3) out += `,${digits.slice(at, at + 3)}`

	return out
}

// A number under a \# numeric picture (§17.16.4.2, as Microsoft's "Format field results" describes it): 0 a
// digit (zero when none), # a digit (a space when none), x a digit that drops the digits to its left (rounding
// to its right), "." the decimal point, "," digit grouping, "-" a minus for a negative number (else a space),
// "+" a plus or minus (a space for zero), text in single quotes and any other character as written; up to three
// sections (positive;negative;zero).
export function numericPicture(value: number, picture: string): string {
	const sections = splitUnquoted(picture, ";")
	const section =
		value < 0 && sections.length > 1
			? (sections[1] ?? "")
			: value === 0 && sections.length > 2
				? (sections[2] ?? "")
				: (sections[0] ?? "")
	const negativeSection = value < 0 && sections.length > 1
	const magnitude = Math.abs(value)
	// The section's characters outside quotes (quoted text is no placeholder), and its decimal point there.
	const quoted: boolean[] = []

	for (let at = 0, inside = false; at < section.length; at++) {
		if (section[at] === "'") inside = !inside

		quoted.push(inside || section[at] === "'")
	}

	const isCode = (at: number, chars: string): boolean => quoted[at] !== true && chars.includes(section[at] ?? "")
	let point = -1

	for (let at = 0; at < section.length && point < 0; at++) if (isCode(at, ".")) point = at

	let places = 0
	let zeros = 0
	let decimals = 0
	let optional = 0
	let truncate = -1
	let grouping = false

	for (let at = 0; at < section.length; at++) {
		if (point >= 0 && at > point) {
			if (isCode(at, "0#x")) decimals++
			if (isCode(at, "#")) optional++

			continue
		}

		if (isCode(at, "0#x")) places++
		if (isCode(at, "0")) zeros++
		if (isCode(at, "x")) truncate = places
		if (isCode(at, ",")) grouping = true
	}

	const [whole = "0", fixed = ""] = magnitude.toFixed(Math.min(decimals, MAX_FIXED_DIGITS)).split(".")
	// Places past what toFixed gives are zeros at any double's precision.
	const fraction = decimals > MAX_FIXED_DIGITS && fixed !== "" ? fixed.padEnd(decimals, "0") : fixed
	let digits = whole.replace(/^0+(?=\d)/, "")

	if (digits === "0" && zeros === 0 && decimals > 0) digits = ""

	digits = digits.padStart(zeros, "0")

	// An x keeps itself and the places after it.
	if (truncate > 0) digits = digits.slice(Math.max(0, digits.length - (places - truncate + 1)))
	if (grouping) digits = digits.replace(/\d+/g, groupThousands)

	// Places no digit fills show as spaces.
	const integer = " ".repeat(Math.max(0, places - digits.replace(/,/g, "").length)) + digits
	let fractionDigits = fraction

	// Optional trailing fraction digits (#) are dropped when zero.
	for (let k = 0; k < optional && fractionDigits.endsWith("0"); k++) fractionDigits = fractionDigits.slice(0, -1)

	let out = ""
	let integerDone = false
	let fractionDone = false
	let signDone = false

	for (let at = 0; at < section.length; at++) {
		const char = section[at] ?? ""

		if (char === "'") {
			const close = section.indexOf("'", at + 1)

			out += section.slice(at + 1, close < 0 ? section.length : close)
			at = close < 0 ? section.length : close

			continue
		}

		if ("0#x,".includes(char) && (point < 0 || at < point)) {
			if (!integerDone) {
				out += integer
				integerDone = true
			}

			continue
		}

		if (at === point) {
			if (fractionDigits !== "") out += "."

			continue
		}

		if ("0#x".includes(char)) {
			if (!fractionDone) {
				out += fractionDigits
				fractionDone = true
			}

			continue
		}

		if (char === "-" || char === "+") {
			if (!signDone && !negativeSection) out += value < 0 ? "-" : char === "+" && value > 0 ? "+" : " "

			signDone = true

			continue
		}

		out += char
	}

	if (value < 0 && !signDone && !negativeSection) out = `-${out}`

	return out
}

function splitUnquoted(text: string, separator: string): string[] {
	const out: string[] = []
	let quoted = false
	let current = ""

	for (const char of text) {
		if (char === "'") quoted = !quoted

		if (char === separator && !quoted) {
			out.push(current)
			current = ""
		} else {
			current += char
		}
	}

	out.push(current)

	return out
}

// Word's defaults when no \@ is given: the en-US short date and time.
export const DEFAULT_DATE_PICTURE = "M/d/yyyy"
export const DEFAULT_TIME_PICTURE = "h:mm am/pm"

// A date under a \@ date-time picture (§17.16.4.1), read as a date control's picture is (forms/dates.ts
// pictureDate): `date`'s local day and time, month and day names in `language` (the field's w:lang), in `calendar`
// (\h hijri, \s saka; Gregorian without), AM/PM as the user's regional settings have it. Era items (g, e, aaa) are
// the Japanese imperial calendar's in a Japanese field (`eastAsia`, its w:lang/@w:eastAsia, else `language`, is
// ja); in any other, they and B are literal characters.
export function datePicture(date: Date, picture: string, language?: string, calendar?: string, eastAsia?: string): string {
	const japanese = /^ja(?:-|$)/i.test(languageTag(eastAsia ?? language ?? "") ?? "")

	return pictureDate(
		new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())),
		{ hours: date.getHours(), minutes: date.getMinutes(), seconds: date.getSeconds() },
		picture,
		language ?? null,
		calendar ?? null,
		japanese ? "japanese" : "literal"
	)
}

// The calendar a DATE or TIME field shows its date in: \h Hijri, \s Saka (§17.16.4.1), else Gregorian.
function fieldCalendar(code: FieldCode): string | undefined {
	return hasSwitch(code, "h") ? "hijri" : hasSwitch(code, "s") ? "saka" : undefined
}

// A number result: \# picture, else a \* number format, else `fallback` (the page's own format for pages).
function numberResult(value: number, code: FieldCode, fallback?: string): string {
	const picture = switchOf(code, "#")?.arg
	const format = numberFormatOf(code)
	const text =
		picture !== undefined
			? numericPicture(value, picture)
			: format !== undefined
				? numberText(value, format)
				: (fallback ?? String(value))

	return caseFormat(text, code)
}

// ---- the document as laid out -----------------------------------------------------------------------------

export interface FieldPage {
	// The page number fields show (section restarts applied) and its text in the section's format.
	readonly number: number
	readonly numberText: string
	readonly section: number
}

// What an update reads from the laid-out pages (undefined where nothing is laid out: a headless session).
export interface FieldPages {
	readonly count: number
	page(index: number): FieldPage | undefined
	// The page holding position `pos` of `session`'s document.
	pageAt(session: DocxEditorSession, pos: number): number | undefined
	// The list number drawn before the paragraph holding `pos` ("1.2\t"), "" for none.
	markerAt(session: DocxEditorSession, pos: number): string
	sectionPages(section: number): number
}

// Where fields are updated: the body's session, every session of the document and its pages.
export interface FieldHost {
	readonly body: { readonly session: DocxEditorSession }
	readonly sessions: readonly DocxEditorSession[]
	readonly pages: FieldPages | undefined
}

// ---- headings --------------------------------------------------------------------------------------------

// A paragraph's outline level (0 for Heading 1, undefined for body text), its style's unless its own
// properties or a list may set one; most paragraphs are resolved by their style alone.
export function outlineLevels(session: DocxEditorSession): (node: Node) => number | undefined {
	const formats = session.formats
	const part = session.story.part
	const styleLevels = new Map<string | null, number | undefined>()

	return node => {
		if (node.type !== nodes.paragraph) return undefined

		const src = node.attrs["src"] as number
		const row = src === NO_SOURCE ? -1 : (part.aux[src] ?? -1)
		const pPr = row < 0 ? -1 : (part.paragraphs.pPr[row] ?? -1)

		if (node.attrs["numId"] !== null || (pPr >= 0 && part.reader.child(pPr, Ns.W, "outlineLvl") >= 0)) {
			const level = formats.paragraph(node).props.outlineLevel

			return level === undefined || level >= 9 ? undefined : level
		}

		const styleId = node.attrs["styleId"] as string | null

		if (!styleLevels.has(styleId)) {
			const style = formats.styleParagraph(styleId)

			styleLevels.set(styleId, style.props.numbering === undefined ? style.props.outlineLevel : -1)
		}

		const level = styleLevels.get(styleId)
		const resolved = level === -1 ? formats.paragraph(node).props.outlineLevel : level

		return resolved === undefined || resolved >= 9 ? undefined : resolved
	}
}

// ---- text of a range --------------------------------------------------------------------------------------

const DELETED: readonly MarkType[] = [docxSchema.marks.deletion, docxSchema.marks.move_from]

function deleted(marks: readonly Mark[]): boolean {
	return DELETED.some(type => type.isInSet(marks) !== undefined)
}

// What source items [first, last) of `part` read as in the final view, as rangeText reads the document (content
// kept as its bytes: a locked block).
export function sourceText(part: StoryPart, first: number, last: number): string {
	let out = ""
	// From inside a paragraph, the next one starts a new line.
	let paragraphs = part.kinds[first] === Item.Paragraph || part.kinds[first] === Item.Table ? 0 : 1
	let depth = 0
	let code = 0
	const codes: number[] = []

	for (let item = first; item < last;) {
		const kind = part.kinds[item] ?? 0

		if (part.hidden(item, RevisionView.Final)) {
			item = part.end(item)

			continue
		}

		switch (kind) {
			case Item.FieldChar: {
				const type = part.fieldCharType(item)

				if (type === FieldCharType.Begin) {
					codes.push(code)
					code = ++depth
				} else if (type === FieldCharType.Separate) code = codes[codes.length - 1] ?? 0
				else if (type === FieldCharType.End && depth > 0) {
					depth--
					code = codes.pop() ?? 0
				}

				break
			}
			case Item.Text:
				if (code === 0) out += part.text(item)

				break
			case Item.Tab:
			case Item.PositionalTab:
				if (code === 0) out += "\t"

				break
			case Item.Break:
				if (code === 0 && part.breakType(item) === BreakType.TextWrapping) out += "\n"

				break
			case Item.CarriageReturn:
				if (code === 0) out += "\n"

				break
			case Item.NoBreakHyphen:
				if (code === 0) out += "‑"

				break
			case Item.Symbol: {
				const char = part.aux[item] ?? -1

				if (code === 0 && char > 0 && char <= 0x10ffff) out += String.fromCodePoint(char)

				break
			}
			case Item.Paragraph:
				if (paragraphs++ > 0) out += "\n"

				break
		}

		item =
			TRANSPARENT[kind] === 1 || kind === Item.Paragraph || kind === Item.Table || kind === Item.Row || kind === Item.Cell
				? item + 1
				: part.end(item)
	}

	return out
}

// A bookmark's start and end as source items (NO_SOURCE: not in a locked block's bytes) of `part`, for the text
// of locked blocks it starts, ends or runs through.
export interface RangeSource {
	readonly part: StoryPart
	readonly start: number
	readonly end: number
}

// What [from, to) of `doc` reads as in the final view: text, tabs, breaks and field results, paragraphs
// joined by line breaks (a field result is inline content); with `source`, locked blocks too, as their bytes
// read (from the bookmark's start to its end where they are inside).
export function rangeText(doc: Node, from: number, to: number, source?: RangeSource): string {
	let out = ""
	let paragraphs = 0

	doc.nodesBetween(Math.max(0, from), Math.min(to, doc.content.size), (node, pos) => {
		if (node.isTextblock || (source !== undefined && node.type === nodes.locked_block)) {
			if (paragraphs++ > 0 && pos >= from) out += "\n"

			if (node.isTextblock) return true

			const part = (source as RangeSource).part
			const first = node.attrs["src"] as number
			const last = first >= 0 && first < part.count ? part.end(first) : first
			const start = (source as RangeSource).start
			const end = (source as RangeSource).end

			if (first >= 0 && first < part.count)
				out += sourceText(part, start > first && start < last ? start : first, end > first && end < last ? end : last)

			return false
		}

		if (!node.isInline) return !node.isAtom

		if (deleted(node.marks)) return false

		const start = Math.max(from, pos)
		const end = Math.min(to, pos + node.nodeSize)

		if (node.isText) out += (node.text ?? "").slice(start - pos, end - pos)
		else if (node.type === nodes.field) out += node.attrs["result"] as string
		else if (node.type === nodes.tab) out += "\t"
		else if (node.type === nodes.break) out += node.attrs["type"] === "textWrapping" ? "\n" : ""
		else if (node.type === nodes.symbol) out += String.fromCodePoint(node.attrs["char"] as number)
		else if (node.type === nodes.hyphen && node.attrs["soft"] !== true) out += "‑"

		return false
	})

	return out.replace(/\n+$/, "")
}

// ---- source fields ---------------------------------------------------------------------------------------

// A source field's place in its part: its row in the part's field table and the items of its characters.
export interface SourceField {
	readonly field: number
	readonly simple: boolean
	// fldChar begin, separate (-1: none) and end items; a simple field's are its w:fldSimple.
	readonly begin: number
	readonly separate: number
	readonly end: number
}

// Item kinds a rewritten result may drop (the rest of a result, a note reference or a picture, would be lost):
// runs and their text, wrappers that hold nothing else, nested fields; range markers and comment references
// are written again next to the new result.
const RESULT_KINDS: ReadonlySet<number> = new Set<number>([
	Item.Run,
	Item.Text,
	Item.DeletedText,
	Item.InstrText,
	Item.DeletedInstrText,
	Item.Tab,
	Item.Break,
	Item.CarriageReturn,
	Item.LastRenderedPageBreak,
	Item.Symbol,
	Item.SoftHyphen,
	Item.NoBreakHyphen,
	Item.FieldChar,
	Item.FieldSimple,
	Item.Insertion,
	Item.Deletion,
	Item.SmartTag,
	Item.CustomXml,
	Item.Bidi,
	Item.Hyperlink,
	Item.CommentReference,
	Item.BookmarkStart,
	Item.BookmarkEnd,
	Item.CommentRangeStart,
	Item.CommentRangeEnd,
	Item.MoveFromRangeStart,
	Item.MoveFromRangeEnd,
	Item.MoveToRangeStart,
	Item.MoveToRangeEnd,
	Item.PermissionStart,
	Item.PermissionEnd,
	Item.CustomXmlRangeMarker
])

const NESTED = new WeakMap<StoryPart, ReadonlySet<number>>()

// Fields of `part` that hold others in their instruction or result.
function nestingFields(part: StoryPart): ReadonlySet<number> {
	let set = NESTED.get(part)

	if (set === undefined) {
		const out = new Set<number>()
		const parents = part.fields.parent

		for (let field = 0; field < part.fields.count; field++) {
			const parent = parents[field] ?? -1

			if (parent >= 0) out.add(parent)
		}

		set = out
		NESTED.set(part, set)
	}

	return set
}

// The source field a field atom stands for, when a new result can be written in place of its stored one: its
// characters are where the atom's runs are (the separate in a run directly in the paragraph or wrapper that
// holds the field), it is not locked (w:fldLock), holds no other field and its result holds only what a
// rewrite may drop.
export function rewritableSource(part: StoryPart, node: Node): SourceField | undefined {
	return rewritableSourceAt(part, node.attrs["src"] as number, node.attrs["end"] as number)
}

// Whether source w:fldSimple `first` holds only what a result written anew carries (RESULT_KINDS) and no field
// of its own, whatever its lock: it can be written as the complex field it stands for (a tracked change holds
// runs only). One that cannot stays out of tracked changes (review/track.ts).
export function simpleFieldRewritable(part: StoryPart, first: number): boolean {
	if (first < 0 || first >= part.count || part.kinds[first] !== Item.FieldSimple) return false
	if (nestingFields(part).has(part.aux[first] ?? -1)) return false

	for (let item = first + 1; item < part.end(first); item++) if (!RESULT_KINDS.has(part.kinds[item] ?? 0)) return false

	return true
}

// The same for the source field of items `first` to `last`.
export function rewritableSourceAt(part: StoryPart, first: number, last: number): SourceField | undefined {
	if (first === NO_SOURCE || first < 0 || first >= part.count) return undefined

	const simple = part.kinds[first] === Item.FieldSimple
	const field = simple ? (part.aux[first] ?? -1) : part.fieldOf(first + 1)

	if (field < 0 || nestingFields(part).has(field)) return undefined

	if (simple) {
		const locked = part.reader.attr(part.node(first), Ns.W, "fldLock")

		if (locked === "1" || locked === "true" || locked === "on") return undefined

		for (let item = first + 1; item < part.end(first); item++) if (!RESULT_KINDS.has(part.kinds[item] ?? 0)) return undefined

		return { field, simple, begin: first, separate: -1, end: first }
	}

	const begin = part.fields.begin[field] ?? -1
	const separate = part.fields.separate[field] ?? -1
	const end = part.fields.end[field] ?? -1

	if (begin !== first + 1 || end < 0 || part.parent(end) !== last || part.fieldCharLocked(begin)) return undefined
	if (part.fieldCharType(begin) !== FieldCharType.Begin) return undefined

	if (separate >= 0) {
		const run = part.parent(separate)

		if (part.kinds[run] !== Item.Run || part.parent(run) !== part.parent(first)) return undefined
	}

	for (let item = (separate >= 0 ? separate : begin) + 1; item < end; item++)
		if (!RESULT_KINDS.has(part.kinds[item] ?? 0)) return undefined

	return { field, simple, begin, separate, end }
}

// ---- evaluation ------------------------------------------------------------------------------------------

// Field types an update recomputes.
export const UPDATABLE_FIELDS: ReadonlySet<string> = new Set([
	"PAGE",
	"NUMPAGES",
	"SECTIONPAGES",
	"SECTION",
	"DATE",
	"TIME",
	"REF",
	"PAGEREF",
	"SEQ"
])

// Fields numbering by a list of their own (§17.16.5.37, §17.16.5.4-6), which an update does not count.
const LIST_NUMBERS: ReadonlySet<string> = new Set(["LISTNUM", "AUTONUM", "AUTONUMLGL", "AUTONUMOUT"])

// Fields whose result depends on page numbers.
const PAGE_FIELDS: ReadonlySet<string> = new Set(["PAGE", "NUMPAGES", "SECTIONPAGES", "SECTION", "PAGEREF"])

// What Word writes for a page reference (PAGEREF, a table of contents' entry) to a bookmark the document lacks,
// and for a REF to one (en-US).
export const MISSING_BOOKMARK = "Error! Bookmark not defined."
export const MISSING_REFERENCE = "Error! Reference source not found."

export function needsPages(type: string): boolean {
	return PAGE_FIELDS.has(type)
}

// The tracked update of a field atom (its result before an update made while tracking changes, who made it
// and when: fields/result.ts), or null.
export function fieldUpdateOf(node: Node): FieldUpdate | null {
	return (node.attrs["update"] as FieldUpdate | null | undefined) ?? null
}

// What a field atom's attributes become when its tracked update is accepted (the result stays) or rejected
// (the result before comes back); with tracked changes in its code, the code after or before them.
export function resolvedFieldUpdate(node: Node, accept: boolean): Readonly<Record<string, unknown>> {
	const update = fieldUpdateOf(node)
	const result = accept || update === null ? (node.attrs["result"] as string) : update.result

	if (update?.code === undefined) return { result, update: null }

	const instruction = accept ? update.code.after : update.code.before

	return { result, update: null, instruction, type: fieldCodeType(instruction) }
}

// A field atom's type for its code: the code's first word, upper case.
export function fieldCodeType(instruction: string): string {
	return (/^\s*([^\s\\"]+)/.exec(instruction)?.[1] ?? "").toUpperCase()
}

// Whether field atom `node` (of `session`'s story) is one an update recomputes.
export function updatableField(session: DocxEditorSession, node: Node): boolean {
	if (node.type !== nodes.field || !UPDATABLE_FIELDS.has(parseFieldCode(node.attrs["instruction"] as string).type)) return false

	return (node.attrs["src"] as number) === NO_SOURCE || rewritableSource(session.story.part, node) !== undefined
}

// One update's view of a story: its bookmarks, sequence numbers and the clock, made once per update.
export class FieldEvaluation {
	readonly session: DocxEditorSession
	readonly host: FieldHost
	// The story's document the positions are in (the session's, or a transaction's about to apply).
	readonly doc: Node
	private readonly now: Date
	private sequences: Map<number, number> | undefined = undefined
	private readonly lists = new Map<DocxEditorSession, ListNumbers>()

	constructor(host: FieldHost, session: DocxEditorSession, now: number, doc: Node = session.state.doc) {
		this.host = host
		this.session = session
		this.doc = doc
		this.now = new Date(now)
	}

	private docOf(session: DocxEditorSession): Node {
		return session === this.session ? this.doc : session.state.doc
	}

	private bookmark(name: string | undefined): DocxBookmark | undefined {
		if (name === undefined) return undefined

		const key = name.toLowerCase()
		const own = bookmarkIndex(this.doc, this.session.story.part).byName.get(key)

		if (own !== undefined) return own

		const body = this.host.body.session

		return body === this.session ? undefined : bookmarkIndex(body.state.doc, body.story.part).byName.get(key)
	}

	// The session whose document holds `bookmark` (this story's, else the body's).
	private holder(bookmark: DocxBookmark): DocxEditorSession {
		return bookmarkIndex(this.doc, this.session.story.part).list.includes(bookmark) ? this.session : this.host.body.session
	}

	private pageOf(session: DocxEditorSession, pos: number): FieldPage | undefined {
		const pages = this.host.pages
		const index = pages?.pageAt(session, pos)

		return index === undefined ? undefined : pages?.page(index)
	}

	// The new result of the field atom `node` at `pos`, or undefined when it keeps the one it has.
	result(node: Node, pos: number): string | undefined {
		const code = parseFieldCode(node.attrs["instruction"] as string)
		const pages = this.host.pages

		switch (code.type) {
			case "PAGE": {
				const page = this.pageOf(this.session, pos)

				return page === undefined ? undefined : numberResult(page.number, code, page.numberText)
			}
			case "NUMPAGES":
				return pages === undefined || pages.count === 0 ? undefined : numberResult(pages.count, code)
			case "SECTIONPAGES": {
				const page = this.pageOf(this.session, pos)

				return page === undefined || pages === undefined ? undefined : numberResult(pages.sectionPages(page.section), code)
			}
			case "SECTION": {
				const page = this.pageOf(this.session, pos)

				return page === undefined ? undefined : numberResult(page.section + 1, code)
			}
			case "DATE":
			case "TIME": {
				const lang = this.language(node, pos)

				return caseFormat(
					datePicture(
						this.now,
						switchOf(code, "@")?.arg ?? (code.type === "DATE" ? DEFAULT_DATE_PICTURE : DEFAULT_TIME_PICTURE),
						lang?.latin,
						fieldCalendar(code),
						lang?.eastAsia
					),
					code
				)
			}
			case "REF":
				return this.reference(code, pos)
			case "PAGEREF":
				return this.pageReference(code, pos)
			case "SEQ":
				return this.sequence(code, pos)
			default:
				return undefined
		}
	}

	// The list number of the paragraph a bookmark starts in (see reference), "" when it has none.
	private paragraphNumber(code: FieldCode, context: "none" | "full" | "relative", bookmark: DocxBookmark, pos: number): string {
		const holder = this.holder(bookmark)
		const lists = this.listsOf(holder)
		const target = lists.at(paragraphAt(this.docOf(holder), bookmark.from))

		if (target === undefined || target.bullet) return ""

		const numbering = holder.context.numbering as Numbering
		const segments: NumberSegment[] = []
		const covered = new Set<number>([target.ilvl])
		const own = levelSegments(numbering, target, target.ilvl)

		for (const segment of own) covered.add(segment.level)

		// Higher levels the level's own text leaves out, nearest last: each with its own text.
		if (context !== "none")
			for (let level = target.ilvl - 1; level >= 0; level--) {
				if (covered.has(level)) continue

				const outer = levelSegments(numbering, target, level)

				for (const segment of outer) covered.add(segment.level)

				spliceAll(segments, 0, 0, outer)
			}

		appendAll(segments, own)

		// Relative: the leading levels the REF's own paragraph shares, when it is numbered in the same list.
		if (context === "relative") {
			const own = holder === this.session ? lists.at(paragraphAt(this.doc, pos)) : undefined
			const here = own?.abstractId === target.abstractId ? own : undefined

			while (
				here !== undefined &&
				segments.length > 1 &&
				(segments[0]?.level ?? 0) < target.ilvl &&
				here.values[segments[0]?.level ?? 0] === target.values[segments[0]?.level ?? 0]
			)
				segments.shift()
		}

		const separator = switchOf(code, "d")?.arg
		const plain = hasSwitch(code, "t")
		let out = ""

		for (const [index, segment] of segments.entries()) {
			const last = index === segments.length - 1
			const lead = plain ? delimiters(segment.lead) : segment.lead
			const after = separator !== undefined && !last ? separator : plain ? delimiters(segment.after) : segment.after

			out += (index === 0 ? lead : "") + segment.number + after
		}

		return out.replace(/[.\s]+$/u, "")
	}

	private listsOf(session: DocxEditorSession): ListNumbers {
		let lists = this.lists.get(session)

		if (lists === undefined) {
			lists = new ListNumbers(session, this.docOf(session))
			this.lists.set(session, lists)
		}

		return lists
	}

	private holdsListNumbers(bookmark: DocxBookmark): boolean {
		const doc = this.docOf(this.holder(bookmark))
		let found = false

		doc.nodesBetween(Math.max(0, bookmark.from), Math.min(bookmark.to, doc.content.size), node => {
			if (node.type === nodes.field && LIST_NUMBERS.has(node.attrs["type"] as string)) found = true

			return !found && !node.isLeaf
		})

		return found
	}

	// The bookmarked text, locked blocks it starts, ends or runs through read from their bytes.
	private bookmarkText(bookmark: DocxBookmark): string {
		const holder = this.holder(bookmark)
		const doc = this.docOf(holder)
		const locked = (place: string | undefined, pos: number): Node | null =>
			place === "kept" && pos >= 0 && pos < doc.content.size && doc.nodeAt(pos)?.type === nodes.locked_block ? doc.nodeAt(pos) : null
		const first = locked(bookmark.start, bookmark.startPos)
		const last = locked(bookmark.end, bookmark.endPos)
		const from = first === null ? bookmark.from : bookmark.startPos
		const to = last === null ? bookmark.to : bookmark.endPos + last.nodeSize

		return rangeText(doc, from, to, { part: holder.story.part, start: bookmark.startItem, end: bookmark.endItem })
	}

	// The language of a field atom's runs (w:lang, its Latin script value; a field of the file's, its first run's),
	// if any.
	private language(node: Node, pos: number): { readonly latin: string | undefined; readonly eastAsia: string | undefined } | undefined {
		const $pos = this.doc.resolve(pos)

		if ($pos.parent.type !== nodes.paragraph) return undefined

		const session = this.session
		const part = session.story.part
		const own = node.attrs["src"] as number
		let props = session.formats.runProps(node.marks)

		if (own !== NO_SOURCE && own >= 0 && own < part.count) {
			let run = own

			while (run < part.end(own) && part.kinds[run] !== Item.Run) run++

			const rPr = run < part.end(own) ? (part.runs.rPr[part.aux[run] ?? -1] ?? -1) : -1

			if (rPr >= 0) props = session.context.store.run(part.document, rPr)
		}

		const lang = session.context.resolver.run(session.formats.paragraph($pos.parent), props).lang

		return { latin: lang.latin ?? undefined, eastAsia: lang.eastAsia ?? undefined }
	}

	// "above" or "below": where a bookmark is from `pos` (§17.16.5.51 \p).
	private relative(bookmark: DocxBookmark, pos: number): string {
		return this.holder(bookmark) !== this.session || bookmark.from <= pos ? "above" : "below"
	}

	// REF (§17.16.5.51, MS-OI29500 2.1.495): the bookmarked text, or the list number of its paragraph without
	// trailing periods: \n as drawn (its level's text), \w in full context (the higher levels its text leaves out
	// before it), \r relative to the REF's own place in the list (the higher levels both share left out); \t keeps
	// only numbers and delimiters, \d replaces the delimiters between numbers, \p adds "above"/"below".
	private reference(code: FieldCode, pos: number): string | undefined {
		const bookmark = this.bookmark(code.args[0])

		if (bookmark === undefined) return MISSING_REFERENCE

		const context = hasSwitch(code, "w") ? "full" : hasSwitch(code, "r") ? "relative" : hasSwitch(code, "n") ? "none" : undefined
		const numbered = context !== undefined
		let text: string

		if (context !== undefined) text = this.paragraphNumber(code, context, bookmark, pos)
		else {
			// A list number field there (LISTNUM, AUTONUM) is drawn by Word from its list, which this editor does not
			// count: the result Word stored stays.
			if (this.holdsListNumbers(bookmark)) return undefined

			text = this.bookmarkText(bookmark)
		}

		if (hasSwitch(code, "p")) text = numbered ? `${text} ${this.relative(bookmark, pos)}` : this.relative(bookmark, pos)

		return caseFormat(text, code)
	}

	// PAGEREF (§17.16.5.43): the page number of the bookmark's start in its section's format (or a \* format);
	// \p "on page N", or "above"/"below" on the same page.
	private pageReference(code: FieldCode, pos: number): string | undefined {
		const bookmark = this.bookmark(code.args[0])

		if (bookmark === undefined) return MISSING_BOOKMARK

		const target = this.pageOf(this.holder(bookmark), bookmark.from)

		if (target === undefined) return undefined

		const text = numberResult(target.number, code, target.numberText)

		if (!hasSwitch(code, "p")) return text

		const here = this.host.pages?.pageAt(this.session, pos)
		const there = this.host.pages?.pageAt(this.holder(bookmark), bookmark.from)

		return here !== undefined && here === there ? this.relative(bookmark, pos) : `on page ${text}`
	}

	// SEQ (§17.16.5.56): the fields of the story in document order, each identifier counted on its own; \c
	// repeats the last number, \r n restarts at n, \s n restarts after each heading of level n or above,
	// \h hides the result.
	private sequence(code: FieldCode, pos: number): string | undefined {
		const value = this.sequenceValues().get(pos)

		if (value === undefined) return undefined
		if (hasSwitch(code, "h") && generalSwitches(code).length === 0) return ""

		return numberResult(value, code)
	}

	private sequenceValues(): Map<number, number> {
		if (this.sequences !== undefined) return this.sequences

		const values = new Map<number, number>()
		const counters = new Map<string, number>()
		const doc = this.doc
		const fields: { pos: number; code: FieldCode }[] = []
		const resets = new Map<string, number>()

		const part = this.session.story.part
		const kept = keptSequences(part)
		// Fields kept in a locked block's bytes count where the block is; their results stay.
		const counted = new Set<{ pos: number; code: FieldCode }>()

		doc.descendants((node, pos) => {
			if (node.type === nodes.field) {
				const code = parseFieldCode(node.attrs["instruction"] as string)

				if (code.type === "SEQ" && !deleted(node.marks)) fields.push({ pos, code })

				return false
			}

			if (node.type === nodes.locked_block && kept.length > 0 && !deleted(node.marks)) {
				const first = node.attrs["src"] as number

				if (first >= 0 && first < part.count)
					for (let k = lowerBound(kept, first); k < kept.length && (kept[k]?.item ?? 0) < part.end(first); k++) {
						const entry = { pos, code: (kept[k] as { code: FieldCode }).code }

						counted.add(entry)
						fields.push(entry)
					}

				return false
			}

			return !node.isLeaf
		})

		for (const { code } of fields) {
			const level = Number(switchOf(code, "s")?.arg)
			const id = (code.args[0] ?? "").toLowerCase()

			if (Number.isInteger(level) && level >= 1 && level <= 9) resets.set(id, Math.max(resets.get(id) ?? 0, level))
		}

		// Headings restarting a sequence, by position: only looked for when a \s asks.
		const headings: { pos: number; level: number }[] = []

		if (resets.size > 0) {
			const levelOf = outlineLevels(this.session)

			doc.descendants((node, pos) => {
				if (node.type !== nodes.paragraph) return node.type !== nodes.locked_block

				const level = levelOf(node)

				if (level !== undefined) headings.push({ pos, level })

				return false
			})
		}

		let heading = 0
		const lastHeading = new Map<string, number>()

		for (const [index, { pos, code }] of fields.entries()) {
			const id = (code.args[0] ?? "").toLowerCase()

			while (heading < headings.length && (headings[heading]?.pos ?? 0) < pos) {
				const level = headings[heading]?.level ?? 9

				for (const [seq, reset] of resets) if (level <= reset - 1) lastHeading.set(seq, (lastHeading.get(seq) ?? 0) + 1)

				heading++
			}

			const resetAt = `${id}\u0000${String(lastHeading.get(id) ?? 0)}`
			let counter = counters.get(resetAt) ?? 0
			const restart = Number(switchOf(code, "r")?.arg)

			if (Number.isInteger(restart) && switchOf(code, "r") !== undefined) counter = restart
			else if (!hasSwitch(code, "c")) counter++

			counters.set(resetAt, counter)

			if (!counted.has(fields[index] as { pos: number; code: FieldCode })) values.set(pos, counter)
		}

		this.sequences = values

		return values
	}
}

// ---- list numbers ----------------------------------------------------------------------------------------

interface ListEntry {
	readonly pos: number
	readonly numId: number
	readonly ilvl: number
	readonly abstractId: number
	// The counter of each level up to its own as its paragraph was numbered (a level not counted yet: its start).
	readonly values: readonly number[]
	readonly bullet: boolean
}

// The numbered paragraphs of a story's document (outside locked blocks), counted once per update as layout
// counts them.
class ListNumbers {
	private readonly byPos = new Map<number, ListEntry>()

	constructor(session: DocxEditorSession, doc: Node) {
		const numbering = session.context.numbering

		if (numbering === undefined) return

		const counters = new NumberingCounters(numbering)
		const formats = session.formats
		// Per abstract definition, the last value of each level and whether it counted since a higher one did.
		const state = new Map<number, { values: number[]; active: boolean[] }>()

		doc.descendants((node, pos) => {
			if (!node.isTextblock) return node.type !== nodes.locked_block && !node.isInline
			if (node.type !== nodes.paragraph) return false

			const ref = formats.paragraph(node).props.numbering

			if (ref === undefined || ref.numId <= 0) return false

			const marker = counters.next(ref.numId, ref.ilvl)
			const effective = numbering.level(ref.numId, ref.ilvl)

			if (marker === undefined || effective === undefined) return false

			let levels = state.get(effective.abstractId)

			if (levels === undefined) {
				levels = { values: [], active: [] }
				state.set(effective.abstractId, levels)
			}

			levels.values[marker.ilvl] = marker.value
			levels.active[marker.ilvl] = true
			levels.active.fill(false, marker.ilvl + 1)

			const values: number[] = []

			for (let level = 0; level <= marker.ilvl; level++)
				values.push(levels.active[level] === true ? (levels.values[level] ?? 0) : (numbering.level(ref.numId, level)?.start ?? 0))

			const entry: ListEntry = {
				pos,
				numId: ref.numId,
				ilvl: marker.ilvl,
				abstractId: effective.abstractId,
				values,
				bullet: marker.bullet
			}

			this.byPos.set(pos, entry)

			return false
		})
	}

	at(pos: number): ListEntry | undefined {
		return this.byPos.get(pos)
	}
}

// The paragraph holding (or starting at) `pos` of `doc`: its position, or -1.
function paragraphAt(doc: Node, pos: number): number {
	const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)))

	if ($pos.parent.isTextblock) return $pos.before()

	return $pos.nodeAfter?.isTextblock === true ? $pos.pos : -1
}

// One number of a list number: the text before it (the level text's own, for the first), the number and the
// text up to the next number (or the end).
interface NumberSegment {
	readonly level: number
	readonly lead: string
	readonly number: string
	readonly after: string
}

// Level `level`'s text (w:lvlText) of the list `entry` is in, as segments with `entry`'s counters.
function levelSegments(numbering: Numbering, entry: ListEntry, level: number): NumberSegment[] {
	const definition = numbering.level(entry.numId, level)?.level
	const template = definition?.text ?? ""
	const out: { level: number; lead: string; number: string; after: string }[] = []
	let from = 0
	let lead = ""

	for (let at = template.indexOf("%"); at >= 0; at = template.indexOf("%", at + 1)) {
		const target = template.charCodeAt(at + 1) - 49

		if (target < 0 || target > 8) continue

		const text = template.slice(from, at)
		const previous = out[out.length - 1]

		if (previous === undefined) lead = text
		else previous.after = text

		from = at + 2

		if (target > level) continue

		const own = numbering.level(entry.numId, target)?.level
		let format = own?.format ?? "decimal"

		if (definition?.legal === true && format !== "none" && format !== "bullet") format = "decimal"

		out.push({
			level: target,
			lead: out.length === 0 ? lead : "",
			number: formatNumber(entry.values[target] ?? 0, format, own?.customFormat),
			after: ""
		})
		at = from - 1
	}

	const previous = out[out.length - 1]

	if (previous !== undefined) previous.after = template.slice(from)

	return out
}

// What delimits numbers in `text`: what is neither a letter nor a space (\t).
function delimiters(text: string): string {
	return text.replace(/[\p{L}\s]/gu, "")
}

const KEPT_SEQUENCES = new WeakMap<StoryPart, readonly { readonly item: number; readonly code: FieldCode }[]>()

// The SEQ fields of a part (their first items, in order, deleted ones left out), read once per part.
function keptSequences(part: StoryPart): readonly { readonly item: number; readonly code: FieldCode }[] {
	let list = KEPT_SEQUENCES.get(part)

	if (list === undefined) {
		const out: { item: number; code: FieldCode }[] = []

		for (let field = 0; field < part.fields.count; field++) {
			const item = part.fields.begin[field] ?? -1

			if (item < 0 || part.fieldType(field) !== "SEQ" || part.hidden(item, RevisionView.Final)) continue

			out.push({ item, code: parseFieldCode(part.fieldInstruction(field)) })
		}

		list = out.sort((a, b) => a.item - b.item)
		KEPT_SEQUENCES.set(part, list)
	}

	return list
}

// The first index of `list` whose item is at or after `item`.
function lowerBound(list: readonly { readonly item: number }[], item: number): number {
	let low = 0
	let high = list.length

	while (low < high) {
		const middle = (low + high) >> 1

		if ((list[middle]?.item ?? 0) < item) low = middle + 1
		else high = middle
	}

	return low
}

// ---- the paged editor as a host ----------------------------------------------------------------------------

// What an update reads from a paged editor: the pages shown (call once layout settled), positions of the body
// and of the story being edited located on them.
export function pagedFieldHost(editor: PagedEditor): FieldHost {
	let sections: Map<number, number> | undefined
	const geometryOf = (session: DocxEditorSession): PagedGeometry | undefined =>
		session === editor.body.session ? editor.body.geometry : session === editor.session ? editor.geometry : undefined

	return {
		body: editor.body,
		sessions: editor.sessions,
		pages: {
			get count() {
				return editor.pageCount
			},
			page: index => editor.page(index),
			pageAt: (session, pos) => geometryOf(session)?.locate(pos, 1)?.page,
			markerAt: (session, pos) => geometryOf(session)?.markerText(pos) ?? "",
			sectionPages(section) {
				if (sections === undefined) {
					const counts = new Map<number, number>()

					for (let index = 0; index < editor.pageCount; index++) {
						const page = editor.page(index)

						if (page !== undefined) counts.set(page.section, (counts.get(page.section) ?? 0) + 1)
					}

					sections = counts
				}

				return sections.get(section) ?? 0
			}
		}
	}
}
