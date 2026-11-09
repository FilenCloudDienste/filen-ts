import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react"
import {
	acceptSuggestion,
	formulaContext,
	functionSuggestions,
	highlightedReferences,
	insertReference,
	pointedReference,
	type HighlightedReference,
	type SheetCommand,
	type SheetLocale,
	type SheetRange
} from "@filen/office/core/sheet"
import {
	stepFrom,
	type GridPoint,
	type SheetCellDrag,
	type SheetCellPointer,
	type SheetGridHandle,
	type SheetGridState,
	type SheetShortcut
} from "@filen/office/react/sheet"
import { resolveTheme, useTheme } from "@/providers/themeProvider"
import type { SheetBodyExtension } from "@/features/spreadsheet/components/sheetExtension"
import type { SheetHandle } from "@/features/spreadsheet/hooks/useSheetSession"
import { FormulaAssist } from "@/features/spreadsheet/formulaBar/formulaAssist"
import { REFERENCE_COLORS, referenceColors } from "@/features/spreadsheet/formulaBar/referenceColors"
import { referenceLayer } from "@/features/spreadsheet/formulaBar/referenceLayer"
import { ReferenceText } from "@/features/spreadsheet/formulaBar/referenceText"
import { browserLanguage, sheetLocaleOf } from "@/features/spreadsheet/formulaBar/sheetLocale"
import { useEntryAutoComplete } from "@/features/spreadsheet/formulaBar/autoComplete"

// Typing a formula, in the cell or the formula bar (Excel's formula UX): its references outlined on the cells in
// their colours and shown in them in the text, a click or drag on cells putting a reference at the caret where one may go (Point mode), function
// names offered as they are typed (Tab takes one) and the arguments of the call the caret is in, and AutoSum
// (Alt+=). A text entry completes from the column's entries (AutoComplete). The locale entries are typed in is
// given to the session here.

type Editor = HTMLInputElement | HTMLTextAreaElement

