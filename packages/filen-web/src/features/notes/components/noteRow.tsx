import { useId, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { PinIcon, HeartIcon, UsersIcon, type LucideIcon } from "lucide-react"
import type { Note, NoteTag, NoteType } from "@filen/sdk-rs"
import { cn } from "@filen/shared"
import { noteRowIcon } from "@/features/notes/lib/icon.logic"
import { noteDisplayTitle } from "@/features/notes/lib/displayTitle"
import { tagDisplayName } from "@/features/notes/lib/sort"
import { splitSnippet } from "@/features/notes/lib/searchIndex.logic"
import { selectionAwareLinkClick } from "@/features/drive/lib/listbox"
import {
	NOTE_ROW_MAX_TAGS,
	noteRowPreview,
	noteRowSharedByEmail,
	noteRowSharedWithNames,
	noteRowTags,
	noteRowTime
} from "@/features/notes/lib/noteRow.logic"
import { NoteContextMenuContent, NoteDropdownMenuContent } from "@/features/notes/components/noteMenu"
import { availableNoteAction, noteOffersPinAndFavorite, type NoteActionDialogKind } from "@/features/notes/components/noteMenu.logic"
import { runNoteDirectAction } from "@/features/notes/lib/noteDirectAction"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { DropdownMenu } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { RowMenuTrigger } from "@/components/rowMenuTrigger"
import { LazyTooltip, RowTooltipContent } from "@/components/lazyTooltip"
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip"
import { DisabledReason, EXPLAINED_DISABLED_CLASS } from "@/components/ui/tooltipIconButton"
import { stopRowPropagation } from "@/lib/domEvents"
import { useTouchLongPress } from "@/lib/useTouchLongPress"

export interface NoteRowProps {
	note: Note
	selected: boolean
	// True iff this note is part of the active multi-selection — a distinct visual state from
	// `selected` above (the currently ROUTED note), since a multi-selection and the open note are
	// independent: clicking a different note while others stay Ctrl-selected opens it without
	// touching the selection.
	multiSelected: boolean
	// Rendered indented under a tag group in the tags view; flat (no indent) under the notes view's sections.
	nested?: boolean
	allTags: readonly NoteTag[]
	currentUserId: bigint | undefined
	// The shared minute tick (useNowMinute), owned by the sidebar so rows do not each subscribe.
	now: number
	isOnline: boolean
	// Whether this note's edits are still queued: its menu's actions wait for them, and so do the pin and favorite
	// toggles. Read once by the sidebar for every row (useInflightNoteUuids).
	inflight: boolean
	// The user's default note type (Appearance → Notes): its notes carry no type mark.
	defaultNoteType: NoteType
	// The text around the active search's hits in this note's body (searchIndex.ts), shown instead of the preview.
	snippet?: string | undefined
	// Threaded straight through to the row's own menu (noteMenu.tsx's onAction/onDuplicated) — the
	// sidebar's ONE dialog host (useNoteDialogHost) is the actual dialog-opening implementation, not
	// this row.
	onAction: (kind: NoteActionDialogKind, note: Note) => void
	onDuplicated: (duplicated: Note) => void
	// Modifier-click selection — mirrors driveRow.tsx's onPointerSelect. Fired from the Link's own
	// onClick with the pointer behind it: a plain click or touch tap lets navigation proceed (see the
	// Link below); a selection gesture (Ctrl/Cmd/Shift+click, a touch tap in selection mode) returns
	// true and is preventDefaulted (blocking both the SPA navigate AND the browser's native "open in new
	// tab" on a modified click), so it only ever changes the selection.
	onPointerSelect: (event: MouseEvent<HTMLAnchorElement>, pointerType: string) => boolean
	// A touch long-press: a Ctrl/Cmd+click's toggle, in place of the context menu.
	onLongPress: () => void
}

// A pin or favorite toggle beside the ⋯ trigger: always shown while set, revealed on hover or keyboard focus
// otherwise. A coarse pointer cannot hover, so there an unset one stays in the menu only.
function RowFlagToggle({
	pressed,
	label,
	icon: Icon,
	pressedClass,
	disabledTitle,
	onToggle
}: {
	pressed: boolean
	label: string
	icon: LucideIcon
	pressedClass: string
	// Set while offline or while the note's edits are queued: the toggle is disabled and says why.
	disabledTitle: string | undefined
	onToggle: () => void
}) {
	const reasonId = useId()

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						variant="ghost"
						size="icon-xs"
						aria-label={label}
						aria-pressed={pressed}
						aria-describedby={disabledTitle === undefined ? undefined : reasonId}
						disabled={disabledTitle !== undefined}
						focusableWhenDisabled={disabledTitle !== undefined}
						className={cn(
							"shrink-0 text-muted-foreground",
							disabledTitle !== undefined && EXPLAINED_DISABLED_CLASS,
							pressed ? pressedClass : "hidden group-focus-within:inline-flex group-hover:inline-flex pointer-coarse:hidden"
						)}
						onClick={event => {
							stopRowPropagation(event)
							onToggle()
						}}
						onDoubleClick={stopRowPropagation}
					>
						<Icon className={cn(pressed && "fill-current")} />
						<DisabledReason
							id={reasonId}
							reason={disabledTitle}
						/>
					</Button>
				}
			/>
			<RowTooltipContent>{disabledTitle ?? label}</RowTooltipContent>
		</Tooltip>
	)
}

