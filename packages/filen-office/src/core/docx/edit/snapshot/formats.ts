import type { Mark, Node } from "prosemirror-model"
import type { EditorState } from "prosemirror-state"
import type { ParagraphFormat } from "../../styles/index"
import type { DocxHighlightColor, DocxLineSpacingRule } from "../commands/formatting"
import { caretMarks, type FormatResolver, type RunValues } from "../formats"
import { docxSchema, inlineLevel } from "../schema"
import type { SnapshotInput } from "./index"

// Formatting values of the selection (font, size, colours, spacing, indents): one value, "mixed" when the
// selection holds several, null where there is nothing to tell. Counted additively over the selection like
// the toggles (by distinct formatting, which few runs differ in), so a growing selection costs its
// difference; the same object while the answer is the same.

export type DocxFormatValue = "on" | "off" | "mixed"

export interface DocxLineSpacingValue {
	readonly rule: DocxLineSpacingRule
	// "auto": 240ths of a line; else twips.
	readonly value: number
}

// Twips.
export interface DocxParagraphSpacingValue {
	readonly before: number
	readonly after: number
}

// Twips; firstLine and hanging as the paragraph dialog shows them (one of the two is 0).
export interface DocxIndentValue {
	readonly start: number
	readonly end: number
	readonly firstLine: number
	readonly hanging: number
}

export interface DocxValuesSnapshot {
	// The font of the content's script.
	readonly font: string | "mixed" | null
	// Half-points.
	readonly size: number | "mixed" | null
	// "auto", "RRGGBB" or "theme:<name>" (with "/tint:<n>" or "/shade:<n>") as the direct colour says; what
	// the styles give is "auto" or "RRGGBB".
	readonly color: string | "mixed" | null
	// The colour shown, "auto" or "RRGGBB" (a swatch).
	readonly colorRgb: string | "mixed" | null
	readonly highlight: DocxHighlightColor | "mixed" | null
	readonly vertAlign: "baseline" | "superscript" | "subscript" | "mixed" | null
	readonly doubleStrike: DocxFormatValue | null
	readonly smallCaps: DocxFormatValue | null
	readonly allCaps: DocxFormatValue | null
	// Character spacing, twips.
	readonly charSpacing: number | "mixed" | null
	readonly lineSpacing: DocxLineSpacingValue | "mixed" | null
	readonly spacing: DocxParagraphSpacingValue | "mixed" | null
	readonly indent: DocxIndentValue | "mixed" | null
}

export const NO_VALUES: DocxValuesSnapshot = Object.freeze({
	font: null,
	size: null,
	color: null,
	colorRgb: null,
	highlight: null,
	vertAlign: null,
	doubleStrike: null,
	smallCaps: null,
	allCaps: null,
	charSpacing: null,
	lineSpacing: null,
	spacing: null,
	indent: null
})

// The link at the selection: the caret's (inside a link or at its start), or the one link holding all of a
// selection. `text` is the whole link's.
export interface DocxLinkContext {
	readonly target: string | null
	readonly anchor: string | null
	readonly text: string
}

const nodes = docxSchema.nodes
const marks = docxSchema.marks

interface ParagraphValues {
	readonly lineSpacing: DocxLineSpacingValue
	readonly spacing: DocxParagraphSpacingValue
	readonly indent: DocxIndentValue
}

// What a selection holds: characters by their formatting values, paragraphs by theirs.
interface Tally {
	chars: number
	links: number
	paragraphs: number
	readonly runs: Map<RunValues, number>
	readonly paras: Map<ParagraphValues, number>
}

interface ProviderState {
	readonly formats: FormatResolver
	readonly paragraphValues: WeakMap<ParagraphFormat, ParagraphValues>
	// Equal paragraph values are one object (snapshots compare them by identity).
	readonly interned: Map<string, object>
	// Tables and content controls wholly in a selection, by node (an edit elsewhere leaves them).
	blockTallies: WeakMap<Node, Tally>
	selection: { doc: Node; from: number; to: number; tally: Tally } | null
	values: DocxValuesSnapshot
	link: { doc: Node; from: number; to: number; link: DocxLinkContext | null } | null
	// The paragraph last counted (dropped after each count).
	last: { readonly node: Node; readonly format: ParagraphFormat } | undefined
}

