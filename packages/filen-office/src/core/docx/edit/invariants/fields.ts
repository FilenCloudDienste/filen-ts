import type { Fragment, Mark, MarkType, Node, Slice } from "prosemirror-model"
import { isHistoryTransaction } from "prosemirror-history"
import type { EditorState, Transaction } from "prosemirror-state"
import {
	AddNodeMarkStep,
	AttrStep,
	RemoveMarkStep,
	RemoveNodeMarkStep,
	ReplaceAroundStep,
	ReplaceStep,
	type Step
} from "prosemirror-transform"
import { SetAttrsStep } from "../attrs"
import { fieldUpdateOf } from "../../fields/evaluate"
import { fieldFormatState, holdsFormatting, unformattableFields, resultDropsFormatting, setFieldFormatState } from "../../fields/format"
import { SetMarkSetsStep, SetMarksStep, isAddMarkLike, markStepPieces, markStepTypes, markStepsOf } from "../marks"
import { RevisionFlag } from "../../model/index"
import { isDeleted, markable, paragraphChange, planOf, setParagraphChange, type RevisionStamp } from "../../review/track"
import { FORMATTING_MARKS, NO_SOURCE, docxSchema, survivorsOf, type MarkerAttrs, type MarkerList } from "../schema"
import { changedRanges, isInternal, isRemarking, markInternal, nodesBetweenRanges, reinsert } from "./core"
import type { InvariantStage } from "./index"

// Fields spanning paragraphs (a table of contents: field_char begin, its instruction texts when it is the
// file's, separate and end in different paragraphs) stay whole: an edit that deletes one of their characters
// deletes the field from its begin to its end, as Word deletes a field a selection takes a boundary of (its
// separate or an instruction text too: the rest would be a code running over paragraph marks, or a code the
// begin no longer holds); characters an edit leaves without their partners otherwise (a paste of part of a
// table) go, and the rest is plain text. A paragraph split inside a field's code (between its begin and
// separate, where nothing shows) puts the code after the split: a code over a paragraph mark would hide what
// follows it. A tracked deletion takes a field's characters all or none: those it took without the rest are
// kept (what the field holds stays deleted). Only edits whose steps remove or insert a field character, split
// paragraphs or mark content deleted are looked at. A move that would take such a field apart is refused (see
// brokenMove).

const nodes = docxSchema.nodes

function sliceHas(slice: Slice): boolean {
	let found = false

	slice.content.descendants(node => {
		if (node.type === nodes.field_char) found = true

		return !found && !node.isLeaf
	})

	return found
}

function rangeHas(doc: Node, from: number, to: number): boolean {
	let found = false

	if (to > from)
		doc.nodesBetween(from, to, node => {
			if (node.type === nodes.field_char) found = true

			return !found && !node.isLeaf
		})

	return found
}

// Whether [from, to) of `doc` holds a separate or instruction text whose begin it does not hold.
function rangeCuts(doc: Node, from: number, to: number): boolean {
	let depth = 0
	let cut = false

	if (to > from)
		doc.nodesBetween(from, to, node => {
			if (node.type === nodes.field_char) {
				const kind = node.attrs["kind"] as string

				if (kind === "begin") depth++
				else if (kind === "end") depth = Math.max(0, depth - 1)
				else if (depth === 0) cut = true
			}

			return !cut && !node.isLeaf
		})

	return cut
}

interface Touched {
	// Where field characters went (positions in the transaction's final document).
	readonly removed: number[]
	// Where a separate or instruction text went without its begin.
	readonly cut: number[]
}

// Where a transaction removed field characters, or undefined when none of its steps removed or inserted one.
function touched(tr: Transaction): Touched | undefined {
	const removed: number[] = []
	const cut: number[] = []
	let any = false

	tr.steps.forEach((step, index) => {
		if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) return

		const doc = tr.docs[index] as Node
		const ranges = step instanceof ReplaceAroundStep ? [step.from, step.gapFrom, step.gapTo, step.to] : [step.from, step.to]
		let gone = false

		for (let k = 0; k < ranges.length; k += 2) {
			const from = ranges[k] ?? 0
			const to = ranges[k + 1] ?? 0

			if (!rangeHas(doc, from, to)) continue

			gone = true

			if (rangeCuts(doc, from, to)) cut.push(tr.mapping.slice(index).map(from, -1))
		}

		if (gone) removed.push(tr.mapping.slice(index).map(step.from, -1))
		if (gone || sliceHas(step.slice)) any = true
	})

	return any ? { removed, cut } : undefined
}

interface Char {
	readonly pos: number
	readonly kind: string
}

