import { Fragment, type Mark, type Node, type Slice } from "prosemirror-model"
import { closeHistory, isHistoryTransaction } from "prosemirror-history"
import type { Transaction } from "prosemirror-state"
import { AddMarkStep, AttrStep, RemoveMarkStep, ReplaceAroundStep, ReplaceStep, StepMap, type Step } from "prosemirror-transform"
import { blockText, boundValue, inlineText, noteBoundEdit, sharedBindings, unmappedKeys } from "../../forms/binding"
import {
	blockControlAround,
	checkboxGlyph,
	controlKey,
	controlOf,
	controlState,
	inlineControlAround,
	isoDate,
	pictureSwap,
	placeholderText,
	simpleBinding,
	typeable,
	type ControlAround,
	type ControlInfo,
	type ControlState
} from "../../forms/controls"
import { formatControlDate, parseControlDate } from "../../forms/dates"
import {
	bindingKey,
	boundAround,
	boundIndex,
	controlSpans,
	followIndex,
	holdsBindings,
	noteBoundCopies,
	type ControlSpan
} from "../../forms/positions"
import { sessionOfDoc } from "../../forms/sessions"
import type { StoryPart } from "../../model/index"
import type { DocxEditContext } from "../context"
import {
	SetMarkSetsStep,
	SetMarksStep,
	isAddMarkLike,
	markStepTypes,
	markStepsOf,
	type MarkPiece,
	type MarkStep,
	type MarksPiece
} from "../marks"
import { builtInStyleId } from "../formats"
import { lockedStyleViolation, protectionOf, protectionViolation } from "../protection"
import { NO_SOURCE, docxSchema, type MarkerList } from "../schema"
import type { DocxEditorSession } from "../session"
import {
	insertedSlices,
	invariantViolation,
	isCommand,
	isInternal,
	isRemarking,
	markCommand,
	markCommandAfter,
	markInternal,
	replacedAfter,
	replacesOf
} from "./core"
import type { InvariantStage } from "./index"

// Content controls keep what Word keeps (ECMA-376 Part 1 §17.5.2): locked content (w:lock contentLocked,
// sdtContentLocked) and controls whose content only form commands change (a checkbox, a drop-down list, a
// picture, a group outside the controls inside it) or that are bound in a way the editor does not update are
// not typed into; a control locked against deletion (sdtLocked, sdtContentLocked) stays. A control showing its
// placeholder (w:showingPlcHdr) loses the placeholder text and its style once something is typed into it, and
// gets them back once emptied, as in Word. Document protection limits edits to what its mode allows
// (edit/protection.ts).
//
// These run as transaction transformers (handlers/forms.ts registers them): one before tracked changes record
// a transaction (a protection that forces tracking turns it on), one after it (protection, locks,
// placeholders). What they refuse, this stage refuses.

const nodes = docxSchema.nodes
const marks = docxSchema.marks
const refusals = new WeakMap<Transaction, string>()
// Transactions form commands made (they set control state themselves).
const formCommands = new WeakSet<Transaction>()
// Sessions whose transaction being transformed is a form command's (between the two transformers).
const commandOf = new WeakSet<DocxEditorSession>()
// Sessions holding controls the editor made (a part without source controls is not looked at otherwise).
const madeIn = new WeakSet<DocxEditorSession>()
// What placeholder text keeps of the content it stands in for.
const DROPPED_MARKS = new Set<string>(["insertion", "deletion", "move_from", "move_to", "format_change", "link"])
const PLACEHOLDER_STYLE = "Placeholder Text"
// Marks a tracked deletion of content sets.
const DELETIONS: ReadonlySet<string> = new Set(["deletion", "move_from"])

export const FORMS_STAGE: InvariantStage | null = {
	name: "forms",
	violation: tr => refusals.get(tr),
	// Bound values follow once everything is applied (tracked changes record deletions in a repair of their own).
	// Changes the transformers do not see (undo, a review resolution) included.
	repair: (transactions, state) => {
		const first = transactions[0]
		const session =
			transactions.map(tr => sessionOf.get(tr)).find(found => found !== undefined) ??
			(first === undefined ? undefined : sessionOfDoc(first.before))

		if (session === undefined || !transactions.some(tr => tr.docChanged)) return null
		noteForeignCopies(session, transactions)

		const pasted = notePasted(session, transactions)
		const shared = sharedKeys(session)

		if (shared.size === 0) return null

		followIndex(session.story.part, transactions)

		const points: number[] = []

		transactions.forEach((tr, index) => {
			let at = touchedPoints(tr)

			for (let later = index + 1; later < transactions.length; later++) {
				const mapping = (transactions[later] as Transaction).mapping

				at = at.map(pos => mapping.map(pos, -1))
			}

			points.push(...at)
		})

		const tr = state.tr

		return mirrorBindings(tr, session, points, shared, pasted) ? markInternal(tr) : null
	}
}

// Copies of another part's controls coming in: a story without controls of its own holds controls then, and
// bound ones once a copy keeps its binding (Word keeps a copy mapped wherever it is pasted).
function noteForeignCopies(session: DocxEditorSession, transactions: readonly Transaction[]): void {
	for (const tr of transactions) {
		// Undo and redo put back content an edit of this session inserted first, noted then.
		if (isHistoryTransaction(tr)) continue

		for (const step of tr.steps) {
			if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep) || step.slice.size === 0 || isRemarking(step)) continue

			for (const slice of insertedSlices(step))
				slice.content.descendants(node => {
					if (node.type === nodes.sdt) noteForeignCopy(session, node)

					for (const mark of node.marks) if (mark.type === marks.content_control) noteForeignCopy(session, mark)

					return true
				})
		}
	}
}

function noteForeignCopy(session: DocxEditorSession, holder: Node | Mark): void {
	if (controlState(holder)?.properties === undefined) return

	madeIn.add(session)

	if (bindingKey(controlOf(session.story.part, holder)) !== undefined) noteBoundCopies(session)
}

// Binding keys of controls pasted into a session's story (a copy shares its original's node).
const pastedKeys = new WeakMap<DocxEditorSession, Set<string>>()

// The binding keys several controls of a session's story share: the source's, and those of pasted copies.
function sharedKeys(session: DocxEditorSession): ReadonlySet<string> {
	const source = sharedBindings(session.story.part)
	const pasted = pastedKeys.get(session)
	const keys = pasted === undefined ? source : new Set([...source, ...pasted])
	const unmapped = unmappedKeys(session.context)

	// Controls bound to no node, or to one with child elements, are no one's to keep alike.
	return unmapped.size === 0 ? keys : new Set([...keys].filter(key => !unmapped.has(key)))
}

// Whether a control holder is a copy of a source control (a paste made it one, invariants/core.ts).
function isCopy(holder: Node | Mark): boolean {
	const state = controlState(holder)

	return (holder.attrs["src"] as number) === NO_SOURCE && (state?.copy !== undefined || state?.properties !== undefined)
}

// Records the copies of bound controls the transactions made (only a part holding bindings has any to copy):
// their keys, and the ranges of the final document holding them.
function notePasted(
	session: DocxEditorSession,
	transactions: readonly Transaction[]
): { readonly ranges: readonly number[]; readonly keys: ReadonlySet<string> } {
	const part = session.story.part
	const out: number[] = []
	const keys = new Set<string>()

	if (!holdsBindings(session)) return { ranges: out, keys }

	let found = false
	const add = (holder: Node | Mark): void => {
		const info = isCopy(holder) ? controlOf(part, holder) : undefined
		const binding = info?.binding === null || info === undefined || info.richBinding ? undefined : simpleBinding(info.binding)

		if (binding === undefined) return

		found = true
		keys.add(binding.key)

		let known = pastedKeys.get(session)

		if (known === undefined) {
			known = new Set()
			pastedKeys.set(session, known)
		}

		known.add(binding.key)
	}
	// [from, to] of step `at` of transaction `index`, in the final document.
	const record = (index: number, at: number, from: number, to: number): void => {
		const tr = transactions[index] as Transaction

		for (let later = at + 1; later < tr.steps.length; later++) {
			const map = tr.mapping.maps[later] ?? StepMap.empty

			from = map.map(from, 1)
			to = map.map(to, -1)
		}

		for (let next = index + 1; next < transactions.length; next++) {
			const mapping = (transactions[next] as Transaction).mapping

			from = mapping.map(from, 1)
			to = mapping.map(to, -1)
		}

		if (to > from) out.push(from, to)
	}

	transactions.forEach((tr, index) => {
		tr.steps.forEach((step, at) => {
			found = false

			if (step instanceof AttrStep) {
				const node = step.attr === "state" ? (tr.docs[at + 1] ?? tr.doc).nodeAt(step.pos) : null

				if (node?.type === nodes.sdt) add(node)
				if (found && node !== null) record(index, at, step.pos, step.pos + node.nodeSize)

				return
			}

			if (!(step instanceof ReplaceStep || step instanceof ReplaceAroundStep) || step.slice.size === 0) return

			for (const slice of insertedSlices(step))
				slice.content.descendants(node => {
					if (node.type === nodes.sdt) add(node)

					for (const mark of node.marks) if (mark.type === marks.content_control) add(mark)
				})

			if (found) tr.mapping.maps[at]?.forEach((_oldStart, _oldEnd, newStart, newEnd) => record(index, at, newStart, newEnd))
		})
	})

	return { ranges: out, keys }
}

