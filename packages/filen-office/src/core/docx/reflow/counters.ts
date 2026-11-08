import type { Node } from "prosemirror-model"
import { docxSchema, type DocxEditorSession } from "../edit/index"
import { listMarkerText, markVanishes } from "../layout/content"
import { numberText } from "../layout/fields"
import { NoteNumbering, type NoteNumberingSnapshot } from "../layout/notes"
import { revisionHidden } from "../model/kinds"
import { NumberingCounters, type CounterSnapshot } from "../numbering/index"
import type { PagedEditor } from "../paged/index"
import { symbolTable, symbolText } from "../../fonts/index"
import type { NotePositionProps } from "../props/index"
import { endsSection, finalSectionEnd, sectionEndOf, sectionProps } from "../stories/sections"

// The numbers the reflowed view shows (list markers, note marks), counted as the pages count them and over a
// story's top-level blocks from checkpoints rather than from the story's start: a window far into a document
// costs the blocks since the nearest checkpoint, and an edit counts again only what follows it.
//
// As layout counts them: a paragraph whose mark the revision view hides (or w:vanish hides) joins the next one,
// and the joined paragraphs are one paragraph with the first one's marker (layout/content.ts build); a marker
// whose run is hidden counts but is not shown; notes are numbered by their section's note properties,
// restarting where those say (layout/notes.ts NoteNumbering).

const nodes = docxSchema.nodes
// The counting state is kept every this many top-level blocks.
const CHECKPOINT = 64
// A top-level table of at least this many rows keeps the counting state every ROW_CHECKPOINT rows, so an edit
// in it counts again from its row and only as far as the numbers it changed reach (or the rows asked for).
const TABLE_ROWS = 64
const ROW_CHECKPOINT = 16

export type MarkerSuffix = "tab" | "space" | "nothing"

const SUFFIXES: Readonly<Record<MarkerSuffix, string>> = { tab: "\t", space: " ", nothing: "" }

// A list marker's text as shown: a symbol font's codes as the characters they draw.
export function markerText(session: CountedStory, paragraph: Node, text: string): string {
	const run = session.context.resolver.listMarker(session.formats.paragraph(paragraph))
	const table = run === undefined ? undefined : symbolTable(run.fonts.ascii)

	return table === undefined ? text : symbolText(table, text)
}

// A list marker as a copy writes it before its paragraph's text: as shown, then what follows it (w:suff).
export function markerCopy(session: CountedStory, paragraph: Node, text: string, suffix: MarkerSuffix): string {
	return markerText(session, paragraph, text) + SUFFIXES[suffix]
}

// The counting state before a row of a long table.
interface RowState {
	readonly lists: CounterSnapshot | undefined
	readonly news: ReadonlyMap<string, number>
	readonly notes: NoteNumberingSnapshot
}

// A long table as last counted: its rows, the state before every ROW_CHECKPOINT-th row and after the last one.
interface TableCount {
	readonly rows: readonly Node[]
	readonly states: ReadonlyMap<number, RowState>
	readonly after: RowState
}

function sameLists(a: CounterSnapshot | undefined, b: CounterSnapshot | undefined): boolean {
	if (a === undefined || b === undefined) return a === b
	if (a.sets.size !== b.sets.size || a.overridesApplied.size !== b.overridesApplied.size) return false

	for (const [id, set] of a.sets) {
		const other = b.sets.get(id)

		if (other === undefined || other.values.length !== set.values.length || other.active.length !== set.active.length) return false

		for (let k = 0; k < set.values.length; k++) if (set.values[k] !== other.values[k]) return false
		for (let k = 0; k < set.active.length; k++) if (set.active[k] !== other.active[k]) return false
	}

	for (const [id, applied] of a.overridesApplied) if (b.overridesApplied.get(id) !== applied) return false

	return true
}

function sameState(a: RowState, b: RowState): boolean {
	if (a.news.size !== b.news.size) return false

	for (const [key, value] of a.news) if (b.news.get(key) !== value) return false

	return (
		a.notes.footnoteNext === b.notes.footnoteNext &&
		a.notes.endnoteNext === b.notes.endnoteNext &&
		a.notes.footnotes === b.notes.footnotes &&
		a.notes.endnotes === b.notes.endnotes &&
		sameLists(a.lists, b.lists)
	)
}

