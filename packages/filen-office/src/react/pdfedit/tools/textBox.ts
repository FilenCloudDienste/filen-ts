import type { PdfPoint, PdfRect } from "../../../core/pdfedit/annotations"
import type { RectSize } from "./placement"
import { RECT_TOOL_IDLE, rectToolKey, rectToolPointer, type RectToolState } from "./rectTools"
import type { ToolKey, ToolPage, ToolPointer, ToolStep } from "./types"

// The text box tool: place a box (drag, click or keyboard), then type into the overlay editor the host shows over it.
// Done (or a press outside the box) commits the text; Escape, or no text, drops it. Editing an existing box is the
// same editing state with its ref (the engine hides that annotation while the editor stands in for it).

export const TEXT_BOX_SIZE: RectSize = { width: 200, height: 40 }

export interface TextBoxEditing {
	readonly page: number
	readonly rect: PdfRect
	readonly text: string
	// The box being edited; absent for a new one.
	readonly id?: number
}

export interface TextBoxState extends RectToolState {
	readonly editing: TextBoxEditing | null
}

export interface TextBoxCommit {
	readonly page: number
	readonly rect: PdfRect
	readonly text: string
	readonly id?: number
}

export const TEXT_BOX_IDLE: TextBoxState = { ...RECT_TOOL_IDLE, editing: null }

function inside(rect: PdfRect, point: PdfPoint): boolean {
	return point[0] >= rect[0] && point[0] <= rect[2] && point[1] >= rect[1] && point[1] <= rect[3]
}

// Ends the edit: its text committed when there is any (an existing box also when emptied: the host deletes it), or
// dropped.
export function textBoxFinish(state: TextBoxState): ToolStep<TextBoxState, TextBoxCommit> {
	const editing = state.editing

	if (editing === null) return { state }

	const keep = editing.text.trim() !== "" || editing.id !== undefined

	return {
		state: TEXT_BOX_IDLE,
		...(keep
			? {
					commit: {
						page: editing.page,
						rect: editing.rect,
						text: editing.text,
						...(editing.id === undefined ? {} : { id: editing.id })
					}
				}
			: {})
	}
}

export function textBoxInput(state: TextBoxState, text: string): TextBoxState {
	return state.editing === null ? state : { ...state, editing: { ...state.editing, text } }
}

// Starts editing an existing box (a double click on it with the select tool).
export function textBoxEdit(page: number, id: number, rect: PdfRect, text: string): TextBoxState {
	return { ...TEXT_BOX_IDLE, editing: { page, rect, text, id } }
}

export function textBoxPointer(state: TextBoxState, event: ToolPointer): ToolStep<TextBoxState, TextBoxCommit> {
	if (state.editing !== null) {
		// A press inside belongs to the editor; one outside finishes the edit.
		return event.type === "down" && (event.page !== state.editing.page || !inside(state.editing.rect, event.point))
			? textBoxFinish(state)
			: { state }
	}

	const step = rectToolPointer(state, event, TEXT_BOX_SIZE)

	return {
		state: { ...step.state, editing: step.commit === undefined ? null : { page: step.commit.page, rect: step.commit.rect, text: "" } }
	}
}

export function textBoxKey(state: TextBoxState, key: ToolKey, target: ToolPage, at?: PdfPoint): ToolStep<TextBoxState, TextBoxCommit> {
	if (state.editing !== null) return key.key === "Escape" ? { state: TEXT_BOX_IDLE } : { state }

	const step = rectToolKey(state, key, target, TEXT_BOX_SIZE, at)

	return {
		state: { ...step.state, editing: step.commit === undefined ? null : { page: step.commit.page, rect: step.commit.rect, text: "" } }
	}
}
