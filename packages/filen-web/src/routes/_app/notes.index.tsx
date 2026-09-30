import { useEffect } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useNotes } from "@/features/notes/queries/notes"
import { notesIndexRedirectTarget } from "@/features/notes/lib/indexRedirect.logic"
import { readLastOpened, useLastOpened } from "@/features/shell/lib/lastOpened"
import { NoteEditorPane } from "@/features/notes/components/noteEditorPane"

// The bare /notes index. Like old-web, the uuid is a pure selection key, so the index redirects — to the
// last opened note while it still exists, else to the first note in the order the sidebar shows. The
// sidebar stays mounted across the redirect (it lives in the app shell); zero notes falls through to the
// select/empty prompt. The loader warms the stored value so the decision needs no extra render.
export const Route = createFileRoute("/_app/notes/")({
	loader: async () => {
		await readLastOpened("notes")
	},
	component: NotesIndexPage
})

function NotesIndexPage() {
	const navigate = useNavigate()
	const storedUuid = useLastOpened("notes")
	const notesQuery = useNotes()
	const target = notesIndexRedirectTarget({ storedUuid, notes: notesQuery.data, pending: notesQuery.isPending })

	useEffect(() => {
		if (typeof target === "string") {
			void navigate({ to: "/notes/$uuid", params: { uuid: target }, replace: true })
		}
	}, [target, navigate])

	return <NoteEditorPane loading={target !== null} />
}
