import { RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state"
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view"
import { findNext, findPrevious, getSearchQuery, replaceAll, replaceNext, search, SearchQuery, setSearchQuery } from "@codemirror/search"
import type { DocxFindControls } from "@/features/preview/components/docxViewer.logic"

// Find and replace for the text and code viewers in their command bar (the find field the document viewers share,
// DocxFindField), over CodeMirror's own search state and commands in place of its bottom panel. The field reads a
// store: a match count capped at CODE_FIND_LIMIT and the current match, counted again at most once a frame while the
// field is open, so typing in the editor re-renders the field only, never the bar.

export const CODE_FIND_LIMIT = 1000

export interface CodeFindCount {
	readonly count: number
	// More matches than `count`.
	readonly capped: boolean
	// The match the selection is on (0-based), or -1.
	readonly active: number
}

const NO_MATCHES: CodeFindCount = { count: 0, capped: false, active: -1 }

// Matches of `query` up to `limit`, and which one the main selection covers.
export function countCodeMatches(state: EditorState, query: SearchQuery, limit: number): CodeFindCount {
	if (!query.valid) {
		return NO_MATCHES
	}

	const { from, to } = state.selection.main
	const cursor = query.getCursor(state)
	let count = 0
	let active = -1

	for (let match = cursor.next(); !match.done; match = cursor.next()) {
		if (count === limit) {
			return { count, capped: true, active }
		}

		if (match.value.from === from && match.value.to === to) {
			active = count
		}

		count++
	}

	return { count, capped: false, active }
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

		if (query.valid) {
			const start = view.state.selection.main.from
			const after = query.getCursor(view.state, start).next()
			const match = after.done ? query.getCursor(view.state).next() : after

			if (!match.done) {
				view.dispatch({
					selection: { anchor: match.value.from, head: match.value.to },
					scrollIntoView: true,
					userEvent: "select.search"
				})
			}
		}

		this.recount()
	}

	// CodeMirror's commands open its panel for an empty query: never run without one.
	private run(command: (view: EditorView) => boolean): void {
		const view = this.view()

		if (view !== null && getSearchQuery(view.state).valid) {
			command(view)
			this.recount()
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

	// The next frame's count, after edits or moves while the field is open.
	schedule(): void {
		if (!this.snapshot.open || this.frame !== 0) {
			return
		}

		this.frame = requestAnimationFrame(() => {
			this.frame = 0
			this.recount()
		})
	}

	private recount(): void {
		const view = this.view()
		const counted =
			view === null || !this.snapshot.open ? NO_MATCHES : countCodeMatches(view.state, getSearchQuery(view.state), CODE_FIND_LIMIT)
		const current = this.snapshot

		if (counted.count !== current.count || counted.capped !== current.capped || counted.active !== current.active) {
			this.set({ ...current, ...counted })
		}
	}

	dispose(): void {
		cancelAnimationFrame(this.frame)
		this.frame = 0
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