// The session a transformed transaction belongs to (for the repair after it).
const sessionOf = new WeakMap<Transaction, DocxEditorSession>()

// Marks a form command's transaction: recorded like typing when tracking is on, its state changes allowed.
// `made`: it inserts a control.
export function formCommand(tr: Transaction, session: DocxEditorSession, made = false): Transaction {
	// Each command is an undo step of its own.
	formCommands.add(closeHistory(tr))

	if (made) madeIn.add(session)

	return tr
}

// Whether a session's story may hold content controls (source ones, or ones the editor made).
export function mayHoldControls(session: DocxEditorSession): boolean {
	return session.story.part.sdts.count > 0 || madeIn.has(session)
}

// Documents holding copies of legacy form fields (pasted: a part without source fields may hold them).
const fieldCopiesIn = new WeakSet<DocxEditContext>()

export function noteFieldCopy(context: DocxEditContext): void {
	fieldCopiesIn.add(context)
}

// Whether a session's story may hold legacy form fields.
export function mayHoldFields(session: DocxEditorSession): boolean {
	return session.story.part.fields.count > 0 || fieldCopiesIn.has(session.context)
}

export function refusedForForms(tr: Transaction): string | undefined {
	return refusals.get(tr)
}

function refuse(tr: Transaction, reason: string, session: DocxEditorSession): Transaction {
	// The invariants never filter the session's own transactions (a bulk tracked change): nothing applies instead.
	if (isInternal(tr)) return session.state.tr

	refusals.set(tr, reason)

	return tr
}

// A link put on text in a plain text control, a command's or not: its content is one run with one set of
// formatting properties (ISO/IEC 29500-1 §17.5.2.44), which a hyperlink breaks.
function plainTextLink(tr: Transaction, session: DocxEditorSession): string | undefined {
	if (isInternal(tr) || !mayHoldControls(session)) return undefined

	const part = session.story.part

	for (let k = 0; k < tr.steps.length; k++) {
		const doc = tr.docs[k] as Node

		for (const step of markStepsOf(tr.steps[k] as Step) ?? []) {
			if (!(step instanceof AddMarkStep) || step.mark.type !== marks.link) continue

			let found = false

			doc.nodesBetween(step.from, step.to, (node, pos) => {
				if (found) return false
				if (!node.isText) return true

				const from = Math.max(pos, step.from)
				const to = Math.min(pos + node.nodeSize, step.to)

				found = from < to && plainTextAt(part, doc, from, to) !== undefined

				return false
			})

			if (found) return REASONS.notText
		}
	}

	return undefined
}

// Before tracked changes record the transaction.
export function formsBefore(tr: Transaction, session: DocxEditorSession): Transaction {
	const context = session.context

	if (protectionOf(context).forcesTracking && !context.review.tracking) context.review.tracking = true

	if (formCommands.has(tr)) {
		commandOf.add(session)
		commandMarks.set(session, writtenControlMarks(tr))

		return tr
	}

	commandOf.delete(session)

	if (!tr.docChanged || isInternal(tr) || isCommand(tr) || !mayHoldControls(session)) return tr

	const out = unlockedFormatting(tr, session) ?? tr
	const refusal = plainTextInsert(out, session)

	if (refusal !== undefined) pendingRefusals.set(session, refusal)

	return out
}

// Locked content ([from, to] pairs) of controls in [from, to] of `doc` whose content may not change.
function lockedContent(part: StoryPart, doc: Node, from: number, to: number): number[] {
	const out: number[] = []

	doc.nodesBetween(from, to, (node, pos) => {
		if (node.type === nodes.sdt) {
			const info = controlOf(part, node)

			if (info !== undefined && typeable(info) === "contentLocked") {
				out.push(pos + 1, pos + node.nodeSize - 1)

				return false
			}
		}

		if (!node.inlineContent) return !node.isInline

		for (const span of controlSpans(node, pos + 1)) {
			const info = controlOf(part, span.mark)

			if (info !== undefined && typeable(info) === "contentLocked") out.push(span.from, span.to)
		}

		return false
	})

	// Sorted, overlapping ones (nested controls) joined.
	const pairs: [number, number][] = []

	for (let k = 0; k < out.length; k += 2) pairs.push([out[k] ?? 0, out[k + 1] ?? 0])

	pairs.sort((a, b) => a[0] - b[0])

	const merged: number[] = []

	for (const [start, end] of pairs) {
		const last = merged.length - 1

		if (last > 0 && start <= (merged[last] ?? 0)) merged[last] = Math.max(merged[last] ?? 0, end)
		else merged.push(start, end)
	}

	return merged
}

// [from, to] without the `locked` pairs (sorted, apart), as pairs.
function outside(from: number, to: number, locked: readonly number[]): number[] {
	const out: number[] = []
	let at = from

	for (let k = 0; k < locked.length; k += 2) {
		const start = locked[k] ?? 0
		const end = locked[k + 1] ?? 0

		if (end <= at || start >= to) continue
		if (start > at) out.push(at, start)

		at = Math.max(at, end)
	}

	if (at < to) out.push(at, to)

	return out
}

// Formatting a selection holding content controls whose content is locked formats everything else, as in Word:
// the transaction again with its mark steps leaving that content out; undefined when nothing needs leaving out.
function unlockedFormatting(tr: Transaction, session: DocxEditorSession): Transaction | undefined {
	const steps = tr.steps

	if (tr.before !== session.state.doc) return undefined

	const markSteps: MarkStep[] = []

	for (const step of steps) {
		const parts = markStepsOf(step)

		if (parts === undefined) return undefined

		markSteps.push(...parts)
	}

	const from = Math.min(...markSteps.map(step => step.from))
	const to = Math.max(...markSteps.map(step => step.to))
	const sorted = lockedContent(session.story.part, tr.before, from, to)

	if (sorted.length === 0) return undefined

	const out = session.state.tr

	for (const step of markSteps) {
		if (step.mark.type === marks.content_control) out.step(step)
		else if (step instanceof SetMarksStep || step instanceof SetMarkSetsStep) {
			const pieces: { from: number; to: number; mark?: Mark | null; marks?: readonly Mark[] }[] = []

			for (const piece of step.pieces as readonly { from: number; to: number }[]) {
				const kept = outside(piece.from, piece.to, sorted)

				for (let k = 0; k < kept.length; k += 2) pieces.push({ ...piece, from: kept[k] ?? 0, to: kept[k + 1] ?? 0 })
			}

			if (pieces.length === 0) continue
			if (step instanceof SetMarksStep) out.step(new SetMarksStep(pieces as MarkPiece[], step.mark))
			else out.step(new SetMarkSetsStep(step.types, pieces as MarksPiece[], step.mark))
		} else {
			const kept = outside(step.from, step.to, sorted)

			for (let k = 0; k < kept.length; k += 2) {
				if (step instanceof AddMarkStep) out.addMark(kept[k] ?? 0, kept[k + 1] ?? 0, step.mark)
				else out.removeMark(kept[k] ?? 0, kept[k + 1] ?? 0, step.mark)
			}
		}
	}

	if (!out.docChanged) return undefined

	out.setSelection(tr.selection.map(out.doc, StepMap.empty))

	if (tr.storedMarksSet) out.setStoredMarks(tr.storedMarks)
	if (tr.scrolledIntoView) out.scrollIntoView()

	for (const key of ["addToHistory", "uiEvent"]) if (tr.getMeta(key) !== undefined) out.setMeta(key, tr.getMeta(key))

	return out
}

// The control marks a form command wrote (by control), before tracked changes record it: what all of each
// control's content takes then (recording may leave its new content marked deleted for a moment).
const commandMarks = new WeakMap<DocxEditorSession, ReadonlyMap<string, Mark>>()

function writtenControlMarks(tr: Transaction): Map<string, Mark> {
	const out = new Map<string, Mark>()

	for (const step of tr.steps) {
		if (!(step instanceof ReplaceStep) || step.slice.size === 0) continue

		for (const slice of insertedSlices(step))
			slice.content.descendants(node => {
				for (const mark of node.marks) if (mark.type === marks.content_control) out.set(controlKey(mark), mark)

				return true
			})
	}

	return out
}

// Refusals the transformer before tracked changes found (the transaction it hands on may be a new one).
const pendingRefusals = new WeakMap<DocxEditorSession, string>()
const PLAIN_MARKS = new Set<string>(["content_control", "link"])

// The plain text control content inserted at [from, to] of `doc` goes into (an inline control's end counts:
// typing there appends to it, as in Word), or undefined.
function plainTextAt(part: StoryPart, doc: Node, from: number, to: number): ControlAround | undefined {
	const inline = inlineControlAround(part, doc, from, to)

	if (inline !== undefined) {
		const inside = from === to ? from > inline.from && from <= inline.to : from >= inline.from && to <= inline.to

		return inside && inline.info.type === "plainText" ? inline : undefined
	}

	const block = blockControlAround(part, doc, from, to)

	return block !== undefined && block.info.type === "plainText" ? block : undefined
}

