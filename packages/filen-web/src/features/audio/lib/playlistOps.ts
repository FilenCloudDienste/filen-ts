// The six pure Playlist CRUD/mutation functions (createPlaylist, renamePlaylist, addTracksToPlaylist,
// removeTracksFromPlaylist, reorderPlaylistFile, pruneDeadTracks) moved to @filen/shared's
// playlistOps.ts — mobile has the identical algorithm. moveArrayItem stays here: it's a generic
// drag-and-drop helper with no playlist-specific shape and no mobile counterpart.

// Generic array reorder for the track-row drag-and-drop idiom (dnd.ts's own native-HTML5 pattern,
// applied to an in-memory list rather than a cross-directory move) — moves the element at `from` to
// sit at `to`, shifting everything between. Always returns a fresh array, unchanged (but still copied)
// when `from`/`to` are equal or out of range.
export function moveArrayItem<T>(array: readonly T[], from: number, to: number): T[] {
	if (from === to || from < 0 || from >= array.length || to < 0 || to >= array.length) {
		return array.slice()
	}

	const next = array.slice()
	const [moved] = next.splice(from, 1)

	if (moved === undefined) {
		return array.slice()
	}

	next.splice(to, 0, moved)

	return next
}
