import { useState } from "react"
import type { DocxEditorCommandType } from "@filen/office/core/docx/edit"
import type { DocxOpenView } from "@/features/office/lib/officeViewSettings"

// Mobile view shows by itself in an editor area narrower than this (px), as Word's mobile apps reflow a
// document on a phone.
export const REFLOW_MAX_WIDTH = 600

// Commands that edit a story Mobile view does not show (headers and footers, as in Word's mobile view): not
// offered while it shows the document.
export const REFLOW_REFUSED: ReadonlySet<DocxEditorCommandType> = new Set(["header.edit", "footer.edit"])

// `commands` as Mobile view offers them (all of them on the pages).
export function reflowCommands<T extends { readonly info: { readonly type: DocxEditorCommandType } }>(
	commands: readonly T[],
	reflow: boolean
): readonly T[] {
	return reflow ? commands.filter(command => !REFLOW_REFUSED.has(command.info.type)) : commands
}

export interface DocxReflowMode {
	// The document is shown reflowed (Mobile view) instead of as pages.
	reflow: boolean
	// The user's choice, which holds for the open document.
	setReflow: (reflow: boolean) => void
}

export interface ReflowState {
	readonly reflow: boolean
	// The user chose (the width no longer decides).
	readonly chosen: boolean
	// Whether the editor area was narrow when last measured (null: not measured yet).
	readonly narrow: boolean | null
}

export const INITIAL_REFLOW: ReflowState = { reflow: false, chosen: false, narrow: null }

// The state a document opens in: the width decides ("auto"), or the device's setting already chose.
export function initialReflow(view: DocxOpenView): ReflowState {
	return view === "auto" ? INITIAL_REFLOW : { reflow: view === "reflow", chosen: true, narrow: null }
}

// The state once the editor area is `width` px wide: Mobile view follows the width only when it crosses
// REFLOW_MAX_WIDTH (the first measure counts as one), and never once the user chose.
export function reflowForWidth(state: ReflowState, width: number): ReflowState {
	if (width <= 0) {
		return state
	}

	const narrow = width < REFLOW_MAX_WIDTH

	if (narrow === state.narrow) {
		return state
	}

	return { reflow: state.chosen ? state.reflow : narrow, chosen: state.chosen, narrow }
}

// The user's choice: it wins for the rest of the open document.
export function reflowChosen(state: ReflowState, reflow: boolean): ReflowState {
	return state.chosen && state.reflow === reflow ? state : { reflow, chosen: true, narrow: state.narrow }
}

// Whether the editor shows Mobile view, for an editor box `width` px wide (0 until measured), opened as `view`
// says (Settings, Office: "Open documents in").
export function useReflowMode(width: number, view: DocxOpenView): DocxReflowMode {
	const [state, setState] = useState<ReflowState>(() => initialReflow(view))
	const next = reflowForWidth(state, width)

	// A width crossing applies during render (no frame of the other view in between).
	if (next !== state) {
		setState(next)
	}

	const [setReflow] = useState(() => (reflow: boolean): void => {
		setState(previous => reflowChosen(previous, reflow))
	})

	return { reflow: next.reflow, setReflow }
}
