import { Fragment, type Mark, type MarkType, type Node, type Schema } from "prosemirror-model"
import type { Transaction } from "prosemirror-state"
import { AddMarkStep, RemoveMarkStep, Step, StepResult, type Mappable } from "prosemirror-transform"
import { asBuilt, builtBlock } from "./origin"
import { docxSchema } from "./schema"

// Run-level content of [from, to) and the mark of the step's type it gets (null: none of that type).
export interface MarkPiece {
	readonly from: number
	readonly to: number
	readonly mark: Mark | null
}

// Run-level content of [from, to) and the marks of the step's types it gets (none of the others).
export interface MarksPiece {
	readonly from: number
	readonly to: number
	readonly marks: readonly Mark[]
}

interface Range {
	readonly from: number
	readonly to: number
}

// Sets marks on inline content piece by piece, as one step: `pieces` are ranges in document order, not
// overlapping; content outside them stays as it is. A step per run of alike pieces copies the document's block
// list once per run, and a transaction keeps every intermediate document: formatting a whole long document that
// way takes seconds and gigabytes. This step changes the blocks the pieces touch once, keeping every other block
// (identity included).
//
// It covers [first piece's from, last piece's to) with `mark` standing for what it sets, for whatever reads mark
// steps by kind (markStepsOf: changed ranges, layout, review index, tracked formatting); its inverse is a step of
// the same kind holding what each piece had, so an undo restores exactly. It is no AddMarkStep: AddMarkStep.merge
// would take it for one (prosemirror-history merges an event's inverted steps) and set one mark over the whole
// range; a Step merges with nothing.
abstract class PieceMarksStep<P extends Range> extends Step {
	readonly pieces: readonly P[]
	readonly from: number
	readonly to: number
	readonly mark: Mark

	constructor(pieces: readonly P[], mark: Mark) {
		super()

		this.pieces = pieces
		this.from = pieces[0]?.from ?? 0
		this.to = pieces[pieces.length - 1]?.to ?? 0
		this.mark = mark
	}

	// The marks of content with `marks` under `piece`.
	protected abstract marked(piece: P, marks: readonly Mark[]): readonly Mark[]
	// The piece giving content of [from, to) back `marks`.
	protected abstract restoring(from: number, to: number, marks: readonly Mark[]): P
	protected abstract alike(a: P, b: P): boolean
	protected abstract withPieces(pieces: readonly P[]): PieceMarksStep<P>
	// Whether inline content of `parent` may carry the step's marks.
	protected abstract allowed(parent: Node): boolean

	override apply(doc: Node): StepResult {
		try {
			return StepResult.ok(this.rebuild(doc, 0, new Cursor(this.pieces), undefined))
		} catch (error) {
			return StepResult.fail(error instanceof Error ? error.message : String(error))
		}
	}

	// `node` (its content starting at `start`) with the pieces' marks set: the same node when nothing in it
	// changed, a block the builder made when it is that again (asBuilt; `built` is what it made in `node`'s
	// place).
	private rebuild(node: Node, start: number, cursor: Cursor, built: Node | undefined): Node {
		const out: Node[] = []
		let changed = false
		const paired = built !== undefined && built.childCount === node.childCount ? built : undefined

		node.forEach((child, offset, index) => {
			const pos = start + offset
			const end = pos + child.nodeSize

			if (!cursor.overlaps(pos, end)) {
				out.push(child)

				return
			}

			if (child.isInline) {
				const before = out.length

				if (child.isAtom && this.allowed(node)) this.markInline(child, pos, cursor, out)
				else out.push(child)

				if (out.length !== before + 1 || out[before] !== child) changed = true

				return
			}

			const own = paired === undefined ? builtBlock(child.attrs) : paired.child(index)
			const rebuilt = child.content.size > 0 ? this.rebuild(child, pos + 1, cursor, own) : child
			const next = rebuilt === child ? child : asBuilt(rebuilt, own)

			if (next !== child) changed = true

			out.push(next)
		})

		return changed ? node.copy(Fragment.fromArray(out)) : node
	}

