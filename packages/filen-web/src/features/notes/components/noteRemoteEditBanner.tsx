import { useTranslation } from "react-i18next"
import type { Note } from "@filen/sdk-rs"
import { useNoteRemoteEdited } from "@/features/notes/store/useNoteRemoteEdit"
import { reloadRemoteEdit, dismissRemoteEdit } from "@/features/notes/lib/socketHandlers"
import { Button } from "@/components/ui/button"

// The realtime reload-vs-keep prompt (mobile's note_edited alert, ported to a non-blocking inline
// banner). Shown only when this note is BOTH dirty and the server's content moved — the ContentEdited
// handler sets the flag; a clean note refetches silently instead. Reload discards the local edit and
// reseeds from the server; Keep dismisses and lets local win on the next push. The action bodies live
// in socketHandlers.ts (reloadRemoteEdit/dismissRemoteEdit) so they are node-testable.
export function NoteRemoteEditBanner({ note }: { note: Note }) {
	const { t } = useTranslation("notes")
	const show = useNoteRemoteEdited(note.uuid)

	if (!show) {
		return null
	}

	return (
		<div
			role="status"
			className="flex shrink-0 items-center gap-3 border-b border-border/50 bg-primary/10 px-5 py-2"
		>
			<div className="min-w-0 flex-1">
				<p className="text-sm font-medium">{t("noteRemoteEditTitle")}</p>
				<p className="truncate text-sm text-muted-foreground">{t("noteRemoteEditBody")}</p>
			</div>
			<Button
				variant="ghost"
				size="sm"
				onClick={() => {
					dismissRemoteEdit(note.uuid)
				}}
			>
				{t("noteRemoteEditKeep")}
			</Button>
			<Button
				variant="default"
				size="sm"
				onClick={() => {
					void reloadRemoteEdit(note)
				}}
			>
				{t("noteRemoteEditReload")}
			</Button>
		</div>
	)
}

export default NoteRemoteEditBanner
