import type { Mark, Node } from "prosemirror-model"
import type { Transaction } from "prosemirror-state"
import { AttrStep, StepMap } from "prosemirror-transform"
import { markStepTypes, markStepsOf } from "../edit/marks"
import { SetAttrsStep } from "../edit/attrs"
import { docxSchema } from "../edit/schema"
import type { DocxEditorSession } from "../edit/session"
import type { StoryPart } from "../model/index"
import { partHasBindings } from "./binding"
import { controlKey, controlOf, simpleBinding, type ControlAround, type ControlInfo } from "./controls"

// Where a story's bound controls are (controls bound by a path the editor updates), by binding key: block
// controls by their position, run-level ones by their paragraph's. Kept per document: a document after a
// transaction gets its predecessor's positions mapped, with only the ranges the transaction changed looked at
// again, so finding the controls bound to a node costs no walk over the document per keystroke.

const nodes = docxSchema.nodes
const marks = docxSchema.marks

// Per key, sorted: a block control at `pos` as 2·pos, a paragraph at `pos` holding run-level ones as 2·pos + 1.
export type BoundIndex = ReadonlyMap<string, readonly number[]>

const indexes = new WeakMap<Node, BoundIndex>()

export function bindingKey(info: ControlInfo | undefined): string | undefined {
	return info?.binding === null || info === undefined || info.richBinding ? undefined : simpleBinding(info.binding)?.key
}

export interface ControlSpan {
	readonly from: number
	readonly to: number
	readonly mark: Mark
}

// The run-level controls of a paragraph (content from `start`) as spans, one per piece (nested ones overlap).
export function controlSpans(paragraph: Node, start: number): ControlSpan[] {
	const open = new Map<string, { from: number; to: number; mark: Mark }>()
	const out: ControlSpan[] = []
	let pos = start

	paragraph.forEach(child => {
		const end = pos + child.nodeSize
		const here = new Set<string>()

		for (const mark of child.marks) {
			if (mark.type !== marks.content_control) continue

			const key = controlKey(mark)
			const span = open.get(key)

			here.add(key)

			if (span !== undefined && span.to === pos) span.to = end
			else {
				if (span !== undefined) out.push(span)

				open.set(key, { from: pos, to: end, mark })
			}
		}

		for (const [key, span] of open) {
			if (!here.has(key)) {
				out.push(span)
				open.delete(key)
			}
		}

		pos = end
	})

	for (const span of open.values()) out.push(span)

	return out
}

function hasControlMark(paragraph: Node): boolean {
	let found = false

	paragraph.forEach(child => {
		if (!found && child.marks.some(mark => mark.type === marks.content_control)) found = true
	})

	return found
}

function add(out: Map<string, number[]>, key: string, entry: number): void {
	const list = out.get(key)

	if (list === undefined) out.set(key, [entry])
	else list.push(entry)
}

// Records the bound controls of `node` at `pos` (a block control, or a paragraph's run-level ones).
function record(part: StoryPart, out: Map<string, number[]>, node: Node, pos: number): void {
	if (node.type === nodes.sdt) {
		const key = bindingKey(controlOf(part, node))

		if (key !== undefined) add(out, key, 2 * pos)

		return
	}

	if (!node.inlineContent || !hasControlMark(node)) return

	const seen = new Set<string>()

	for (const span of controlSpans(node, pos + 1)) {
		const key = bindingKey(controlOf(part, span.mark))

		if (key === undefined || seen.has(key)) continue

		seen.add(key)
		add(out, key, 2 * pos + 1)
	}
}

function scan(part: StoryPart, doc: Node): BoundIndex {
	const out = new Map<string, number[]>()

	doc.descendants((node, pos) => {
		if (node.type === nodes.locked_block) return false

		record(part, out, node, pos)

		return !node.inlineContent && !node.isInline
	})

	return out
}

// The index of `doc` (a story document of `part`): known, or found by one walk.
export function boundIndex(part: StoryPart, doc: Node): BoundIndex {
	let found = indexes.get(doc)

	if (found === undefined) {
		found = scan(part, doc)
		indexes.set(doc, found)
	}

	return found
}