// Whether a slice is more than text in the control `key` (undefined: in no run-level control): paragraphs, other
// inline content (a line break in a control of one line: `multiLine` off), other controls or links.
function structured(slice: Slice, key: string | undefined, multiLine: boolean): boolean {
	if (slice.openStart > 0 || slice.openEnd > 0) return true

	let found = false

	slice.content.descendants(node => {
		if (found) return false
		// A line break only where the control holds several lines.
		if (!node.isText && node.type !== nodes.tab && (node.type !== nodes.break || !multiLine)) found = true
		else if (
			node.marks.some(mark => PLAIN_MARKS.has(mark.type.name) && (mark.type !== marks.content_control || controlKey(mark) !== key))
		)
			found = true

		return false
	})

	return found
}

// Whether a step's slice may be more than text (`doc`: the document it applies to): anything but text carrying no
// control or link, or only the control mark of what is around it (typing in a control).
function maybeStructured(doc: Node, step: ReplaceStep): boolean {
	const slice = step.slice

	if (slice.openStart > 0 || slice.openEnd > 0) return true

	const $from = doc.resolve(step.from)
	const around = [...($from.nodeBefore?.marks ?? []), ...(doc.resolve(step.to).nodeAfter?.marks ?? [])]
	let found = false

	slice.content.forEach(node => {
		if (
			!node.isText ||
			node.marks.some(mark => PLAIN_MARKS.has(mark.type.name) && (mark.type !== marks.content_control || !mark.isInSet(around)))
		)
			found = true
	})

	return found
}

// The text of a slice: paragraphs on lines of their own, tabs and line breaks as characters. The empty paragraphs
// open ends leave where content went into a paragraph (a paragraph pasted inside one) add no line.
function sliceText(slice: Slice): string {
	const lines: string[] = []
	const leaf = (node: Node): string => (node.type === nodes.tab ? "\t" : node.type === nodes.break ? "\n" : "")

	if (slice.openStart === 0 && slice.openEnd === 0 && slice.content.firstChild?.isInline === true)
		return slice.content.textBetween(0, slice.content.size, "\n", leaf)

	slice.content.descendants(node => {
		if (!node.isTextblock) return !node.isInline

		lines.push(node.textBetween(0, node.content.size, "\n", leaf))

		return false
	})

	// Only around pasted text (Enter alone is empty paragraphs: a line break).
	if (lines.some(line => line !== "")) {
		if (slice.openStart > 0 && lines[0] === "") lines.shift()
		if (slice.openEnd > 0 && lines[lines.length - 1] === "") lines.pop()
	}

	return lines.join("\n")
}

// Content pasted into a plain text control comes in as plain text in the control's formatting, as Word pastes it:
// paragraphs as line breaks where the control allows several lines (w:multiLine, ECMA-376 Part 1 §17.5.2.44),
// else as spaces; Enter in a one-line control does nothing. Appends the steps to `tr`; why it cannot apply, or
// undefined.
function plainTextInsert(tr: Transaction, session: DocxEditorSession): string | undefined {
	const part = session.story.part
	const steps = tr.steps.length

	for (let k = 0; k < steps; k++) {
		const step = tr.steps[k]

		if (!(step instanceof ReplaceStep) || step.slice.size === 0) continue

		const doc = tr.docs[k] as Node

		if (!maybeStructured(doc, step)) continue
		const around = plainTextAt(part, doc, step.from, step.to)

		if (around === undefined || typeable(around.info) !== undefined) continue
		if (!structured(step.slice, around.kind === "inline" ? controlKey(around.holder) : undefined, around.info.multiLine)) continue

		const separator = around.info.multiLine ? "\n" : " "
		const raw = sliceText(step.slice)

		if (raw.replace(/\n/g, "") === "" && !around.info.multiLine) return REASONS.notText

		const text = separator === "\n" ? raw : raw.replace(/\n/g, separator)
		let from = step.from
		let to = step.from + step.slice.size

		for (let later = k; later < tr.steps.length; later++) {
			const map = tr.mapping.maps[later] ?? StepMap.empty

			from = later === k ? from : map.map(from, -1)
			to = later === k ? to : map.map(to, 1)
		}

		tr.replaceWith(from, to, textContent(text, contentMarks(doc, around)))
	}

	return undefined
}

// After tracked changes recorded it: protection, locks, placeholders.
export function formsAfter(tr: Transaction, session: DocxEditorSession): Transaction {
	const out = checked(tr, session)

	if (out.docChanged) sessionOf.set(out, session)

	return out
}

function checked(tr: Transaction, session: DocxEditorSession): Transaction {
	const command = commandOf.has(session)
	const pending = pendingRefusals.get(session)

	commandOf.delete(session)
	pendingRefusals.delete(session)

	if (!tr.docChanged) return tr
	if (pending !== undefined) return refuse(tr, pending, session)

	const protection = protectionViolation(tr, session, command) ?? lockedStyleViolation(tr, session.context)

	if (protection !== undefined) return refuse(tr, protection, session)

	const link = plainTextLink(tr, session)

	if (link !== undefined) return refuse(tr, link, session)
	if (command) {
		const written = commandMarks.get(session)

		commandMarks.delete(session)

		if (isInternal(tr)) return tr

		unifyStates(tr, written)

		return markCommand(tr)
	}

	const part = session.story.part

	if (!mayHoldControls(session)) return tr

	const lock = lockViolation(tr, part)

	if (lock !== undefined) return refuse(tr, lock, session)
	if (isInternal(tr) || invariantViolation(tr) !== undefined) return tr

	// A command (a tracked deletion is the review stage's): part of a placeholder deleted or marked deleted turns it
	// into text too.
	if (isCommand(tr)) {
		realizePlaceholders(tr, session, tr.steps.length, new Set())

		return tr
	}

	const before = tr.steps.length

	placeholders(tr, session, protectionOf(session.context).mode === "forms")
	typedStates(tr, part)

	// What this stage did beyond inline content and plain formatting (a control's marks or state, a control
	// taken away) is not a user's to do: the core lets it through a command, still judging the user's own steps
	// as copies. Otherwise the transaction stays the user's edit, which the core's copy repairs look at.
	return tr.steps.slice(before).every(userLike) ? tr : markCommandAfter(tr, before)
}

// Steps showing a pasted copy's placeholder whole: part of the paste.
const pasteSteps = new WeakSet<Step>()

function userLike(step: Step): boolean {
	if (pasteSteps.has(step)) return true
	if (step instanceof ReplaceStep) {
		let source = false

		step.slice.content.descendants(node => {
			if (node.marks.some(mark => mark.type === marks.content_control && (mark.attrs["src"] as number) !== NO_SOURCE)) source = true

			return !source
		})

		return !source && step.slice.openStart === 0 && step.slice.openEnd === 0 && step.slice.content.firstChild?.isInline !== false
	}
	return markStepsOf(step)?.every(part => part.mark.type === marks.char_style) ?? false
}

// Text typed into a combo box or a date control: the entry whose display text it is becomes the choice (none:
// free text), the date it reads as becomes the date (none: the last date stays), as Word keeps them.
function typedStates(tr: Transaction, part: StoryPart): void {
	const seen = new Set<string>()
	const changes: { around: ControlAround; state: ControlState }[] = []

	for (const point of touchedPoints(tr)) {
		const doc = tr.doc
		const at = Math.min(point, doc.content.size)

		if (!valuedAt(part, doc, at)) continue

		const around = inlineControlAround(part, doc, at, at) ?? blockControlAround(part, doc, at, at)

		if (around === undefined || around.info.showingPlaceholder || typeable(around.info) !== undefined) continue

		const info = around.info
		const key = `${controlKey(around.holder)}@${String(around.from)}`

		if (seen.has(key) || (info.type !== "comboBox" && info.date === null)) continue

		seen.add(key)

		const text = controlText(doc, around)
		const state = controlState(around.holder) ?? {}

		if (info.type === "comboBox") {
			const value = info.items.find(item => item.text === text)?.value ?? null

			if (value !== info.lastValue) changes.push({ around, state: { ...state, value } })
		} else if (info.date !== null) {
			const date = info.date
			const iso =
				date.iso !== null && formatControlDate(date.iso, date.format, date.lid, date.calendar) === text
					? date.iso
					: parseControlDate(text, date.format, date.lid, date.calendar)

			// Text that is no date keeps the last date as w:fullDate, as Word does.
			if (iso !== null && iso !== date.iso) changes.push({ around, state: { ...state, date: iso } })
		}
	}

	for (const { around, state } of changes) setControlState(tr, around, state)
}

// Whether a combo box or a date control may hold `pos`: one of the controls of its paragraph or around it is.
function valuedAt(part: StoryPart, doc: Node, pos: number): boolean {
	const $pos = doc.resolve(pos)
	const valued = (info: ControlInfo | undefined): boolean => info !== undefined && (info.type === "comboBox" || info.date !== null)

	for (let depth = $pos.depth; depth > 0; depth--) {
		const node = $pos.node(depth)

		if (node.type === nodes.sdt && valued(controlOf(part, node))) return true
	}

	let found = false

	if ($pos.parent.inlineContent)
		$pos.parent.forEach(child => {
			if (!found)
				for (const mark of child.marks) if (mark.type === marks.content_control && valued(controlOf(part, mark))) found = true
		})

	return found
}

// Whether a control showing its placeholder may hold [from, to]: a block one around it, or a run-level one marking
// content in it.
function placeholderAround(part: StoryPart, doc: Node, from: number, to: number): boolean {
	const $from = doc.resolve(from)

	for (let depth = $from.depth; depth > 0; depth--) {
		const node = $from.node(depth)

		if (node.type === nodes.sdt && controlOf(part, node)?.showingPlaceholder === true) return true
	}

	let found = false

	eachInline(doc, from, to, node => {
		for (const mark of node.marks)
			if (mark.type === marks.content_control && controlOf(part, mark)?.showingPlaceholder === true) found = true

		return !found
	})

	return found
}

