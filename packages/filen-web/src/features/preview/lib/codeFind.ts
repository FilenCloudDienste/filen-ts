import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state"
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view"
import { findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, search, SearchQuery, setSearchQuery } from "@codemirror/search"
import type { DocxFindControls } from "@/features/preview/components/docxViewer.logic"

// Find and replace for the text and code viewers in their command bar (the find field the document viewers share,
// DocxFindField), over CodeMirror's own search state and commands in place of its bottom panel. The field reads a
// store: a match count capped at CODE_FIND_LIMIT and the current match. The matches are collected once per query and,
// after edits, once the typing pauses; a caret move only looks the selection up in them, at most once a frame. Typing
// in the editor re-renders the field only, never the bar.

export const CODE_FIND_LIMIT = 1000
// Edits wait this long (ms) for the next before the matches are collected again.
export const CODE_FIND_EDIT_DELAY = 200

export interface CodeFindCount {
	readonly count: number
	// More matches than `count`.
	readonly capped: boolean
	// The match the selection is on (0-based), or -1.
	readonly active: number
}

const NO_MATCHES: CodeFindCount = { count: 0, capped: false, active: -1 }

// The first matches of a query, in document order (they never overlap).
export interface CodeMatches {
	readonly starts: readonly number[]
	readonly ends: readonly number[]
	// More matches than these.
	readonly capped: boolean
}

const EMPTY_MATCHES: CodeMatches = { starts: [], ends: [], capped: false }

// Matches of `query` up to `limit`, in one walk of the document.
export function collectCodeMatches(state: EditorState, query: SearchQuery, limit: number): CodeMatches {
	if (!query.valid) {
		return EMPTY_MATCHES
	}

	const starts: number[] = []
	const ends: number[] = []
	const cursor = query.getCursor(state)

	for (let match = cursor.next(); !match.done; match = cursor.next()) {
		if (starts.length === limit) {
			return { starts, ends, capped: true }
		}

		starts.push(match.value.from)
		ends.push(match.value.to)
	}

	return { starts, ends, capped: false }
}

// The index of the first match starting at or after `position` (the count when none does).
function firstMatchFrom(starts: readonly number[], position: number): number {
	let low = 0
	let high = starts.length

	while (low < high) {
		const middle = (low + high) >>> 1

		if ((starts[middle] ?? 0) < position) {
			low = middle + 1
		} else {
			high = middle
		}
	}

	return low
}

// The count of `matches`, and which one the selection from `from` to `to` covers.
export function countOfCodeMatches(matches: CodeMatches, from: number, to: number): CodeFindCount {
	const index = firstMatchFrom(matches.starts, from)
	const active = matches.starts[index] === from && matches.ends[index] === to ? index : -1

	return { count: matches.starts.length, capped: matches.capped, active }
}

// The field is open: matches are highlighted (CodeMirror's own highlighter shows only with its panel).
const setFindOpen = StateEffect.define<boolean>()

const findOpen = StateField.define<boolean>({
	create: () => false,
	update: (open, transaction) => {
		for (const effect of transaction.effects) {
			if (effect.is(setFindOpen)) {
				open = effect.value
			}
		}

		return open
	}
})

const MATCH = Decoration.mark({ class: "cm-searchMatch" })
const SELECTED = Decoration.mark({ class: "cm-searchMatch cm-searchMatch-selected" })
// Visible ranges this close together are searched as one, and each is searched this far past its ends.
const MARGIN = 250

// The matches in view only, as CodeMirror's own highlighter does.
function highlights(view: EditorView): DecorationSet {
	const state = view.state
	const query = getSearchQuery(state)

	if (!state.field(findOpen) || !query.valid) {
		return Decoration.none
	}

	const builder = new RangeSetBuilder<Decoration>()
	const main = state.selection.main
	const ranges = view.visibleRanges

	for (let index = 0; index < ranges.length; index++) {
		const range = ranges[index]

		if (range === undefined) {
			continue
		}

		let to = range.to

		for (let next = ranges[index + 1]; next !== undefined && to > next.from - 2 * MARGIN; next = ranges[index + 1]) {
			to = next.to
			index++
		}

		const cursor = query.getCursor(state, Math.max(0, range.from - MARGIN), Math.min(state.doc.length, to + MARGIN))

		for (let match = cursor.next(); !match.done; match = cursor.next()) {
			const { from, to: end } = match.value

			builder.add(from, end, from === main.from && end === main.to ? SELECTED : MATCH)
		}
	}

	return builder.finish()
}

