import { create } from "zustand"
import type { Playlist } from "@filen/shared"

export type PlaylistDialog = { kind: "create" } | { kind: "rename"; playlist: Playlist } | { kind: "delete"; playlist: Playlist }

// The one create/rename/delete dialog the /playlists split view can have open. A store rather than
// component state because the two surfaces that open it share no ancestor below the shell: the sidebar
// is the shell's, the pane is the route's. PlaylistDialogsHost (mounted once, by the route screen) owns
// the mutation and its pending state.
export const usePlaylistDialogStore = create<{ dialog: PlaylistDialog | null }>(() => ({ dialog: null }))

export function openPlaylistDialog(dialog: PlaylistDialog): void {
	usePlaylistDialogStore.setState({ dialog })
}

export function closePlaylistDialog(): void {
	usePlaylistDialogStore.setState({ dialog: null })
}