// Calls `f` with each inline node of [from, to] until it returns false: from the paragraph holding the range when
// it is one (no walk from the top of the document), else by nodesBetween.
function eachInline(doc: Node, from: number, to: number, f: (node: Node) => boolean): void {
	const $from = doc.resolve(from)

	if (!$from.parent.inlineContent || to > $from.end()) {
		let going = true

		doc.nodesBetween(from, to, node => {
			if (going && node.isInline) going = f(node)

			return going
		})

		return
	}

	const parent = $from.parent
	let pos = $from.start()

	for (let index = 0; index < parent.childCount; index++) {
		const child = parent.child(index)
		const end = pos + child.nodeSize

		if (pos >= to) return
		if (end > from && !f(child)) return

		pos = end
	}
}

// Whether all inline content of [from, to] (one paragraph) is in a control going on before or after it (typed in
// a control).
function insideControl(doc: Node, from: number, to: number): boolean {
	const around = [...(doc.resolve(from).nodeBefore?.marks ?? []), ...(doc.resolve(to).nodeAfter?.marks ?? [])]
	let inside = true

	eachInline(doc, from, to, node => {
		if (!node.marks.some(mark => mark.type === marks.content_control && mark.isInSet(around))) inside = false

		return inside
	})

	return inside
}

// ---- controls bound to one node -------------------------------------------------------------------------

// Positions of the final document a transaction touched.
export function touchedPoints(tr: Transaction): number[] {
	const out: number[] = []

	tr.steps.forEach((step, index) => {
		const map = tr.mapping.maps[index] ?? StepMap.empty

		for (let k = 0; k < out.length; k++) out[k] = map.map(out[k] ?? 0, -1)

		const parts = markStepsOf(step)

		if (parts !== undefined) for (const part of parts) out.push(part.from, part.to)
		else map.forEach((_oldStart, _oldEnd, newStart, newEnd) => out.push(newStart, newEnd))
	})

	return out
}

// The controls around `pos` (inline ones touching it, block ones holding it) bound by a path the editor
// updates to a node other controls of the part are bound to too.
export function boundAt(part: StoryPart, doc: Node, pos: number, shared: ReadonlySet<string>): { around: ControlAround; key: string }[] {
	const out: { around: ControlAround; key: string }[] = []
	const add = (around: ControlAround): void => {
		const binding = around.info.binding === null || around.info.richBinding ? undefined : simpleBinding(around.info.binding)

		if (binding !== undefined && shared.has(binding.key)) out.push({ around, key: binding.key })
	}
	const $pos = doc.resolve(pos)

	if ($pos.parent.inlineContent) {
		for (const span of controlSpans($pos.parent, $pos.start())) {
			if (span.from > pos || span.to < pos) continue

			const info = controlOf(part, span.mark)

			if (info !== undefined) add({ kind: "inline", holder: span.mark, info, from: span.from, to: span.to, pos: span.from })
		}
	}

	for (let depth = $pos.depth; depth > 0; depth--) {
		const node = $pos.node(depth)

		if (node.type !== nodes.sdt) continue

		const info = controlOf(part, node)
		const at = $pos.before(depth)

		if (info !== undefined) add({ kind: "block", holder: node, info, from: at + 1, to: at + node.nodeSize - 1, pos: at })
	}

	return out
}

// One piece of a control: a control an edit split over two paragraphs is written as two, each showing the
// bound value.
function pieceKey(around: ControlAround): string {
	return `${controlKey(around.holder)}@${String(around.from)}`
}

export function controlText(doc: Node, around: ControlAround): string {
	if (around.kind === "block") return blockText(around.holder as Node)

	let text = ""

	doc.nodesBetween(around.from, around.to, node => {
		if (node.isInline) text += inlineText(node)
	})

	return text
}

// Word shows a node's value in every control bound to it: after an edit of one, the others of the story that
// share its binding (forms/binding.ts sharedBindings) show its value too. Whether it changed any.
// `pasted`: ranges of the final document holding pasted copies of bound controls (of `keys`): a copy takes its
// node's value from the controls already there (as Word shows a pasted bound control the node's value), never
// the other way. A copy nested in a control bound to the same node (or holding one) stops being a control: the
// outer control shows the value, so every control of the node ends up holding one value.
function mirrorBindings(
	tr: Transaction,
	session: DocxEditorSession,
	points: readonly number[],
	shared: ReadonlySet<string>,
	pasted: { readonly ranges: readonly number[]; readonly keys: ReadonlySet<string> }
): boolean {
	const part = session.story.part

	if (shared.size === 0) return false

	const doc = tr.doc
	const values = new Map<string, { value: string; source: string }>()
	const head = tr.selection.head
	const ranges = pasted.ranges
	const inPasted = (around: ControlAround): boolean => {
		for (let k = 0; k < ranges.length; k += 2) if (around.from >= (ranges[k] ?? 0) && around.to <= (ranges[k + 1] ?? 0)) return true

		return false
	}
	// Keys of pasted copies no edit outside the paste touched: their value comes from a control outside it.
	const fromExisting = new Set(pasted.keys)

	for (const point of points) {
		for (const found of boundAt(part, doc, Math.min(point, doc.content.size), shared)) {
			if (inPasted(found.around)) continue

			const info = found.around.info
			const value = info.showingPlaceholder ? "" : boundValue(info, controlText(doc, found.around))
			const holds = head >= found.around.from && head <= found.around.to

			fromExisting.delete(found.key)

			if (!values.has(found.key) || holds) values.set(found.key, { value, source: pieceKey(found.around) })
		}
	}

	if (values.size === 0 && fromExisting.size === 0) return false

	for (const [key, { value }] of values) noteBoundEdit(session.context, key, value)

	const index = boundIndex(part, doc)
	const shown = (around: ControlAround): string =>
		around.info.showingPlaceholder ? "" : boundValue(around.info, controlText(doc, around))
	const ops: { around: ControlAround; value: string | null }[] = []

	for (const key of new Set([...values.keys(), ...fromExisting])) {
		const controls = boundAround(part, doc, index, key)
		const outer = (around: ControlAround): ControlAround | undefined =>
			controls.find(
				other =>
					other !== around &&
					controlKey(other.holder) !== controlKey(around.holder) &&
					other.from <= around.from &&
					other.to >= around.to &&
					(other.from !== around.from || other.to !== around.to || other.kind === "block")
			)

		if (!values.has(key)) {
			const first = controls.find(around => !inPasted(around) && outer(around) === undefined)

			if (first === undefined) continue

			values.set(key, { value: shown(first), source: pieceKey(first) })
		}

		const wanted = values.get(key) as { value: string; source: string }

		for (const around of controls) {
			const holder = outer(around)

			if (holder !== undefined) {
				// Nested in a control of the node: a copy (or what holds a copy) is no control of its own any more.
				if (isCopy(around.holder) || isCopy(holder.holder)) ops.push({ around, value: null })

				continue
			}

			if (wanted.source !== pieceKey(around) && shown(around) !== wanted.value) ops.push({ around, value: wanted.value })
		}
	}

	if (ops.length === 0) return false

	// A control one written holds goes with that one's content; the rest change from the end.
	ops.sort((a, b) => a.around.from - b.around.from || b.around.to - a.around.to)

	const written: ControlAround[] = []
	const kept: typeof ops = []

	for (const op of ops) {
		if (written.some(other => other.from <= op.around.from && other.to >= op.around.to)) continue
		if (op.value !== null) written.push(op.around)

		kept.push(op)
	}

	for (const { around, value } of kept.reverse()) {
		if (value === null) unwrap(tr, around)
		else showValue(tr, session.context, part, around, value)
	}

	return kept.length > 0
}

// Shows a bound node's `value` in a control as its type shows it (an empty value: the placeholder).
export function showValue(tr: Transaction, context: DocxEditContext, part: StoryPart, around: ControlAround, value: string): void {
	const info = around.info
	const state = controlState(around.holder) ?? {}

	if (value === "") {
		writeControl(tr, context, around, placeholderText(part, around.holder, info), placeholderState(around.holder, info, true))

		return
	}

	if (info.checkbox !== null) {
		const checked = value === "true" || value === "1"
		const glyph = checkboxGlyph(info.checkbox, checked)

		writeControl(tr, context, around, glyph.text, { ...state, checked, placeholder: false }, glyph.font)

		return
	}

	if (info.date !== null) {
		const iso = isoDate(value) ?? parseControlDate(value, info.date.format, info.date.lid, info.date.calendar)

		// A value that is no date shows as it is, the control keeping its last date.
		writeControl(
			tr,
			context,
			around,
			iso === null ? value : formatControlDate(iso, info.date.format, info.date.lid, info.date.calendar),
			iso === null ? { ...state, placeholder: false } : { ...state, date: iso, placeholder: false }
		)

		return
	}

	if (info.type === "dropDownList" || info.type === "comboBox") {
		const item = info.items.find(entry => entry.value === value)

		writeControl(tr, context, around, item?.text ?? value, { ...state, value: item?.value ?? null, placeholder: false })

		return
	}

	writeControl(tr, context, around, value, { ...state, placeholder: false })
}

