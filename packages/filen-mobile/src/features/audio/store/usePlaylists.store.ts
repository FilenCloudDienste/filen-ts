import { create } from "zustand"
import type { PlaylistWithItems } from "@/features/audio/audio"
import { toggleInArray } from "@/stores/createSelectionSlice"

export type PlaylistsStore = {
	selectedPlaylists: PlaylistWithItems[]
	setSelectedPlaylists: (fn: PlaylistWithItems[] | ((prev: PlaylistWithItems[]) => PlaylistWithItems[])) => void
	toggleSelectedPlaylist: (playlist: PlaylistWithItems) => void
	clearSelectedPlaylists: () => void
	selectAllPlaylists: (playlists: PlaylistWithItems[]) => void
}

const playlistId = (p: PlaylistWithItems) => p.uuid

/**
 * Drop selected items whose uuid is no longer present in `liveItems`. Pure helper used by the
 * playlists / playlist screens to purge "selection ghosts" when a refetch (e.g. pull-to-refresh)
 * removes a still-selected playlist/track — keeps the header count honest and stops bulk ops from
 * targeting a phantom (#AU-15). Returns the SAME array reference when nothing changed so callers
 * can cheaply skip a no-op store write.
 */
export function pruneSelectionByUuid<T extends { uuid: string }>(selected: T[], liveItems: { uuid: string }[]): T[] {
	const liveUuids = new Set(liveItems.map(item => item.uuid))
	const kept = selected.filter(item => liveUuids.has(item.uuid))

	return kept.length === selected.length ? selected : kept
}

export const usePlaylistsStore = create<PlaylistsStore>(set => ({
	selectedPlaylists: [],
	setSelectedPlaylists(fn) {
		set(state => ({
			selectedPlaylists: typeof fn === "function" ? fn(state.selectedPlaylists) : fn
		}))
	},
	toggleSelectedPlaylist(playlist) {
		set(state => ({
			selectedPlaylists: toggleInArray(state.selectedPlaylists, playlist, playlistId)
		}))
	},
	clearSelectedPlaylists() {
		set({ selectedPlaylists: [] })
	},
	selectAllPlaylists(playlists) {
		set({ selectedPlaylists: playlists })
	}
}))

export default usePlaylistsStore
