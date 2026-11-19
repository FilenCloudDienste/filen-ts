import { Fragment, Slice, type Node, type ResolvedPos } from "prosemirror-model"
import { AllSelection, TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import { canJoin } from "prosemirror-transform"
import type { Action, Bullet, ParaProps, RunProps } from "../../model"
import { NO_ORIGIN, RUN_MARK, presentationTextSchema, runPropsOf } from "../../text/schema"
import { presentationHref, xmlSafeText } from "../xmlText"

// Text commands over the editing schema (core/presentation/text/schema.ts): what the keyboard and the ribbon do to
// the body being edited, as ProseMirror transactions on the page's editor state. The same commands format a whole
// shape that is selected but not being edited: a state over its body with everything selected (stateOver).
//
// Run properties are a:rPr as written; what a run shows is its own rPr over its paragraph's level defaults (the
// inheritance chain, resolved by the worker and handed over in the TextSeed): `TextDefaults` gives those, so a
// toggle knows whether bold is on where the run says nothing.

export interface TextDefaults {
	// The paragraph properties of `level` along the chain (bullets, alignment, indents), defRPr included.
	paragraph(level: number): ParaProps
}

export const NO_DEFAULTS: TextDefaults = { paragraph: () => ({}) }

// A run property change: a value sets it, null removes it (the run inherits again).
export type RunPatch = { readonly [K in keyof RunProps]?: RunProps[K] | null }
export type ParaPatch = { readonly [K in keyof ParaProps]?: ParaProps[K] | null }

export type TextCommand = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean

function patched<T extends object>(props: T, patch: { readonly [K in keyof T]?: T[K] | null }): T {
	const out: Record<string, unknown> = { ...(props as Record<string, unknown>) }

	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete out[key]
		else if (value !== undefined) out[key] = value
	}

	return out as T
}

export function levelOf(paragraph: Node): number {
	return Math.max(0, Math.min(8, ((paragraph.attrs["pPr"] as ParaProps | undefined)?.lvl ?? 0) | 0))
}

// What a paragraph shows: its own pPr over its level's defaults.
export function effectiveParaProps(paragraph: Node, defaults: TextDefaults): ParaProps {
	return { ...defaults.paragraph(levelOf(paragraph)), ...(paragraph.attrs["pPr"] as ParaProps) }
}

// What a run shows: its rPr over its paragraph's level defaults.
export function effectiveRunProps(rPr: RunProps, paragraph: Node, defaults: TextDefaults): RunProps {
	return { ...(defaults.paragraph(levelOf(paragraph)).defRPr ?? {}), ...rPr }
}

// The word around an empty selection, or undefined at a word's edge or outside one: PowerPoint formats the word the
// caret is in. A word is a run of letters, digits, underscores and apostrophes (each with the marks after it), split
// further where the engine's word segmenter separates two words (Chinese, Japanese, Thai: scripts written without
// spaces).
function wordAround($pos: ResolvedPos): { readonly from: number; readonly to: number } | undefined {
	const parent = $pos.parent

	if (!parent.isTextblock) return undefined

	const text = parent.textBetween(0, parent.content.size, undefined, "￼")
	const offset = $pos.parentOffset
	const start = wordRunStart(text, offset)
	const end = wordRunEnd(text, offset)

	if (start === offset || end === offset) return undefined

	let from = start
	let to = end

	for (const split of wordSplits(text, start, end)) {
		if (split === offset) return undefined

		if (split < offset) {
			from = split
		} else {
			to = split

			break
		}
	}

	return { from: $pos.start() + from, to: $pos.start() + to }
}

// The local rPr at a caret: the stored marks, else the run before it, else the paragraph mark's.
export function caretRunProps(state: EditorState): RunProps {
	const $from = state.selection.$from
	const marks = state.storedMarks ?? $from.marks()

	return runPropsOf(marks, $from.parent.attrs["endRPr"] as RunProps | null)
}

