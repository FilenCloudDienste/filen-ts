import type { Mark, MarkType, Node } from "prosemirror-model"
import type { EditorState, Transaction } from "prosemirror-state"
import type { ColorProps, ResolvedRunProps, ThemeFontRef } from "../../props/index"
import { DEFAULT_FONT, type ParagraphFormat } from "../../styles/index"
import {
	DOCX_FONT_SIZES,
	DOCX_THEME_BODY_FONT,
	DOCX_THEME_HEADINGS_FONT,
	MAX_HALF_POINTS,
	type DocxHighlightColor,
	type DocxTextColor,
	type FormattingCommand
} from "../commands/formatting"
import { MAX_TWIPS } from "../commands/base"
import { AttrChanges } from "../attrs"
import { changeCase } from "../changeCase"
import type { DocxEditContext } from "../context"
import { baseFits } from "../formatting"
import {
	caretMarks,
	changeMarkSets,
	changeMarks,
	runPieces,
	selectedParagraphs,
	withMark,
	wordAround,
	type FormatResolver,
	type ParagraphAt,
	type RunValues
} from "../formats"
import type { DocumentCommandContext, DocumentCommandHandler, FeatureHandlers, StoryCommandContext, StoryCommandHandler } from "../registry"
import { FORMATTING_MARKS, NO_SOURCE, docxSchema, type ColorAttrs, type IndentAttrs } from "../schema"
import type { DocxEditorSession } from "../session"

// Fonts, sizes, colours, character spacing, paragraph spacing and indents, Clear All Formatting and the format
// painter. Each command sets direct formatting only where the styles do not already give the result (as
// Word does), so choosing what a style gives removes the direct property instead.

const marks = docxSchema.marks
const nodes = docxSchema.nodes
// Formatting cleared by Clear All Formatting: everything but the language and highlighting (Word keeps both),
// and the plain mark it sets.
const CLEARED_TYPES: readonly MarkType[] = FORMATTING_MARKS.filter(name => name !== "lang" && name !== "highlight").map(name => marks[name])
// What the painter carries of content: every formatting mark, and the run's source w:rPr (its base).
const PROPERTY_TYPES: readonly MarkType[] = FORMATTING_MARKS.map(name => marks[name])
const PAINTED_TYPES: readonly MarkType[] = [...PROPERTY_TYPES, marks.run]
// Paragraph attributes the painter carries and Clear All Formatting resets.
const PARAGRAPH_ATTRS: readonly string[] = ["styleId", "numId", "ilvl", "align", "indent", "spacing", "borders"]
// Above Word's size list, font.grow and font.shrink step by 10 points; below it by 1.
const LARGE_STEP = 20
const SMALL_STEP = 2
const PLAIN = marks.plain.create()
const ONLY_PLAIN: readonly Mark[] = [PLAIN]

type Cmd<T extends FormattingCommand["type"]> = Extract<FormattingCommand, { readonly type: T }>

// Content a run command changes: a piece of the selection, or the caret (its stored marks).
interface RunAt {
	readonly format: ParagraphFormat
	readonly marks: readonly Mark[]
	// In a table: a table style may format it, which the resolver does not see, so a font, size or colour is
	// never left to the styles there.
	readonly cell: boolean
	readonly values: RunValues
	// What the paragraph and character styles alone give.
	readonly style: RunValues
	readonly styleRun: ResolvedRunProps
}

// A mark type set to what `next` gives each piece (undefined: none).
interface MarkChange {
	readonly type: MarkType
	next(at: RunAt): Mark | undefined
}

function inCell(state: EditorState): boolean {
	const $from = state.selection.$from

	for (let depth = $from.depth; depth > 0; depth--) if ($from.node(depth).type === nodes.table_cell) return true

	return false
}

// Whether the selection touches a paragraph (cheap: the snapshot asks on every change).
export function touchesParagraph(state: EditorState): boolean {
	const { $from, $to, empty, from, to } = state.selection

	if ($from.parent.type === nodes.paragraph || $to.parent.type === nodes.paragraph) return true
	if (empty) return false

	let found = false

	state.doc.nodesBetween(from, to, node => {
		if (found) return false
		if (node.type === nodes.paragraph) found = true

		return !found && !node.isInline && node.type !== nodes.locked_block
	})

	return found
}

