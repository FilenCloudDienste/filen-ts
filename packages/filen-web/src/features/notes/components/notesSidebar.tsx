import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { isImeKeydown } from "@filen/shared/keymap"
import { selectedNoteUuidFromPath } from "@/features/notes/lib/route"
import { useTranslation } from "react-i18next"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useShallow } from "zustand/shallow"
import {
	PlusIcon,
	SearchIcon,
	ChevronRightIcon,
	StarIcon,
	StickyNoteIcon,
	TagIcon,
	MoreHorizontalIcon,
	PinIcon,
	HeartIcon,
	CalendarDaysIcon,
	CalendarIcon,
	ArchiveIcon,
	Trash2Icon,
	UploadIcon,
	ArrowDownNarrowWideIcon,
	type LucideIcon
} from "lucide-react"
import type { Note, NoteTag } from "@filen/sdk-rs"
import { cn, aggregateNoteSelectionFlags, DEFAULT_NOTE_TAGS_SORT_BY, toggleInSet, type NoteTagsSortBy } from "@filen/shared"
import { useNotes } from "@/features/notes/queries/notes"
import { useNoteTags } from "@/features/notes/queries/noteTags"
import { useNotesViewModeQuery, useNoteTagsSortByQuery } from "@/features/notes/queries/preferences"
import { useAccountQuery } from "@/queries/account"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { setNotesViewMode, DEFAULT_NOTES_VIEW_MODE, setNoteTagsSortBy, type NotesViewMode } from "@/features/notes/lib/preferences"
import { tagDisplayName, isNoteUndecryptable } from "@/features/notes/lib/sort"
import {
	buildNotesGroupedRows,
	buildNotesByTag,
	buildTagsViewRows,
	isUntaggedTagUuid,
	filterNotesByBlockedOwner,
	sidebarRowKey,
	selectableNotesFromRows,
	selectableRowIndexByKey,
	notesRowKeyTarget,
	type NotesSidebarRow,
	type NotesGroupIcon
} from "@/features/notes/components/notesSidebar.logic"
import { createNote } from "@/features/notes/lib/actions"
import { exportAllNotes, toastNotesExportOutcome } from "@/features/notes/lib/export"
import { createFailedAs, runNoteCreateActivity } from "@/features/notes/lib/activity"
import { importNoteFromFile } from "@/features/notes/lib/import"
import { importAcceptAttribute } from "@/features/notes/lib/import.logic"
import { selectableNotesForSelectAll } from "@/features/notes/lib/selectionFlags"
import { useNotesSelectionStore } from "@/features/notes/store/useNotesSelectionStore"
import { useNotesListSelection } from "@/features/notes/hooks/useNotesListSelection"
import { useNoteDialogHost } from "@/features/notes/hooks/useNoteDialogHost"
import { useNoteSearchBodies } from "@/features/notes/hooks/useNoteSearchBodies"
import { useIsOnline } from "@/lib/useIsOnline"
import { useNowMinute } from "@/lib/useNowMinute"
import { OUTSIDE_OVERLAYS, useAction } from "@/lib/keymap/useAction"
import { ON_FOCUSED_ROW, rowNoteUuid } from "@/features/notes/lib/rowKeys"
import { hasCommandModifier } from "@/lib/rowKeys"
import { isNoteInflight } from "@/features/notes/store/useNotesInflight"
import { runNoteDirectAction } from "@/features/notes/lib/noteDirectAction"
import { availableNoteAction, type NoteActionId } from "@/features/notes/components/noteMenu.logic"
import { canBulkDeleteNotes } from "@/features/notes/components/notesBulkActionBar.logic"
import type { ListPointerSelection } from "@/lib/useListPointerSelection"
import { useIsSidebarPanelVisible } from "@/features/shell/lib/sidebarPanelVisibility"
import { ResizableSidebarPanel } from "@/features/shell/components/sidebarPanel"
import { NoteRow } from "@/features/notes/components/noteRow"
import { NotesBulkActionBar } from "@/features/notes/components/notesBulkActionBar"
import { canBulkTrashNotes } from "@/features/notes/components/notesBulkActionBar.logic"
import { TagContextMenuContent } from "@/features/notes/components/noteMenu"
import { type NoteActionDialogKind, type NoteTagDialogKind } from "@/features/notes/components/noteMenu.logic"
import { Button } from "@/components/ui/button"
import { LoadingState } from "@/components/loadingState"
import { ListFilterInput } from "@/components/listFilterInput"
import { SidebarNotice } from "@/components/sidebarNotice"
import { BULK_BAR_MIN_SELECTION } from "@/components/selectionActionBar"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

// First-pass size estimates only — note rows now vary in height (optional preview / shared-by /
// avatar / tag lines), and the notes view interleaves section headers, so real heights come from the
// virtualizer's measureElement pass after mount (same shape as messageThread.tsx's mixed message/day
// rows). Tag headers are still one line; the estimates just seed the initial layout.
const NOTE_ROW_ESTIMATE = 76
const TAG_ROW_ESTIMATE = 40
const HEADER_ROW_ESTIMATE = 40

