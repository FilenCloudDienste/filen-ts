import { AllSelection, NodeSelection, TextSelection, type EditorState, type Transaction } from "prosemirror-state"
import type { Node } from "prosemirror-model"
import { canJoin } from "prosemirror-transform"
import { RUN_FORMATTING, docxSchema } from "../edit/index"
import { AttrChanges } from "../edit/attrs"
import { caretMarks, type FormatResolver } from "../edit/formats"
import type { IndentAttrs } from "../edit/schema"
import { revisionHidden, type RevisionView } from "../model/kinds"

// The rebindable shortcuts and their matcher live with the command table (no engine), for a host's keymap.
export * from "../edit/keys"

// The structural keys an input view handles itself (the browser's own editing would change its hidden DOM
// in ways ProseMirror cannot read back as DOCX): Enter splits the paragraph, Shift+Enter breaks the line,
// Backspace at a paragraph's start and Delete at its end join paragraphs, Mod+A selects everything. Each
// returns the transaction or null when it does not apply (the view's default then runs). The session's
// invariants check every result.

// Enter, as Word's: in an empty list item the item leaves the list (numbering off) instead. At the paragraph's
// end the new paragraph takes its style's following style (w:next), and text typed there the caret's run
// formatting (the paragraph mark's, §17.3.1.29): never a link, revision or content control around the caret.
export function splitParagraph(state: EditorState, formats: FormatResolver): Transaction | null {
	if (state.selection instanceof NodeSelection || state.selection instanceof AllSelection) return null

	const empty = state.selection.empty
	const tr = state.tr.deleteSelection()
	const $from = tr.selection.$from
	const paragraph = $from.parent

	if (!paragraph.isTextblock) return null

	const atEnd = paragraph.type === docxSchema.nodes.paragraph && holdsNoContent(paragraph, $from.parentOffset, paragraph.content.size)

	if (empty && atEnd && holdsNoContent(paragraph, 0, $from.parentOffset) && formats.listOf(paragraph) !== undefined) {
		const changes = new AttrChanges()

		changes.set(paragraph, $from.before(), formats.numberingOff(paragraph))
		changes.step(tr)

		return tr.scrollIntoView()
	}

	const marks = atEnd ? (empty ? caretMarks(state, formats) : $from.marks()).filter(mark => RUN_FORMATTING.has(mark.type)) : null
	const next = atEnd ? formats.nextStyle(paragraph) : undefined

	tr.split($from.pos, 1, next === undefined ? undefined : [{ type: paragraph.type, attrs: { ...paragraph.attrs, styleId: next } }])

	return (marks === null ? tr : tr.setStoredMarks(marks)).scrollIntoView()
}

// Whether `paragraph` holds nothing but zero-width range markers and proofing marks between offsets `from`
// and `to`.
function holdsNoContent(paragraph: Node, from: number, to: number): boolean {
	let pos = 0

	for (let k = 0; k < paragraph.childCount && pos < to; k++) {
		const child = paragraph.child(k)

		if (pos + child.nodeSize > from && child.type !== docxSchema.nodes.marker && child.type !== docxSchema.nodes.proof_err) return false

		pos += child.nodeSize
	}

	return true
}

export function lineBreak(state: EditorState): Transaction | null {
	if (!state.selection.$from.parent.isTextblock) return null

	return state.tr.replaceSelectionWith(docxSchema.nodes.break.create({ type: "textWrapping" }), true).scrollIntoView()
}

// A tab character in place of the selection.
export function insertTab(state: EditorState): Transaction | null {
	if (!state.selection.$from.parent.isTextblock) return null

	return state.tr.replaceSelectionWith(docxSchema.nodes.tab.create(), true).scrollIntoView()
}

