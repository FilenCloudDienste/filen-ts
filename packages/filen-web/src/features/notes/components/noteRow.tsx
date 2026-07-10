import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { PinIcon, HeartIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { noteIcon } from "@/features/notes/lib/icon.logic"
import type { Note } from "@filen/sdk-rs"

export interface NoteRowProps {
	note: Note
	selected: boolean
	// Rendered indented under a tag group in the tags view; flat (no indent) in the notes view.
	nested?: boolean
}

// One note row, shared by both sidebar views (the notes list and a tag group's expanded members). The
// whole row is a Link to /notes/$uuid — the uuid is a selection key, not a path hierarchy (D4). Pinned/
// favorited stay subtle muted marks (spec) rather than loud badges.
export function NoteRow({ note, selected, nested = false }: NoteRowProps) {
	const { t } = useTranslation("notes")
	const { icon: Icon, colorClass } = noteIcon(note)
	const title = note.title !== undefined && note.title.length > 0 ? note.title : t("noteUntitled")
	// Preview snippet: the SDK's own short summary, falling back to the title so the second line is never
	// blank for a note whose content preview is empty.
	const preview = note.preview !== undefined && note.preview.length > 0 ? note.preview : title

	return (
		<Link
			to="/notes/$uuid"
			params={{ uuid: note.uuid }}
			aria-current={selected ? "page" : undefined}
			className={cn(
				"group flex h-full w-full items-center gap-2.5 rounded-xl px-2.5 text-left transition-colors outline-none app-region-no-drag focus-visible:ring-3 focus-visible:ring-ring/30",
				nested && "pl-8",
				selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60"
			)}
		>
			<Icon className={cn("size-4 shrink-0", colorClass)} />
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="flex min-w-0 items-center gap-1.5">
					{note.pinned ? (
						<PinIcon
							aria-label={t("notePinned")}
							className="size-3 shrink-0 text-muted-foreground"
						/>
					) : null}
					{note.favorite ? (
						<HeartIcon
							aria-label={t("noteFavorite")}
							className="size-3 shrink-0 text-muted-foreground"
						/>
					) : null}
					<span className="truncate text-sm font-medium">{title}</span>
				</div>
				<span className="truncate text-xs text-muted-foreground">{preview}</span>
			</div>
		</Link>
	)
}
