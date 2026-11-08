import { Mark, type Node } from "prosemirror-model"
import { TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import type { EditorView } from "prosemirror-view"
import { RUN_FORMATTING, docxSchema } from "../../../core/docx/edit/index"
import { joinBackward, joinForward } from "../../../core/docx/paged/index"
import { insidePair } from "../../../core/docx/edit/invariants/codePoints"
import { autoLink } from "../../../core/docx/edit/handlers/insert"
import type { DocxEditorSession } from "../../../core/docx/edit/session"

// Edits over a selection, and word and line deletions, made as transactions on the document. Left to the
// browser, they change the view's DOM across run spans and ProseMirror reads the result back: it rebuilds the
// changed range with its context's marks, so the rest of the last run takes another run's formatting (and loses
// what has no DOM form: scale, kerning, position), and track changes sees the whole range as new text.

const WORD_AND_LINE_DELETES: ReadonlySet<string> = new Set([
	"deleteWordBackward",
	"deleteWordForward",
	"deleteSoftLineBackward",
	"deleteSoftLineForward",
	"deleteHardLineBackward",
	"deleteHardLineForward",
	"deleteEntireSoftLine"
])

const CHARACTER_DELETES: ReadonlySet<string> = new Set(["deleteContent", "deleteContentBackward", "deleteContentForward"])

// Backspace or Delete with a selection: the selection goes.
export function deleteSelectionKey(state: EditorState): Transaction | null {
	return state.selection.empty ? null : state.tr.deleteSelection().scrollIntoView()
}

// A composition starting over a selection: the selection goes first. With no marks stored for what comes next:
// the browser composes into the text node its selection ended in (it keeps its own range across the deletion),
// and ProseMirror's placeholder for stored marks would leave that node to be read back without its marks.
export function deleteBeforeComposition(state: EditorState): Transaction | null {
	return state.selection.empty ? null : state.tr.deleteSelection().setStoredMarks(null).scrollIntoView()
}

function ownFormatting(marks: readonly Mark[]): readonly Mark[] {
	return marks.filter(mark => RUN_FORMATTING.has(mark.type))
}

// The formatting text composed over the selection takes, as typing over it does: the first selected
// character's. Undefined for no selection.
export function selectionFormatting(state: EditorState): readonly Mark[] | undefined {
	const selection = state.selection

	if (selection.empty || !(selection instanceof TextSelection)) return undefined

	const first = state.doc.nodeAt(selection.from)

	return ownFormatting(first?.isText === true ? first.marks : (selection.$from.marksAcross(selection.$to) ?? Mark.none))
}

// The composed `text` at `from` given `formatting` (selectionFormatting), as one replacement of the composed
// text (its other marks, an insertion's under track changes, kept): joined with the composition in history.
// Null when it already has it or the text is not there.
export function composedFormatting(state: EditorState, from: number, text: string, formatting: readonly Mark[]): Transaction | null {
	const to = from + text.length

	if (text === "" || from < 0 || to > state.doc.content.size || state.doc.textBetween(from, to, undefined, "\ufffc") !== text) return null

	const first = state.doc.nodeAt(from)
	let differs = false

	state.doc.nodesBetween(from, to, node => {
		if (node.isText && !Mark.sameSet(ownFormatting(node.marks), formatting)) differs = true

		return !differs
	})

	if (first === null || !first.isText || !differs) return null

	let marks: readonly Mark[] = first.marks.filter(mark => !RUN_FORMATTING.has(mark.type))

	for (const mark of formatting) marks = mark.addToSet(marks)

	return state.tr.replaceWith(from, to, docxSchema.text(text, marks))
}

// The document range of a beforeinput's first target range, widened to whole characters (an end inside a
// surrogate pair takes the pair), or undefined when it has none, is collapsed or lies outside the view (positions
// in the view are the document's).
function targetRange(view: EditorView, event: InputEvent, doc: Node): { readonly from: number; readonly to: number } | undefined {
	const size = doc.content.size
	const ranges = typeof event.getTargetRanges === "function" ? event.getTargetRanges() : []
	const range = ranges[0]

	if (range === undefined || range.collapsed) return undefined

	try {
		const a = view.posAtDOM(range.startContainer, range.startOffset, -1)
		const b = view.posAtDOM(range.endContainer, range.endOffset, 1)
		let from = Math.min(a, b)
		let to = Math.max(a, b)

		if (!(from >= 0 && to <= size && from < to)) return undefined
		if (insidePair(doc, from)) from--
		if (insidePair(doc, to)) to++

		return { from, to }
	} catch {
		return undefined
	}
}

function insertedText(event: InputEvent): string {
	return event.data ?? event.dataTransfer?.getData("text/plain") ?? ""
}

// The transaction a beforeinput makes on `state` (the document's state, whose positions the view's are), or
// undefined to leave it to the browser: typing with no selection and single-character deletions at a caret,
// which stay inside one text node. Typing at a caret whose `typingMarks` (DocxEditorSession.typingMarks) differ
// from the caret's own is a transaction too, with those marks.
export function inputTransaction(
	view: EditorView,
	state: EditorState,
	event: InputEvent,
	typingMarks?: (state: EditorState) => readonly Mark[] | undefined
): Transaction | undefined {
	if (view.composing || event.isComposing) return undefined

	const type = event.inputType
	const selected = !state.selection.empty

	if (type === "insertText" || type === "insertReplacementText") {
		const text = insertedText(event)

		if (text === "") return undefined

		// A replacement (autocorrect, a suggestion) names its range; typing replaces the selection.
		const range = type === "insertReplacementText" || !selected ? targetRange(view, event, state.doc) : undefined

		if (range !== undefined) return state.tr.insertText(text, range.from, range.to).scrollIntoView()
		if (selected) return state.tr.insertText(text).scrollIntoView()

		const caretMarks = typingMarks?.(state)

		return caretMarks === undefined ? undefined : state.tr.setStoredMarks(caretMarks).insertText(text).scrollIntoView()
	}

	if (CHARACTER_DELETES.has(type)) return selected ? state.tr.deleteSelection().scrollIntoView() : undefined

	if (!WORD_AND_LINE_DELETES.has(type)) return undefined
	if (selected) return state.tr.deleteSelection().scrollIntoView()

	const range = targetRange(view, event, state.doc)

	return range === undefined ? undefined : withinParagraph(state, type, range)
}

// A word or line deletion of [from, to] kept in the caret's paragraph, as Word and the platforms delete: a range
// a browser computed past the paragraph's edge (Chromium's Ctrl+K on macOS runs on into the next paragraph) stops
// there. At the edge it deletes towards, the paragraphs join, as Backspace and Delete join them (nothing where
// they do not join: the browser's deletion would cut across the structure).
function withinParagraph(state: EditorState, type: string, range: { readonly from: number; readonly to: number }): Transaction {
	const $caret = state.selection.$from

	if (!$caret.parent.isTextblock) return state.tr.delete(range.from, range.to).scrollIntoView()

	const start = $caret.start()
	const end = $caret.end()
	const forward = type.endsWith("Forward")
	const backward = type.endsWith("Backward")

	if ((forward && $caret.pos === end) || (backward && $caret.pos === start)) {
		const joined = forward ? joinForward(state) : joinBackward(state)

		return joined === null || joined === false ? state.tr : joined
	}

	const from = Math.max(range.from, start)
	const to = Math.min(range.to, end)

	return from < to ? state.tr.delete(from, to).scrollIntoView() : state.tr
}

// ---- links as you type ---------------------------------------------------------------------------------

// Whether a beforeinput types a Space at the caret right after a web or e-mail address (see autoLink): the
// Space is then typed as a transaction (spaceTransaction), so the link follows it at once (autoLinked).
export function spaceEndsAddress(view: EditorView, session: DocxEditorSession, event: InputEvent): boolean {
	if (view.composing || event.isComposing || event.inputType !== "insertText" || event.data !== " ") return false

	const selection = session.state.selection

	return selection.empty && selection instanceof TextSelection && autoLink(session, selection.from) !== null
}

// The Space spaceEndsAddress found, typed at the caret.
export function spaceTransaction(session: DocxEditorSession): Transaction {
	return session.state.tr.insertText(" ").scrollIntoView()
}

// Runs `act` (a key that may end a word: Space, Tab, Enter, Shift+Enter) and, when it put a space, a tab or a
// break right after the caret it started from or split the paragraph there, makes the address before it a link
// through `apply`. What `act` returns.
export function autoLinked(session: DocxEditorSession, act: () => boolean, apply: (tr: Transaction) => unknown): boolean {
	const before = session.state
	const caret = before.selection

	if (!caret.empty || session.readOnly) return act()

	const done = act()
	const state = session.state

	if (state.doc !== before.doc && state.doc.content.size > before.doc.content.size && endsWord(state.doc, caret.from)) {
		const tr = autoLink(session, caret.from)

		if (tr !== null) apply(tr)
	}

	return done
}

// Whether a space, a tab or a break follows `pos`, or its paragraph ends there.
function endsWord(doc: Node, pos: number): boolean {
	const $pos = doc.resolve(pos)

	if (!$pos.parent.isTextblock) return false

	const after = $pos.nodeAfter

	return (
		after === null ||
		after.type === docxSchema.nodes.tab ||
		after.type === docxSchema.nodes.break ||
		(after.isText && /^\s/.test(after.text ?? ""))
	)
}