// Every run in [from, to) mapped through `map` (given its local and shown props); atoms' rPr too. Paragraph marks of
// paragraphs whose end lies inside the range (or that are empty and touched) follow.
function mapRuns(
	tr: Transaction,
	from: number,
	to: number,
	defaults: TextDefaults,
	map: (local: RunProps, shown: RunProps) => RunProps
): void {
	const doc = tr.doc
	const edits: { readonly from: number; readonly to: number; readonly rPr: RunProps }[] = []
	const atoms: { readonly pos: number; readonly node: Node; readonly rPr: RunProps }[] = []
	const marks: { readonly pos: number; readonly node: Node; readonly endRPr: RunProps }[] = []

	doc.nodesBetween(from, to, (node, pos, parent) => {
		if (node.type.name === "paragraph") {
			const end = pos + node.nodeSize - 1

			if ((end <= to && end >= from) || node.content.size === 0) {
				const endRPr = (node.attrs["endRPr"] as RunProps | null) ?? {}

				marks.push({ pos, node, endRPr: map(endRPr, effectiveRunProps(endRPr, node, defaults)) })
			}

			return true
		}

		if (parent === null) return true

		if (node.isText) {
			const local = runPropsOf(node.marks, parent.attrs["endRPr"] as RunProps | null)

			edits.push({
				from: Math.max(from, pos),
				to: Math.min(to, pos + node.nodeSize),
				rPr: map(local, effectiveRunProps(local, parent, defaults))
			})
		} else if (node.type.name === "br" || node.type.name === "field") {
			const local = node.attrs["rPr"] as RunProps

			atoms.push({ pos, node, rPr: map(local, effectiveRunProps(local, parent, defaults)) })
		}

		return false
	})

	for (const edit of edits) if (edit.from < edit.to) tr.addMark(edit.from, edit.to, RUN_MARK.create({ rPr: edit.rPr }))
	for (const atom of atoms) tr.setNodeMarkup(atom.pos, undefined, { ...atom.node.attrs, rPr: atom.rPr })
	for (const mark of marks) tr.setNodeMarkup(mark.pos, undefined, { ...tr.doc.nodeAt(mark.pos)?.attrs, endRPr: mark.endRPr })
}

// Maps the run properties of the selection (the word around a caret; else what is typed next).
export function mapRunProps(defaults: TextDefaults, map: (local: RunProps, shown: RunProps) => RunProps): TextCommand {
	return (state, dispatch) => {
		const selection = state.selection
		let { from, to } = selection

		if (selection.empty) {
			const word = wordAround(selection.$from)

			if (word === undefined) {
				if (dispatch !== undefined) {
					const $from = selection.$from
					const local = caretRunProps(state)
					const next = map(local, effectiveRunProps(local, $from.parent, defaults))
					const tr = state.tr.setStoredMarks([RUN_MARK.create({ rPr: next })])

					// An empty paragraph's mark is what it shows (and what PowerPoint saves for it).
					if ($from.parent.content.size === 0)
						tr.setNodeMarkup($from.before(), undefined, { ...$from.parent.attrs, endRPr: next })

					dispatch(tr)
				}

				return true
			}

			from = word.from
			to = word.to
		}

		if (dispatch !== undefined) {
			const tr = state.tr

			mapRuns(tr, from, to, defaults, map)
			dispatch(tr.setSelection(selection.map(tr.doc, tr.mapping)))
		}

		return true
	}
}

export function setRunProps(patch: RunPatch, defaults: TextDefaults = NO_DEFAULTS): TextCommand {
	return mapRunProps(defaults, local => patched(local, patch))
}