// Ranges of `tr.doc` a transaction changed in ways that can move, make or change a bound control.
function changedRanges(tr: Transaction): number[] {
	const out: number[] = []
	const maps = tr.mapping.maps

	tr.steps.forEach((step, index) => {
		const map = maps[index] ?? StepMap.empty

		for (let k = 0; k < out.length; k += 2) {
			out[k] = map.map(out[k] ?? 0, -1)
			out[k + 1] = map.map(out[k + 1] ?? 0, 1)
		}

		const parts = markStepsOf(step)

		if (parts !== undefined) {
			for (const part of parts) if (markStepTypes(part).includes(marks.content_control)) out.push(part.from, part.to)
		} else if (step instanceof AttrStep) {
			out.push(step.pos, step.pos)
		} else if (step instanceof SetAttrsStep) {
			for (const entry of step.entries) if ("state" in entry.attrs || "src" in entry.attrs) out.push(entry.pos, entry.pos)
		} else {
			map.forEach((_oldStart, _oldEnd, newStart, newEnd) => out.push(newStart, newEnd))
		}
	})

	return out
}

function advance(part: StoryPart, index: BoundIndex, tr: Transaction): BoundIndex {
	const doc = tr.doc
	const out = new Map<string, number[]>()
	const mapping = tr.mapping

	for (const [key, list] of index) {
		for (const entry of list) {
			const result = mapping.mapResult(entry >> 1, 1)

			if (!result.deletedAfter) add(out, key, 2 * result.pos + (entry & 1))
		}
	}

	const ranges = changedRanges(tr)

	for (let k = 0; k < ranges.length; k += 2) {
		const from = Math.min(ranges[k] ?? 0, doc.content.size)
		const to = Math.min(Math.max(ranges[k + 1] ?? 0, from), doc.content.size)
		const $from = doc.resolve(from)

		for (let depth = $from.depth; depth > 0; depth--) {
			const node = $from.node(depth)

			if (node.type === nodes.locked_block) break

			record(part, out, node, $from.before(depth))
		}

		// Within one paragraph (typing): the ancestors above are all.
		if ($from.parent.inlineContent && to <= $from.end()) continue

		doc.nodesBetween(from, to, (node, pos) => {
			if (node.type === nodes.locked_block) return false
			// Ancestors of `from` were looked at above.
			if (pos < from && pos + node.nodeSize > from) return !node.inlineContent

			record(part, out, node, pos)

			return !node.inlineContent && !node.isInline
		})
	}

	for (const [key, list] of out) {
		list.sort((a, b) => a - b)

		const unique = list.filter((entry, k) => k === 0 || entry !== list[k - 1])

		if (unique.length === 0) out.delete(key)
		else out.set(key, unique)
	}

	return out
}

// Brings the index along `transactions` (applied in turn) from the last document among them it is known for;
// nothing when it is known for none (it is found by a walk once asked for).
export function followIndex(part: StoryPart, transactions: readonly Transaction[]): void {
	let start = transactions.length

	while (start > 0 && !indexes.has((transactions[start - 1] as Transaction).doc)) start--

	let index = start > 0 ? indexes.get((transactions[start - 1] as Transaction).doc) : indexes.get((transactions[0] as Transaction).before)

	if (index === undefined) return

	for (let k = start; k < transactions.length; k++) {
		const tr = transactions[k] as Transaction

		index = tr.docChanged ? advance(part, index, tr) : index
		indexes.set(tr.doc, index)
	}
}

// The controls of `doc` bound to `key` in document order, each piece of a control split over paragraphs apart.
export function boundAround(part: StoryPart, doc: Node, index: BoundIndex, key: string): ControlAround[] {
	const out: ControlAround[] = []

	for (const entry of index.get(key) ?? []) {
		const pos = entry >> 1
		const node = pos < doc.content.size ? doc.nodeAt(pos) : null

		if (node === null) continue

		if ((entry & 1) === 0) {
			const info = node.type === nodes.sdt ? controlOf(part, node) : undefined

			if (info !== undefined && bindingKey(info) === key)
				out.push({ kind: "block", holder: node, info, from: pos + 1, to: pos + node.nodeSize - 1, pos })

			continue
		}

		if (!node.inlineContent) continue

		for (const span of controlSpans(node, pos + 1)) {
			const info = controlOf(part, span.mark)

			if (info !== undefined && bindingKey(info) === key)
				out.push({ kind: "inline", holder: span.mark, info, from: span.from, to: span.to, pos: span.from })
		}
	}

	return out.sort((a, b) => a.from - b.from)
}

// Sessions whose story holds bound copies of another part's controls (its own part may bind nothing).
const boundCopies = new WeakSet<DocxEditorSession>()

export function noteBoundCopies(session: DocxEditorSession): void {
	boundCopies.add(session)
}

// Whether a session's story may hold controls bound by a path the editor updates.
export function holdsBindings(session: DocxEditorSession): boolean {
	return partHasBindings(session.story.part) || boundCopies.has(session)
}