// Section-header icon kind → concrete lucide icon (the logic layer stays React-free and only names the
// kind). Today gets a distinct calendar glyph; the remaining date buckets share the plain calendar.
const GROUP_ICON: Record<NotesGroupIcon, LucideIcon> = {
	pinned: PinIcon,
	favorited: HeartIcon,
	today: CalendarDaysIcon,
	calendar: CalendarIcon,
	archived: ArchiveIcon,
	trashed: Trash2Icon
}

// A notes-view date-group section header — a leading icon + the bucket label. Sticky-free (the
// virtualizer positions it absolutely like every other row), and a plain label: the flat row model
// puts it beside the rows it introduces rather than around them, so it claims no ownership of them.
function NotesGroupHeader({ row }: { row: Extract<NotesSidebarRow, { kind: "header" }> }) {
	const { t } = useTranslation("notes")
	const Icon = GROUP_ICON[row.icon]
	const label = row.label.kind === "key" ? t(row.label.key) : row.label.text

	return (
		<div className="flex items-center gap-2 px-2.5 pt-4 pb-1.5">
			<Icon className="size-4 shrink-0 text-muted-foreground" />
			<span className="truncate text-sm font-semibold text-muted-foreground">{label}</span>
		</div>
	)
}

function segmentClass(active: boolean): string {
	return cn(
		"flex-1 rounded-md px-2 py-1 text-xs font-medium focus-ring transition-colors outline-none app-region-no-drag",
		active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
	)
}

// A tag group's disclosure row, over the member note rows the flat row model emits after it. A plain
// <button> carrying its own aria-expanded — no role override, so it keeps both native activation and
// the button semantics every caller (and locator) resolves it by.
export function TagGroupRow({
	row,
	onToggle,
	onTagAction,
	onCreateNoteInTag
}: {
	row: Extract<NotesSidebarRow, { kind: "tag" }>
	onToggle: () => void
	onTagAction: (kind: NoteTagDialogKind, tag: NoteTag) => void
	onCreateNoteInTag: (created: Note) => void
}) {
	const { t } = useTranslation("notes")
	const name = tagDisplayName(row.tag)
	// The synthesized untagged row has no server uuid, so every tag action (rename/delete/favorite/
	// create-note-in-tag) would be meaningless — it renders without a context menu at all rather than
	// opening an empty popup. Its label is styled apart so a real tag a user named "Untagged" stays
	// distinguishable.
	const isVirtual = isUntaggedTagUuid(row.tag.uuid)

	const trigger = (
		<button
			type="button"
			aria-expanded={row.expanded}
			data-notes-row=""
			aria-label={t(row.expanded ? "notesTagCollapse" : "notesTagExpand", { name })}
			onClick={onToggle}
			className="group flex w-full items-center gap-1.5 rounded-xl px-2.5 py-2 text-left focus-ring transition-colors outline-none app-region-no-drag hover:bg-sidebar-accent/60"
		>
			<ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", row.expanded && "rotate-90")} />
			<TagIcon className="size-4 shrink-0 text-muted-foreground" />
			<span className={cn("min-w-0 flex-1 truncate text-sm font-medium", isVirtual && "text-muted-foreground italic")}>{name}</span>
			{row.tag.favorite ? (
				<StarIcon
					aria-label={t("notesTagFavorite")}
					className="size-3 shrink-0 text-amber-500"
				/>
			) : null}
			<span
				aria-label={t("notesTagCount", { count: row.noteCount })}
				className="shrink-0 text-xs text-muted-foreground tabular-nums"
			>
				{row.noteCount}
			</span>
		</button>
	)

	if (isVirtual) {
		return trigger
	}

	return (
		<ContextMenu>
			{/* Same render-prop merge as NoteRow's own trigger — Base UI merges onContextMenu + ref onto
			the button rather than wrapping it, so the row's geometry stays untouched. */}
			<ContextMenuTrigger render={trigger} />
			<TagContextMenuContent
				tag={row.tag}
				onTagAction={onTagAction}
				onCreateNoteInTag={onCreateNoteInTag}
			/>
		</ContextMenu>
	)
}

// Tags-view sort control: 3 field/direction radio-group pairs, same shape as drive's own SortMenu but
// icon-only (the narrow sidebar has no room for a labeled "Sort by" button). Shown next to the
// notes/tags view toggle, tags view only.
type TagsSortField = "lastActivity" | "name" | "notesCount"
type TagsSortDirection = "asc" | "desc"

const TAGS_SORT_PARTS: Record<NoteTagsSortBy, { field: TagsSortField; direction: TagsSortDirection }> = {
	lastActivityDesc: { field: "lastActivity", direction: "desc" },
	lastActivityAsc: { field: "lastActivity", direction: "asc" },
	nameAsc: { field: "name", direction: "asc" },
	nameDesc: { field: "name", direction: "desc" },
	notesCountDesc: { field: "notesCount", direction: "desc" },
	notesCountAsc: { field: "notesCount", direction: "asc" }
}

const TAGS_SORT_FROM_PARTS: Record<TagsSortField, Record<TagsSortDirection, NoteTagsSortBy>> = {
	lastActivity: { desc: "lastActivityDesc", asc: "lastActivityAsc" },
	name: { asc: "nameAsc", desc: "nameDesc" },
	notesCount: { desc: "notesCountDesc", asc: "notesCountAsc" }
}

