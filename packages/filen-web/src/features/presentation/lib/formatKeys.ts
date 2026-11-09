import { formatPainterOf, type FormatPainterHost } from "@filen/office/react/presentation"
import { painterTargets } from "@/features/presentation/components/ribbon/home"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { presentationEditorKey } from "@/features/presentation/lib/keymap/editor"

type FormatKeyEvent = Parameters<typeof presentationEditorKey>[0] & {
	readonly target: EventTarget | null
	readonly defaultPrevented: boolean
	preventDefault(): void
}

// Copy Formatting and Paste Formatting (PowerPoint's Ctrl+Shift+C and Ctrl+Shift+V) pressed on the slide or in a body
// being edited there; true when the key was taken. Elsewhere (the notes, the rail, a field) the key stays the browser's,
// and so does a paste with nothing copied or nothing to take it.
export function onFormatKey(
	event: FormatKeyEvent,
	editor: PresentationRibbonEditor | undefined,
	editable: boolean,
	overrides: Readonly<Record<string, string>>,
	mac?: boolean
): boolean {
	const text = editor?.text

	if (event.defaultPrevented || editor === undefined || text === undefined || !editable) return false

	const action = presentationEditorKey(event, overrides, mac)

	if (action !== "presentation.copyFormat" && action !== "presentation.pasteFormat") return false
	if (!(event.target instanceof Element) || event.target.closest("[data-fo-slide-canvas]") === null) return false

	// A field on the slide other than the body (a prompt's input) keeps its own paste as plain text.
	const field = event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")

	if (field !== null && field.closest("[data-fo-text-editor]") === null) return false

	const host: FormatPainterHost = { session: editor.session, text, targets: painterTargets(editor), command: op => editor.command(op) }
	const painter = formatPainterOf(text)

	if (action === "presentation.pasteFormat") {
		if (!painter.pasteFormat(host)) return false

		event.preventDefault()

		return true
	}

	if (text.active === undefined && host.targets().shapes.length === 0) return false

	event.preventDefault()
	void painter.copyFormat(host)

	return true
}
