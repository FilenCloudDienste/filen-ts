import { type MouseEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { PinIcon, HeartIcon } from "lucide-react"
import type { Note, NoteTag } from "@filen/sdk-rs"
import { cn, contactDisplayName } from "@filen/shared"
import { formatRelativeTime } from "@/lib/relativeTime"
import { useNowMinute } from "@/lib/useNowMinute"
import { noteIcon } from "@/features/notes/lib/icon.logic"
import { noteDisplayTitle } from "@/features/notes/lib/displayTitle"
import { selectionAwareLinkClick } from "@/features/drive/lib/listbox"
import { noteRowPreview, noteRowSharedByEmail, noteRowTags, noteRowParticipants } from "@/features/notes/lib/noteRow.logic"
import { safeAvatarUrl } from "@/lib/avatarUrl"
import { NoteContextMenuContent, NoteDropdownMenuContent } from "@/features/notes/components/noteMenu"
import { type NoteActionDialogKind } from "@/features/notes/components/noteMenu.logic"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu } from "@/components/ui/dropdown-menu"
import { RowMenuTrigger } from "@/components/rowMenuTrigger"
import { UserAvatar } from "@/components/userAvatar"

export interface NoteRowProps {
	note: Note
	selected: boolean
	// True iff this note is part of the active multi-selection — a distinct visual state from
	// `selected` above (the currently ROUTED note), since a multi-selection and the open note are
	// independent: clicking a different note while others stay Ctrl-selected opens it without
	// touching the selection.
	multiSelected: boolean
	// Rendered indented under a tag group in the tags view; flat (no indent) in the notes view.
	nested?: boolean
	allTags: readonly NoteTag[]
	currentUserId: bigint | undefined
	// Threaded straight through to the row's own menu (noteMenu.tsx's onAction/onDuplicated) — the
	// sidebar's ONE dialog host (useNoteDialogHost) is the actual dialog-opening implementation, not
	// this row.
	onAction: (kind: NoteActionDialogKind, note: Note) => void
	onDuplicated: (duplicated: Note) => void
	// Modifier-click selection — mirrors driveRow.tsx's onPointerSelect. Fired from the Link's own
	// onClick: a plain click lets navigation proceed (see the Link below); Ctrl/Cmd/Shift+click call
	// preventDefault first (blocking both the SPA navigate AND the browser's native "open in new tab"
	// on a modified click) and only ever change the selection.
	onPointerSelect: (event: MouseEvent<HTMLAnchorElement>) => void
}

// A left-column circular badge — the type icon, then (stacked below, only when set) pin and favorite —
// mirroring mobile's badge stack. size-8 circle with a size-4 mark.
function RowBadge({ children }: { children: ReactNode }) {
	return <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted [&_svg]:size-4">{children}</div>
}

// One note row, shared by both sidebar views (the notes list and a tag group's expanded members). The
// row container carries the selection ring; the Link inside it is the activation target — a Link to
// /notes/$uuid, where the uuid is a selection key, not a path hierarchy — with the ⋯ trigger button as
// its sibling, not its descendant (see the ContextMenuTrigger comment below).
// A rich mobile-parity row: a circular badge column (type + pin + favorite) beside a text column with
// title, optional preview, relative edited-time, an optional "Shared by <email>" line, a participant
// avatar strip, and a tag-chip strip. Carries its own row-level context menu (right-click) and ⋯
// trigger (hover-revealed), both rendering the SAME shared descriptor list (noteMenu.logic.ts).
// No default in the destructuring pattern (`nested = false`): the React Compiler bails out of any
// component whose parameters carry one, which would leave this per-row component fully unmemoized.
export function NoteRow({
	note,
	selected,
	multiSelected,
	nested,
	allTags,
	currentUserId,
	onAction,
	onDuplicated,
	onPointerSelect
}: NoteRowProps) {
	// ["notes", "common"] for the shared cannot-decrypt title; notes stays the default namespace.
	const { t } = useTranslation(["notes", "common"])
	// The relative-time + shared-by wording live in the shared "common"/"notes" catalogs; the row's
	// own namespace is "notes", so the relative label uses a common-bound t.
	const { t: tCommon } = useTranslation("common")
	const now = useNowMinute()
	const { icon: Icon, colorClass } = noteIcon(note)
	const title = noteDisplayTitle(note, t)
	const preview = noteRowPreview(note)
	const sharedByEmail = noteRowSharedByEmail(note, currentUserId)
	const tags = noteRowTags(note)
	const participants = noteRowParticipants(note, currentUserId)

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
							"group flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 transition-colors app-region-no-drag",
							nested && "pl-8",
							selected ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60",
							multiSelected && "ring-2 ring-primary/60 ring-inset"
						)}
					>
						<Link
							to="/notes/$uuid"
							params={{ uuid: note.uuid }}
							// The routed note, announced on the link that navigates to it (the drive sidebar's own
							// rows do the same). The multi-selection is a separate fact with no honest ARIA on a
							// plain list item — it shows as the ring below, plus the bulk bar's own selected count.
							aria-current={selected ? "page" : undefined}
							onClick={selectionAwareLinkClick(onPointerSelect)}
							className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg text-left focus-ring-row outline-none"
						>
							<div className="flex shrink-0 flex-col items-center gap-1.5">
								<RowBadge>
									<Icon className={colorClass} />
								</RowBadge>
								{note.pinned ? (
									<RowBadge>
										<PinIcon
											aria-label={t("notePinned")}
											className="text-muted-foreground"
										/>
									</RowBadge>
								) : null}
								{note.favorite ? (
									<RowBadge>
										<HeartIcon
											aria-label={t("noteFavorite")}
											className="text-red-500"
										/>
									</RowBadge>
								) : null}
							</div>
							<div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
								<span className="truncate text-sm font-medium">{title}</span>
								{preview !== undefined ? (
									<span className="line-clamp-2 text-xs text-muted-foreground">{preview}</span>
								) : null}
								<span className="truncate text-xs text-muted-foreground">
									{formatRelativeTime(Number(note.editedTimestamp), tCommon, now)}
								</span>
								{sharedByEmail !== null ? (
									<span className="truncate text-xs text-muted-foreground">
										{t("noteSharedByEmail", { email: sharedByEmail })}
									</span>
								) : null}
								{participants.length > 0 ? (
									<div className="flex flex-wrap gap-1.5 pt-0.5">
										{participants.map(participant => {
											const displayName = contactDisplayName(participant)
											const source = safeAvatarUrl(participant.avatar)

											return (
												<UserAvatar
													key={participant.userId.toString()}
													src={source}
													name={displayName}
													size="sm"
													alt={displayName}
												/>
											)
										})}
									</div>
								) : null}
								{tags.length > 0 ? (
									<div className="flex flex-wrap gap-1.5 pt-0.5">
										{tags.map(tag => (
											<span
												key={tag.uuid}
												className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5"
											>
												{tag.favorite ? <HeartIcon className="size-3 shrink-0 text-red-500" /> : null}
												<span className="truncate text-xs text-muted-foreground">{tag.name ?? tag.uuid}</span>
											</span>
										))}
									</div>
								) : null}
							</div>
						</Link>
						<DropdownMenu>
							<RowMenuTrigger
								label={t("noteItemMenuTrigger")}
								reveal="plain"
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