const highlighter = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet

		constructor(view: EditorView) {
			this.decorations = highlights(view)
		}

		update(update: ViewUpdate): void {
			if (
				update.docChanged ||
				update.selectionSet ||
				update.viewportChanged ||
				update.transactions.some(transaction =>
					transaction.effects.some(effect => effect.is(setSearchQuery) || effect.is(setFindOpen))
				)
			) {
				this.decorations = highlights(update.view)
			}
		}
	},
	{ decorations: plugin => plugin.decorations }
)

// CodeMirror's search state (for its commands) and the highlighter, in the editor's configuration.
export const codeFindExtension: Extension = [search(), findOpen, highlighter]

export interface CodeFindSnapshot extends CodeFindCount {
	readonly open: boolean
	// Opened as find and replace.
	readonly replace: boolean
	// Bumped to focus the field again while it is open.
	readonly focus: number
	// The query last searched.
	readonly query: string
	readonly caseSensitive: boolean
}

const CLOSED: CodeFindSnapshot = { ...NO_MATCHES, open: false, replace: false, focus: 0, query: "", caseSensitive: false }

export class CodeFind {
	private snapshot: CodeFindSnapshot = CLOSED
	private readonly listeners = new Set<() => void>()
	private frame = 0
	private timer: ReturnType<typeof setTimeout> | undefined = undefined
	// The matches, of `matchesQuery` in `matchesDoc`.
	private matches: CodeMatches = EMPTY_MATCHES
	private matchesQuery: SearchQuery | null = null
	private matchesDoc: Text | null = null
	private readonly view: () => EditorView | null
	// Replace is offered (an editable file).
	private readonly editable: boolean