// ---- locks ----------------------------------------------------------------------------------------------

export { controlSpans, type ControlSpan } from "../../forms/positions"

const REASONS = { contentLocked: "lockedContentControl", bound: "boundContentControl", notText: "formControl" } as const

// Zero-width content (range markers, comment references) may go anywhere.
function onlyMarkers(step: ReplaceStep | ReplaceAroundStep): boolean {
	if (step.from !== step.to || step instanceof ReplaceAroundStep) return false

	let only = true

	step.slice.content.forEach(node => {
		if (node.type !== nodes.marker && node.type !== nodes.comment_ref) only = false
	})

	return only
}

// Whether [from, to] lies inside a control a user may type into, nested in `outer` (the content range of one
// that may not be typed into).
function nestedTypeable(part: StoryPart, doc: Node, from: number, to: number, outer: { from: number; to: number }): boolean {
	const inner = inlineControlAround(part, doc, from, to) ?? blockControlAround(part, doc, from, to)

	return (
		inner !== undefined &&
		typeable(inner.info) === undefined &&
		inner.from >= outer.from &&
		inner.to <= outer.to &&
		(inner.from !== outer.from || inner.to !== outer.to)
	)
}

// Why a step range breaks a control's lock: `replace` changes content (`from` = `to` inserts; `inserts`: content
// comes in), `format` sets marks, `unwrap` takes a control mark away.
function rangeViolation(
	part: StoryPart,
	doc: Node,
	from: number,
	to: number,
	kind: "replace" | "format" | "unwrap",
	inserts: Slice | null = null
): string | undefined {
	let violation: string | undefined
	const visitParagraph = (paragraph: Node, start: number): void => {
		for (const span of controlSpans(paragraph, start)) {
			const overlaps = from === to ? from > span.from && from < span.to : from < span.to && to > span.from

			if (!overlaps) continue

			const info = controlOf(part, span.mark)

			if (info === undefined) continue

			if (kind === "unwrap") {
				if (info.lock === "sdtLocked" || info.lock === "sdtContentLocked") violation ??= REASONS.contentLocked

				continue
			}

			const whole = from < to && from <= span.from && to >= span.to
			const blocker = typeable(info)

			if (kind === "replace" && whole) {
				const exact = from === span.from && to === span.to

				// Exactly its content typed over or deleted: the placeholder comes back. Typed over, a control
				// typing does not change keeps its content; deleted with more, or deleted alone, it goes.
				if (exact && blocker === undefined) continue
				if (exact && inserts !== null) {
					violation ??= REASONS[blocker ?? "notText"]

					continue
				}

				if (info.lock === "sdtLocked" || info.lock === "sdtContentLocked") violation ??= REASONS.contentLocked
				// Taken out and put back (a replace over it): only as it was.
				else if (blocker !== undefined && inserts !== null && changedCopy(doc, span, inserts)) violation ??= REASONS[blocker]

				continue
			}

			if (kind === "format") {
				if (blocker === "contentLocked") violation ??= REASONS.contentLocked

				continue
			}

			if (blocker !== undefined && !nestedTypeable(part, doc, from, to, span)) violation ??= REASONS[blocker]
		}
	}
	const visitBlock = (node: Node, pos: number): void => {
		if (kind === "format") {
			const info = controlOf(part, node)

			if (info !== undefined && typeable(info) === "contentLocked" && from < pos + node.nodeSize - 1 && to > pos + 1)
				violation ??= REASONS.contentLocked

			return
		}

		if (kind !== "replace") return

		const info = controlOf(part, node)

		// Deleted whole: the core keeps controls locked against deletion; put back, only as it was.
		if (info === undefined) return
		if (from <= pos && to >= pos + node.nodeSize) {
			const blocker = inserts === null ? undefined : typeable(info)

			if (blocker !== undefined && inserts !== null && changedBlockCopy(node, inserts)) violation ??= REASONS[blocker]

			return
		}

		const blocker = typeable(info)

		if (blocker !== undefined && !nestedTypeable(part, doc, from, to, { from: pos + 1, to: pos + node.nodeSize - 1 }))
			violation ??= REASONS[blocker]
	}

	if (from === to) {
		const $pos = doc.resolve(from)

		if ($pos.parent.inlineContent) visitParagraph($pos.parent, $pos.start())

		for (let depth = $pos.depth; depth > 0 && violation === undefined; depth--) {
			const node = $pos.node(depth)

			if (node.type === nodes.sdt) visitBlock(node, $pos.before(depth))
		}

		return violation
	}

	doc.nodesBetween(from, to, (node, pos) => {
		if (violation !== undefined) return false
		if (node.type === nodes.sdt) visitBlock(node, pos)

		if (node.inlineContent) {
			visitParagraph(node, pos + 1)

			return false
		}

		return !node.isInline
	})

	return violation
}

// Whether `slice` holds the run-level control of `span` (of `doc`) with other content than it has.
function changedCopy(doc: Node, span: ControlSpan, slice: Slice): boolean {
	const key = controlKey(span.mark)
	const copy: Node[] = []
	const old: Node[] = []

	slice.content.descendants(node => {
		if (node.isInline && node.marks.some(mark => mark.type === marks.content_control && controlKey(mark) === key)) copy.push(node)

		return !node.isInline
	})

	if (copy.length === 0) return false

	doc.slice(span.from, span.to).content.forEach(node => old.push(node))

	return !Fragment.from(old).eq(Fragment.from(copy))
}

// Whether `slice` holds block control `node` with other content than it has.
function changedBlockCopy(node: Node, slice: Slice): boolean {
	const key = controlKey(node)
	let changed = false

	slice.content.descendants(child => {
		if (changed || child.isInline) return false
		if (child.type === nodes.sdt && controlKey(child) === key && !child.content.eq(node.content)) changed = true

		return !changed
	})

	return changed
}

// Whether pieces (in document order) format locked content, by one walk over their span.
function piecesViolation(
	part: StoryPart,
	doc: Node,
	pieces: readonly { readonly from: number; readonly to: number }[]
): string | undefined {
	const first = pieces[0]
	const last = pieces[pieces.length - 1]

	if (first === undefined || last === undefined) return undefined

	const locked = lockedContent(part, doc, first.from, last.to)
	let k = 0

	for (const piece of pieces) {
		while (k < locked.length && (locked[k + 1] ?? 0) <= piece.from) k += 2

		if (k < locked.length && (locked[k] ?? 0) < piece.to) return REASONS.contentLocked
	}

	return undefined
}

// Whether [from, to] of `doc` holds a content control (a block one, or text of an inline one).
function controlBetween(doc: Node, from: number, to: number): boolean {
	let found = false

	doc.nodesBetween(from, to, node => {
		found ||= node.type === nodes.sdt || node.marks.some(mark => mark.type === marks.content_control)

		return !found
	})

	return found
}

function lockViolation(tr: Transaction, part: StoryPart): string | undefined {
	for (let k = 0; k < tr.steps.length; k++) {
		const step = tr.steps[k]
		const doc = tr.docs[k] as Node
		let violation: string | undefined

		if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
			if (onlyMarkers(step)) continue

			if (step instanceof ReplaceAroundStep)
				violation =
					rangeViolation(part, doc, step.from, step.gapFrom, "replace") ??
					rangeViolation(part, doc, step.gapTo, step.to, "replace")
			// A rebuild over no control (one walk) breaks no lock, however many replaces it makes.
			else if (replacesOf(step)[0] === step || controlBetween(doc, step.from, step.to))
				for (const replace of replacesOf(step)) {
					violation ??= pictureSwap(part, doc, replace.from, replace.to, replace.slice.content)
						? undefined
						: rangeViolation(part, doc, replace.from, replace.to, "replace", replace.slice.size > 0 ? replace.slice : null)
				}
		} else if (step !== undefined) {
			for (const one of markStepsOf(step) ?? []) {
				const control = one.mark.type === marks.content_control

				// A control mark added by a user is the core's to refuse (an identity).
				if (control && isAddMarkLike(one)) continue

				// A step setting marks piece by piece formats its pieces only.
				violation ??=
					!control && (one instanceof SetMarksStep || one instanceof SetMarkSetsStep)
						? piecesViolation(part, doc, one.pieces)
						: rangeViolation(part, doc, one.from, one.to, control ? "unwrap" : "format")
			}
		}

		if (violation !== undefined) return violation
	}

	return undefined
}

// A form command recorded as tracked changes keeps the old content (deleted) next to the new: the control's
// content all takes the state the command wrote (else the state the new content has), so it stays one control.
function unifyStates(tr: Transaction, written: ReadonlyMap<string, Mark> | undefined): void {
	const inserted = insertedRanges(tr)
	const seen = new Set<number>()

	for (let k = 0; k < inserted.length; k += 2) {
		const $pos = tr.doc.resolve(inserted[k] ?? 0)

		if (!$pos.parent.inlineContent || seen.has($pos.start())) continue

		seen.add($pos.start())

		const paragraph = $pos.parent
		const start = $pos.start()
		const newest = new Map<string, Mark>()

		paragraph.forEach(child => {
			if (child.marks.some(mark => mark.type === marks.deletion || mark.type === marks.move_from)) return

			for (const mark of child.marks) if (mark.type === marks.content_control) newest.set(controlKey(mark), mark)
		})

		for (const [key, mark] of written ?? []) newest.set(key, mark)

		if (newest.size === 0) continue

		let pos = start

		paragraph.forEach(child => {
			for (const mark of child.marks) {
				const wanted = mark.type === marks.content_control ? newest.get(controlKey(mark)) : undefined

				if (wanted !== undefined && !wanted.eq(mark)) {
					tr.removeMark(pos, pos + child.nodeSize, mark)
					tr.addMark(pos, pos + child.nodeSize, wanted)
				}
			}

			pos += child.nodeSize
		})
	}
}