// The field characters of `doc` without partners. A field without a separate whose code would run from one
// paragraph to another has none either (Word reads what follows its begin as the code).
function unmatched(doc: Node): Char[] {
	const open: { begin: Char; block: number; separate: Char | undefined; instructions: Char[] }[] = []
	const stray: Char[] = []
	let block = -1

	doc.descendants((node, pos) => {
		if (node.type !== nodes.field_char) {
			if (node.isTextblock) block = pos

			return !node.isLeaf
		}

		const char = { pos, kind: node.attrs["kind"] as string }
		const top = open[open.length - 1]

		if (char.kind === "begin") open.push({ begin: char, block, separate: undefined, instructions: [] })
		else if ((char.kind === "instruction" || char.kind === "deletedInstruction") && top !== undefined && top.separate === undefined)
			top.instructions.push(char)
		else if (char.kind === "separate" && top !== undefined && top.separate === undefined) top.separate = char
		else if (char.kind === "end" && top !== undefined) {
			open.pop()

			if (top.separate === undefined && top.block !== block) stray.push(top.begin, ...top.instructions, char)
		} else stray.push(char)

		return false
	})

	for (const field of open) stray.push(field.begin, ...field.instructions, ...(field.separate === undefined ? [] : [field.separate]))

	return stray.sort((a, b) => a.pos - b.pos)
}

// The fields of `doc` from their begin to after their end character.
function fieldRanges(doc: Node): [number, number][] {
	const open: number[] = []
	const out: [number, number][] = []

	doc.descendants((node, pos) => {
		if (node.type !== nodes.field_char) return !node.isLeaf

		const kind = node.attrs["kind"] as string

		if (kind === "begin") open.push(pos)
		else if (kind === "end") {
			const begin = open.pop()

			if (begin !== undefined) out.push([begin, pos + 1])
		}

		return false
	})

	return out
}

// Whether [from, to) can go in one deletion: paragraphs of one container, no section break or locked block.
function deletable(doc: Node, from: number, to: number): boolean {
	const $from = doc.resolve(from)
	const $to = doc.resolve(to)

	if (
		!$from.parent.isTextblock ||
		!$to.parent.isTextblock ||
		$from.depth !== $to.depth ||
		$from.node($from.depth - 1) !== $to.node($to.depth - 1)
	)
		return false

	let safe = true

	doc.nodesBetween(from, to, (node, pos) => {
		if (!safe) return false

		// The containers the range lies in.
		if (pos < from && !node.isTextblock) return true

		if (node.type === nodes.locked_block || node.type === nodes.table || node.type === nodes.sdt) safe = false
		else if (node.type === nodes.paragraph && (node.attrs["sectPr"] as number) !== NO_SOURCE && pos + node.nodeSize - 1 < to)
			safe = false

		return safe && !node.isTextblock
	})

	return safe
}

// Whether a step of `tr` put a block boundary into the document (a split, paragraphs pasted).
function splits(tr: Transaction): boolean {
	return tr.steps.some(step => (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) && step.slice.openStart > 0)
}

// Where a paragraph ends inside a field's code: the offset of the first begin whose separate (or end) it does not
// hold, whatever follows it (text typed or pasted into a code is the code's), or -1.
function openCode(paragraph: Node): number {
	const open: { offset: number; code: boolean }[] = []

	paragraph.forEach((child, offset) => {
		if (child.type !== nodes.field_char) return

		const kind = child.attrs["kind"] as string
		const last = open[open.length - 1]

		if (kind === "begin") open.push({ offset, code: true })
		else if (kind === "separate" && last !== undefined) last.code = false
		else if (kind === "end") open.pop()
	})

	return open.find(field => field.code)?.offset ?? -1
}