function TagsSortMenu({ value, onChange }: { value: NoteTagsSortBy; onChange: (next: NoteTagsSortBy) => void }) {
	const { t } = useTranslation("notes")
	const { field, direction } = TAGS_SORT_PARTS[value]

	const fields: { field: TagsSortField; label: string }[] = [
		{ field: "lastActivity", label: t("notesTagsSortLastActivity") },
		{ field: "name", label: t("notesTagsSortName") },
		{ field: "notesCount", label: t("notesTagsSortNotesCount") }
	]

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("notesTagsSortMenuLabel")}
						className="app-region-no-drag"
					>
						<ArrowDownNarrowWideIcon />
					</Button>
				}
			/>
			<DropdownMenuContent align="end">
				<DropdownMenuRadioGroup
					value={field}
					onValueChange={(next: TagsSortField) => {
						onChange(TAGS_SORT_FROM_PARTS[next][direction])
					}}
				>
					<DropdownMenuLabel>{t("notesTagsSortMenuLabel")}</DropdownMenuLabel>
					{fields.map(row => (
						<DropdownMenuRadioItem
							key={row.field}
							value={row.field}
						>
							{row.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				<DropdownMenuSeparator />
				<DropdownMenuRadioGroup
					value={direction}
					onValueChange={(next: TagsSortDirection) => {
						onChange(TAGS_SORT_FROM_PARTS[field][next])
					}}
				>
					<DropdownMenuRadioItem value="asc">{t("notesTagsSortAscending")}</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="desc">{t("notesTagsSortDescending")}</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export function NotesSidebar() {
	const { t } = useTranslation(["notes", "common"])
	const isOnline = useIsOnline()
	const panelVisible = useIsSidebarPanelVisible()
	const navigate = useNavigate()
	const pathname = useRouterState({ select: state => state.location.pathname })
	const selectedUuid = selectedNoteUuidFromPath(pathname)

	const notesQuery = useNotes()
	const tagsQuery = useNoteTags()
	const viewModeQuery = useNotesViewModeQuery()
	const viewMode = viewModeQuery.data ?? DEFAULT_NOTES_VIEW_MODE
	const tagsSortByQuery = useNoteTagsSortByQuery()
	const tagsSortBy = tagsSortByQuery.data ?? DEFAULT_NOTE_TAGS_SORT_BY
	const accountQuery = useAccountQuery()
	const currentUserId = accountQuery.data?.id
	// Always warm (unlike drive's sharedIn-only gate): every note in this single flat list could be owned
	// by anyone, not just a sharedIn subtree, so the blocked cross-reference applies unconditionally.
	const blocked = useBlockedUsers(true)

	const [search, setSearch] = useState("")
	// Collapse state is in-memory only — a tag uuid present here is expanded.
	const [expandedTags, setExpandedTags] = useState<ReadonlySet<string>>(() => new Set())
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
	const importInputRef = useRef<HTMLInputElement | null>(null)
	// The header holding the filter field notes.search focuses (ListFilterInput takes no ref).
	const sidebarHeaderRef = useRef<HTMLDivElement | null>(null)

	// This filter is applied BEFORE either view builds its rows, so a blocked note's uuid is simply absent
	// from every downstream derivation (rows, selectableNotes, the live-selection re-derivation below) —
	// the same "just don't include it" mechanism the selection ghost-purge already relies on, no separate
	// purge step needed.
	const allNotes = filterNotesByBlockedOwner(notesQuery.data ?? [], blocked)
	// Eager, opt-in full-body fetch feeding the filters below; see useNoteSearchBodies.ts's own
	// doc comment for why this never fires a single request outside an active search.
	const searchBodies = useNoteSearchBodies(allNotes, search)

	// One host for every row's menu (noteRow.tsx never opens a dialog itself — it only calls onAction).
	// currentUuid drives the delete/leave nav-away guard: a row-triggered delete of the currently-open
	// note still navigates to /notes before the row disappears out of the cache.
	const dialogHost = useNoteDialogHost()

	// The notes view's date groups ("Today", "Previous 7 days", …) cut on rolling windows back from now,
	// so the row model needs a clock — as state, never a `Date.now()` read in this render body (see
	// useNowMinute).
	const now = useNowMinute()

	// allTags, rows and both selectable lookups are all built before the next hook: the React Compiler
	// drops the memo scope of a value that is still mutable across a hook call.
	const allTags = tagsQuery.data ?? []

	// One flattened row model for BOTH views, so a single virtualizer covers either (never a nested
	// virtualizer per tag). Notes view: each note as a flat note row. Tags view: tag headers + expanded
	// member notes interleaved.
	const rows: NotesSidebarRow[] =
		viewMode === "notes"
			? buildNotesGroupedRows(allNotes, search, now, searchBodies)
			: buildTagsViewRows({
					tags: allTags,
					notesByTag: buildNotesByTag(allNotes),
					expandedTagUuids: expandedTags,
					search,
					sortBy: tagsSortBy,
					untaggedLabel: t("notesTagUntagged"),
					bodies: searchBodies
				})

	// The ordered, currently-visible note set click-selection ranges walk (search-filtered, spans both
	// views). A view switch (viewMode) resets the selection/anchor, mirroring how a fresh directory
	// resets drive's own selection on navigation.
	const selectableNotes = selectableNotesFromRows(rows)
	const selectableIndexByRowKey = selectableRowIndexByKey(rows)

	const rawSelectedNotes = useNotesSelectionStore(useShallow(state => state.selectedNotes))
	// LIVE (ghost-purged) selection: re-derived from the current notes query every render, so a note
	// removed from the account (elsewhere, or by another tab) between selection and dispatch is never
	// targeted or counted towards the bulk bar's "2+ selected" threshold.
	const notesByUuid = new Map(allNotes.map(note => [note.uuid, note]))
	const liveSelectedNotes: Note[] = []
	for (const selected of rawSelectedNotes) {
		const live = notesByUuid.get(selected.uuid)

		if (live) {
			liveSelectedNotes.push(live)
		}
	}
	const liveSelectedUuids = new Set(liveSelectedNotes.map(note => note.uuid))
	const selection = useNotesListSelection({ notes: selectableNotes, resetKey: viewMode, selectionCount: liveSelectedNotes.length })

	async function handleViewModeChange(next: NotesViewMode): Promise<void> {
		if (next === viewMode) {
			return
		}

		await setNotesViewMode(next)
		await viewModeQuery.refetch()
	}

	function toggleTag(uuid: string): void {
		setExpandedTags(prev => toggleInSet(prev, uuid))
	}

	// Target of every "open the note just created/duplicated" path, including the tag-menu's
	// create-then-tag round trip (noteMenu.tsx).
	async function openNote(note: Note): Promise<void> {
		await navigate({ to: "/notes/$uuid", params: { uuid: note.uuid } })
	}

	async function handleNewNote(): Promise<void> {
		const created = await runNoteCreateActivity(t("notesCreating"), async () =>
			createFailedAs(await createNote(), t("notesCreateError"))
		)

		if (created !== null) {
			await openNote(created)
		}
	}

	async function handleExportAll(): Promise<void> {
		toastNotesExportOutcome(await exportAllNotes(allNotes))
	}

	// The hidden file input's onChange: detect+sanitize+create all happen inside importNoteFromFile
	// (lib/import.ts); this only resolves the outcome and navigates, same shape as handleNewNote. Resets
	// the input's value after every pick (success or failure) so choosing the SAME file twice in a row
	// still fires a change event.
	async function handleImportFile(file: File): Promise<void> {
		const imported = await runNoteCreateActivity(t("notesImporting", { name: file.name }), async () =>
			createFailedAs(await importNoteFromFile(file), t("notesImportError", { name: file.name }))
		)

		if (imported !== null) {
			await openNote(imported)
		}
	}

	async function handleTagsSortChange(next: NoteTagsSortBy): Promise<void> {
		await setNoteTagsSortBy(next)
		await tagsSortByQuery.refetch()
	}

	// Def in features/notes/lib/keymap.ts. Every notes action stands down under any open dialog or menu
	// (OUTSIDE_OVERLAYS): a note dialog (rename/delete/leave/createTag), History or Participants, or a
	// row's menu, whose own Escape closes it without also clearing the selection. A new note is also
	// gated on the same connectivity flag the button is disabled by, so the two can never disagree —
	// drive.newDirectory guards its own hotkey identically.
	useAction(
		"notes.newNote",
		() => {
			if (isOnline) {
				void handleNewNote()
			}
		},
		OUTSIDE_OVERLAYS,
		[isOnline]
	)

	// Def in features/notes/lib/keymap.ts. Browser default for mod+a is "select all page text" — must
	// preventDefault or the native selection would visibly compete with the note-row selection.
	// Targets `selectableNotes` (already search-filtered) minus undecryptable ones — mirrors
	// drive.selectAll exactly.
	//
	// The selection actions below are additionally OFF while the panel is out of sight (drawer closed
	// below the layout breakpoint), and the trash keys ignore the selection then: every trace of a
	// selection — rows, count, bulk bar — lives inside this panel, so firing them there would swallow the
	// browser's own select-all and leave an invisible selection a later Delete could act on.
	// notes.newNote stays live: it navigates, so its result is visible wherever it is triggered from.
	useAction(
		"notes.selectAll",
		event => {
			event.preventDefault()
			useNotesSelectionStore.getState().setSelectedNotes(selectableNotesForSelectAll(selectableNotes))
		},
		{ ...OUTSIDE_OVERLAYS, enabled: panelVisible },
		[selectableNotes]
	)

	// Def in features/notes/lib/keymap.ts. No preventDefault — bare Escape has no disruptive browser
	// default.
	useAction(
		"notes.clearSelection",
		() => {
			useNotesSelectionStore.getState().clearSelectedNotes()
		},
		{ ...OUTSIDE_OVERLAYS, enabled: panelVisible }
	)

	// A scan, once per keypress: the uuid comes from the DOM or the URL, not typed as a note uuid.
	function noteWithUuid(uuid: string): Note | undefined {
		return allNotes.find(note => note.uuid === uuid)
	}

	// The note a per-note shortcut acts on: the one whose row the key was pressed in, else the note on screen.
	function keyTargetNote(event: KeyboardEvent): Note | undefined {
		return noteWithUuid(rowNoteUuid(event.target) ?? selectedUuid)
	}

	// Runs what the note's own menu would for `id`, through the menu's gate (offered for this note, online, its edits
	// not still queued). True when it ran, so the caller cancels the key's default only then.
	function runNoteKey(note: Note | undefined, id: NoteActionId): boolean {
		if (note === undefined) {
			return false
		}

		const descriptor = availableNoteAction(note, id, currentUserId, isOnline, isNoteInflight(note.uuid))

		if (descriptor === undefined || descriptor.run === "submenu") {
			return false
		}

		if (descriptor.run === "dialog") {
			dialogHost.openNoteDialog(descriptor.dialogKind, note)
		} else {
			void runNoteDirectAction(note, descriptor.id, t, duplicated => {
				void openNote(duplicated)
			})
		}

		return true
	}

	// The open note's Trash, behind a confirmation: offered by the same gate as its menu's Trash. True when it asked.
	function confirmOpenNoteTrash(note: Note | undefined): boolean {
		if (note === undefined || availableNoteAction(note, "trash", currentUserId, isOnline, isNoteInflight(note.uuid)) === undefined) {
			return false
		}

		dialogHost.openNoteDialog("trash", note)

		return true
	}

	// Def in features/notes/lib/keymap.ts. A selection (shown only with the panel in sight) is confirmed and trashed
	// as the bulk bar does, when it offers Trash at all (canBulkTrashNotes, its own gate); with none, the focused note
	// is trashed as its menu's Trash does, and the open note (no row focused: the key was pressed in the page at large)
	// only once confirmed, through the same menu gate. preventDefault only once it acts: Backspace still has a "go back"
	// default in some engines.
	useAction(
		"notes.trash",
		keyboardEvent => {
			if (panelVisible && liveSelectedNotes.length > 0) {
				if (!isOnline || !canBulkTrashNotes(aggregateNoteSelectionFlags(liveSelectedNotes, currentUserId, isNoteUndecryptable))) {
					return
				}

				keyboardEvent.preventDefault()
				dialogHost.openBulkDialog("trashSelected", liveSelectedNotes)

				return
			}

			const rowUuid = rowNoteUuid(keyboardEvent.target)

			if (rowUuid !== undefined ? runNoteKey(noteWithUuid(rowUuid), "trash") : confirmOpenNoteTrash(noteWithUuid(selectedUuid))) {
				keyboardEvent.preventDefault()
			}
		},
		OUTSIDE_OVERLAYS,
		[isOnline, liveSelectedNotes, currentUserId, panelVisible, selectedUuid, allNotes]
	)

	// Def in features/notes/lib/keymap.ts. As notes.trash, for the selection's or the note's Delete permanently: both
	// confirm first.
	useAction(
		"notes.deletePermanently",
		keyboardEvent => {
			if (panelVisible && liveSelectedNotes.length > 0) {
				if (!isOnline || !canBulkDeleteNotes(aggregateNoteSelectionFlags(liveSelectedNotes, currentUserId, isNoteUndecryptable))) {
					return
				}

				keyboardEvent.preventDefault()
				dialogHost.openBulkDialog("deleteSelected", liveSelectedNotes)

				return
			}

			if (runNoteKey(keyTargetNote(keyboardEvent), "deletePermanently")) {
				keyboardEvent.preventDefault()
			}
		},
		OUTSIDE_OVERLAYS,
		[isOnline, liveSelectedNotes, currentUserId, panelVisible, selectedUuid, allNotes]
	)

	// The focused or open note's menu entry `id`, as a key handler.
	function onNoteKey(id: NoteActionId): (keyboardEvent: KeyboardEvent) => void {
		return keyboardEvent => {
			if (runNoteKey(keyTargetNote(keyboardEvent), id)) {
				keyboardEvent.preventDefault()
			}
		}
	}

	// The focused row's menu entry `id` (its single keys).
	function onRowKey(id: NoteActionId): (keyboardEvent: KeyboardEvent) => void {
		return keyboardEvent => {
			runNoteKey(noteWithUuid(rowNoteUuid(keyboardEvent.target) ?? ""), id)
		}
	}

	const noteKeyDeps = [isOnline, currentUserId, selectedUuid, allNotes]

	// Defs in features/notes/lib/keymap.ts: the focused or open note's menu entries, through its menu's gate.
	useAction("notes.rename", onNoteKey("rename"), OUTSIDE_OVERLAYS, noteKeyDeps)
	useAction("notes.duplicate", onNoteKey("duplicate"), OUTSIDE_OVERLAYS, noteKeyDeps)
	useAction("notes.restore", onNoteKey("restore"), OUTSIDE_OVERLAYS, noteKeyDeps)
	useAction("notes.export", onNoteKey("export"), OUTSIDE_OVERLAYS, noteKeyDeps)
	useAction("notes.history", onNoteKey("history"), OUTSIDE_OVERLAYS, noteKeyDeps)
	useAction("notes.participants", onNoteKey("participants"), OUTSIDE_OVERLAYS, noteKeyDeps)

	// Single keys, on the focused row only: useAction cancels a matched printable key's default itself, and
	// ON_FOCUSED_ROW stands down before that anywhere else.
	useAction("notes.archive", onRowKey("archive"), { ...ON_FOCUSED_ROW, enabled: panelVisible }, noteKeyDeps)
	useAction("notes.pin", onRowKey("pin"), { ...ON_FOCUSED_ROW, enabled: panelVisible }, noteKeyDeps)
	useAction("notes.favorite", onRowKey("favorite"), { ...ON_FOCUSED_ROW, enabled: panelVisible }, noteKeyDeps)

	// Def in features/notes/lib/keymap.ts. Into the sidebar's filter, in sight only; outside the editors, whose
	// find keeps the key (useAction skips editable targets).
	useAction(
		"notes.search",
		keyboardEvent => {
			const field = sidebarHeaderRef.current?.querySelector<HTMLInputElement>('input[type="search"]')

			if (field === undefined || field === null) {
				return
			}

			keyboardEvent.preventDefault()
			field.focus()
			field.select()
		},
		{ ...OUTSIDE_OVERLAYS, enabled: panelVisible }
	)

	// Defs in features/notes/lib/keymap.ts: the sidebar's "..." menu entries, under the same gates as its items.
	useAction(
		"notes.import",
		keyboardEvent => {
			const input = importInputRef.current

			if (!isOnline || input === null) {
				return
			}

			keyboardEvent.preventDefault()
			input.click()
		},
		OUTSIDE_OVERLAYS,
		[isOnline]
	)

	useAction(
		"notes.newTag",
		keyboardEvent => {
			if (!isOnline) {
				return
			}

			keyboardEvent.preventDefault()
			dialogHost.openCreateTagDialog()
		},
		OUTSIDE_OVERLAYS,
		[isOnline]
	)

	useAction(
		"notes.exportAll",
		keyboardEvent => {
			if (notesQuery.isPending || allNotes.length === 0) {
				return
			}

			keyboardEvent.preventDefault()
			void handleExportAll()
		},
		OUTSIDE_OVERLAYS,
		[notesQuery.isPending, allNotes]
	)

	useAction(
		"notes.toggleView",
		keyboardEvent => {
			keyboardEvent.preventDefault()
			void handleViewModeChange(viewMode === "notes" ? "tags" : "notes")
		},
		{ ...OUTSIDE_OVERLAYS, enabled: panelVisible },
		[viewMode]
	)

	const activeQuery = viewMode === "notes" ? notesQuery : tagsQuery
	const searching = search.trim().length > 0

	// Null while listing; NotesSidebarList renders the rows then.
	function renderFallback(): ReactNode {
		if (activeQuery.isPending) {
			return <LoadingState size="md" />
		}

		if (activeQuery.isError) {
			return (
				<SidebarNotice
					role="alert"
					icon={<StickyNoteIcon />}
					title={t("notesLoadError")}
				/>
			)
		}

		if (rows.length === 0) {
			if (searching) {
				return (
					<SidebarNotice
						icon={<SearchIcon />}
						title={t("notesSearchEmptyTitle")}
						description={t("notesSearchEmptyDescription")}
					/>
				)
			}

			return viewMode === "notes" ? (
				<SidebarNotice
					icon={<StickyNoteIcon />}
					title={t("notesEmptyTitle")}
					description={t("notesEmptyDescription")}
				/>
			) : (
				<SidebarNotice
					icon={<TagIcon />}
					title={t("notesTagsEmptyTitle")}
					description={t("notesTagsEmptyDescription")}
					action={
						// The empty-state's own create-tag entry point: reachable even when the account
						// has zero notes (the tags-view "no tags" state is agnostic to note count), unlike the
						// note-scoped createTag dialog this reuses instead (openCreateTagDialog carries no note).
						<Button
							variant="outline"
							size="sm"
							className="mt-1 app-region-no-drag"
							onClick={() => {
								dialogHost.openCreateTagDialog()
							}}
						>
							<PlusIcon />
							{t("noteActionCreateTag")}
						</Button>
					}
				/>
			)
		}

		return null
	}

	return (
		<ResizableSidebarPanel
			module="notes"
			resizeLabel={t("notesSidebarResize")}
		>
			<div
				ref={sidebarHeaderRef}
				className="flex flex-col gap-2 p-3"
			>
				<div className="flex items-center justify-between gap-2">
					<h2 className="truncate px-1 text-[15px] font-semibold">{t("notesSidebarTitle")}</h2>
					<div className="flex items-center gap-0.5">
						<Button
							variant="ghost"
							size="icon-sm"
							disabled={!isOnline}
							aria-label={t("notesNewNote")}
							title={!isOnline ? t("common:offlineActionDisabled") : undefined}
							className="app-region-no-drag"
							onClick={() => {
								void handleNewNote()
							}}
						>
							<PlusIcon />
						</Button>
						{/* Bulk-ops menu — export/import/new-tag. The TRIGGER itself stays always-enabled: a
						zero-note account must still be able to reach "New tag" here; only the export item,
						which genuinely needs notes to zip, carries its own disabled state. */}
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={t("notesSidebarMoreActions")}
										className="app-region-no-drag"
									>
										<MoreHorizontalIcon />
									</Button>
								}
							/>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									disabled={notesQuery.isPending || allNotes.length === 0}
									onClick={() => {
										void handleExportAll()
									}}
								>
									{t("notesExportAllAction")}
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={!isOnline}
									title={!isOnline ? t("common:offlineActionDisabled") : undefined}
									onClick={() => {
										importInputRef.current?.click()
									}}
								>
									<UploadIcon />
									{t("notesImportAction")}
								</DropdownMenuItem>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									disabled={!isOnline}
									title={!isOnline ? t("common:offlineActionDisabled") : undefined}
									onClick={() => {
										dialogHost.openCreateTagDialog()
									}}
								>
									<PlusIcon />
									{t("noteActionCreateTag")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						{/* The actual file picker: hidden, triggered by the menu item above. Its `accept` is
						the widened import union (import.logic.ts), and the value resets after every pick so
						re-selecting the same file still fires a change event. */}
						<input
							ref={importInputRef}
							type="file"
							accept={importAcceptAttribute()}
							className="hidden"
							onChange={event => {
								const file = event.target.files?.[0]
								event.target.value = ""

								if (file) {
									void handleImportFile(file)
								}
							}}
						/>
					</div>
				</div>

				<ListFilterInput
					value={search}
					onChange={setSearch}
					placeholder={t("notesSearch")}
					ariaLabel={t("notesSearch")}
					wrapperClassName="app-region-no-drag"
				/>

				<div className="flex items-center gap-1.5">
					<div
						role="group"
						aria-label={t("notesViewToggleLabel")}
						className="flex flex-1 gap-0.5 rounded-lg bg-muted p-0.5 app-region-no-drag"
					>
						<button
							type="button"
							aria-pressed={viewMode === "notes"}
							onClick={() => {
								void handleViewModeChange("notes")
							}}
							className={segmentClass(viewMode === "notes")}
						>
							{t("notesViewNotes")}
						</button>
						<button
							type="button"
							aria-pressed={viewMode === "tags"}
							onClick={() => {
								void handleViewModeChange("tags")
							}}
							className={segmentClass(viewMode === "tags")}
						>
							{t("notesViewTags")}
						</button>
					</div>
					{/* Tags-view sort control, shown only in the view it applies to (the notes view has its
					own date-grouping instead, no sort control of its own). */}
					{viewMode === "tags" ? (
						<TagsSortMenu
							value={tagsSortBy}
							onChange={next => {
								void handleTagsSortChange(next)
							}}
						/>
					) : null}
				</div>
			</div>

			<div className="relative flex min-h-0 flex-1 flex-col">
				<div
					ref={setScrollElement}
					className="flex flex-1 flex-col overflow-y-auto px-1.5 pb-3 app-region-pane"
				>
					<NotesSidebarList
						rows={rows}
						scrollElement={scrollElement}
						fallback={renderFallback()}
						label={t("notesListLabel")}
						selectedUuid={selectedUuid}
						liveSelectedUuids={liveSelectedUuids}
						nested={viewMode === "tags"}
						allTags={allTags}
						currentUserId={currentUserId}
						selectableIndexByRowKey={selectableIndexByRowKey}
						onToggleTag={toggleTag}
						onOpenNote={openNote}
						onTagAction={dialogHost.openTagDialog}
						onNoteAction={dialogHost.openNoteDialog}
						onPointerSelect={selection.handlePointerSelect}
						onToggleSelect={selection.toggleAt}
					/>
				</div>
				{/* Bottom-anchored floating selection bar — overlays the scroll container, replacing
				    nothing in the header. Mirrors directoryListing.tsx's own BulkActionBar placement. Shown
				    at 2+ selected only — a single selection is just normal browsing. */}
				{liveSelectedNotes.length >= BULK_BAR_MIN_SELECTION ? (
					<div className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex justify-center">
						<NotesBulkActionBar
							selectedNotes={liveSelectedNotes}
							allTags={allTags}
							currentUserId={currentUserId}
							onDialogAction={dialogHost.openBulkDialog}
						/>
					</div>
				) : null}
			</div>
			{dialogHost.renderActiveDialog()}
		</ResizableSidebarPanel>
	)
}

interface NotesSidebarListProps {
	rows: NotesSidebarRow[]
	scrollElement: HTMLDivElement | null
	// Rendered instead of the list (loading, error, empty) while non-null.
	fallback: ReactNode
	label: string
	selectedUuid: string
	liveSelectedUuids: ReadonlySet<string>
	nested: boolean
	allTags: readonly NoteTag[]
	currentUserId: bigint | undefined
	selectableIndexByRowKey: ReadonlyMap<string, number>
	onToggleTag: (uuid: string) => void
	onOpenNote: (note: Note) => Promise<void>
	onTagAction: (kind: NoteTagDialogKind, tag: NoteTag) => void
	onNoteAction: (kind: NoteActionDialogKind, note: Note) => void
	onPointerSelect: ListPointerSelection["handlePointerSelect"]
	onToggleSelect: ListPointerSelection["toggleAt"]
}

// Owns the virtualizer, which opts its host out of the React Compiler and re-renders it on every range
// change while scrolling; split out so NotesSidebar itself compiles and those renders stay here. Mounted in
// every state, so the virtualizer and its measurement cache live exactly as long as the sidebar.
function NotesSidebarList({
	rows,
	scrollElement,
	fallback,
	label,
	selectedUuid,
	liveSelectedUuids,
	nested,
	allTags,
	currentUserId,
	selectableIndexByRowKey,
	onToggleTag,
	onOpenNote,
	onTagAction,
	onNoteAction,
	onPointerSelect,
	onToggleSelect
}: NotesSidebarListProps) {
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollElement,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: index => {
			const kind = rows[index]?.kind

			return kind === "tag" ? TAG_ROW_ESTIMATE : kind === "header" ? HEADER_ROW_ESTIMATE : NOTE_ROW_ESTIMATE
		},
		overscan: 10,
		getItemKey: index => {
			const row = rows[index]

			return row !== undefined ? sidebarRowKey(row) : index
		}
	})

	// The focus stop (note link, tag button) of the row at `index`, once the virtualizer has it mounted.
	function rowStop(list: Element, index: number): HTMLElement | null {
		return list.querySelector<HTMLElement>(`li[data-index="${String(index)}"] [data-notes-row]`)
	}

	// A row scrolled in from outside the window mounts on a later frame; a few are plenty.
	function focusRow(list: Element, index: number, framesLeft: number): void {
		const stop = rowStop(list, index)

		if (stop !== null) {
			stop.focus()
		} else if (framesLeft > 0) {
			requestAnimationFrame(() => {
				focusRow(list, index, framesLeft - 1)
			})
		}
	}

	// Arrow keys, Home and End move between rows and Left/Right fold tags (notesRowKeyTarget), from a row's own
	// focus stop only: its ⋯ trigger owns its keys. A chord is some shortcut's, and Shift is left to the page.
	function handleKeyDown(event: ReactKeyboardEvent<HTMLUListElement>): void {
		if (event.defaultPrevented || event.shiftKey || hasCommandModifier(event) || isImeKeydown(event.nativeEvent)) {
			return
		}

		if (!(event.target instanceof HTMLElement) || !event.target.hasAttribute("data-notes-row")) {
			return
		}

		const from = Number(event.target.closest<HTMLElement>("li[data-index]")?.dataset["index"] ?? "-1")
		const result = notesRowKeyTarget(rows, from, event.key)

		if (result === null) {
			return
		}

		event.preventDefault()

		if (result.kind === "toggleTag") {
			const row = rows[from]

			if (row?.kind === "tag") {
				onToggleTag(row.tag.uuid)
			}

			return
		}

		const list = event.currentTarget

		if (rowStop(list, result.index) === null) {
			virtualizer.scrollToIndex(result.index)
		}

		focusRow(list, result.index, 3)
	}

	if (fallback !== null) {
		return fallback
	}

	return (
		// A plain list, deliberately neither tree nor listbox: both patterns owe a single-Tab-stop roving
		// focus model (every row link here stays its own Tab stop; the arrow keys above are a shortcut
		// between them, not that model), and one flat virtualizer cannot nest
		// DOM levels anyway — so the grouping stays where it honestly is, in the flat row order, with
		// each tag row's own aria-expanded as the only disclosure claim (same shape as the drive
		// sidebar's disclosure list). Positions are threaded per item because virtualization mounts
		// only a window: the DOM child count here is never the real total.
		<ul
			aria-label={label}
			onKeyDown={handleKeyDown}
			className="relative w-full"
			style={{ height: virtualizer.getTotalSize() }}
		>
			{virtualizer.getVirtualItems().map(virtualRow => {
				const row = rows[virtualRow.index]

				if (row === undefined) {
					return null
				}

				return (
					<li
						key={virtualRow.key}
						data-index={virtualRow.index}
						aria-posinset={virtualRow.index + 1}
						aria-setsize={rows.length}
						ref={element => {
							virtualizer.measureElement(element)
						}}
						className="absolute top-0 left-0 w-full"
						style={{ transform: `translateY(${String(virtualRow.start)}px)` }}
					>
						{row.kind === "header" ? (
							<NotesGroupHeader row={row} />
						) : row.kind === "tag" ? (
							<TagGroupRow
								row={row}
								onToggle={() => {
									onToggleTag(row.tag.uuid)
								}}
								onTagAction={onTagAction}
								onCreateNoteInTag={created => {
									void onOpenNote(created)
								}}
							/>
						) : (
							<NoteRow
								note={row.note}
								selected={row.note.uuid === selectedUuid}
								multiSelected={liveSelectedUuids.has(row.note.uuid)}
								nested={nested}
								allTags={allTags}
								currentUserId={currentUserId}
								onAction={onNoteAction}
								onDuplicated={duplicated => {
									void onOpenNote(duplicated)
								}}
								onPointerSelect={(event, pointerType) =>
									onPointerSelect(selectableIndexByRowKey.get(sidebarRowKey(row)) ?? -1, event, pointerType)
								}
								onLongPress={() => {
									onToggleSelect(selectableIndexByRowKey.get(sidebarRowKey(row)) ?? -1)
								}}
							/>
						)}
					</li>
				)
			})}
		</ul>
	)
}