export function writable(context: { readonly session: DocxEditorSession; readonly state: EditorState }): boolean {
	return !context.session.readOnly && touchesParagraph(context.state)
}

function atOf(formats: FormatResolver, paragraph: Node, marksOf: readonly Mark[], cell: boolean): RunAt {
	const format = formats.paragraph(paragraph)

	return {
		format,
		marks: marksOf,
		cell,
		values: formats.values(format, marksOf),
		style: formats.styleValues(format, marksOf),
		styleRun: formats.styleRun(format, marksOf)
	}
}

// Applies the changes `plan` makes from the content's current formatting: to every piece of a selection, to
// the word a caret is inside of (as Word does), or to the caret's stored marks (what is typed next).
function runCommand(context: StoryCommandContext, plan: (ats: readonly RunAt[]) => readonly MarkChange[]): Transaction | null {
	const state = context.state
	const formats = context.session.formats
	const word = wordAround(state)

	if (state.selection.empty && word === undefined) {
		const $from = state.selection.$from

		if ($from.parent.type !== nodes.paragraph) return null

		const current = caretMarks(state, formats)
		const at = atOf(formats, $from.parent, current, inCell(state))
		let next = current

		for (const change of plan([at])) next = withMark(next, change.type, change.next(at))

		return state.tr.setStoredMarks(next)
	}

	const pieces = runPieces(state, word === undefined ? undefined : [word])

	if (pieces.length === 0) return null

	const ats = pieces.map(piece => atOf(formats, piece.paragraph, piece.node.marks, piece.cell))
	const tr = state.tr

	for (const change of plan(ats)) changeMarks(tr, pieces, change.type, (_piece, index) => change.next(ats[index] as RunAt))

	return tr.docChanged ? tr : null
}

// ---- character formatting ------------------------------------------------------------------------------

type BooleanValue = "strike" | "doubleStrike" | "caps" | "smallCaps"

const BOOLEAN_TYPES: Readonly<Record<BooleanValue, MarkType>> = {
	strike: marks.strike,
	doubleStrike: marks.double_strike,
	caps: marks.caps,
	smallCaps: marks.small_caps
}

// A direct boolean property set to `value`, or none where the styles give it.
function booleanChange(name: BooleanValue, value: boolean): MarkChange {
	const type = BOOLEAN_TYPES[name]
	const mark = type.create({ value })

	return { type, next: at => (at.style[name] === value ? undefined : mark) }
}

// Turns `name` on, or off when all of the content has it; `exclusive` goes off with it (Word allows one of
// strikethrough and double strikethrough, of all caps and small caps).
function toggleValue(name: BooleanValue, exclusive: BooleanValue): (ats: readonly RunAt[]) => readonly MarkChange[] {
	return ats =>
		ats.every(at => at.values[name]) ? [booleanChange(name, false)] : [booleanChange(name, true), booleanChange(exclusive, false)]
}

function vertAlign(target: "superscript" | "subscript"): (ats: readonly RunAt[]) => readonly MarkChange[] {
	return ats => {
		const value = ats.every(at => at.values.vertAlign === target) ? "baseline" : target
		const mark = marks.vert_align.create({ value })

		return [{ type: marks.vert_align, next: at => (at.style.vertAlign === value ? undefined : mark) }]
	}
}

// The w:u value content shows: its own, else what the styles give.
function underlineOf(at: RunAt): string {
	const own = marks.underline.isInSet(at.marks)

	return own === undefined ? (at.styleRun.underline?.style ?? "none") : (own.attrs["style"] as string)
}

// Double underline on, or underline off when all of the content has it; an underline colour stays.
function doubleUnderline(ats: readonly RunAt[]): readonly MarkChange[] {
	const value = ats.every(at => underlineOf(at) === "double") ? "none" : "double"
	// One mark for each distinct own underline (a few in any selection).
	const made = new Map<Mark | undefined, Mark>()

	return [
		{
			type: marks.underline,
			next: at => {
				const own = marks.underline.isInSet(at.marks)

				const colored = own !== undefined && (own.attrs["value"] !== null || own.attrs["themeColor"] !== null)

				if ((at.styleRun.underline?.style ?? "none") === value && !colored) return undefined

				let mark = made.get(own)

				if (mark === undefined) {
					mark = marks.underline.create({ ...own?.attrs, style: value })
					made.set(own, mark)
				}

				return mark
			}
		}
	]
}