const STATES = new WeakMap<object, ProviderState>()

function stateOf(input: SnapshotInput): ProviderState {
	let state = STATES.get(input.session)

	if (state === undefined) {
		state = {
			formats: input.session.formats,
			paragraphValues: new WeakMap(),
			interned: new Map(),
			blockTallies: new WeakMap(),
			selection: null,
			values: NO_VALUES,
			link: null,
			last: undefined
		}
		STATES.set(input.session, state)
	}

	return state
}

function emptyTally(): Tally {
	return { chars: 0, links: 0, paragraphs: 0, runs: new Map(), paras: new Map() }
}

function bump<K>(map: Map<K, number>, key: K, by: number): void {
	const count = (map.get(key) ?? 0) + by

	if (count === 0) map.delete(key)
	else map.set(key, count)
}

function intern<T extends object>(state: ProviderState, value: T): T {
	const key = JSON.stringify(value)
	let out = state.interned.get(key) as T | undefined

	if (out === undefined) {
		out = Object.freeze(value)
		state.interned.set(key, out)
	}

	return out
}

function paragraphValues(state: ProviderState, paragraph: Node): ParagraphValues {
	const format = state.formats.paragraph(paragraph)
	let values = state.paragraphValues.get(format)

	if (values === undefined) {
		const { spacing, indent } = format.props

		values = {
			lineSpacing: intern(state, { rule: spacing.lineRule, value: spacing.line }),
			spacing: intern(state, { before: spacing.before, after: spacing.after }),
			indent: intern(state, {
				start: indent.start,
				end: indent.end,
				firstLine: Math.max(0, indent.firstLine),
				hanging: Math.max(0, -indent.firstLine)
			})
		}
		state.paragraphValues.set(format, values)
	}

	return values
}

function addParagraph(state: ProviderState, tally: Tally, node: Node, sign: number): void {
	tally.paragraphs += sign
	bump(tally.paras, paragraphValues(state, node), sign)
}

function addInline(state: ProviderState, tally: Tally, paragraph: Node, node: Node, size: number, sign: number): void {
	const formats = state.formats

	tally.chars += sign * size

	if (marks.link.isInSet(node.marks) !== undefined) tally.links += sign * size

	// Consecutive runs of one paragraph resolve its format once.
	if (state.last?.node !== paragraph) state.last = { node: paragraph, format: formats.paragraph(paragraph) }

	bump(tally.runs, formats.values(state.last.format, node.marks), sign * size)
}

function addTally(tally: Tally, add: Tally, sign: number): void {
	tally.chars += sign * add.chars
	tally.links += sign * add.links
	tally.paragraphs += sign * add.paragraphs

	for (const [key, count] of add.runs) bump(tally.runs, key, sign * count)
	for (const [key, count] of add.paras) bump(tally.paras, key, sign * count)
}

function addBlock(state: ProviderState, tally: Tally, node: Node, sign: number): void {
	if (node.type === nodes.paragraph) {
		addParagraph(state, tally, node, sign)
		node.forEach(child => {
			if (inlineLevel(child) === "run") addInline(state, tally, node, child, child.nodeSize, sign)
		})

		return
	}

	if (node.type === nodes.locked_block || node.isInline) return

	if (node.type === nodes.table || node.type === nodes.sdt) {
		let own = state.blockTallies.get(node)

		if (own === undefined) {
			own = emptyTally()

			const target = own

			node.forEach(child => addBlock(state, target, child, 1))
			state.blockTallies.set(node, own)
		}

		addTally(tally, own, sign)

		return
	}

	node.forEach(child => addBlock(state, tally, child, sign))
}

function addContaining(state: ProviderState, tally: Tally, doc: Node, pos: number, sign: number): void {
	const $pos = doc.resolve(pos)

	for (let depth = $pos.depth; depth > 0; depth--) {
		if ($pos.node(depth).type === nodes.paragraph) {
			addParagraph(state, tally, $pos.node(depth), sign)

			return
		}
	}
}

