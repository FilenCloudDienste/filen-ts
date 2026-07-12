import { useState, type DragEvent } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { formatBytes } from "@filen/utils"
import { GripVerticalIcon, MusicIcon, PlayIcon, PlusIcon, ShuffleIcon, XIcon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import { usePlaylistsQuery } from "@/features/audio/queries/playlists"
import { removeTracksFromPlaylistAction, reorderPlaylistFileAction } from "@/features/audio/lib/playlists"
import { playPlaylistFrom, shufflePlayPlaylist } from "@/features/audio/lib/playlistPlayback"
import { AddPlaylistTracksDialog } from "@/features/audio/components/addPlaylistTracksDialog"
import {
	setDraggedTrackIndex,
	getDraggedTrackIndex,
	clearDraggedTrackIndex,
	isTrackReorderDrag,
	TRACK_DRAG_TYPE
} from "@/features/audio/lib/trackDnd"
import type { Playlist, PlaylistFile } from "@/features/audio/lib/playlistSchema"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import { cn } from "@/lib/utils"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"

export interface PlaylistDetailDialogProps {
	playlist: Playlist
	onClose: () => void
}

// A playlist's track list: play-from-row (mobile #49 semantics — replaces the queue positioned at that
// row), drag-reorder (native HTML5 DnD, trackDnd.ts's module-level idiom — no dnd-kit dependency),
// per-row remove, and an add-tracks entry point (AddPlaylistTracksDialog). `playlist` is only the
// INITIAL snapshot (the row that was clicked to open this) — the body always renders off the live
// query cache so every mutation's confirm-then-patch reflects here immediately, without this dialog
// needing its own optimistic state.
export function PlaylistDetailDialog({ playlist: initialPlaylist, onClose }: PlaylistDetailDialogProps) {
	const { t } = useTranslation("audio")
	const isOnline = useIsOnline()
	const playlistsQuery = usePlaylistsQuery()
	const [addOpen, setAddOpen] = useState(false)
	const [removingUuid, setRemovingUuid] = useState<string | null>(null)
	const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

	const liveEntry = playlistsQuery.data?.find(entry => entry.status === "ok" && entry.playlist.uuid === initialPlaylist.uuid)
	const playlist = liveEntry?.status === "ok" ? liveEntry.playlist : initialPlaylist
	const hasTracks = playlist.files.length > 0

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, removingUuid !== null)) {
			details.cancel()
			return
		}

		if (!next) {
			onClose()
		}
	}

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

	function handlePlayFrom(index: number): void {
		void playPlaylistFrom(playlist, index).catch((error: unknown) => {
			toast.error(errorLabel(asErrorDTO(error)))
		})
	}

	function handlePlay(): void {
		void playPlaylistFrom(playlist, 0).catch((error: unknown) => {
			toast.error(errorLabel(asErrorDTO(error)))
		})
	}

	function handleShufflePlay(): void {
		void shufflePlayPlaylist(playlist).catch((error: unknown) => {
			toast.error(errorLabel(asErrorDTO(error)))
		})
	}

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{playlist.name}</DialogTitle>
					<DialogDescription>{t("playlistTrackCount", { count: playlist.files.length })}</DialogDescription>
				</DialogHeader>
				<div className="flex items-center gap-2">
					<Button
						size="sm"
						disabled={!hasTracks}
						onClick={handlePlay}
					>
						<PlayIcon />
						{t("play")}
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={!hasTracks}
						onClick={handleShufflePlay}
					>
						<ShuffleIcon />
						{t("shufflePlay")}
					</Button>
					<Button
						variant="outline"
						size="sm"
						className="ml-auto"
						disabled={!isOnline}
						onClick={() => {
							setAddOpen(true)
						}}
					>
						<PlusIcon />
						{t("addTracks")}
					</Button>
				</div>
				<div className="h-72 overflow-y-auto rounded-xl ring-1 ring-foreground/5 dark:ring-foreground/10">
					{!hasTracks ? (
						<Empty className="border-none p-6">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<MusicIcon />
								</EmptyMedia>
								<EmptyTitle>{t("playlistTracksEmptyTitle")}</EmptyTitle>
								<EmptyDescription>{t("playlistTracksEmptyBody")}</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<ul className="flex flex-col gap-0.5 p-2">
							{playlist.files.map((file, index) => (
								<TrackRow
									key={file.uuid}
									file={file}
									index={index}
									dragOver={dragOverIndex === index}
									removing={removingUuid === file.uuid}
									disabled={!isOnline}
									onPlay={() => {
										handlePlayFrom(index)
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
						</ul>
					)}
				</div>
			</DialogContent>
			{addOpen ? (
				<AddPlaylistTracksDialog
					playlist={playlist}
					onClose={() => {
						setAddOpen(false)
					}}
				/>
			) : null}
		</Dialog>
	)
}

interface TrackRowProps {
	file: PlaylistFile
	index: number
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

	function handleDragStart(event: DragEvent<HTMLLIElement>): void {
		setDraggedTrackIndex(index)
		event.dataTransfer.effectAllowed = "move"
		event.dataTransfer.setData(TRACK_DRAG_TYPE, "1")
	}

	function handleDragOver(event: DragEvent<HTMLLIElement>): void {
		if (!isTrackReorderDrag(event.dataTransfer)) {
			return
		}

		event.preventDefault()
		onDragEnterIndex(index)
	}

	function handleDrop(event: DragEvent<HTMLLIElement>): void {
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
		<li
			draggable={!disabled}
			onDragStart={handleDragStart}
			onDragEnd={() => {
				clearDraggedTrackIndex()
				onDragLeaveIndex()
			}}
			onDragOver={handleDragOver}
			onDragLeave={onDragLeaveIndex}
			onDrop={handleDrop}
			className={cn(
				"group/trow flex items-center gap-2 rounded-xl px-2 py-1.5 outline-none",
				dragOver ? "bg-accent" : "hover:bg-accent/50"
			)}
		>
			<GripVerticalIcon
				aria-hidden="true"
				className={cn("size-4 shrink-0 text-muted-foreground", disabled ? "opacity-40" : "cursor-grab")}
			/>
			<button
				type="button"
				className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
				onClick={onPlay}
			>
				<MusicIcon className="size-4 shrink-0 text-muted-foreground" />
				<span
					title={file.name}
					className="min-w-0 flex-1 truncate text-sm"
				>
					{file.name}
				</span>
				<span className="shrink-0 text-xs text-muted-foreground">{formatBytes(file.size)}</span>
			</button>
			<Button
				variant="ghost"
				size="icon-xs"
				aria-label={t("removeFromPlaylist")}
				disabled={disabled || removing}
				className="shrink-0 opacity-0 transition-opacity group-hover/trow:opacity-100 focus-visible:opacity-100"
				onClick={onRemove}
			>
				{removing ? <Spinner className="size-3.5" /> : <XIcon />}
			</Button>
		</li>
	)
}