// ---- control content --------------------------------------------------------------------------------------------

// The marks of a control's first inline content (what new content in it takes).
export function contentMarks(doc: Node, around: ControlAround): readonly Mark[] {
	if (around.kind === "inline") return doc.nodeAt(around.from)?.marks ?? [around.holder as Mark]

	let found: readonly Mark[] | undefined

	doc.nodesBetween(around.from, around.to, child => {
		if (found === undefined && child.isInline) found = child.marks

		return found === undefined
	})

	return found ?? []
}

// Replaces a control's content: an inline control's span, or a block one's content with its first paragraph
// holding `content` (what a control shows is one paragraph's content, line breaks for lines; a control holding
// other blocks, a table, becomes that paragraph, as Word refreshes a bound control).
export function replaceContent(tr: Transaction, around: ControlAround, written: readonly Node[]): void {
	if (around.kind === "inline") {
		tr.replaceWith(around.from, around.to, [...written, ...anchorsIn(tr.doc, around.from, around.to, around.to)])

		return
	}

	const holder = tr.doc.nodeAt(around.pos)
	let first: Node | undefined
	let at = -1
	let paragraphs = true

	holder?.forEach(child => {
		if (!child.isTextblock) paragraphs = false
	})
	tr.doc.nodesBetween(around.from, around.to, (child, pos) => {
		if (first !== undefined) return false
		if (!child.inlineContent) return !child.isInline

		first = child
		at = pos

		return false
	})

	if (first === undefined) return

	const end = at + first.nodeSize
	const content = [...written, ...anchorsIn(tr.doc, at + 1, around.to, end)]

	if (!paragraphs) {
		tr.replaceWith(around.from, around.to, first.type.create(first.attrs, content, first.marks))

		return
	}

	if (around.to > end) tr.delete(end, around.to)

	tr.replaceWith(at + 1, end - 1, content)
}

// What outlives a control's content written anew, in order: range markers and comment anchors inline, and the
// markers before the paragraphs from `blocksFrom` on that go with it. The new content ends with them, so a range
// (a comment's, a bookmark's) only shrinks, as accepting a deletion keeps them (review/accept.ts).
function anchorsIn(doc: Node, from: number, to: number, blocksFrom: number): Node[] {
	const out: Node[] = []

	doc.nodesBetween(from, to, (child, pos) => {
		if (child.isInline) {
			if ((child.type === docxSchema.nodes.marker || child.type === docxSchema.nodes.comment_ref) && pos >= from) out.push(child)

			return false
		}

		if (pos >= blocksFrom && child.isTextblock)
			for (const marker of (child.attrs["before"] as MarkerList | undefined) ?? [])
				out.push(
					marker.kind === "commentReference"
						? docxSchema.nodes.comment_ref.create({ src: marker.src, id: marker.id })
						: docxSchema.nodes.marker.create({
								src: marker.src,
								kind: marker.kind,
								id: marker.id,
								name: "name" in marker ? marker.name : null
							})
				)

		return true
	})

	return out
}

// Marks for new content of a control: its first content's, with the control mark (inline) holding `state`,
// and the placeholder style only while the placeholder shows.
export function newContentMarks(context: DocxEditContext, doc: Node, around: ControlAround, state: ControlState): readonly Mark[] {
	let set = contentMarks(doc, around)

	if (around.kind === "inline") {
		const mark = around.holder as Mark

		set = marks.content_control.create({ ...mark.attrs, state }).addToSet(mark.removeFromSet(set))
	}

	if (state.placeholder === true) return placeholderMarks(context, set)

	return set.filter(mark => !placeholderStyled(context, mark))
}

// Text as inline content (tabs as tab nodes, line feeds as line breaks).
export function textContent(text: string, set: readonly Mark[]): Node[] {
	const out: Node[] = []

	for (const [k, line] of text.split("\n").entries()) {
		if (k > 0) out.push(nodes.break.create({ type: "textWrapping" }, null, set))

		for (const [n, piece] of line.split("\t").entries()) {
			if (n > 0) out.push(nodes.tab.create(null, null, set))
			if (piece !== "") out.push(docxSchema.text(piece, set))
		}
	}

	return out
}

// The run fonts Word gives a checkbox glyph: w:rFonts naming the state's font for every script.
export function withFont(set: readonly Mark[], font: string | null): readonly Mark[] {
	if (font === null) return set

	const current = marks.font.isInSet(set)

	if (current !== undefined && (current.attrs["ascii"] === font || current.attrs["eastAsia"] === font)) return set

	return marks.font.create({ ascii: font, hAnsi: font, eastAsia: font, hint: "eastAsia" }).addToSet(marks.font.removeFromSet(set))
}

// Replaces a control's content with `text` (a checkbox glyph in its `font`) and sets its state.
export function writeControl(
	tr: Transaction,
	context: DocxEditContext,
	around: ControlAround,
	text: string,
	state: ControlState,
	font: string | null = null
): void {
	const set = withFont(newContentMarks(context, tr.doc, around, state), font)

	replaceContent(tr, around, state.placeholder === true ? placeholderContent(text, set) : textContent(text, set))

	if (around.kind === "block") tr.setNodeAttribute(around.pos, "state", state)
}

// ---- placeholders ---------------------------------------------------------------------------------------

// The character style Word gives placeholder text ("Placeholder Text"), when the document has it.
export function placeholderStyle(context: DocxEditContext): string | undefined {
	return context.styles.byName(PLACEHOLDER_STYLE, "character")?.id ?? context.styles.byId("PlaceholderText")?.id
}

// Whether a character style mark is the placeholder style (the document's, Word's id for it, or the one the
// writer adds).
export function placeholderStyled(context: DocxEditContext, mark: Mark): boolean {
	if (mark.type !== marks.char_style) return false

	const id = mark.attrs["styleId"] as string

	return id === "PlaceholderText" || id === placeholderStyle(context) || context.newStyles.get(id) === PLACEHOLDER_STYLE
}

// The state of a control whose placeholder shows (`showing`) or no longer does.
export function placeholderState(holder: Node | Mark, info: ControlInfo, showing: boolean): ControlState {
	const state = controlState(holder) ?? {}

	if (!showing) return { ...state, placeholder: false }

	// A date control keeps its last date (w:fullDate) under the placeholder, as Word does.
	return {
		...state,
		placeholder: true,
		...(info.type === "dropDownList" || info.type === "comboBox" ? { value: null } : {})
	}
}

// Sets a control's state: a block control's attribute, an inline control's mark over its span.
export function setControlState(tr: Transaction, around: ControlAround, state: ControlState): void {
	if (around.kind === "block") {
		tr.setNodeAttribute(around.pos, "state", state)

		return
	}

	const mark = around.holder as Mark

	tr.removeMark(around.from, around.to, mark)
	tr.addMark(around.from, around.to, marks.content_control.create({ ...mark.attrs, state }))
}

// Placeholder text as inline content with `markSet` (a tab as a tab node).
export function placeholderContent(text: string, markSet: readonly Mark[]): Node[] {
	const out: Node[] = []

	text.split("\t").forEach((piece, k) => {
		if (k > 0) out.push(nodes.tab.create(null, null, markSet))
		if (piece !== "") out.push(docxSchema.text(piece, markSet))
	})

	return out
}

// The marks of placeholder text standing for content that had `markSet`: no revision, link or recorded
// formatting change, the placeholder style (Word's built-in one, added to a document that lacks it).
export function placeholderMarks(context: DocxEditContext, markSet: readonly Mark[]): readonly Mark[] {
	const style = placeholderStyle(context) ?? builtInStyleId(context, PLACEHOLDER_STYLE)
	const kept = markSet.filter(mark => mark.type !== marks.char_style && !DROPPED_MARKS.has(mark.type.name))

	return marks.char_style.create({ styleId: style }).addToSet(kept)
}

// Ranges each replace step inserted, in the final document.
function insertedRanges(tr: Transaction): number[] {
	const out: number[] = []

	tr.steps.forEach((step, index) => {
		const map = tr.mapping.maps[index] ?? StepMap.empty

		if (map !== StepMap.empty) {
			for (let k = 0; k < out.length; k += 2) {
				out[k] = map.map(out[k] ?? 0, -1)
				out[k + 1] = map.map(out[k + 1] ?? 0, 1)
			}
		}

		if (!(step instanceof ReplaceStep) || step.slice.size === 0) return

		const after = replacedAfter(step)

		for (let k = 0; k < after.length; k += 2) if ((after[k + 1] ?? 0) > (after[k] ?? 0)) out.push(after[k] ?? 0, after[k + 1] ?? 0)
	})

	return out
}