// The w:rFonts slots a font choice sets (Word sets the Latin and complex script fonts; the East Asian one
// stays).
const FONT_SLOTS = [
	["ascii", "asciiTheme"],
	["hAnsi", "hAnsiTheme"],
	["cs", "csTheme"]
] as const

const NO_FONTS: Readonly<Record<string, unknown>> = {
	ascii: null,
	hAnsi: null,
	eastAsia: null,
	cs: null,
	asciiTheme: null,
	hAnsiTheme: null,
	eastAsiaTheme: null,
	csTheme: null,
	hint: null
}

// Whether the styles set a font slot from a theme font (rather than by name): the nearest level setting the
// slot decides, the character style's chain first, then what the paragraph gives runs.
function styleSlotThemed(
	context: DocxEditContext,
	at: RunAt,
	slot: "ascii" | "hAnsi" | "cs",
	themeSlot: "asciiTheme" | "hAnsiTheme" | "csTheme"
): boolean {
	const styles = context.styles
	const styleId = marks.char_style.isInSet(at.marks)?.attrs["styleId"] as string | undefined

	for (let style = styleId === undefined ? undefined : styles.byId(styleId); style !== undefined; style = styles.parent(style)) {
		const fonts = style.run.fonts

		if (fonts?.[themeSlot] !== undefined) return true
		if (fonts?.[slot] !== undefined) return false
	}

	return at.format.runBase.fonts?.[themeSlot] !== undefined
}

function fontChange(context: DocxEditContext, family: string): MarkChange {
	const theme = family === DOCX_THEME_BODY_FONT ? "minor" : family === DOCX_THEME_HEADINGS_FONT ? "major" : undefined
	const refs: Readonly<Record<string, ThemeFontRef>> | undefined =
		theme === undefined ? undefined : { ascii: `${theme}HAnsi`, hAnsi: `${theme}HAnsi`, cs: `${theme}Bidi` }
	const languages = context.resolver.settings.themeFontLanguage
	const names = new Map<string, string>()

	for (const [slot] of FONT_SLOTS) {
		const ref = refs?.[slot]

		// As the resolver reads a slot: a theme font the theme lacks is Word's default.
		names.set(slot, ref === undefined ? family : (context.resolver.theme?.font(ref, languages) ?? DEFAULT_FONT))
	}

	// One mark for each distinct result, worked out once for each distinct input: a selection over a long
	// document has a few, over a hundred thousand runs.
	const made = new Map<string, Mark>()
	const results = new TupleMemo<Mark | undefined>()

	return {
		type: marks.font,
		next: at =>
			results.get(
				[
					marks.font.isInSet(at.marks),
					at.cell,
					at.styleRun,
					marks.char_style.isInSet(at.marks)?.attrs["styleId"],
					at.format.runBase
				],
				() => fontMark(at)
			)
	}

	function fontMark(at: RunAt): Mark | undefined {
		const attrs: Record<string, unknown> = { ...NO_FONTS, ...marks.font.isInSet(at.marks)?.attrs }

		for (const [slot, themeSlot] of FONT_SLOTS) {
			// A named font the styles give from the theme is still set by name: it must not follow the theme.
			if (
				!at.cell &&
				at.styleRun.fonts[slot] === names.get(slot) &&
				styleSlotThemed(context, at, slot, themeSlot) === (refs !== undefined)
			) {
				attrs[slot] = null
				attrs[themeSlot] = null
			} else {
				attrs[slot] = refs === undefined ? family : null
				attrs[themeSlot] = refs?.[slot] ?? null
			}
		}

		if (Object.values(attrs).every(value => value === null)) return undefined

		const key = JSON.stringify(attrs)
		let mark = made.get(key)

		if (mark === undefined) {
			mark = marks.font.create(attrs)
			made.set(key, mark)
		}

		return mark
	}
}

// Results by a tuple of inputs, each compared by identity.
class TupleMemo<T> {
	private readonly root = new Map<unknown, unknown>()

	get(keys: readonly unknown[], make: () => T): T {
		let level = this.root

		for (let k = 0; k < keys.length - 1; k++) {
			let next = level.get(keys[k]) as Map<unknown, unknown> | undefined

			if (next === undefined) {
				next = new Map()
				level.set(keys[k], next)
			}

			level = next
		}

		const last = keys[keys.length - 1]

		if (level.has(last)) return level.get(last) as T

		const value = make()

		level.set(last, value)

		return value
	}
}