	// An inline node, cut where pieces start or end inside it, each part with its piece's marks.
	private markInline(node: Node, pos: number, cursor: Cursor, out: Node[]): void {
		const end = pos + node.nodeSize
		let at = pos
		let same = true
		const parts: Node[] = []

		for (let k = cursor.index; k < this.pieces.length; k++) {
			const piece = this.pieces[k] as P

			if (piece.from >= end) break
			if (piece.to <= at) continue

			const from = Math.max(at, piece.from)
			const to = Math.min(end, piece.to)

			if (from > at) parts.push(node.isText ? node.cut(at - pos, from - pos) : node)

			const marks = this.marked(piece, node.marks)

			if (!sameSet(marks, node.marks)) same = false

			parts.push((node.isText ? node.cut(from - pos, to - pos) : node).mark(marks))
			at = to
		}

		if (at < end) parts.push(node.isText ? node.cut(at - pos, end - pos) : node)

		if (same) out.push(node)
		else out.push(...parts)
	}

	override invert(doc: Node): Step {
		const pieces: P[] = []
		const cursor = new Cursor(this.pieces)
		const add = (piece: P): void => {
			const last = pieces[pieces.length - 1]

			if (last !== undefined && last.to === piece.from && this.alike(last, piece))
				pieces[pieces.length - 1] = { ...last, to: piece.to }
			else pieces.push(piece)
		}
		const visit = (node: Node, start: number): void => {
			node.forEach((child, offset) => {
				const pos = start + offset
				const end = pos + child.nodeSize

				if (!cursor.overlaps(pos, end)) return

				if (!child.isInline) {
					if (child.content.size > 0) visit(child, pos + 1)

					return
				}

				for (let k = cursor.index; k < this.pieces.length; k++) {
					const piece = this.pieces[k] as P

					if (piece.from >= end) break
					if (piece.to > pos) add(this.restoring(Math.max(pos, piece.from), Math.min(end, piece.to), child.marks))
				}
			})
		}

		visit(doc, 0)

		return this.withPieces(pieces)
	}

	// Each piece maps as AddMarkStep's range does: its start to the right, its end to the left, so content
	// inserted at a piece's edge stays outside it (typing next to bolded text is not bolded by a rebase), and a
	// piece whose content was deleted (or that shrank to nothing) is dropped; the step is null without pieces.
	override map(mapping: Mappable): Step | null {
		const pieces: P[] = []

		for (const piece of this.pieces) {
			const from = mapping.map(piece.from, 1)
			const to = mapping.map(piece.to, -1)

			if (to > from) pieces.push({ ...piece, from, to })
		}

		return pieces.length === 0 ? null : this.withPieces(pieces)
	}

	abstract override toJSON(): { stepType: string }
}

// Sets the mark of one type piece by piece (each piece's `mark`; null removes the type's).
export class SetMarksStep extends PieceMarksStep<MarkPiece> {
	get type(): MarkType {
		return this.mark.type
	}

	protected marked(piece: MarkPiece, marks: readonly Mark[]): readonly Mark[] {
		return piece.mark === null ? this.type.removeFromSet(marks) : piece.mark.addToSet(marks)
	}

	protected restoring(from: number, to: number, marks: readonly Mark[]): MarkPiece {
		return { from, to, mark: this.type.isInSet(marks) ?? null }
	}

	protected alike(a: MarkPiece, b: MarkPiece): boolean {
		return sameMark(a.mark, b.mark)
	}

	protected withPieces(pieces: readonly MarkPiece[]): SetMarksStep {
		return new SetMarksStep(pieces, this.mark)
	}

	protected allowed(parent: Node): boolean {
		return parent.type.allowsMarkType(this.type)
	}

	override toJSON(): { stepType: string; mark: unknown; pieces: [number, number, unknown][] } {
		return {
			stepType: "docxSetMarks",
			mark: this.mark.toJSON(),
			pieces: this.pieces.map(piece => [piece.from, piece.to, piece.mark?.toJSON() ?? null])
		}
	}

	static override fromJSON(schema: Schema, json: { mark: unknown; pieces: [number, number, unknown][] }): SetMarksStep {
		if (!Array.isArray(json.pieces)) throw new RangeError("Invalid input for SetMarksStep.fromJSON")

		return new SetMarksStep(
			json.pieces.map(([from, to, mark]) => ({ from, to, mark: mark === null ? null : schema.markFromJSON(mark) })),
			schema.markFromJSON(json.mark)
		)
	}
}

