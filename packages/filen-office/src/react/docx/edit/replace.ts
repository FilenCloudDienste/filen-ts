import type { Node } from "prosemirror-model"
import { closeHistory } from "prosemirror-history"
import { TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import { docxSchema } from "../../../core/docx/edit/index"
import { plainSlice } from "./clipboard"

// Replacing a selection with plain text an app produced (the assistant's rewrite): one undo step, formatted as the
// text it replaces starts, through the story's own dispatch (protection, tracked changes, read-only).

// A story that takes transactions: a PagedEditor (the story being edited) or a DocxEditorSession.
export interface DocxTextTarget {
	readonly state: EditorState
	dispatch(tr: Transaction): boolean
}

export interface DocxTextRange {
	readonly from: number
	readonly to: number
}

const { nodes, marks } = docxSchema

// What a plain-text replacement keeps nothing of but its text: anything else in the range (a table's structure, a
// field, a picture, a comment's anchor, a tracked change) would be lost or half-replaced.
const PLAIN_INLINE: ReadonlySet<unknown> = new Set([nodes.text, nodes.tab, nodes.break, nodes.hyphen, nodes.symbol, nodes.proof_err])
const TRACKED: ReadonlySet<unknown> = new Set([marks.insertion, marks.deletion, marks.move_from, marks.move_to])

// Whether [from, to) holds only paragraphs of plain text (tabs, line breaks, symbols included) and no tracked change.
export function plainTextRange(doc: Node, { from, to }: DocxTextRange): boolean {
	if (from >= to || from < 0 || to > doc.content.size) return false

	let plain = true

	doc.nodesBetween(from, to, (node, pos) => {
		if (!plain) return false

		// An ancestor of the whole range (the paragraph, a table cell it sits in).
		if (pos < from && pos + node.nodeSize > to) return true

		if (node.type === nodes.paragraph) return true

		if (!PLAIN_INLINE.has(node.type) || node.marks.some(mark => TRACKED.has(mark.type))) plain = false

		return false
	})

	return plain
}

// The resolved position whose marks the replacement takes: the range's first character's.
function contextOf(doc: Node, from: number, to: number): ReturnType<Node["resolve"]> {
	const $from = doc.resolve(from)

	return from < to && $from.parentOffset < $from.parent.content.size ? doc.resolve(from + 1) : $from
}

// Replaces `range` (the selection by default) with `text`: one line stays in its paragraph, several split it as a
// paste of plain text does. The replacement ends selected. False when the range is not plain text or the story
// refused the edit (read-only, protected; its onRefused says why).
export function replaceSelectionText(target: DocxTextTarget, text: string, range: DocxTextRange = target.state.selection): boolean {
	const state = target.state
	const { from, to } = range

	if (!plainTextRange(state.doc, range)) return false

	const tr = state.tr.replace(from, to, plainSlice(text, contextOf(state.doc, from, to)))

	tr.setSelection(TextSelection.create(tr.doc, from, tr.mapping.map(to)))

	return target.dispatch(closeHistory(tr).scrollIntoView())
}
