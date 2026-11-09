import { useSyncExternalStore } from "react"
import type { OutlineShape, SlideOutline, SlideRef } from "@filen/office/core/presentation"
import type { PresentationSessionApi } from "@filen/office/dom/presentation"

// The Selection Pane's state for one editor session (PowerPoint keeps it per window): whether it is open, the slide's
// outline as the worker last answered it (asked again for each new render of the slide while the pane is open, never
// otherwise), and the groups collapsed in it. Nothing is asked while it is closed.

export interface SelectionPaneState {
	readonly open: boolean
	// The outline of the slide last asked about; undefined while the first answer for a slide is on its way.
	readonly outline: SlideOutline | undefined
	readonly failed: boolean
	// Groups collapsed in the list (expanded is the default, as PowerPoint opens it).
	readonly collapsed: ReadonlySet<number>
	// Bumps when the pane should take focus (Alt+F10).
	readonly focus: number
}

export interface SelectionPaneStore {
	readonly subscribe: (listener: () => void) => () => void
	readonly getSnapshot: () => SelectionPaneState
	readonly setOpen: (open: boolean, focus?: boolean) => void
	readonly toggle: (focus?: boolean) => void
	// The outline of `slide` at `revision` of its render (a repeat of the last ask does nothing).
	readonly request: (session: Pick<PresentationSessionApi, "outline">, slide: SlideRef, revision: number) => void
	readonly setCollapsed: (collapsed: ReadonlySet<number>) => void
}

function sameShape(a: OutlineShape, b: OutlineShape): boolean {
	return (
		a.id === b.id &&
		a.name === b.name &&
		a.hidden === b.hidden &&
		a.role === b.role &&
		a.media === b.media &&
		a.lock === b.lock &&
		a.locks?.noSelect === b.locks?.noSelect &&
		a.children === b.children
	)
}

// The new answer with every object that did not change kept as the object it was (members first, so an unchanged
// group keeps its object too): the pane draws again only the rows an edit changed.
export function stableOutline(previous: readonly OutlineShape[] | undefined, next: readonly OutlineShape[]): readonly OutlineShape[] {
	if (previous === undefined) return next

	const old = new Map(previous.map(shape => [shape.id, shape]))
	let same = previous.length === next.length
	const out = next.map((shape, index) => {
		const before = old.get(shape.id)
		const children =
			shape.children === undefined || before?.children === undefined ? undefined : stableOutline(before.children, shape.children)
		const candidate = children === undefined || children === shape.children ? shape : { ...shape, children }
		const kept = before !== undefined && sameShape(before, candidate) ? before : candidate

		if (kept !== previous[index]) same = false

		return kept
	})

	return same ? previous : out
}

const NO_COLLAPSED: ReadonlySet<number> = new Set()

export function createSelectionPane(): SelectionPaneStore {
	let state: SelectionPaneState = { open: false, outline: undefined, failed: false, collapsed: NO_COLLAPSED, focus: 0 }
	let token = 0
	let asked: { readonly session: object; readonly slide: SlideRef; readonly revision: number } | undefined
	const listeners = new Set<() => void>()
	const set = (next: Partial<SelectionPaneState>): void => {
		state = { ...state, ...next }

		for (const listener of listeners) listener()
	}
	const setOpen = (open: boolean, focus = false): void => {
		if (state.open === open && !focus) return

		// Closed, it forgets the outline (asked again when it opens: the slide may have changed meanwhile).
		if (!open) {
			asked = undefined
			token++
		}

		set({ open, ...(open ? {} : { outline: undefined, failed: false }), ...(open && focus ? { focus: state.focus + 1 } : {}) })
	}

	return {
		subscribe: listener => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		},
		getSnapshot: () => state,
		setOpen,
		toggle: focus => {
			setOpen(!state.open, focus)
		},
		request: (session, slide, revision) => {
			if (!state.open) return
			if (asked?.session === session && asked.slide === slide && asked.revision === revision) return

			const other = state.outline?.slide !== slide || asked?.session !== session

			asked = { session, slide, revision }

			const mine = ++token

			// Another slide: its list is not the last one's (a new revision of the same slide keeps it until the answer).
			if (other && state.outline !== undefined) set({ outline: undefined, failed: false, collapsed: NO_COLLAPSED })

			void session.outline(slide).then(
				outline => {
					if (mine !== token) return

					const shapes = stableOutline(state.outline?.slide === slide ? state.outline.shapes : undefined, outline.shapes)

					set({ outline: shapes === outline.shapes ? outline : { ...outline, shapes }, failed: false })
				},
				() => {
					if (mine === token) set({ outline: undefined, failed: true })
				}
			)
		},
		setCollapsed: collapsed => {
			set({ collapsed })
		}
	}
}

const CLOSED: SelectionPaneState = { open: false, outline: undefined, failed: false, collapsed: NO_COLLAPSED, focus: 0 }
const NO_STORE = {
	subscribe: () => () => undefined,
	getSnapshot: () => CLOSED
}

export function useSelectionPane(store: SelectionPaneStore | undefined): SelectionPaneState {
	const source = store ?? NO_STORE

	return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
}