interface Checkpoint {
	readonly index: number
	readonly lists: CounterSnapshot | undefined
	readonly news: ReadonlyMap<string, number>
	readonly notes: NoteNumberingSnapshot
	// The paragraph before it hid its mark (it joins this block's first paragraph).
	readonly joined: boolean
}

const NO_NOTES = { footnotes: undefined, endnotes: undefined } as const

// A vertically merged cell's continuation: the pages lay out none of what it holds (the merge shows the first
// cell's), so nothing in it counts.
function continued(node: Node): boolean {
	return node.type === nodes.table_cell && node.attrs["vMerge"] === "continue"
}

// What counting reads of a story: its document, its formats and its part (a session's, or a story only shown).
export type CountedStory = Pick<DocxEditorSession, "formats" | "context" | "story">

// List and note numbering of a story, from checkpoints: blocks are counted from the last checkpoint at or
// before the first one asked for. Checkpoints after a block that changed are dropped (see invalidate).
export class StoryCounters {
	private readonly editor: PagedEditor
	private readonly counters: NumberingCounters | undefined
	private readonly notes: NoteNumbering
	// Sections of the document give notes properties of their own (else the document's apply throughout).
	private readonly sectioned: boolean
	private readonly countable = new WeakMap<Node, boolean>()
	private checkpoints: Checkpoint[] = []
	// Long top-level tables as last counted, by index (kept while what precedes them is unchanged).
	private readonly tables = new Map<number, TableCount>()

	constructor(editor: PagedEditor, session: CountedStory) {
		const numbering = session.context.numbering
		const model = editor.edits.model
		const part = session.story.part

		this.editor = editor
		this.counters = numbering === undefined ? undefined : new NumberingCounters(numbering)
		this.notes = new NoteNumbering(model)
		this.sectioned =
			session.story.story.kind === "body" &&
			model.sections.some(section => {
				const props = section.sectPr < 0 ? undefined : session.context.store.section(part.document, section.sectPr)

				return props?.footnotes !== undefined || props?.endnotes !== undefined
			})
	}

	// Blocks from `index` on changed (-1: everything, as when the revision view changed): what was counted after
	// it is counted again.
	invalidate(index: number): void {
		let keep = this.checkpoints.length

		while (keep > 0 && (this.checkpoints[keep - 1]?.index ?? 0) > index) keep--

		this.checkpoints.length = keep

		// A table at `index` itself is counted from where its rows changed (it starts from the same state).
		for (const at of this.tables.keys()) if (index < 0 || at > index) this.tables.delete(at)
	}

	// The note properties of the section starting at block `index` of the body (a section's properties are at its
	// end), when the document's sections give their own (or an edit changed some).
	private sectionNotes(
		session: CountedStory,
		doc: Node,
		index: number
	): { readonly footnotes: NotePositionProps | undefined; readonly endnotes: NotePositionProps | undefined } {
		if (!this.sectioned && doc.attrs["sectionChanges"] === null) return NO_NOTES

		const part = session.story.part
		let end = finalSectionEnd(doc)

		for (let at = index; at < doc.childCount; at++) {
			const block = doc.child(at)

			if (endsSection(part, block)) {
				end = sectionEndOf(block)

				break
			}
		}

		const props = sectionProps(session.context, part, end)

		return { footnotes: props.footnotes, endnotes: props.endnotes }
	}

