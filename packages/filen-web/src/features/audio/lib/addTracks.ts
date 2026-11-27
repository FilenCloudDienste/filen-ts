import { toast } from "sonner"
import type { Playlist } from "@filen/shared"
import { i18n } from "@/lib/i18n"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { DriveItem } from "@/features/drive/lib/item"
import { addTracksToPlaylistAction } from "@/features/audio/lib/playlists"
import { isPlaylistSong } from "@/features/audio/lib/handoff"

export type AddTracksOutcome = { status: "success"; added: number; skipped: number } | { status: "error"; error: unknown }

// Adds tracks the way the playlist's Add tracks dialog does, with its toasts: how many went in, or why none did.
// `selected` is how many items the user picked when that is more than `items` (a drive selection's non-songs): those
// and the tracks already in the playlist count as skipped.
export async function addTracksWithToast(
	playlist: Playlist,
	items: DriveItem[],
	options?: { selected?: number }
): Promise<AddTracksOutcome> {
	let added: number

	try {
		added = await addTracksToPlaylistAction(playlist, items)
	} catch (error) {
		toast.error(errorLabel(error))

		return { status: "error", error }
	}

	const skipped = Math.max(0, (options?.selected ?? items.length) - added)

	if (added > 0) {
		toast.success(
			skipped > 0
				? i18n.t("audio:tracksAddedSkippedToast", { count: added, skipped })
				: i18n.t("audio:tracksAddedToast", { count: added })
		)
	} else if (skipped > 0) {
		toast.info(i18n.t("audio:tracksNoneAddedToast"))
	}

	return { status: "success", added, skipped }
}

// Adds a drive selection's songs (isPlaylistSong) in one write; directories and every other item are skipped.
export function addSelectionToPlaylist(playlist: Playlist, selection: readonly DriveItem[]): Promise<AddTracksOutcome> {
	return addTracksWithToast(playlist, selection.filter(isPlaylistSong), {
		selected: selection.length
	})
}
