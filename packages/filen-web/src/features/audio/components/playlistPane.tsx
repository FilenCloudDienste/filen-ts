import { useId, useState, type DragEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { formatBytes } from "@filen/shared"
import { AudioLinesIcon, GripVerticalIcon, MoreHorizontalIcon, MusicIcon, PlayIcon, PlusIcon, ShuffleIcon, XIcon } from "lucide-react"
import { removeTracksFromPlaylistAction, reorderPlaylistFileAction } from "@/features/audio/lib/playlists"
import { AddPlaylistTracksDialog } from "@/features/audio/components/addPlaylistTracksDialog"
import { PlaylistArtwork } from "@/features/audio/components/playlistArtwork"
import { PlaylistMenuContent } from "@/features/audio/components/playlistMenu"
import { startPlaylist, startShuffledPlaylist } from "@/features/audio/lib/playlistPlayback"
import { useAudioStore } from "@/features/audio/store/useAudioStore"
import {
	setDraggedTrackIndex,
	getDraggedTrackIndex,
	clearDraggedTrackIndex,
	isTrackReorderDrag,
	TRACK_DRAG_TYPE
} from "@/features/audio/lib/trackDnd"
import type { Playlist, PlaylistFile } from "@filen/shared"
import { formatRelativeTime } from "@/lib/relativeTime"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"

// The selected playlist, inline in the /playlists main pane: a hero (artwork, name as the page's h1,
// meta, Play/Shuffle/Add tracks/⋯) over its track table. Play-from-row keeps mobile #49 semantics
// (replaces the queue positioned at that row), drag-reorder is trackDnd.ts's native HTML5 idiom, and
// `playlist` is always the live query-cache copy, so every mutation's confirm-then-patch lands here
// without optimistic state of its own.
export function PlaylistPane({ playlist }: { playlist: Playlist }) {
	const { t } = useTranslation("audio")
	const { t: tCommon } = useTranslation("common")
	const headingId = useId()
	const isOnline = useIsOnline()
	const [addOpen, setAddOpen] = useState(false)
	const [removingUuid, setRemovingUuid] = useState<string | null>(null)
	const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
	// One primitive for the whole table, so only a track change re-renders it (never playback progress).
	const currentTrackUuid = useAudioStore(state => state.queue[state.currentIndex]?.uuid ?? null)
	const hasTracks = playlist.files.length > 0
	const totalSize = playlist.files.reduce((sum, file) => sum + file.size, 0)

	async function handleRemove(uuid: string): Promise<void> {
		setRemovingUuid(uuid)

		try {
			await removeTracksFromPlaylistAction(playlist, [uuid])
		} catch (error) {
			toast.error(errorLabel(asErrorDTO(error)))
		} finally {
			setRemovingUuid(null)
		}
	}

	async function handleReorder(from: number, to: number): Promise<void> {
		if (from === to) {
			return
		}

		try {
			await reorderPlaylistFileAction(playlist, from, to)
		} catch (error) {
			toast.error(errorLabel(asErrorDTO(error)))
		}
	}

	return (
		<section
			aria-labelledby={headingId}
			className="flex min-h-0 flex-1 flex-col overflow-y-auto"
		>
			<header className="flex flex-col gap-5 px-6 pt-8 pb-6 sm:flex-row sm:items-end">
				<PlaylistArtwork
					uuid={playlist.uuid}
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
						{t("playlistUpdated", { time: formatRelativeTime(playlist.updated, tCommon) })}
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
					<table className="w-full table-fixed border-separate border-spacing-0 text-sm">
						<thead className="sticky top-0 z-10 bg-card text-xs text-muted-foreground">
							<tr>
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
									className="w-24 border-b border-border px-2 py-2 text-right font-normal"
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
						<tbody>
							{playlist.files.map((file, index) => (
								<TrackRow
									key={file.uuid}
									file={file}
									index={index}
									playing={file.uuid === currentTrackUuid}
									dragOver={dragOverIndex === index}
									removing={removingUuid === file.uuid}
									disabled={!isOnline}
									onPlay={() => {
										startPlaylist(playlist, index)
									}}
									onRemove={() => {
										void handleRemove(file.uuid)
									}}
									onDropAt={from => {
										void handleReorder(from, index)
									}}
									onDragEnterIndex={setDragOverIndex}
									onDragLeaveIndex={() => {
										setDragOverIndex(null)
									}}
								/>
							))}
						</tbody>
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

interface TrackRowProps {
	file: PlaylistFile
	index: number
	playing: boolean
	dragOver: boolean
	removing: boolean
	disabled: boolean
	onPlay: () => void
	onRemove: () => void
	onDropAt: (fromIndex: number) => void
	onDragEnterIndex: (index: number) => void
	onDragLeaveIndex: () => void
}

function TrackRow({
	file,
	index,
	playing,
	dragOver,
	removing,
	disabled,
	onPlay,
	onRemove,
	onDropAt,
	onDragEnterIndex,
	onDragLeaveIndex
}: TrackRowProps) {
	const { t } = useTranslation("audio")
	// Painted per cell: a <tr> takes neither a rounded corner nor, under border-separate, a reliable
	// background of its own.
	const cellClass = cn("py-1.5 transition-colors", dragOver ? "bg-accent" : "group-hover/trow:bg-accent/50")

	function handleDragStart(event: DragEvent<HTMLTableRowElement>): void {
		setDraggedTrackIndex(index)
		event.dataTransfer.effectAllowed = "move"
		event.dataTransfer.setData(TRACK_DRAG_TYPE, "1")
	}

	function handleDragOver(event: DragEvent<HTMLTableRowElement>): void {
		if (!isTrackReorderDrag(event.dataTransfer)) {
			return
		}

		event.preventDefault()
		onDragEnterIndex(index)
	}

	function handleDrop(event: DragEvent<HTMLTableRowElement>): void {
		if (!isTrackReorderDrag(event.dataTransfer)) {
			return
		}

		event.preventDefault()
		onDragLeaveIndex()

		const from = getDraggedTrackIndex()

		clearDraggedTrackIndex()

		if (from !== null) {
			onDropAt(from)
		}
	}

	return (
		<tr
			draggable={!disabled}
			onDragStart={handleDragStart}
			onDragEnd={() => {
				clearDraggedTrackIndex()
				onDragLeaveIndex()
			}}
			onDragOver={handleDragOver}
			onDragLeave={onDragLeaveIndex}
			onDrop={handleDrop}
			className="group/trow"
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
					className={cn(
						"flex w-full min-w-0 items-center rounded-lg px-2 py-0.5 text-left focus-ring-row outline-none",
						playing && "font-medium text-primary"
					)}
					onClick={onPlay}
				>
					<span
						title={file.name}
						className="min-w-0 flex-1 truncate"
					>
						{file.name}
					</span>
				</button>
			</td>
			<td className={cn(cellClass, "px-2 text-right text-xs text-muted-foreground tabular-nums")}>{formatBytes(file.size)}</td>
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
					onClick={onRemove}
				>
					{removing ? <Spinner className="size-3.5" /> : <XIcon />}
				</Button>
			</td>
		</tr>
	)
}