// The shown run properties over the selection (or at the caret): each property's value where every run agrees,
// undefined where they differ.
export function selectionRunProps(state: EditorState, defaults: TextDefaults): Partial<RunProps> {
	const selection = state.selection

	if (selection.empty) {
		const local = caretRunProps(state)

		return effectiveRunProps(local, selection.$from.parent, defaults)
	}

	let agreed: Record<string, unknown> | undefined
	const differs = new Set<string>()

	state.doc.nodesBetween(selection.from, selection.to, (node, _pos, parent) => {
		if (!node.isText || parent === null) return true

		const shown = effectiveRunProps(runPropsOf(node.marks, parent.attrs["endRPr"] as RunProps | null), parent, defaults) as Record<
			string,
			unknown
		>

		if (agreed === undefined) {
			agreed = { ...shown }

			return false
		}

		for (const key of new Set([...Object.keys(agreed), ...Object.keys(shown)])) {
			if (!differs.has(key) && JSON.stringify(agreed[key]) !== JSON.stringify(shown[key])) differs.add(key)
		}

		return false
	})

	if (agreed === undefined) return effectiveRunProps(caretRunProps(state), selection.$from.parent, defaults)

	for (const key of differs) delete agreed[key]

	return agreed as Partial<RunProps>
}

// Bold, italic: on everywhere when any run of the selection shows it off (PowerPoint's toggle), else off.
export function toggleRunFlag(flag: "b" | "i", defaults: TextDefaults = NO_DEFAULTS): TextCommand {
	return (state, dispatch) => {
		const on = selectionRunProps(state, defaults)[flag] === true

		return mapRunProps(defaults, local => ({ ...local, [flag]: !on }))(state, dispatch)
	}
}

export function toggleUnderline(defaults: TextDefaults = NO_DEFAULTS, kind: NonNullable<RunProps["u"]> = "sng"): TextCommand {
	return (state, dispatch) => {
		const shown = selectionRunProps(state, defaults).u
		const on = shown !== undefined && shown !== "none"

		return mapRunProps(defaults, local => ({ ...local, u: on && shown === kind ? "none" : kind }))(state, dispatch)
	}
}

export function toggleStrike(defaults: TextDefaults = NO_DEFAULTS, kind: "sngStrike" | "dblStrike" = "sngStrike"): TextCommand {
	return (state, dispatch) => {
		const shown = selectionRunProps(state, defaults).strike

		return mapRunProps(defaults, local => ({ ...local, strike: shown === kind ? "noStrike" : kind }))(state, dispatch)
	}
}

// Superscript (30%) and subscript (−25%), PowerPoint's offsets; again removes it.
export function toggleBaseline(kind: "super" | "sub", defaults: TextDefaults = NO_DEFAULTS): TextCommand {
	const value = kind === "super" ? 30_000 : -25_000

	return (state, dispatch) => {
		const shown = selectionRunProps(state, defaults).baseline

		return mapRunProps(defaults, local => {
			const { baseline: _old, ...rest } = local

			return shown === value ? rest : { ...rest, baseline: value }
		})(state, dispatch)
	}
}

// PowerPoint's font size list (points): Increase and Decrease Font Size step through it.
export const FONT_SIZES: readonly number[] = [
	8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96
]

const DEFAULT_SIZE = 1800

// A size one step up or down the list from `points` (past its ends: by 10 points, at least 1).
export function steppedSize(points: number, direction: 1 | -1): number {
	if (direction === 1) {
		const next = FONT_SIZES.find(size => size > points + 1e-9)

		return next ?? Math.min(4000, Math.floor(points / 10) * 10 + 10)
	}

	const previous = [...FONT_SIZES].reverse().find(size => size < points - 1e-9)

	return previous ?? Math.max(1, Math.ceil(points / 10) * 10 - 10)
}

export function stepFontSize(direction: 1 | -1, defaults: TextDefaults = NO_DEFAULTS): TextCommand {
	return mapRunProps(defaults, (local, shown) => ({
		...local,
		sz: Math.round(steppedSize((shown.sz ?? DEFAULT_SIZE) / 100, direction) * 100)
	}))
}

// Clear All Formatting: runs keep only their language.
export function clearFormatting(defaults: TextDefaults = NO_DEFAULTS): TextCommand {
	return mapRunProps(defaults, local => ({
		...(local.lang === undefined ? {} : { lang: local.lang }),
		...(local.altLang === undefined ? {} : { altLang: local.altLang })
	}))
}