Step.jsonID("docxSetMarks", SetMarksStep)

// Sets the marks of several types piece by piece: each piece's content keeps its marks of other types and has
// exactly the piece's `marks` of `types` (Clear All Formatting and the format painter change a dozen types at
// once: one step, not one per type).
export class SetMarkSetsStep extends PieceMarksStep<MarksPiece> {
	readonly types: readonly MarkType[]

	constructor(types: readonly MarkType[], pieces: readonly MarksPiece[], mark: Mark) {
		super(pieces, mark)

		this.types = types
	}

	// Whether content with `marks` changes under `piece`.
	changes(piece: MarksPiece, marks: readonly Mark[]): boolean {
		return !sameSet(this.marked(piece, marks), marks)
	}

	protected marked(piece: MarksPiece, marks: readonly Mark[]): readonly Mark[] {
		let out: readonly Mark[] = marks.filter(mark => !this.types.includes(mark.type))

		for (const mark of piece.marks) out = mark.addToSet(out)

		return out
	}

	protected restoring(from: number, to: number, marks: readonly Mark[]): MarksPiece {
		return { from, to, marks: marks.filter(mark => this.types.includes(mark.type)) }
	}

	protected alike(a: MarksPiece, b: MarksPiece): boolean {
		return sameSet(a.marks, b.marks)
	}

	protected withPieces(pieces: readonly MarksPiece[]): SetMarkSetsStep {
		return new SetMarkSetsStep(this.types, pieces, this.mark)
	}

	protected allowed(parent: Node): boolean {
		return this.types.every(type => parent.type.allowsMarkType(type))
	}

	override toJSON(): { stepType: string; mark: unknown; types: string[]; pieces: [number, number, unknown[]][] } {
		return {
			stepType: "docxSetMarkSets",
			mark: this.mark.toJSON(),
			types: this.types.map(type => type.name),
			pieces: this.pieces.map(piece => [piece.from, piece.to, piece.marks.map(mark => mark.toJSON())])
		}
	}

	static override fromJSON(
		schema: Schema,
		json: { mark: unknown; types: string[]; pieces: [number, number, unknown[]][] }
	): SetMarkSetsStep {
		if (!Array.isArray(json.pieces) || !Array.isArray(json.types)) throw new RangeError("Invalid input for SetMarkSetsStep.fromJSON")

		return new SetMarkSetsStep(
			json.types.map(name => {
				const type = schema.marks[name]

				if (type === undefined) throw new RangeError(`Unknown mark type ${name}`)

				return type
			}),
			json.pieces.map(([from, to, marks]) => ({ from, to, marks: marks.map(mark => schema.markFromJSON(mark)) })),
			schema.markFromJSON(json.mark)
		)
	}
}

Step.jsonID("docxSetMarkSets", SetMarkSetsStep)

export type PieceStep = SetMarksStep | SetMarkSetsStep

// A step setting inline marks over [from, to): an AddMarkStep, or a piece step (its covering range; `mark`
// stands for what it sets).
export function isAddMarkLike(step: Step): step is AddMarkStep | PieceStep {
	return step instanceof AddMarkStep || step instanceof PieceMarksStep
}

// A step changing inline marks over [from, to): an AddMarkStep, a RemoveMarkStep or a piece step.
export type MarkStep = AddMarkStep | RemoveMarkStep | PieceStep

// Private: a MarkSetStep changes marks too; callers read steps through markStepsOf.
function isMarkStep(step: Step): step is MarkStep {
	return step instanceof AddMarkStep || step instanceof RemoveMarkStep || step instanceof PieceMarksStep
}

// prosemirror-transform's MarkSetStep (not exported): what an AddMarkStep displacing other marks of its type or a
// RemoveMarkStep over gaps inverts to, so an undo of a plain addMark/removeMark may hold one. Its `steps` (mark
// steps, or such sets) apply in order. The class comes from the step registry: an O(1) check, nothing serialized.
const MARK_SET = Step.fromJSON(docxSchema, { stepType: "markSet", steps: [] }).constructor

