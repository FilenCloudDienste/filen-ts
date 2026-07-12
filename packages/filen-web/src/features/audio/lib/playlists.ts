import { Semaphore } from "@filen/utils"
import type { File as SdkFile, FileEncryptionVersion, UuidStr } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { log } from "@/lib/log"
import { narrowItem, asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { buildQueueTrack } from "@/features/audio/lib/handoff"
import { parsePlaylist, serializePlaylist, type Playlist, type PlaylistFile } from "@/features/audio/lib/playlistSchema"
import {
	addTracksToPlaylist as addTracksPure,
	createPlaylist as createPlaylistPure,
	pruneDeadTracks as pruneDeadTracksPure,
	removeTracksFromPlaylist as removeTracksPure,
	renamePlaylist as renamePlaylistPure,
	reorderPlaylistFile as reorderPure
} from "@/features/audio/lib/playlistOps"
import type { QueueTrack } from "@/features/audio/store/audioQueue"
import { playlistsQueryGet, playlistsQueryRemove, playlistsQueryUpsert, type PlaylistEntry } from "@/features/audio/queries/playlists"

// The `.filen/Playlists` on-disk contract's read/write engine — mirrors mobile's audio.ts playlist
// section (getPlaylistsDirectory/getPlaylists/mutatePlaylist/savePlaylist/reorderPlaylistFile), kept
// framework-free (no React) so every function here is directly unit-testable against a mocked sdkApi,
// same posture as features/drive/lib/actions.ts. UI components never talk to sdkApi directly for
// playlists — they call into this module, which owns the write-lock, the freshest-copy recompose and
// the query-cache patch.

const DOT_FILEN_DIR_NAME = ".filen"
const PLAYLISTS_DIR_NAME = "Playlists"

let playlistsDirUuidPromise: Promise<string> | null = null

async function resolvePlaylistsDirectoryUuid(): Promise<string> {
	const dotFilen = await runOp(sdkApi.createDirectory(null, DOT_FILEN_DIR_NAME))
	const playlists = await runOp(sdkApi.createDirectory(dotFilen.uuid, PLAYLISTS_DIR_NAME))

	return playlists.uuid
}

// Lazily create/find `.filen/Playlists` at the drive root, memoized for the tab's life —
// createDirectory is idempotent + case-insensitive server-side (an existing directory with this name
// returns ITS uuid rather than erroring), so no listing pre-check is needed at either level. A
// rejected resolve clears the memo before it propagates, so the NEXT caller gets a fresh attempt
// instead of every future playlist operation failing for the rest of the session on one transient
// network hiccup.
export function getPlaylistsDirectoryUuid(): Promise<string> {
	playlistsDirUuidPromise ??= resolvePlaylistsDirectoryUuid().catch((error: unknown) => {
		playlistsDirUuidPromise = null
		throw error
	})

	return playlistsDirUuidPromise
}

function fallbackDisplayName(item: DriveItem): string {
	return asDirectoryOrFile(item).data.decryptedMeta?.name ?? asDirectoryOrFile(item).data.uuid
}

function safeJsonParse(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(new TextDecoder().decode(bytes)) as unknown
	} catch {
		return null
	}
}

// Dead-track existence checks + the resulting cleanup persist run AT MOST ONCE per playlist per tab
// session — mirrors mobile's playlistCleanupDone discipline. A page reload (which a full sign-out
// already forces — see performLogout) is what resets this, same as every other module-level session
// cache in this feature (the audio store's own prefs-load memo, the engine's output-prefs memo).
const prunedThisSession = new Set<string>()

async function pruneDeadTracksOnce(playlist: Playlist): Promise<Playlist> {
	if (prunedThisSession.has(playlist.uuid) || playlist.files.length === 0) {
		return playlist
	}

	prunedThisSession.add(playlist.uuid)

	const checks = await Promise.all(
		playlist.files.map(async file => {
			try {
				const found = await runOp(sdkApi.getFile(file.uuid))

				return { uuid: file.uuid, dead: found === undefined }
			} catch (error) {
				// A transient existence-check failure is NOT a definitive not-found — keep the track rather
				// than risk pruning a live file over a flaky read (mirrors mobile's identical caution).
				log.warn("audio", "playlist dead-track check failed; keeping the track", { uuid: file.uuid, error })

				return { uuid: file.uuid, dead: false }
			}
		})
	)

	const deadUuids = new Set(checks.filter(check => check.dead).map(check => check.uuid))
	const cleaned = pruneDeadTracksPure(playlist, deadUuids)

	if (cleaned === null) {
		return playlist
	}

	// Fire-and-forget persist through the write-lock, recomposed against the freshest copy — a
	// concurrent user edit landing in the same tick is never clobbered by this cleanup.
	void mutatePlaylist(playlist.uuid, playlist, current => pruneDeadTracksPure(current, deadUuids)).catch((error: unknown) => {
		log.warn("audio", "playlist dead-track cleanup persist failed", { uuid: playlist.uuid, error })
	})

	return cleaned
}

