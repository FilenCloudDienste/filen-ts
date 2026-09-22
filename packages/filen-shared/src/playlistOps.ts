import type { Playlist, PlaylistFile } from "./playlist"

// Pure playlist mutation logic — every CRUD edit an app applies inside its write-lock, factored out
// so the composition rules (dedup-on-add, restamp-on-add, index-bounds on reorder/remove) are
// unit-testable with no lock, no network client and no cache. Each function returns `null` to mean
// "no-op, nothing actually changed" so the write-lock layer can skip the upload entirely rather than
// re-persisting an identical file. None of these read the clock themselves — callers pass `now` so
// the library stays deterministic and testable.

export function createPlaylist(uuid: string, name: string, now: number): Playlist {
	return { uuid, name, created: now, updated: now, files: [] }
}

export function renamePlaylist(current: Playlist, name: string, now: number): Playlist {
	return { ...current, name, updated: now }
}

// Appends tracks not already present (by file uuid), re-stamping each entry's `playlist` field to the
// CURRENT playlist's uuid — a caller-built snapshot for a different playlist (or a stale one from
// before a rename-of-a-different-field) can never leak a wrong owner into storage. Dedup runs against
// `current`, which the write-lock layer has already resolved to the freshest copy, so a track added
// concurrently by another mutation is respected rather than re-added.
export function addTracksToPlaylist(current: Playlist, tracks: PlaylistFile[], now: number): { next: Playlist | null; added: number } {
	const existing = new Set(current.files.map(file => file.uuid))
	const toAppend = tracks.filter(track => !existing.has(track.uuid)).map(track => ({ ...track, playlist: current.uuid }))

	if (toAppend.length === 0) {
		return { next: null, added: 0 }
	}

	return { next: { ...current, files: [...current.files, ...toAppend], updated: now }, added: toAppend.length }
}

export function removeTracksFromPlaylist(current: Playlist, uuids: readonly string[], now: number): Playlist | null {
	if (uuids.length === 0) {
		return null
	}

	const toRemove = new Set(uuids)
	const files = current.files.filter(file => !toRemove.has(file.uuid))

	if (files.length === current.files.length) {
		return null
	}

	return { ...current, files, updated: now }
}

// Moves the track at `from` to `to` (both against `current.files`' own indices, so a stale `from`/`to`
// pair computed against an older snapshot naturally lands on whatever now occupies those slots — the
// same freshest-recompose rule as add/remove). Out-of-range indices are a no-op.
export function reorderPlaylistFile(current: Playlist, from: number, to: number, now: number): Playlist | null {
	if (from === to || from < 0 || from >= current.files.length || to < 0 || to >= current.files.length) {
		return null
	}

	const files = current.files.slice()
	const [moved] = files.splice(from, 1)

	if (!moved) {
		return null
	}

	files.splice(to, 0, moved)

	return { ...current, files, updated: now }
}

// Drops every file whose uuid is in `deadUuids` (the drive-side existence check came back negative).
// Separated from removeTracksFromPlaylist only so the dead-track-prune call site never has to build a
// throwaway array just to reuse the same filter — the semantics are identical. Deliberately does NOT
// bump `updated`: a background prune is not a user edit, and both apps rely on that to tell the two
// apart.
export function pruneDeadTracks(current: Playlist, deadUuids: ReadonlySet<string>): Playlist | null {
	if (deadUuids.size === 0) {
		return null
	}

	const files = current.files.filter(file => !deadUuids.has(file.uuid))

	if (files.length === current.files.length) {
		return null
	}

	return { ...current, files }
}