// Size marks by value and complex script value (a few distinct ones).
const SIZE_MARKS = new Map<string, Mark>()

function sizeMark(at: RunAt, halfPoints: number): Mark | undefined {
	const value = !at.cell && at.styleRun.size === halfPoints ? null : halfPoints
	const cs = !at.cell && at.styleRun.sizeCs === halfPoints ? null : halfPoints

	if (value === null && cs === null) return undefined

	const key = `${String(value)}:${String(cs)}`
	let mark = SIZE_MARKS.get(key)

	if (mark === undefined) {
		mark = marks.size.create({ value, cs })
		SIZE_MARKS.set(key, mark)
	}

	return mark
}

// The next size of Word's list up or down from `size` (half-points).
export function steppedSize(size: number, up: boolean): number {
	const smallest = DOCX_FONT_SIZES[0] ?? SMALL_STEP
	const largest = DOCX_FONT_SIZES[DOCX_FONT_SIZES.length - 1] ?? LARGE_STEP

	if (up) {
		if (size < smallest) return Math.min(smallest, size + SMALL_STEP)

		return Math.min(
			MAX_HALF_POINTS,
			DOCX_FONT_SIZES.find(candidate => candidate > size) ?? (Math.floor(size / LARGE_STEP) + 1) * LARGE_STEP
		)
	}

	if (size > largest) return Math.max(largest, (Math.ceil(size / LARGE_STEP) - 1) * LARGE_STEP)

	return DOCX_FONT_SIZES.findLast(candidate => candidate < size) ?? Math.max(SMALL_STEP, size - SMALL_STEP)
}

function colorChange(context: DocxEditContext, color: DocxTextColor): MarkChange {
	let attrs: ColorAttrs

	switch (color.kind) {
		case "auto":
			attrs = { value: "auto", themeColor: null, themeTint: null, themeShade: null }

			break
		case "rgb":
			attrs = { value: color.value, themeColor: null, themeTint: null, themeShade: null }

			break
		case "theme":
			// Word writes the colour it computed next to the theme reference.
			attrs = {
				value:
					context.resolver.color({
						themeColor: color.theme,
						...(color.tint !== undefined ? { themeTint: color.tint } : {}),
						...(color.shade !== undefined ? { themeShade: color.shade } : {})
					}) ?? "auto",
				themeColor: color.theme,
				themeTint: color.tint ?? null,
				themeShade: color.shade ?? null
			}

			break
	}

	const mark = marks.color.create(attrs)

	return { type: marks.color, next: at => (!at.cell && sameColor(styleColor(context, at), color) ? undefined : mark) }
}

// The colour the styles give: the nearest level setting one, the character style's chain first, then what the
// paragraph gives runs.
function styleColor(context: DocxEditContext, at: RunAt): ColorProps | undefined {
	const styles = context.styles
	const styleId = marks.char_style.isInSet(at.marks)?.attrs["styleId"] as string | undefined

	for (let style = styleId === undefined ? undefined : styles.byId(styleId); style !== undefined; style = styles.parent(style)) {
		if (style.run.color !== undefined) return style.run.color
	}

	return at.format.runBase.color
}

// Whether the styles' colour is the choice, as chosen: a theme colour follows the theme and an RGB one does
// not, so the same shade given the other way is no match (as fontChange compares theme fonts).
function sameColor(props: ColorProps | undefined, color: DocxTextColor): boolean {
	switch (color.kind) {
		case "auto":
			return props === undefined || (props.themeColor === undefined && (props.val ?? "auto").toLowerCase() === "auto")
		case "rgb":
			return props?.themeColor === undefined && props?.val?.toUpperCase() === color.value.toUpperCase()
		case "theme":
			return props?.themeColor === color.theme && props.themeTint === color.tint && props.themeShade === color.shade
	}
}

function highlightChange(name: DocxHighlightColor): MarkChange {
	const mark = marks.highlight.create({ value: name })

	return { type: marks.highlight, next: at => (at.style.highlight === name ? undefined : mark) }
}

function spacingChange(twips: number): MarkChange {
	const mark = marks.spacing.create({ value: twips })

	return { type: marks.spacing, next: at => (at.style.spacing === twips ? undefined : mark) }
}

// ---- paragraphs ----------------------------------------------------------------------------------------