async function readOnePlaylistEntry(file: SdkFile): Promise<PlaylistEntry> {
	const item = narrowItem(file)
	const base = asDirectoryOrFile(item)
	const fallbackName = fallbackDisplayName(item)

	if (base.type !== "file" || base.data.undecryptable) {
		return { status: "degraded", fileUuid: base.data.uuid, name: fallbackName }
	}

	try {
		const bytes = await runOp(sdkApi.downloadFileBytes(base.data, crypto.randomUUID()))
		const parsed = parsePlaylist(safeJsonParse(bytes))

		if (parsed === null) {
			return { status: "degraded", fileUuid: base.data.uuid, name: fallbackName }
		}

		return { status: "ok", playlist: await pruneDeadTracksOnce(parsed) }
	} catch (error) {
		// AU-05 parity: an isolated per-playlist read failure never collapses the whole screen — skip
		// just this row, keep the rest.
		log.warn("audio", "playlist read failed; skipping it", { uuid: base.data.uuid, error })

		return { status: "degraded", fileUuid: base.data.uuid, name: fallbackName }
	}
}

// The plain, testable list fetch — exported so this project's node-environment unit tests can exercise
// it against a mocked sdkApi (same rationale as fetchDirectoryListing/fetchNotes). Every entry is
// isolated: a parse/download failure on ONE playlist file surfaces as a degraded row rather than
// rejecting the whole call.
export async function fetchPlaylistEntries(): Promise<PlaylistEntry[]> {
	const dirUuid = await getPlaylistsDirectoryUuid()
	const { files } = await runOp(sdkApi.listDirectory({ kind: "uuid", uuid: dirUuid }))

	return Promise.all(files.map(readOnePlaylistEntry))
}

async function savePlaylist(playlist: Playlist): Promise<void> {
	const dirUuid = await getPlaylistsDirectoryUuid()
	const bytes = new TextEncoder().encode(serializePlaylist(playlist))

	await runOp(sdkApi.uploadFileBytes(dirUuid, bytes, `${playlist.uuid}.json`, "application/json"))
	playlistsQueryUpsert(playlist)
}

const writeLocks = new Map<string, Semaphore>()

function lockFor(uuid: string): Semaphore {
	let lock = writeLocks.get(uuid)

	if (lock === undefined) {
		lock = new Semaphore(1)
		writeLocks.set(uuid, lock)
	}

	return lock
}

function freshestPlaylist(uuid: string, fallback: Playlist): Playlist {
	const entries = playlistsQueryGet()
	const cached = entries?.find(entry => entry.status === "ok" && entry.playlist.uuid === uuid)

	return cached?.status === "ok" ? cached.playlist : fallback
}

// Serializes every whole-file write to a given playlist behind a per-uuid Semaphore(1), and re-reads
// the freshest copy from the query cache (the UI's own source of truth, kept warm by every prior
// read/write) as the merge base instead of the caller's possibly-stale snapshot — two edits that
// overlap in flight compose instead of the second clobbering the first's change with a stale full-file
// overwrite. `mutate` returning `null` means "no-op" and skips the upload entirely.
async function mutatePlaylist(uuid: string, fallback: Playlist, mutate: (current: Playlist) => Playlist | null): Promise<Playlist | null> {
	const lock = lockFor(uuid)

	await lock.acquire()

	try {
		const next = mutate(freshestPlaylist(uuid, fallback))

		if (next === null) {
			return null
		}

		await savePlaylist(next)

		return next
	} finally {
		lock.release()
	}
}

// ── Public actions ──────────────────────────────────────────────────────

export async function createPlaylist(name: string): Promise<Playlist> {
	const playlist = createPlaylistPure(crypto.randomUUID(), name, Date.now())

	await savePlaylist(playlist)

	return playlist
}

export function renamePlaylistAction(playlist: Playlist, name: string): Promise<Playlist | null> {
	return mutatePlaylist(playlist.uuid, playlist, current => renamePlaylistPure(current, name, Date.now()))
}

export function addTracksToPlaylistAction(playlist: Playlist, items: DriveItem[]): Promise<number> {
	const candidates = items
		.map(item => playlistFileFromDriveItem(item, playlist.uuid))
		.filter((file): file is PlaylistFile => file !== null)

	if (candidates.length === 0) {
		return Promise.resolve(0)
	}

	let added = 0

	return mutatePlaylist(playlist.uuid, playlist, current => {
		const result = addTracksPure(current, candidates, Date.now())

		added = result.added

		return result.next
	}).then(() => added)
}

