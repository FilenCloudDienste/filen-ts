import * as FileSystem from "expo-file-system"
import type { DriveItem } from "@/types"
import { run, Semaphore } from "@filen/utils"
import transfers from "@/features/transfers/transfers"
import { serialize, deserialize, serializeEquals } from "@/lib/serializer"
import auth from "@/lib/auth"
import { NonRootDir_Tags } from "@filen/sdk-rs"
import {
	unwrapFileMeta,
	unwrapDirMeta,
	unwrapAnyDirUuid,
	unwrappedDirIntoDriveItem,
	unwrappedFileIntoDriveItem
} from "@/lib/sdkUnwrap"
import { sumLocalDirectoryFileBytes } from "@/lib/fsUtils"
import { ClearBarrier } from "@/lib/clearBarrier"
import {
	atomicWrite,
	parentCacheKey,
	directoryDriveItemToAnyDirWithContext,
	findStaleStoredOfflineEntries,
	makeSyncError,
	type OfflineParent,
	type OfflineSyncError
} from "@/features/offline/offlineHelpers"
import {
	planTreeReconcile,
	isSyncTmpName,
	uuidFromSyncTmpName,
	type LocalTreeEntry,
	type RemoteTreeEntry
} from "@/features/offline/offlineSyncPlanner"
import { validateUuid } from "@/lib/uuid"
import {
	driveItemStoredOfflineQueryUpdate,
	getStoredOfflineQueryCacheEntries
} from "@/features/drive/queries/useDriveItemStoredOffline.query"
import { driveItemsQueryUpdate } from "@/features/drive/queries/useDriveItems.query"
import { isFileItem, isDirectoryItem } from "@/features/drive/driveSelectors"
import {
	OFFLINE_VERSION,
	OFFLINE_PARENT_DIRECTORY,
	OFFLINE_DIRECTORY,
	OFFLINE_FILES_DIRECTORY,
	OFFLINE_DIRECTORIES_DIRECTORY,
	OFFLINE_INDEX_FILE
} from "@/lib/storageRoots"

export type Uuid = string

export type FileOrDirectoryOfflineMeta = {
	item: DriveItem
	parent: OfflineParent
	// Observed on-disk byte size, recorded ONLY when it diverged from the item's meta size at
	// verification time. Meta sizes are client-supplied at upload and untrustworthy (same class
	// as lastModified) — remote content can genuinely be shorter than its claimed size (e.g. a
	// crashed upload). The SDK downloads whatever chunks exist and reports success; this records
	// what it actually delivered so heals compare against delivered truth instead of
	// re-downloading (and re-failing) such files on every pass forever.
	diskSize?: number
}

export type DirectoryOfflineMeta = FileOrDirectoryOfflineMeta & {
	entries: Record<
		Uuid,
		{
			item: DriveItem
			// Raw root-relative listing path with leading "/" — original decrypted names,
			// NEVER decoded or encoded. Disk access is Paths.join(treeDir.uri, path).
			path: string
			// Same contract as FileOrDirectoryOfflineMeta.diskSize — present only for files
			// whose verified on-disk size diverges from their meta size.
			diskSize?: number
		}
	>
}

export type Index = {
	files: Record<
		Uuid,
		{
			item: DriveItem
			parent: OfflineParent
		}
	>
	directories: Record<
		Uuid,
		{
			item: DriveItem
			parent: OfflineParent
		}
	>
}

// Critical: When changing anything related to offline storage index/store/persistence format, bump OFFLINE_VERSION in storageRoots.ts to invalidate old caches and prevent potential issues from stale or incompatible data.
export const VERSION = OFFLINE_VERSION
export const DIRECTORY = OFFLINE_DIRECTORY
export const FILES_DIRECTORY = OFFLINE_FILES_DIRECTORY
export const DIRECTORIES_DIRECTORY = OFFLINE_DIRECTORIES_DIRECTORY
export const INDEX_FILE = OFFLINE_INDEX_FILE

// Root URIs are stable for the process lifetime — read the (native-backed) uri getters once
// instead of per call site in entry loops.
const FILES_DIRECTORY_URI = FILES_DIRECTORY.uri
const DIRECTORIES_DIRECTORY_URI = DIRECTORIES_DIRECTORY.uri

// NFC-normalize only when non-ASCII is present — String.normalize is expensive on Hermes and
// nearly all real paths are pure ASCII, for which it is the identity. The charCode scan is
// ~free by comparison.
function normalizeNfcFast(value: string): string {
	for (let i = 0; i < value.length; i++) {
		if (value.charCodeAt(i) > 127) {
			return value.normalize("NFC")
		}
	}

	return value
}

// dirname for RAW root-relative entry paths (always lead with "/", never end with one):
// "/a/b" → "/a", "/a" → "/". Replaces FileSystem.Paths.dirname + the "."/"" normalization in
// per-entry listing loops.
function rawPathDirname(path: string): string {
	const lastSlash = path.lastIndexOf("/")

	return lastSlash <= 0 ? "/" : path.slice(0, lastSlash)
}

// Manages offline file/directory storage on device.
//
// Storage layout (v2):
//   offline/v{N}/files/{uuid}/{filename}        — standalone files (one data file + one .filenmeta)
//   offline/v{N}/directories/{uuid}/...         — directory trees (in-place reconciled download + one .filenmeta with entries map)
//   offline/v{N}/index                          — serialized Index of all stored items (rebuilt on mutation)
//
// Key concepts:
//   - "Standalone" items are stored individually under files/ or as a top-level directory.
//   - A stored directory's subtree is flattened into the .filenmeta `entries` map, keyed by entry
//     UUID. Each entry records its RAW root-relative listing path (leading "/", original decrypted
//     names — never decoded/encoded). Disk access is always Paths.join(treeDir.uri, entry.path);
//     expo-file-system handles percent-encoding internally.
//   - File UUIDs rotate on every content change (same uuid ⟹ identical bytes), so tree state is a
//     pure uuid set-diff — there are NO timestamp comparisons anywhere.
//   - reconcileTree() converges one stored tree onto its remote listing IN PLACE: rename/move/delete
//     local entries per the pure planner (offlineSyncPlanner), run at most ONE hash-idempotent
//     directory download for missing entries, verify (after downloads, and end-to-end on thorough
//     passes), and only then commit meta + index. The LOCAL view is index-only by default
//     (automatic passes trust the meta — no per-entry stats) and disk-verified when thorough: true
//     (user-explicit passes) or when leftover .sync-tmp-* temps prove a crashed pass. No staging,
//     no swap — a failed pass leaves disk state untouched, returns OfflineSyncErrors, and the next
//     pass re-converges. A no-op pass writes nothing (serialized-meta fixed point).
//   - The Index is the source of truth for "is this item offline?" queries and is rebuilt atomically.
//   - Standalone copies that overlap a stored tree (same UUID inside the tree) are removed on commit
//     (overlap dedup).
export class Offline {
	// indexMutex(1): serializes index read/write to prevent concurrent corruption.
	private readonly indexMutex = new Semaphore(1)
	private indexCache: Index | null = null
	// storeMutex(3): allows up to 3 concurrent file/directory downloads while still bounding I/O.
	private readonly storeMutex = new Semaphore(3)
	// storeItemMutexes: per-UUID Semaphore(1) lock serializing storeFile/storeDirectory/reconcileTree
	// for the same item. Without this, two concurrent store calls for the same UUID both pass the
	// isItemStored guard (cold cache) and race the destructive parent-directory delete/recreate, so
	// call B wipes call A's in-flight download target mid-transfer. Keyed by UUID so distinct items
	// still download concurrently up to storeMutex(3).
	private readonly storeItemMutexes = new Map<string, Semaphore>()
	// clearBarrier: serializes clearAll against in-flight storeFile/storeDirectory/reconcileTree/removeItem.
	private readonly clearBarrier = new ClearBarrier()
	private readonly listDirectoriesCache = new Map<string, Awaited<ReturnType<Offline["listDirectories"]>>>()
	private listFilesCache: Awaited<ReturnType<Offline["listFiles"]>> | null = null
	private listDirectoriesRecursiveCache: Awaited<ReturnType<Offline["listDirectoriesRecursive"]>> | null = null
	private readonly itemSizeCache = new Map<
		string,
		{
			size: number
			files: number
			dirs: number
		}
	>()
	private readonly isItemStoredCache = new Map<string, boolean>()
	private readonly getLocalFileCache = new Map<string, FileSystem.File>()
	private readonly getLocalDirectoryCache = new Map<string, FileSystem.Directory>()
	private directoriesEnsured = false
	private versionSweepDone = false
	private readonly directoryMetaCache = new Map<string, DirectoryOfflineMeta>()
	private uuidToTopLevelCache: Map<string, string> | null = null
	// Monotonic count of cache invalidations — every disk mutation path calls invalidateCaches,
	// so an unchanged counter proves the store is byte-identical to the last in-process rebuild.
	private mutationCounter = 0
	// mutationCounter value captured after the last FULL in-process index rebuild. -1 until the
	// first rebuild this session: an index loaded from disk is never trusted as rebuild-fresh
	// (it may be stale from a crashed previous session), so the first updateIndex always runs.
	private indexRebuildMutationCounter = -1

	public constructor() {
		this.ensureDirectories()
	}

	private ensureDirectories(): void {
		if (this.directoriesEnsured) {
			return
		}

		// Native FS create() can throw on disk full / IO / permission errors. Guard so a transient failure
		// does not propagate out of the module-scope `new Offline()` (which would brick module load) nor out
		// of synchronous callers. Leave directoriesEnsured=false on failure so the lazy per-operation
		// ensureDirectories() calls in storeFile/reconcileTree/updateIndex (which run inside run()) retry and
		// surface the error via their Result path.
		try {
			// The old-version sweep only ever needs to run once per process — stale v{N-1} dirs
			// cannot reappear at runtime, so it is deliberately NOT reset by invalidateCaches.
			if (!this.versionSweepDone) {
				if (OFFLINE_PARENT_DIRECTORY.exists) {
					for (const entry of OFFLINE_PARENT_DIRECTORY.list()) {
						if (entry instanceof FileSystem.Directory && entry.name !== `v${VERSION}`) {
							entry.delete()
						}
					}
				}

				this.versionSweepDone = true
			}

			// Both leaf directories existing implies the whole chain exists — the warm re-check
			// after every invalidateCaches costs 2 stats instead of stat + list + 3 stats.
			if (!FILES_DIRECTORY.exists || !DIRECTORIES_DIRECTORY.exists) {
				if (!DIRECTORY.exists) {
					DIRECTORY.create({
						intermediates: true,
						idempotent: true
					})
				}

				if (!FILES_DIRECTORY.exists) {
					FILES_DIRECTORY.create({
						intermediates: true,
						idempotent: true
					})
				}

				if (!DIRECTORIES_DIRECTORY.exists) {
					DIRECTORIES_DIRECTORY.create({
						intermediates: true,
						idempotent: true
					})
				}
			}

			this.directoriesEnsured = true
		} catch (e) {
			console.error("[Offline] ensureDirectories failed", e)
		}
	}

	/**
	 * Acquire the per-UUID store lock, serializing storeFile/storeDirectory/reconcileTree for the same
	 * item so the check-then-act (guards → local mutations → download → commit) runs atomically per
	 * UUID. Distinct UUIDs are unaffected and still bounded only by storeMutex(3).
	 * Returns a release function that frees the slot and prunes the map entry once no one else holds or
	 * waits on it, keeping the map bounded.
	 */
	private async acquireStoreItemLock(uuid: string): Promise<() => void> {
		const existing = this.storeItemMutexes.get(uuid)
		const mutex = existing ?? new Semaphore(1)

		if (!existing) {
			this.storeItemMutexes.set(uuid, mutex)
		}

		await mutex.acquire()

		let released = false

		return () => {
			if (released) {
				return
			}

			released = true

			mutex.release()

			// Prune the entry only when fully idle (no holder, no waiters) so a concurrent waiter
			// keeps using the same Semaphore instance instead of racing on a fresh one.
			if (mutex.count() === 0 && this.storeItemMutexes.get(uuid) === mutex) {
				this.storeItemMutexes.delete(uuid)
			}
		}
	}

	// Called after any mutation to offline storage. Must be aggressive because the filesystem changed.
	private invalidateCaches(): void {
		this.mutationCounter++
		this.listFilesCache = null
		this.listDirectoriesCache.clear()
		this.listDirectoriesRecursiveCache = null
		this.itemSizeCache.clear()
		this.isItemStoredCache.clear()
		this.getLocalFileCache.clear()
		this.getLocalDirectoryCache.clear()
		this.directoryMetaCache.clear()
		this.uuidToTopLevelCache = null
		this.directoriesEnsured = false
	}

