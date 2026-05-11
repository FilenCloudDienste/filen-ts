import { create } from "zustand"
import type { PlaylistWithItems } from "@/lib/audio"

export type PlaylistsStore = {
	selectedPlaylists: PlaylistWithItems[]
	setSelectedPlaylists: (fn: PlaylistWithItems[] | ((prev: PlaylistWithItems[]) => PlaylistWithItems[])) => void
}

export const usePlaylistsStore = create<PlaylistsStore>(set => ({
	selectedPlaylists: [],
	setSelectedPlaylists(fn) {
		set(state => ({
			selectedPlaylists: typeof fn === "function" ? fn(state.selectedPlaylists) : fn
		}))
	}
}))

export default usePlaylistsStore