// Tab and Shift+Tab in a table (the innermost one holding both ends of the selection): the next (previous)
// cell with its content selected, as Word's do. A vertical merge's continuation cells belong to the cell above,
// and rows and cells revision view `view` hides are not there: both are passed over. From the last cell shown,
// `lastRow` puts the caret in the table's last row (Word adds a row below it); false from the first cell
// going back (nothing happens), null outside a table.
export function cellStep(
	state: EditorState,
	dir: 1 | -1,
	view: RevisionView
): Transaction | { readonly lastRow: Transaction } | false | null {
	const { $from, $to } = state.selection
	const nodes = docxSchema.nodes
	const hidden = (node: Node): boolean => revisionHidden(node.attrs["revision"] as number, view)

	for (let d = Math.min($from.depth, $to.depth) - 3; d >= 1; d--) {
		const table = $from.node(d)

		if (table.type !== nodes.table || $to.node(d) !== table || $from.before(d) !== $to.before(d)) continue

		const doc = state.doc
		const $end = dir > 0 ? $to : $from
		let row = $end.index(d)
		let cell = $end.index(d + 1)
		let rowPos = $end.before(d + 1)

		for (;;) {
			cell += dir

			if (cell < 0 || cell >= table.child(row).childCount) {
				const left = table.child(row)

				row += dir

				if (row < 0) return false

				if (row >= table.childCount) {
					const last = table.child(table.childCount - 1)
					const caret = TextSelection.findFrom(doc.resolve($from.before(d) + table.nodeSize - last.nodeSize), 1, true)

					return caret === null ? false : { lastRow: state.tr.setSelection(caret) }
				}

				const next = table.child(row)

				rowPos = dir > 0 ? rowPos + left.nodeSize : rowPos - next.nodeSize
				// Before its first cell going on (after its last going back); a hidden row is passed over whole.
				const into = dir > 0 ? -1 : next.childCount

				cell = hidden(next) ? next.childCount - 1 - into : into

				continue
			}

			const target = table.child(row).child(cell)

			if (target.attrs["vMerge"] === "continue" || hidden(target)) continue

			let cellPos = rowPos + 1

			for (let k = 0; k < cell; k++) cellPos += table.child(row).child(k).nodeSize

			const start = TextSelection.findFrom(doc.resolve(cellPos + 1), 1, true)
			const end = TextSelection.findFrom(doc.resolve(cellPos + target.nodeSize - 1), -1, true)

			if (start === null || end === null || start.from < cellPos || end.to > cellPos + target.nodeSize || start.from > end.to)
				continue

			return state.tr.setSelection(TextSelection.create(doc, start.from, end.to)).scrollIntoView()
		}
	}

	return null
}

// At a paragraph's start: a list item leaves its list first, its text staying where it was (Word's first
// Backspace; with `formats` only); otherwise joined to the paragraph before it. Inside a cell's first
// paragraph, or after a table, nothing happens (the key is still taken: the browser would delete across the
// structure).
export function joinBackward(state: EditorState, formats?: FormatResolver): Transaction | null | false {
	const { $from, empty } = state.selection
	const paragraph = $from.parent

	if (!empty || !paragraph.isTextblock) return null

	if (
		formats !== undefined &&
		paragraph.type === docxSchema.nodes.paragraph &&
		holdsNoContent(paragraph, 0, $from.parentOffset) &&
		formats.listOf(paragraph) !== undefined
	) {
		const indent = formats.paragraph(paragraph).props.indent
		const { end, endChars } = (paragraph.attrs["indent"] as IndentAttrs | null) ?? {}
		// The text start the number's hanging indent gave it, as the paragraph's own indent.
		const kept: IndentAttrs = {
			start: indent.start,
			...(indent.startChars === undefined ? {} : { startChars: indent.startChars }),
			...(end === undefined ? {} : { end }),
			...(endChars === undefined ? {} : { endChars }),
			firstLine: 0,
			...(indent.firstLineChars === undefined ? {} : { firstLineChars: 0 })
		}
		const changes = new AttrChanges()
		const tr = state.tr

		changes.set(paragraph, $from.before(), { ...formats.numberingOff(paragraph), indent: kept })
		changes.step(tr)

		return tr.scrollIntoView()
	}

	if ($from.parentOffset > 0) return null

	const before = $from.before()

	if ($from.index($from.depth - 1) === 0) return false

	const previous = state.doc.resolve(before).nodeBefore

	if (previous === null || !previous.isTextblock) {
		// After an atom block (a locked block): select it, as Word does with a table or image before.
		if (previous !== null && previous.isAtom) return state.tr.setSelection(NodeSelection.create(state.doc, before - previous.nodeSize))

		return false
	}

	return canJoin(state.doc, before) ? state.tr.join(before).scrollIntoView() : false
}

export function joinForward(state: EditorState): Transaction | null | false {
	const { $from, empty } = state.selection

	if (!empty || !$from.parent.isTextblock || $from.parentOffset < $from.parent.content.size) return null

	const after = $from.after()
	const next = state.doc.resolve(after).nodeAfter

	if (next === null || !next.isTextblock) {
		if (next !== null && next.isAtom) return state.tr.setSelection(NodeSelection.create(state.doc, after))

		return false
	}

	return canJoin(state.doc, after) ? state.tr.join(after).scrollIntoView() : false
}

export function selectAll(state: EditorState): Transaction {
	return state.tr.setSelection(new AllSelection(state.doc))
}

// The caret after a NodeSelection on an atom block is gone: next to it.
export function besideNode(state: EditorState, dir: 1 | -1): Transaction | null {
	const selection = state.selection

	if (!(selection instanceof NodeSelection)) return null

	const pos = dir > 0 ? selection.to : selection.from
	const found = TextSelection.findFrom(state.doc.resolve(pos), dir, true)

	return found === null ? null : state.tr.setSelection(found)
}
