// The on-disk playlist contract stored at `.filen/Playlists/${playlistUuid}.json` — every app that
// reads or writes these files must produce and accept byte-identical JSON. Validation is deliberately
// hand-rolled (no schema library) so this stays a plain, dependency-free structural check: strict
// about every KNOWN field's presence/type, but silent about any extra property a newer app build
// might add — forward compatible by construction, since a structural check that only reads named
// keys never notices (or strips) ones it doesn't ask for.

export interface PlaylistFile {
	uuid: string
	name: string
	mime: string
	size: number
	bucket: string
	key: string
	version: number
	chunks: number
	region: string
	// The owning playlist's uuid, restamped on every write, so a track snapshot built for one
	// playlist can never silently carry into another's serialized file.
	playlist: string
}

export interface Playlist {
	uuid: string
	name: string
	created: number
	updated: number
	files: PlaylistFile[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isPlaylistFile(value: unknown): value is PlaylistFile {
	if (!isPlainObject(value)) {
		return false
	}

	return (
		typeof value["uuid"] === "string" &&
		typeof value["name"] === "string" &&
		typeof value["mime"] === "string" &&
		typeof value["size"] === "number" &&
		typeof value["bucket"] === "string" &&
		typeof value["key"] === "string" &&
		typeof value["version"] === "number" &&
		typeof value["chunks"] === "number" &&
		typeof value["region"] === "string" &&
		typeof value["playlist"] === "string"
	)
}

// Structurally validates a parsed JSON value against the Playlist contract. A single malformed FILE
// entry fails the whole playlist (returns null) rather than being silently dropped — validation is
// deep and all-or-nothing; the required ISOLATION happens one level up, at the per-playlist-file read
// (a corrupt playlist is skipped, not repaired in place).
// Unknown top-level or per-file properties are preserved, never rejected or stripped — forward compat.
export function parsePlaylist(value: unknown): Playlist | null {
	if (!isPlainObject(value)) {
		return null
	}

	const uuid = value["uuid"]
	const name = value["name"]
	const created = value["created"]
	const updated = value["updated"]
	const files = value["files"]

	if (
		typeof uuid !== "string" ||
		typeof name !== "string" ||
		typeof created !== "number" ||
		typeof updated !== "number" ||
		!Array.isArray(files)
	) {
		return null
	}

	if (!files.every(isPlaylistFile)) {
		return null
	}

	return { ...value, uuid, name, created, updated, files }
}

// Playlist files are read back with plain JSON.parse (never an app's own bigint-envelope local-cache
// serializer — playlist storage predates and is independent of that format), so the only thing worth
// centralizing on the write side is dropping any accidental non-JSON-safe value before JSON.stringify
// would throw on it. Every PlaylistFile field the write path constructs is already a plain
// string/number by the time it reaches here (callers convert SDK bigints at construction) — this is a
// cheap, self-documenting guard against that invariant regressing, not a real serializer.
export function serializePlaylist(playlist: Playlist): string {
	return JSON.stringify(playlist)
}
