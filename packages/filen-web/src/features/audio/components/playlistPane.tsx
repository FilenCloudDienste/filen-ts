import { useId, useLayoutEffect, useRef, useState, type DragEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { useVirtualizer } from "@tanstack/react-virtual"
import { formatBytes, formatSecondsToMediaClock } from "@filen/shared"
import { AudioLinesIcon, GripVerticalIcon, MoreHorizontalIcon, MusicIcon, PlayIcon, PlusIcon, ShuffleIcon, XIcon } from "lucide-react"
import { removeTracksFromPlaylistAction, reorderPlaylistFileAction } from "@/features/audio/lib/playlists"
import { AddPlaylistTracksDialog } from "@/features/audio/components/addPlaylistTracksDialog"
import { PlaylistArtwork } from "@/features/audio/components/playlistArtwork"
import { PlaylistMenuContent } from "@/features/audio/components/playlistMenu"
import { startPlaylist, startShuffledPlaylist } from "@/features/audio/lib/playlistPlayback"
import { useAudioStore } from "@/features/audio/store/useAudioStore"
import { isTrackReorderDrag, TRACK_DRAG_TYPE } from "@/features/audio/lib/trackDnd"
import { useKnownCoverUrl, useTrackMetadata } from "@/features/audio/hooks/useTrackMetadata"
import { trackDisplayTitle } from "@/features/audio/lib/trackTags.logic"
import type { Playlist, PlaylistFile } from "@filen/shared"
import { formatRelativeTime } from "@/lib/relativeTime"
import { useNowMinute } from "@/lib/useNowMinute"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"

// Fixed row height (a 36px cover plus the cell padding), so the virtualizer never has to measure a row.
const TRACK_ROW_HEIGHT = 48
const TRACK_ROW_OVERSCAN = 8
const INITIAL_VIEWPORT_HEIGHT = 800
// Every column, the ones hidden at narrow widths included, so a spacer row always spans the table.
const TRACK_COLUMN_COUNT = 6

// The selected playlist, inline in the /playlists main pane: a hero (artwork, name as the page's h1,
// meta, Play/Shuffle/Add tracks/⋯) over its track table. Play-from-row keeps mobile #49 semantics
// (replaces the queue positioned at that row), drag-reorder is trackDnd.ts's native HTML5 idiom, and
// `playlist` is always the live query-cache copy, so every mutation's confirm-then-patch lands here
// without optimistic state of its own. The table is virtualized: only rows on screen mount, and only a
// mounted row reads its track's tags.
export function PlaylistPane({ playlist }: { playlist: Playlist }) {
	const { t } = useTranslation("audio")
	const headingId = useId()
	const isOnline = useIsOnline()
	const [addOpen, setAddOpen] = useState(false)
	const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)
	const [headerElement, setHeaderElement] = useState<HTMLElement | null>(null)
	// One primitive for the whole table, so only a track change re-renders it (never playback progress).
	const currentTrackUuid = useAudioStore(state => state.queue[state.currentIndex]?.uuid ?? null)
	const heroCoverUrl = useKnownCoverUrl(playlist.files[0])
	const hasTracks = playlist.files.length > 0
	const totalSize = playlist.files.reduce((sum, file) => sum + file.size, 0)

	return (
		<section
			ref={setScrollElement}
			aria-labelledby={headingId}
			className="flex min-h-0 flex-1 flex-col overflow-y-auto"
		>
			<header
				ref={setHeaderElement}
				className="flex flex-col gap-5 px-6 pt-8 pb-6 sm:flex-row sm:items-end"
			>
				<PlaylistArtwork
					uuid={playlist.uuid}
					coverUrl={heroCoverUrl}
					className="size-32 rounded-2xl shadow-sm sm:size-40"
					iconClassName="size-12 sm:size-14"
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("playlistEyebrow")}</p>
					<h1
						id={headingId}
						title={playlist.name}
						className="truncate text-2xl font-semibold tracking-tight sm:text-3xl"
					>
						{playlist.name}
					</h1>
					<p className="truncate text-sm text-muted-foreground">
						{t("playlistTrackCount", { count: playlist.files.length })} · {formatBytes(totalSize)} ·{" "}
						<PlaylistUpdated updated={playlist.updated} />
					</p>
					<div className="mt-3 flex flex-wrap items-center gap-2">
						<Button
							disabled={!hasTracks}
							onClick={() => {
								startPlaylist(playlist, 0)
							}}
						>
							<PlayIcon />
							{t("play")}
						</Button>
						<Button
							variant="outline"
							disabled={!hasTracks}
							onClick={() => {
								startShuffledPlaylist(playlist)
							}}
						>
							<ShuffleIcon />
							{t("shufflePlay")}
						</Button>
						<Button
							variant="outline"
							disabled={!isOnline}
							onClick={() => {
								setAddOpen(true)
							}}
						>
							<PlusIcon />
							{t("addTracks")}
						</Button>
						<DropdownMenu>
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon"
										aria-label={t("playlistItemMenuTrigger")}
									>
										<MoreHorizontalIcon />
									</Button>
								}
							/>
							<PlaylistMenuContent
								playlist={playlist}
								playback={false}
							/>
						</DropdownMenu>
					</div>
				</div>
			</header>
			<div className="px-4 pb-6">
				{!hasTracks ? (
					<Empty className="border-none p-10">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<MusicIcon />
							</EmptyMedia>
							<EmptyTitle>{t("playlistTracksEmptyTitle")}</EmptyTitle>
							<EmptyDescription>{t("playlistTracksEmptyBody")}</EmptyDescription>
						</EmptyHeader>
					</Empty>
				) : (
					<table
						aria-rowcount={playlist.files.length + 1}
						className="w-full table-fixed border-separate border-spacing-0 text-sm"
					>
						<thead className="sticky top-0 z-10 bg-card text-xs text-muted-foreground">
							<tr aria-rowindex={1}>
								<th
									scope="col"
									className="w-10 border-b border-border py-2 text-center font-normal"
								>
									{t("trackColumnNumber")}
								</th>
								<th
									scope="col"
									className="border-b border-border px-2 py-2 text-left font-normal"
								>
									{t("trackColumnTitle")}
								</th>
								<th
									scope="col"
									className="hidden w-[30%] border-b border-border px-2 py-2 text-left font-normal md:table-cell"
								>
									{t("trackColumnAlbum")}
								</th>
								<th
									scope="col"
									className="w-16 border-b border-border px-2 py-2 text-right font-normal"
								>
									{t("trackColumnDuration")}
								</th>
								<th
									scope="col"
									className="hidden w-24 border-b border-border px-2 py-2 text-right font-normal lg:table-cell"
								>
									{t("trackColumnSize")}
								</th>
								<th
									scope="col"
									className="w-10 border-b border-border"
								>
									<span className="sr-only">{t("trackColumnActions")}</span>
								</th>
							</tr>
						</thead>
						<TrackTableBody
							playlist={playlist}
							scrollElement={scrollElement}
							headerElement={headerElement}
							currentTrackUuid={currentTrackUuid}
							disabled={!isOnline}
						/>
					</table>
				)}
			</div>
			{addOpen ? (
				<AddPlaylistTracksDialog
					playlist={playlist}
					onClose={() => {
						setAddOpen(false)
					}}
				/>
			) : null}
		</section>
	)
}

