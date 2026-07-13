import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ListMusicIcon, MoreHorizontalIcon, PlayIcon, PlusIcon, ShuffleIcon, PencilIcon, Trash2Icon } from "lucide-react"
import { usePlaylistsQuery, type PlaylistEntry } from "@/features/audio/queries/playlists"
import { createPlaylist, deletePlaylistAction, renamePlaylistAction } from "@/features/audio/lib/playlists"
import { playPlaylistFrom, shufflePlayPlaylist } from "@/features/audio/lib/playlistPlayback"
import { PlaylistDetailDialog } from "@/features/audio/components/playlistDetailDialog"
import type { Playlist } from "@/features/audio/lib/playlistSchema"
import { formatRelativeTime } from "@/lib/relativeTime"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import { cn } from "@/lib/utils"
import { InputDialog } from "@/components/dialogs/inputDialog"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"

// The playlists CRUD surface for `.filen/Playlists` (list, create, rename, delete, play, shuffle-play) —
// the body of the /playlists screen (features/audio/screens/playlists.tsx supplies the screen's own
// header; this component owns everything below it). Opening a row's track list goes through
// PlaylistDetailDialog — a full Dialog, since track management (add/remove/reorder) needs more room than
// a row affords. Previously lived inside the now-playing popover's Playlists tab (unreachable without a
// playing queue); the founder decision moved it to a dedicated rail entry instead — see iconRail.tsx's
// new entry and nowPlayingPanel.tsx's own comment for the popover-side half of that change.
export function PlaylistsPanel() {
	const { t } = useTranslation("audio")
	const { t: tCommon } = useTranslation("common")
	const isOnline = useIsOnline()
	const playlistsQuery = usePlaylistsQuery()
	const [createOpen, setCreateOpen] = useState(false)
	const [createPending, setCreatePending] = useState(false)
	const [renameTarget, setRenameTarget] = useState<Playlist | null>(null)
	const [renamePending, setRenamePending] = useState(false)
	const [deleteTarget, setDeleteTarget] = useState<Playlist | null>(null)
	const [deletePending, setDeletePending] = useState(false)
	const [detailTarget, setDetailTarget] = useState<Playlist | null>(null)

	const entries = playlistsQuery.data ?? []

	async function handleCreate(name: string): Promise<void> {
		setCreatePending(true)

		try {
			await createPlaylist(name.trim())
			setCreateOpen(false)
		} catch (error) {
			toast.error(errorLabel(asErrorDTO(error)))
		} finally {
			setCreatePending(false)
		}
	}

	async function handleRename(name: string): Promise<void> {
		if (!renameTarget) {
			return
		}

		setRenamePending(true)

		try {
			await renamePlaylistAction(renameTarget, name.trim())
			setRenameTarget(null)
		} catch (error) {
			toast.error(errorLabel(asErrorDTO(error)))
		} finally {
			setRenamePending(false)
		}
	}

	async function handleDelete(): Promise<void> {
		if (!deleteTarget) {
			return
		}

		setDeletePending(true)

		try {
			await deletePlaylistAction(deleteTarget)
			setDeleteTarget(null)
		} catch (error) {
			toast.error(errorLabel(asErrorDTO(error)))
		} finally {
			setDeletePending(false)
		}
	}

	function handlePlay(playlist: Playlist): void {
		void playPlaylistFrom(playlist, 0).catch((error: unknown) => {
			toast.error(errorLabel(asErrorDTO(error)))
		})
	}

	function handleShufflePlay(playlist: Playlist): void {
		void shufflePlayPlaylist(playlist).catch((error: unknown) => {
			toast.error(errorLabel(asErrorDTO(error)))
		})
	}

	// Screen-shaped, not popover-shaped: an action row (count + New playlist) mirroring TransfersScreen's
	// own header/action-row split, then a centered max-width scrollable column (EventsList/settings'
	// shared reading-width idiom) so the list doesn't stretch edge-to-edge on a wide window.
	return (
		<>
			<div className="mx-auto flex w-full max-w-2xl shrink-0 items-center justify-between gap-2 px-4 pb-3">
				<p className="text-xs text-muted-foreground">{t("playlistsCount", { count: entries.length })}</p>
				<Button
					variant="outline"
					size="sm"
					disabled={!isOnline}
					onClick={() => {
						setCreateOpen(true)
					}}
				>
					<PlusIcon aria-hidden="true" />
					{t("newPlaylist")}
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
				<div className="mx-auto flex w-full max-w-2xl flex-col">
					{playlistsQuery.status === "pending" ? (
						<div className="flex justify-center py-6">
							<Spinner className="size-5" />
						</div>
					) : playlistsQuery.status === "error" ? (
						<p className="px-2 py-4 text-center text-sm text-destructive">{errorLabel(asErrorDTO(playlistsQuery.error))}</p>
					) : entries.length === 0 ? (
						<Empty className="border-none p-10">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<ListMusicIcon />
								</EmptyMedia>
								<EmptyTitle>{t("playlistsEmptyTitle")}</EmptyTitle>
								<EmptyDescription>{t("playlistsEmptyBody")}</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<ul className="flex flex-col gap-1">
							{entries.map(entry => (
								<PlaylistRow
									key={entry.status === "ok" ? entry.playlist.uuid : entry.fileUuid}
									entry={entry}
									isOnline={isOnline}
									onOpen={playlist => {
										setDetailTarget(playlist)
									}}
									onPlay={handlePlay}
									onShufflePlay={handleShufflePlay}
									onRename={playlist => {
										setRenameTarget(playlist)
									}}
									onDelete={playlist => {
										setDeleteTarget(playlist)
									}}
								/>
							))}
						</ul>
					)}
				</div>
			</div>

			<InputDialog
				open={createOpen}
				pending={createPending}
				title={t("newPlaylistTitle")}
				body={t("newPlaylistBody")}
				label={t("playlistNameLabel")}
				placeholder={t("playlistNamePlaceholder")}
				submitLabel={t("newPlaylistSubmit")}
				validate={value => value.trim().length > 0}
				onOpenChange={setCreateOpen}
				onSubmit={value => {
					void handleCreate(value)
				}}
			/>
			<InputDialog
				open={renameTarget !== null}
				pending={renamePending}
				title={t("renamePlaylistTitle")}
				body={t("renamePlaylistBody")}
				label={t("playlistNameLabel")}
				placeholder={t("playlistNamePlaceholder")}
				initialValue={renameTarget?.name ?? ""}
				submitLabel={t("playlistActionRename")}
				validate={value => value.trim().length > 0}
				onOpenChange={open => {
					if (!open) {
						setRenameTarget(null)
					}
				}}
				onSubmit={value => {
					void handleRename(value)
				}}
			/>
			<ConfirmDialog
				open={deleteTarget !== null}
				pending={deletePending}
				title={t("deletePlaylistTitle")}
				body={t("deletePlaylistBody", { name: deleteTarget?.name ?? "" })}
				confirmLabel={t("playlistActionDelete")}
				cancelLabel={tCommon("cancel")}
				destructive
				onOpenChange={open => {
					if (!open) {
						setDeleteTarget(null)
					}
				}}
				onConfirm={() => {
					void handleDelete()
				}}
			/>
			{detailTarget !== null ? (
				<PlaylistDetailDialog
					playlist={detailTarget}
					onClose={() => {
						setDetailTarget(null)
					}}
				/>
			) : null}
		</>
	)
}

