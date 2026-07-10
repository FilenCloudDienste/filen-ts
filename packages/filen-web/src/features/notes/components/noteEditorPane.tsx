import { useTranslation } from "react-i18next"
import { StickyNoteIcon } from "lucide-react"
import { noteIcon } from "@/features/notes/lib/icon.logic"
import { Spinner } from "@/components/ui/spinner"
import { Separator } from "@/components/ui/separator"
import type { Note } from "@filen/sdk-rs"

export interface NoteEditorPaneProps {
	// The resolved selected note, or undefined when nothing is selected / not yet resolved.
	note?: Note | undefined
	// True while the note list (which the selected note is resolved from) is still loading.
	loading?: boolean | undefined
}

// The main content card for the notes module — deliberately thin this step: a titled header for the
// selected note plus centered muted states. The read-only renderers and the live editors land in the
// next steps; here the card only needs to read as present and not ugly.
export function NoteEditorPane({ note, loading = false }: NoteEditorPaneProps) {
	const { t } = useTranslation("notes")

	if (note === undefined) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
				<StickyNoteIcon className="size-8 text-muted-foreground/60" />
				<div className="flex flex-col gap-1">
					<p className="font-heading text-lg font-medium tracking-tight">
						{loading ? t("notesLoadingNote") : t("notesSelectPrompt")}
					</p>
					{!loading ? <p className="text-sm text-muted-foreground">{t("notesSelectPromptDescription")}</p> : null}
				</div>
			</div>
		)
	}

	const { icon: Icon, colorClass } = noteIcon(note)
	const title = note.title !== undefined && note.title.length > 0 ? note.title : t("noteUntitled")

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex shrink-0 items-center gap-2.5 px-5 py-4">
				<Icon className={`size-5 shrink-0 ${colorClass}`} />
				<h1 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h1>
			</header>
			<Separator className="bg-border/50" />
			<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
				<Spinner className="size-5" />
				<p className="text-sm">{t("notesLoadingNote")}</p>
			</div>
		</div>
	)
}
