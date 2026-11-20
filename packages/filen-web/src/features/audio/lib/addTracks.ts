import { toast } from "sonner"
import type { Playlist } from "@filen/shared"
import { i18n } from "@/lib/i18n"
import { errorLabel } from "@/lib/i18n/errorLabel"
import type { DriveItem } from "@/features/drive/lib/item"
import { addTracksToPlaylistAction } from "@/features/audio/lib/playlists"

export type AddTracksOutcome = { status: "success"; added: number } | { status: "error"; error: unknown }

// Adds tracks the way the playlist's Add tracks dialog does, with its toasts: how many went in, or why none did.
export async function addTracksWithToast(playlist: Playlist, items: DriveItem[]): Promise<AddTracksOutcome> {
	let added: number

	try {
		added = await addTracksToPlaylistAction(playlist, items)
	} catch (error) {
		toast.error(errorLabel(error))

		return { status: "error", error }
	}

	if (added > 0) {
		toast.success(i18n.t("audio:tracksAddedToast", { count: added }))
	}

	return { status: "success", added }
}
