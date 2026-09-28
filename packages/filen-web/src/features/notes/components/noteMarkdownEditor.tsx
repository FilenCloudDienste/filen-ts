import { startTransition, useEffect, useRef, useState } from "react"
import { IN_EDITORS, useAction } from "@/lib/keymap/useAction"
import { CodeMirrorSource } from "@/features/preview/components/codeMirrorSource"
import { MarkdownRenderer } from "@/features/preview/components/markdownRenderer"
import { MarkdownSplitPane } from "@/features/notes/components/markdownSplitPane"
import type { NoteEditorController } from "@/features/notes/hooks/useNoteEditor"
import type { Note } from "@filen/sdk-rs"

// A pause in typing before the preview catches up.
const PREVIEW_DEBOUNCE_MS = 200

// Writable md note editor: the SAME resizable split as the reader, editable on the left. The right
// pane renders from the LIVE EDITOR value (not the content query), so the preview follows the user's
// typing — `previewValue` seeds from the controller seed and advances once typing pauses, as a
// transition: react-markdown parses the whole document during render, and a note may be up to 1 MiB, so
// a parse per keystroke would stall typing. The CALLER keys this on controller.remountKey, so both the
// editor buffer and this previewValue re-seed together on a real reseed and never mid-edit (EDITOR
// INVARIANT).
//
// editor.togglePreview hides the preview pane, giving the editor the whole width, and brings it back;
// while hidden the preview is not updated at all, and catches up when shown.
export function NoteMarkdownEditor({ note, controller }: { note: Note; controller: NoteEditorController }) {
	const [previewValue, setPreviewValue] = useState(controller.seed)
	const [previewHidden, setPreviewHidden] = useState(false)
	const latestValueRef = useRef(controller.seed)
	const previewTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

	useEffect(() => {
		return () => {
			clearTimeout(previewTimerRef.current)
		}
	}, [])

	useAction(
		"editor.togglePreview",
		keyboardEvent => {
			keyboardEvent.preventDefault()
			clearTimeout(previewTimerRef.current)
			setPreviewValue(latestValueRef.current)
			setPreviewHidden(prev => !prev)
		},
		IN_EDITORS
	)

	function handleChange(value: string): void {
		latestValueRef.current = value
		controller.onChange(value)

		if (previewHidden) {
			return
		}

		clearTimeout(previewTimerRef.current)

		previewTimerRef.current = setTimeout(() => {
			startTransition(() => {
				setPreviewValue(latestValueRef.current)
			})
		}, PREVIEW_DEBOUNCE_MS)
	}

	return (
		<MarkdownSplitPane
			left={
				<CodeMirrorSource
					text={controller.seed}
					tag="markdown"
					alt={note.title ?? ""}
					editable
					onValueChange={handleChange}
				/>
			}
			right={
				<MarkdownRenderer
					text={previewValue}
					alt={note.title ?? ""}
				/>
			}
			rightHidden={previewHidden}
		/>
	)
}
