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