// Codes split from their separates by the transactions' splits (Enter, paragraphs pasted into them), moved after
// the split (onto `tr`, whose steps follow them).
function rejoinCodes(transactions: readonly Transaction[], tr: Transaction): void {
	const ranges: number[] = []

	for (const [index, step] of transactions.entries()) {
		if (!step.docChanged || isHistoryTransaction(step) || isInternal(step) || !splits(step)) continue

		const later = transactions.slice(index + 1)

		for (const at of changedRanges(step, false)) ranges.push(tr.mapping.map(later.reduce((pos, next) => next.mapping.map(pos), at)))
	}

	if (ranges.length === 0) return

	const doc = tr.doc
	const moves: { from: number; to: number; into: number }[] = []
	const seen = new Set<number>()

	for (let k = 0; k < ranges.length; k += 2) {
		const from = Math.max(0, Math.min(ranges[k] ?? 0, ranges[k + 1] ?? 0) - 1)
		const to = Math.min(doc.content.size, Math.max(ranges[k] ?? 0, ranges[k + 1] ?? 0) + 1)

		doc.nodesBetween(from, to, (node, pos, parent, index) => {
			if (!node.isTextblock) return !node.isLeaf
			if (seen.has(pos) || node.type !== nodes.paragraph) return false

			seen.add(pos)

			const offset = openCode(node)
			const next = parent !== null && index + 1 < parent.childCount ? parent.child(index + 1) : null

			if (offset >= 0 && next?.type === nodes.paragraph)
				moves.push({ from: pos + 1 + offset, to: pos + node.nodeSize - 1, into: pos + node.nodeSize + 1 })

			return false
		})
	}

	for (const { from, to, into } of moves.sort((a, b) => b.from - a.from)) {
		const code = tr.doc.slice(from, to).content

		tr.insert(into, code)
		tr.delete(from, to)
	}
}

// Deletes [from, to) (onto `tr`) with what outlives deletion put back where it was (range markers, comment
// anchors): these repairs skip the invariants that keep them for an edit.
function deleteKeeping(tr: Transaction, from: number, to: number): void {
	const markers: MarkerAttrs[] = []

	tr.doc.nodesBetween(from, to, (node, pos) => {
		if (pos < from || pos + node.nodeSize > to) return !node.isLeaf

		if (node.isBlock) for (const marker of (node.attrs["before"] as MarkerList | undefined) ?? []) markers.push(marker)

		for (const marker of survivorsOf(node)) markers.push(marker)

		return !node.isLeaf
	})

	tr.delete(from, to)

	if (markers.length > 0) reinsert(tr, from, markers)
}

const DELETING = [docxSchema.marks.deletion, docxSchema.marks.move_from]

// Field characters the transactions' tracked deletions marked without the rest of their field: unmarked
// (onto `tr`, whose steps follow them).
function wholeDeletions(transactions: readonly Transaction[], tr: Transaction): void {
	const ranges: number[] = []

	transactions.forEach((step, index) => {
		const later = transactions.slice(index + 1)

		step.steps.forEach((each, k) => {
			for (const one of markStepsOf(each) ?? []) {
				if (
					!isAddMarkLike(one) ||
					!(
						DELETING.includes(one.mark.type) ||
						(one instanceof SetMarkSetsStep && one.types.some(type => DELETING.includes(type)))
					)
				)
					continue

				// From after the step to the end of the transactions, then through `tr`.
				const map = (pos: number, assoc: number): number =>
					tr.mapping.map(
						later.reduce((at, next) => next.mapping.map(at, assoc), step.mapping.slice(k + 1).map(pos, assoc)),
						assoc
					)

				ranges.push(map(one.from, -1), map(one.to, 1))
			}
		})
	})

	if (ranges.length === 0) return

	const doc = tr.doc
	let any = false

	for (let k = 0; k < ranges.length && !any; k += 2) {
		const from = Math.max(0, Math.min(ranges[k] ?? 0, doc.content.size))
		const to = Math.max(from, Math.min(ranges[k + 1] ?? 0, doc.content.size))

		doc.nodesBetween(from, to, node => {
			if (node.type === nodes.field_char) any = true

			return !any && !node.isLeaf
		})
	}

	if (!any) return

	const deleted = (node: Node): boolean => DELETING.some(type => type.isInSet(node.marks) !== undefined)
	const open: { pos: number; deleted: boolean }[][] = []
	const mixed: { pos: number; deleted: boolean }[][] = []

	doc.descendants((node, pos) => {
		if (node.type !== nodes.field_char) return !node.isLeaf

		const kind = node.attrs["kind"] as string
		const char = { pos, deleted: deleted(node) }

		if (kind === "begin") open.push([char])
		else open[open.length - 1]?.push(char)

		if (kind === "end") {
			const group = open.pop()

			if (group !== undefined && group.some(entry => entry.deleted) && group.some(entry => !entry.deleted)) mixed.push(group)
		}

		return false
	})

	// From the last, so earlier positions hold (marks and attributes move nothing anyway).
	for (const group of mixed.reverse()) {
		const first = group[0]
		const last = group[group.length - 1]
		const deletion = group
			.map(char => docxSchema.marks.deletion.isInSet(doc.nodeAt(char.pos)?.marks ?? []))
			.find(mark => mark !== undefined)

		const inserted = first === undefined || last === undefined ? "none" : insertedBy(doc, first.pos, last.pos + 1, deletion)

		// A deletion takes all of it, as an untracked one does: for real when its author inserted all of it, else
		// marked (what another inserted too: inserted and deleted, as Word records it); a move takes a field whole
		// or none of it.
		if (
			deletion !== undefined &&
			first !== undefined &&
			last !== undefined &&
			inserted === "all" &&
			deletable(doc, first.pos, last.pos + 1)
		) {
			deleteKeeping(tr, first.pos, last.pos + 1)
		} else if (deletion !== undefined && first !== undefined && last !== undefined) {
			deleteWhole(tr, first.pos, last.pos + 1, deletion)
		} else {
			for (const char of group) if (char.deleted) for (const type of DELETING) tr.removeMark(char.pos, char.pos + 1, type)
		}
	}
}

