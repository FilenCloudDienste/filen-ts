import type { EditorState } from "prosemirror-state"
import { clampZoom } from "@filen/office/dom/docx"

// The editor's find state, how Find seeds from the selection, and Ctrl/Cmd+wheel zoom steps.

export interface FindState {
	open: boolean
	// Opened as "Find and replace".
	replace: boolean
	// Bumped to focus the field again.
	focus: number
	query: string
	caseSensitive: boolean
	// The current match; -1 until a search picks one (the first after the caret).
	active: number
}

export const FIND_CLOSED: FindState = { open: false, replace: false, focus: 0, query: "", caseSensitive: false, active: -1 }

// The longest selection Find takes as its query (Word's Find what holds 255 characters).
export const FIND_SEED_MAX = 255

// The selection's text as a query for Find: a selection within one paragraph, up to FIND_SEED_MAX characters;
// undefined for an empty, longer or multi-paragraph one (Find keeps its last query then, as Word does). Takes
// the editor, not its state: a callback reading the state would change with every keystroke.
export function findSeed(editor: { readonly state: EditorState }): string | undefined {
	const { doc, selection } = editor.state
	const { from, to } = selection

	if (from >= to) {
		return undefined
	}

	const start = doc.resolve(from)

	if (!start.parent.isTextblock || !start.sameParent(doc.resolve(to))) {
		return undefined
	}

	const text = doc.textBetween(from, to)

	return text.length === 0 || text.length > FIND_SEED_MAX ? undefined : text
}

// Find opened (Ctrl+F, Ctrl+H): the query and its options kept from the last search this session, or the
// selection's text when `seed` is given (a new search then, from the caret).
export function openedFind(previous: FindState, replace: boolean, seed: string | undefined): FindState {
	const seeded = seed !== undefined && seed !== previous.query ? { query: seed, active: -1 } : {}

	return previous.open
		? { ...previous, ...seeded, replace: previous.replace || replace, focus: previous.focus + 1 }
		: { ...previous, ...seeded, open: true, replace, focus: previous.focus + 1, active: -1 }
}

// Find closed: the query and its options stay for the next time it opens.
export function closedFind(previous: FindState): FindState {
	return { ...previous, open: false, replace: false, active: -1 }
}

export const WHEEL_SENSITIVITY = 0.0015

// The zoom after one Ctrl/Cmd+wheel step from `previous` (fit: the width-fitting zoom `fit`). Applied as a
// state updater, so steps arriving faster than renders add up.
export function wheelZoom(previous: "fit" | number, fit: number, deltaY: number): number {
	return clampZoom((previous === "fit" ? fit : previous) - deltaY * WHEEL_SENSITIVITY)
}
