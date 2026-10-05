import { useLastOpened } from "@/features/shell/lib/lastOpened"

// The playlist uuid the /playlists view asks for: the route's `playlist` param, else the playlist shown
// last (across reloads too), so the rail and a reload of the bare route reopen it. resolveSelectedPlaylist
// then falls back to the first playlist for one that is gone or degraded. `deciding` while the stored
// value is still being read, so nothing is shown (or remembered) for a choice not made yet.
export function usePlaylistSelection(param: string | undefined): { uuid: string | undefined; deciding: boolean } {
	const stored = useLastOpened("playlists")

	if (param !== undefined) {
		return { uuid: param, deciding: false }
	}

	return { uuid: stored ?? undefined, deciding: stored === undefined }
}