// A link on the selected text: a URL (http, https or mailto, §1.11.1; stored as the save proof's classifier reads it,
// presentationHref) or a slide; undefined removes it.
export function setHyperlink(link: Action | undefined, defaults: TextDefaults = NO_DEFAULTS): TextCommand {
	const action = link === undefined ? undefined : linkable(link)

	if (action === null) return () => false

	return (state, dispatch) => {
		if (state.selection.empty && wordAround(state.selection.$from) === undefined) return false

		return mapRunProps(defaults, local => {
			const { hlinkClick: _old, ...rest } = local

			return action === undefined ? rest : { ...rest, hlinkClick: action }
		})(state, dispatch)
	}
}

const MAX_HREF = 2048

// The link as the deck stores it, or null when it may not carry it.
function linkable(action: Action): Action | null {
	if (action.kind === "url") {
		const href = presentationHref(action.href)

		return href === undefined || href.length > MAX_HREF ? null : { kind: "url", href }
	}

	return action.kind === "slide" || action.kind === "internal" ? action : null
}

// Paragraphs touching the selection.
function selectedParagraphs(state: EditorState): { readonly pos: number; readonly node: Node }[] {
	const out: { pos: number; node: Node }[] = []
	const { from, to } = state.selection

	state.doc.nodesBetween(from, to, (node, pos) => {
		if (node.type.name !== "paragraph") return true

		out.push({ pos, node })

		return false
	})

	return out
}

export function mapParaProps(defaults: TextDefaults, map: (local: ParaProps, shown: ParaProps) => ParaProps): TextCommand {
	return (state, dispatch) => {
		const paragraphs = selectedParagraphs(state)

		if (paragraphs.length === 0) return false

		if (dispatch !== undefined) {
			const tr = state.tr

			for (const { pos, node } of paragraphs) {
				const local = node.attrs["pPr"] as ParaProps

				tr.setNodeMarkup(pos, undefined, { ...node.attrs, pPr: map(local, effectiveParaProps(node, defaults)) })
			}

			dispatch(tr)
		}

		return true
	}
}

export function setParaProps(patch: ParaPatch, defaults: TextDefaults = NO_DEFAULTS): TextCommand {
	return mapParaProps(defaults, local => patched(local, patch))
}

// The shown paragraph properties of the selection, each where every paragraph agrees.
export function selectionParaProps(state: EditorState, defaults: TextDefaults): Partial<ParaProps> {
	let agreed: Record<string, unknown> | undefined

	for (const { node } of selectedParagraphs(state)) {
		const shown = effectiveParaProps(node, defaults) as Record<string, unknown>

		if (agreed === undefined) {
			agreed = { ...shown }
			continue
		}

		for (const key of Object.keys(agreed)) if (JSON.stringify(agreed[key]) !== JSON.stringify(shown[key])) delete agreed[key]
	}

	return (agreed ?? {}) as Partial<ParaProps>
}

// PowerPoint's hanging indent for a bullet added to text with none (0.375 inch, EMU).
const BULLET_INDENT = 342_900
// One list level's step when a paragraph holds its own indents (0.5 inch, EMU).
const LEVEL_STEP = 457_200

export const DEFAULT_BULLET: Bullet = { kind: "char", char: "•" }
export const DEFAULT_NUMBERING: Bullet = { kind: "autoNum", scheme: "arabicPeriod" }

function sameBulletKind(a: Bullet | undefined, b: Bullet): boolean {
	if (a === undefined) return false
	if (a.kind !== b.kind) return false
	if (a.kind === "autoNum" && b.kind === "autoNum") return a.scheme === b.scheme

	return true
}