function addRange(state: ProviderState, tally: Tally, doc: Node, from: number, to: number, sign: number): void {
	if (to <= from) return

	doc.nodesBetween(from, to, (node, pos, parent) => {
		if (!node.isInline) {
			if (pos >= from && pos + node.nodeSize <= to) {
				addBlock(state, tally, node, sign)

				return false
			}

			if (node.type === nodes.paragraph && pos >= from) addParagraph(state, tally, node, sign)

			return node.type !== nodes.locked_block
		}

		if (parent !== null && parent.type === nodes.paragraph && inlineLevel(node) === "run") {
			const size = Math.min(to, pos + node.nodeSize) - Math.max(from, pos)

			if (size > 0) addInline(state, tally, parent, node, size, sign)
		}

		return false
	})
}

// The tally of a single-range selection: by its difference when only its ends moved on the same document.
function selectionTally(state: ProviderState, editor: EditorState): Tally {
	const selection = editor.selection
	const doc = editor.doc

	if (selection.ranges.length !== 1) {
		const tally = emptyTally()

		for (const range of selection.ranges) {
			addContaining(state, tally, doc, range.$from.pos, 1)
			addRange(state, tally, doc, range.$from.pos, range.$to.pos, 1)
		}

		state.selection = null

		return tally
	}

	const { from, to } = selection
	const cached = state.selection

	if (cached !== null && cached.doc === doc && cached.from === from && cached.to === to) return cached.tally

	if (cached !== null && cached.doc === doc && Math.abs(from - cached.from) + Math.abs(to - cached.to) <= to - from) {
		const tally = cached.tally

		if (from !== cached.from) {
			addContaining(state, tally, doc, cached.from, -1)
			addContaining(state, tally, doc, from, 1)

			if (from < cached.from) addRange(state, tally, doc, from, cached.from, 1)
			else addRange(state, tally, doc, cached.from, from, -1)
		}

		if (to > cached.to) addRange(state, tally, doc, cached.to, to, 1)
		else if (to < cached.to) addRange(state, tally, doc, to, cached.to, -1)

		state.selection = { doc, from, to, tally }

		return tally
	}

	const tally = emptyTally()

	addContaining(state, tally, doc, from, 1)
	addRange(state, tally, doc, from, to, 1)
	state.selection = { doc, from, to, tally }

	return tally
}

function single<K, V>(map: ReadonlyMap<K, number>, read: (key: K) => V): V | "mixed" | null {
	let out: V | undefined
	let found = false

	for (const key of map.keys()) {
		const value = read(key)

		if (!found) {
			out = value
			found = true
		} else if (value !== out) {
			return "mixed"
		}
	}

	return found ? (out as V) : null
}

function share(map: ReadonlyMap<RunValues, number>, chars: number, on: (values: RunValues) => boolean): DocxFormatValue {
	let count = 0

	for (const [values, size] of map) if (on(values)) count += size

	return count === 0 ? "off" : count === chars ? "on" : "mixed"
}

function caretValues(state: ProviderState, editor: EditorState): { run: RunValues; paragraph: ParagraphValues } | undefined {
	const $from = editor.selection.$from

	if ($from.parent.type !== nodes.paragraph) return undefined

	const marksOf: readonly Mark[] = caretMarks(editor, state.formats)

	return {
		run: state.formats.values(state.formats.paragraph($from.parent), marksOf),
		paragraph: paragraphValues(state, $from.parent)
	}
}

function computeValues(state: ProviderState, editor: EditorState): DocxValuesSnapshot {
	const caret = editor.selection.empty ? caretValues(state, editor) : undefined
	const tally = editor.selection.empty ? undefined : selectionTally(state, editor)

	// A caret drops the last selection's tally: it holds the document it counted (after a format over everything,
	// a copy of the whole document until the next selection).
	if (editor.selection.empty) state.selection = null
	let runs: ReadonlyMap<RunValues, number>
	let chars: number
	let paras: ReadonlyMap<ParagraphValues, number>

	if (tally === undefined) {
		if (caret === undefined) return NO_VALUES

		runs = new Map([[caret.run, 1]])
		chars = 1
		paras = new Map([[caret.paragraph, 1]])
	} else {
		// A selection of empty paragraphs (or atoms only) shows what typing at its start would get.
		const start = tally.chars === 0 ? caretValues(state, editor) : undefined

		runs = start === undefined ? tally.runs : new Map([[start.run, 1]])
		chars = start === undefined ? tally.chars : 1
		paras = tally.paras
	}

	const hasRuns = runs.size > 0

	return {
		font: single(runs, values => values.font),
		size: single(runs, values => values.size),
		color: single(runs, values => values.color),
		colorRgb: single(runs, values => values.colorRgb),
		highlight: single(runs, values => values.highlight),
		vertAlign: single(runs, values => values.vertAlign),
		doubleStrike: hasRuns ? share(runs, chars, values => values.doubleStrike) : null,
		smallCaps: hasRuns ? share(runs, chars, values => values.smallCaps) : null,
		allCaps: hasRuns ? share(runs, chars, values => values.caps) : null,
		charSpacing: single(runs, values => values.spacing),
		lineSpacing: single(paras, values => values.lineSpacing),
		spacing: single(paras, values => values.spacing),
		indent: single(paras, values => values.indent)
	}
}

