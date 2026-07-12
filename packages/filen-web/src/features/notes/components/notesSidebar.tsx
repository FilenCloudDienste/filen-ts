import { Fragment, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useShallow } from "zustand/shallow"
import { toast } from "sonner"
import {
	PlusIcon,
	SearchIcon,
	XIcon,
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
import { cn } from "@/lib/utils"
import { useNotes } from "@/features/notes/queries/notes"
import { useNoteTags } from "@/features/notes/queries/noteTags"
import { useNotesViewModeQuery, useNoteTagsSortByQuery } from "@/features/notes/queries/preferences"
import { useAccountQuery } from "@/queries/account"
import { useBlockedUsers } from "@/features/contacts/hooks/useBlockedUsers"
import { setNotesViewMode, DEFAULT_NOTES_VIEW_MODE, setNoteTagsSortBy, type NotesViewMode } from "@/features/notes/lib/preferences"
import { DEFAULT_NOTE_TAGS_SORT_BY, tagDisplayName, type NoteTagsSortBy } from "@/features/notes/lib/sort"
import {
	buildNotesGroupedRows,
	buildNotesByTag,
	buildTagsViewRows,
	filterNotesByBlockedOwner,
	sidebarRowKey,
	selectableNotesFromRows,
	selectableRowIndexByKey,
	type NotesSidebarRow,
	type NotesGroupIcon
} from "@/features/notes/components/notesSidebar.logic"
import { createNote } from "@/features/notes/lib/actions"
import { exportAllNotes } from "@/features/notes/lib/export"
import { importNoteFromFile } from "@/features/notes/lib/import"
import { importAcceptAttribute } from "@/features/notes/lib/import.logic"
import { selectableNotesForSelectAll } from "@/features/notes/lib/selectionFlags"
import { useNotesSelectionStore } from "@/features/notes/store/useNotesSelectionStore"
import { useNotesListSelection } from "@/features/notes/hooks/useNotesListSelection"
import { useNoteDialogHost } from "@/features/notes/hooks/useNoteDialogHost"
import { useNoteSearchBodies } from "@/features/notes/hooks/useNoteSearchBodies"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { registerAction } from "@/lib/keymap/registry"
import { useAction } from "@/lib/keymap/useAction"
import { useResizableSidebar } from "@/features/shell/hooks/useResizableSidebar"
import { SidebarResizeHandle } from "@/features/shell/components/sidebarResizeHandle"
import { NoteRow } from "@/features/notes/components/noteRow"
import { NotesBulkActionBar } from "@/features/notes/components/notesBulkActionBar"
import { TagContextMenuContent } from "@/features/notes/components/noteMenu"
import { type NoteTagDialogKind } from "@/features/notes/components/noteMenu.logic"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
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

// Module scope, not inside the component — mirrors drive's "drive.newDirectory" registration
// (newDirectory.tsx): runs once per module evaluation, which registerAction's duplicate-id guard
// assumes. Same default combo ("n") as drive's own new-item command — the two never coexist (only one
// of NotesSidebar/NewDirectory is ever mounted at a time, since they live on mutually exclusive routes).
registerAction({ id: "notes.newNote", defaultCombo: "n", scope: "notes", descriptionKey: "notesNewNote" })
// Multi-select commands — mirrors drive.selectAll/drive.clearSelection (directoryListing.tsx) exactly:
// mod+a selects every currently-visible (search-filtered) decryptable note, Escape clears the
// selection. Both fire through react-hotkeys-hook's default ignore-list, which already skips real
// form-tag targets (the search `<Input>`), so these never fight that box's own local
// Escape-clears-search handling below.
registerAction({ id: "notes.selectAll", defaultCombo: "mod+a", scope: "notes", descriptionKey: "notesCommandSelectAll" })
registerAction({ id: "notes.clearSelection", defaultCombo: "escape", scope: "notes", descriptionKey: "notesCommandClearSelection" })

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
// virtualizer positions it absolutely like every other row).
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

// The URL owns the selected note: /notes/<uuid> is a selection key, not a path hierarchy. The
// sidebar renders in the app shell (outside the notes route match), so it reads the raw pathname rather
// than route params. Empty at "/notes" (nothing selected).
function selectedUuidFromPath(pathname: string): string {
	const match = /^\/notes\/([^/]+)/.exec(pathname)

	return match?.[1] ?? ""
}

// Compact centered empty/error state, sized for the narrow sidebar (not the full-page Empty primitive).
function SidebarNotice({ icon, title, description, action }: { icon: ReactNode; title: string; description?: string; action?: ReactNode }) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
			<div className="text-muted-foreground [&_svg]:size-6">{icon}</div>
			<p className="text-sm font-medium">{title}</p>
			{description !== undefined ? <p className="text-xs text-muted-foreground">{description}</p> : null}
			{action}
		</div>
	)
}