// Bullets or numbering on the selected paragraphs; the same kind again (or `undefined`) turns them off, as the
// ribbon's toggles do. A paragraph without an indent of its own gets PowerPoint's hanging indent.
export function setBullet(bullet: Bullet | undefined, defaults: TextDefaults = NO_DEFAULTS, font?: string): TextCommand {
	return (state, dispatch) => {
		const shown = selectedParagraphs(state).map(({ node }) => effectiveParaProps(node, defaults).bullet)
		const off = bullet === undefined || shown.every(item => sameBulletKind(item, bullet))

		return mapParaProps(defaults, (local, effective) => {
			const { bullet: _old, buFont: _font, ...rest } = local

			// Off: the hanging indent the bullet hung in goes with it (PowerPoint writes marL="0" indent="0" with buNone).
			if (off) return { ...rest, bullet: { kind: "none" }, ...((effective.indent ?? 0) < 0 ? { marL: 0, indent: 0 } : {}) }

			const next: ParaProps = { ...rest, bullet: bullet as Bullet, ...(font === undefined ? {} : { buFont: { typeface: font } }) }

			if ((effective.marL ?? 0) === 0 && (effective.indent ?? 0) === 0)
				return { ...next, marL: BULLET_INDENT, indent: -BULLET_INDENT }

			return next
		})(state, dispatch)
	}
}

// Increase or decrease the list level (Tab and Shift+Tab at a paragraph's start; the ribbon's buttons).
export function changeLevel(direction: 1 | -1, defaults: TextDefaults = NO_DEFAULTS): TextCommand {
	return (state, dispatch) => {
		const paragraphs = selectedParagraphs(state)

		if (paragraphs.every(({ node }) => levelOf(node) === (direction === 1 ? 8 : 0))) return false

		return mapParaProps(defaults, local => {
			const current = Math.max(0, Math.min(8, (local.lvl ?? 0) | 0))
			const level = Math.max(0, Math.min(8, current + direction))

			// Already at the limit: neither the level nor its own indents move.
			if (level === current) return local

			const next: ParaProps = { ...local, lvl: level }

			// Own indents move with the level; inherited ones come from the level's style.
			if (local.marL !== undefined) return { ...next, marL: Math.max(0, local.marL + direction * LEVEL_STEP) }

			return level === 0 ? (({ lvl: _lvl, ...rest }) => rest)(next) : next
		})(state, dispatch)
	}
}

// Enter: a new paragraph with the same properties; the new one names no source paragraph.
export const splitParagraph: TextCommand = (state, dispatch) => {
	const { $from, $to } = state.selection

	if (!$from.parent.isTextblock || $from.depth !== 1 || $to.depth !== 1) return false

	if (dispatch !== undefined) {
		const tr = state.tr

		if (!state.selection.empty) tr.deleteSelection()

		const $pos = tr.selection.$from
		const marks = state.storedMarks ?? $pos.marks()
		const paragraph = $pos.parent

		tr.split($pos.pos, 1, [{ type: paragraph.type, attrs: { ...paragraph.attrs, origin: NO_ORIGIN } }])
		tr.setStoredMarks(marks.length === 0 ? null : marks)
		dispatch(tr.scrollIntoView())
	}

	return true
}

// Shift+Enter: a line break (a:br) in the paragraph, with the caret's run properties.
export const insertLineBreak: TextCommand = (state, dispatch) => {
	if (dispatch !== undefined) {
		const rPr = caretRunProps(state)
		const marks = state.storedMarks ?? state.selection.$from.marks()

		dispatch(
			state.tr
				.replaceSelectionWith(presentationTextSchema.nodes.br.create({ rPr }), false)
				.setStoredMarks(marks.length === 0 ? null : marks)
				.scrollIntoView()
		)
	}

	return true
}

// Tab: a level down at a paragraph's start or over several paragraphs (PowerPoint), else a tab character.
export function tabKey(direction: 1 | -1, defaults: TextDefaults = NO_DEFAULTS): TextCommand {
	return (state, dispatch) => {
		const { $from, $to, empty } = state.selection
		const atStart = empty && $from.parentOffset === 0
		const across = $from.parent !== $to.parent

		if (direction === -1 || atStart || across) return changeLevel(direction, defaults)(state, dispatch) || direction === 1

		dispatch?.(state.tr.insertText("\t").scrollIntoView())

		return true
	}
}