	/**
	 * Read and cache a directory's .filenmeta file. Returns null if the file
	 * doesn't exist or can't be decoded.
	 */
	private async readDirectoryMeta(topLevelUuid: string): Promise<DirectoryOfflineMeta | null> {
		const cached = this.directoryMetaCache.get(topLevelUuid)

		if (cached) {
			return cached
		}

		const metaFile = new FileSystem.File(`${DIRECTORIES_DIRECTORY_URI}/${topLevelUuid}/${topLevelUuid}.filenmeta`)
		const metaInfo = metaFile.info()

		if (!metaInfo.exists || (metaInfo.size ?? 0) === 0) {
			return null
		}

		const readResult = await run(async () => {
			const meta: DirectoryOfflineMeta = deserialize(await metaFile.text())

			if (Object.keys(meta).length === 0) {
				throw new Error("Directory meta file is empty")
			}

			// Reject metas whose item is a directory type but lack an entries object.
			// This can happen when a legacy or corrupt write serialized only {item, parent}
			// (a FileOrDirectoryOfflineMeta) instead of the required DirectoryOfflineMeta.
			// Treat as corrupt so the directory is re-downloaded rather than silently
			// returning an entries-less meta that breaks listDirectories and clearAll.
			if (isDirectoryItem(meta.item) && (meta.entries === undefined || meta.entries === null)) {
				throw new Error("Directory meta is missing entries — treating as corrupt")
			}

			return meta
		})

		if (!readResult.success) {
			return null
		}

		this.directoryMetaCache.set(topLevelUuid, readResult.data)

		return readResult.data
	}

	// Reads a standalone files/{uuid}/{uuid}.filenmeta — null when missing, empty, or undecodable.
	// Callers treat null as "no usable meta"; broken-entry handling lives in listBrokenStandaloneUuids.
	private async readStandaloneMeta(uuid: string): Promise<FileOrDirectoryOfflineMeta | null> {
		const metaFile = new FileSystem.File(`${FILES_DIRECTORY_URI}/${uuid}/${uuid}.filenmeta`)
		const metaInfo = metaFile.info()

		if (!metaInfo.exists || (metaInfo.size ?? 0) === 0) {
			return null
		}

		const readResult = await run(async () => {
			const meta: FileOrDirectoryOfflineMeta = deserialize(await metaFile.text())

			if (Object.keys(meta).length === 0) {
				throw new Error("Standalone meta file is empty")
			}

			return meta
		})

		return readResult.success ? readResult.data : null
	}

	// Recorded delivered size for a stored standalone file (see FileOrDirectoryOfflineMeta.diskSize) —
	// null when the entry carries no record (no meta, or the size matched at verification time). The
	// sync heal consults this ONLY for files whose on-disk size already failed the meta-size compare,
	// so the extra meta read never lands on the healthy-file hot path.
	public async getStandaloneRecordedDiskSize(uuid: string): Promise<number | null> {
		const meta = await this.readStandaloneMeta(uuid)

		return meta?.diskSize ?? null
	}

	/**
	 * Build a map from any UUID (top-level or nested entry) to the top-level
	 * directory UUID that contains it. Used for O(1) lookups instead of
	 * scanning all top-level directories.
	 */
	private async buildUuidToTopLevelIndex(): Promise<Map<string, string>> {
		if (this.uuidToTopLevelCache) {
			return this.uuidToTopLevelCache
		}

		const index = new Map<string, string>()
		const topLevelEntries = DIRECTORIES_DIRECTORY.list()

		for (const topLevelEntry of topLevelEntries) {
			if (!(topLevelEntry instanceof FileSystem.Directory) || !validateUuid(topLevelEntry.name)) {
				continue
			}

			const meta = await this.readDirectoryMeta(topLevelEntry.name)

			if (!meta) {
				continue
			}

			// Map the top-level directory itself
			index.set(meta.item.data.uuid, topLevelEntry.name)

			// Map all nested entries
			for (const uuid in meta.entries) {
				const entry = meta.entries[uuid]

				if (entry) {
					index.set(entry.item.data.uuid, topLevelEntry.name)
				}
			}
		}

		this.uuidToTopLevelCache = index

		return index
	}

	public async updateIndex(): Promise<void> {
		await run(
			async defer => {
				await this.indexMutex.acquire()

				defer(() => {
					this.indexMutex.release()
				})

				// Previous in-memory index — the diff base for the query-cache broadcasts and the
				// fixed-point base for the index write below. It survives invalidateCaches (only
				// clearAll and readIndex assign indexCache).
				const previousIndex = this.indexCache

				// NO-MUTATION SKIP: this process is the offline store's only writer and every
				// disk-mutation path bumps mutationCounter (via invalidateCaches). An unchanged
				// counter since the last FULL in-process rebuild proves this rebuild would produce
				// the identical index — skip the meta re-reads, broadcasts and write entirely.
				// The cheap cross-session ghost healing (stale storedOffline reconciliation) still
				// runs: it needs only the in-memory index and the query-cache entries. The first
				// updateIndex of a session never skips (indexRebuildMutationCounter starts -1), so
				// staleness left by a crashed previous session heals exactly like before.
				if (previousIndex !== null && this.indexRebuildMutationCounter === this.mutationCounter) {
					this.ensureDirectories()

					for (const staleEntry of findStaleStoredOfflineEntries(getStoredOfflineQueryCacheEntries(), previousIndex)) {
						driveItemStoredOfflineQueryUpdate({
							updater: false,
							params: staleEntry
						})
					}

					await this.buildUuidToTopLevelIndex()

					return
				}

				this.ensureDirectories()
				this.invalidateCaches()

				const [files, directories] = await Promise.all([this.listFiles(), this.listDirectoriesRecursive()])
				const indexFiles: Index["files"] = {}
				const indexDirectories: Index["directories"] = {}

				// Broadcast only NEWLY indexed uuids when a previous index exists this session: an
				// already-indexed uuid's storedOffline query value is already true (this lib is the
				// query's only writer), so re-pushing tens of thousands of unchanged `true`s every
				// pass is pure overhead. A null previous index (first rebuild this session)
				// broadcasts everything, healing whatever the persisted query cache holds.
				for (const { item, parent } of files) {
					indexFiles[item.data.uuid] = {
						item,
						parent
					}

					if (!previousIndex || !previousIndex.files[item.data.uuid]) {
						driveItemStoredOfflineQueryUpdate({
							updater: true,
							params: {
								uuid: item.data.uuid,
								type: item.type
							}
						})
					}
				}

				for (const { item, parent } of directories.directories) {
					indexDirectories[item.data.uuid] = {
						item,
						parent
					}

					if (!previousIndex || !previousIndex.directories[item.data.uuid]) {
						driveItemStoredOfflineQueryUpdate({
							updater: true,
							params: {
								uuid: item.data.uuid,
								type: item.type
							}
						})
					}
				}

				for (const { item, parent } of directories.files) {
					indexFiles[item.data.uuid] = {
						item,
						parent
					}

					if (!previousIndex || !previousIndex.files[item.data.uuid]) {
						driveItemStoredOfflineQueryUpdate({
							updater: true,
							params: {
								uuid: item.data.uuid,
								type: item.type
							}
						})
					}
				}

				const index: Index = {
					files: indexFiles,
					directories: indexDirectories
				}

				// Skip the (multi-MB at scale) serialize + atomic rewrite when the rebuilt index
				// structurally equals the previous one and the file is still on disk — it already
				// holds exactly this content. serializeEquals is conservative: any doubt falls
				// back to the write.
				const indexUnchanged = previousIndex !== null && INDEX_FILE.info().exists && serializeEquals(index, previousIndex)

				if (!indexUnchanged) {
					atomicWrite(INDEX_FILE, serialize(index satisfies Index))
				}

				this.indexCache = index

				// Reconcile the push-only storedOffline query cache against the rebuilt index:
				// broadcast `false` for every cached `true` whose uuid is no longer indexed.
				// The per-item loops above only ever broadcast `true`, so without this an item
				// that vanished from the store wholesale (e.g. an OFFLINE_VERSION sweep) keeps
				// its persisted `true` forever — a ghost "stored offline" badge for an item the
				// offline screen doesn't list and whose menu offers neither offline action.
				for (const staleEntry of findStaleStoredOfflineEntries(getStoredOfflineQueryCacheEntries(), index)) {
					driveItemStoredOfflineQueryUpdate({
						updater: false,
						params: staleEntry
					})
				}

				// Eagerly warm uuidToTopLevelCache so the sync isItemTopLevelStoredSync
				// used by drive item menus returns a defined answer immediately after
				// boot, not after the per-row isStoredOffline query lazily triggers it.
				// We just walked every top-level directory above; this re-reads their
				// meta but is the price for a clean cache invariant: "indexCache set
				// ⇒ uuidToTopLevelCache set".
				await this.buildUuidToTopLevelIndex()

				// Mark this rebuild as current — updateIndex calls with no interleaving mutation
				// take the no-mutation skip above.
				this.indexRebuildMutationCounter = this.mutationCounter
			},
			{
				throw: true
			}
		)
	}