function sameValues(a: object, b: object): boolean {
	const left = Object.entries(a).filter(([, value]) => value !== undefined)
	const right = Object.entries(b).filter(([, value]) => value !== undefined)

	return left.length === right.length && left.every(([key, value]) => (b as Record<string, unknown>)[key] === value)
}

function without<T extends object>(value: T, keys: readonly string[]): T {
	const out = { ...value } as Record<string, unknown>

	for (const key of keys) delete out[key]

	return out as T
}

function isEmpty(value: object): boolean {
	return Object.values(value).every(entry => entry === undefined)
}

interface PropertyField {
	// The fields of the attribute this command field sets (left out together when the styles give it).
	readonly drop: readonly string[]
	// Whether the resolved paragraph has the command's value.
	holds(format: ParagraphFormat): boolean
}

// Sets an attribute holding properties (w:ind, w:spacing) on each selected paragraph: `next` merges the
// command's fields into the paragraph's direct ones; a field the styles already give the same value is left
// out, and an attribute equal to the source's is the source's own object (so the writer keeps its bytes).
function paragraphProperty<T extends object>(
	context: StoryCommandContext,
	name: "indent" | "spacing",
	next: (current: T, at: ParagraphAt) => T,
	fields: readonly PropertyField[]
): Transaction | null {
	const formats = context.session.formats
	const paragraphs = selectedParagraphs(context.state)

	if (paragraphs.length === 0) return null

	const changes = new AttrChanges()

	for (const at of paragraphs) {
		const source = (formats.sourceProps(at.node)[name] as object | undefined) ?? null
		let value = next((at.node.attrs[name] as T | null) ?? ({} as T), at)

		// In a table its style's paragraph properties count, which the resolver does not see.
		if (!at.cell) {
			for (const field of fields) {
				const candidate = without(value, field.drop)

				if (field.holds(formats.paragraphWith(at.node, { [name]: isEmpty(candidate) ? null : candidate }))) value = candidate
			}
		}

		changes.set(at.node, at.pos, { [name]: source !== null && sameValues(source, value) ? source : isEmpty(value) ? null : value })
	}

	if (changes.empty) return null

	const tr = context.state.tr

	changes.step(tr)

	return tr
}

function indent(context: StoryCommandContext, command: Cmd<"paragraph.indent">): Transaction | null {
	const fields: PropertyField[] = []
	const { start, end, firstLine, hanging } = command
	const first = firstLine ?? (hanging === undefined ? undefined : -hanging)

	if (start !== undefined)
		fields.push({
			drop: ["start", "startChars"],
			holds: f => f.props.indent.start === start && f.props.indent.startChars === undefined
		})
	if (end !== undefined)
		fields.push({ drop: ["end", "endChars"], holds: f => f.props.indent.end === end && f.props.indent.endChars === undefined })

	if (first !== undefined) {
		fields.push({
			drop: ["firstLine", "hanging", "firstLineChars", "hangingChars"],
			holds: f => f.props.indent.firstLine === first && f.props.indent.firstLineChars === undefined
		})
	}

	const formats = context.session.formats

	return paragraphProperty<IndentAttrs>(
		context,
		"indent",
		(current, at) => {
			let out = current
			// Character-unit forms win over twips: a value set in twips replaces the paragraph's own, and one the
			// styles or the list level give is switched off (0).
			const styled = formats.paragraphWith(at.node, { indent: null }).props.indent
			const chars = (key: "startChars" | "endChars" | "firstLineChars" | "hangingChars", inherited: number | undefined) =>
				inherited === undefined ? {} : { [key]: 0 }

			if (start !== undefined) out = { ...without(out, ["startChars"]), start, ...chars("startChars", styled.startChars) }
			if (end !== undefined) out = { ...without(out, ["endChars"]), end, ...chars("endChars", styled.endChars) }

			if (firstLine !== undefined) {
				out = {
					...without(out, ["hanging", "hangingChars", "firstLineChars"]),
					firstLine,
					...chars("firstLineChars", styled.firstLineChars)
				}
			}

			if (hanging !== undefined) {
				out = {
					...without(out, ["firstLine", "firstLineChars", "hangingChars"]),
					hanging,
					...chars("hangingChars", styled.firstLineChars)
				}
			}

			return out
		},
		fields
	)
}