// Backspace at a paragraph's start: joined to the one before (an indented paragraph goes up a level first, as in
// PowerPoint's lists).
export function backspaceAtStart(defaults: TextDefaults = NO_DEFAULTS): TextCommand {
	return (state, dispatch) => {
		const { $from, empty } = state.selection

		if (!empty || $from.parentOffset !== 0 || $from.depth !== 1) return false
		if (levelOf($from.parent) > 0) return changeLevel(-1, defaults)(state, dispatch)

		const before = $from.before()

		if ($from.index(0) === 0 || !canJoin(state.doc, before)) return true

		dispatch?.(state.tr.join(before).scrollIntoView())

		return true
	}
}

export const deleteAtEnd: TextCommand = (state, dispatch) => {
	const { $from, empty } = state.selection

	if (!empty || $from.parentOffset !== $from.parent.content.size || $from.depth !== 1) return false

	const after = $from.after()

	if ($from.index(0) >= state.doc.childCount - 1 || !canJoin(state.doc, after)) return true

	dispatch?.(state.tr.join(after).scrollIntoView())

	return true
}

export const selectAllText: TextCommand = (state, dispatch) => {
	dispatch?.(state.tr.setSelection(new AllSelection(state.doc)))

	return true
}

// Alt+Shift+Up/Down: the paragraphs the selection touches swap places with the one before or after them, in one
// step, the selection moving with them; false at the body's edge.
export function moveParagraphs(direction: 1 | -1): TextCommand {
	return (state, dispatch) => {
		const { doc, selection } = state
		const { $from, $to } = selection
		const first = $from.index(0)
		const last = Math.min(doc.childCount - 1, $to.depth === 0 && $to.index(0) > first ? $to.index(0) - 1 : $to.index(0))
		const other = direction === -1 ? first - 1 : last + 1

		if (other < 0 || other >= doc.childCount || last < first) return false

		if (dispatch !== undefined) {
			let start = 0

			for (let index = 0; index < first; index++) start += doc.child(index).nodeSize

			let end = start

			for (let index = first; index <= last; index++) end += doc.child(index).nodeSize

			const moved = doc.child(other)
			const size = moved.nodeSize
			const tr =
				direction === -1
					? state.tr.delete(start - size, start).insert(end - size, moved)
					: state.tr.delete(end, end + size).insert(start, moved)
			const shift = direction === -1 ? -size : size

			tr.setSelection(TextSelection.create(tr.doc, selection.anchor + shift, selection.head + shift))
			dispatch(tr.scrollIntoView())
		}

		return true
	}
}

// A state over a whole body with everything selected: formatting a selected shape that is not being edited.
export function selectAllIn(state: EditorState): EditorState {
	return state.apply(state.tr.setSelection(new AllSelection(state.doc)))
}

// Pasted content, sanitized to <p>/<pre> blocks of text, <br>, tabs and b/i/u/s (react/docx/edit/clipboard.ts
// safeClipboardHtml), read as paragraphs whose runs take the caret's run properties with those flags on top.
export interface PastedElement {
	readonly nodeName: string
	readonly nodeType: number
	readonly textContent: string | null
	readonly childNodes: ArrayLike<PastedElement>
	hasAttribute?(name: string): boolean
}

const PASTE_FLAGS: Readonly<Record<string, RunPatch>> = {
	B: { b: true },
	STRONG: { b: true },
	I: { i: true },
	EM: { i: true },
	U: { u: "sng" },
	S: { strike: "sngStrike" }
}