interface PlaylistRowProps {
	entry: PlaylistEntry
	isOnline: boolean
	onOpen: (playlist: Playlist) => void
	onPlay: (playlist: Playlist) => void
	onShufflePlay: (playlist: Playlist) => void
	onRename: (playlist: Playlist) => void
	onDelete: (playlist: Playlist) => void
}

function PlaylistRow({ entry, isOnline, onOpen, onPlay, onShufflePlay, onRename, onDelete }: PlaylistRowProps) {
	const { t } = useTranslation("audio")
	const { t: tCommon } = useTranslation("common")

	if (entry.status === "degraded") {
		return (
			<li
				key={entry.fileUuid}
				className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-muted-foreground"
			>
				<ListMusicIcon className="size-5 shrink-0" />
				<span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
				<span className="shrink-0 text-xs">{t("playlistDegraded")}</span>
			</li>
		)
	}

	const { playlist } = entry

	return (
		<li className={cn("group/prow flex items-center gap-2 rounded-xl px-1 pr-2")}>
			<button
				type="button"
				className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
				onClick={() => {
					onOpen(playlist)
				}}
			>
				<ListMusicIcon className="size-5 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1">
					<span
						title={playlist.name}
						className="block truncate text-sm font-medium"
					>
						{playlist.name}
					</span>
					<span className="block truncate text-xs text-muted-foreground">
						{t("playlistTrackCount", { count: playlist.files.length })} · {formatRelativeTime(playlist.updated, tCommon)}
					</span>
				</span>
			</button>
			<DropdownMenu>
				<DropdownMenuTrigger
					render={
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={t("playlistItemMenuTrigger")}
							className="shrink-0 opacity-0 transition-opacity group-hover/prow:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
						>
							<MoreHorizontalIcon />
						</Button>
					}
				/>
				<DropdownMenuContent align="end">
					<DropdownMenuItem
						disabled={playlist.files.length === 0}
						onClick={() => {
							onPlay(playlist)
						}}
					>
						<PlayIcon />
						{t("play")}
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={playlist.files.length === 0}
						onClick={() => {
							onShufflePlay(playlist)
						}}
					>
						<ShuffleIcon />
						{t("shufflePlay")}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						disabled={!isOnline}
						onClick={() => {
							onRename(playlist)
						}}
					>
						<PencilIcon />
						{t("playlistActionRename")}
					</DropdownMenuItem>
					<DropdownMenuItem
						variant="destructive"
						disabled={!isOnline}
						onClick={() => {
							onDelete(playlist)
						}}
					>
						<Trash2Icon />
						{t("playlistActionDelete")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</li>
	)
}