// Whether [from, to) of `doc` holds content inserted while tracking: all of it by the author of `deletion`
// (paragraph marks too), none of it, or some.
function insertedBy(doc: Node, from: number, to: number, deletion: Mark | undefined): "all" | "none" | "some" {
	let own = 0
	let other = 0
	let plain = 0

	doc.nodesBetween(from, to, (node, pos) => {
		if (node.type === nodes.paragraph) {
			if (pos + node.nodeSize - 1 < to && pos >= doc.resolve(from).before()) {
				if (((node.attrs["revision"] as number) & RevisionFlag.Inserted) === 0) plain++
				else if (paragraphChange(node)?.inserted?.author === deletion?.attrs["author"]) own++
				else other++
			}

			return true
		}

		if (!node.isInline || !markable(node) || pos < from || pos + node.nodeSize > to) return !node.isInline

		const insertion = docxSchema.marks.insertion.isInSet(node.marks)

		if (insertion === undefined) plain++
		else if (insertion.attrs["author"] === deletion?.attrs["author"]) own++
		else other++

		return false
	})

	return other === 0 && plain === 0 && own > 0 ? "all" : own === 0 && other === 0 ? "none" : "some"
}

// Marks [from, to) of `tr`'s document deleted by `deletion` (a tracked deletion's mark): what tracking marks of
// it, not deleted yet, and the paragraph marks inside, as a tracked deletion over paragraphs records them.
function deleteWhole(tr: Transaction, from: number, to: number, deletion: Mark): void {
	const doc = tr.doc
	const stamp: RevisionStamp = {
		author: (deletion.attrs["author"] as string | null) ?? "",
		date: (deletion.attrs["date"] as string | null) ?? "",
		id: deletion.attrs["id"] as number
	}

	doc.nodesBetween(from, to, (node, pos) => {
		if (node.type === nodes.paragraph) {
			// Its mark inside the range: deleted with it.
			if (pos + node.nodeSize - 1 < to && pos >= doc.resolve(from).before()) {
				const revision = node.attrs["revision"] as number

				if ((revision & RevisionFlag.Deleted) === 0) {
					tr.setNodeAttribute(pos, "revision", revision | RevisionFlag.Deleted)
					setParagraphChange(tr, pos, tr.doc.nodeAt(pos) ?? node, { ...paragraphChange(node), deleted: stamp })
				}
			}

			return true
		}

		if (node.isInline && markable(node) && !isDeleted(node) && pos >= from && pos + node.nodeSize <= to)
			tr.addMark(pos, pos + node.nodeSize, deletion)

		return !node.isInline
	})
}

// Fields whose new result drops their formatting (a w:fldSimple without \* MERGEFORMAT: an update writes its
// result without properties, §17.16.4.3) lose their formatting marks with a new result (onto `tr`): an update
// made, or a tracked one accepted. A tracked update pending keeps them (its result before shows them), and one
// rejected brings that result back with them.
function unformatResults(transactions: readonly Transaction[], tr: Transaction): void {
	const points: number[] = []

	transactions.forEach((step, index) => {
		if (isHistoryTransaction(step)) return

		const later = transactions.slice(index + 1)

		step.steps.forEach((one, k) => {
			const positions =
				one instanceof SetAttrsStep
					? one.entries.filter(entry => "result" in entry.attrs || "update" in entry.attrs).map(entry => entry.pos)
					: one instanceof AttrStep && (one.attr === "result" || one.attr === "update")
						? [one.pos]
						: []

			for (const pos of positions) {
				const was = step.docs[k]?.nodeAt(pos)
				const after = step.docs[k + 1]?.nodeAt(pos) ?? (k + 1 === step.steps.length ? step.doc.nodeAt(pos) : null)

				if (was?.type !== nodes.field || after?.type !== nodes.field || !resultDropsFormatting(after)) continue

				const before = fieldUpdateOf(was)

				// Pending, unchanged, or a tracked update rejected: the formatting stays.
				if (
					fieldUpdateOf(after) !== null ||
					(before === null && was.attrs["result"] === after.attrs["result"]) ||
					(before !== null && after.attrs["result"] === before.result)
				)
					continue

				points.push(
					tr.mapping.map(
						later.reduce((at, next) => next.mapping.map(at, 1), step.mapping.slice(k + 1).map(pos, 1)),
						1
					)
				)
			}
		})
	})

	for (const pos of points) {
		const node = tr.doc.nodeAt(pos)

		if (node?.type !== nodes.field || !resultDropsFormatting(node)) continue

		unformatField(tr, pos, node)
	}
}