export function pastedSlice(body: PastedElement, base: RunProps, endRPr: RunProps | null): Slice {
	const schema = presentationTextSchema
	const paragraphs: Node[] = []

	const inline = (element: PastedElement, rPr: RunProps, out: Node[]): void => {
		for (let index = 0; index < element.childNodes.length; index++) {
			const child = element.childNodes[index] as PastedElement

			if (child.nodeType === 3) {
				pastedText((child.textContent ?? "").replace(/[\r\n]+/gu, " "), rPr, out)
			} else if (child.nodeName === "BR") {
				out.push(schema.nodes.br.create({ rPr }))
			} else if (child.nodeName === "SPAN" && child.hasAttribute?.("data-fo-tab") === true) {
				out.push(schema.text("\t", [RUN_MARK.create({ rPr })]))
			} else {
				const flag = PASTE_FLAGS[child.nodeName]

				inline(child, flag === undefined ? rPr : patched(rPr, flag), out)
			}
		}
	}

	for (let index = 0; index < body.childNodes.length; index++) {
		const block = body.childNodes[index] as PastedElement
		const content: Node[] = []

		inline(block, base, content)
		paragraphs.push(schema.nodes.paragraph.create({ endRPr }, content))
	}

	if (paragraphs.length === 0) return Slice.empty

	// One pasted block joins the paragraph it lands in; more split it.
	return new Slice(Fragment.from(paragraphs), 1, 1)
}

// Pasted text as inline nodes: U+000B (the line break PowerPoint and Word put on the clipboard) as a:br, and what XML
// cannot carry taken out (xmlSafeText), so a paste never holds text the worker refuses.
function pastedText(text: string, rPr: RunProps, out: Node[]): void {
	const schema = presentationTextSchema
	const pieces = text.split("\u000b")

	pieces.forEach((piece, index) => {
		if (index > 0) out.push(schema.nodes.br.create({ rPr }))

		const safe = xmlSafeText(piece)

		if (safe.length > 0) out.push(schema.text(safe, [RUN_MARK.create({ rPr })]))
	})
}

// Plain text pasted: lines become paragraphs, with the caret's run properties.
export function plainTextSlice(text: string, base: RunProps, endRPr: RunProps | null): Slice {
	const schema = presentationTextSchema
	const lines = text.replace(/\r\n?/gu, "\n").split("\n")
	const paragraphs = lines.map(line => {
		const content: Node[] = []

		pastedText(line, base, content)

		return schema.nodes.paragraph.create({ endRPr }, content)
	})

	return new Slice(Fragment.from(paragraphs), 1, 1)
}

// One word character's base, a whole code point (sticky: tested at lastIndex), and a mark. A mark (Thai vowels and
// tones, combining accents) belongs to a word only after a word base: one after a symbol (an emoji's variation
// selector, a keycap) is not a word character, so a word never starts or ends inside a grapheme cluster.
const WORD_BASE = /[\p{L}\p{N}_'’]/uy
const MARK = /\p{M}/uy

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff
}

// The start of the code point ending at `at` (> 0).
function codePointBefore(text: string, at: number): number {
	return at >= 2 && isLowSurrogate(text.charCodeAt(at - 1)) && isHighSurrogate(text.charCodeAt(at - 2)) ? at - 2 : at - 1
}

function isMark(text: string, at: number): boolean {
	MARK.lastIndex = at

	return MARK.test(text)
}

// The end of the word character (a word base with the marks after it) starting at `at`, or `at` where none does.
function wordCharEnd(text: string, at: number): number {
	WORD_BASE.lastIndex = at

	if (!WORD_BASE.test(text)) return at

	let end = WORD_BASE.lastIndex

	while (isMark(text, end)) end = MARK.lastIndex

	return end
}

// The start of the word character ending at `at`, or `at` where none does.
function wordCharStart(text: string, at: number): number {
	if (at === 0) return at

	let base = codePointBefore(text, at)

	while (base > 0 && isMark(text, base)) base = codePointBefore(text, base)

	return wordCharEnd(text, base) === at ? base : at
}

// The bounds of the run of word characters around `at`.
function wordRunStart(text: string, at: number): number {
	for (let previous = wordCharStart(text, at); previous !== at; previous = wordCharStart(text, at)) at = previous

	return at
}

function wordRunEnd(text: string, at: number): number {
	for (let next = wordCharEnd(text, at); next !== at; next = wordCharEnd(text, at)) at = next

	return at
}

// null: the engine has no Intl.Segmenter (a run of word characters is then one word).
let words: Intl.Segmenter | null | undefined

