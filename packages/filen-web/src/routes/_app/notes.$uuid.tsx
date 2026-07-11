import { createFileRoute } from "@tanstack/react-router"
import { useNotes } from "@/features/notes/queries/notes"
import { NoteEditorPane } from "@/features/notes/components/noteEditorPane"

// The selected-note route. `uuid` is a selection key, not a path hierarchy — the note is resolved
// from the one global notes list cache, never a per-uuid fetch, so switching notes reuses already-loaded
// metadata. A uuid that isn't in the list (stale link) resolves to undefined → the pane's select prompt.
// Auth-guarded by the _app layout.
export const Route = createFileRoute("/_app/notes/$uuid")({ component: NoteDetailPage })

function NoteDetailPage() {
	const { uuid } = Route.useParams()
	const notesQuery = useNotes()
	const note = notesQuery.data?.find(n => n.uuid === uuid)

	return (
		<NoteEditorPane
			note={note}
			loading={notesQuery.isPending}
		/>
	)
}