// Where a step changed its document, in the document after it.
function stepRanges(step: Step): readonly { readonly from: number; readonly to: number }[] {
	if (step instanceof SetAttrsStep) return step.entries.map(entry => ({ from: entry.pos, to: entry.pos + 1 }))

	const parts = markStepsOf(step)

	if (parts !== undefined) return parts.flatMap(markStepPieces)
	if (step instanceof AttrStep || step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep)
		return [{ from: step.pos, to: step.pos + 1 }]

	const range = step as unknown as { from?: number; to?: number }

	if (typeof range.from !== "number" || typeof range.to !== "number") return []

	const map = step.getMap()

	return [{ from: map.map(range.from, -1), to: map.map(range.to, 1) }]
}

const FORMAT_CHANGE = docxSchema.marks.format_change

function propertiesOf(marksOf: readonly Mark[]): readonly Mark[] {
	return marksOf.filter(mark => FORMATTED.has(mark.type) && mark.type !== FORMAT_CHANGE)
}

function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
	return a.length === b.length && a.every(mark => mark.isInSet(b))
}

// Each field atom between `from` and `to` (a plain loop: Bold over a whole document walks every run once).
function fieldsBetween(node: Node, start: number, from: number, to: number, f: (field: Node, pos: number) => void): void {
	for (let index = 0, pos = start; index < node.childCount && pos < to; index++) {
		const child = node.child(index)
		const end = pos + child.nodeSize

		if (end > from) {
			if (child.type === nodes.field) f(child, pos)
			else if (!child.isLeaf && !child.isText) fieldsBetween(child, pos + 1, from, to, f)
		}

		pos = end
	}
}

// Whether a step may change the formatting state of a field of the file (with no states to carry): a
// formatting change taken off or given, or formatting given while tracking. Content replaced keeps its atoms'
// states with their nodes (an undo brings back the nodes it took), and typing, tracked deletions and their undo
// do not change one.
function changesFormatState(step: Step, tracked: boolean): boolean {
	const changes = (type: MarkType): boolean => type === FORMAT_CHANGE || (tracked && FORMATTED.has(type))

	const parts = markStepsOf(step)

	if (parts !== undefined) return parts.some(part => markStepTypes(part).some(changes))
	if (step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep) return changes(step.mark.type)

	return !(step instanceof ReplaceStep || step instanceof ReplaceAroundStep || step instanceof AttrStep || step instanceof SetAttrsStep)
}

// The documents whose fields may hold states, from the first one given one on (each later one carries them).
const WITH_STATES = new WeakSet<Node>()

// The formatting state of the file's fields the transactions changed (fields/format.ts FieldFormatState): a
// tracked change read with one leaving its atom is accepted when its formatting stays, else rejected; a
// tracked formatting over one keeping its change records who made it and the formatting before; the state goes
// with the atom's new node.
function followFormatStates(transactions: readonly Transaction[]): void {
	for (const tr of transactions) {
		if (!tr.docChanged) continue

		const carried = WITH_STATES.has(tr.before)
		const plan = planOf(tr)

		if (carried) WITH_STATES.add(tr.doc)
		else if (!tr.steps.some(step => changesFormatState(step, plan !== undefined))) continue

		const back = tr.mapping.invert()
		// One walk over the span every step changed (a step over many pieces, Bold over everything, walks once).
		let from = Infinity
		let to = -Infinity

		tr.steps.forEach((step, index) => {
			const later = tr.mapping.slice(index + 1)

			for (const range of stepRanges(step)) {
				from = Math.min(from, later.map(range.from, -1))
				to = Math.max(to, later.map(range.to, 1))
			}
		})

		from = Math.max(0, from)
		to = Math.min(tr.doc.content.size, to)

		if (to <= from) continue

		// The file's fields before, by position (one walk, not a lookup from the top per field).
		const before = new Map<number, Node>()

		fieldsBetween(tr.before, 0, back.map(from, -1), back.map(to, 1), (node, pos) => {
			if ((node.attrs["src"] as number) !== NO_SOURCE) before.set(pos, node)
		})

		if (before.size > 0)
			fieldsBetween(tr.doc, 0, from, to, (node, pos) => {
				if ((node.attrs["src"] as number) === NO_SOURCE) return

				const was = before.get(back.map(pos, 1))

				if (was === undefined || was === node || was.attrs["src"] !== node.attrs["src"]) return

				let state = fieldFormatState(was)
				const had = FORMAT_CHANGE.isInSet(was.marks)
				const has = FORMAT_CHANGE.isInSet(node.marks)

				if (had !== undefined && has === undefined)
					state = { resolved: sameMarks(propertiesOf(was.marks), propertiesOf(node.marks)) ? "accept" : "reject" }
				else if (had === undefined && has !== undefined) state = undefined
				else if (
					plan !== undefined &&
					had !== undefined &&
					has !== undefined &&
					had.eq(has) &&
					state?.tracked === undefined &&
					!sameMarks(propertiesOf(was.marks), propertiesOf(node.marks))
				)
					state = { ...state, tracked: { author: plan.stamp.author, date: plan.stamp.date, from: propertiesOf(was.marks) } }

				setFieldFormatState(node, state)

				if (state !== undefined) WITH_STATES.add(tr.doc)
			})
	}
}