const VALUE_KEYS = Object.keys(NO_VALUES) as (keyof DocxValuesSnapshot)[]

export function valuesOf(input: SnapshotInput): DocxValuesSnapshot {
	const state = stateOf(input)
	const values = computeValues(state, input.state)

	state.last = undefined
	const previous = state.values

	if (VALUE_KEYS.every(key => previous[key] === values[key])) return previous

	state.values = values

	return values
}

// Whether the selection holds linked content, from the last snapshot's tally when it is of this state.
export function selectionHasLink(session: object, editor: EditorState): boolean {
	const state = STATES.get(session)
	const cached = state?.selection
	const { from, to, empty } = editor.selection

	if (empty)
		return state?.link?.doc === editor.doc && state.link.from === from ? state.link.link !== null : linkMarkAt(editor) !== undefined
	if (cached !== undefined && cached !== null && cached.doc === editor.doc && cached.from === from && cached.to === to)
		return cached.tally.links > 0

	return editor.doc.rangeHasMark(from, to, marks.link)
}

// The link mark at an empty selection: inside a link or at its start.
export function linkMarkAt(editor: EditorState): Mark | undefined {
	const $from = editor.selection.$from

	return $from.parent.type === nodes.paragraph ? marks.link.isInSet($from.nodeAfter?.marks ?? []) : undefined
}

// The extent of `link` around `pos` in its paragraph: the run of children carrying it that holds `pos`.
export function linkExtent(doc: Node, pos: number, link: Mark): { from: number; to: number } {
	const $pos = doc.resolve(pos)
	let from = -1
	let at = $pos.start()
	let out = { from: pos, to: pos }

	$pos.parent.forEach(child => {
		const end = at + child.nodeSize

		if (link.isInSet(child.marks)) {
			if (from < 0) from = at
			if (from <= pos && pos <= end && out.to <= out.from) out = { from, to: end }
			else if (out.from === from) out = { from, to: end }
		} else {
			from = -1
		}

		at = end
	})

	return out
}

// The link holding the whole selection, with its extent.
export function selectedLink(editor: EditorState): { link: Mark; from: number; to: number } | undefined {
	const selection = editor.selection
	const link = selection.empty ? linkMarkAt(editor) : marks.link.isInSet(selection.$from.nodeAfter?.marks ?? [])

	if (link === undefined || selection.$from.parent !== selection.$to.parent) return undefined

	const extent = linkExtent(editor.doc, selection.from, link)

	return extent.to >= selection.to ? { link, ...extent } : undefined
}

export function linkOf(input: SnapshotInput): DocxLinkContext | null {
	const state = stateOf(input)
	const editor = input.state
	const { from, to } = editor.selection
	const cached = state.link

	if (cached !== null && cached.doc === editor.doc && cached.from === from && cached.to === to) return cached.link

	const found = selectedLink(editor)
	let link: DocxLinkContext | null = null

	if (found !== undefined) {
		const next: DocxLinkContext = {
			target: (found.link.attrs["target"] as string | null) ?? null,
			anchor: (found.link.attrs["anchor"] as string | null) ?? null,
			text: editor.doc.textBetween(found.from, found.to, undefined, "\ufffc")
		}
		const previous = cached?.link ?? null

		link =
			previous !== null && previous.target === next.target && previous.anchor === next.anchor && previous.text === next.text
				? previous
				: Object.freeze(next)
	}

	state.link = { doc: editor.doc, from, to, link }

	return link
}