function segmentClass(active: boolean): string {
	return cn(
		"flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors outline-none app-region-no-drag focus-visible:ring-3 focus-visible:ring-ring/30",
		active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
	)
}

function TagGroupRow({
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

	return (
		<ContextMenu>
			{/* Same render-prop merge as NoteRow's own trigger — Base UI merges onContextMenu + ref onto
			the button rather than wrapping it, so the row's geometry stays untouched. */}
			<ContextMenuTrigger
				render={
					<button
						type="button"
						aria-expanded={row.expanded}
						aria-label={t(row.expanded ? "notesTagCollapse" : "notesTagExpand", { name })}
						onClick={onToggle}
						className="group flex w-full items-center gap-1.5 rounded-xl px-2.5 py-2 text-left transition-colors outline-none app-region-no-drag hover:bg-sidebar-accent/60 focus-visible:ring-3 focus-visible:ring-ring/30"
					>
						<ChevronRightIcon
							className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", row.expanded && "rotate-90")}
						/>
						<TagIcon className="size-4 shrink-0 text-muted-foreground" />
						<span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
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
				}
			/>
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
	const { t } = useTranslation("notes")
	const navigate = useNavigate()
	const pathname = useRouterState({ select: state => state.location.pathname })
	const selectedUuid = selectedUuidFromPath(pathname)

	const resize = useResizableSidebar("notes")
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

	// This filter is applied BEFORE either view builds its rows, so a blocked note's uuid is simply absent
	// from every downstream derivation (rows, selectableNotes, the live-selection re-derivation below) —
	// the same "just don't include it" mechanism the selection ghost-purge already relies on, no separate
	// purge step needed.
	const allNotes = filterNotesByBlockedOwner(notesQuery.data ?? [], blocked)
	const allTags = tagsQuery.data ?? []
	// Eager, opt-in full-body fetch feeding the filters below; see useNoteSearchBodies.ts's own
	// doc comment for why this never fires a single request outside an active search.
	const searchBodies = useNoteSearchBodies(allNotes, search)

	// One host for every row's menu (noteRow.tsx never opens a dialog itself — it only calls onAction).
	// currentUuid drives the delete/leave nav-away guard: a row-triggered delete of the currently-open
	// note still navigates to /notes before the row disappears out of the cache.
	const dialogHost = useNoteDialogHost({ currentUuid: selectedUuid })

	// One flattened row model for BOTH views, so a single virtualizer covers either (never a nested
	// virtualizer per tag). Notes view: each note as a flat note row. Tags view: tag headers + expanded
	// member notes interleaved.
	const rows: NotesSidebarRow[] =
		viewMode === "notes"
			? buildNotesGroupedRows(allNotes, search, Date.now(), searchBodies)
			: buildTagsViewRows({
					tags: allTags,
					notesByTag: buildNotesByTag(allNotes),
					expandedTagUuids: expandedTags,
					search,
					sortBy: tagsSortBy,
					bodies: searchBodies
				})

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollElement,
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

	// The ordered, currently-visible note set click-selection ranges walk (search-filtered, spans both
	// views). A view switch (viewMode) resets the selection/anchor, mirroring how a fresh directory
	// resets drive's own selection on navigation.
	const selectableNotes = selectableNotesFromRows(rows)
	const selection = useNotesListSelection({ notes: selectableNotes, resetKey: viewMode })
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

	async function handleViewModeChange(next: NotesViewMode): Promise<void> {
		if (next === viewMode) {
			return
		}

		await setNotesViewMode(next)
		await viewModeQuery.refetch()
	}

	function toggleTag(uuid: string): void {
		setExpandedTags(prev => {
			const next = new Set(prev)

			if (next.has(uuid)) {
				next.delete(uuid)
			} else {
				next.add(uuid)
			}

			return next
		})
	}

	async function handleNewNote(): Promise<void> {
		const outcome = await createNote()

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		await navigate({ to: "/notes/$uuid", params: { uuid: outcome.item.uuid } })
	}

	async function handleDuplicated(duplicated: Note): Promise<void> {
		await navigate({ to: "/notes/$uuid", params: { uuid: duplicated.uuid } })
	}

	// Same "navigate to the freshly created note" tail as handleDuplicated/handleNewNote, fired once the
	// tag-menu's own create-then-tag round trip (noteMenu.tsx) resolves.
	async function handleCreateNoteInTag(created: Note): Promise<void> {
		await navigate({ to: "/notes/$uuid", params: { uuid: created.uuid } })
	}

	async function handleExportAll(): Promise<void> {
		const outcome = await exportAllNotes(allNotes)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	// The hidden file input's onChange: detect+sanitize+create all happen inside importNoteFromFile
	// (lib/import.ts); this only resolves the outcome and navigates, same shape as handleNewNote. Resets
	// the input's value after every pick (success or failure) so choosing the SAME file twice in a row
	// still fires a change event.
	async function handleImportFile(file: File): Promise<void> {
		const outcome = await importNoteFromFile(file)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
			return
		}

		await navigate({ to: "/notes/$uuid", params: { uuid: outcome.item.uuid } })
	}

	async function handleTagsSortChange(next: NoteTagsSortBy): Promise<void> {
		await setNoteTagsSortBy(next)
		await tagsSortByQuery.refetch()
	}

	// Registered at module scope above; guards on dialogHost.isDialogOpen so "n" never fires a second
	// create while a note dialog (rename/delete/leave/createTag) is already open — same convention as
	// drive.newDirectory's own dialogOpen guard.
	useAction(
		"notes.newNote",
		() => {
			if (!dialogHost.isDialogOpen) {
				void handleNewNote()
			}
		},
		undefined,
		[dialogHost.isDialogOpen]
	)

	// Registered at module scope above. Browser default for mod+a is "select all page text" — must
	// preventDefault or the native selection would visibly compete with the note-row selection.
	// Guarded on dialogHost.isDialogOpen so a background Cmd+A can't select notes behind an open
	// dialog. Targets `selectableNotes` (already search-filtered) minus undecryptable ones — mirrors
	// drive.selectAll exactly.
	useAction(
		"notes.selectAll",
		event => {
			if (dialogHost.isDialogOpen) {
				return
			}

			event.preventDefault()
			useNotesSelectionStore.getState().setSelectedNotes(selectableNotesForSelectAll(selectableNotes))
		},
		undefined,
		[dialogHost.isDialogOpen, selectableNotes]
	)

	// Registered at module scope above. No preventDefault — bare Escape has no disruptive browser
	// default. Guarded on dialogHost.isDialogOpen so Escape closes the dialog (its own onOpenChange
	// handling) without also clearing the background selection.
	useAction(
		"notes.clearSelection",
		() => {
			if (dialogHost.isDialogOpen) {
				return
			}

			useNotesSelectionStore.getState().clearSelectedNotes()
		},
		undefined,
		[dialogHost.isDialogOpen]
	)

	const activeQuery = viewMode === "notes" ? notesQuery : tagsQuery
	const searching = search.trim().length > 0

	function renderBody(): ReactNode {
		if (activeQuery.isPending) {
			return (
				<div className="flex flex-1 items-center justify-center py-8">
					<Spinner className="size-5 text-muted-foreground" />
				</div>
			)
		}

		if (activeQuery.isError) {
			return (
				<SidebarNotice
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

		return (
			<div
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(virtualRow => {
					const row = rows[virtualRow.index]

					if (row === undefined) {
						return null
					}

					return (
						<div
							key={virtualRow.key}
							data-index={virtualRow.index}
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
										toggleTag(row.tag.uuid)
									}}
									onTagAction={dialogHost.openTagDialog}
									onCreateNoteInTag={created => {
										void handleCreateNoteInTag(created)
									}}
								/>
							) : (
								<NoteRow
									note={row.note}
									selected={row.note.uuid === selectedUuid}
									multiSelected={liveSelectedUuids.has(row.note.uuid)}
									nested={viewMode === "tags"}
									allTags={allTags}
									currentUserId={currentUserId}
									onAction={dialogHost.openNoteDialog}
									onDuplicated={duplicated => {
										void handleDuplicated(duplicated)
									}}
									onPointerSelect={event => {
										selection.handlePointerSelect(selectableIndexByRowKey.get(sidebarRowKey(row)) ?? -1, event)
									}}
								/>
							)}
						</div>
					)
				})}
			</div>
		)
	}

	return (
		<Fragment>
			<aside
				// Geometry mirrors DriveSidebar (rounded-xl, borderless) — the shell's contextual panel slot.
				// Width is user-resizable (useResizableSidebar) — the inline style replaces the old static
				// w-52 utility, and a trailing drag-handle sibling (below) commits the new width. Drag region
				// is Electron plumbing, inert in a plain browser; interactive descendants opt back out with
				// app-region-no-drag.
				className="hidden shrink-0 flex-col rounded-xl bg-sidebar app-region-drag md:flex"
				style={{ width: resize.width }}
			>
				<div className="flex flex-col gap-2 p-3">
					<div className="flex items-center justify-between gap-2">
						<h2 className="truncate px-1 text-[15px] font-semibold">{t("notesSidebarTitle")}</h2>
						<div className="flex items-center gap-0.5">
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("notesNewNote")}
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
										onClick={() => {
											importInputRef.current?.click()
										}}
									>
										<UploadIcon />
										{t("notesImportAction")}
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem
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

					<div className="relative app-region-no-drag">
						<SearchIcon
							aria-hidden="true"
							className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
						/>
						<Input
							type="search"
							aria-label={t("notesSearch")}
							placeholder={t("notesSearch")}
							value={search}
							onChange={event => {
								setSearch(event.target.value)
							}}
							onKeyDown={event => {
								if (event.key === "Escape" && search.length > 0) {
									event.preventDefault()
									setSearch("")
								}
							}}
							className="h-8 pr-8 pl-8"
						/>
						{search.length > 0 ? (
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label={t("notesSearchClear")}
								className="absolute top-1/2 right-1.5 -translate-y-1/2"
								onClick={() => {
									setSearch("")
								}}
							>
								<XIcon />
							</Button>
						) : null}
					</div>

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
						className="flex flex-1 flex-col overflow-y-auto px-1.5 pb-3"
					>
						{renderBody()}
					</div>
					{/* Bottom-anchored floating selection bar — overlays the scroll container, replacing
				    nothing in the header. Mirrors directoryListing.tsx's own BulkActionBar placement. Shown
				    at 2+ selected only — a single selection is just normal browsing. */}
					{liveSelectedNotes.length > 1 ? (
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
			</aside>
			<SidebarResizeHandle
				ariaLabel={t("notesSidebarResize")}
				onPointerDown={resize.onPointerDown}
				onPointerMove={resize.onPointerMove}
				onPointerUp={resize.onPointerUp}
			/>
		</Fragment>
	)
}