function repair(transactions: readonly Transaction[], state: EditorState): Transaction | null {
	followFormatStates(transactions)

	const tr = repairCharacters(transactions, state)

	rejoinCodes(transactions, tr)
	wholeDeletions(transactions, tr)
	unformatResults(transactions, tr)
	unformattable(transactions, tr)

	return tr.docChanged ? markInternal(tr) : null
}

// Characters an edit left without partners, and the rest of fields it took one of (see the top).
function repairCharacters(transactions: readonly Transaction[], state: EditorState): Transaction {
	const removed: number[] = []
	const cut: number[] = []
	let any = false

	// The session's own transactions too where they took field characters (Accept or Reject of a part of a
	// field's tracked change takes the characters it covers): a field is not left without its other characters.
	transactions.forEach((tr, index) => {
		if (!tr.docChanged || isHistoryTransaction(tr)) return

		const points = touched(tr)

		if (points === undefined || (isInternal(tr) && points.removed.length === 0)) return

		any = true

		// Carried through the transactions after it.
		const later = transactions.slice(index + 1)
		const carry = (point: number): number => later.reduce((at, next) => next.mapping.map(at, -1), point)

		for (const point of points.removed) removed.push(carry(point))
		for (const point of points.cut) cut.push(carry(point))
	})

	if (!any) return state.tr

	const doc = state.doc
	// Characters without partners before these edits (a file's own) stay as they are.
	const first = transactions[0]
	const kept = new Set<number>()

	if (first !== undefined)
		for (const char of unmatched(first.before)) {
			let pos: number | null = char.pos

			for (const tr of transactions) {
				const mapped: { deleted: boolean; pos: number } | null = pos === null ? null : tr.mapping.mapResult(pos, 1)

				pos = mapped === null || mapped.deleted ? null : mapped.pos
			}

			if (pos !== null) kept.add(pos)
		}

	const stray = unmatched(doc).filter(char => !kept.has(char.pos))
	const tr = state.tr
	const ranges: [number, number][] = []

	// Fields an edit took a separate or instruction text of: whole (the innermost holding where it went).
	if (cut.length > 0) {
		const fields = fieldRanges(doc)

		for (const point of cut) {
			let inner: [number, number] | undefined

			for (const field of fields)
				if (field[0] < point && point < field[1] && (inner === undefined || field[0] > inner[0])) inner = field

			if (inner !== undefined && !kept.has(inner[0])) ranges.push(inner)
		}
	}

	if (stray.length === 0 && ranges.length === 0) return tr

	// The rest of a field one of whose characters an edit deleted: from its begin to where its end was, or from
	// where its begin was to its end.
	const open = stray.filter(char => char.kind === "begin" || char.kind === "end")
	const char = open.length === 1 ? open[0] : undefined

	if (char !== undefined && removed.length > 0) {
		const after = Math.min(...removed.filter(point => point > char.pos))
		const before = Math.max(...removed.filter(point => point <= char.pos))

		if (char.kind === "begin" && Number.isFinite(after)) ranges.push([char.pos, after])
		else if (char.kind === "end" && Number.isFinite(before)) ranges.push([before, char.pos + 1])
	}

	// Outermost first; one inside another goes with it.
	ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])

	const whole: [number, number][] = []

	for (const range of ranges) {
		const last = whole[whole.length - 1]

		if (last !== undefined && range[0] < last[1]) continue
		if (deletable(doc, range[0], range[1])) whole.push(range)
	}

	for (const [from, to] of whole.reverse()) deleteKeeping(tr, from, to)

	// What is still without partners goes alone.
	for (const left of unmatched(tr.doc).reverse()) {
		const before = tr.mapping.invert().map(left.pos, 1)

		if (!kept.has(before)) deleteKeeping(tr, left.pos, left.pos + 1)
	}

	return tr
}

