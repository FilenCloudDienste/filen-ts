import type { Node } from "prosemirror-model"
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import { ReplaceAroundStep, ReplaceStep, type Step } from "prosemirror-transform"
import { markStepPieces, markStepsOf } from "../marks"
import { isInternal, replacesOf } from "./core"

// Positions inside a UTF-16 surrogate pair (a character outside the BMP is two of the document's positions) are
// no place for a selection or an edit: a selection put there snaps to the character's edges, and an edit that
// would split one is refused, so half a character never reaches the model (and a save).

// Whether `pos` falls between the two code units of a surrogate pair of one text node.
export function insidePair(doc: Node, pos: number): boolean {
	if (pos <= 0 || pos >= doc.content.size) return false

	const $pos = doc.resolve(pos)

	if ($pos.textOffset === 0) return false

	const text = $pos.parent.child($pos.index()).text

	if (text === undefined) return false

	const at = $pos.textOffset

	return (text.charCodeAt(at - 1) & 0xfc00) === 0xd800 && (text.charCodeAt(at) & 0xfc00) === 0xdc00
}

// The positions a step edits, in the document before it.
function stepPositions(step: Step): number[] {
	if (step instanceof ReplaceAroundStep) return [step.from, step.to, step.gapFrom, step.gapTo]
	if (step instanceof ReplaceStep) return replacesOf(step).flatMap(replace => [replace.from, replace.to])

	return markStepsOf(step)?.flatMap(part => markStepPieces(part).flatMap(piece => [piece.from, piece.to])) ?? []
}

// Positions a transaction may have looked up: an edit has a few; a command over a whole document (a step per
// paragraph) takes its positions from node and text boundaries, and a lookup each would cost a walk each.
const MAX_LOOKUPS = 64

function splitsPair(tr: Transaction): boolean {
	const positions = tr.steps.map(stepPositions)
	let count = 0

	for (const list of positions) count += list.length

	if (count > MAX_LOOKUPS) return false

	return positions.some((list, index) => {
		const doc = tr.docs[index] as Node

		return list.some(pos => insidePair(doc, pos))
	})
}

// A selection with an end inside a pair: a range takes the whole character, a caret goes on in the direction
// it moved (from `before`, the head it had).
function snapped(state: EditorState, before: number): TextSelection | null {
	const selection = state.selection

	if (!(selection instanceof TextSelection)) return null

	const doc = state.doc
	const { anchor, head } = selection
	const anchorIn = insidePair(doc, anchor)
	const headIn = insidePair(doc, head)

	if (!anchorIn && !headIn) return null

	if (anchor === head) {
		const at = head >= before ? head + 1 : head - 1

		return TextSelection.create(doc, at)
	}

	const forward = head > anchor
	const newAnchor = anchorIn ? (forward ? anchor - 1 : anchor + 1) : anchor
	const newHead = headIn ? (forward ? head + 1 : head - 1) : head

	return TextSelection.create(doc, newAnchor, newHead)
}

export function codePointPlugin(): Plugin {
	return new Plugin({
		key: new PluginKey("docxCodePoints"),
		filterTransaction: tr => !tr.docChanged || isInternal(tr) || !splitsPair(tr),
		appendTransaction: (transactions, old, state) => {
			if (!transactions.some(tr => tr.selectionSet || tr.docChanged)) return null

			const selection = snapped(state, old.selection.head)

			return selection === null ? null : state.tr.setSelection(selection)
		}
	})
}