// Ranges of the final document what a step replacing the selection [from, to] (of the document the transaction
// starts from) inserted: typing over it, tracked or not.
function selectionInserts(tr: Transaction, from: number, to: number): number[] {
	const out: number[] = []

	tr.steps.forEach((step, index) => {
		const map = tr.mapping.maps[index] ?? StepMap.empty

		for (let k = 0; k < out.length; k += 2) {
			out[k] = map.map(out[k] ?? 0, -1)
			out[k + 1] = map.map(out[k + 1] ?? 0, 1)
		}

		if (step instanceof ReplaceStep && step.slice.size > 0) {
			const after = replacedAfter(step)

			replacesOf(step).forEach((replace, k) => {
				const start = after[2 * k] ?? 0
				const end = after[2 * k + 1] ?? 0

				if (replace.from >= from && replace.to <= to && end > start) out.push(start, end)
			})
		}

		from = map.map(from, -1)
		to = map.map(to, 1)
	})

	return out
}

interface Emptied {
	readonly mark: Mark
	readonly markSet: readonly Mark[]
	pos: number
}

// Applies the placeholder rules to `tr`; whether it added steps.
function placeholders(tr: Transaction, session: DocxEditorSession, forms: boolean): boolean {
	const part = session.story.part
	const context = session.context
	const before = tr.steps.length
	const emptied: Emptied[] = []
	const inserted = insertedRanges(tr)
	// A selection of exactly a control's content typed over: what is typed goes into the control (the editor's
	// marks would leave it outside, as the control ends where the selection does).
	const selection = session.state.selection
	const covered =
		inserted.length > 0 && !selection.empty && tr.before === session.state.doc
			? inlineControlAround(part, tr.before, selection.from, selection.to)
			: undefined
	const retyped =
		covered !== undefined && covered.from === selection.from && covered.to === selection.to && typeable(covered.info) === undefined
	const coveredKey = retyped ? controlKey(covered.holder) : undefined

	// Inline controls a step deleted exactly (all their content): they come back with their placeholder.
	tr.steps.forEach((step, index) => {
		const map = tr.mapping.maps[index] ?? StepMap.empty

		for (const entry of emptied) entry.pos = map.map(entry.pos, -1)

		if (!(step instanceof ReplaceStep) || step.to <= step.from) return

		const doc = tr.docs[index] as Node
		const after = replacedAfter(step)

		replacesOf(step).forEach((replace, k) => {
			if (replace.to <= replace.from) return

			const $from = doc.resolve(replace.from)

			if (!$from.parent.inlineContent || replace.to > $from.end()) return

			for (const span of controlSpans($from.parent, $from.start())) {
				if (span.from !== replace.from || span.to !== replace.to) continue

				const info = controlOf(part, span.mark)

				if (info === undefined || typeable(info) !== undefined || controlKey(span.mark) === coveredKey) continue

				// The marks every node of the content shares: the control's own and those of controls around it (not
				// those of controls inside it, which go with their content).
				let shared: readonly Mark[] | undefined

				doc.nodesBetween(span.from, span.to, node => {
					if (node.isInline) shared = shared === undefined ? node.marks : shared.filter(mark => mark.isInSet(node.marks))
				})

				emptied.push({ mark: span.mark, markSet: shared ?? [span.mark], pos: after[2 * k] ?? 0 })
			}
		})
	})

	const typed = retyped ? selectionInserts(tr, selection.from, selection.to) : []

	if (retyped && covered !== undefined) {
		for (let k = 0; k < typed.length; k += 2) {
			const from = typed[k] ?? 0
			const to = typed[k + 1] ?? 0

			if (to <= from || !tr.doc.resolve(from).parent.inlineContent) continue

			let inside = false

			tr.doc.nodesBetween(from, to, node => {
				if (node.isInline && node.marks.some(mark => mark.type === marks.content_control && controlKey(mark) === coveredKey))
					inside = true
			})

			if (!inside) tr.addMark(from, to, covered.holder as Mark)
		}
	}

	// Typing at the end of an inline control appends to it, as in Word; under forms protection, typing at either
	// edge goes into the control.
	for (let k = 0; k < inserted.length; k += 2) {
		const from = inserted[k] ?? 0
		const to = inserted[k + 1] ?? 0
		const doc = tr.doc
		const $from = doc.resolve(from)

		if (from === to || !$from.parent.inlineContent || to > $from.end() || insideControl(doc, from, to)) continue

		const before = inlineControlAround(part, doc, from, from)
		const edge =
			before !== undefined && before.to === from ? before : forms ? (before ?? inlineControlAround(part, doc, to, to)) : undefined

		if (edge !== undefined && typeable(edge.info) === undefined) tr.addMark(from, to, edge.holder as Mark)
	}

	// Typed into a control showing its placeholder: the placeholder text and its style go.
	const seen = new Set<string>()

	for (let k = inserted.length - 2; k >= 0; k -= 2) {
		const doc = tr.doc
		const mapping = tr.mapping.slice(before)
		const from = mapping.map(inserted[k] ?? 0, 1)
		const to = mapping.map(inserted[k + 1] ?? 0, -1)

		if (to <= from) continue
		// Controls that came in whole (pasted) are copies, not typed into: one showing its placeholder shows all of it,
		// as Word copies a placeholder whole.
		if (!typed.some((pos, n) => n % 2 === 0 && mapping.map(pos, 1) === from) && wholePlaceholders(tr, session, from, to)) continue

		if (!placeholderAround(part, doc, from, to) || markersOnly(doc, from, to)) continue

		const around = inlineControlAround(part, doc, from, to) ?? blockControlAround(part, doc, from, to)

		if (around === undefined || !around.info.showingPlaceholder || typeable(around.info) !== undefined) continue

		const key = controlKey(around.holder)

		if (seen.has(key)) continue

		seen.add(key)
		replacePlaceholder(tr, session, around, from, to)
	}

	// Exactly all of an inline control's content deleted, it shows its placeholder again (below).
	realizePlaceholders(tr, session, before, new Set([...seen, ...emptied.map(entry => controlKey(entry.mark))]))

	// Emptied block controls (every paragraph empty): the placeholder again.
	const points = inserted.length > 0 ? inserted.filter((_pos, k) => k % 2 === 0) : [tr.selection.from]

	for (const point of points) {
		const doc = tr.doc
		const at = Math.min(tr.mapping.slice(before).map(point, -1), doc.content.size)
		const around = blockControlAround(part, doc, at, at)

		if (around === undefined || around.info.showingPlaceholder || typeable(around.info) !== undefined) continue
		if (emptyContent(around.holder as Node)) restoreBlock(tr, context, part, around)
	}

	for (const entry of emptied.reverse()) {
		const doc = tr.doc
		const pos = Math.min(tr.mapping.slice(before).map(entry.pos, -1), doc.content.size)
		const $pos = doc.resolve(pos)
		const key = controlKey(entry.mark)
		const info = controlOf(part, entry.mark)

		if (info === undefined || !$pos.parent.inlineContent) continue
		if (controlSpans($pos.parent, $pos.start()).some(span => controlKey(span.mark) === key)) continue

		const mark = marks.content_control.create({ ...entry.mark.attrs, state: placeholderState(entry.mark, info, true) })
		const markSet = placeholderMarks(context, mark.addToSet(entry.mark.removeFromSet(entry.markSet)))

		tr.insert(pos, placeholderContent(placeholderText(part, entry.mark, info), markSet))
	}

	return tr.steps.length > before
}

// A comment anchored (by `tr`, the session's own step) in a control showing its placeholder turns that into the
// control's text: LibreOffice reads a placeholder's text as its building block's, the anchor lost.
export function commentedPlaceholders(tr: Transaction, session: DocxEditorSession): void {
	if (mayHoldControls(session)) realizePlaceholders(tr, session, tr.steps.length, new Set(), true)
}

// Part of a placeholder deleted (tracked or not) or commented by the first `count` steps: what is left is the
// control's text, no longer its placeholder (ECMA-376 §17.5.2.39). `done`: controls already seen to.
function realizePlaceholders(tr: Transaction, session: DocxEditorSession, count: number, done: Set<string>, commentsOnly = false): void {
	const part = session.story.part

	for (const { around, pos, index } of placeholderEdits(tr, part, count, commentsOnly)) {
		const key = controlKey(around.holder)

		if (done.has(key)) continue

		const at = Math.min(tr.mapping.slice(index).map(pos, -1), tr.doc.content.size)
		const mapped = mappedAround(tr, around, at, at)

		if (mapped === undefined) continue

		const info = controlOf(part, mapped.holder)

		if (info === undefined || !info.showingPlaceholder || typeable(info) !== undefined) continue

		done.add(key)
		replacePlaceholder(tr, session, { ...mapped, info }, mapped.from, mapped.to)
	}
}