// Field characters in [from, to) of `doc`, added to `out`.
function charsIn(doc: Node, from: number, to: number, out: Set<Node>): void {
	if (to > from)
		doc.nodesBetween(from, to, node => {
			if (node.type === nodes.field_char) out.add(node)

			return !node.isLeaf
		})
}

// A move (field characters taken out and put back, the same nodes: a drag, a block moved) that leaves a field
// spanning paragraphs without its partners is refused rather than repaired: Word moves a field whole (a
// selection taking one of its boundaries takes all of it), and dropping its characters would lose the field.
function brokenMove(tr: Transaction): string | undefined {
	if (!tr.docChanged || isHistoryTransaction(tr) || isInternal(tr)) return undefined

	const gone = new Set<Node>()
	const put = new Set<Node>()

	tr.steps.forEach((step, index) => {
		if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep)) return

		const doc = tr.docs[index] as Node

		if (step instanceof ReplaceAroundStep) {
			charsIn(doc, step.from, step.gapFrom, gone)
			charsIn(doc, step.gapTo, step.to, gone)
		} else {
			charsIn(doc, step.from, step.to, gone)
		}

		step.slice.content.descendants(node => {
			if (node.type === nodes.field_char) put.add(node)

			return !node.isLeaf
		})
	})

	if (![...put].some(node => gone.has(node)) || unmatched(tr.doc).length <= unmatched(tr.before).length) return undefined

	return "A move would take a field spanning paragraphs apart"
}

const FORMATTED: ReadonlySet<MarkType> = new Set([...FORMATTING_MARKS, "format_change" as const].map(name => docxSchema.marks[name]))

// Whether a document holds a field no run can format (fields/format.ts unformattableFields): known where it was
// built, carried from the steps alone (a step brings one in only with the content it inserts or the field
// attributes it sets), found by a walk only where neither tells.
const FIELD_KINDS = ["simple", "src", "result"]

// (The answer for each top-level block kept: content an undo brings back, or a later look at the same blocks,
// reads it.)
function someUnformattable(content: Fragment, keep = true): boolean {
	for (let index = 0; index < content.childCount; index++) {
		const child = content.child(index)

		if (
			child.type === nodes.field
				? !holdsFormatting(child)
				: !child.isLeaf && (keep ? blockUnformattable(child) : someUnformattable(child.content, false))
		)
			return true
	}

	return false
}

function blockUnformattable(node: Node): boolean {
	let holds = unformattableFields.get(node)

	if (holds === undefined) {
		holds = someUnformattable(node.content, false)
		unformattableFields.set(node, holds)
	}

	return holds
}

// Whether a step may bring such a field in; undefined when it cannot tell.
function bringsUnformattable(step: Step): boolean | undefined {
	if (isRemarking(step)) return false
	if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) return someUnformattable(step.slice.content)
	if (step instanceof AttrStep) return FIELD_KINDS.includes(step.attr) ? undefined : false
	if (step instanceof SetAttrsStep) return step.entries.some(entry => FIELD_KINDS.some(name => name in entry.attrs)) ? undefined : false

	return markStepsOf(step) !== undefined || step instanceof AddNodeMarkStep || step instanceof RemoveNodeMarkStep ? false : undefined
}

function carryUnformattable(tr: Transaction): void {
	if (!tr.docChanged || unformattableFields.has(tr.doc)) return

	let holds = unformattableFields.get(tr.before)

	// (Once found, kept: it only lets unformattable look at what mark steps changed.)
	for (let index = 0; holds === false && index < tr.steps.length; index++) holds = bringsUnformattable(tr.steps[index] as Step)

	if (holds !== undefined) unformattableFields.set(tr.doc, holds)
}

function holdsUnformattable(doc: Node): boolean {
	let holds = unformattableFields.get(doc)

	if (holds === undefined) {
		holds = someUnformattable(doc.content)
		unformattableFields.set(doc, holds)
	}

	return holds
}