	private async readIndex(): Promise<Index> {
		if (this.indexCache) {
			return this.indexCache
		}

		const result = await run(async defer => {
			await this.indexMutex.acquire()

			defer(() => {
				this.indexMutex.release()
			})

			if (this.indexCache) {
				return this.indexCache
			}

			this.ensureDirectories()

			const indexInfo = INDEX_FILE.info()

			if (!indexInfo.exists || (indexInfo.size ?? 0) === 0) {
				return {
					files: {},
					directories: {}
				} satisfies Index
			}

			const readResult = await run(async () => {
				const index: Index = deserialize(await INDEX_FILE.text())

				if (Object.keys(index).length === 0) {
					throw new Error("Index file is empty")
				}

				return index
			})

			if (readResult.success) {
				this.indexCache = readResult.data

				return readResult.data
			}

			if (INDEX_FILE.exists) {
				INDEX_FILE.delete()
			}

			return {
				files: {},
				directories: {}
			} satisfies Index
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	}

	// Cache-only sync variant of isItemStored. Returns the cached value if known,
	// or undefined if not yet populated. For render-time menu gating where an
	// async lookup is too expensive. Callers that prefer to err on "show the
	// action" should treat undefined as "not known offline".
	public isItemStoredSync(item: DriveItem): boolean | undefined {
		return this.isItemStoredCache.get(item.data.uuid)
	}

	// Synchronously checks whether an item is a TOP-LEVEL stored offline entry.
	// removeItem() only operates on top-level entries — nested files and dirs
	// inside a stored tree get removed when their top-level parent is removed,
	// not individually. updateIndex() flattens all nested items into
	// `index.files` / `index.directories`, so a plain isItemStored check would
	// return true for nested children too. This method consults the
	// uuid → top-level mapping to distinguish.
	//
	// Returns:
	//   true  — item itself is a top-level stored entry (safe to expose remove).
	//   false — item is either not stored, or is a nested child of a stored
	//           tree. Either way, removeItem is not the right action.
	//   undefined — caches not yet populated; caller should re-render after
	//               the per-item isItemStored query warms them.
	public isItemTopLevelStoredSync(item: DriveItem): boolean | undefined {
		if (!this.indexCache || !this.uuidToTopLevelCache) {
			return undefined
		}

		const uuid = item.data.uuid

		if (isFileItem(item)) {
			if (!this.indexCache.files[uuid]) {
				return false
			}

			// Standalone stored files aren't in the uuid→top-level map (it's built
			// from stored DIRECTORIES). Nested files are present and mapped to
			// their parent directory's uuid. So "not present" === top-level.
			return this.uuidToTopLevelCache.get(uuid) === undefined
		}

		if (!this.indexCache.directories[uuid]) {
			return false
		}

		// A top-level stored directory maps to itself in the uuid→top-level index.
		// A nested directory maps to its parent. Absent (cache built without this
		// directory) is also treated as top-level — guarded by indexCache check
		// above.
		const mapping = this.uuidToTopLevelCache.get(uuid)

		return mapping === undefined || mapping === uuid
	}

	public async isItemStored(item: DriveItem): Promise<boolean> {
		const cachedStored = this.isItemStoredCache.get(item.data.uuid)

		if (cachedStored !== undefined) {
			return cachedStored
		}

		this.ensureDirectories()

		const index = await this.readIndex()

		// Warm uuidToTopLevelCache too — the sync isItemTopLevelStoredSync check
		// used by drive item menus depends on BOTH this cache AND indexCache.
		// Idempotent: short-circuits once populated.
		await this.buildUuidToTopLevelIndex()

		switch (item.type) {
			case "directory":
			case "sharedRootDirectory":
			case "sharedDirectory": {
				const storedDir = Boolean(index.directories[item.data.uuid])

				this.isItemStoredCache.set(item.data.uuid, storedDir)

				return storedDir
			}

			case "file":
			case "sharedFile":
			case "sharedRootFile": {
				const storedFile = Boolean(index.files[item.data.uuid])

				this.isItemStoredCache.set(item.data.uuid, storedFile)

				return storedFile
			}
		}
	}

	// Keyed on the META, not the data file: one entry per uuid-named files/ dir with a readable,
	// non-empty file meta — REGARDLESS of whether the data file still exists. A standalone whose
	// bytes were deleted while its meta survived is still conceptually stored offline; listing it
	// routes it through the normal sync decision flow (the heal re-downloads missing bytes, gone
	// remotes get removed). Dirs with missing/empty/undecodable metas are listBrokenStandaloneUuids
	// territory.
	public async listFiles(): Promise<
		{
			item: DriveItem
			parent: OfflineParent
		}[]
	> {
		if (this.listFilesCache) {
			return this.listFilesCache
		}

		this.ensureDirectories()

		const entries = FILES_DIRECTORY.list()
		const files: Awaited<ReturnType<typeof this.listFiles>> = []

		await Promise.all(
			entries.map(async entry => {
				if (!(entry instanceof FileSystem.Directory) || !validateUuid(entry.name)) {
					return
				}

				const metaFile = new FileSystem.File(`${entry.uri}/${entry.name}.filenmeta`)
				const metaInfo = metaFile.info()

				if (!metaInfo.exists || (metaInfo.size ?? 0) === 0) {
					return
				}

				const readResult = await run(async () => {
					const meta: FileOrDirectoryOfflineMeta = deserialize(await metaFile.text())

					if (Object.keys(meta).length === 0) {
						throw new Error("File meta is empty")
					}

					return meta
				})

				if (!readResult.success) {
					return
				}

				const meta = readResult.data

				if (!isFileItem(meta.item)) {
					return
				}

				files.push({
					item: meta.item,
					parent: meta.parent
				})
			})
		)

		this.listFilesCache = files

		return files
	}

	// Scans FILES_DIRECTORY for standalone uuid-named directories whose meta file is missing, empty,
	// or undecodable while the directory itself still exists. Used by the sync top-level pass to
	// rebuild (own cloud) or remove (undecidable) broken standalone entries. hasDataFile reports
	// whether any non-.filenmeta file is present and dataFileSize its on-disk byte size (null when
	// absent) — together they decide rebuild (cheap meta rewrite, only around bytes at the EXPECTED
	// size) vs redownload (no bytes, or wrong-size residue that must never be blessed) in the heal.
	public async listBrokenStandaloneUuids(): Promise<{ uuid: string; hasDataFile: boolean; dataFileSize: number | null }[]> {
		this.ensureDirectories()

		const broken: { uuid: string; hasDataFile: boolean; dataFileSize: number | null }[] = []

		for (const entry of FILES_DIRECTORY.list()) {
			if (!(entry instanceof FileSystem.Directory) || !validateUuid(entry.name)) {
				continue
			}

			const metaFile = new FileSystem.File(`${entry.uri}/${entry.name}.filenmeta`)
			const metaInfo = metaFile.info()
			let brokenMeta = !metaInfo.exists || (metaInfo.size ?? 0) === 0

			if (!brokenMeta) {
				const readResult = await run(async () => {
					const meta: FileOrDirectoryOfflineMeta = deserialize(await metaFile.text())

					if (Object.keys(meta).length === 0) {
						throw new Error("File meta is empty")
					}

					return meta
				})

				brokenMeta = !readResult.success
			}

			if (!brokenMeta) {
				continue
			}

			let dataFileSize: number | null = null

			for (const inner of entry.list()) {
				if (inner instanceof FileSystem.File && !inner.name.endsWith(".filenmeta")) {
					dataFileSize = inner.size

					break
				}
			}

			broken.push({
				uuid: entry.name,
				hasDataFile: dataFileSize !== null,
				dataFileSize
			})
		}

		return broken
	}

	// Scans DIRECTORIES_DIRECTORY for uuid-named tree dirs whose meta file is missing, empty, or
	// undecodable while the tree dir itself still exists (readDirectoryMeta is the canonical
	// brokenness test — it is what every tree reader uses, incl. its entries-less rejection).
	// Used by the sync top-level pass to rebuild (own cloud, alive) or remove (trashed/deleted)
	// broken trees that nothing else lists: listDirectories skips meta-less dirs, so without this
	// scan an aborted/crashed partial tree would stay invisible on disk forever. No hasDataFile
	// distinction — reconcileTree's hash-idempotent download skips healthy bytes either way.
	public async listBrokenTreeUuids(): Promise<string[]> {
		this.ensureDirectories()

		const broken: string[] = []

		for (const entry of DIRECTORIES_DIRECTORY.list()) {
			if (!(entry instanceof FileSystem.Directory) || !validateUuid(entry.name)) {
				continue
			}

			if ((await this.readDirectoryMeta(entry.name)) === null) {
				broken.push(entry.name)
			}
		}

		return broken
	}

	// Rewrites a stored tree root's meta {item, parent} while preserving its entries. Used by the
	// sync top-level pass for remote renames (meta item refresh) and moves (parent re-anchor) — the
	// on-disk tree itself is uuid-named and therefore name/location independent.
	public async updateTreeRootMeta({ uuid, item, parent }: { uuid: string; item: DriveItem; parent: OfflineParent }): Promise<void> {
		await run(
			async defer => {
				await this.clearBarrier.enter()

				defer(() => {
					this.clearBarrier.leave()
				})

				const releaseStoreItemLock = await this.acquireStoreItemLock(uuid)

				defer(() => {
					releaseStoreItemLock()
				})

				this.ensureDirectories()

				const existingMeta = await this.readDirectoryMeta(uuid)

				if (!existingMeta) {
					return
				}

				const metaFile = new FileSystem.File(FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, uuid, `${uuid}.filenmeta`))

				atomicWrite(
					metaFile,
					serialize({
						item,
						parent,
						entries: existingMeta.entries
					} satisfies DirectoryOfflineMeta)
				)

				this.invalidateCaches()
			},
			{
				throw: true
			}
		)
	}

	// Deletes a standalone files/{uuid} directory directly by uuid. Used by the sync top-level pass
	// for BROKEN standalone entries (meta missing/undecodable) whose remote uuid turned out trashed
	// or permanently deleted — such dirs cannot be addressed as a DriveItem through removeItem.
	// NO index update — broken dirs were never indexed; callers batch one at the end of their pass.
	public async removeStandaloneDirectory(uuid: string): Promise<void> {
		await run(
			async defer => {
				await this.clearBarrier.enter()

				defer(() => {
					this.clearBarrier.leave()
				})

				const releaseStoreItemLock = await this.acquireStoreItemLock(uuid)

				defer(() => {
					releaseStoreItemLock()
				})

				this.ensureDirectories()

				const standaloneDir = new FileSystem.Directory(FileSystem.Paths.join(FILES_DIRECTORY.uri, uuid))

				if (standaloneDir.exists) {
					standaloneDir.delete()
				}

				this.invalidateCaches()
			},
			{
				throw: true
			}
		)
	}

	// Deletes a stored tree's directories/{uuid} directly by uuid. Used by the sync top-level pass
	// for BROKEN trees (meta missing/undecodable) whose remote uuid turned out trashed or
	// permanently deleted — such dirs cannot be addressed as a DriveItem through removeItem.
	// NO index update — broken trees were never indexed; callers batch one at the end of their pass.
	public async removeTreeDirectory(uuid: string): Promise<void> {
		await run(
			async defer => {
				await this.clearBarrier.enter()

				defer(() => {
					this.clearBarrier.leave()
				})

				const releaseStoreItemLock = await this.acquireStoreItemLock(uuid)

				defer(() => {
					releaseStoreItemLock()
				})

				this.ensureDirectories()

				const treeDir = new FileSystem.Directory(FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, uuid))

				if (treeDir.exists) {
					treeDir.delete()
				}

				this.invalidateCaches()
			},
			{
				throw: true
			}
		)
	}

	// Renames a standalone stored file's data file in place (remote rename, same uuid ⟹ same bytes)
	// and rewrites its meta {item, parent}. The current data file is located as the single
	// non-.filenmeta file in files/{uuid}/ so a stale on-disk name from an older meta still gets
	// corrected. The meta rewrite does NOT require a data file: a bytes-missing standalone that was
	// moved/renamed remotely must still converge (meta parent/item updated; the heal redownloads
	// the bytes later) — requiring bytes here made the re-anchor no-op forever.
	public async renameStandaloneFile({ item, parent }: { item: DriveItem; parent: OfflineParent }): Promise<void> {
		await run(
			async defer => {
				if (!isFileItem(item)) {
					throw new Error("Item not of type file")
				}

				if (!item.data.decryptedMeta) {
					throw new Error("File missing decrypted meta")
				}

				const newName = item.data.decryptedMeta.name

				await this.clearBarrier.enter()

				defer(() => {
					this.clearBarrier.leave()
				})

				const releaseStoreItemLock = await this.acquireStoreItemLock(item.data.uuid)

				defer(() => {
					releaseStoreItemLock()
				})

				this.ensureDirectories()

				const standaloneDir = new FileSystem.Directory(FileSystem.Paths.join(FILES_DIRECTORY.uri, item.data.uuid))

				if (!standaloneDir.exists) {
					return
				}

				let dataFile: FileSystem.File | null = null

				for (const entry of standaloneDir.list()) {
					if (entry instanceof FileSystem.File && !entry.name.endsWith(".filenmeta")) {
						dataFile = entry

						break
					}
				}

				// The data-file rename is best-effort on whatever bytes exist; the meta rewrite
				// below is the actual convergence contract and runs either way. NFC compare — iOS
				// lists names in NFD, and a raw compare would re-"rename" an umlaut-named file on
				// every pass.
				if (dataFile && normalizeNfcFast(dataFile.name) !== normalizeNfcFast(newName)) {
					dataFile.rename(newName)
				}

				const metaFile = new FileSystem.File(FileSystem.Paths.join(standaloneDir.uri, `${item.data.uuid}.filenmeta`))

				// A rename never changes bytes (same uuid ⟹ same content) — carry the delivered-size
				// record so a meta-size-drifted file doesn't lose its blessing on rename.
				const priorDiskSize = (await this.readStandaloneMeta(item.data.uuid))?.diskSize

				atomicWrite(
					metaFile,
					serialize({
						item,
						parent,
						...(priorDiskSize !== undefined
							? {
									diskSize: priorDiskSize
								}
							: {})
					} satisfies FileOrDirectoryOfflineMeta)
				)

				this.invalidateCaches()
			},
			{
				throw: true
			}
		)
	}

