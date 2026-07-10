import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate, useRouterState } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { PlusIcon, SearchIcon, XIcon, ChevronRightIcon, StarIcon, StickyNoteIcon, TagIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useNotes } from "@/features/notes/queries/notes"
import { useNoteTags } from "@/features/notes/queries/noteTags"
import { useNotesViewModeQuery } from "@/features/notes/queries/preferences"
import { setNotesViewMode, DEFAULT_NOTES_VIEW_MODE, type NotesViewMode } from "@/features/notes/lib/preferences"
import { DEFAULT_NOTE_TAGS_SORT_BY, tagDisplayName } from "@/features/notes/lib/sort"
import {
	buildNotesView,
	buildNotesByTag,
	buildTagsViewRows,
	sidebarRowKey,
	type NotesSidebarRow
} from "@/features/notes/components/notesSidebar.logic"
import { createNote } from "@/features/notes/lib/actions"
import { NoteRow } from "@/features/notes/components/noteRow"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"

// Fixed row heights so the single virtualizer needs no measureElement pass — both row kinds render at a
// known, constant height (the wrapper pins it), so estimateSize is exact and rows never overlap. Note
// rows are taller (title + preview lines); tag headers are one line.
const NOTE_ROW_HEIGHT = 56
const TAG_ROW_HEIGHT = 40

// The URL owns the selected note: /notes/<uuid> is a selection key, not a path hierarchy (D4). The
// sidebar renders in the app shell (outside the notes route match), so it reads the raw pathname rather
// than route params. Empty at "/notes" (nothing selected).
function selectedUuidFromPath(pathname: string): string {
	const match = /^\/notes\/([^/]+)/.exec(pathname)

	return match?.[1] ?? ""
}

// Compact centered empty/error state, sized for the narrow sidebar (not the full-page Empty primitive).
function SidebarNotice({ icon, title, description }: { icon: ReactNode; title: string; description?: string }) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
			<div className="text-muted-foreground [&_svg]:size-6">{icon}</div>
			<p className="text-sm font-medium">{title}</p>
			{description !== undefined ? <p className="text-xs text-muted-foreground">{description}</p> : null}
		</div>
	)
}

function segmentClass(active: boolean): string {
	return cn(
		"flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors outline-none app-region-no-drag focus-visible:ring-3 focus-visible:ring-ring/30",
		active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
	)
}

function TagGroupRow({ row, onToggle }: { row: Extract<NotesSidebarRow, { kind: "tag" }>; onToggle: () => void }) {
	const { t } = useTranslation("notes")
	const name = tagDisplayName(row.tag)

	return (
		<button
			type="button"
			aria-expanded={row.expanded}
			aria-label={t(row.expanded ? "notesTagCollapse" : "notesTagExpand", { name })}
			onClick={onToggle}
			className="group flex h-full w-full items-center gap-1.5 rounded-xl px-2.5 text-left transition-colors outline-none app-region-no-drag hover:bg-sidebar-accent/60 focus-visible:ring-3 focus-visible:ring-ring/30"
		>
			<ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", row.expanded && "rotate-90")} />
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
	)
}

export function NotesSidebar() {
	const { t } = useTranslation("notes")
	const navigate = useNavigate()
	const pathname = useRouterState({ select: state => state.location.pathname })
	const selectedUuid = selectedUuidFromPath(pathname)

	const notesQuery = useNotes()
	const tagsQuery = useNoteTags()
	const viewModeQuery = useNotesViewModeQuery()
	const viewMode = viewModeQuery.data ?? DEFAULT_NOTES_VIEW_MODE

	const [search, setSearch] = useState("")
	// Collapse state is in-memory only (D4) — a tag uuid present here is expanded.
	const [expandedTags, setExpandedTags] = useState<ReadonlySet<string>>(() => new Set())
	const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)

	const allNotes = notesQuery.data ?? []
	const allTags = tagsQuery.data ?? []

	// One flattened row model for BOTH views, so a single virtualizer covers either (never a nested
	// virtualizer per tag). Notes view: each note as a flat note row. Tags view: tag headers + expanded
	// member notes interleaved.
	const rows: NotesSidebarRow[] =
		viewMode === "notes"
			? buildNotesView(allNotes, search).map(note => ({ kind: "note", note, tagUuid: "" }))
			: buildTagsViewRows({
					tags: allTags,
					notesByTag: buildNotesByTag(allNotes),
					expandedTagUuids: expandedTags,
					search,
					sortBy: DEFAULT_NOTE_TAGS_SORT_BY
				})

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollElement,
		estimateSize: index => (rows[index]?.kind === "tag" ? TAG_ROW_HEIGHT : NOTE_ROW_HEIGHT),
		overscan: 10,
		getItemKey: index => {
			const row = rows[index]

			return row !== undefined ? sidebarRowKey(row) : index
		}
	})

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
		const note = await createNote()

		await navigate({ to: "/notes/$uuid", params: { uuid: note.uuid } })
	}

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
							className="absolute top-0 left-0 w-full"
							style={{
								height: row.kind === "tag" ? TAG_ROW_HEIGHT : NOTE_ROW_HEIGHT,
								transform: `translateY(${String(virtualRow.start)}px)`
							}}
						>
							{row.kind === "tag" ? (
								<TagGroupRow
									row={row}
									onToggle={() => {
										toggleTag(row.tag.uuid)
									}}
								/>
							) : (
								<NoteRow
									note={row.note}
									selected={row.note.uuid === selectedUuid}
									nested={viewMode === "tags"}
								/>
							)}
						</div>
					)
				})}
			</div>
		)
	}

	return (
		<aside
			// Geometry identical to DriveSidebar (w-52, rounded-xl, borderless) — the shell's contextual
			// panel slot. Drag region is Electron plumbing, inert in a plain browser; interactive
			// descendants opt back out with app-region-no-drag.
			className="hidden w-52 shrink-0 flex-col rounded-xl bg-sidebar app-region-drag md:flex"
		>
			<div className="flex flex-col gap-2 p-3">
				<div className="flex items-center justify-between gap-2">
					<h2 className="truncate px-1 text-[15px] font-semibold">{t("notesSidebarTitle")}</h2>
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

				<div
					role="group"
					aria-label={t("notesViewToggleLabel")}
					className="flex gap-0.5 rounded-lg bg-muted p-0.5 app-region-no-drag"
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
			</div>

			<div
				ref={setScrollElement}
				className="flex flex-1 flex-col overflow-y-auto px-1.5 pb-3"
			>
				{renderBody()}
			</div>
		</aside>
	)
}