// Word's Hanging Indent and Unhang: the start indent steps to the next default tab stop past both the text and
// the first line (to the previous one, not before the first line), the first line staying put. In twips, the
// character-unit forms switched off as in indent().
function hangingIndent(context: StoryCommandContext, command: Cmd<"paragraph.hangingIndent">): Transaction | null {
	const formats = context.session.formats
	const tab = context.context.model.settings.defaultTabStop
	const step = tab !== undefined && tab > 0 ? tab : 720

	return paragraphProperty<IndentAttrs>(
		context,
		"indent",
		(current, at) => {
			const resolved = formats.paragraph(at.node).props.indent
			const first = resolved.start + resolved.firstLine
			let start: number

			if (command.direction > 0) {
				start = (Math.floor(Math.max(resolved.start, first) / step) + 1) * step
			} else {
				if (resolved.firstLine >= 0) return current

				start = Math.max(first, (Math.ceil(resolved.start / step) - 1) * step)
			}

			if (start > MAX_TWIPS || start < -MAX_TWIPS || start - first > MAX_TWIPS) return current

			const styled = formats.paragraphWith(at.node, { indent: null }).props.indent

			return {
				...without(current, ["startChars", "firstLine", "firstLineChars", "hangingChars"]),
				start,
				hanging: start - first,
				...(styled.startChars === undefined ? {} : { startChars: 0 }),
				...(styled.firstLineChars === undefined ? {} : { hangingChars: 0 })
			}
		},
		[]
	)
}

interface SpacingValue {
	readonly before?: number
	readonly beforeLines?: number
	readonly beforeAutospacing?: boolean
	readonly after?: number
	readonly afterLines?: number
	readonly afterAutospacing?: boolean
	readonly line?: number
	readonly lineRule?: "auto" | "exact" | "atLeast"
}

const EDGES = {
	before: { lines: "beforeLines", auto: "beforeAutospacing" },
	after: { lines: "afterLines", auto: "afterAutospacing" }
} as const

function spacing(context: StoryCommandContext, command: Cmd<"paragraph.spacing"> | Cmd<"paragraph.lineSpacing">): Transaction | null {
	if (command.type === "paragraph.lineSpacing") {
		const { rule, value } = command

		return paragraphProperty<SpacingValue>(context, "spacing", current => ({ ...current, line: value, lineRule: rule }), [
			{ drop: ["line", "lineRule"], holds: f => f.props.spacing.line === value && f.props.spacing.lineRule === rule }
		])
	}

	const formats = context.session.formats
	const amounts = (["before", "after"] as const).flatMap(edge => {
		const amount = command[edge]

		return amount === undefined ? [] : [{ edge, amount, ...EDGES[edge] }]
	})

	return paragraphProperty<SpacingValue>(
		context,
		"spacing",
		(current, at) => {
			let out: Record<string, unknown> = { ...current }

			for (const { edge, amount, lines, auto } of amounts) {
				out = without(out, [lines, auto])
				out[edge] = amount

				// Automatic spacing a style gives would still win over the amount.
				if (formats.styleParagraph(at.node.attrs["styleId"] as string | null).props.spacing[auto]) out[auto] = false
			}

			return out as SpacingValue
		},
		amounts.map(({ edge, amount, lines, auto }) => ({
			drop: [edge, lines, auto],
			holds: f => f.props.spacing[edge] === amount && f.props.spacing[lines] === undefined && !f.props.spacing[auto]
		}))
	)
}

// The id Clear All Formatting gives paragraphs: Normal (null when Normal is the default paragraph style).
function normalStyle(context: DocxEditContext): string | null {
	const styles = context.styles
	const normal = styles.defaultOf("paragraph")

	return normal === undefined || normal.canonicalName === "normal" ? null : (styles.byName("normal", "paragraph")?.id ?? null)
}

function paragraphReset(context: DocxEditContext, tr: Transaction, paragraphs: readonly ParagraphAt[]): void {
	const reset: Record<string, unknown> = {}

	for (const name of PARAGRAPH_ATTRS) reset[name] = null

	reset["styleId"] = normalStyle(context)

	setAttrs(tr, paragraphs, () => reset)
}

// Sets on each paragraph what `attrs` gives it, as one step.
function setAttrs(
	tr: Transaction,
	paragraphs: readonly ParagraphAt[],
	attrs: (at: ParagraphAt) => Readonly<Record<string, unknown>>
): void {
	const changes = new AttrChanges()

	for (const at of paragraphs) changes.set(at.node, at.pos, attrs(at))

	changes.step(tr)
}

