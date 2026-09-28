import { useTranslation } from "react-i18next"
import { PencilIcon, PlayIcon, ShuffleIcon, Trash2Icon } from "lucide-react"
import type { Playlist } from "@filen/shared"
import { startPlaylist, startShuffledPlaylist } from "@/features/audio/lib/playlistPlayback"
import { openPlaylistDialog } from "@/features/audio/store/usePlaylistDialogStore"
import { useIsOnline } from "@/lib/useIsOnline"
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"

// A playlist's ⋯ menu body. The sidebar row carries the playback entries too (its only way to play
// without selecting); the pane's hero already has Play/Shuffle as buttons, so it passes
// `playback={false}`.
export function PlaylistMenuContent({ playlist, playback }: { playlist: Playlist; playback: boolean }) {
	const { t } = useTranslation("audio")
	const isOnline = useIsOnline()
	const hasTracks = playlist.files.length > 0

	return (
		<DropdownMenuContent align="end">
			{playback ? (
				<>
					<DropdownMenuItem
						disabled={!hasTracks}
						onClick={() => {
							startPlaylist(playlist, 0)
						}}
					>
						<PlayIcon />
						{t("play")}
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={!hasTracks}
						onClick={() => {
							startShuffledPlaylist(playlist)
						}}
					>
						<ShuffleIcon />
						{t("shufflePlay")}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
				</>
			) : null}
			<DropdownMenuItem
				disabled={!isOnline}
				onClick={() => {
					openPlaylistDialog({ kind: "rename", playlist })
				}}
			>
				<PencilIcon />
				{t("playlistActionRename")}
			</DropdownMenuItem>
			<DropdownMenuItem
				variant="destructive"
				disabled={!isOnline}
				onClick={() => {
					openPlaylistDialog({ kind: "delete", playlist })
				}}
			>
				<Trash2Icon />
				{t("playlistActionDelete")}
			</DropdownMenuItem>
		</DropdownMenuContent>
	)
}