function wordSegmenter(): Intl.Segmenter | null {
	if (words === undefined) {
		const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter

		words = Segmenter === undefined ? null : new Segmenter(undefined, { granularity: "word" })
	}

	return words
}

// The offsets inside the word run [from, to) where the segmenter puts two words side by side (UAX #29 with the
// engine's dictionaries for scripts without spaces). Only word-like neighbours split the run, so an apostrophe or an
// underscore the segmenter leaves apart still belongs to the word as before.
function wordSplits(text: string, from: number, to: number): number[] {
	const segmenter = wordSegmenter()
	const splits: number[] = []

	if (segmenter === null) return splits

	let previousWordLike = false

	for (const segment of segmenter.segment(text.slice(from, to))) {
		const wordLike = segment.isWordLike === true

		if (segment.index > 0 && previousWordLike && wordLike) splits.push(from + segment.index)

		previousWordLike = wordLike
	}

	return splits
}

// null: the engine has no Intl.Segmenter (steps then go by code point).
let graphemes: Intl.Segmenter | null | undefined

function graphemeSegmenter(): Intl.Segmenter | null {
	if (graphemes === undefined) {
		const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter

		graphemes = Segmenter === undefined ? null : new Segmenter(undefined, { granularity: "grapheme" })
	}

	return graphemes
}

// The offset one user-perceived character (an extended grapheme cluster, UAX #29: a letter with its marks, a flag, an
// emoji ZWJ sequence) from `offset` in `text`.
function characterStep(text: string, offset: number, direction: 1 | -1): number {
	const segmenter = graphemeSegmenter()

	if (segmenter !== null) {
		const segment = segmenter.segment(text).containing(direction === 1 ? offset : offset - 1)

		if (segment !== undefined) return direction === 1 ? segment.index + segment.segment.length : segment.index
	}

	const next = offset + direction
	const code = text.charCodeAt(direction === 1 ? next : offset - 1)

	// One step over a pair: forward past its low half, backward from after it.
	if (direction === 1 && next < text.length && isLowSurrogate(code)) return next + 1
	if (direction === -1 && offset - 2 >= 0 && isLowSurrogate(code)) return offset - 2

	return next
}

// The position one character (a grapheme cluster whole, an atom whole) or one word from `pos` in `direction`, across
// paragraph ends.
function stepFrom(doc: Node, pos: number, direction: 1 | -1, unit: "char" | "word"): number {
	const $pos = doc.resolve(pos)
	const paragraph = $pos.parent
	const start = $pos.start()
	const offset = $pos.parentOffset

	if (direction === -1 && offset === 0) return $pos.index(0) === 0 ? pos : pos - 2
	if (direction === 1 && offset === paragraph.content.size) return $pos.index(0) >= doc.childCount - 1 ? pos : pos + 2

	const text = paragraph.textBetween(0, paragraph.content.size, undefined, "￼")

	if (unit === "char") return start + characterStep(text, offset, direction)

	let at = offset

	if (direction === 1) {
		while (at < text.length && wordCharEnd(text, at) === at) at++

		const end = wordRunEnd(text, at)

		return start + (wordSplits(text, wordRunStart(text, at), end).find(split => split > at) ?? end)
	}

	while (at > 0 && wordCharStart(text, at) === at) at--

	const from = wordRunStart(text, at)

	return start + (wordSplits(text, from, wordRunEnd(text, at)).findLast(split => split < at) ?? from)
}

// Left and Right (Alt or Ctrl: by word), Shift extending: moves made on the document's logical positions, so a key
// held down never races the sink's own selection.
export function horizontalMove(direction: 1 | -1, unit: "char" | "word", extend: boolean): TextCommand {
	return (state, dispatch) => {
		const selection = state.selection
		let anchor = selection.anchor
		let head: number

		if (!extend && !selection.empty && unit === "char") {
			head = direction === 1 ? selection.to : selection.from
		} else {
			head = stepFrom(state.doc, selection.head, direction, unit)
		}

		if (!extend) anchor = head

		dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, anchor, head)).scrollIntoView())

		return true
	}
}