// Word's Clear All Formatting: direct character formatting goes (the language stays) and the paragraphs
// become Normal paragraphs without direct properties or list.
function clearAll(context: StoryCommandContext): Transaction | null {
	const state = context.state

	if (state.selection.empty) {
		const $from = state.selection.$from

		if ($from.parent.type !== nodes.paragraph) return null

		const current = caretMarks(state, context.session.formats)
		const tr = state.tr.setStoredMarks(PLAIN.addToSet(current.filter(mark => !CLEARED_TYPES.includes(mark.type))))

		paragraphReset(context.context, tr, [{ node: $from.parent, pos: $from.before(), cell: false }])

		return tr
	}

	const tr = state.tr

	changeMarkSets(tr, runPieces(state), CLEARED_TYPES, () => ONLY_PLAIN, PLAIN)
	paragraphReset(context.context, tr, selectedParagraphs(state))

	return tr.docChanged ? tr : null
}

// ---- format painter ------------------------------------------------------------------------------------

// The id (RunBases) of the source w:rPr content is formatted with, -1 for none.
function baseOf(marksOf: readonly Mark[]): number {
	return (marks.run.isInSet(marksOf)?.attrs["base"] as number | undefined) ?? -1
}

// format.copy: the formatting of the selection's first content (or the caret's), and its paragraph's when the
// paragraph mark is in the selection (nothing selected, a selection past the paragraph's end, or all of it).
// The run's source w:rPr goes with it (the base of its run mark), so properties without marks go too.
function copyFormat(context: DocumentCommandContext, sticky: boolean): boolean {
	const state = context.session.state
	const { $from, $to, empty } = state.selection
	const first = empty ? undefined : runPieces(state)[0]
	const source = first?.node.marks ?? caretMarks(state, context.session.formats)
	const paragraph = first?.paragraph ?? ($from.parent.type === nodes.paragraph ? $from.parent : undefined)

	if (paragraph === undefined) return false

	const whole = $from.parent === $to.parent && $from.parentOffset === 0 && $to.parentOffset === $to.parent.content.size
	const attrs: Record<string, unknown> = {}

	for (const name of PARAGRAPH_ATTRS) attrs[name] = paragraph.attrs[name]

	context.editor.setPainter({
		marks: source.filter(mark => PAINTED_TYPES.includes(mark.type)),
		paragraph: empty || $from.parent !== $to.parent || whole ? attrs : null,
		sticky
	})

	return true
}

// format.paste: the painted content becomes formatted exactly as the painter's: written from the painter's
// source w:rPr with its marks (as pasted text is: a run without a source of its own, keeping the base), so
// every property goes, with and without a mark. A base holding a tracked formatting change is not copied (its
// revision belongs to the source text), nor one whose bytes would not read the same in this story's part:
// then the marks alone. Content with a tracked formatting change keeps it and its own base (the w:rPrChange
// lives there): only its properties are painted. Its paragraph formatting (when it carries any) goes to the
// paragraphs. The painter turns off after one paste unless sticky.
function pasteFormat(context: DocumentCommandContext): boolean {
	const painter = context.editor.painter
	const session = context.session

	if (painter === undefined) return false

	const state = session.state
	const id = baseOf(painter.marks)
	const painted = id < 0 ? undefined : session.context.bases.get(id)
	const base = painted === undefined || painted.props.change !== undefined || !baseFits(painted, session.story.part.document) ? -1 : id
	let properties: readonly Mark[] = []

	for (const mark of painter.marks) if (PROPERTY_TYPES.includes(mark.type)) properties = mark.addToSet(properties)

	const withRun = marks.run.create({ src: NO_SOURCE, base }).addToSet(properties)
	const word = state.selection.empty ? wordAround(state) : undefined
	const tr = state.tr

	if (state.selection.empty && word === undefined) {
		if (state.selection.$from.parent.type !== nodes.paragraph) return false

		const current = caretMarks(state, context.session.formats)
		// What is typed next is new text: no part of another formatting revision.
		let next: readonly Mark[] = current.filter(mark => !PAINTED_TYPES.includes(mark.type) && mark.type !== marks.format_change)

		for (const mark of withRun) next = mark.addToSet(next)

		tr.setStoredMarks(next)
	} else {
		changeMarkSets(
			tr,
			runPieces(state, word === undefined ? undefined : [word]),
			PAINTED_TYPES,
			piece => {
				if (marks.format_change.isInSet(piece.node.marks) === undefined) return withRun

				const own = marks.run.isInSet(piece.node.marks)

				return own === undefined ? properties : own.addToSet(properties)
			},
			PLAIN
		)
	}

	const paragraph = painter.paragraph

	if (paragraph !== null) setAttrs(tr, selectedParagraphs(state), () => paragraph)

	const done = session.dispatch(tr)

	if (done && !painter.sticky) context.editor.setPainter(undefined)

	return done
}

