import { useEffect } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useNotes } from "@/features/notes/queries/notes"
import { sortNotes } from "@/features/notes/lib/sort"
import { NoteEditorPane } from "@/features/notes/components/noteEditorPane"

// The bare /notes index. Like old-web (oldweb-notes §1) the uuid is a pure selection key, so the index
// redirects to the first note in the same sorted order the sidebar shows — the sidebar stays mounted
// across the redirect (it lives in the app shell). Zero notes falls through to the select/empty prompt.
export const Route = createFileRoute("/_app/notes/")({ component: NotesIndexPage })

function NotesIndexPage() {
	const navigate = useNavigate()
	const notesQuery = useNotes()
	const notes = notesQuery.data
	const firstUuid = notes !== undefined && notes.length > 0 ? sortNotes(notes)[0]?.uuid : undefined

	useEffect(() => {
		if (firstUuid !== undefined) {
			void navigate({ to: "/notes/$uuid", params: { uuid: firstUuid }, replace: true })
		}
	}, [firstUuid, navigate])

	return <NoteEditorPane loading={notesQuery.isPending} />
}
