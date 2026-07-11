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

// One note row, shared by both sidebar views (the notes list and a tag group's expanded members). Most
// of the row is a Link to /notes/$uuid — the uuid is a selection key, not a path hierarchy (D4) — with
// the ⋯ trigger button as its sibling, not its descendant (see the ContextMenuTrigger comment below).
// Pinned/favorited stay subtle muted marks (spec) rather than loud badges. Carries its own row-level
// context menu (right-click) and ⋯ trigger (hover-revealed), both rendering the SAME shared descriptor
// list (noteMenu.logic.ts) the editor header's own menu uses.
export function NoteRow({ note, selected, nested = false, allTags, currentUserId, onAction, onDuplicated }: NoteRowProps) {
	const { t } = useTranslation("notes")
	const { icon: Icon, colorClass } = noteIcon(note)
	const title = note.title !== undefined && note.title.length > 0 ? note.title : t("noteUntitled")
	// Preview snippet: the SDK's own short summary, falling back to the title so the second line is never
	// blank for a note whose content preview is empty.
	const preview = note.preview !== undefined && note.preview.length > 0 ? note.preview : title

	return (
		<ContextMenu>
			{/* render-prop merge onto the row's own div (mirrors driveRow.tsx's own idiom) — Base UI's
			ContextMenuTrigger merges its onContextMenu handler + ref onto the given element rather than
			wrapping it. The Link stays a SIBLING of the ⋯ trigger button, not an ancestor: a <button> nested
			inside an <a> is invalid content model and an accessibility regression (drive's own row solved
			the identical shape by never using a real anchor at all — see driveRow.tsx). */}
			<ContextMenuTrigger
				render={
					<div
						className={cn(
							"group flex h-full w-full items-center gap-2.5 rounded-xl px-2.5 transition-colors app-region-no-drag",
							nested && "pl-8",
							selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60"
						)}
					>
						<Link
							to="/notes/$uuid"
							params={{ uuid: note.uuid }}
							aria-current={selected ? "page" : undefined}
							className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-lg text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
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
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label={t("noteItemMenuTrigger")}
										className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
										onClick={event => {
											// The button is a sibling of the Link now, not a descendant, so a click here
											// can never bubble into a navigation — this only stops it reaching the row
											// div's own onContextMenu, mirroring driveRow.tsx's matching trigger.
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
					</div>
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