// Controls showing their placeholder that a step of `tr` (the first `count`) deleted part of or marked part of
// deleted (a range over one of its edges too), or (`commentsOnly`) anchored a comment in: the control as it was
// then, a position in it and the step's index.
function placeholderEdits(
	tr: Transaction,
	part: StoryPart,
	count: number,
	commentsOnly: boolean
): { around: ControlAround; pos: number; index: number }[] {
	const out: { around: ControlAround; pos: number; index: number }[] = []
	const partly = (start: number, end: number, from: number, to: number): boolean =>
		start < to && end > from && !(from <= start && to >= end)
	const note = (doc: Node, from: number, to: number, index: number): void => {
		// Only a control at an end of the range is partly in it.
		if (to <= from) return

		const keys = new Set<string>()
		const add = (around: ControlAround): void => {
			const key = controlKey(around.holder)

			if (keys.has(key) || !around.info.showingPlaceholder) return

			keys.add(key)
			out.push({ around, pos: Math.max(from, around.from), index })
		}

		for (const at of [from, to]) {
			const $at = doc.resolve(at)

			if ($at.parent.inlineContent) {
				for (const span of controlSpans($at.parent, $at.start())) {
					const info = controlOf(part, span.mark)

					if (info !== undefined && partly(span.from, span.to, from, to))
						add({ kind: "inline", holder: span.mark, info, from: span.from, to: span.to, pos: span.from })
				}
			}

			for (let depth = $at.depth; depth > 0; depth--) {
				const node = $at.node(depth)

				if (node.type !== nodes.sdt) continue

				const pos = $at.before(depth)
				const info = controlOf(part, node)

				if (info !== undefined && partly(pos + 1, pos + node.nodeSize - 1, from, to))
					add({ kind: "block", holder: node, info, from: pos + 1, to: pos + node.nodeSize - 1, pos })
			}
		}
	}

	// A comment anchored in it.
	const commented = (doc: Node, at: number, slice: Slice, index: number): void => {
		const keys = new Set<string>()

		slice.content.descendants(node => {
			if (node.type !== nodes.comment_ref) return true

			for (const mark of node.marks) {
				const info = mark.type === marks.content_control ? controlOf(part, mark) : undefined

				if (info === undefined || !info.showingPlaceholder || keys.has(controlKey(mark))) continue

				keys.add(controlKey(mark))
				out.push({ around: { kind: "inline", holder: mark, info, from: at, to: at, pos: at }, pos: at, index })
			}

			return false
		})

		const $at = doc.resolve(at)

		for (let depth = $at.depth; depth > 0 && keys.size === 0; depth--) {
			const node = $at.node(depth)
			const info = node.type === nodes.sdt ? controlOf(part, node) : undefined

			if (info === undefined || !info.showingPlaceholder) continue

			let anchored = false

			slice.content.descendants(child => {
				anchored ||= child.type === nodes.comment_ref

				return !anchored
			})

			if (!anchored) break

			const pos = $at.before(depth)

			out.push({ around: { kind: "block", holder: node, info, from: pos + 1, to: pos + node.nodeSize - 1, pos }, pos: at, index })

			break
		}
	}

	for (let index = 0; index < count; index++) {
		const step = tr.steps[index] as Step
		const doc = tr.docs[index] as Node

		if (step instanceof ReplaceStep) {
			for (const replace of replacesOf(step)) {
				if (commentsOnly) commented(doc, replace.from, replace.slice, index)
				else note(doc, replace.from, replace.to, index)
			}
		} else if (!commentsOnly) {
			for (const part of markStepsOf(step) ?? [])
				if (!(part instanceof RemoveMarkStep) && markStepTypes(part).some(type => DELETIONS.has(type.name)))
					note(doc, part.from, part.to, index)
		}
	}

	return out
}

// Whether [from, to] holds range markers only (a bookmark put around a heading): nothing typed, so a placeholder
// stays.
function markersOnly(doc: Node, from: number, to: number): boolean {
	let only = true

	doc.nodesBetween(from, to, node => {
		if (node.isInline && node.type !== nodes.marker) only = false

		return only
	})

	return only
}

// Shows the whole placeholder in each run-level control [from, to] holds whole that shows part of it; whether
// [from, to] is exactly one such control's content.
function wholePlaceholders(tr: Transaction, session: DocxEditorSession, from: number, to: number): boolean {
	const part = session.story.part
	const doc = tr.doc
	const copies: ControlAround[] = []
	let exact = false

	const $start = doc.resolve(from)

	// Typing in a control: the control goes on before or after what was typed, so none came in whole.
	if ($start.parent.inlineContent && to <= $start.end()) {
		const around = [...($start.nodeBefore?.marks ?? []), ...(doc.resolve(to).nodeAfter?.marks ?? [])]
		let whole = false

		eachInline(doc, from, to, node => {
			if (node.marks.some(mark => mark.type === marks.content_control && !mark.isInSet(around))) whole = true

			return !whole
		})

		if (!whole) return false
	}

	const visit = (node: Node, start: number): void => {
		for (const span of controlSpans(node, start)) {
			if (span.from < from || span.to > to) continue

			const info = controlOf(part, span.mark)

			if (info === undefined) continue
			if (span.from === from && span.to === to) exact = true
			if (info.showingPlaceholder)
				copies.push({ kind: "inline", holder: span.mark, info, from: span.from, to: span.to, pos: span.from })
		}
	}
	const $from = doc.resolve(from)

	// Typing stays in its paragraph: no walk from the top of the document.
	if ($from.parent.inlineContent && to <= $from.end()) visit($from.parent, $from.start())
	else
		doc.nodesBetween(from, to, (node, pos) => {
			if (!node.inlineContent) return !node.isInline

			visit(node, pos + 1)

			return false
		})

	for (const around of copies.sort((a, b) => b.from - a.from)) {
		const text = placeholderText(part, around.holder, around.info)

		if (controlText(doc, around) === text) continue

		const before = tr.steps.length

		writeControl(tr, session.context, around, text, placeholderState(around.holder, around.info, true))

		for (const step of tr.steps.slice(before)) pasteSteps.add(step)
	}

	return exact
}

function emptyContent(node: Node): boolean {
	let empty = true

	node.descendants(child => {
		if (child.isInline) empty = false

		return empty && !child.isInline
	})

	return empty
}

function replacePlaceholder(tr: Transaction, session: DocxEditorSession, around: ControlAround, from: number, to: number): void {
	const doc = tr.doc
	const holder = around.holder
	const info = around.info
	// What else the control holds goes (from the end).
	const pieces: [number, number][] = []

	if (around.kind === "inline") {
		if (to < around.to) pieces.push([to, around.to])
		if (around.from < from) pieces.push([around.from, from])
	} else {
		doc.nodesBetween(around.from, around.to, (node, pos) => {
			if (!node.inlineContent) return !node.isInline

			const start = pos + 1
			const end = pos + node.nodeSize - 1

			if (start < from) pieces.push([start, Math.min(end, from)])
			if (end > to) pieces.push([Math.max(start, to), end])

			return false
		})
		pieces.sort((a, b) => b[0] - a[0])
	}

	let start = from
	let end = to

	for (const [a, b] of pieces) {
		if (b <= a) continue

		tr.delete(a, b)

		if (b <= start) {
			start -= b - a
			end -= b - a
		}
	}

	tr.doc.nodesBetween(start, end, (node, pos) => {
		for (const mark of node.marks) {
			if (placeholderStyled(session.context, mark)) tr.removeMark(Math.max(start, pos), Math.min(end, pos + node.nodeSize), mark)
		}
	})

	const mapped = mappedAround(tr, around, start, end)

	if (mapped === undefined) return

	setControlState(tr, mapped, placeholderState(holder, info, false))

	if (info.temporary) unwrap(tr, mappedAround(tr, mapped, start, end) ?? mapped)
}

// The control `around` stood for, as it stands now around [from, to].
function mappedAround(tr: Transaction, around: ControlAround, from: number, to: number): ControlAround | undefined {
	const doc = tr.doc
	const $pos = doc.resolve(from)
	const key = controlKey(around.holder)

	if (around.kind === "block") {
		for (let depth = $pos.depth; depth > 0; depth--) {
			const node = $pos.node(depth)

			if (node.type === nodes.sdt && controlKey(node) === key)
				return { ...around, holder: node, pos: $pos.before(depth), from: $pos.before(depth) + 1, to: $pos.after(depth) - 1 }
		}

		return undefined
	}

	if (!$pos.parent.inlineContent) return undefined

	const span = controlSpans($pos.parent, $pos.start()).find(item => controlKey(item.mark) === key && item.from <= from && item.to >= to)

	return span === undefined ? undefined : { ...around, holder: span.mark, from: span.from, to: span.to, pos: span.from }
}

// A temporary control (w:temporary) goes once edited; its content stays.
function unwrap(tr: Transaction, around: ControlAround): void {
	if (around.kind === "inline") {
		tr.removeMark(around.from, around.to, around.holder as Mark)

		return
	}

	const node = tr.doc.nodeAt(around.pos)

	if (node !== null && node.type === nodes.sdt) tr.replaceWith(around.pos, around.pos + node.nodeSize, node.content)
}

function restoreBlock(tr: Transaction, context: DocxEditContext, part: StoryPart, around: ControlAround): void {
	const node = around.holder as Node
	let at = -1

	tr.doc.nodesBetween(around.from, around.to, (child, pos) => {
		if (at >= 0) return false
		if (child.inlineContent) at = pos + 1

		return at < 0 && !child.isInline
	})

	if (at < 0) return

	// The formatting of what was there: the first inline content the transaction took.
	const original = tr.before
	const back = Math.min(tr.mapping.invert().map(at, 1), original.content.size)
	let markSet: readonly Mark[] = []

	original.nodesBetween(back, Math.min(original.content.size, back + 4096), child => {
		// Controls inside the block go with their content.
		if (markSet.length === 0 && child.isInline) markSet = child.marks.filter(mark => mark.type !== marks.content_control)

		return markSet.length === 0 && !child.isInline
	})

	tr.insert(at, placeholderContent(placeholderText(part, node, around.info), placeholderMarks(context, markSet)))
	tr.setNodeAttribute(around.pos, "state", placeholderState(node, around.info, true))
}