	// Converges one stored directory tree onto its remote listing IN PLACE. Also the initial-store
	// path (storeDirectory delegates here with initialStore: true).
	//
	//   1. Read the existing meta, then crash recovery with RESCUE: a leftover /.sync-tmp-{uuid}
	//      move temp whose uuid the current meta still claims and whose meta path is free on disk is
	//      moved back into place (bytes preserved — no re-download); occupied or unknown temps are
	//      deleted. ANY temp found is proof of a crashed mutation pass and escalates this pass to
	//      the disk-verified local view regardless of `thorough`.
	//   2. One bulk recursive remote listing → uuid → {item, raw path} map (Linked dirs excluded).
	//   3. Local view from the existing meta, two modes (design §4.2):
	//      - INDEX-ONLY (default — automatic passes): every meta entry is trusted as present on
	//        disk; zero per-entry stats. External deletion/corruption is detected only on thorough
	//        passes or at file-access time (accepted trade).
	//      - DISK-VERIFIED (thorough: true — user-explicit passes — or crash escalation): every
	//        entry stat-checked (file size mismatch counts as missing — truncation self-heal).
	//   4. Pure plan (offlineSyncPlanner): two-phase moves via tree-root temps + deletes (deletes are
	//      skipped while the listing is degraded by scan errors) — then execute.
	//   5. One in-place hash-idempotent directory download for missing uuids; per-entry download
	//      errors fail the pass.
	//   6. Verify-after-download — stat every remote entry on disk. Runs after EVERY download
	//      regardless of pass mode (it is what makes a committed meta trustworthy at write time) and
	//      on disk-verified passes even without one; an index-only pass that downloaded nothing
	//      changed no bytes and skips the stats. Then commit meta + index ONLY when every collected
	//      error is a DEGRADED-listing marker (see below) — verify and download errors always
	//      block. A rebuilt meta identical to the existing file skips the meta write/index update;
	//      a TRUE no-op pass (no download, readable meta) performs zero writes and no sweep.
	//   7. After a verified pass that downloaded or started with an unreadable meta — including a
	//      pure self-heal pass whose rebuilt meta is byte-identical — orphan sweep deletes physical
	//      paths the meta does not claim (incl. crashed .filendl partials).
	//
	// Degraded listings (scan errors, or listed files whose metas are unreadable): affected entries
	// are silently absent from the listing, so the delete phase is skipped AND the commit writes
	// the VERIFIED UNION — remote entries plus the still-on-disk existing-meta entries the skipped
	// delete phase preserved. Without the union, a PERMANENT scan error (e.g. a legacy
	// undecryptable nested meta) would block the commit forever: new files would re-download and
	// re-hash every pass yet never enter the meta (an eternal-resync relative). Degraded markers
	// carry `degraded: true` and bubble to the caller on every pass, commit or not.
	//
	// Failure policy: no deletions on errors, meta/index never advance on a failed pass. The one
	// exception is an initial store with NO readable prior meta — its partial tree is deleted and
	// the first NON-degraded error is thrown (UI alerts); a degraded-only initial store commits and
	// succeeds. An initial store over a readable committed meta (e.g. a concurrent store that lost
	// the per-uuid lock race) keeps state and returns the errors like a sync pass; storeDirectory
	// surfaces non-degraded ones by throwing without deleting. Aborts are silent (no throw, no
	// error entries beyond already-collected degraded markers) and keep committed state — except an
	// aborted initial store with no readable prior meta, whose meta-less partial tree is deleted so
	// it is not stranded as a broken tree the next sync pass would pointlessly resurrect.
	public async reconcileTree({
		directory,
		parent,
		hideProgress,
		skipIndexUpdate,
		initialStore,
		thorough,
		signal
	}: {
		directory: DriveItem
		parent: OfflineParent
		hideProgress?: boolean
		skipIndexUpdate?: boolean
		initialStore?: boolean
		thorough?: boolean
		signal?: AbortSignal
	}): Promise<OfflineSyncError[]> {
		const result = await run(async defer => {
			if (!isDirectoryItem(directory)) {
				throw new Error("Item not of type directory")
			}

			if (!directory.data.decryptedMeta) {
				throw new Error("Directory missing decrypted meta")
			}

			const topLevelUuid = directory.data.uuid
			const directoryName = directory.data.decryptedMeta.name

			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			const releaseStoreItemLock = await this.acquireStoreItemLock(topLevelUuid)

			defer(() => {
				releaseStoreItemLock()
			})

			await this.storeMutex.acquire()

			defer(() => {
				this.storeMutex.release()
			})

			this.ensureDirectories()

			const errors: OfflineSyncError[] = []
			const errorIds = new Set<string>()

			const pushError = (error: OfflineSyncError): void => {
				if (!errorIds.has(error.id)) {
					errorIds.add(error.id)
					errors.push(error)
				}
			}

			const liveDir = new FileSystem.Directory(FileSystem.Paths.join(DIRECTORIES_DIRECTORY_URI, topLevelUuid))
			// CRITICAL encoding contract: every disk access that carries a RAW entry path MUST pass
			// that path as a SEPARATE Paths.join / File / Directory constructor argument. expo's
			// (patched — see patches/expo-file-system+56.0.7.patch) encodePathChars runs ONLY on
			// rest arguments; pre-joining a raw name into one string bypasses it, so names with
			// `[ ] ^ |` reach the native layer raw and every stat misses ("Missing on disk after
			// sync" — regression 2026-06-11, guarded by offlineUriEncoding.test.ts). Direct
			// concatenation with liveDirUri is only allowed for provably URI-safe segments
			// (uuids + fixed ASCII suffixes), where encoding is the identity.
			const liveDirUri = liveDir.uri

			if (!liveDir.exists) {
				liveDir.create({
					intermediates: true,
					idempotent: true
				})
			}

			// Prior state, captured at pass entry — BEFORE tmp crash recovery, whose rescue needs the
			// meta's claimed paths. The existing meta is both the local-view source and the
			// failure-policy discriminator: a readable meta means a committed tree exists on disk.
			// An unreadable meta yields an empty local view — the hash-idempotent download skips
			// healthy bytes and the meta is rebuilt from the listing (near-free repair).
			const existingMeta = await this.readDirectoryMeta(topLevelUuid)
			const metaWasUnreadable = existingMeta === null && !initialStore
			const metaFile = new FileSystem.File(`${liveDirUri}/${topLevelUuid}.filenmeta`)
			const existingEntries = existingMeta?.entries ?? {}

			// Crash recovery with RESCUE: a previous pass that died mid-move can leave /.sync-tmp-{uuid}
			// extraction temps at the tree root. A temp whose uuid the CURRENT meta still claims and
			// whose meta path is free on disk is moved back into place (bytes preserved — no
			// re-download); occupied or unknown temps are deleted (the hash-idempotent download
			// restores their bytes). ANY temp is proof of a crashed mutation pass, so the meta cannot
			// be trusted — escalate this pass to the disk-verified local view below.
			let crashEscalation = false

			for (const entry of liveDir.list()) {
				if (!isSyncTmpName(entry.name)) {
					continue
				}

				crashEscalation = true

				const tmpUuid = uuidFromSyncTmpName(entry.name)
				const claimedEntry = tmpUuid !== null ? existingEntries[tmpUuid] : undefined

				if (claimedEntry) {
					const destinationUri = FileSystem.Paths.join(liveDirUri, claimedEntry.path)

					if (!new FileSystem.File(destinationUri).exists && !new FileSystem.Directory(destinationUri).exists) {
						const destinationParent = new FileSystem.Directory(FileSystem.Paths.dirname(destinationUri))

						if (!destinationParent.exists) {
							destinationParent.create({
								intermediates: true,
								idempotent: true
							})
						}

						if (entry instanceof FileSystem.Directory) {
							entry.move(new FileSystem.Directory(destinationUri))
						} else {
							entry.move(new FileSystem.File(destinationUri))
						}

						continue
					}
				}

				entry.delete()
			}

			if (crashEscalation) {
				// The physical tree changed (rescued moves) or at minimum held crash residue — drop
				// derived caches.
				this.invalidateCaches()
			}

			// Local-view mode for this pass (design §4.2): disk-verified on user-explicit thorough
			// passes and on crash escalation, index-only (meta-trusting) otherwise. Declared here
			// because the pre-materialization fixed-point check below keys off it.
			const thoroughLocalView = thorough === true || crashEscalation

			// Initial-store failure policy: a user-initiated FIRST store (no readable prior meta) has
			// no prior state worth keeping, so a FATALLY failed pass (any non-degraded error) deletes
			// the partial tree and throws (UI alerts as today). Degraded-only error sets do not count
			// as failure — they commit below and the store succeeds. When a readable meta exists, this
			// pass runs over a COMMITTED tree — e.g. a concurrent initial store that passed the
			// read-only guards, then lost the per-uuid lock race against a pass that already committed
			// — and deleting would destroy it. Such failures keep state and return the collected
			// errors like a sync pass instead.
			const finish = (collected: OfflineSyncError[]): OfflineSyncError[] => {
				const fatal = collected.filter(error => error.degraded !== true)

				if (initialStore && fatal.length > 0 && existingMeta === null) {
					if (liveDir.exists) {
						liveDir.delete()
					}

					this.invalidateCaches()

					throw new Error(fatal[0]?.message ?? "Storing directory offline failed")
				}

				return collected
			}

			// Abort policy: silent — no throw, never an error entry, committed state untouched. The
			// one cleanup: an aborted INITIAL store with no readable prior meta deletes its partial
			// tree, otherwise the invisible meta-less directories/{uuid}/ would linger as a broken
			// tree that the next sync pass needlessly re-downloads (and effectively resurrects a
			// store the user chose to abort).
			const finishAborted = (): OfflineSyncError[] => {
				if (initialStore && existingMeta === null) {
					if (liveDir.exists) {
						liveDir.delete()
					}

					this.invalidateCaches()
				}

				return errors
			}

			// Remote listing — one bulk recursive metadata fetch. Listing paths are RAW root-relative
			// original decrypted names; we only prefix "/" and never decode/encode them.
			const { authedSdkClient } = await auth.getSdkClients()
			const remoteDir = directoryDriveItemToAnyDirWithContext(directory)

			if (!remoteDir || typeof remoteDir === "string") {
				throw new Error("Cannot resolve directory context for the remote listing")
			}

			const scanErrors: unknown[] = []

			const listingResult = await run(async () =>
				authedSdkClient.listDirRecursiveWithPaths(
					remoteDir,
					{
						onProgress() {
							// Noop
						}
					},
					{
						onErrors(errs) {
							scanErrors.push(...errs)
						}
					},
					signal
						? {
								signal
							}
						: undefined
				)
			)

			if (!listingResult.success) {
				if (signal?.aborted) {
					// The threaded signal aborted the listing itself — same silent-abort policy as
					// the ops/download abort paths below, not a listing failure.
					return finishAborted()
				}

				pushError(
					makeSyncError({
						itemUuid: topLevelUuid,
						topLevelUuid,
						name: directoryName,
						itemType: directory.type,
						kind: "listing",
						message: listingResult.error instanceof Error ? listingResult.error.message : String(listingResult.error)
					})
				)

				return finish(errors)
			}

			// FAST FIXED POINT — the dominant pass in practice (nothing changed remotely): an
			// index-only, non-degraded pass over a committed tree whose listing matches the
			// existing meta exactly needs NO remote map, NO local view, NO plan, NO serialize and
			// NO meta-text read. One walk over the raw listing against the existing entries
			// decides it; ANY doubt (mismatch, unreadable meta, scan error, thorough/crash pass)
			// falls through to the full reconcile below. serializeEquals is conservative — false
			// positives are impossible.
			if (!initialStore && !metaWasUnreadable && !thoroughLocalView && scanErrors.length === 0) {
				let matched = 0
				let mismatch = false

				for (const { dir, path } of listingResult.data.dirs) {
					if (dir.tag === NonRootDir_Tags.Linked) {
						// Excluded from the remote view — committed metas never contain Linked
						// entries either.
						continue
					}

					const unwrapped = unwrapDirMeta(dir.inner[0])
					const existing = existingEntries[unwrapped.uuid]

					// Path compare without the `/${path}` allocation: existing paths carry the
					// leading "/" the listing paths lack.
					if (
						!existing ||
						existing.path.length !== path.length + 1 ||
						existing.path.charCodeAt(0) !== 47 ||
						!existing.path.endsWith(path) ||
						!serializeEquals(existing.item, unwrappedDirIntoDriveItem(unwrapped))
					) {
						mismatch = true

						break
					}

					matched++
				}

				if (!mismatch) {
					for (const { file, path } of listingResult.data.files) {
						const unwrapped = unwrapFileMeta(file)

						if (!unwrapped.meta) {
							// Unreadable listed meta degrades the pass — slow path territory.
							mismatch = true

							break
						}

						const existing = existingEntries[unwrapped.file.uuid]

						if (
							!existing ||
							existing.path.length !== path.length + 1 ||
							existing.path.charCodeAt(0) !== 47 ||
							!existing.path.endsWith(path) ||
							!serializeEquals(existing.item, unwrappedFileIntoDriveItem(unwrapped))
						) {
							mismatch = true

							break
						}

						matched++
					}
				}

				if (!mismatch && matched === Object.keys(existingEntries).length) {
					// True no-op: zero writes, no sweep — same exit as the serialized fixed point.
					return errors
				}
			}

			const remote = new Map<
				string,
				RemoteTreeEntry & {
					item: DriveItem
				}
			>()

			for (const { dir, path } of listingResult.data.dirs) {
				if (dir.tag === NonRootDir_Tags.Linked) {
					continue
				}

				const unwrapped = unwrapDirMeta(dir.inner[0])

				remote.set(unwrapped.uuid, {
					uuid: unwrapped.uuid,
					item: unwrappedDirIntoDriveItem(unwrapped),
					path: `/${path}`,
					isDirectory: true
				})
			}

			// Listed files whose metas cannot be read are dropped from the remote map (no readable
			// name/size to verify against) — but their LOCAL copies must not be deleted because of
			// it, so any drop degrades the pass exactly like a scan error.
			let unreadableListedFiles = 0

			for (const { file, path } of listingResult.data.files) {
				const unwrapped = unwrapFileMeta(file)

				if (!unwrapped.meta) {
					unreadableListedFiles++

					continue
				}

				remote.set(unwrapped.file.uuid, {
					uuid: unwrapped.file.uuid,
					item: unwrappedFileIntoDriveItem(unwrapped),
					path: `/${path}`,
					isDirectory: false
				})
			}

			// Local view from the existing meta (read at pass entry above), two modes (design §4.2):
			//   - INDEX-ONLY (default — automatic passes): every meta entry is TRUSTED as present on
			//     disk. Zero per-entry File/Directory constructions in this phase — the dominant
			//     local cost for big trees. Externally deleted/corrupted bytes are detected only on
			//     thorough passes or at file-access time (accepted trade).
			//   - DISK-VERIFIED (thorough passes — user-explicit triggers — or crash escalation):
			//     every entry is stat-checked; a file whose on-disk size diverges from its meta size
			//     counts as missing so the download heals truncation for free.
			const local: LocalTreeEntry[] = []

			for (const uuid in existingEntries) {
				const entry = existingEntries[uuid]

				if (!entry) {
					continue
				}

				if (!thoroughLocalView) {
					local.push({
						uuid,
						path: entry.path,
						isDirectory: isDirectoryItem(entry.item),
						existsOnDisk: true
					})

					continue
				}

				if (isDirectoryItem(entry.item)) {
					local.push({
						uuid,
						path: entry.path,
						isDirectory: true,
						existsOnDisk: new FileSystem.Directory(liveDirUri, entry.path).exists
					})
				} else {
					// One info() call per file — exists + size in a single native hop instead of two.
					const dataFileInfo = new FileSystem.File(liveDirUri, entry.path).info()
					// Compare against the recorded delivered size when the entry carries one — for
					// meta-size-drifted remotes the meta size can NEVER match disk, and comparing
					// against it would re-mark the entry missing (and re-download it) every
					// thorough pass forever.
					const expectedSize = entry.diskSize ?? Number(entry.item.data.decryptedMeta?.size ?? -1)

					local.push({
						uuid,
						path: entry.path,
						isDirectory: false,
						existsOnDisk: dataFileInfo.exists && (dataFileInfo.size ?? 0) === expectedSize
					})
				}
			}

			// Scan errors and unreadable listed file metas mean entries can be silently absent from
			// the listing — deleting on that basis would destroy good local copies, so the plan skips
			// deletions for this pass (moves and downloads still apply; deletions resume once the
			// listing is clean). The pass is marked DEGRADED: the commit below still advances using
			// the verified union so a permanent scan error can never block the meta forever.
			const listingDegraded = scanErrors.length > 0 || unreadableListedFiles > 0
			const plan = planTreeReconcile({
				remote,
				local,
				allowDeletes: !listingDegraded
			})

			// Expected ON-DISK path for a remote entry this pass. With deferred moves (degraded
			// destination collisions — plan.deferredMoves) an entry's disk location is the
			// planner's finalPath for it: deferred movers and the subtrees riding inside them
			// stayed put, so their REMOTE paths would lie about the disk in both the verify stats
			// and the committed meta. Entries the plan classified MISSING are exempt — the
			// download places them at their remote paths regardless of any stale meta path.
			// Without deferrals every surviving entry's final path lands exactly on its remote
			// path, so the remote path is used directly.
			const missingSet = new Set(plan.missingUuids)
			const expectedDiskPath = (uuid: string, remotePath: string): string => {
				if (plan.deferredMoves.length === 0 || missingSet.has(uuid)) {
					return remotePath
				}

				return existingEntries[uuid] ? (plan.finalPaths.get(uuid) ?? remotePath) : remotePath
			}

			if (listingDegraded) {
				const reasons: string[] = []

				if (scanErrors.length > 0) {
					reasons.push(`${scanErrors.length} scan error(s)`)
				}

				if (unreadableListedFiles > 0) {
					reasons.push(`${unreadableListedFiles} listed file(s) with unreadable metadata`)
				}

				pushError(
					makeSyncError({
						itemUuid: topLevelUuid,
						topLevelUuid,
						name: directoryName,
						itemType: directory.type,
						kind: "listing",
						degraded: true,
						message: `Remote listing degraded (${reasons.join(", ")}) — skipped deletions for this pass`
					})
				)
			}

			// Execute the planned local mutations. All remote-truth-following and idempotent — safe
			// even when the pass later fails, since the next pass re-converges from disk state.
			const opsResult = await run(async () => {
				for (const op of plan.ops) {
					if (signal?.aborted) {
						return false
					}

					if (op.type === "move") {
						const destinationUri = FileSystem.Paths.join(liveDirUri, op.to)
						const destinationParent = new FileSystem.Directory(FileSystem.Paths.dirname(destinationUri))

						if (!destinationParent.exists) {
							destinationParent.create({
								intermediates: true,
								idempotent: true
							})
						}

						if (op.isDirectory) {
							const from = new FileSystem.Directory(liveDirUri, op.from)

							if (from.exists) {
								from.move(new FileSystem.Directory(destinationUri))
							}
						} else {
							const from = new FileSystem.File(liveDirUri, op.from)

							if (from.exists) {
								from.move(new FileSystem.File(destinationUri))
							}
						}

						continue
					}

					if (op.isDirectory) {
						const target = new FileSystem.Directory(liveDirUri, op.path)

						if (target.exists) {
							target.delete()
						}
					} else {
						const target = new FileSystem.File(liveDirUri, op.path)

						if (target.exists) {
							target.delete()
						}
					}
				}

				return true
			})

			if (plan.ops.length > 0) {
				// The physical tree (possibly) changed underneath the existing meta — drop derived caches.
				this.invalidateCaches()
			}

			if (!opsResult.success) {
				pushError(
					makeSyncError({
						itemUuid: topLevelUuid,
						topLevelUuid,
						name: directoryName,
						itemType: directory.type,
						kind: "store",
						message: opsResult.error instanceof Error ? opsResult.error.message : String(opsResult.error)
					})
				)

				return finish(errors)
			}

			if (!opsResult.data) {
				// Aborted mid-ops — leftover temps are cleaned up on the next pass's entry.
				return finishAborted()
			}

			// Download missing/changed entries — at most ONE in-place directory download per pass.
			// The Rust downloader is idempotent per file (size+hash skip), so renames-before-download
			// maximize skips and only missing/changed bytes transfer.
			let downloadRan = false

			if (plan.missingUuids.length > 0) {
				if (signal?.aborted) {
					return finishAborted()
				}

				downloadRan = true

				let resolveCompletion: (() => void) | undefined

				defer(() => {
					resolveCompletion?.()
				})

				const completionPromise = new Promise<void>(resolve => {
					resolveCompletion = resolve
				})

				const downloadResult = await run(async () =>
					transfers.download({
						item: directory,
						destination: liveDir,
						hideProgress,
						awaitExternalCompletionBeforeMarkingAsFinished: () => completionPromise,
						preserveDestinationOnStart: true,
						signal
					})
				)

				if (!downloadResult.success) {
					pushError(
						makeSyncError({
							itemUuid: topLevelUuid,
							topLevelUuid,
							name: directoryName,
							itemType: directory.type,
							kind: "download",
							message: downloadResult.error instanceof Error ? downloadResult.error.message : String(downloadResult.error)
						})
					)

					return finish(errors)
				}

				const transferred = downloadResult.data

				if (!transferred) {
					// Aborted — nothing committed; the next pass picks this tree up again.
					return finishAborted()
				}

				// SDK-side tree-scan errors: the downloader's own remote scan failed somewhere, so
				// part of the tree was silently absent from its download set while the call still
				// resolved Ok. The dropped entries surface as fatal verify-missing errors below —
				// this degraded marker only records WHY, so the user sees the cause instead of a
				// bare "missing on disk".
				if ("scanErrors" in transferred && transferred.scanErrors.length > 0) {
					pushError(
						makeSyncError({
							itemUuid: topLevelUuid,
							topLevelUuid,
							name: directoryName,
							itemType: directory.type,
							kind: "listing",
							degraded: true,
							message: `Download tree scan reported ${transferred.scanErrors.length} error(s) — entries it dropped are reported missing below`
						})
					)
				}

				if ("errors" in transferred && transferred.errors.length > 0) {
					for (const downloadError of transferred.errors) {
						// Resolve the failed entry by matching the error's absolute local path against the
						// raw remote listing paths (longest suffix wins); fall back to the tree root.
						let matched: (RemoteTreeEntry & { item: DriveItem }) | null = null

						for (const remoteEntry of remote.values()) {
							if (
								downloadError.path.endsWith(remoteEntry.path) &&
								remoteEntry.path.length > (matched?.path.length ?? -1)
							) {
								matched = remoteEntry
							}
						}

						const errorMessage = await run(async () => downloadError.error.message())

						pushError(
							makeSyncError({
								itemUuid: matched?.uuid ?? topLevelUuid,
								topLevelUuid,
								name: matched?.item.data.decryptedMeta?.name ?? directoryName,
								itemType: matched?.item.type ?? directory.type,
								kind: "download",
								message: errorMessage.success ? errorMessage.data : "Download failed"
							})
						)
					}
				}
			}

			// Verify-after-download — every remote entry must be PRESENT on disk before anything
			// advances. Runs after EVERY download regardless of pass mode (it is what makes a
			// committed meta trustworthy at write time) and on disk-verified passes even without
			// one. An index-only pass that downloaded nothing changed no bytes — it skips these
			// stats entirely (external damage is detected on thorough passes or at file-access
			// time, the design's accepted trade).
			//
			// Absence is FATAL (blocks the commit). A size that diverges from the item's meta size
			// is NOT — meta sizes are client-supplied and remote content can genuinely be shorter
			// than claimed (crashed uploads); the SDK downloads every chunk that exists and reports
			// success. Treating the divergence as fatal would block the whole tree forever (the SDK
			// can never produce different bytes for the same uuid). Instead the delivered size is
			// recorded on the committed entry (so heals stop re-downloading it) and a DEGRADED
			// warning surfaces the likely-corrupt remote once per fresh observation.
			const verifiedFileUuids = new Set<string>()
			const observedSizeMismatches = new Map<string, number>()

			if (downloadRan || thoroughLocalView) {
				for (const [uuid, remoteEntry] of remote) {
					// Deferred movers (and entries riding inside them) knowingly sit at their CURRENT
					// paths, not their remote ones — stat where the bytes actually are.
					const expectedPath = expectedDiskPath(uuid, remoteEntry.path)

					if (remoteEntry.isDirectory) {
						if (!new FileSystem.Directory(liveDirUri, expectedPath).exists) {
							pushError(
								makeSyncError({
									itemUuid: uuid,
									topLevelUuid,
									name: remoteEntry.item.data.decryptedMeta?.name ?? uuid,
									itemType: remoteEntry.item.type,
									kind: "verify",
									message: `Missing on disk after sync: ${expectedPath}`
								})
							)
						}

						continue
					}

					// One info() call per file — exists + size in a single native hop instead of two.
					const dataFileInfo = new FileSystem.File(liveDirUri, expectedPath).info()

					if (!dataFileInfo.exists) {
						pushError(
							makeSyncError({
								itemUuid: uuid,
								topLevelUuid,
								name: remoteEntry.item.data.decryptedMeta?.name ?? uuid,
								itemType: remoteEntry.item.type,
								kind: "verify",
								message: `Missing on disk after sync: ${expectedPath}`
							})
						)

						continue
					}

					const observedSize = dataFileInfo.size ?? 0
					const expectedSize = isFileItem(remoteEntry.item) ? Number(remoteEntry.item.data.decryptedMeta?.size ?? -1) : -1

					verifiedFileUuids.add(uuid)

					if (observedSize !== expectedSize) {
						observedSizeMismatches.set(uuid, observedSize)

						// Warn only when this divergence is a fresh observation — an entry already
						// committed at this exact delivered size has warned before, and re-nagging on
						// every manual sync of an otherwise-clean tree helps nobody.
						if (existingEntries[uuid]?.diskSize !== observedSize) {
							pushError(
								makeSyncError({
									itemUuid: uuid,
									topLevelUuid,
									name: remoteEntry.item.data.decryptedMeta?.name ?? uuid,
									itemType: remoteEntry.item.type,
									kind: "verify",
									degraded: true,
									message: `Stored with a size mismatch: ${expectedPath} holds ${observedSize} bytes but its metadata claims ${expectedSize} — the remote file content is likely incomplete`
								})
							)
						}
					}
				}
			}

			// Commit — advances ONLY when the pass verified clean apart from degraded-listing
			// markers (verify and download errors are never degraded, so they always block here).
			if (errors.some(error => error.degraded !== true)) {
				return finish(errors)
			}

			// THOROUGH FIXED POINT — disk-verified no-op (a manual sync over a healthy committed
			// tree): the verify stats above ran and confirmed every entry in place at its expected
			// size. When nothing changed versus the existing meta (incl. per-entry delivered-size
			// records), skip the committedEntries build, the full meta serialize and the meta-text
			// read — the slow path below would only conclude metaUnchanged anyway. Mirrors the
			// index-only fast fixed point before the ops phase.
			if (
				thoroughLocalView &&
				!downloadRan &&
				!initialStore &&
				!metaWasUnreadable &&
				!listingDegraded &&
				errors.length === 0 &&
				plan.ops.length === 0 &&
				plan.missingUuids.length === 0 &&
				plan.deferredMoves.length === 0 &&
				remote.size === local.length
			) {
				let fixedPoint = true

				for (const [uuid, remoteEntry] of remote) {
					const existing = existingEntries[uuid]
					const committedDiskSize = verifiedFileUuids.has(uuid) ? observedSizeMismatches.get(uuid) : existing?.diskSize

					if (
						!existing ||
						existing.path !== remoteEntry.path ||
						committedDiskSize !== existing.diskSize ||
						!serializeEquals(existing.item, remoteEntry.item)
					) {
						fixedPoint = false

						break
					}
				}

				if (fixedPoint) {
					return errors
				}
			}

			// Committed entries: every remote entry — deferred movers (and their riders) at their
			// CURRENT disk path rather than the remote one — plus, on a degraded pass only, the
			// VERIFIED UNION's preserved entries: existing-meta entries absent from the degraded
			// listing (exactly the uuids the skipped delete phase kept on disk). They were verified
			// by the pass that originally committed them; each is included with its existing item
			// only when its bytes are still present right now.
			const committedEntries = new Map<
				string,
				{
					item: DriveItem
					path: string
					diskSize?: number
				}
			>()

			for (const [uuid, remoteEntry] of remote) {
				// Delivered-size record: a freshly verified mismatch records its observed size; an
				// entry this pass did NOT stat (index-only commit) carries its existing record; a
				// verified entry whose size matches its meta drops any stale record.
				const diskSize = verifiedFileUuids.has(uuid) ? observedSizeMismatches.get(uuid) : existingEntries[uuid]?.diskSize

				committedEntries.set(uuid, {
					item: remoteEntry.item,
					path: expectedDiskPath(uuid, remoteEntry.path),
					...(diskSize !== undefined
						? {
								diskSize
							}
						: {})
				})
			}

			if (listingDegraded) {
				const committedPaths = new Set<string>()

				for (const committedEntry of committedEntries.values()) {
					committedPaths.add(committedEntry.path)
				}

				const localStatByUuid = new Map<string, boolean>()

				for (const localEntry of local) {
					localStatByUuid.set(localEntry.uuid, localEntry.existsOnDisk)
				}

				for (const uuid in existingEntries) {
					const entry = existingEntries[uuid]

					if (!entry || remote.has(uuid)) {
						continue
					}

					// Drop preserved entries whose pre-pass stat said missing — an unlisted entry
					// whose bytes are gone has nothing verified to preserve (it re-enters via the
					// listing + download once the listing reads clean again). Index-only passes
					// trust the meta here (the view is all-true); the re-stat below still guards
					// every path the union actually commits.
					if (localStatByUuid.get(uuid) !== true) {
						continue
					}

					// The move phase may have carried an unlisted entry along inside a moved/renamed
					// ancestor directory — the planner's finalPaths already tracked the entry through
					// every executed move, so the union records its CURRENT on-disk path.
					const path = plan.finalPaths.get(uuid) ?? entry.path

					// A committed entry already claims this exact path (e.g. the file was re-created
					// under a new uuid): the downloaded bytes own it — aliasing the stale uuid onto
					// the same path would lie about what is on disk. Drop the preserved entry;
					// cleanup happens once the listing is clean.
					if (committedPaths.has(path)) {
						continue
					}

					// Verified union: re-stat the final path so the committed meta only ever claims
					// bytes that are actually present. Size compares against the recorded delivered
					// size when present (same drift rule as the local view above).
					if (isDirectoryItem(entry.item)) {
						if (!new FileSystem.Directory(liveDirUri, path).exists) {
							continue
						}
					} else {
						const preservedInfo = new FileSystem.File(liveDirUri, path).info()
						const expectedSize = entry.diskSize ?? Number(entry.item.data.decryptedMeta?.size ?? -1)

						if (!preservedInfo.exists || (preservedInfo.size ?? 0) !== expectedSize) {
							continue
						}
					}

					committedEntries.set(uuid, {
						item: entry.item,
						path,
						...(entry.diskSize !== undefined
							? {
									diskSize: entry.diskSize
								}
							: {})
					})
				}
			}

			// Current on-disk meta text, read LAZILY — only passes that reach the commit step pay
			// the (potentially multi-megabyte) read; fast fixed-point passes above never do.
			const currentMetaInfo = metaFile.info()
			const currentMetaText = currentMetaInfo.exists && (currentMetaInfo.size ?? 0) > 0 ? await metaFile.text() : null

			// Canonical entry order: plain lexicographic uuid sort (identical to the previous
			// tuple-sort comparator), built without the intermediate entries array.
			const sortedEntryUuids = [...committedEntries.keys()].sort()
			const committedRecord: DirectoryOfflineMeta["entries"] = {}

			for (let i = 0; i < sortedEntryUuids.length; i++) {
				const uuid = sortedEntryUuids[i] as string
				const committedEntry = committedEntries.get(uuid)

				if (committedEntry) {
					committedRecord[uuid] = committedEntry
				}
			}

			const serialized = serialize({
				item: directory,
				parent,
				entries: committedRecord
			} satisfies DirectoryOfflineMeta)

			const metaUnchanged = currentMetaText !== null && serialized === currentMetaText

			if (metaUnchanged && !downloadRan && !metaWasUnreadable) {
				// Fixed point: nothing changed — a TRUE no-op pass performs zero writes and no sweep.
				// Degraded markers (if any) still surface to the caller every pass.
				return errors
			}

			if (metaUnchanged) {
				// Byte-identical meta after a heal pass: skip the meta write, overlap dedup and index
				// update (all derived from the unchanged meta) — but a download still changed bytes on
				// disk, so derived caches are dropped and the orphan sweep below still runs (crashed
				// .filendl partials must not outlive a heal).
				if (downloadRan) {
					this.invalidateCaches()
				}
			} else {
				atomicWrite(metaFile, serialized)

				// Overlap dedup: entries of this tree (incl. degraded-pass preserved ones) subsume
				// their standalone copies. The flattened index contains EVERY nested entry of this
				// tree, so gating on the index alone would degenerate into one existence stat per
				// committed entry — instead list each storage root once and gate on actual on-disk
				// top-level uuids (typically a handful).
				const currentIndex = await this.readIndex()
				const standaloneFileUuids = new Set<string>()

				for (const entry of FILES_DIRECTORY.list()) {
					standaloneFileUuids.add(entry.name)
				}

				const storedTreeUuids = new Set<string>()

				for (const entry of DIRECTORIES_DIRECTORY.list()) {
					storedTreeUuids.add(entry.name)
				}

				for (const entryUuid of committedEntries.keys()) {
					if (standaloneFileUuids.has(entryUuid) && currentIndex.files[entryUuid]) {
						const standaloneFileDir = new FileSystem.Directory(`${FILES_DIRECTORY_URI}/${entryUuid}`)

						if (standaloneFileDir.exists) {
							standaloneFileDir.delete()
						}
					}

					// Don't delete ourselves — we're reconciling this tree, not a nested one.
					if (storedTreeUuids.has(entryUuid) && entryUuid !== topLevelUuid && currentIndex.directories[entryUuid]) {
						const standaloneDirDir = new FileSystem.Directory(`${DIRECTORIES_DIRECTORY_URI}/${entryUuid}`)

						if (standaloneDirDir.exists) {
							standaloneDirDir.delete()
						}
					}
				}

				this.invalidateCaches()

				if (!skipIndexUpdate) {
					await this.updateIndex()
				}
			}

			// Orphan sweep — only after a verified pass that ran a download or started with an
			// unreadable meta: delete physical paths the COMMITTED meta does not claim (this also
			// cleans crashed .filendl partials). The keep-set is built from committedEntries, so a
			// degraded pass's preserved entries (and their ancestors) are sweep-protected. Never
			// runs on true no-op passes.
			//
			// Membership is compared in NFC: iOS Foundation reports directory listings with
			// DECOMPOSED (NFD) Unicode names while listing/meta paths carry whatever form was
			// uploaded (usually NFC) — raw-string comparison made the sweep treat every file under
			// an umlaut-named directory as an orphan and delete the verified, just-committed
			// subtree. Disk operations still use the raw entry handles; only the comparison keys
			// are normalized.
			if (downloadRan || metaWasUnreadable) {
				const claimed = new Set<string>()

				for (const committedEntry of committedEntries.values()) {
					// ONE normalize per full path: NFC composition never crosses or affects "/"
					// (solidus participates in no canonical compositions), so slash-aligned slices
					// of the normalized path equal the normalized slices the old per-ancestor
					// normalize produced. The walk also stops at the first already-claimed
					// ancestor — shared parents are claimed exactly once instead of once per
					// descendant.
					let current = normalizeNfcFast(committedEntry.path)

					while (current !== "" && current !== "/" && !claimed.has(current)) {
						claimed.add(current)

						const lastSlash = current.lastIndexOf("/")

						current = lastSlash <= 0 ? "/" : current.slice(0, lastSlash)
					}
				}

				const metaFileName = `${topLevelUuid}.filenmeta`

				const sweep = (dir: FileSystem.Directory, relPrefix: string): void => {
					for (const entry of dir.list()) {
						if (relPrefix === "" && entry.name === metaFileName) {
							continue
						}

						const relPath = `${relPrefix}/${entry.name}`

						if (claimed.has(normalizeNfcFast(relPath))) {
							if (entry instanceof FileSystem.Directory) {
								sweep(entry, relPath)
							}

							continue
						}

						if (entry.exists) {
							entry.delete()
						}
					}
				}

				sweep(liveDir, "")
			}

			// Committed. Degraded markers (if any) still bubble so the caller's error surface keeps
			// reporting the listing degradation until it clears.
			return errors
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	}

	// Resolves true when the file IS stored offline on return (download completed + meta written,
	// or it was already stored / nested inside a stored tree), false when the download was ABORTED
	// (transfers.download returned null) — nothing was committed and the partial dir is cleaned up.
	// Failures still throw. Callers that must not treat an aborted store as durable (e.g. the sync
	// version adoption, which only drops the old copy once the new one is stored) check the boolean.
	public async storeFile({
		file,
		parent,
		hideProgress,
		skipIndexUpdate,
		signal
	}: {
		file: DriveItem
		parent: OfflineParent
		hideProgress?: boolean
		skipIndexUpdate?: boolean
		signal?: AbortSignal
	}): Promise<boolean> {
		const result = await run(async defer => {
			if (!isFileItem(file)) {
				throw new Error("Item not of type file")
			}

			if (!file.data.decryptedMeta) {
				throw new Error("File missing decrypted meta")
			}

			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			// Per-UUID lock (outermost of the store locks): serializes the whole guard→delete→download→index
			// section against another store call for the same file, so neither wipes the other's in-flight target.
			const releaseStoreItemLock = await this.acquireStoreItemLock(file.data.uuid)

			defer(() => {
				releaseStoreItemLock()
			})

			await this.storeMutex.acquire()

			defer(() => {
				this.storeMutex.release()
			})

			this.ensureDirectories()

			if (await this.isItemStored(file)) {
				return true
			}

			// Skip if this file already exists inside a stored directory tree (overlap guard).
			const uuidToTopLevel = await this.buildUuidToTopLevelIndex()

			if (uuidToTopLevel.has(file.data.uuid)) {
				return true
			}

			const dataFile = new FileSystem.File(FileSystem.Paths.join(FILES_DIRECTORY.uri, file.data.uuid, file.data.decryptedMeta.name))
			const metaFile = new FileSystem.File(FileSystem.Paths.join(FILES_DIRECTORY.uri, file.data.uuid, `${file.data.uuid}.filenmeta`))

			if (dataFile.parentDirectory.exists) {
				dataFile.parentDirectory.delete()
			}

			dataFile.parentDirectory.create({
				intermediates: true,
				idempotent: true
			})

			const innerResult = await run(async defer => {
				let resolveCompletion: (() => void) | undefined

				defer(() => {
					resolveCompletion?.()
				})

				const completionPromise = new Promise<void>(resolve => {
					resolveCompletion = resolve
				})

				const downloadResult = await transfers.download({
					item: file,
					destination: dataFile,
					hideProgress,
					awaitExternalCompletionBeforeMarkingAsFinished: () => completionPromise,
					signal
				})

				// Aborted (null result): nothing was committed — no meta write, no index update.
				if (!downloadResult) {
					return false
				}

				// Record the delivered size when it diverges from the (client-supplied, possibly
				// wrong) meta size, so thorough heals bless these bytes instead of re-downloading
				// the same shortfall forever.
				const observedSize = dataFile.exists ? (dataFile.size ?? 0) : null
				const expectedSize = Number(file.data.decryptedMeta?.size ?? -1)

				atomicWrite(
					metaFile,
					serialize({
						item: file,
						parent,
						...(observedSize !== null && observedSize !== expectedSize
							? {
									diskSize: observedSize
								}
							: {})
					} satisfies FileOrDirectoryOfflineMeta)
				)

				this.invalidateCaches()

				if (!skipIndexUpdate) {
					await this.updateIndex()
				}

				return true
			})

			if (!innerResult.success) {
				if (dataFile.parentDirectory.exists) {
					dataFile.parentDirectory.delete()
				}

				throw innerResult.error
			}

			if (!innerResult.data) {
				// Aborted: clean up the partial download dir (same as the failure path) so no
				// meta-less files/{uuid}/ residue is left behind, and report not-stored.
				if (dataFile.parentDirectory.exists) {
					dataFile.parentDirectory.delete()
				}

				return false
			}

			return true
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	}

	// Meta-preserving standalone self-heal: re-downloads a stored standalone file's bytes to the
	// exact files/{uuid}/{name} data path while KEEPING the existing meta. Stale data files left
	// behind by an older name are removed first; the meta is only rewritten after a successful
	// download. A failed or aborted heal leaves the meta untouched — the item stays listed offline
	// so the next sync pass retries. No index update — callers batch one at the end of their pass.
	// Resolves true when the download completed and the meta was rewritten, false when the download
	// was aborted (null result). Failures still throw.
	public async redownloadStandaloneFile({
		item,
		parent,
		signal
	}: {
		item: DriveItem
		parent: OfflineParent
		signal?: AbortSignal
	}): Promise<boolean> {
		const result = await run(async defer => {
			if (!isFileItem(item)) {
				throw new Error("Item not of type file")
			}

			if (!item.data.decryptedMeta) {
				throw new Error("File missing decrypted meta")
			}

			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			const releaseStoreItemLock = await this.acquireStoreItemLock(item.data.uuid)

			defer(() => {
				releaseStoreItemLock()
			})

			await this.storeMutex.acquire()

			defer(() => {
				this.storeMutex.release()
			})

			this.ensureDirectories()

			const standaloneDir = new FileSystem.Directory(FileSystem.Paths.join(FILES_DIRECTORY.uri, item.data.uuid))

			if (!standaloneDir.exists) {
				standaloneDir.create({
					intermediates: true,
					idempotent: true
				})
			}

			const metaFileName = `${item.data.uuid}.filenmeta`
			const dataFileName = item.data.decryptedMeta.name
			let deletedStaleData = false

			// Drop stale data files from an older name (the heal may follow a remote rename) — never
			// the meta, never the current data file (the download overwrites it in place). Names
			// compare in NFC: iOS Foundation lists names in NFD, and a raw compare would classify
			// the CURRENT umlaut-named data file as stale, deleting it on every heal.
			const metaFileNameNfc = normalizeNfcFast(metaFileName)
			const dataFileNameNfc = normalizeNfcFast(dataFileName)

			for (const entry of standaloneDir.list()) {
				const entryNameNfc = normalizeNfcFast(entry.name)

				if (entryNameNfc === metaFileNameNfc || entryNameNfc === dataFileNameNfc) {
					continue
				}

				if (entry.exists) {
					entry.delete()

					deletedStaleData = true
				}
			}

			if (deletedStaleData) {
				// The physical data changed underneath the derived caches (getLocalFile may have
				// cached the old-name file) — drop them even if the download below fails.
				this.invalidateCaches()
			}

			const dataFile = new FileSystem.File(FileSystem.Paths.join(standaloneDir.uri, dataFileName))

			const downloaded = await transfers.download({
				item,
				destination: dataFile,
				hideProgress: true,
				signal
			})

			if (!downloaded) {
				// Aborted — meta untouched; the next sync pass retries the heal.
				return false
			}

			const metaFile = new FileSystem.File(FileSystem.Paths.join(standaloneDir.uri, metaFileName))

			// Same delivered-size record as storeFile — without it a meta-size-drifted remote
			// would be re-healed (re-downloaded at the same shortfall) on every thorough pass.
			const observedSize = dataFile.exists ? (dataFile.size ?? 0) : null
			const expectedSize = Number(item.data.decryptedMeta.size ?? -1)

			atomicWrite(
				metaFile,
				serialize({
					item,
					parent,
					...(observedSize !== null && observedSize !== expectedSize
						? {
								diskSize: observedSize
							}
						: {})
				} satisfies FileOrDirectoryOfflineMeta)
			)

			this.invalidateCaches()

			return true
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	}

	public async storeDirectory({
		directory,
		parent,
		hideProgress,
		skipIndexUpdate,
		signal
	}: {
		directory: DriveItem
		parent: OfflineParent
		hideProgress?: boolean
		skipIndexUpdate?: boolean
		signal?: AbortSignal
	}): Promise<OfflineSyncError[]> {
		if (await this.isItemStored(directory)) {
			return []
		}

		// Skip if this dir is already nested inside another stored directory (but not if it IS a top-level entry).
		const uuidToTopLevel = await this.buildUuidToTopLevelIndex()
		const topLevelUuid = uuidToTopLevel.get(directory.data.uuid)

		if (topLevelUuid && topLevelUuid !== directory.data.uuid) {
			return []
		}

		const errors = await this.reconcileTree({
			directory,
			parent,
			hideProgress,
			skipIndexUpdate,
			initialStore: true,
			signal
		})

		// reconcileTree returns non-degraded errors for an initial store only when a readable
		// committed meta already existed at pass start (it deletes the partial tree and throws
		// otherwise). Surface such failures to the caller WITHOUT deleting the committed tree.
		// Degraded-only error sets mean the pass COMMITTED (verified union) — the store succeeded;
		// they are RETURNED so the caller can surface them (sync passes re-surface their own).
		const fatal = errors.filter(error => error.degraded !== true)

		if (fatal.length > 0) {
			throw new Error(fatal[0]?.message ?? "Storing directory offline failed")
		}

		return errors
	}

	// Converts a directory DriveItem at the given path into an AnyDirWithContext for SDK calls.
	// Needed because listDirectories returns DriveItems but SDK listing APIs require AnyDirWithContext.
	private findParentAnyDirWithContext(pathToItem: Record<string, DriveItem>, dirname: string): OfflineParent | null {
		const item = pathToItem[dirname]

		if (!item) {
			return null
		}

		return directoryDriveItemToAnyDirWithContext(item)
	}

	// Lists offline directories (and their files). Without parent: returns top-level stored directories.
	// With parent: navigates into a stored directory tree and returns only the immediate children of that parent.
	public async listDirectories(parent?: OfflineParent): Promise<{
		files: {
			item: DriveItem
			parent: OfflineParent
		}[]
		directories: {
			item: DriveItem
			parent: OfflineParent
		}[]
	}> {
		const cacheKey: string = parent ? parentCacheKey(parent) : "root"
		const cached = this.listDirectoriesCache.get(cacheKey)

		if (cached) {
			return cached
		}

		this.ensureDirectories()

		const directories: Awaited<ReturnType<typeof this.listDirectories>>["directories"] = []
		const files: Awaited<ReturnType<typeof this.listDirectories>>["files"] = []
		const topLevelEntries = DIRECTORIES_DIRECTORY.list()

		if (!parent) {
			await Promise.all(
				topLevelEntries.map(async topLevelEntry => {
					if (!(topLevelEntry instanceof FileSystem.Directory) || !validateUuid(topLevelEntry.name)) {
						return
					}

					const meta = await this.readDirectoryMeta(topLevelEntry.name)

					if (!meta) {
						return
					}

					if (!isDirectoryItem(meta.item)) {
						return
					}

					directories.push({
						item: meta.item,
						parent: meta.parent
					})
				})
			)

			const noParentResult = {
				files,
				directories
			}

			this.listDirectoriesCache.set(cacheKey, noParentResult)

			return noParentResult
		}

		// Use unwrapAnyDirUuid instead of unwrapDirMeta — the parent may be a deserialized
		// tagged-union from the PersistentMap cache, not a live SDK instance.
		const parentUuid: string | null = typeof parent === "string" ? null : unwrapAnyDirUuid(parent)

		if (!parentUuid) {
			return {
				files,
				directories
			}
		}

		const uuidToTopLevel = await this.buildUuidToTopLevelIndex()
		const topLevelUuid = uuidToTopLevel.get(parentUuid) ?? null

		if (!topLevelUuid) {
			return {
				files,
				directories
			}
		}

		const directoryMeta = await this.readDirectoryMeta(topLevelUuid)

		if (!directoryMeta) {
			return {
				files,
				directories
			}
		}

		const entryUuids = Object.keys(directoryMeta.entries)
		const uuidToPath: Record<string, string> = {
			[topLevelUuid]: "/"
		}
		const pathToItem: Record<string, DriveItem> = {
			"/": directoryMeta.item
		}

		for (let i = 0; i < entryUuids.length; i++) {
			const entryMeta = directoryMeta.entries[entryUuids[i] as string]

			if (!entryMeta || !isDirectoryItem(entryMeta.item)) {
				continue
			}

			pathToItem[entryMeta.path] = entryMeta.item
			uuidToPath[entryMeta.item.data.uuid] = entryMeta.path
		}

		const targetPath = uuidToPath[parentUuid]

		if (!targetPath) {
			return {
				files,
				directories
			}
		}

		for (let i = 0; i < entryUuids.length; i++) {
			const entryMeta = directoryMeta.entries[entryUuids[i] as string]

			if (!entryMeta) {
				continue
			}

			const dirname = rawPathDirname(entryMeta.path)

			if (dirname !== targetPath) {
				continue
			}

			switch (entryMeta.item.type) {
				case "directory":
				case "sharedRootDirectory":
				case "sharedDirectory": {
					const parent = this.findParentAnyDirWithContext(pathToItem, dirname)

					if (!parent) {
						continue
					}

					directories.push({
						item: entryMeta.item,
						parent
					})

					break
				}

				case "file":
				case "sharedFile":
				case "sharedRootFile": {
					const parent = this.findParentAnyDirWithContext(pathToItem, dirname)

					if (!parent) {
						continue
					}

					files.push({
						item: entryMeta.item,
						parent
					})

					break
				}
			}
		}

		const parentResult = {
			files,
			directories
		}

		this.listDirectoriesCache.set(cacheKey, parentResult)

		return parentResult
	}

	// Flattens all stored directory trees into a single list of files + directories.
	// Deduplicates by UUID because the same item could appear in overlapping trees.
	public async listDirectoriesRecursive(): Promise<Awaited<ReturnType<typeof this.listDirectories>>> {
		if (this.listDirectoriesRecursiveCache) {
			return this.listDirectoriesRecursiveCache
		}

		this.ensureDirectories()

		const directories: Awaited<ReturnType<typeof this.listDirectories>>["directories"] = []
		const files: Awaited<ReturnType<typeof this.listDirectories>>["files"] = []
		const seenUuids = new Set<string>()
		const topLevelEntries = DIRECTORIES_DIRECTORY.list()

		await Promise.all(
			topLevelEntries.map(async topLevelEntry => {
				if (!(topLevelEntry instanceof FileSystem.Directory) || !validateUuid(topLevelEntry.name)) {
					return
				}

				const directoryMeta = await this.readDirectoryMeta(topLevelEntry.name)

				if (!directoryMeta) {
					return
				}

				if (!isDirectoryItem(directoryMeta.item)) {
					return
				}

				if (seenUuids.has(directoryMeta.item.data.uuid)) {
					return
				}

				seenUuids.add(directoryMeta.item.data.uuid)

				directories.push({
					item: directoryMeta.item,
					parent: directoryMeta.parent
				})

				const entryUuids = Object.keys(directoryMeta.entries)
				const pathToItem: Record<string, DriveItem> = {
					"/": directoryMeta.item
				}

				for (let i = 0; i < entryUuids.length; i++) {
					const entryMeta = directoryMeta.entries[entryUuids[i] as string]

					if (!entryMeta || !isDirectoryItem(entryMeta.item)) {
						continue
					}

					pathToItem[entryMeta.path] = entryMeta.item
				}

				for (let i = 0; i < entryUuids.length; i++) {
					const entryMeta = directoryMeta.entries[entryUuids[i] as string]

					if (!entryMeta) {
						continue
					}

					const dirname = rawPathDirname(entryMeta.path)

					if (seenUuids.has(entryMeta.item.data.uuid)) {
						continue
					}

					switch (entryMeta.item.type) {
						case "directory":
						case "sharedRootDirectory":
						case "sharedDirectory": {
							const parent = this.findParentAnyDirWithContext(pathToItem, dirname)

							if (!parent) {
								continue
							}

							seenUuids.add(entryMeta.item.data.uuid)

							directories.push({
								item: entryMeta.item,
								parent
							})

							break
						}

						case "file":
						case "sharedFile":
						case "sharedRootFile": {
							const parent = this.findParentAnyDirWithContext(pathToItem, dirname)

							if (!parent) {
								continue
							}

							seenUuids.add(entryMeta.item.data.uuid)

							files.push({
								item: entryMeta.item,
								parent
							})

							break
						}
					}
				}
			})
		)

		const recursiveResult = {
			files,
			directories
		}

		this.listDirectoriesRecursiveCache = recursiveResult

		return recursiveResult
	}

	public async itemSize(item: DriveItem): Promise<{
		size: number
		files: number
		dirs: number
	}> {
		const cachedSize = this.itemSizeCache.get(item.data.uuid)

		if (cachedSize) {
			return cachedSize
		}

		this.ensureDirectories()

		switch (item.type) {
			case "file":
			case "sharedFile":
			case "sharedRootFile": {
				const index = await this.readIndex()
				const fileEntry = index.files[item.data.uuid]

				if (!fileEntry || !isFileItem(fileEntry.item)) {
					return {
						size: 0,
						files: 0,
						dirs: 0
					}
				}

				const sizeResult = {
					size: Number(fileEntry.item.data.decryptedMeta?.size ?? 0),
					files: 1,
					dirs: 0
				}

				this.itemSizeCache.set(item.data.uuid, sizeResult)

				return sizeResult
			}

			case "directory":
			case "sharedRootDirectory":
			case "sharedDirectory": {
				const uuidToTopLevel = await this.buildUuidToTopLevelIndex()
				const topLevelUuid = uuidToTopLevel.get(item.data.uuid)

				if (!topLevelUuid) {
					return {
						size: 0,
						files: 0,
						dirs: 0
					}
				}

				const directoryMeta = await this.readDirectoryMeta(topLevelUuid)

				if (!directoryMeta) {
					return {
						size: 0,
						files: 0,
						dirs: 0
					}
				}

				const entryUuids = Object.keys(directoryMeta.entries)
				const uuidToPath: Record<string, string> = {
					[topLevelUuid]: "/"
				}

				for (let i = 0; i < entryUuids.length; i++) {
					const entryMeta = directoryMeta.entries[entryUuids[i] as string]

					if (!entryMeta || !isDirectoryItem(entryMeta.item)) {
						continue
					}

					uuidToPath[entryMeta.item.data.uuid] = entryMeta.path
				}

				const targetPath = uuidToPath[item.data.uuid]

				if (!targetPath) {
					return {
						size: 0,
						files: 0,
						dirs: 0
					}
				}

				let size = 0
				let files = 0
				let dirs = 0
				const targetPrefix = targetPath === "/" ? "/" : `${targetPath}/`

				for (let i = 0; i < entryUuids.length; i++) {
					const entryMeta = directoryMeta.entries[entryUuids[i] as string]

					if (!entryMeta) {
						continue
					}

					const dirname = rawPathDirname(entryMeta.path)

					if (dirname !== targetPath && !dirname.startsWith(targetPrefix)) {
						continue
					}

					switch (entryMeta.item.type) {
						case "directory":
						case "sharedRootDirectory":
						case "sharedDirectory": {
							dirs += 1

							break
						}

						case "file":
						case "sharedFile":
						case "sharedRootFile": {
							size += Number(entryMeta.item.data.decryptedMeta?.size ?? 0)
							files += 1

							break
						}
					}
				}

				const sizeResult = {
					size,
					files,
					dirs
				}

				this.itemSizeCache.set(item.data.uuid, sizeResult)

				return sizeResult
			}
		}
	}

	public async clearAll(): Promise<void> {
		// Snapshot every uuid+type that's about to disappear so we can invalidate the
		// "is item stored offline?" queries after deletion. Match removeItem's pattern of
		// walking nested directory-meta entries pessimistically.
		const stored = await this.clearBarrier.runExclusive(async () => {
			const collected: {
				uuid: string
				type: DriveItem["type"]
			}[] = []

			if (INDEX_FILE.exists) {
				const index = await this.readIndex()

				for (const fileEntry of Object.values(index.files)) {
					collected.push({
						uuid: fileEntry.item.data.uuid,
						type: fileEntry.item.type
					})
				}

				for (const directoryEntry of Object.values(index.directories)) {
					collected.push({
						uuid: directoryEntry.item.data.uuid,
						type: directoryEntry.item.type
					})

					const meta = await this.readDirectoryMeta(directoryEntry.item.data.uuid)

					if (!meta) {
						continue
					}

					for (const entry of Object.values(meta.entries ?? {})) {
						if (!entry) {
							continue
						}

						collected.push({
							uuid: entry.item.data.uuid,
							type: entry.item.type
						})
					}
				}
			}

			if (DIRECTORY.exists) {
				DIRECTORY.delete()
			}

			this.directoriesEnsured = false
			this.indexCache = null

			this.ensureDirectories()
			this.invalidateCaches()

			return collected
		})

		// updateIndex acquires indexMutex internally — call it after leaving the barrier.
		await this.updateIndex()

		// Broadcast offline=false for every item that was previously stored so badges update
		// without waiting for the next isItemStored() refetch.
		for (const { uuid, type } of stored) {
			driveItemStoredOfflineQueryUpdate({
				updater: false,
				params: {
					uuid,
					type
				}
			})
		}
	}

	public async size(): Promise<{
		size: number
		files: number
		dirs: number
	}> {
		const index = await this.readIndex()
		const files = Object.keys(index.files).length
		const dirs = Object.keys(index.directories).length

		const size = sumLocalDirectoryFileBytes(FILES_DIRECTORY) + sumLocalDirectoryFileBytes(DIRECTORIES_DIRECTORY)

		return {
			size,
			files,
			dirs
		}
	}

	public async removeItem(item: DriveItem): Promise<void> {
		const result = await run(async defer => {
			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			// Per-UUID lock: a removal must not interleave with a same-uuid reconcile/redownload
			// mid-pass — without it the delete can land between that pass's download and commit,
			// whose meta/index write then resurrects the item. Callers never hold this lock when
			// calling removeItem and the lock order matches every other store method
			// (clearBarrier → per-uuid → storeMutex), so no deadlock is possible.
			const releaseStoreItemLock = await this.acquireStoreItemLock(item.data.uuid)

			defer(() => {
				releaseStoreItemLock()
			})

			await this.storeMutex.acquire()

			defer(() => {
				this.storeMutex.release()
			})

			this.ensureDirectories()

			let didDelete = false

			if (isFileItem(item)) {
				const parentDirectory = new FileSystem.Directory(FileSystem.Paths.join(FILES_DIRECTORY.uri, item.data.uuid))

				if (parentDirectory.exists) {
					parentDirectory.delete()

					didDelete = true
				}
			} else {
				const { directories: topLevelDirectories } = await this.listDirectories()

				for (const { item: directoryItem } of topLevelDirectories) {
					if (!isDirectoryItem(directoryItem)) {
						continue
					}

					if (directoryItem.data.uuid !== item.data.uuid) {
						continue
					}

					// Read meta before deletion to get all nested entries for query invalidation
					const directoryMeta = await this.readDirectoryMeta(directoryItem.data.uuid)

					if (directoryMeta) {
						for (const uuid in directoryMeta.entries) {
							const entry = directoryMeta.entries[uuid]

							if (entry) {
								driveItemStoredOfflineQueryUpdate({
									updater: false,
									params: {
										uuid: entry.item.data.uuid,
										type: entry.item.type
									}
								})
							}
						}
					}

					const dataDirectory = new FileSystem.Directory(
						FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, directoryItem.data.uuid)
					)

					if (!dataDirectory.exists) {
						continue
					}

					dataDirectory.delete()

					didDelete = true
				}
			}

			if (didDelete) {
				// The disk changed — drop derived caches (and bump the mutation counter) HERE, like
				// every other mutator. updateIndex's no-mutation skip relies on mutators owning
				// their own invalidation; removeItem previously leaned on updateIndex's internal
				// invalidate for it.
				this.invalidateCaches()

				await this.updateIndex()

				// Optimistically prune the /offline virtual-root listing so the row
				// disappears without waiting for the next mount-driven refetch.
				// removeItem only operates on top-level entries, so the root list is
				// the only place where the removed item is directly visible; nested
				// children already had their per-item driveItemStoredOfflineQuery
				// invalidated above.
				driveItemsQueryUpdate({
					params: {
						path: {
							type: "offline",
							uuid: null
						}
					},
					updater: prev => {
						if (!Array.isArray(prev)) {
							return prev
						}

						return prev.filter(driveItem => driveItem.data.uuid !== item.data.uuid)
					}
				})
			}

			driveItemStoredOfflineQueryUpdate({
				updater: false,
				params: {
					uuid: item.data.uuid,
					type: item.type
				}
			})
		})

		if (!result.success) {
			throw result.error
		}
	}

	// Looks up a file's local path: first checks standalone files/, then the owning directory tree's
	// uuid-keyed entries (O(1) lookup → join the entry's raw path).
	public async getLocalFile(item: DriveItem): Promise<FileSystem.File | null> {
		const cachedLocalFile = this.getLocalFileCache.get(item.data.uuid)

		if (cachedLocalFile) {
			return cachedLocalFile
		}

		if (!isFileItem(item)) {
			return null
		}

		this.ensureDirectories()

		const index = await this.readIndex()
		const fileEntry = index.files[item.data.uuid]
		// Nested tree entries are flattened into index.files too — consult the uuid→top-level map
		// FIRST so their guaranteed-miss standalone stat is skipped (same uuid ⟹ same bytes, so
		// serving the tree copy is equally correct during a transient standalone/tree overlap).
		const uuidToTopLevel = await this.buildUuidToTopLevelIndex()
		const topLevelUuid = uuidToTopLevel.get(item.data.uuid)

		const tryStandalone = (): FileSystem.File | null => {
			if (!fileEntry || !isFileItem(fileEntry.item)) {
				return null
			}

			const file = new FileSystem.File(
				FileSystem.Paths.join(FILES_DIRECTORY_URI, fileEntry.item.data.uuid, fileEntry.item.data.decryptedMeta?.name ?? "")
			)

			if (file.exists) {
				this.getLocalFileCache.set(item.data.uuid, file)

				return file
			}

			return null
		}

		if (!topLevelUuid) {
			return tryStandalone()
		}

		const directoryMeta = await this.readDirectoryMeta(topLevelUuid)
		const entryMeta = directoryMeta?.entries[item.data.uuid]

		if (entryMeta && isFileItem(entryMeta.item)) {
			// Raw name-bearing path → separate constructor args, so expo's encoder runs on it.
			const foundFile = new FileSystem.File(DIRECTORIES_DIRECTORY_URI, topLevelUuid, entryMeta.path)

			if (foundFile.exists) {
				this.getLocalFileCache.set(item.data.uuid, foundFile)

				return foundFile
			}
		}

		// Tree bytes missing (or tree meta unreadable): a standalone copy may still exist — keep
		// the old standalone-first behavior's reachability as a last resort.
		return tryStandalone()
	}

	public async getLocalDirectory(item: DriveItem): Promise<FileSystem.Directory | null> {
		const cachedLocalDir = this.getLocalDirectoryCache.get(item.data.uuid)

		if (cachedLocalDir) {
			return cachedLocalDir
		}

		if (!isDirectoryItem(item)) {
			return null
		}

		this.ensureDirectories()

		const uuidToTopLevel = await this.buildUuidToTopLevelIndex()
		const topLevelUuid = uuidToTopLevel.get(item.data.uuid)

		if (!topLevelUuid) {
			return null
		}

		const directoryMeta = await this.readDirectoryMeta(topLevelUuid)

		if (!directoryMeta) {
			return null
		}

		// Check if this is the top-level directory itself
		if (directoryMeta.item.data.uuid === item.data.uuid) {
			const foundDirectory = new FileSystem.Directory(`${DIRECTORIES_DIRECTORY_URI}/${topLevelUuid}`)

			if (foundDirectory.exists) {
				this.getLocalDirectoryCache.set(item.data.uuid, foundDirectory)

				return foundDirectory
			}
		}

		// Nested entries are uuid-keyed — direct lookup, then the raw name-bearing path goes in
		// as a separate constructor arg so expo's encoder runs on it.
		const entryMeta = directoryMeta.entries[item.data.uuid]

		if (!entryMeta || !isDirectoryItem(entryMeta.item)) {
			return null
		}

		const foundDirectory = new FileSystem.Directory(DIRECTORIES_DIRECTORY_URI, topLevelUuid, entryMeta.path)

		if (foundDirectory.exists) {
			this.getLocalDirectoryCache.set(item.data.uuid, foundDirectory)

			return foundDirectory
		}

		return null
	}
}

const offline = new Offline()

export default offline