function painterEnabled(context: DocumentCommandContext): boolean {
	return !context.session.readOnly && touchesParagraph(context.session.state)
}

const COPY: DocumentCommandHandler<"format.copy"> = {
	enabled: painterEnabled,
	run: (context, command) => copyFormat(context, command.sticky === true)
}

const PASTE: DocumentCommandHandler<"format.paste"> = {
	enabled: context => context.editor.painter !== undefined && painterEnabled(context),
	run: pasteFormat
}

// ---- handlers ------------------------------------------------------------------------------------------

function runHandler<T extends FormattingCommand["type"]>(
	plan: (context: StoryCommandContext, command: Cmd<T>) => readonly MarkChange[] | ((ats: readonly RunAt[]) => readonly MarkChange[])
): StoryCommandHandler<T> {
	return {
		enabled: writable,
		run(context, command) {
			const changes = plan(context, command as Cmd<T>)

			return runCommand(context, typeof changes === "function" ? changes : () => changes)
		}
	}
}

function storyHandler<T extends FormattingCommand["type"]>(
	run: (context: StoryCommandContext, command: Cmd<T>) => Transaction | null,
	enabled: (context: StoryCommandContext) => boolean = writable
): StoryCommandHandler<T> {
	return { enabled, run: (context, command) => run(context, command as Cmd<T>) }
}

const step = (up: boolean): MarkChange => ({ type: marks.size, next: at => sizeMark(at, steppedSize(at.values.size, up)) })
// font.growPoint and font.shrinkPoint: one point, within the sizes Word accepts.
const pointStep = (up: boolean): MarkChange => ({
	type: marks.size,
	next: at => sizeMark(at, Math.min(MAX_HALF_POINTS, Math.max(SMALL_STEP, at.values.size + (up ? SMALL_STEP : -SMALL_STEP))))
})

export const FORMATTING_HANDLERS: FeatureHandlers = {
	story: {
		"format.superscript": runHandler(() => vertAlign("superscript")),
		"format.subscript": runHandler(() => vertAlign("subscript")),
		"format.doubleStrike": runHandler(() => toggleValue("doubleStrike", "strike")),
		"format.smallCaps": runHandler(() => toggleValue("smallCaps", "caps")),
		"format.allCaps": runHandler(() => toggleValue("caps", "smallCaps")),
		"format.doubleUnderline": runHandler(() => doubleUnderline),
		"format.changeCase": storyHandler(changeCase),
		"format.clearAll": storyHandler(clearAll),
		"font.family": runHandler<"font.family">((context, command) => [fontChange(context.context, command.family)]),
		"font.size": runHandler<"font.size">((_context, command) => [{ type: marks.size, next: at => sizeMark(at, command.halfPoints) }]),
		"font.grow": runHandler(() => [step(true)]),
		"font.shrink": runHandler(() => [step(false)]),
		"font.growPoint": runHandler(() => [pointStep(true)]),
		"font.shrinkPoint": runHandler(() => [pointStep(false)]),
		"font.spacing": runHandler<"font.spacing">((_context, command) => [spacingChange(command.twips)]),
		"color.text": runHandler<"color.text">((context, command) => [colorChange(context.context, command.color)]),
		"color.highlight": runHandler<"color.highlight">((_context, command) => [highlightChange(command.name)]),
		"paragraph.indent": storyHandler(indent),
		"paragraph.hangingIndent": storyHandler(hangingIndent),
		"paragraph.spacing": storyHandler<"paragraph.spacing">(spacing, writable),
		"paragraph.lineSpacing": storyHandler<"paragraph.lineSpacing">(spacing, writable)
	},
	document: {
		"format.copy": COPY,
		"format.paste": PASTE
	}
}