// The virtualized rows, in their own component: the React Compiler skips any component that calls
// useVirtualizer, so keeping it here leaves the pane around it compiled, and each row (compiled, with
// props that stay stable across scrolls) re-renders only when its own state changes.
function TrackTableBody({
	playlist,
	scrollElement,
	headerElement,
	currentTrackUuid,
	disabled
}: {
	playlist: Playlist
	scrollElement: HTMLElement | null
	headerElement: HTMLElement | null
	currentTrackUuid: string | null
	disabled: boolean
}) {
	const [removingUuid, setRemovingUuid] = useState<string | null>(null)
	const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
	const tbodyRef = useRef<HTMLTableSectionElement>(null)
	// Where the first row sits within the scrolled content (hero plus table head), so the virtualizer
	// measures rows from there. Re-measured when the hero reflows (a wrapping name, a narrow window).
	const [rowsOffset, setRowsOffset] = useState(0)
	const virtualizer = useVirtualizer({
		count: playlist.files.length,
		getScrollElement: () => scrollElement,
		estimateSize: () => TRACK_ROW_HEIGHT,
		overscan: TRACK_ROW_OVERSCAN,
		scrollMargin: rowsOffset,
		getItemKey: index => playlist.files[index]?.uuid ?? index,
		// Rows to render before the scroller has been measured (first paint, and jsdom, which never lays out).
		initialRect: { width: 0, height: INITIAL_VIEWPORT_HEIGHT }
	})
	const virtualRows = virtualizer.getVirtualItems()
	const firstRow = virtualRows.at(0)
	const lastRow = virtualRows.at(-1)
	const paddingTop = firstRow !== undefined ? firstRow.start - rowsOffset : 0
	const paddingBottom = lastRow !== undefined ? virtualizer.getTotalSize() - (lastRow.end - rowsOffset) : 0

	useLayoutEffect(() => {
		const tbody = tbodyRef.current

		if (scrollElement === null || headerElement === null || tbody === null) {
			return
		}

		const scroller = scrollElement

		function measure(): void {
			if (tbody === null) {
				return
			}

			setRowsOffset(tbody.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop)
		}

		measure()

		const observer = new ResizeObserver(measure)

		observer.observe(headerElement)

		return () => {
			observer.disconnect()
		}
	}, [scrollElement, headerElement])

	return (
		<tbody ref={tbodyRef}>
			{paddingTop > 0 ? (
				<tr aria-hidden="true">
					<td
						colSpan={TRACK_COLUMN_COUNT}
						style={{ height: paddingTop }}
					/>
				</tr>
			) : null}
			{virtualRows.map(virtualRow => {
				const file = playlist.files[virtualRow.index]

				if (!file) {
					return null
				}

				return (
					<TrackRow
						key={file.uuid}
						playlist={playlist}
						file={file}
						index={virtualRow.index}
						playing={file.uuid === currentTrackUuid}
						dragOver={dragOverIndex === virtualRow.index}
						removing={removingUuid === file.uuid}
						disabled={disabled}
						setRemovingUuid={setRemovingUuid}
						setDragOverIndex={setDragOverIndex}
					/>
				)
			})}
			{paddingBottom > 0 ? (
				<tr aria-hidden="true">
					<td
						colSpan={TRACK_COLUMN_COUNT}
						style={{ height: paddingBottom }}
					/>
				</tr>
			) : null}
		</tbody>
	)
}