	// Calls `marker` for each paragraph showing a list marker and `note` for each note reference of blocks
	// [from, to) of `doc` (positions from `positionOf`); of a long table's rows, only those `wanted` says hold
	// positions asked for (all of them without it).
	count(
		session: CountedStory,
		doc: Node,
		from: number,
		to: number,
		positionOf: (index: number) => number,
		marker: (pos: number, text: string, paragraph: Node, suffix: MarkerSuffix) => void,
		note: (pos: number, text: string) => void,
		wanted?: (from: number, to: number) => boolean
	): void {
		const counters = this.counters
		const notes = this.notes
		const view = this.editor.view
		const body = session.story.story.kind === "body"
		let k = this.checkpoints.length - 1

		while (k >= 0 && (this.checkpoints[k]?.index ?? 0) > from) k--

		const checkpoint = k >= 0 ? this.checkpoints[k] : undefined
		const news = new Map(checkpoint?.news ?? [])

		if (checkpoint?.lists === undefined) counters?.reset()
		else counters?.restore(checkpoint.lists)

		if (checkpoint === undefined) {
			const section = body ? this.sectionNotes(session, doc, 0) : NO_NOTES

			notes.startSection(section.footnotes, section.endnotes, true)
		} else {
			notes.restore(checkpoint.notes)
		}

		const formats = session.formats
		const resolver = session.context.resolver
		// Counts a paragraph (unless it joins the one before, whose marker the joined ones share); true when its
		// own mark is hidden (it joins the next).
		const visit = (paragraph: Node, pos: number, shown: boolean, joined: boolean): boolean => {
			const direct = paragraph.attrs["numId"]
			const format = formats.paragraph(paragraph)
			const revision = paragraph.attrs["revision"]
			const hidden =
				revisionHidden(typeof revision === "number" ? revision : 0, view) || markVanishes(resolver.paragraphMark(format), false)

			if (!joined && typeof direct === "number" && direct < 0) {
				// A list a command made (not in the numbering part until saved): Word's first bullet or decimal level.
				const list = formats.newLists.get(direct)
				const ilvl = paragraph.attrs["ilvl"]
				const key = `${String(direct)}:${String(typeof ilvl === "number" ? ilvl : 0)}`
				const value = (news.get(key) ?? 0) + 1

				news.set(key, value)

				// The first level of one AutoFormat started counts from its typed number in its format.
				const first = typeof ilvl === "number" && ilvl > 0 ? undefined : list?.first

				if (shown && list !== undefined)
					marker(
						pos + 1,
						list.kind === "bullet"
							? "•"
							: first === undefined
								? `${String(value)}.`
								: `${numberText(first.start + value - 1, first.format)}${first.suffix}`,
						paragraph,
						"tab"
					)
			} else if (!joined) {
				const numbering = format.props.numbering

				if (numbering !== undefined && numbering.numId > 0 && format.level !== undefined && counters !== undefined) {
					const counted = counters.next(numbering.numId, numbering.ilvl)
					const run = resolver.listMarker(format)
					const text = counted === undefined ? "" : listMarkerText(counted)

					// A marker whose run is hidden still counts (as on the pages); it is not shown. One of no text shows
					// (and copies) what follows it, as on the pages.
					if (
						shown &&
						counted !== undefined &&
						(text.length > 0 || counted.suffix !== "nothing") &&
						run !== undefined &&
						!run.vanish
					)
						marker(pos + 1, text, paragraph, counted.suffix)
				}
			}

			paragraph.forEach((child, at) => {
				if (child.type !== nodes.note_ref || child.attrs["custom"] === true) return

				const endnote = child.attrs["kind"] === "endnote"
				const state = notes.snapshot()
				const value = endnote ? state.endnoteNext : state.footnoteNext

				notes.restore(endnote ? { ...state, endnoteNext: value + 1 } : { ...state, footnoteNext: value + 1 })

				if (shown) note(pos + 1 + at, numberText(value, endnote ? state.endnotes.format : state.footnotes.format))
			})

			return hidden
		}
		// The blocks inside a block that hold anything counted, in order.
		const walk = (parent: Node, pos: number, shown: boolean): void => {
			let joined = false

			parent.forEach((child, at) => {
				if (child.isTextblock) {
					joined = visit(child, pos + 1 + at, shown, joined)
				} else {
					joined = false

					if (!child.isLeaf && !continued(child) && this.counts(session, child)) walk(child, pos + 1 + at, shown)
				}
			})
		}
		const state = (): RowState => ({ lists: counters?.snapshot(), news: new Map(news), notes: notes.snapshot() })
		const restore = (to: RowState): void => {
			if (to.lists === undefined) counters?.reset()
			else counters?.restore(to.lists)

			news.clear()

			for (const [key, value] of to.news) news.set(key, value)

			notes.restore(to.notes)
		}
		// A long table at `index`: rows unchanged since it was last counted, from the same state, and not asked
		// for are passed over (from the state kept after them).
		const table = (index: number, block: Node, pos: number, shown: boolean): void => {
			const last = this.tables.get(index)
			const rows: Node[] = []
			const states = new Map<number, RowState>()
			const count = block.childCount
			// The state now is the one `last` had before row r (so for the same rows it stays so).
			let same = last !== undefined
			let at = pos + 1
			const asked = (from: number, to: number): boolean => shown && (wanted?.(from, to) ?? true)

			for (let r = 0; r < count;) {
				const row = block.child(r)

				if (last !== undefined && r % ROW_CHECKPOINT === 0) {
					const before = last.states.get(r)
					const now = same ? before : state()

					// Where an edit's numbers stop differing, the rows after it are as they were.
					if (!same && before !== undefined && now !== undefined && sameState(now, before)) same = true

					states.set(r, same && before !== undefined ? before : (now ?? state()))
				} else if (r % ROW_CHECKPOINT === 0) {
					states.set(r, state())
				}

				if (same && last !== undefined && last.rows[r] === row && !asked(at, at + row.nodeSize)) {
					// Rows the same and not asked for, up to a kept state: that state, and on from there.
					let end = r
					let to = at

					while (end < count && last.rows[end] === block.child(end) && !asked(to, to + block.child(end).nodeSize)) {
						to += block.child(end).nodeSize
						end++
					}

					const stop = end === count && last.rows.length === count ? count : end - (end % ROW_CHECKPOINT)
					const resume = stop === count ? last.after : last.states.get(stop)

					if (stop > r && resume !== undefined) {
						for (let k = r; k < stop; k++) {
							const kept = last.states.get(k)

							rows.push(block.child(k))
							at += block.child(k).nodeSize

							if (k % ROW_CHECKPOINT === 0 && kept !== undefined) states.set(k, kept)
						}

						restore(resume)
						r = stop

						continue
					}
				}

				rows.push(row)

				if (!row.isLeaf && this.counts(session, row)) walk(row, at, asked(at, at + row.nodeSize))

				// A row changed: the numbers may differ from here on.
				if (last?.rows[r] !== row) same = false

				at += row.nodeSize
				r++
			}

			this.tables.set(index, { rows, states, after: same && last !== undefined && last.rows.length === count ? last.after : state() })
		}
		let joined = checkpoint?.joined ?? false

		for (let index = checkpoint?.index ?? 0; index < to && index < doc.childCount; index++) {
			if (index % CHECKPOINT === 0 && (this.checkpoints.at(-1)?.index ?? -1) < index)
				this.checkpoints.push({ index, lists: counters?.snapshot(), news: new Map(news), notes: notes.snapshot(), joined })

			const block = doc.child(index)
			const start = positionOf(index)
			const shown = index >= from

			if (block.isTextblock) {
				joined = visit(block, start, shown, joined)
			} else {
				joined = false

				if (block.type === nodes.table && block.childCount >= TABLE_ROWS) {
					if (this.counts(session, block)) table(index, block, start, shown)
				} else if (this.counts(session, block)) {
					walk(block, start, shown)
				}
			}

			// A section ends: the next one's note properties, numbers restarting where they say.
			if (body && endsSection(session.story.part, block)) {
				const section = this.sectionNotes(session, doc, index + 1)

				notes.startSection(section.footnotes, section.endnotes, false)
			}
		}
	}

	// Whether `node` holds anything counted (a numbered paragraph, a note reference): kept per node, so a long
	// table edited in one cell is read where it changed only.
	private counts(session: CountedStory, node: Node): boolean {
		const known = this.countable.get(node)

		if (known !== undefined) return known

		let found = false

		if (node.isTextblock) {
			const numId = node.attrs["numId"]
			const numbering = typeof numId === "number" && numId < 0 ? undefined : session.formats.paragraph(node).props.numbering

			found = (typeof numId === "number" && numId < 0) || (numbering !== undefined && numbering.numId > 0)

			for (let k = 0; k < node.childCount && !found; k++) found = node.child(k).type === nodes.note_ref
		} else {
			for (let k = 0; k < node.childCount && !found; k++) {
				const child = node.child(k)

				found = !child.isLeaf && !continued(child) && this.counts(session, child)
			}
		}

		this.countable.set(node, found)

		return found
	}
}