// Takes the formatting marks off field atom `node` at `pos` (onto `tr`).
function unformatField(tr: Transaction, pos: number, node: Node): void {
	for (const mark of node.marks) if (FORMATTED.has(mark.type)) tr.step(new SetMarksStep([{ from: pos, to: pos + 1, mark: null }], mark))
}

function formats(type: MarkType): boolean {
	return FORMATTED.has(type)
}

// Whether a step may give a field formatting: a formatting mark step.
function formatsFields(step: Step): boolean {
	if (step instanceof AddNodeMarkStep) return formats(step.mark.type)

	return markStepsOf(step)?.some(part => !(part instanceof RemoveMarkStep) && markStepTypes(part).some(formats)) ?? false
}

// Whether `content` holds such a field with formatting (pasted or moved).
function someFormattedUnformattable(content: Fragment, top = true): boolean {
	for (let index = 0; index < content.childCount; index++) {
		const child = content.child(index)

		if (
			child.type === nodes.field
				? !holdsFormatting(child) && child.marks.some(mark => formats(mark.type))
				: !child.isLeaf && (!top || blockUnformattable(child)) && someFormattedUnformattable(child.content, false)
		)
			return true
	}

	return false
}

// A field no run can format never holds formatting (onto `tr`): the formatting a mark step gave one, a field
// inserted with formatting, and one whose result went goes.
function unformattable(transactions: readonly Transaction[], tr: Transaction): void {
	for (const one of transactions) carryUnformattable(one)

	transactions.forEach((one, at) => {
		if (!one.docChanged) return

		// One walk over the span the steps changed (a step over many pieces walks once); a mark step's only where
		// the document holds such a field.
		let from = Infinity
		let to = -Infinity
		let marking: boolean | undefined

		one.steps.forEach((step, index) => {
			let ranges: readonly { readonly from: number; readonly to: number }[]

			if (formatsFields(step)) {
				marking ??= holdsUnformattable(one.before) || one.steps.some(other => bringsUnformattable(other) !== false)

				if (!marking) return

				ranges = stepRanges(step)
			} else if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
				if (isRemarking(step) || !someFormattedUnformattable(step.slice.content)) return

				ranges = stepRanges(step)
			} else if (step instanceof AttrStep || step instanceof SetAttrsStep) {
				if (bringsUnformattable(step) === false) return

				ranges = stepRanges(step)
			} else return

			const rest = one.mapping.slice(index + 1)

			for (const range of ranges) {
				from = Math.min(from, rest.map(range.from, -1))
				to = Math.max(to, rest.map(range.to, 1))
			}
		})

		if (from === Infinity) return

		const later = transactions.slice(at + 1)
		const map = (pos: number, assoc: number): number =>
			tr.mapping.map(
				later.reduce((point, next) => next.mapping.map(point, assoc), pos),
				assoc
			)
		const doc = tr.doc
		const start = Math.max(0, map(from, -1))
		const end = Math.min(doc.content.size, map(to, 1))

		if (end > start)
			fieldsBetween(doc, 0, start, end, (node, pos) => {
				if (!holdsFormatting(node)) unformatField(tr, pos, node)
			})
	})
}

// A field spanning paragraphs (a table of contents built as paragraphs) whose begin and end an edit puts in one
// paragraph (that paragraph joined with the one holding its end, a deletion across its paragraphs) is refused:
// read back, a field in one paragraph is one field atom (edit/build.ts), not the characters the editor holds, so
// no save could write what the editor shows.
function collapsedField(tr: Transaction): string | undefined {
	if (!tr.docChanged || isHistoryTransaction(tr) || isInternal(tr)) return undefined

	let found = false

	// One walk however many ranges a transaction changed (Replace All changes one per match).
	nodesBetweenRanges(tr.doc, changedRanges(tr, false, NO_ATTRS), node => {
		if (found || node.isTextblock) {
			if (!found && node.type === nodes.paragraph) found = beginsAndEnds(node)

			return false
		}

		return !node.isLeaf
	})

	return found ? "A field spanning paragraphs would begin and end in one paragraph" : undefined
}

const NO_ATTRS: ReadonlySet<string> = new Set()

// Whether a paragraph holds a field character begin and the end that closes it.
function beginsAndEnds(paragraph: Node): boolean {
	let open = 0

	for (let index = 0; index < paragraph.childCount; index++) {
		const child = paragraph.child(index)

		if (child.type !== nodes.field_char) continue

		const kind = child.attrs["kind"] as string

		if (kind === "begin") open++
		else if (kind === "end" && open > 0) return true
	}

	return false
}

export const FIELDS_STAGE: InvariantStage | null = {
	name: "fields",
	violation: tr => brokenMove(tr) ?? collapsedField(tr),
	repair
}
