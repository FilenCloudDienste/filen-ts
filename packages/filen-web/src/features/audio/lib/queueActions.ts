import { toast } from "sonner"
import type { Playlist } from "@filen/shared"
import { audioEngine } from "@/features/audio/lib/audioEngine"
import { buildQueueTrack, isPlaylistSong } from "@/features/audio/lib/handoff"
import { queueTracksFromPlaylist } from "@/features/audio/lib/playlists"
import type { QueuePlacement, QueueTrack } from "@/features/audio/store/audioQueue"
import type { DriveItem } from "@/features/drive/lib/item"
import { i18n } from "@/lib/i18n"

// "Play next" / "Add to queue" from every surface (drive menus, playlist menus, track rows), with the toast saying what
// went in. The tracks are built from what the caller already holds: no read.
export function queueTracks(tracks: readonly QueueTrack[], placement: QueuePlacement): void {
	if (tracks.length === 0) {
		return
	}

	const added = audioEngine.enqueue(tracks, placement)

	if (added === 0) {
		toast.info(i18n.t("audio:queuedNoneToast"))

		return
	}

	toast.success(
		placement === "next" ? i18n.t("audio:queuedNextToast", { count: added }) : i18n.t("audio:queuedEndToast", { count: added })
	)
}

// A drive selection's songs, in selection order; directories and every other item are skipped.
export function queueDriveSongs(items: readonly DriveItem[], placement: QueuePlacement): void {
	queueTracks(items.filter(isPlaylistSong).map(buildQueueTrack), placement)
}

export function queuePlaylist(playlist: Playlist, placement: QueuePlacement): void {
	queueTracks(queueTracksFromPlaylist(playlist), placement)
}

// Clears, then offers the cleared queue back from the toast: the tracks, the one playing, its position and whether it
// played. The snapshot is only what the store already held.
export function clearQueueWithUndo(): void {
	const snapshot = audioEngine.queueSnapshot()

	audioEngine.clearQueue()

	if (snapshot === null) {
		return
	}

	toast(i18n.t("audio:queueClearedToast"), {
		action: {
			label: i18n.t("audio:queueClearedUndo"),
			onClick: () => {
				void audioEngine.restoreQueue(snapshot)
			}
		}
	})
}
