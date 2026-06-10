import * as FileSystem from "expo-file-system"
import type { DriveItem } from "@/types"
import { run, Semaphore } from "@filen/utils"
import transfers from "@/features/transfers/transfers"
import { serialize, deserialize } from "@/lib/serializer"
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
	type OfflineParent,
	type OfflineSyncError,
	type OfflineSyncErrorKind
} from "@/features/offline/offlineHelpers"
import { planTreeReconcile, isSyncTmpName, type LocalTreeEntry, type RemoteTreeEntry } from "@/features/offline/offlineSyncPlanner"
import { validateUuid } from "@/lib/uuid"
import { driveItemStoredOfflineQueryUpdate } from "@/features/drive/queries/useDriveItemStoredOffline.query"
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
}

export type DirectoryOfflineMeta = FileOrDirectoryOfflineMeta & {
	entries: Record<
		Uuid,
		{
			item: DriveItem
			// Raw root-relative listing path with leading "/" — original decrypted names,
			// NEVER decoded or encoded. Disk access is Paths.join(treeDir.uri, path).
			path: string
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
//     directory download for missing entries, verify everything, and only then commit meta + index.
//     No staging, no swap — a failed pass leaves disk state untouched, returns OfflineSyncErrors,
//     and the next pass re-converges. A no-op pass writes nothing (serialized-meta fixed point).
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
	private readonly directoryMetaCache = new Map<string, DirectoryOfflineMeta>()
	private uuidToTopLevelCache: Map<string, string> | null = null
	private abortController: AbortController = new AbortController()

	public constructor() {
		this.ensureDirectories()
	}

	public cancel(): void {
		this.abortController.abort()
		this.abortController = new AbortController()
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
			if (OFFLINE_PARENT_DIRECTORY.exists) {
				for (const entry of OFFLINE_PARENT_DIRECTORY.list()) {
					if (entry instanceof FileSystem.Directory && entry.name !== `v${VERSION}`) {
						entry.delete()
					}
				}
			}

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

		const metaFile = new FileSystem.File(FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, topLevelUuid, `${topLevelUuid}.filenmeta`))

		if (!metaFile.exists || metaFile.size === 0) {
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

				this.ensureDirectories()
				this.invalidateCaches()

				const [files, directories] = await Promise.all([this.listFiles(), this.listDirectoriesRecursive()])
				const indexFiles: Index["files"] = {}
				const indexDirectories: Index["directories"] = {}

				for (const { item, parent } of files) {
					indexFiles[item.data.uuid] = {
						item,
						parent
					}

					driveItemStoredOfflineQueryUpdate({
						updater: true,
						params: {
							uuid: item.data.uuid,
							type: item.type
						}
					})
				}

				for (const { item, parent } of directories.directories) {
					indexDirectories[item.data.uuid] = {
						item,
						parent
					}

					driveItemStoredOfflineQueryUpdate({
						updater: true,
						params: {
							uuid: item.data.uuid,
							type: item.type
						}
					})
				}

				for (const { item, parent } of directories.files) {
					indexFiles[item.data.uuid] = {
						item,
						parent
					}

					driveItemStoredOfflineQueryUpdate({
						updater: true,
						params: {
							uuid: item.data.uuid,
							type: item.type
						}
					})
				}

				const index: Index = {
					files: indexFiles,
					directories: indexDirectories
				}

				atomicWrite(INDEX_FILE, serialize(index satisfies Index))

				this.indexCache = index

				// Eagerly warm uuidToTopLevelCache so the sync isItemTopLevelStoredSync
				// used by drive item menus returns a defined answer immediately after
				// boot, not after the per-row isStoredOffline query lazily triggers it.
				// We just walked every top-level directory above; this re-reads their
				// meta but is the price for a clean cache invariant: "indexCache set
				// ⇒ uuidToTopLevelCache set".
				await this.buildUuidToTopLevelIndex()
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

			if (!INDEX_FILE.exists || INDEX_FILE.size === 0) {
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

	// TEMPORARY: replaced by offlineSync.sync() in the follow-up commit — see offlineSync.ts (Task 5).
	public async sync(): Promise<void> {
		// Noop
	}

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

				const innerEntries = entry.list()

				await Promise.all(
					innerEntries.map(async innerEntry => {
						if (!(innerEntry instanceof FileSystem.File) || innerEntry.name.endsWith(".filenmeta")) {
							return
						}

						const dataFile = innerEntry
						const metaFile = new FileSystem.File(
							FileSystem.Paths.join(dataFile.parentDirectory.uri, `${dataFile.parentDirectory.name}.filenmeta`)
						)

						if (!dataFile.exists || !metaFile.exists || metaFile.size === 0) {
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
			})
		)

		this.listFilesCache = files

		return files
	}

	// Scans FILES_DIRECTORY for standalone uuid-named directories whose meta file is missing, empty,
	// or undecodable while the directory itself still exists. Used by the sync top-level pass to
	// rebuild (own cloud) or remove (undecidable) broken standalone entries.
	public async listBrokenStandaloneUuids(): Promise<string[]> {
		this.ensureDirectories()

		const broken: string[] = []

		for (const entry of FILES_DIRECTORY.list()) {
			if (!(entry instanceof FileSystem.Directory) || !validateUuid(entry.name)) {
				continue
			}

			const metaFile = new FileSystem.File(FileSystem.Paths.join(entry.uri, `${entry.name}.filenmeta`))

			if (!metaFile.exists || metaFile.size === 0) {
				broken.push(entry.name)

				continue
			}

			const readResult = await run(async () => {
				const meta: FileOrDirectoryOfflineMeta = deserialize(await metaFile.text())

				if (Object.keys(meta).length === 0) {
					throw new Error("File meta is empty")
				}

				return meta
			})

			if (!readResult.success) {
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

	// Renames a standalone stored file's data file in place (remote rename, same uuid ⟹ same bytes)
	// and rewrites its meta. The current data file is located as the single non-.filenmeta file in
	// files/{uuid}/ so a stale on-disk name from an older meta still gets corrected.
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

				if (!dataFile) {
					return
				}

				if (dataFile.name !== newName) {
					dataFile.rename(newName)
				}

				const metaFile = new FileSystem.File(FileSystem.Paths.join(standaloneDir.uri, `${item.data.uuid}.filenmeta`))

				atomicWrite(
					metaFile,
					serialize({
						item,
						parent
					} satisfies FileOrDirectoryOfflineMeta)
				)

				this.invalidateCaches()
			},
			{
				throw: true
			}
		)
	}

	private makeSyncError({
		itemUuid,
		topLevelUuid,
		name,
		itemType,
		kind,
		message
	}: {
		itemUuid: string
		topLevelUuid: string | null
		name: string
		itemType: DriveItem["type"]
		kind: OfflineSyncErrorKind
		message: string
	}): OfflineSyncError {
		return {
			id: `${itemUuid}:${kind}`,
			itemUuid,
			topLevelUuid,
			name,
			itemType,
			kind,
			message,
			timestamp: Date.now()
		}
	}

	// Converges one stored directory tree onto its remote listing IN PLACE. Also the initial-store
	// path (storeDirectory delegates here with initialStore: true).
	//
	//   1. Clean leftover /.sync-tmp-* move temps (crash recovery).
	//   2. One bulk recursive remote listing → uuid → {item, raw path} map (Linked dirs excluded).
	//   3. Local view from the existing meta, stat-checked (file size mismatch counts as missing —
	//      truncation self-heal).
	//   4. Pure plan (offlineSyncPlanner): two-phase moves via tree-root temps + deletes (deletes are
	//      skipped while the listing is degraded by scan errors) — then execute.
	//   5. One in-place hash-idempotent directory download for missing uuids; per-entry download
	//      errors fail the pass.
	//   6. Verify every remote entry on disk, then commit meta + index ONLY when the pass collected
	//      zero errors. A rebuilt meta identical to the existing file is a no-op (zero writes).
	//   7. After a committed pass that downloaded or started with an unreadable meta: orphan sweep
	//      deletes physical paths the new meta does not claim (incl. crashed .filendl partials).
	//
	// Failure policy: no deletions on errors, meta/index never advance on a failed pass. initialStore
	// is the exception — the partial tree is deleted and the first error is thrown (UI alerts).
	public async reconcileTree({
		directory,
		parent,
		hideProgress,
		skipIndexUpdate,
		initialStore,
		signal
	}: {
		directory: DriveItem
		parent: OfflineParent
		hideProgress?: boolean
		skipIndexUpdate?: boolean
		initialStore?: boolean
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

			const pushError = (error: OfflineSyncError): void => {
				if (!errors.some(existing => existing.id === error.id)) {
					errors.push(error)
				}
			}

			const liveDir = new FileSystem.Directory(FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, topLevelUuid))

			// Initial-store failure policy: a user-initiated first store has no prior state worth
			// keeping, so a failed pass deletes the partial tree and throws (UI alerts as today).
			// Sync passes instead keep local state untouched and return the collected errors.
			const finish = (collected: OfflineSyncError[]): OfflineSyncError[] => {
				if (initialStore && collected.length > 0) {
					if (liveDir.exists) {
						liveDir.delete()
					}

					this.invalidateCaches()

					throw new Error(collected[0]?.message ?? "Storing directory offline failed")
				}

				return collected
			}

			if (!liveDir.exists) {
				liveDir.create({
					intermediates: true,
					idempotent: true
				})
			}

			// Crash recovery: a previous pass that died mid-move can leave /.sync-tmp-* extraction
			// temps at the tree root. Delete them — their bytes are restored below by the
			// hash-idempotent download.
			for (const entry of liveDir.list()) {
				if (isSyncTmpName(entry.name)) {
					entry.delete()
				}
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
					}
				)
			)

			if (!listingResult.success) {
				pushError(
					this.makeSyncError({
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

			for (const { file, path } of listingResult.data.files) {
				const unwrapped = unwrapFileMeta(file)

				if (!unwrapped.meta) {
					continue
				}

				remote.set(unwrapped.file.uuid, {
					uuid: unwrapped.file.uuid,
					item: unwrappedFileIntoDriveItem(unwrapped),
					path: `/${path}`,
					isDirectory: false
				})
			}

			// Local view from the existing meta. A file whose on-disk size diverges from its meta size
			// counts as missing so the download heals truncation for free. An unreadable meta yields an
			// empty local view — the hash-idempotent download skips healthy bytes and the meta is
			// rebuilt from the listing (near-free repair).
			const existingMeta = await this.readDirectoryMeta(topLevelUuid)
			const metaWasUnreadable = existingMeta === null && !initialStore
			const metaFile = new FileSystem.File(FileSystem.Paths.join(liveDir.uri, `${topLevelUuid}.filenmeta`))
			const currentMetaText = metaFile.exists && metaFile.size > 0 ? await metaFile.text() : null
			const existingEntries = existingMeta?.entries ?? {}
			const local: LocalTreeEntry[] = []

			for (const uuid in existingEntries) {
				const entry = existingEntries[uuid]

				if (!entry) {
					continue
				}

				if (isDirectoryItem(entry.item)) {
					local.push({
						uuid,
						path: entry.path,
						isDirectory: true,
						existsOnDisk: new FileSystem.Directory(FileSystem.Paths.join(liveDir.uri, entry.path)).exists
					})
				} else {
					const dataFile = new FileSystem.File(FileSystem.Paths.join(liveDir.uri, entry.path))

					local.push({
						uuid,
						path: entry.path,
						isDirectory: false,
						existsOnDisk: dataFile.exists && dataFile.size === Number(entry.item.data.decryptedMeta?.size ?? -1)
					})
				}
			}

			// Scan errors mean entries can be silently absent from the listing — deleting on that
			// basis would destroy good local copies, so the plan skips deletions for this pass
			// (moves and downloads still apply; deletions resume once the listing is clean).
			const plan = planTreeReconcile({
				remote,
				local,
				allowDeletes: scanErrors.length === 0
			})

			if (scanErrors.length > 0) {
				pushError(
					this.makeSyncError({
						itemUuid: topLevelUuid,
						topLevelUuid,
						name: directoryName,
						itemType: directory.type,
						kind: "listing",
						message: `Remote listing degraded (${scanErrors.length} scan error(s)) — skipped deletions for this pass`
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
						const destinationParent = new FileSystem.Directory(
							FileSystem.Paths.dirname(FileSystem.Paths.join(liveDir.uri, op.to))
						)

						if (!destinationParent.exists) {
							destinationParent.create({
								intermediates: true,
								idempotent: true
							})
						}

						if (op.isDirectory) {
							const from = new FileSystem.Directory(FileSystem.Paths.join(liveDir.uri, op.from))

							if (from.exists) {
								from.move(new FileSystem.Directory(FileSystem.Paths.join(liveDir.uri, op.to)))
							}
						} else {
							const from = new FileSystem.File(FileSystem.Paths.join(liveDir.uri, op.from))

							if (from.exists) {
								from.move(new FileSystem.File(FileSystem.Paths.join(liveDir.uri, op.to)))
							}
						}

						continue
					}

					if (op.isDirectory) {
						const target = new FileSystem.Directory(FileSystem.Paths.join(liveDir.uri, op.path))

						if (target.exists) {
							target.delete()
						}
					} else {
						const target = new FileSystem.File(FileSystem.Paths.join(liveDir.uri, op.path))

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
					this.makeSyncError({
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
				return finish(errors)
			}

			// Download missing/changed entries — at most ONE in-place directory download per pass.
			// The Rust downloader is idempotent per file (size+hash skip), so renames-before-download
			// maximize skips and only missing/changed bytes transfer.
			let downloadRan = false

			if (plan.missingUuids.length > 0) {
				if (signal?.aborted) {
					return finish(errors)
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
						this.makeSyncError({
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
					return finish(errors)
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
							this.makeSyncError({
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

			// Verify — every remote entry must be present on disk (files at their exact size) before
			// anything advances.
			for (const [uuid, remoteEntry] of remote) {
				if (remoteEntry.isDirectory) {
					if (!new FileSystem.Directory(FileSystem.Paths.join(liveDir.uri, remoteEntry.path)).exists) {
						pushError(
							this.makeSyncError({
								itemUuid: uuid,
								topLevelUuid,
								name: remoteEntry.item.data.decryptedMeta?.name ?? uuid,
								itemType: remoteEntry.item.type,
								kind: "verify",
								message: `Missing on disk after sync: ${remoteEntry.path}`
							})
						)
					}

					continue
				}

				const dataFile = new FileSystem.File(FileSystem.Paths.join(liveDir.uri, remoteEntry.path))
				const expectedSize = isFileItem(remoteEntry.item) ? Number(remoteEntry.item.data.decryptedMeta?.size ?? -1) : -1

				if (!dataFile.exists || dataFile.size !== expectedSize) {
					pushError(
						this.makeSyncError({
							itemUuid: uuid,
							topLevelUuid,
							name: remoteEntry.item.data.decryptedMeta?.name ?? uuid,
							itemType: remoteEntry.item.type,
							kind: "verify",
							message: `Missing or incomplete on disk after sync: ${remoteEntry.path}`
						})
					)
				}
			}

			// Commit — ONLY a fully-verified pass advances meta/index.
			if (errors.length > 0) {
				return finish(errors)
			}

			const serialized = serialize({
				item: directory,
				parent,
				entries: Object.fromEntries(
					[...remote.entries()]
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
						.map(([uuid, remoteEntry]) => [
							uuid,
							{
								item: remoteEntry.item,
								path: remoteEntry.path
							}
						])
				)
			} satisfies DirectoryOfflineMeta)

			if (currentMetaText !== null && serialized === currentMetaText) {
				// Fixed point: nothing changed — a no-op pass performs zero writes.
				return []
			}

			atomicWrite(metaFile, serialized)

			// Overlap dedup: entries of this tree subsume their standalone copies.
			const currentIndex = await this.readIndex()

			for (const entryUuid of remote.keys()) {
				if (currentIndex.files[entryUuid]) {
					const standaloneFileDir = new FileSystem.Directory(FileSystem.Paths.join(FILES_DIRECTORY.uri, entryUuid))

					if (standaloneFileDir.exists) {
						standaloneFileDir.delete()
					}
				}

				// Don't delete ourselves — we're reconciling this tree, not a nested one.
				if (currentIndex.directories[entryUuid] && entryUuid !== topLevelUuid) {
					const standaloneDirDir = new FileSystem.Directory(FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, entryUuid))

					if (standaloneDirDir.exists) {
						standaloneDirDir.delete()
					}
				}
			}

			this.invalidateCaches()

			if (!skipIndexUpdate) {
				await this.updateIndex()
			}

			// Orphan sweep — only after a committed pass that ran a download or started with an
			// unreadable meta: delete physical paths the new meta does not claim (this also cleans
			// crashed .filendl partials). Never runs on no-op passes.
			if (downloadRan || metaWasUnreadable) {
				const claimed = new Set<string>()

				for (const remoteEntry of remote.values()) {
					let current = remoteEntry.path

					while (current !== "" && current !== "/") {
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

						if (claimed.has(relPath)) {
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

			return []
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	}

	public async storeFile({
		file,
		parent,
		hideProgress,
		skipIndexUpdate,
		force,
		signal
	}: {
		file: DriveItem
		parent: OfflineParent
		hideProgress?: boolean
		skipIndexUpdate?: boolean
		// Skips the already-stored / nested-inside-a-stored-tree guards. Used by the sync self-heal
		// re-download path, where the item IS stored but its data file is missing or truncated —
		// the delete-parent-dir-then-download flow below restores it in place.
		force?: boolean
		signal?: AbortSignal
	}): Promise<void> {
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

			if (!force) {
				if (await this.isItemStored(file)) {
					return
				}

				// Skip if this file already exists inside a stored directory tree (overlap guard).
				const uuidToTopLevel = await this.buildUuidToTopLevelIndex()

				if (uuidToTopLevel.has(file.data.uuid)) {
					return
				}
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

				const result = await transfers.download({
					item: file,
					destination: dataFile,
					hideProgress,
					awaitExternalCompletionBeforeMarkingAsFinished: () => completionPromise,
					signal
				})

				if (result) {
					atomicWrite(
						metaFile,
						serialize({
							item: file,
							parent
						} satisfies FileOrDirectoryOfflineMeta)
					)

					this.invalidateCaches()

					if (!skipIndexUpdate) {
						await this.updateIndex()
					}
				}
			})

			if (!innerResult.success) {
				if (dataFile.parentDirectory.exists) {
					dataFile.parentDirectory.delete()
				}

				throw innerResult.error
			}
		})

		if (!result.success) {
			throw result.error
		}
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
	}): Promise<void> {
		if (await this.isItemStored(directory)) {
			return
		}

		// Skip if this dir is already nested inside another stored directory (but not if it IS a top-level entry).
		const uuidToTopLevel = await this.buildUuidToTopLevelIndex()
		const topLevelUuid = uuidToTopLevel.get(directory.data.uuid)

		if (topLevelUuid && topLevelUuid !== directory.data.uuid) {
			return
		}

		await this.reconcileTree({
			directory,
			parent,
			hideProgress,
			skipIndexUpdate,
			initialStore: true,
			signal
		})
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

		const uuidToPath: Record<string, string> = {
			[topLevelUuid]: "/"
		}
		const pathToItem: Record<string, DriveItem> = {
			"/": directoryMeta.item
		}

		for (const uuid in directoryMeta.entries) {
			const entryMeta = directoryMeta.entries[uuid]

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

		for (const uuid in directoryMeta.entries) {
			const entryMeta = directoryMeta.entries[uuid]

			if (!entryMeta) {
				continue
			}

			let dirname = FileSystem.Paths.dirname(entryMeta.path)

			if (dirname === "." || dirname === "") {
				dirname = "/"
			}

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

				const pathToItem: Record<string, DriveItem> = {
					"/": directoryMeta.item
				}

				for (const uuid in directoryMeta.entries) {
					const entryMeta = directoryMeta.entries[uuid]

					if (!entryMeta || !isDirectoryItem(entryMeta.item)) {
						continue
					}

					pathToItem[entryMeta.path] = entryMeta.item
				}

				for (const uuid in directoryMeta.entries) {
					const entryMeta = directoryMeta.entries[uuid]

					if (!entryMeta) {
						continue
					}

					let dirname = FileSystem.Paths.dirname(entryMeta.path)

					if (dirname === "." || dirname === "") {
						dirname = "/"
					}

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

				const uuidToPath: Record<string, string> = {
					[topLevelUuid]: "/"
				}

				for (const uuid in directoryMeta.entries) {
					const entryMeta = directoryMeta.entries[uuid]

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

				for (const uuid in directoryMeta.entries) {
					const entryMeta = directoryMeta.entries[uuid]

					if (!entryMeta) {
						continue
					}

					let dirname = FileSystem.Paths.dirname(entryMeta.path)

					if (dirname === "." || dirname === "") {
						dirname = "/"
					}

					if (dirname !== targetPath && !dirname.startsWith(targetPath === "/" ? "/" : `${targetPath}/`)) {
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

		if (fileEntry && isFileItem(fileEntry.item)) {
			const file = new FileSystem.File(
				FileSystem.Paths.join(FILES_DIRECTORY.uri, fileEntry.item.data.uuid, fileEntry.item.data.decryptedMeta?.name ?? "")
			)

			if (file.exists) {
				this.getLocalFileCache.set(item.data.uuid, file)

				return file
			}
		}

		// Standalone lookup missed (either no index entry or the file isn't on
		// disk at the standalone path). Fall through to the directory-tree lookup
		// below — the item may live inside a marked-offline directory rather than
		// marked standalone, and `buildUuidToTopLevelIndex` includes the uuids of
		// every nested file entry across all marked-offline directories.
		const uuidToTopLevel = await this.buildUuidToTopLevelIndex()
		const topLevelUuid = uuidToTopLevel.get(item.data.uuid)

		if (!topLevelUuid) {
			return null
		}

		const directoryMeta = await this.readDirectoryMeta(topLevelUuid)

		if (!directoryMeta) {
			return null
		}

		const entryMeta = directoryMeta.entries[item.data.uuid]

		if (!entryMeta || !isFileItem(entryMeta.item)) {
			return null
		}

		const foundFile = new FileSystem.File(FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, topLevelUuid, entryMeta.path))

		if (foundFile.exists) {
			this.getLocalFileCache.set(item.data.uuid, foundFile)

			return foundFile
		}

		return null
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
			const foundDirectory = new FileSystem.Directory(FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, topLevelUuid))

			if (foundDirectory.exists) {
				this.getLocalDirectoryCache.set(item.data.uuid, foundDirectory)

				return foundDirectory
			}
		}

		// Nested entries are uuid-keyed — direct lookup, then join the raw path.
		const entryMeta = directoryMeta.entries[item.data.uuid]

		if (!entryMeta || !isDirectoryItem(entryMeta.item)) {
			return null
		}

		const foundDirectory = new FileSystem.Directory(FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, topLevelUuid, entryMeta.path))

		if (foundDirectory.exists) {
			this.getLocalDirectoryCache.set(item.data.uuid, foundDirectory)

			return foundDirectory
		}

		return null
	}
}

const offline = new Offline()

export default offline
