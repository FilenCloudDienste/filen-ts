import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { StickyNoteIcon, MoreHorizontalIcon } from "lucide-react"
import type { Note } from "@filen/sdk-rs"
import { noteIcon } from "@/features/notes/lib/icon.logic"
import { NoteReader } from "@/features/notes/components/reader/noteReader"
import { NoteDropdownMenuContent } from "@/features/notes/components/noteMenu"
import { useNoteDialogHost } from "@/features/notes/hooks/useNoteDialogHost"
import { useNoteTags } from "@/features/notes/queries/noteTags"
import { useAccountQuery } from "@/queries/account"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

export interface NoteEditorPaneProps {
	// The resolved selected note, or undefined when nothing is selected / not yet resolved.
	note?: Note | undefined
	// True while the note list (which the selected note is resolved from) is still loading.
	loading?: boolean | undefined
}

// The main content card for the notes module: a titled header for the selected note (icon + title +
// the ⋮ menu, sharing noteMenu.logic.ts's descriptor list with the sidebar row's own menu) plus the
// per-type read-only body (NoteReader). Live editing arrives with the sync outbox — this step never
// writes note CONTENT, only metadata actions (rename/pin/favorite/tags/type/lifecycle).
export function NoteEditorPane({ note, loading = false }: NoteEditorPaneProps) {
	const { t } = useTranslation("notes")
	const navigate = useNavigate()
	const tagsQuery = useNoteTags()
	const accountQuery = useAccountQuery()
	// This host's own dialogs act on `note` alone, and `note` IS the currently-routed note by
	// construction (notes.$uuid.tsx resolves it from the route param) — so a delete/leave confirmed here
	// always navigates away, unlike the sidebar's host which also serves rows for OTHER notes.
	const dialogHost = useNoteDialogHost({ currentUuid: note?.uuid ?? "" })

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

	async function handleDuplicated(duplicated: Note): Promise<void> {
		await navigate({ to: "/notes/$uuid", params: { uuid: duplicated.uuid } })
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex shrink-0 items-center gap-2.5 px-5 py-4">
				<Icon className={`size-5 shrink-0 ${colorClass}`} />
				<h1 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h1>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("noteItemMenuTrigger")}
							>
								<MoreHorizontalIcon />
							</Button>
						}
					/>
					<NoteDropdownMenuContent
						note={note}
						allTags={tagsQuery.data ?? []}
						currentUserId={accountQuery.data?.id}
						onAction={dialogHost.openNoteDialog}
						onDuplicated={duplicated => {
							void handleDuplicated(duplicated)
						}}
					/>
				</DropdownMenu>
			</header>
			<Separator className="bg-border/50" />
			{/* Keyed by uuid so switching the selected note remounts the reader fresh — required by the
			EDITOR INVARIANT the CodeMirror-backed readers rely on (noteReader.tsx). */}
			<NoteReader
				key={note.uuid}
				note={note}
			/>
			{dialogHost.renderActiveDialog()}
		</div>
	)
}
