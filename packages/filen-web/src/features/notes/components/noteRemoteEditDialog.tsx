import { lazy, Suspense, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { Note } from "@filen/sdk-rs"
import { conflictCopyStamp } from "@filen/shared"
import { useNoteRemoteEdit } from "@/features/notes/store/useNoteRemoteEdit"
import { keepMineOverRemoteEdit, reloadRemoteEdit, saveRemoteEditMineAsCopy } from "@/features/notes/lib/socketHandlers"
import { localNoteContent } from "@/features/notes/lib/localContent"
import { holdNoteForRemoteEdit, releaseNoteHold } from "@/features/notes/lib/remoteEditHolds"
import { codeMirrorTagForNote } from "@/features/notes/components/reader/reader.logic"
import { RemoteChangeDialog } from "@/features/preview/components/remoteChangeDialog"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { LoadingState } from "@/components/loadingState"

// @codemirror/merge, for the comparison only.
const RemoteCompare = lazy(async () => ({ default: (await import("@/features/preview/components/remoteCompare")).RemoteCompare }))

// Asks what happens to the edits in this note when a newer version of it was saved elsewhere, with the
// file editors' dialog. Their content came with the socket event, so the comparison needs no download;
// it is offered for the plain-text types a line diff can show.
export function NoteRemoteEditDialog({ note }: { note: Note }) {
	const { t } = useTranslation("notes")
	const edit = useNoteRemoteEdit(note.uuid)
	const [pending, setPending] = useState(false)
	const shown = edit !== undefined

	// The note's pushes wait while the question is on screen; a note left unanswered sends its edits again
	// (the push's own overwrite check still reports burying their version), and asks again when reopened.
	useEffect(() => {
		if (!shown) {
			return undefined
		}

		holdNoteForRemoteEdit(note.uuid)

		return () => {
			releaseNoteHold(note.uuid)
		}
	}, [shown, note.uuid])

	if (edit === undefined) {
		return null
	}

	const theirs = edit.theirs
	const comparable = theirs !== undefined && (note.noteType === "text" || note.noteType === "md" || note.noteType === "code")

	async function handleSaveMineAsCopy(): Promise<void> {
		const title = t("noteRemoteEditCopyTitle", {
			title: note.title !== undefined && note.title.length > 0 ? note.title : t("noteUntitled"),
			date: conflictCopyStamp(new Date())
		})

		setPending(true)

		const outcome = await saveRemoteEditMineAsCopy(note, title)

		setPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))

			return
		}

		toast.success(t("noteRemoteEditSavedAsCopy", { title }))
	}

	return (
		<RemoteChangeDialog
			kind="revised"
			title={t("noteRemoteEditTitle")}
			body={t("noteRemoteEditBody")}
			renderCompare={
				comparable
					? mine => (
							<Suspense fallback={<LoadingState size="lg" />}>
								<RemoteCompare
									theirs={{ status: "ready", text: theirs }}
									mine={mine}
									tag={codeMirrorTagForNote(note)}
								/>
							</Suspense>
						)
					: undefined
			}
			readMine={() => localNoteContent(note.uuid)}
			pending={pending}
			onKeepMine={() => {
				void keepMineOverRemoteEdit(note)
			}}
			onLoadTheirs={() => {
				void reloadRemoteEdit(note)
			}}
			onSaveMineAsNew={() => {
				void handleSaveMineAsCopy()
			}}
		/>
	)
}

export default NoteRemoteEditDialog
