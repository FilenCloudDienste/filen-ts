// An editor's side of the selection transform, implemented beside each editor (CodeMirror, Quill, a text field, the
// Word document editor). The transform UI reads the selection through it and applies the result through it, as one
// step of the editor's own undo. Also what reads the selection for the assistant's document context.

// What a replacement left for the UI to offer: `undo` where the editor's own undo cannot take it back (a text
// field whose browser refused execCommand), null where it can.
export interface TransformApplied {
	readonly undo: (() => boolean) | null
}

// The selection as it was taken. It keeps its own range, so moving the caret meanwhile changes nothing; an edit of
// the text does.
export interface TransformSelection {
	readonly text: string
	// False once the text was edited since (or the editor is gone): the result no longer fits where it would go.
	current(): boolean
	// Replaces the selection, the replacement left selected and the editor focused. Null when not current or the
	// editor refused it.
	replace(text: string): TransformApplied | null
	// Where the selection is on screen (client px), for the result's popover; null when it cannot tell.
	rect(): DOMRect | null
}

export interface TransformHost {
	// The selection now. Null when nothing is selected (or the editor cannot be edited); "unsupported" for one the
	// editor cannot replace as plain text (a table, a field, several checklist items).
	selection(): TransformSelection | "unsupported" | null
	// Where the selection ends on screen while there is one, for the button beside it: cheap, read on selection
	// changes, never copies the text.
	selectionRect(): DOMRect | null
	// Focus back in the editor, its selection as it was (after the menu or popover closes without applying).
	focus(): void
}

export type TextField = HTMLTextAreaElement | HTMLInputElement

// Sets the field's value where the browser cannot (its state is the app's), with that selection.
export type TextFieldWrite = (value: string, selection: { start: number; end: number }) => void

// Document.execCommand: deprecated, yet still the only way into a text field's own undo, and every current engine
// runs it. Reached through this interface so that one place states it; an engine that drops it gets the fallback.
interface EditingCommands {
	execCommand(commandId: string, showUi: boolean, value: string): boolean
}

function insertIntoField(text: string): boolean {
	const commands: EditingCommands = document

	return commands.execCommand(text.length === 0 ? "delete" : "insertText", false, text)
}

// A plain text field (the chat composer, a checklist item): the browser's own insertText, so its undo takes the
// replacement back in one step and the field's input event reaches the app's state as typing would. A browser that
// refuses it gets the attached `write`, the app setting the value itself, and a one-level undo. The field and its
// write are attached after each commit (or as a field takes focus), so the host never reads them during a render.
export function textFieldTransform(): { host: TransformHost; attach: (field: TextField | null, write: TextFieldWrite) => void } {
	let field: TextField | null = null
	let write: TextFieldWrite = () => undefined
	const attached = () => (field?.isConnected === true ? field : null)

	const host: TransformHost = {
		selection: () => {
			const element = attached()

			if (element === null || element.readOnly || element.disabled) {
				return null
			}

			const start = element.selectionStart ?? 0
			const end = element.selectionEnd ?? start

			if (start === end) {
				return null
			}

			const value = element.value
			const current = () => element.isConnected && element.value === value

			return {
				text: value.slice(start, end),
				current,
				replace: (text: string) => {
					if (!current()) {
						return null
					}

					element.focus()
					element.setSelectionRange(start, end)

					if (insertIntoField(text) && element.value !== value) {
						element.setSelectionRange(start, start + text.length)

						return { undo: null }
					}

					const next = value.slice(0, start) + text + value.slice(end)

					write(next, { start, end: start + text.length })

					return {
						undo: () => {
							if (!element.isConnected || element.value !== next) {
								return false
							}

							write(value, { start, end })

							return true
						}
					}
				},
				rect: () => (element.isConnected ? element.getBoundingClientRect() : null)
			}
		},
		selectionRect: () => {
			const element = attached()

			return element !== null && element.selectionStart !== element.selectionEnd ? element.getBoundingClientRect() : null
		},
		focus: () => {
			attached()?.focus()
		}
	}

	return {
		host,
		attach: (next, nextWrite) => {
			field = next
			write = nextWrite
		}
	}
}