export function removeTracksFromPlaylistAction(playlist: Playlist, uuids: string[]): Promise<Playlist | null> {
	return mutatePlaylist(playlist.uuid, playlist, current => removeTracksPure(current, uuids))
}

export function reorderPlaylistFileAction(playlist: Playlist, from: number, to: number): Promise<Playlist | null> {
	return mutatePlaylist(playlist.uuid, playlist, current => reorderPure(current, from, to))
}

// Deletes the playlist's own `${uuid}.json` file from the Playlists directory. Re-lists rather than
// trusting a cached file handle — a delete is infrequent and this guarantees the freshest handle
// (mirrors mobile's own re-list-then-delete). A playlist whose file is already gone (a concurrent
// delete from elsewhere) is treated as success: the query row is removed either way.
export async function deletePlaylistAction(playlist: Playlist): Promise<void> {
	const lock = lockFor(playlist.uuid)

	await lock.acquire()

	try {
		const dirUuid = await getPlaylistsDirectoryUuid()
		const { files } = await runOp(sdkApi.listDirectory({ kind: "uuid", uuid: dirUuid }))
		const targetName = `${playlist.uuid}.json`.toLowerCase()
		const match = files.find(file => fallbackDisplayName(narrowItem(file)).toLowerCase() === targetName)

		if (match) {
			await runOp(sdkApi.deleteFilePermanently(match))
		}

		playlistsQueryRemove(playlist.uuid)
	} finally {
		lock.release()
		// The uuid is gone for good (a new playlist never reuses a deleted one's uuid) — drop its lock so
		// a long session creating/deleting many playlists doesn't grow this map unbounded.
		writeLocks.delete(playlist.uuid)
	}
}

// ── Drive item ⇄ PlaylistFile ───────────────────────────────────────────

// Projects a picked drive file into the stored PlaylistFile shape (add-tracks picker). `null` for a
// directory or an undecryptable file — the picker itself filters these out already; this is
// belt-and-suspenders against a stale selection slipping through.
function playlistFileFromDriveItem(item: DriveItem, playlistUuid: string): PlaylistFile | null {
	const base = asDirectoryOrFile(item)

	if (base.type !== "file" || base.data.decryptedMeta === null) {
		return null
	}

	return {
		uuid: base.data.uuid,
		name: base.data.decryptedMeta.name,
		mime: base.data.decryptedMeta.mime,
		size: Number(base.data.size),
		bucket: base.data.bucket,
		key: base.data.decryptedMeta.key,
		// version is already a plain number (FileEncryptionVersion), unlike size/chunks below which are
		// bigints on the SDK type — no conversion needed.
		version: base.data.decryptedMeta.version,
		chunks: Number(base.data.chunks),
		region: base.data.region,
		playlist: playlistUuid
	}
}

// Rebuilds a playable drive item straight from a stored PlaylistFile — no re-listing the drive. `parent`
// has no real value to restore (the entry never carries its true drive location) so the file's own
// uuid stands in as a harmless placeholder, mirroring mobile's identical rebuild
// (playlistFileToDriveItem: `new ParentUuid.Uuid(file.uuid)`); nothing on the playback path reads it.
function driveItemFromPlaylistFile(entry: PlaylistFile): DriveItem {
	const now = BigInt(Date.now())
	const raw: SdkFile = {
		uuid: entry.uuid as UuidStr,
		meta: {
			type: "decoded",
			data: {
				name: entry.name,
				mime: entry.mime,
				modified: now,
				size: BigInt(entry.size),
				key: entry.key,
				version: entry.version as FileEncryptionVersion
			}
		},
		parent: entry.uuid as UuidStr,
		size: BigInt(entry.size),
		favorited: false,
		region: entry.region,
		bucket: entry.bucket,
		timestamp: now,
		chunks: BigInt(entry.chunks),
		canMakeThumbnail: false
	}

	return narrowItem(raw)
}

// Play integration entry point (Q4/step 3): builds the queue directly from the stored PlaylistFile
// entries, with no drive re-list — the whole point of storing bucket/region/key/version/chunks inline.
// Deliberately does NOT import the audioEngine singleton (see playlistPlayback.ts for the thin glue
// that does): that module boots real playback/media-session/kv-prefs side effects at import time,
// which this data-layer module must stay free of so it stays trivially unit-testable in node.
export function queueTracksFromPlaylist(playlist: Playlist): QueueTrack[] {
	return playlist.files.map(entry => buildQueueTrack(driveItemFromPlaylistFile(entry)))
}
