import { CodeMirrorSource } from "@/features/preview/components/codeMirrorSource"
import { useCodeMirrorTransformHost } from "@/features/preview/lib/codeMirrorTransformHost"
import { SelectionTransformRoot } from "@/features/assistant/transform/selectionTransform"
import { codeMirrorTagForNote } from "@/features/notes/components/reader/reader.logic"
import type { NoteEditorController } from "@/features/notes/hooks/useNoteEditor"
import type { Note } from "@filen/sdk-rs"

// Writable text/code note editor: the shared CodeMirror surface in editable mode, wired to the outbox
// via the controller's per-keystroke onChange. Language follows the note title's extension for a code
// note (unhighlighted for plain text), same map file preview uses. The CALLER keys this on
// controller.remountKey so `seed` freezes at mount and only a real reseed remounts it (EDITOR INVARIANT).
// The assistant's selection transform edits through the view; its edits reach the outbox as typing does.
export function NoteTextCodeEditor({ note, controller }: { note: Note; controller: NoteEditorController }) {
	const { host, onView } = useCodeMirrorTransformHost()

	return (
		<SelectionTransformRoot
			host={host}
			className="contents"
		>
			<CodeMirrorSource
				text={controller.seed}
				tag={codeMirrorTagForNote(note)}
				alt={note.title ?? ""}
				editable
				onValueChange={controller.onChange}
				onView={onView}
			/>
		</SelectionTransformRoot>
	)
}
