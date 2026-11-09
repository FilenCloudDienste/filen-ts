import { useEffect, useRef } from "react"
import { autoCompleteIndex, autoCompletion, type AutoCompleteIndex, type SheetSessionApi } from "@filen/office/core/sheet"
import type { GridEditing, SheetGridModel } from "@filen/office/react/sheet"

// AutoComplete in the entry (support.microsoft.com, "Turn automatic completion of cell entries on or off"): once a
// character is typed at the end of a text entry, the one entry of the column that starts with it fills in the rest,
// selected, so typing on replaces it, Backspace or Delete drops it and Enter takes it. A formula is not completed.

// Completes the entry in `input` (whose text is `text`, the open entry's) from `index`: the completed text, or null
// when nothing was completed. The rest is selected in the editor.
export function completeEntry(input: HTMLTextAreaElement | HTMLInputElement, text: string, index: AutoCompleteIndex): string | null {
	if (input.value !== text || text === "" || text.startsWith("=")) return null
	if (input.selectionStart !== text.length || input.selectionEnd !== text.length) return null

	const found = autoCompletion(index, text)

	if (found === null) return null

	const completed = text + found.slice(text.length)

	input.value = completed
	input.setSelectionRange(text.length, completed.length, "forward")

	return completed
}

// Whether an input event typed characters (not a paste, a deletion, an undo or an input method's composition).
export function typedInput(event: Event): boolean {
	return event instanceof InputEvent && event.inputType === "insertText" && !event.isComposing
}

// The column's entries for the entry open now, read once the first character is typed into it: by cell, and those
// that arrived (null while the session reads them). `waiting`: text typed before they came, completed when they do.
interface EntrySession {
	readonly key: string
	index: AutoCompleteIndex | null
	waiting: string | null
}

interface AutoCompleteContext {
	readonly model: SheetGridModel
	readonly session: SheetSessionApi
	readonly current: { current: EntrySession | null }
}

// The focused entry editor (the in-cell editor or the formula bar, both marked data-sheet-editor), or null.
function entryEditor(element: EventTarget | null): HTMLTextAreaElement | HTMLInputElement | null {
	return (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) &&
		element.closest("[data-sheet-editor]") !== null
		? element
		: null
}

// Completes what `input` holds when it is the open entry's text, reading the column's entries first.
function complete(context: AutoCompleteContext, input: HTMLTextAreaElement | HTMLInputElement): void {
	const { model, session, current } = context
	const entry = model.getSnapshot().editing

	if (entry?.text !== input.value || entry.text === "" || entry.text.startsWith("=")) return

	const key = `${String(entry.sheet)}:${String(entry.row)}:${String(entry.col)}`
	let state = current.current

	if (state?.key !== key) {
		const started: EntrySession = { key, index: null, waiting: null }

		state = started
		current.current = started
		session.query("autoComplete.entries", { sheet: entry.sheet, row: entry.row, col: entry.col }).then(
			result => {
				if (current.current !== started) return

				started.index = autoCompleteIndex(result.entries.map(item => item.text))

				const waiting = started.waiting
				const editor = entryEditor(document.activeElement)

				started.waiting = null

				if (waiting !== null && editor?.value === waiting) complete(context, editor)
			},
			() => undefined
		)
	}

	if (state.index === null) {
		state.waiting = entry.text

		return
	}

	state.waiting = null

	const completed = completeEntry(input, entry.text, state.index)

	if (completed !== null) model.setEditText(completed)
}

// AutoComplete for the in-cell editor and the formula bar while `canEdit`.
export function useEntryAutoComplete({
	model,
	session,
	canEdit,
	editing
}: {
	model: SheetGridModel
	session: SheetSessionApi
	canEdit: boolean
	editing: GridEditing | null
}): void {
	const current = useRef<EntrySession | null>(null)
	const opened = editing === null ? null : `${String(editing.sheet)}:${String(editing.row)}:${String(editing.col)}`

	// After the editor's own handler (React's, at its root), which has given the entry the typed text.
	useEffect(() => {
		if (!canEdit) return

		const context = { model, session, current }
		const input = (event: Event): void => {
			const editor = typedInput(event) ? entryEditor(event.target) : null

			if (editor !== null) complete(context, editor)
		}

		document.addEventListener("input", input)

		return () => {
			document.removeEventListener("input", input)
		}
	}, [model, session, canEdit])

	// An entry opened by typing a character (the grid's key, not the editor's input) completes from it too; a closed
	// entry lets its entries go.
	useEffect(() => {
		if (opened === null) {
			current.current = null

			return
		}

		const entry = model.getSnapshot().editing
		const editor = entryEditor(document.activeElement)

		if (canEdit && entry?.mode === "enter" && !entry.fromInput && entry.text !== "" && editor !== null)
			complete({ model, session, current }, editor)
	}, [opened, model, session, canEdit])
}