	constructor(view: () => EditorView | null, editable: boolean) {
		this.view = view
		this.editable = editable
	}

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)

		return () => {
			this.listeners.delete(listener)
		}
	}

	readonly get = (): CodeFindSnapshot => this.snapshot

	readonly isOpen = (): boolean => this.snapshot.open

	private set(next: CodeFindSnapshot): void {
		this.snapshot = next

		for (const listener of this.listeners) {
			listener()
		}
	}

	// Opens the field (as find and replace), or focuses it again; the selection, when one line, is searched.
	open(replace: boolean): void {
		const view = this.view()
		const selected = view === null ? "" : view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)
		const seed = selected.length > 0 && !selected.includes("\n") ? selected : null

		this.set({
			...this.snapshot,
			open: true,
			replace: replace || (this.snapshot.open && this.snapshot.replace),
			focus: this.snapshot.focus + 1
		})
		view?.dispatch({ effects: setFindOpen.of(true) })

		if (seed !== null) {
			this.search(seed, this.snapshot.caseSensitive)
		}
	}

	close(): void {
		this.forget()
		this.set({ ...CLOSED, caseSensitive: this.snapshot.caseSensitive, focus: this.snapshot.focus })
		this.view()?.dispatch({ effects: [setFindOpen.of(false), setSearchQuery.of(new SearchQuery({ search: "" }))] })
	}

	// Searches from the selection on, wrapping round, and selects the first match.
	search(text: string, caseSensitive: boolean): void {
		const view = this.view()

		this.set({ ...this.snapshot, query: text, caseSensitive })

		if (view === null) {
			return
		}

		const query = new SearchQuery({ search: text, caseSensitive, literal: true })

		view.dispatch({ effects: setSearchQuery.of(query) })
		this.collect(view.state)

		const { starts, ends, capped } = this.matches
		const start = view.state.selection.main.from
		const index = firstMatchFrom(starts, start)
		let from = starts[index]
		let to = ends[index]

		// Past the collected matches: the first one from the selection on is beyond them.
		if (from === undefined && capped) {
			const after = query.getCursor(view.state, start).next()

			if (!after.done) {
				from = after.value.from
				to = after.value.to
			}
		}

		// None from the selection on: wrap round to the first.
		if (from === undefined) {
			from = starts[0]
			to = ends[0]
		}

		if (from !== undefined && to !== undefined) {
			view.dispatch({
				selection: { anchor: from, head: to },
				scrollIntoView: true,
				userEvent: "select.search"
			})
		}

		this.recount(false)
	}

	// CodeMirror's commands open its panel for an empty query: never run without one.
	private run(command: (view: EditorView) => boolean): void {
		const view = this.view()

		if (view !== null && getSearchQuery(view.state).valid) {
			command(view)
			this.recount(true)
		}
	}

	step(direction: 1 | -1): void {
		this.run(direction > 0 ? findNext : findPrevious)
	}

	private withReplacement(replacement: string, command: (view: EditorView) => boolean): void {
		const view = this.view()

		if (view === null) {
			return
		}

		const query = getSearchQuery(view.state)

		view.dispatch({
			effects: setSearchQuery.of(
				new SearchQuery({ search: query.search, caseSensitive: query.caseSensitive, literal: true, replace: replacement })
			)
		})
		this.run(command)
	}

	// The count after an edit (once the edits pause) or a move (the next frame) while the field is open.
	schedule(docChanged: boolean): void {
		if (!this.snapshot.open) {
			return
		}

		if (docChanged) {
			clearTimeout(this.timer)
			this.timer = setTimeout(() => {
				this.timer = undefined
				this.recount(true)
			}, CODE_FIND_EDIT_DELAY)

			return
		}

		if (this.frame !== 0) {
			return
		}

		this.frame = requestAnimationFrame(() => {
			this.frame = 0
			this.recount(false)
		})
	}

	// The matches are collected again for another query at once, and for another document only when `edited` (an
	// edit's delay ran out, or a command changed it); until then the count stays as it was.
	private recount(edited: boolean): void {
		const view = this.view()

		if (view === null || !this.snapshot.open) {
			this.update(NO_MATCHES)

			return
		}

		const state = view.state
		const query = getSearchQuery(state)
		const sameQuery = this.matchesQuery?.eq(query) ?? false

		if (sameQuery && this.matchesDoc !== state.doc && !edited) {
			return
		}

		this.collect(state)
		this.update(countOfCodeMatches(this.matches, state.selection.main.from, state.selection.main.to))
	}

	// The matches of the state's query in its document, collected again when either differs.
	private collect(state: EditorState): void {
		const query = getSearchQuery(state)

		if (this.matchesDoc === state.doc && this.matchesQuery?.eq(query) === true) {
			return
		}

		clearTimeout(this.timer)
		this.timer = undefined
		this.matches = collectCodeMatches(state, query, CODE_FIND_LIMIT)
		this.matchesQuery = query
		this.matchesDoc = state.doc
	}

	private update(counted: CodeFindCount): void {
		const current = this.snapshot

		if (counted.count !== current.count || counted.capped !== current.capped || counted.active !== current.active) {
			this.set({ ...current, ...counted })
		}
	}

	// Drops the matches and any count to come.
	private forget(): void {
		cancelAnimationFrame(this.frame)
		this.frame = 0
		clearTimeout(this.timer)
		this.timer = undefined
		this.matches = EMPTY_MATCHES
		this.matchesQuery = null
		this.matchesDoc = null
	}

	dispose(): void {
		this.forget()
	}

	// The field's view of it (DocxFindField).
	controls(snapshot: CodeFindSnapshot, locked: boolean): DocxFindControls {
		const controls: DocxFindControls = {
			query: snapshot.query,
			caseSensitive: snapshot.caseSensitive,
			count: snapshot.count,
			capped: snapshot.capped,
			active: snapshot.active,
			search: (query, caseSensitive) => {
				this.search(query, caseSensitive)
			},
			step: direction => {
				this.step(direction)
			},
			close: () => {
				this.close()
			}
		}

		return this.editable
			? {
					...controls,
					replace: {
						disabled: locked,
						one: replacement => {
							this.withReplacement(replacement, replaceNext)
						},
						all: replacement => {
							this.withReplacement(replacement, replaceAll)
						}
					}
				}
			: controls
	}
}
