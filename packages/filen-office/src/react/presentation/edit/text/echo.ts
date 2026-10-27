import type { Node } from "prosemirror-model"
import type { PaintedPage } from "../../../docx/paint/page"

// Typed text shown in the frame of the key, before the worker lays it out (the docx editor shows input at once
// because it lays out on the page; here the layout is the worker's, the session's one measuring realm). The text goes
// into the painted span of the fragment it extends and the caret moves past it, measured on this thread; the worker's
// page then replaces both, patching the line that changed. Only a plain insertion at one place is echoed: anything
// else waits for the worker.

// The text `doc` inserts into `laid` at one place (no deletion, no paragraph break, no atom), with its position in
// `laid`; undefined for any other change.
export function pendingInsertion(laid: Node, doc: Node): { readonly pos: number; readonly text: string; readonly end: number } | undefined {
	if (laid === doc) return undefined

	const start = laid.content.findDiffStart(doc.content)
	const end = laid.content.findDiffEnd(doc.content)

	if (start === null || end === null) return undefined

	let endA = end.a
	let endB = end.b
	const overlap = start - Math.min(endA, endB)

	// A repeated character makes the two scans overlap.
	if (overlap > 0) {
		endA += overlap
		endB += overlap
	}

	if (endA !== start || endB <= start || endB > doc.content.size) return undefined

	const $from = doc.resolve(start)
	const $to = doc.resolve(endB)

	if (!$from.parent.isTextblock || $from.parent !== $to.parent) return undefined

	let plain = true

	doc.nodesBetween(start, endB, node => {
		if (!node.isText && !node.isTextblock) plain = false

		return plain
	})

	if (!plain) return undefined

	return { pos: start, text: doc.textBetween(start, endB), end: endB }
}

// The echo painted into a page: the text node it changed and what it held.
export class TextEcho {
	private node: Text | undefined
	private original = ""

	// Puts `text` at laid-out `offset` of `paragraph` into the painted span that holds it (or ends right before it, with
	// the spaces between from `paragraphText`). False when no single-text span takes it.
	apply(painted: PaintedPage, paragraph: number, offset: number, text: string, paragraphText: string): boolean {
		let target: PaintedPage["texts"][number] | undefined

		for (const item of painted.texts) {
			if (item.source !== paragraph || item.start > offset) continue
			if (target === undefined || item.start >= target.start) target = item
		}

		if (target === undefined) return false

		const gap = offset > target.end ? paragraphText.slice(target.end, offset) : ""
		const node = target.element.firstChild

		if (target.element.childNodes.length !== 1 || node === null || node.nodeType !== 3 || /\S/u.test(gap)) return false

		const textNode = node as Text
		const data = textNode.data
		const at = Math.min(data.length, Math.max(0, offset - target.start))

		this.node = textNode
		this.original = data
		textNode.data = data.slice(0, at) + gap + text + data.slice(at)

		return true
	}

	// The painted span as the worker's page drew it.
	restore(): void {
		if (this.node !== undefined && this.node.data !== this.original) this.node.data = this.original

		this.node = undefined
		this.original = ""
	}
}