// A search snippet with its hits marked. Plain text nodes only: the snippet is note text.
function SearchSnippet({ snippet }: { snippet: string }) {
	return splitSnippet(snippet).map((part, index) =>
		part.hit ? (
			<mark
				key={index}
				className="rounded-sm bg-transparent font-medium text-foreground"
			>
				{part.text}
			</mark>
		) : (
			<span key={index}>{part.text}</span>
		)
	)
}

// One note row, shared by both sidebar views (the notes list and a tag group's expanded members). The
// row container carries the selection state; the Link inside it is the activation target — a Link to
// /notes/$uuid, where the uuid is a selection key, not a path hierarchy — with the pin/favorite toggles
// and the ⋯ trigger as its siblings, not its descendants (see the ContextMenuTrigger comment below).
// Three quiet lines: an optional type mark + title (+ a shared mark), the edited time + a one-line preview,
// and at most NOTE_ROW_MAX_TAGS tag chips plus a "+N" chip, never wrapping. Carries its own row-level context
// menu (right-click) and ⋯ trigger (hover-revealed), both rendering the SAME shared descriptor list
// (noteMenu.logic.ts).
// No default in the destructuring pattern (`nested = false`): the React Compiler bails out of any
// component whose parameters carry one, which would leave this per-row component fully unmemoized.
export function NoteRow({
	note,
	selected,
	multiSelected,
	nested,
	allTags,
	currentUserId,
	now,
	isOnline,
	inflight,
	defaultNoteType,
	snippet,
	onAction,
	onDuplicated,
	onPointerSelect,
	onLongPress
}: NoteRowProps) {
	// ["notes", "common"] for the shared cannot-decrypt title; notes stays the default namespace.
	const { t } = useTranslation(["notes", "common"])
	const mark = noteRowIcon(note, nested !== true, defaultNoteType)
	const title = noteDisplayTitle(note, t)
	const preview = noteRowPreview(note)
	const sharedByEmail = noteRowSharedByEmail(note, currentUserId)
	const sharedWithNames = noteRowSharedWithNames(note, currentUserId, sharedByEmail)
	const sharedLabel =
		sharedByEmail === null && sharedWithNames === null
			? null
			: [
					sharedByEmail !== null ? t("noteSharedByEmail", { email: sharedByEmail }) : null,
					sharedWithNames !== null ? t("noteSharedWith", { names: sharedWithNames }) : null
				]
					.filter(line => line !== null)
					.join("\n")
	const tags = note.tags.length > 0 ? noteRowTags(note) : note.tags
	const hiddenTags = tags.length > NOTE_ROW_MAX_TAGS ? tags.slice(NOTE_ROW_MAX_TAGS) : null
	const hiddenTagNames = hiddenTags !== null ? hiddenTags.map(tagDisplayName).join(", ") : ""
	const offersFlags = noteOffersPinAndFavorite(note)
	// The menu's own reasons, in its order (noteMenu.tsx).
	const flagsDisabledTitle = inflight ? t("noteSyncing") : isOnline ? undefined : t("common:offlineActionDisabled")
	const press = useTouchLongPress<HTMLDivElement>({ onLongPress })

	// The menu's own gate and dispatch (an edit still queued for this note blocks it).
	function toggleFlag(id: "pin" | "favorite"): void {
		if (availableNoteAction(note, id, currentUserId, isOnline, inflight) === undefined) {
			return
		}

		void runNoteDirectAction(note, id, t, onDuplicated)
	}

	return (
		<ContextMenu>
			{/* render-prop merge onto the row's own div (mirrors driveRow.tsx's own idiom) — Base UI's
			ContextMenuTrigger merges its onContextMenu handler + ref onto the given element rather than
			wrapping it. The Link stays a SIBLING of the toggles and the ⋯ trigger, not an ancestor: a <button>
			nested inside an <a> is invalid content model and an accessibility regression (drive's own row solved
			the identical shape by never using a real anchor at all — see driveRow.tsx). */}
			<ContextMenuTrigger
				render={
					<div
						{...press.handlers}
						// Which note a key pressed in this row is for (the notes shortcuts' target).
						data-note-uuid={note.uuid}
						className={cn(
							"group relative flex w-full items-start gap-1 rounded-lg py-1.5 pr-1.5 pl-3 transition-colors app-region-no-drag",
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
							// The row's stop for the list's arrow keys (notesSidebar.tsx).
							data-notes-row=""
							onClick={selectionAwareLinkClick((event: MouseEvent<HTMLAnchorElement>) =>
								onPointerSelect(event, press.pointerType(event))
							)}
							className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md text-left focus-ring-row outline-none"
						>
							<span className="flex min-w-0 items-center gap-1.5">
								{mark !== null ? <mark.icon className={cn("size-3.5 shrink-0", mark.colorClass)} /> : null}
								<span className="min-w-0 truncate text-sm font-medium">{title}</span>
								{sharedLabel !== null ? (
									<LazyTooltip
										label={sharedLabel}
										className="flex shrink-0"
									>
										<span className="text-muted-foreground">
											<UsersIcon
												aria-hidden
												className="size-3"
											/>
											<span className="sr-only">{sharedLabel}</span>
										</span>
									</LazyTooltip>
								) : null}
							</span>
							<span className="truncate text-xs text-muted-foreground">
								{noteRowTime(Number(note.editedTimestamp), now)}
								{snippet !== undefined ? (
									<>
										{" · "}
										<SearchSnippet snippet={snippet} />
									</>
								) : preview !== undefined ? (
									` · ${preview}`
								) : null}
							</span>
							{tags.length > 0 ? (
								<span className="flex min-w-0 gap-1 overflow-hidden pt-0.5">
									{tags.slice(0, NOTE_ROW_MAX_TAGS).map(tag => (
										<span
											key={tag.uuid}
											className="min-w-0 truncate rounded-full bg-muted px-1.5 text-xs leading-4 text-muted-foreground"
										>
											{tagDisplayName(tag)}
										</span>
									))}
									{hiddenTags !== null ? (
										<LazyTooltip
											label={hiddenTagNames}
											className="flex shrink-0"
										>
											<span className="rounded-full bg-muted px-1.5 text-xs leading-4 text-muted-foreground tabular-nums">
												<span aria-hidden>{t("noteMoreTags", { hidden: hiddenTags.length })}</span>
												<span className="sr-only">{hiddenTagNames}</span>
											</span>
										</LazyTooltip>
									) : null}
								</span>
							) : null}
						</Link>
						<div className="-my-0.5 flex shrink-0 items-center">
							{offersFlags ? (
								<>
									<RowFlagToggle
										pressed={note.pinned}
										label={t("notePinned")}
										icon={PinIcon}
										pressedClass="text-foreground"
										disabledTitle={flagsDisabledTitle}
										onToggle={() => {
											toggleFlag("pin")
										}}
									/>
									<RowFlagToggle
										pressed={note.favorite}
										label={t("noteFavorite")}
										icon={HeartIcon}
										pressedClass="text-red-500 hover:text-red-500"
										disabledTitle={flagsDisabledTitle}
										onToggle={() => {
											toggleFlag("favorite")
										}}
									/>
								</>
							) : (
								<>
									{note.pinned ? (
										<PinIcon
											role="img"
											aria-label={t("notePinned")}
											className="mx-1 size-3.5 shrink-0 fill-current text-muted-foreground"
										/>
									) : null}
									{note.favorite ? (
										<HeartIcon
											role="img"
											aria-label={t("noteFavorite")}
											className="mx-1 size-3.5 shrink-0 fill-current text-red-500"
										/>
									) : null}
								</>
							)}
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
