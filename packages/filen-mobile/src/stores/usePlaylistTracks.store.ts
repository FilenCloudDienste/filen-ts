import { create } from "zustand"
import type { PlaylistWithItems } from "@/lib/audio"
import { toggleInArray } from "@/stores/createSelectionSlice"

export type PlaylistTrack = PlaylistWithItems["files"][number]

export type PlaylistTracksStore = {
	selectedTracks: PlaylistTrack[]
	setSelectedTracks: (fn: PlaylistTrack[] | ((prev: PlaylistTrack[]) => PlaylistTrack[])) => void
	toggleSelectedTrack: (track: PlaylistTrack) => void
	clearSelectedTracks: () => void
	selectAllTracks: (tracks: PlaylistTrack[]) => void
}

const trackId = (t: PlaylistTrack) => t.uuid

export const usePlaylistTracksStore = create<PlaylistTracksStore>(set => ({
	selectedTracks: [],
	setSelectedTracks(fn) {
		set(state => ({
			selectedTracks: typeof fn === "function" ? fn(state.selectedTracks) : fn
		}))
	},
	toggleSelectedTrack(track) {
		set(state => ({
			selectedTracks: toggleInArray(state.selectedTracks, track, trackId)
		}))
	},
	clearSelectedTracks() {
		set({ selectedTracks: [] })
	},
	selectAllTracks(tracks) {
		set({ selectedTracks: tracks })
	}
}))

export default usePlaylistTracksStore
