import { useState } from "react"
import { CodeMirrorSource } from "@/features/preview/components/codeMirrorSource"
import { MarkdownRenderer } from "@/features/preview/components/markdownRenderer"
import { MarkdownSplitPane } from "@/features/notes/components/markdownSplitPane"
import type { NoteEditorController } from "@/features/notes/hooks/useNoteEditor"
import type { Note } from "@filen/sdk-rs"

// Writable md note editor: the SAME resizable split as the reader, editable on the left. The right
// pane renders from the LIVE EDITOR value (not the content query), so the preview updates as the user
// types — `previewValue` seeds from the controller seed and advances on every change alongside the
// outbox enqueue. The CALLER keys this on controller.remountKey, so both the editor buffer and this
// previewValue re-seed together on a real reseed and never mid-edit (EDITOR INVARIANT).
export function NoteMarkdownEditor({ note, controller }: { note: Note; controller: NoteEditorController }) {
	const [previewValue, setPreviewValue] = useState(controller.seed)

	function handleChange(value: string): void {
		setPreviewValue(value)
		controller.onChange(value)
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
		/>
	)
}
