import {
	DOT_FILEN_SUBDIRS,
	KeyedSemaphores,
	driveItemName,
	isDotFilenSubdirName,
	parsePlaylist,
	type Playlist,
	type PlaylistFile,
	addTracksToPlaylist as addTracksPure,
	createPlaylist as createPlaylistPure,
	pruneDeadTracks as pruneDeadTracksPure,
	removeTracksFromPlaylist as removeTracksPure,
	renamePlaylist as renamePlaylistPure,
	reorderPlaylistFile as reorderPure
} from "@filen/shared"
import type { DriveEvent, File as SdkFile, FileEncryptionVersion, UuidStr } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { asErrorDTO, DIRECTORY_NOT_FOUND_PREFIX, PARENT_NOT_FOUND_PREFIX, type ErrorDTO } from "@/lib/sdk/errors"
import { log } from "@/lib/log"
import {
	dotFilenSubdirUuid,
	findDotFilenSubdir,
	forgetDotFilenSubdir,
	getDotFilenSubdir,
	knownDotFilenUuid,
	noteDotFilenFile,
	onDotFilenSubdirForgotten
} from "@/lib/dotFilen"
import { narrowItem, asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { buildQueueTrack } from "@/features/audio/lib/handoff"
import type { QueueTrack } from "@/features/audio/store/audioQueue"
import {
	markPlaylistsUnsynced,
	playlistsQueryGet,
	playlistsQueryRemove,
	playlistsQueryUpsert,
	type PlaylistEntry
} from "@/features/audio/queries/playlists"

// The `.filen/playlists` on-disk contract's read/write engine — mirrors mobile's audio.ts playlist
// section (getPlaylistsDirectory/getPlaylists/mutatePlaylist/savePlaylist/reorderPlaylistFile), kept
// framework-free (no React) so every function here is directly unit-testable against a mocked sdkApi,
// same posture as features/drive/lib/actions.ts. UI components never talk to sdkApi directly for
// playlists — they call into this module, which owns the write-lock, the freshest-copy recompose and
// the query-cache patch.

const PLAYLISTS_DIR_NAME = DOT_FILEN_SUBDIRS.playlists

// Drive uuids of the files this tab knows the Playlists directory holds: the last listing plus its own
// uploads since. What lets a uuid-only socket event be tied to a playlist.
const knownPlaylistFileUuids = new Set<string>()

// Raw (pre-prune) parses from the last listing by drive file uuid. A file's uuid rotates on every
// content change, so the bytes behind one never change and its parse can be reused. `null` is bytes that
// do not parse as a playlist: as final as a parse, so that file is never downloaded again. A failed download
// or an undecryptable file has no entry and is retried.
let parsedByFileUuid = new Map<string, Playlist | null>()

// `.filen/playlists` at the drive root, shared with the other `.filen` consumers (lib/dotFilen.ts).
export function getPlaylistsDirectoryUuid(): Promise<string> {
	return getDotFilenSubdir(PLAYLISTS_DIR_NAME)
}

// `.filen` or `playlists` itself was trashed, deleted, moved or renamed: the memo now names the wrong
// directory (or none), so the next use re-resolves it and the cache re-reads from there.
onDotFilenSubdirForgotten(PLAYLISTS_DIR_NAME, () => {
	knownPlaylistFileUuids.clear()
	parsedByFileUuid = new Map()
	markPlaylistsUnsynced()
})

export function forgetPlaylistsDirectory(): void {
	forgetDotFilenSubdir(PLAYLISTS_DIR_NAME)
}

// A plain worker throw when the uuid no longer resolves, or the SDK's own kind for a gone folder.
function isDirectoryGone(dto: ErrorDTO): boolean {
	return (
		dto.kind === "FolderNotFound" ||
		(dto.species === "plain" && (dto.message.startsWith(DIRECTORY_NOT_FOUND_PREFIX) || dto.message.startsWith(PARENT_NOT_FOUND_PREFIX)))
	)
}

// runOp for an op addressed to the Playlists directory: a gone directory also drops the memo, so the
// failure isn't repeated against it for the rest of the session.
async function runPlaylistsDirectoryOp<T>(op: Promise<T>): Promise<T> {
	try {
		return await runOp(op)
	} catch (error) {
		if (isDirectoryGone(asErrorDTO(error))) {
			forgetPlaylistsDirectory()
		}

		throw error
	}
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
// cache in this feature (the audio store's own prefs-load memo, the engine's output-prefs memo). A
// playlist joins only once its checks completed; `pruning` holds the ones whose checks are still out.
const prunedThisSession = new Set<string>()
const pruning = new Set<string>()

// The dead tracks each checked playlist held, by playlist uuid, so a later read of a copy that still
// lists them (the cleanup upload failed, or a listing raced it) shows it pruned without asking again. A
// uuid leaves once a read sees a copy without it, or once it is added again (addedDuringPass covers an
// add while the checks are out): a track added back later is not dropped by a stale set.
const deadByPlaylist = new Map<string, Set<string>>()
const addedDuringPass = new Map<string, Set<string>>()

function forgetDead(playlistUuid: string, trackUuids: readonly string[]): void {
	const dead = deadByPlaylist.get(playlistUuid)

	if (dead !== undefined) {
		for (const uuid of trackUuids) {
			dead.delete(uuid)
		}

		if (dead.size === 0) {
			deadByPlaylist.delete(playlistUuid)
		}
	}

	if (pruning.has(playlistUuid)) {
		const added = addedDuringPass.get(playlistUuid) ?? new Set<string>()

		for (const uuid of trackUuids) {
			added.add(uuid)
		}

		addedDuringPass.set(playlistUuid, added)
	}
}

// A filled cache without the playlist's row means it was deleted (here, or elsewhere and re-read) since it
// was checked: its cleanup must not upload it back.
function deletedSinceChecked(uuid: string): boolean {
	const entries = playlistsQueryGet()

	return entries !== undefined && !entries.some(entry => entry.status === "ok" && entry.playlist.uuid === uuid)
}

function withoutKnownDead(playlist: Playlist): Playlist {
	const dead = deadByPlaylist.get(playlist.uuid)

	if (dead === undefined) {
		return playlist
	}

	const listed = new Set(playlist.files.map(file => file.uuid))

	for (const uuid of dead) {
		if (!listed.has(uuid)) {
			dead.delete(uuid)
		}
	}

	if (dead.size === 0) {
		deadByPlaylist.delete(playlist.uuid)

		return playlist
	}

	return pruneDeadTracksPure(playlist, dead) ?? playlist
}

// One pass's existence checks by track uuid, so a track shared by several playlists (or listed twice in
// one) costs one getFile. Scoped to the read that started the pass rather than the session: a later
// read checking a newly seen playlist asks afresh instead of trusting an answer that may have gone stale.
type TrackExistence = Map<string, Promise<boolean>>

function trackIsDead(uuid: string, existence: TrackExistence): Promise<boolean> {
	let check = existence.get(uuid)

	if (check === undefined) {
		check = runOp(sdkApi.getFile(uuid)).then(
			found => found === undefined,
			(error: unknown) => {
				// A transient existence-check failure is NOT a definitive not-found — keep the track rather
				// than risk pruning a live file over a flaky read (mirrors mobile's identical caution).
				log.warn("audio", "playlist dead-track check failed; keeping the track", { uuid, error })

				return false
			}
		)
		existence.set(uuid, check)
	}

	return check
}

async function prunePass(playlist: Playlist, existence: TrackExistence): Promise<void> {
	try {
		const dead = await Promise.all(playlist.files.map(file => trackIsDead(file.uuid, existence)))
		const added = addedDuringPass.get(playlist.uuid)
		const deadUuids = new Set(
			playlist.files.filter((file, index) => dead[index] === true && added?.has(file.uuid) !== true).map(file => file.uuid)
		)

		prunedThisSession.add(playlist.uuid)

		if (deadUuids.size === 0) {
			return
		}

		deadByPlaylist.set(playlist.uuid, deadUuids)

		// Through the write-lock, recomposed against the freshest copy — a concurrent user edit is never
		// clobbered by this cleanup. A cached copy older than the one checked (restored from a previous
		// session) is not a base to write back over it. The dead set is read under the lock, so a track
		// added back while this waited stays. The listed row is patched before the upload, so a failed
		// cleanup upload still leaves the dead tracks out of the list; an unfilled cache is left alone.
		await mutatePlaylist(
			playlist.uuid,
			playlist,
			current => {
				const stillDead = deadByPlaylist.get(playlist.uuid)

				if (stillDead === undefined || deletedSinceChecked(playlist.uuid)) {
					return null
				}

				const next = pruneDeadTracksPure(current.updated > playlist.updated ? current : playlist, stillDead)

				if (next !== null && playlistsQueryGet() !== undefined) {
					playlistsQueryUpsert(next)
				}

				return next
			},
			{ patchCache: false }
		)
	} catch (error) {
		log.warn("audio", "playlist dead-track cleanup persist failed", { uuid: playlist.uuid, error })
	} finally {
		pruning.delete(playlist.uuid)
		addedDuringPass.delete(playlist.uuid)
	}
}

// The list never waits on the checks (one getFile per track). They start a task after the read returned,
// once its rows are in the cache, so the cleanup's cache patch neither cancels that read nor finds an
// unfilled cache to collapse to one row.
function startPrunePasses(playlists: Playlist[]): void {
	const unchecked: Playlist[] = []

	for (const playlist of playlists) {
		if (playlist.files.length > 0 && !prunedThisSession.has(playlist.uuid) && !pruning.has(playlist.uuid)) {
			pruning.add(playlist.uuid)
			unchecked.push(playlist)
		}
	}

	if (unchecked.length === 0) {
		return
	}

	setTimeout(() => {
		const existence: TrackExistence = new Map()

		for (const playlist of unchecked) {
			void prunePass(playlist, existence)
		}
	}, 0)
}

// A row the next read would give again: a parsed playlist, or a file whose bytes do not parse.
export function isSettledPlaylistEntry(entry: PlaylistEntry): boolean {
	return entry.status === "ok" || parsedByFileUuid.get(entry.fileUuid) === null
}

async function readOnePlaylistEntry(file: SdkFile, nextParsed: Map<string, Playlist | null>): Promise<PlaylistEntry> {
	const item = narrowItem(file)
	const base = asDirectoryOrFile(item)
	const fallbackName = driveItemName(base)

	if (base.type !== "file" || base.data.undecryptable) {
		return { status: "degraded", fileUuid: base.data.uuid, name: fallbackName }
	}

	try {
		const known = parsedByFileUuid.get(base.data.uuid)
		const parsed =
			known !== undefined
				? known
				: parsePlaylist(safeJsonParse(await runOp(sdkApi.downloadFileBytes(base.data, crypto.randomUUID()))))

		nextParsed.set(base.data.uuid, parsed)

		if (parsed === null) {
			return { status: "degraded", fileUuid: base.data.uuid, name: fallbackName }
		}

		return { status: "ok", playlist: withoutKnownDead(parsed) }
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
	// A read creates nothing: no Playlists directory (or no `.filen`) is no playlists, until the first one is saved.
	const dirUuid = await findDotFilenSubdir(PLAYLISTS_DIR_NAME)

	if (dirUuid === null) {
		knownPlaylistFileUuids.clear()
		parsedByFileUuid = new Map()

		return []
	}

	const { files } = await runPlaylistsDirectoryOp(sdkApi.listDirectory({ kind: "uuid", uuid: dirUuid }))

	knownPlaylistFileUuids.clear()

	for (const file of files) {
		knownPlaylistFileUuids.add(file.uuid)
		noteDotFilenFile(file.uuid)
	}

	const nextParsed = new Map<string, Playlist | null>()
	const entries = await Promise.all(files.map(file => readOnePlaylistEntry(file, nextParsed)))

	parsedByFileUuid = nextParsed
	startPrunePasses([...nextParsed.values()].filter(parsed => parsed !== null))

	return entries
}

// Whether a drive event may have changed the Playlists directory's contents behind the query cache. A
// content edit arrives as the old version retired plus a fileNew, so the fileNew is the one signal; one
// for a uuid this tab already knows is its own save echoing back (an echo that beats the upload's return
// still counts, costing a refetch, never a missed change). Every other event counts when it lands a file
// in the directory or names a known one — version-only deletes and edit-retirements excepted.
// While no Playlists directory is known (a read found none, which counts as a clean read), one created or
// restored elsewhere is the only sign its first playlist may follow: a fileNew into it can't be tied to it
// yet. Under the known `.filen`, or under any parent while `.filen` itself is unknown.
function isPlaylistsDirectoryArrival(inner: DriveEvent): boolean {
	if (inner.type !== "folderSubCreated" && inner.type !== "folderRestore") {
		return false
	}

	const dotFilenUuid = knownDotFilenUuid()

	return (
		inner.dir.meta.type === "decoded" &&
		isDotFilenSubdirName(inner.dir.meta.data.name, PLAYLISTS_DIR_NAME) &&
		(dotFilenUuid === null || inner.dir.parent === dotFilenUuid)
	)
}

export function isPlaylistsDriveEvent(inner: DriveEvent): boolean {
	const playlistsDirUuid = dotFilenSubdirUuid(PLAYLISTS_DIR_NAME)

	if (playlistsDirUuid === null) {
		return isPlaylistsDirectoryArrival(inner)
	}

	switch (inner.type) {
		case "fileNew":
			return inner.file.parent === playlistsDirUuid && !knownPlaylistFileUuids.has(inner.file.uuid)

		case "fileRestore":
		case "fileMove":
			return inner.file.parent === playlistsDirUuid || knownPlaylistFileUuids.has(inner.file.uuid)

		case "fileArchiveRestored":
			return inner.file.parent === playlistsDirUuid || knownPlaylistFileUuids.has(inner.currentUuid)

		case "fileTrash":
			return inner.newUUID === undefined && knownPlaylistFileUuids.has(inner.uuid)

		case "fileDeletedPermanent":
			return inner.stableUUID !== undefined && knownPlaylistFileUuids.has(inner.uuid)

		case "fileMetadataChanged":
			return knownPlaylistFileUuids.has(inner.uuid)

		default:
			return false
	}
}

async function savePlaylist(playlist: Playlist, patchCache: boolean): Promise<void> {
	const dirUuid = await getPlaylistsDirectoryUuid()
	const bytes = new TextEncoder().encode(JSON.stringify(playlist))
	const file = await runPlaylistsDirectoryOp(sdkApi.uploadFileBytes(dirUuid, bytes, `${playlist.uuid}.json`, "application/json"))

	knownPlaylistFileUuids.add(file.uuid)
	noteDotFilenFile(file.uuid)

	if (patchCache) {
		playlistsQueryUpsert(playlist)
	}
}

const writeLocks = new KeyedSemaphores()

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
async function mutatePlaylist(
	uuid: string,
	fallback: Playlist,
	mutate: (current: Playlist) => Playlist | null,
	{ patchCache = true }: { patchCache?: boolean } = {}
): Promise<Playlist | null> {
	const release = await writeLocks.acquire(uuid)

	try {
		const next = mutate(freshestPlaylist(uuid, fallback))

		if (next === null) {
			return null
		}

		await savePlaylist(next, patchCache)

		return next
	} finally {
		release()
	}
}

// ── Public actions ──────────────────────────────────────────────────────

export async function createPlaylist(name: string): Promise<Playlist> {
	const playlist = createPlaylistPure(crypto.randomUUID(), name, Date.now())

	await savePlaylist(playlist, true)

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
		// Picked again, so live: a set from an earlier check must not prune it.
		forgetDead(
			playlist.uuid,
			candidates.map(file => file.uuid)
		)

		const result = addTracksPure(current, candidates, Date.now())

		added = result.added

		return result.next
	}).then(() => added)
}

export function removeTracksFromPlaylistAction(playlist: Playlist, uuids: string[]): Promise<Playlist | null> {
	return mutatePlaylist(playlist.uuid, playlist, current => removeTracksPure(current, uuids, Date.now()))
}

// Addressed by uuid, not index: the caller's indices come from the list it displays, while the move
// applies to the freshest copy after waiting on the write lock, which an earlier edit may have
// reordered. `targetUuid` is the track whose slot the moved one takes.
export function reorderPlaylistFileAction(playlist: Playlist, movedUuid: string, targetUuid: string): Promise<Playlist | null> {
	return mutatePlaylist(playlist.uuid, playlist, current => {
		const from = current.files.findIndex(file => file.uuid === movedUuid)
		const to = current.files.findIndex(file => file.uuid === targetUuid)

		return from === -1 || to === -1 ? null : reorderPure(current, from, to, Date.now())
	})
}

// Deletes the playlist's own `${uuid}.json` file from the Playlists directory. Re-lists rather than
// trusting a cached file handle — a delete is infrequent and this guarantees the freshest handle
// (mirrors mobile's own re-list-then-delete). A playlist whose file is already gone (a concurrent
// delete from elsewhere) is treated as success: the query row is removed either way.
export async function deletePlaylistAction(playlist: Playlist): Promise<void> {
	const release = await writeLocks.acquire(playlist.uuid)

	try {
		const dirUuid = await getPlaylistsDirectoryUuid()
		const { files } = await runPlaylistsDirectoryOp(sdkApi.listDirectory({ kind: "uuid", uuid: dirUuid }))
		const targetName = `${playlist.uuid}.json`.toLowerCase()
		const match = files.find(file => driveItemName(narrowItem(file)).toLowerCase() === targetName)

		if (match) {
			await runOp(sdkApi.deleteFilePermanently(match))
			// So this delete's own socket echo isn't taken for a remote change (one racing ahead of this
			// line still is, which costs a refetch, never a missed change).
			knownPlaylistFileUuids.delete(match.uuid)
		}

		playlistsQueryRemove(playlist.uuid)
		deadByPlaylist.delete(playlist.uuid)
	} finally {
		release()
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
		// The stored PlaylistFile carries no whole-life id, and nothing on the playback path reads one.
		stableUUID: undefined,
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
		// PlaylistFile carries no SDK flag and the SDK never thumbnails audio, so the veto is the
		// correct value here — not a placeholder standing in for one.
		canMakeThumbnail: false
	}

	return narrowItem(raw)
}

// Play integration entry point: builds the queue directly from the stored PlaylistFile
// entries, with no drive re-list — the whole point of storing bucket/region/key/version/chunks inline.
// Deliberately does NOT import the audioEngine singleton (see playlistPlayback.ts for the thin glue
// that does): that module boots real playback/media-session/kv-prefs side effects at import time,
// which this data-layer module must stay free of so it stays trivially unit-testable in node.
export function queueTracksFromPlaylist(playlist: Playlist): QueueTrack[] {
	return playlist.files.map(playlistFileTrack)
}

// One stored entry as a playable track, for anything that reads the file itself (metadata included).
export function playlistFileTrack(entry: PlaylistFile): QueueTrack {
	return buildQueueTrack(driveItemFromPlaylistFile(entry))
}