// The editor the user types in (the in-cell editor or the formula bar, both marked data-sheet-editor), or null.
function focusedEditor(): Editor | null {
	const element = document.activeElement

	return (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
		element.closest("[data-sheet-editor]") !== null
		? element
		: null
}

// A reference pointed at, which a further drag, click or arrow moves until something else is typed: where it is in the
// entry, and the cells it runs from (anchor) and to (focus, where an arrow steps from).
interface Pointed {
	readonly start: number
	readonly end: number
	readonly text: string
	readonly anchor: GridPoint
	readonly focus: GridPoint
}

const ARROWS: Readonly<Record<string, "up" | "down" | "left" | "right">> = {
	ArrowUp: "up",
	ArrowDown: "down",
	ArrowLeft: "left",
	ArrowRight: "right"
}

function spanOf(anchor: GridPoint, focus: GridPoint): SheetRange {
	return {
		startRow: Math.min(anchor.row, focus.row),
		startCol: Math.min(anchor.col, focus.col),
		endRow: Math.max(anchor.row, focus.row),
		endCol: Math.max(anchor.col, focus.col)
	}
}

export interface FormulaCaret {
	readonly editor: Editor | null
	readonly caret: number
}

// The view's part (sheetExtension.ts), with what the formula bar shares: the locale's argument separator, the caret,
// the entry with its references coloured (null when none is), and AutoSum for its button.
export interface SheetFormulaExtension extends SheetBodyExtension {
	readonly locale: SheetLocale
	readonly caret: FormulaCaret
	readonly coloredText: ReactNode
	readonly autoSum: () => void
	// The in-cell editor's keys before the grid's (SheetGrid onEditorKey): arrows point in a formula.
	readonly editorKey: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean
}

export function useSheetFormula({
	grid,
	gridRef,
	handle,
	canEdit,
	run
}: {
	grid: SheetGridState
	gridRef: RefObject<SheetGridHandle | null>
	handle: SheetHandle
	canEdit: boolean
	run: (command: SheetCommand) => void
}): SheetFormulaExtension {
	const { theme } = useTheme()
	const colors = referenceColors(resolveTheme(theme) === "dark")
	const [locale] = useState(() => sheetLocaleOf(browserLanguage()))
	const [caret, setCaret] = useState<FormulaCaret>({ editor: null, caret: 0 })
	// The suggestion list's choice, and the word it was dismissed for (Escape).
	const [choice, setChoice] = useState(0)
	const [dismissed, setDismissed] = useState<string | null>(null)
	const pointed = useRef<Pointed | null>(null)
	const { model, editing } = grid
	const text = editing?.text ?? ""
	const context = editing === null ? null : formulaContext(text, caret.caret, locale.argument)
	const word = context?.word ?? null
	const suggestions = word === null || `${String(word.start)}:${word.text}` === dismissed ? [] : functionSuggestions(word.text, 8)
	const sheetName = (sheet: number | undefined): string => grid.sheets.find(entry => entry.id === sheet)?.name ?? ""

	// A text entry completes from the column's entries (formulaBar/autoComplete.ts).
	useEntryAutoComplete({ model, session: handle.session, canEdit, editing })

	// The session reads entries in the browser's locale and shows inputs in it.
	useEffect(() => {
		handle.session.configure({ locale })
	}, [handle, locale])

	// Where the caret is, in whichever editor has focus.
	useEffect(() => {
		const update = (): void => {
			const editor = focusedEditor()

			setCaret(previous => {
				const next = editor === null ? 0 : (editor.selectionEnd ?? editor.value.length)

				return previous.editor === editor && previous.caret === next ? previous : { editor, caret: next }
			})
		}

		document.addEventListener("selectionchange", update)
		// After the editor's own handler (React's, at its root): a render before it would put back the text it held.
		document.addEventListener("input", update)
		document.addEventListener("focusin", update)
		document.addEventListener("keyup", update, true)

		return () => {
			document.removeEventListener("selectionchange", update)
			document.removeEventListener("input", update)
			document.removeEventListener("focusin", update)
			document.removeEventListener("keyup", update, true)
		}
	}, [])

	function placeCaret(editor: Editor | null, position: number): void {
		requestAnimationFrame(() => {
			const target = editor ?? focusedEditor()

			target?.focus({ preventScroll: true })
			target?.setSelectionRange(position, position)
			setCaret({ editor: target, caret: position })
		})
	}

	function accept(index: number): boolean {
		const entry = suggestions[index]

		if (entry === undefined || word === null) return false

		const next = acceptSuggestion(text, word, entry.name)

		model.setEditText(next.text)
		placeCaret(caret.editor, next.caret)

		return true
	}

	// The suggestion list's keys, before the editor's own: arrows choose, Tab takes, Escape closes the list.
	const open = suggestions.length > 0

	useEffect(() => {
		if (!open) return

		const keydown = (event: KeyboardEvent): void => {
			if (!(event.target instanceof Element) || event.target.closest("[data-sheet-editor]") === null || event.isComposing) return

			const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0

			if (step !== 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
				event.preventDefault()
				event.stopPropagation()
				setChoice(current => (current + step + suggestions.length) % suggestions.length)
			} else if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
				event.preventDefault()
				event.stopPropagation()
				accept(choice)
			} else if (event.key === "Escape" && word !== null) {
				event.preventDefault()
				event.stopPropagation()
				setDismissed(`${String(word.start)}:${word.text}`)
			}
		}

		document.addEventListener("keydown", keydown, true)

		return () => {
			document.removeEventListener("keydown", keydown, true)
		}
	})

	// Puts the reference to the cells from `anchor` to `focus` at `at` in the entry (over `base`, a reference pointed a
	// moment ago, when given) and keeps it as the pointed one.
	function putReference(
		anchor: GridPoint,
		focus: GridPoint,
		at: number,
		base: { start: number; end: number } | undefined,
		sheet: string | null,
		fallback: string
	): { text: string; caret: number } {
		const range = spanOf(anchor, focus)
		const single = range.startRow === range.endRow && range.startCol === range.endCol
		const reference = pointedReference(
			{
				kind: "cell",
				range: !single,
				...range,
				startRowAbs: false,
				startColAbs: false,
				endRowAbs: false,
				endColAbs: false
			},
			sheet
		)
		const current = model.getSnapshot().editing?.text ?? fallback
		const next = insertReference(current, at, reference, base)

		pointed.current = { start: next.span.start, end: next.span.end, text: next.text, anchor, focus }
		model.setEditText(next.text)

		return next
	}

	// Point mode from the keyboard (Excel's status bar "Point"): in a formula's entry, where a reference may go or over
	// the one pointed last, an arrow points at the next cell (from the edited one at first) and Shift+arrow widens the
	// reference to a range. Any other key, or a caret where no reference may go, is the grid's (an arrow commits).
	function editorKey(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
		const direction = ARROWS[event.key]

		if (direction === undefined || event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return false

		const snapshot = model.getSnapshot()
		const entry = snapshot.editing
		const layout = snapshot.layout
		const axes = model.axes(snapshot.sheet)

		if (entry?.mode !== "enter" || !entry.text.startsWith("=") || layout === null || axes === null) return false

		const input = event.currentTarget
		const at = input.selectionEnd
		const previous = pointed.current
		const replacing = previous !== null && previous.text === entry.text && at === previous.end ? previous : undefined

		if (input.selectionStart !== at) return false
		if (replacing === undefined && formulaContext(entry.text, at, locale.argument)?.points !== true) return false

		const shown = snapshot.sheet
		const from = replacing?.focus ?? (shown === entry.sheet ? { row: entry.row, col: entry.col } : snapshot.selection.active)
		const focus = stepFrom(from, direction, axes, layout, model.merges(layout)).active
		const anchor = event.shiftKey ? (replacing?.anchor ?? from) : focus
		const next = putReference(anchor, focus, at, replacing, shown === entry.sheet ? null : sheetName(shown), entry.text)

		// The caret goes after the reference now, as F4 puts it: a next arrow before the render still finds it there.
		event.preventDefault()
		input.value = next.text
		input.setSelectionRange(next.caret, next.caret)
		setCaret({ editor: input, caret: next.caret })
		gridRef.current?.reveal(focus)

		return true
	}

	// A click on a cell while a formula is typed where a reference may go puts the cell's; a drag widens it to a range.
	function pointer(event: SheetCellPointer): boolean | SheetCellDrag | undefined {
		if (event.kind !== "down" || !event.editing) return undefined

		const entry = model.getSnapshot().editing
		const editor = focusedEditor()

		if (!entry?.text.startsWith("=")) return undefined

		const at = editor?.selectionEnd ?? entry.text.length
		const previous = pointed.current
		// The reference pointed a moment ago, still as it was: moved, not added to.
		const replacing = previous !== null && previous.text === entry.text && at === previous.end ? previous : undefined

		if (replacing === undefined && formulaContext(entry.text, at, locale.argument)?.points !== true) return undefined

		const shown = model.getSnapshot().sheet
		const sheet = shown === entry.sheet ? null : sheetName(shown)
		const anchor = { row: event.row, col: event.col }
		const put = (focus: GridPoint, base: { start: number; end: number } | undefined): void => {
			const next = putReference(anchor, focus, base?.end ?? at, base, sheet, entry.text)

			placeCaret(editor, next.caret)
		}

		put(anchor, replacing)

		return {
			move(point) {
				const span = pointed.current ?? undefined

				put(point, span === undefined ? undefined : { start: span.start, end: span.end })
			},
			end() {
				// The pointed reference stays movable until something else is typed.
			}
		}
	}

	// Alt+= (Option+= or Cmd+Shift+T on a Mac): the sum the session proposes, opened to finish for one cell, written for a block.
	function autoSumAction(): void {
		const { sheet, selection } = model.getSnapshot()
		const range = selection.ranges[selection.ranges.length - 1]

		if (range === undefined || !canEdit) return

		void handle.session.query("autoSum", { sheet, range, active: { sheet, ...selection.active } }).then(
			proposal => {
				if (proposal.kind === "edit") {
					if (model.startEditing(proposal.entry, "edit")) placeCaret(null, proposal.entry.length - 1)

					return
				}

				const rows = Uint32Array.from(proposal.cells, cell => cell.row)
				const cols = Uint16Array.from(proposal.cells, cell => cell.col)

				run({ type: "cells.set", sheet, cells: { rows, cols, inputs: proposal.cells.map(cell => cell.entry) } })
			},
			() => undefined
		)
	}

	const references = editing === null ? [] : highlightedReferences(text, REFERENCE_COLORS)
	// One colouring for the formula bar and the in-cell editor, in the colours of the outlines; none without references.
	const colored = (shown: string, found: readonly HighlightedReference[]): ReactNode =>
		found.length === 0 ? null : (
			<ReferenceText
				text={shown}
				references={found}
				colors={colors}
			/>
		)
	const coloredText = colored(text, references)
	const layer =
		editing === null || references.length === 0
			? null
			: referenceLayer({ references, ownSheet: sheetName(editing.sheet), shownSheet: sheetName(grid.sheet), colors })

	return {
		id: "formula",
		locale,
		caret,
		coloredText,
		grid: {
			id: "formula",
			...(layer !== null && { layers: [layer] }),
			pointer,
			editorText: shown => (shown === text ? coloredText : colored(shown, highlightedReferences(shown, REFERENCE_COLORS)))
		},
		overlay:
			editing !== null && caret.editor !== null && (open || context?.call !== null) ? (
				<FormulaAssist
					editor={caret.editor}
					gridRef={gridRef}
					suggestions={suggestions}
					choice={Math.min(choice, Math.max(0, suggestions.length - 1))}
					call={context?.call ?? null}
					separator={locale.argument}
					onChoose={index => {
						accept(index)
					}}
				/>
			) : null,
		shortcut: (shortcut: SheetShortcut) => {
			if (shortcut !== "autoSum") return false

			autoSumAction()

			return true
		},
		autoSum: autoSumAction,
		editorKey
	}
}
