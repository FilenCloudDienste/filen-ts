import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { PinIcon, HeartIcon, MoreHorizontalIcon } from "lucide-react"
import type { Note, NoteTag } from "@filen/sdk-rs"
import { cn } from "@/lib/utils"
import { noteIcon } from "@/features/notes/lib/icon.logic"
import { NoteContextMenuContent, NoteDropdownMenuContent } from "@/features/notes/components/noteMenu"
import { type NoteActionDialogKind } from "@/features/notes/components/noteMenu.logic"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"

export interface NoteRowProps {
	note: Note
	selected: boolean
	// Rendered indented under a tag group in the tags view; flat (no indent) in the notes view.
	nested?: boolean
	allTags: readonly NoteTag[]
	currentUserId: bigint | undefined
	// Threaded straight through to the row's own menu (noteMenu.tsx's onAction/onDuplicated) — the
	// sidebar's ONE dialog host (useNoteDialogHost) is the actual dialog-opening implementation, not
	// this row.
	onAction: (kind: NoteActionDialogKind, note: Note) => void
	onDuplicated: (duplicated: Note) => void
}

// One note row, shared by both sidebar views (the notes list and a tag group's expanded members). The
// whole row is a Link to /notes/$uuid — the uuid is a selection key, not a path hierarchy (D4). Pinned/
// favorited stay subtle muted marks (spec) rather than loud badges. Carries its own row-level context
// menu (right-click) and ⋯ trigger (hover-revealed), both rendering the SAME shared descriptor list
// (noteMenu.logic.ts) the editor header's own menu uses.
export function NoteRow({ note, selected, nested = false, allTags, currentUserId, onAction, onDuplicated }: NoteRowProps) {
	const { t } = useTranslation("notes")
	const { icon: Icon, colorClass } = noteIcon(note)
	const title = note.title !== undefined && note.title.length > 0 ? note.title : t("noteUntitled")
	// Preview snippet: the SDK's own short summary, falling back to the title so the second line is never
	// blank for a note whose content preview is empty.
	const preview = note.preview !== undefined && note.preview.length > 0 ? note.preview : title

	return (
		<ContextMenu>
			{/* render-prop merge onto the Link itself (mirrors driveRow.tsx's own idiom, div there) — Base
			UI's ContextMenuTrigger merges its onContextMenu handler + ref onto the given element rather than
			wrapping it, so the row stays a single real <a>, not an extra nested interactive element. */}
			<ContextMenuTrigger
				render={
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
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label={t("noteItemMenuTrigger")}
										className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
										onClick={event => {
											// Must not navigate the row's own Link — see noteMenu.tsx's own item onClick
											// for the matching portaled-popup rationale.
											event.preventDefault()
											event.stopPropagation()
										}}
									>
										<MoreHorizontalIcon />
									</Button>
								}
							/>
							<NoteDropdownMenuContent
								note={note}
								allTags={allTags}
								currentUserId={currentUserId}
								onAction={onAction}
								onDuplicated={onDuplicated}
							/>
						</DropdownMenu>
					</Link>
				}
			/>
			<NoteContextMenuContent
				note={note}
				allTags={allTags}
				currentUserId={currentUserId}
				onAction={onAction}
				onDuplicated={onDuplicated}
			/>
		</ContextMenu>
	)
}
