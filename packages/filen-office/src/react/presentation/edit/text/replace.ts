import type { Node } from "prosemirror-model"
import { EditorState, TextSelection, type Transaction } from "prosemirror-state"
import { caretRunProps, plainTextSlice } from "../../../../core/presentation/edit/commands/text"
import { xmlSafeText } from "../../../../core/presentation/edit/xmlText"
import type { RunProps, TextBody } from "../../../../core/presentation/model"
import { RUN_MARK, bodyToDoc, docToBody, presentationTextSchema, runPropsOf } from "../../../../core/presentation/text/schema"

// Plain text put in place of a range of a body being edited (the selection transform's Accept): one transaction, so
// the controller commits it as one undo step.

export interface TextRange {
	readonly from: number
	readonly to: number
}

// Whether [from, to) holds only text and line breaks: a slide number, a date field or content kept as its source
// (math) would be lost to plain text, so such a range is not offered.
export function slidePlainRange(doc: Node, range: TextRange): boolean {
	let plain = true

	doc.nodesBetween(range.from, range.to, node => {
		if (node.type.name === "field" || node.type.name === "opaque") plain = false

		return plain
	})

	return plain
}

interface Segment {
	readonly from: number
	readonly to: number
	// The local run props of its first character (the run before it, else its paragraph mark's, when it is empty).
	readonly rPr: RunProps
}

// The range cut at paragraph ends and line breaks: the parts its text reads as lines (textBetween(from, to, "\n")).
function segments(doc: Node, range: TextRange): Segment[] {
	const out: Segment[] = []

	doc.nodesBetween(range.from, range.to, (node, pos) => {
		if (node.type.name !== "paragraph") return true

		const start = Math.max(range.from, pos + 1)
		const end = Math.min(range.to, pos + 1 + node.content.size)
		const endRPr = node.attrs["endRPr"] as RunProps | null
		let at = start

		const close = (to: number): void => {
			const $at = doc.resolve(at)
			const after = $at.nodeAfter
			const rPr = after !== null && after.isText && at < to ? runPropsOf(after.marks, endRPr) : runPropsOf($at.marks(), endRPr)

			out.push({ from: at, to, rPr })
		}

		node.forEach((child, offset) => {
			const childPos = pos + 1 + offset

			if (child.type.name === "br" && childPos >= start && childPos < end) {
				close(childPos)
				at = childPos + 1
			}
		})
		close(end)

		return false
	})

	return out
}

// `text` in place of `range` (a range of `state.doc`): when its lines match the range's lines one for one, each line's
// text is replaced in place, so every paragraph keeps its properties (level, bullet, alignment) and each line the run
// properties of its first character; else as a plain-text paste (lines become paragraphs, with the caret's run
// properties). The replacement ends selected. Null when the range is not plain text (slidePlainRange).
export function replaceSlideText(state: EditorState, range: TextRange, text: string): Transaction | null {
	const doc = state.doc

	if (range.from > range.to || range.from < 0 || range.to > doc.content.size || !slidePlainRange(doc, range)) return null

	const lines = text.replace(/\r\n?/gu, "\n").split("\n")
	const parts = segments(doc, range)
	const tr = state.tr

	if (lines.length === parts.length) {
		// Last first: the positions before each replacement stay as they were.
		for (let index = parts.length - 1; index >= 0; index--) {
			const part = parts[index] as Segment
			const line = xmlSafeText(lines[index] ?? "")

			if (line.length === 0) tr.delete(part.from, part.to)
			else tr.replaceWith(part.from, part.to, presentationTextSchema.text(line, [RUN_MARK.create({ rPr: part.rPr })]))
		}
	} else {
		const selected = state.apply(state.tr.setSelection(TextSelection.create(doc, range.from, range.to)))
		const endRPr = selected.selection.$from.parent.attrs["endRPr"] as RunProps | null

		tr.setSelection(TextSelection.create(doc, range.from, range.to))
		tr.replaceSelection(plainTextSlice(text, caretRunProps(selected), endRPr))
	}

	const from = tr.mapping.map(range.from, -1)
	const to = tr.mapping.map(range.to, 1)

	return tr.setSelection(TextSelection.create(tr.doc, Math.min(from, to), to))
}

// The range's text as replaceSlideText reads its lines: each paragraph's part, a line break too, as a line.
export function slideRangeText(doc: Node, range: TextRange): string {
	return segments(doc, range)
		.map(part => doc.textBetween(part.from, part.to))
		.join("\n")
}

// The whole document as a range of text positions.
function wholeRange(doc: Node): TextRange {
	return { from: TextSelection.atStart(doc).from, to: TextSelection.atEnd(doc).to }
}

// A whole body's text (a shape selected as an object, not being edited), lines as replaceSlideText reads them; null
// when it holds something plain text would lose (a field, math).
export function bodyPlainText(body: TextBody): string | null {
	const { doc } = bodyToDoc(body)
	const range = wholeRange(doc)

	return slidePlainRange(doc, range) ? slideRangeText(doc, range) : null
}

// `text` in place of a whole body's text, as replaceSlideText puts it in place of a selection; null when the body is not
// plain text (bodyPlainText).
export function replaceBodyText(body: TextBody, text: string): TextBody | null {
	const { doc, origins } = bodyToDoc(body)
	const tr = replaceSlideText(EditorState.create({ doc, schema: presentationTextSchema }), wholeRange(doc), text)

	return tr === null ? null : docToBody(tr.doc, body, origins)
}