// Its own component so the minute tick re-renders this label, not the whole pane.
function PlaylistUpdated({ updated }: { updated: number }) {
	const { t } = useTranslation("audio")
	const { t: tCommon } = useTranslation("common")
	const now = useNowMinute()

	return t("playlistUpdated", { time: formatRelativeTime(updated, tCommon, now) })
}

interface TrackRowProps {
	playlist: Playlist
	file: PlaylistFile
	index: number
	playing: boolean
	dragOver: boolean
	removing: boolean
	disabled: boolean
	setRemovingUuid: (uuid: string | null) => void
	setDragOverIndex: (index: number | null) => void
}

// Its handlers are built here from stable props (the live playlist, the body's state setters), so a
// scroll that re-renders the body leaves every row whose own props did not change untouched.
function TrackRow({ playlist, file, index, playing, dragOver, removing, disabled, setRemovingUuid, setDragOverIndex }: TrackRowProps) {
	const { t } = useTranslation("audio")
	const { record, pending, coverUrl } = useTrackMetadata(file)
	const title = trackDisplayTitle(record, file.name)
	// Painted per cell: a <tr> takes neither a rounded corner nor, under border-separate, a reliable
	// background of its own.
	const cellClass = cn("py-1.5 transition-colors", dragOver ? "bg-accent" : "group-hover/trow:bg-accent/50")

	async function handleRemove(): Promise<void> {
		setRemovingUuid(file.uuid)

		try {
			await removeTracksFromPlaylistAction(playlist, [file.uuid])
		} catch (error) {
			toast.error(errorLabel(asErrorDTO(error)))
		}

		setRemovingUuid(null)
	}

	async function handleReorder(movedUuid: string): Promise<void> {
		if (movedUuid === file.uuid) {
			return
		}

		try {
			await reorderPlaylistFileAction(playlist, movedUuid, file.uuid)
		} catch (error) {
			toast.error(errorLabel(asErrorDTO(error)))
		}
	}

	function handleDragLeave(): void {
		setDragOverIndex(null)
	}

	// The payload is the dragged track's uuid, not its row index: the list can re-render mid-drag (an
	// earlier reorder's save landing) and shift every index under the pointer.
	function handleDragStart(event: DragEvent<HTMLTableRowElement>): void {
		event.dataTransfer.effectAllowed = "move"
		event.dataTransfer.setData(TRACK_DRAG_TYPE, file.uuid)
	}

	function handleDragOver(event: DragEvent<HTMLTableRowElement>): void {
		if (!isTrackReorderDrag(event.dataTransfer)) {
			return
		}

		event.preventDefault()
		setDragOverIndex(index)
	}

	function handleDrop(event: DragEvent<HTMLTableRowElement>): void {
		if (!isTrackReorderDrag(event.dataTransfer)) {
			return
		}

		event.preventDefault()
		handleDragLeave()

		const movedUuid = event.dataTransfer.getData(TRACK_DRAG_TYPE)

		if (movedUuid !== "") {
			void handleReorder(movedUuid)
		}
	}

	return (
		<tr
			aria-rowindex={index + 2}
			draggable={!disabled}
			onDragStart={handleDragStart}
			onDragEnd={handleDragLeave}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
			className="group/trow h-12"
		>
			<td className={cn(cellClass, "rounded-l-xl text-center text-xs text-muted-foreground tabular-nums")}>
				{/* The index doubles as the drag handle: it turns into a grip under the pointer. */}
				<span className={cn("inline-flex size-4 items-center justify-center", !disabled && "group-hover/trow:hidden")}>
					{playing ? (
						<>
							<AudioLinesIcon
								aria-hidden="true"
								className="size-4 text-primary"
							/>
							<span className="sr-only">{t("trackNowPlaying")}</span>
						</>
					) : (
						index + 1
					)}
				</span>
				{disabled ? null : (
					<GripVerticalIcon
						aria-hidden="true"
						className="mx-auto hidden size-4 cursor-grab group-hover/trow:block"
					/>
				)}
			</td>
			<td className={cellClass}>
				<button
					type="button"
					className="flex w-full min-w-0 items-center gap-3 rounded-lg px-2 text-left focus-ring-row outline-none"
					onClick={() => {
						startPlaylist(playlist, index)
					}}
				>
					<span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
						{coverUrl ? (
							<img
								src={coverUrl}
								alt=""
								className="size-full object-cover"
							/>
						) : (
							<MusicIcon
								aria-hidden="true"
								className="size-4"
							/>
						)}
					</span>
					<span className="flex min-w-0 flex-1 flex-col">
						<span
							title={title}
							className={cn("truncate leading-5", playing && "font-medium text-primary")}
						>
							{title}
						</span>
						{pending ? (
							<Skeleton className="mt-1 h-3 w-24" />
						) : (
							<span className="truncate text-xs leading-4 text-muted-foreground">{record?.artist ?? t("unknownArtist")}</span>
						)}
					</span>
				</button>
			</td>
			<td className={cn(cellClass, "hidden px-2 text-muted-foreground md:table-cell")}>
				{pending ? (
					<Skeleton className="h-3 w-24" />
				) : (
					<span
						title={record?.album ?? undefined}
						className="block truncate"
					>
						{record?.album}
					</span>
				)}
			</td>
			<td className={cn(cellClass, "px-2 text-right text-xs text-muted-foreground tabular-nums")}>
				{pending ? (
					<Skeleton className="ml-auto h-3 w-8" />
				) : record?.durationSec !== null && record?.durationSec !== undefined ? (
					formatSecondsToMediaClock(record.durationSec)
				) : null}
			</td>
			<td className={cn(cellClass, "hidden px-2 text-right text-xs text-muted-foreground tabular-nums lg:table-cell")}>
				{formatBytes(file.size)}
			</td>
			<td className={cn(cellClass, "rounded-r-xl pr-1 text-right")}>
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={t("removeFromPlaylist")}
					disabled={disabled || removing}
					className={cn(
						"opacity-0 transition-opacity group-hover/trow:opacity-100 focus-visible:opacity-100",
						removing && "opacity-100"
					)}
					onClick={() => {
						void handleRemove()
					}}
				>
					{removing ? <Spinner className="size-3.5" /> : <XIcon />}
				</Button>
			</td>
		</tr>
	)
}