// The mark steps `step` stands for, in the order they apply: itself, or a MarkSetStep's; undefined for any other
// step. Mark steps change no positions, so each part's range holds in the document the step applies to.
export function markStepsOf(step: Step): readonly MarkStep[] | undefined {
	if (isMarkStep(step)) return [step]
	if (step.constructor !== MARK_SET) return undefined

	const out: MarkStep[] = []

	collectMarkSet(step, out)

	return out
}

function collectMarkSet(step: Step, out: MarkStep[]): void {
	if (!("steps" in step) || !Array.isArray(step.steps)) return

	for (const part of step.steps as readonly Step[]) {
		if (isMarkStep(part)) out.push(part)
		else collectMarkSet(part, out)
	}
}

// The ranges a mark step changes: a piece step's pieces, else its range.
export function markStepPieces(step: MarkStep): readonly { readonly from: number; readonly to: number }[] {
	return step instanceof PieceMarksStep ? step.pieces : [step]
}

// The mark types a mark step changes.
export function markStepTypes(step: MarkStep): readonly MarkType[] {
	return step instanceof SetMarkSetsStep ? step.types : [step.mark.type]
}

// The pieces of a SetMarksStep gathered in document order (pieces next to each other getting the same mark
// join), made into the step at the end.
export class MarkChanges {
	private readonly pieces: MarkPiece[] = []
	private sorted = true

	add(from: number, to: number, mark: Mark | null): void {
		if (to <= from) return

		const last = this.pieces[this.pieces.length - 1]

		if (last !== undefined && last.to === from && sameMark(last.mark, mark)) {
			this.pieces[this.pieces.length - 1] = { from: last.from, to, mark }

			return
		}

		if (last !== undefined && from < last.to) this.sorted = false

		this.pieces.push({ from, to, mark })
	}

	get empty(): boolean {
		return this.pieces.length === 0
	}

	// Adds the step to `tr` (none without pieces); `mark` is a mark of the type, what readers of an AddMarkStep
	// see.
	step(tr: Transaction, mark: Mark): void {
		if (this.pieces.length === 0) return
		if (!this.sorted) this.pieces.sort((a, b) => a.from - b.from)

		tr.step(new SetMarksStep(this.pieces, mark))
	}
}

// The pieces of a SetMarkSetsStep, gathered as MarkChanges gathers its own.
export class MarkSetChanges {
	private readonly pieces: MarksPiece[] = []
	private readonly types: readonly MarkType[]
	private sorted = true

	constructor(types: readonly MarkType[]) {
		this.types = types
	}

	add(from: number, to: number, marks: readonly Mark[]): void {
		if (to <= from) return

		const last = this.pieces[this.pieces.length - 1]

		if (last !== undefined && last.to === from && sameSet(last.marks, marks)) {
			this.pieces[this.pieces.length - 1] = { from: last.from, to, marks }

			return
		}

		if (last !== undefined && from < last.to) this.sorted = false

		this.pieces.push({ from, to, marks })
	}

	get empty(): boolean {
		return this.pieces.length === 0
	}

	// Adds the step to `tr` (none without pieces); `mark` is what readers of an AddMarkStep see.
	step(tr: Transaction, mark: Mark): void {
		if (this.pieces.length === 0) return
		if (!this.sorted) this.pieces.sort((a, b) => a.from - b.from)

		tr.step(new SetMarkSetsStep(this.types, this.pieces, mark))
	}
}

// The first piece that may overlap a node, for nodes visited in document order (positions only grow).
class Cursor {
	index = 0
	private readonly pieces: readonly Range[]

	constructor(pieces: readonly Range[]) {
		this.pieces = pieces
	}

	overlaps(pos: number, end: number): boolean {
		while (this.index < this.pieces.length && (this.pieces[this.index]?.to ?? 0) <= pos) this.index++

		return this.index < this.pieces.length && (this.pieces[this.index]?.from ?? 0) < end
	}
}

function sameMark(a: Mark | null, b: Mark | null): boolean {
	return a === null ? b === null : b !== null && a.eq(b)
}

export function sameSet(a: readonly Mark[], b: readonly Mark[]): boolean {
	return a.length === b.length && a.every((mark, k) => mark === b[k] || mark.eq(b[k] as Mark))
}
