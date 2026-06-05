import * as FileSystem from "expo-file-system"
import type { DriveItem } from "@/types"
import { run, Semaphore } from "@filen/utils"
import transfers from "@/features/transfers/transfers"
import { serialize, deserialize } from "@/lib/serializer"
import auth from "@/lib/auth"
import {
	type File,
	type Dir,
	type SharedFile,
	type SharedDir,
	type SharedRootDir,
	NonRootDir_Tags,
	ErrorKind,
	AnyDirWithContext,
	AnySharedDirWithContext,
	AnySharedDir,
	AnyNormalDir,
	AnyDirWithContext_Tags,
	AnySharedDir_Tags
} from "@filen/sdk-rs"
import cache from "@/lib/cache"
import { normalizeModificationTimestampForComparison } from "@/lib/utils"
import {
	unwrapFileMeta,
	unwrapDirMeta,
	unwrapAnyDirUuid,
	unwrappedDirIntoDriveItem,
	unwrappedFileIntoDriveItem,
	unwrapParentUuid
} from "@/lib/sdkUnwrap"
import { normalizeFilePathForSdk, extractPathInsideUuidDirectory } from "@/lib/paths"
import { unwrapSdkError } from "@/lib/sdkErrors"
import { sumLocalDirectoryFileBytes } from "@/lib/fsUtils"
import { ClearBarrier } from "@/lib/clearBarrier"
import { atomicWrite, parentCacheKey, type OfflineParent } from "@/features/offline/offlineHelpers"
import { validate as validateUuid } from "uuid"
import useOfflineStore from "@/features/offline/store/useOffline.store"
import { onlineManager } from "@tanstack/react-query"
import { driveItemStoredOfflineQueryUpdate } from "@/features/drive/queries/useDriveItemStoredOffline.query"
import { driveItemsQueryUpdate } from "@/features/drive/queries/useDriveItems.query"
import {
	OFFLINE_VERSION,
	OFFLINE_DIRECTORY,
	OFFLINE_FILES_DIRECTORY,
	OFFLINE_DIRECTORIES_DIRECTORY,
	OFFLINE_INDEX_FILE
} from "@/lib/storageRoots"

export type FileOrDirectoryOfflineMeta = {
	item: DriveItem
	parent: OfflineParent
}

export type DirectoryOfflineMeta = FileOrDirectoryOfflineMeta & {
	entries: Record<
		string,
		{
			item: DriveItem
		}
	>
}

export type Uuid = string

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
// Storage layout:
//   offline/v{N}/files/{uuid}/{filename}        — standalone files (one data file + one .filenmeta)
//   offline/v{N}/directories/{uuid}/...         — directory trees (recursive download + one .filenmeta with entries map)
//   offline/v{N}/index                          — serialized Index of all stored items (rebuilt on mutation)
//
// Key concepts:
//   - "Standalone" items are stored individually under files/ or as a top-level directory.
//   - When a directory is stored, its subtree is flattened into entries in the .filenmeta. Any standalone
//     items that overlap (same UUID already in the directory tree) are removed (overlap dedup).
//   - The Index is the source of truth for "is this item offline?" queries and is rebuilt atomically.
//   - sync() compares local offline state against remote, re-downloading changed/new files and pruning deleted ones.
export class Offline {
	// indexMutex(1): serializes index read/write to prevent concurrent corruption.
	private readonly indexMutex = new Semaphore(1)
	private indexCache: Index | null = null
	// syncMutex(1): only one sync() runs at a time (compares local vs remote state).
	private readonly syncMutex = new Semaphore(1)
	// storeMutex(3): allows up to 3 concurrent file/directory downloads while still bounding I/O.
	private readonly storeMutex = new Semaphore(3)
	// storeItemMutexes: per-UUID Semaphore(1) lock serializing storeFile/storeDirectory for the same item.
	// Without this, two concurrent store calls for the same UUID both pass the isItemStored guard (cold cache)
	// and race the destructive parent-directory delete/recreate, so call B wipes call A's in-flight download
	// target mid-transfer. Keyed by UUID so distinct items still download concurrently up to storeMutex(3).
	private readonly storeItemMutexes = new Map<string, Semaphore>()
	// clearBarrier: serializes clearAll against in-flight storeFile/storeDirectory/removeItem.
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
	}

	/**
	 * Acquire the per-UUID store lock, serializing storeFile/storeDirectory for the same item so the
	 * check-then-act (isItemStored guard → destructive parent delete/recreate → download → index update)
	 * runs atomically per UUID. Distinct UUIDs are unaffected and still bounded only by storeMutex(3).
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
			if (
				(meta.item.type === "directory" || meta.item.type === "sharedDirectory" || meta.item.type === "sharedRootDirectory") &&
				(meta.entries === undefined || meta.entries === null)
			) {
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
			for (const path in meta.entries) {
				const entry = meta.entries[path]

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

		if (item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile") {
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

	// Compares local offline items against remote server state and reconciles:
	// 1. Collects unique parents from all stored files/dirs, fetches their remote listings in parallel.
	// 2. For each stored file: deletes if removed remotely, re-downloads if modified, or re-stores under a new UUID if renamed.
	// 3. For each stored directory: recursively compares entries; sets needsFullResync=true if any diff, then re-downloads.
	// 4. Rebuilds the index at the end.
	public async sync(): Promise<void> {
		const signal = this.abortController.signal

		await run(
			async defer => {
				await this.syncMutex.acquire()

				useOfflineStore.getState().setSyncing(true)

				defer(() => {
					useOfflineStore.getState().setSyncing(false)

					this.syncMutex.release()
				})

				if (signal.aborted) {
					return
				}

				// sync() reads remote server state for every stored item; without
				// network those listDir calls would all fail. The reconnect
				// listener re-fires sync() on offline → online transition, so
				// returning here is the right behavior for cold-start in airplane
				// mode (setup.ts fire-and-forget) and for any future caller.
				if (!onlineManager.isOnline()) {
					return
				}

				this.ensureDirectories()

				const [files, { directories: topLevelDirectories }, { authedSdkClient }] = await Promise.all([
					this.listFiles(),
					this.listDirectories(),
					auth.getSdkClients()
				])

				// Dedup parents: multiple offline items may share a parent dir. We only need to list each parent once.
				const uniqueParents = new Map<string, OfflineParent>()

				for (const { parent } of files) {
					const key = parentCacheKey(parent)

					if (!uniqueParents.has(key)) {
						uniqueParents.set(key, parent)
					}
				}

				for (const { parent } of topLevelDirectories) {
					const key = parentCacheKey(parent)

					if (!uniqueParents.has(key)) {
						uniqueParents.set(key, parent)
					}
				}

				const parentListings = new Map<
					string,
					Awaited<
						| ReturnType<typeof authedSdkClient.listDir>
						| ReturnType<typeof authedSdkClient.listSharedDir>
						| ReturnType<typeof authedSdkClient.listInSharedRoot>
					> | null
				>()

				await Promise.all(
					Array.from(uniqueParents.entries()).map(async ([key, parent]) => {
						if (signal.aborted) {
							return
						}

						const listResult = await run(async () => {
							if (parent === "sharedInRoot") {
								return await authedSdkClient.listInSharedRoot({ signal })
							}

							switch (parent.tag) {
								case AnyDirWithContext_Tags.Normal: {
									return await authedSdkClient.listDir(parent.inner[0], { signal })
								}

								case AnyDirWithContext_Tags.Shared: {
									switch (parent.inner[0].dir.tag) {
										case AnySharedDir_Tags.Dir:
										case AnySharedDir_Tags.Root: {
											return await authedSdkClient.listSharedDir(parent.inner[0].dir, parent.inner[0].shareInfo, {
												signal
											})
										}

										default: {
											throw new Error("Unsupported shared directory type for listing")
										}
									}
								}

								case AnyDirWithContext_Tags.Linked: {
									throw new Error("Linked directories are not supported for listing in sync")
								}

								default: {
									throw new Error("Unsupported directory type for listing")
								}
							}
						})

						if (!listResult.success) {
							const unwrappedSdkError = unwrapSdkError(listResult.error)

							if (
								unwrappedSdkError &&
								(unwrappedSdkError.kind() === ErrorKind.FolderNotFound ||
									unwrappedSdkError.kind() === ErrorKind.WrongPassword)
							) {
								parentListings.set(key, null)
							}

							return
						}

						parentListings.set(key, listResult.data)
					})
				)

				// Build byUuid + byName indexes for O(1) lookup during file comparison below.
				const parentListingIndexes = new Map<
					string,
					{
						byUuid: Map<string, File | SharedFile>
						byName: Map<string, File | SharedFile>
					}
				>()

				for (const [key, listing] of parentListings) {
					if (!listing) {
						parentListingIndexes.set(key, {
							byUuid: new Map(),
							byName: new Map()
						})

						continue
					}

					const byUuid = new Map<string, File | SharedFile>()
					const byName = new Map<string, File | SharedFile>()

					for (const f of listing.files) {
						const unwrapped = unwrapFileMeta(f)

						if (!unwrapped.meta) {
							continue
						}

						byUuid.set(unwrapped.file.uuid, f)
						byName.set(unwrapped.meta.name.trim().toLowerCase(), f)
					}

					parentListingIndexes.set(key, {
						byUuid,
						byName
					})
				}

				const parentListingDirIndexes = new Map<
					string,
					{
						byUuid: Map<string, Dir | SharedDir | SharedRootDir>
						byName: Map<string, Dir | SharedDir | SharedRootDir>
					}
				>()

				for (const [key, listing] of parentListings) {
					const byUuid = new Map<string, Dir | SharedDir | SharedRootDir>()
					const byName = new Map<string, Dir | SharedDir | SharedRootDir>()

					if (listing) {
						for (const d of listing.dirs) {
							const unwrapped = unwrapDirMeta(d)

							if (!unwrapped.meta) {
								continue
							}

							byUuid.set(unwrapped.uuid, d)
							byName.set(unwrapped.meta.name.trim().toLowerCase(), d)
						}
					}

					parentListingDirIndexes.set(key, {
						byUuid,
						byName
					})
				}

				if (signal.aborted) {
					return
				}

				await Promise.all([
					...files.map(({ item, parent }) =>
						run(async () => {
							if (signal.aborted) {
								return
							}

							if (
								!item.data.decryptedMeta ||
								(item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile")
							) {
								return
							}

							const dataFile = new FileSystem.File(
								FileSystem.Paths.join(FILES_DIRECTORY.uri, item.data.uuid, item.data.decryptedMeta.name)
							)
							const metaFile = new FileSystem.File(
								FileSystem.Paths.join(FILES_DIRECTORY.uri, item.data.uuid, `${item.data.uuid}.filenmeta`)
							)

							if (!dataFile.exists || !metaFile.exists) {
								if (dataFile.parentDirectory.exists) {
									dataFile.parentDirectory.delete()
								}

								return
							}

							const key = parentCacheKey(parent)

							if (!parentListings.has(key)) {
								return
							}

							const listing = parentListings.get(key)

							if (!listing) {
								if (dataFile.parentDirectory.exists) {
									dataFile.parentDirectory.delete()
								}

								return
							}

							const index = parentListingIndexes.get(key)
							const existingFile = index?.byUuid.get(item.data.uuid)

							if (!existingFile && dataFile.parentDirectory.exists) {
								dataFile.parentDirectory.delete()
							}

							if (existingFile && dataFile.exists && metaFile.exists) {
								const unwrappedFileMeta = unwrapFileMeta(existingFile)

								if (unwrappedFileMeta.meta && unwrappedFileMeta.meta.name !== item.data.decryptedMeta.name) {
									dataFile.rename(unwrappedFileMeta.meta.name)

									atomicWrite(
										metaFile,
										serialize({
											item: unwrappedFileIntoDriveItem(unwrappedFileMeta),
											parent
										} satisfies FileOrDirectoryOfflineMeta)
									)
								}

								if (
									unwrappedFileMeta.meta &&
									normalizeModificationTimestampForComparison(Number(unwrappedFileMeta.meta.modified)) >
										normalizeModificationTimestampForComparison(Number(item.data.decryptedMeta.modified))
								) {
									if (dataFile.parentDirectory.exists) {
										dataFile.parentDirectory.delete()
									}

									this.isItemStoredCache.delete(item.data.uuid)

									if (this.indexCache) {
										delete this.indexCache.files[item.data.uuid]
									}

									await this.storeFile({
										file: unwrappedFileIntoDriveItem(unwrappedFileMeta),
										parent,
										skipIndexUpdate: true,
										signal
									})

									return
								}
							}

							if (existingFile) {
								return
							}

							// UUID gone from remote but a file with the same name exists — likely re-uploaded.
							// Re-store under the new UUID so offline stays in sync.
							let updatedFile: File | SharedFile | undefined = undefined
							const normalizedName = item.data.decryptedMeta.name.trim().toLowerCase()
							const nameMatch = index?.byName.get(normalizedName)

							if (nameMatch) {
								const unwrappedNameMatch = unwrapFileMeta(nameMatch)

								if (unwrappedNameMatch.meta) {
									const nameMatchUuid = unwrappedNameMatch.file.uuid

									if (nameMatchUuid !== item.data.uuid) {
										updatedFile = nameMatch
									}
								}
							}

							if (!updatedFile) {
								return
							}

							await this.storeFile({
								file: unwrappedFileIntoDriveItem(unwrapFileMeta(updatedFile)),
								parent,
								skipIndexUpdate: true,
								signal
							})

							if (dataFile.parentDirectory.exists) {
								dataFile.parentDirectory.delete()
							}
						})
					),
					...topLevelDirectories.map(({ item, parent }) =>
						run(async () => {
							if (signal.aborted) {
								return
							}

							if (!item.data.decryptedMeta) {
								return
							}

							const metaFile = new FileSystem.File(
								FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, item.data.uuid, `${item.data.uuid}.filenmeta`)
							)

							if (!metaFile.exists || metaFile.size === 0) {
								return
							}

							const key = parentCacheKey(parent)

							if (!parentListings.has(key)) {
								return
							}

							const listing = parentListings.get(key)

							if (!listing) {
								if (metaFile.parentDirectory.exists) {
									metaFile.parentDirectory.delete()
								}

								return
							}

							const dirIndex = parentListingDirIndexes.get(key)
							const existingDir = dirIndex?.byUuid.get(item.data.uuid)

							if (!existingDir && metaFile.parentDirectory.exists) {
								metaFile.parentDirectory.delete()
							}

							if (existingDir && metaFile.exists && metaFile.size > 0) {
								const unwrappedRemoteDir = unwrapDirMeta(existingDir)

								if (
									unwrappedRemoteDir.meta &&
									item.data.decryptedMeta &&
									unwrappedRemoteDir.meta.name !== item.data.decryptedMeta.name
								) {
									const existingMeta = await this.readDirectoryMeta(item.data.uuid)

									atomicWrite(
										metaFile,
										serialize({
											item: unwrappedDirIntoDriveItem(unwrappedRemoteDir),
											parent,
											entries: existingMeta?.entries ?? {}
										} satisfies DirectoryOfflineMeta)
									)
								}
							}

							if (!existingDir) {
								const normalizedName = item.data.decryptedMeta.name.trim().toLowerCase()
								const nameMatch = dirIndex?.byName.get(normalizedName)

								if (nameMatch) {
									const unwrappedNameMatch = unwrapDirMeta(nameMatch)

									if (unwrappedNameMatch.meta && unwrappedNameMatch.uuid !== item.data.uuid) {
										await this.storeDirectory({
											directory: unwrappedDirIntoDriveItem(unwrapDirMeta(nameMatch)),
											parent,
											skipIndexUpdate: true,
											signal
										})
									}
								}

								return
							}

							const remoteDir: AnyDirWithContext = (() => {
								switch (item.type) {
									case "directory": {
										return new AnyDirWithContext.Normal(new AnyNormalDir.Dir(item.data))
									}

									case "sharedDirectory": {
										const parentUuid = unwrapParentUuid(item.data.inner.parent)

										if (!parentUuid) {
											throw new Error("Shared directory is missing parent information.")
										}

										const parentDirFromCache = cache.directoryUuidToAnySharedDirWithContext.get(parentUuid)

										if (!parentDirFromCache) {
											throw new Error("Parent directory of shared directory not found in cache.")
										}

										return new AnyDirWithContext.Shared(
											AnySharedDirWithContext.new({
												dir: new AnySharedDir.Dir(item.data),
												shareInfo: parentDirFromCache.shareInfo
											})
										)
									}

									case "sharedRootDirectory": {
										return new AnyDirWithContext.Shared(
											AnySharedDirWithContext.new({
												dir: new AnySharedDir.Root(item.data),
												shareInfo: item.data.sharingRole
											})
										)
									}

									default: {
										throw new Error(`Unsupported directory type: ${item.type}`)
									}
								}
							})()

							const [remoteDirectoryEntries, directoryMetaBytes] = await Promise.all([
								authedSdkClient.listDirRecursiveWithPaths(
									remoteDir,
									{
										onProgress() {
											// Noop
										}
									},
									{
										onErrors() {
											// Noop
										}
									}
								),
								metaFile.text()
							])

							const directoryMeta: DirectoryOfflineMeta = deserialize(directoryMetaBytes)

							if (Object.keys(directoryMeta).length === 0) {
								if (metaFile.parentDirectory.exists) {
									metaFile.parentDirectory.delete()
								}

								return
							}

							const localDirectories = new Map<
								string,
								{
									item: DriveItem
									directory: FileSystem.Directory
								}
							>()
							const localFiles = new Map<
								string,
								{
									item: DriveItem
									file: FileSystem.File
								}
							>()

							for (const path in directoryMeta.entries) {
								const entry = directoryMeta.entries[path]

								if (!entry) {
									continue
								}

								switch (entry.item.type) {
									case "directory":
									case "sharedRootDirectory":
									case "sharedDirectory": {
										const directory = new FileSystem.Directory(
											FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, item.data.uuid, path)
										)

										if (directory.exists) {
											localDirectories.set(path, {
												item: entry.item,
												directory
											})
										}

										break
									}

									case "file":
									case "sharedFile":
									case "sharedRootFile": {
										const file = new FileSystem.File(FileSystem.Paths.join(DIRECTORIES_DIRECTORY, item.data.uuid, path))

										if (file.exists) {
											localFiles.set(path, {
												item: entry.item,
												file
											})
										}

										break
									}
								}
							}

							const remoteFiles = new Map<string, File | SharedFile>()
							const remoteDirectories = new Map<string, Dir | SharedDir | SharedRootDir>()

							for (const { dir, path } of remoteDirectoryEntries.dirs) {
								if (dir.tag === NonRootDir_Tags.Linked) {
									continue
								}

								const normalizedPath = normalizeFilePathForSdk(path)

								remoteDirectories.set(normalizedPath, dir.inner[0])
							}

							for (const { file, path } of remoteDirectoryEntries.files) {
								const normalizedPath = normalizeFilePathForSdk(path)

								remoteFiles.set(normalizedPath, file)
							}

							for (const [path, localDirectory] of localDirectories) {
								const remoteDirectory = remoteDirectories.get(path)

								if (!remoteDirectory && localDirectory && localDirectory.directory.exists) {
									localDirectory.directory.delete()
								}
							}

							// If any file was updated/added/removed in the directory tree, re-download the whole thing.
							let needsFullResync = false

							for (const [path, localFile] of localFiles) {
								const remoteFile = remoteFiles.get(path)

								if (!remoteFile && localFile && localFile.file.exists) {
									localFile.file.delete()

									continue
								}

								if (
									remoteFile &&
									localFile &&
									localFile.item.data.decryptedMeta &&
									(localFile.item.type === "file" ||
										localFile.item.type === "sharedFile" ||
										localFile.item.type === "sharedRootFile")
								) {
									const unwrappedRemoteFile = unwrapFileMeta(remoteFile)

									if (
										unwrappedRemoteFile.meta &&
										normalizeModificationTimestampForComparison(Number(unwrappedRemoteFile.meta.modified)) >
											normalizeModificationTimestampForComparison(
												Number(localFile.item.data.decryptedMeta.modified)
											) &&
										localFile.file.exists
									) {
										localFile.file.delete()

										needsFullResync = true
									}
								}
							}

							for (const [path, remoteDirectory] of remoteDirectories) {
								const localDirectory = localDirectories.get(path)

								if (!localDirectory && remoteDirectory) {
									needsFullResync = true
								}
							}

							for (const [path, remoteFile] of remoteFiles) {
								const localFile = localFiles.get(path)

								if (!localFile && remoteFile) {
									needsFullResync = true
								}
							}

							// force: true bypasses the isItemStored check, since we know it's stored but stale.
							if (needsFullResync) {
								await this.storeDirectory({
									directory: item,
									parent,
									skipIndexUpdate: true,
									force: true,
									signal
								})
							}
						})
					)
				])

				if (signal.aborted) {
					return
				}

				await this.updateIndex()
			},
			{
				throw: true
			}
		)
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

						if (meta.item.type !== "file" && meta.item.type !== "sharedFile" && meta.item.type !== "sharedRootFile") {
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
	}): Promise<void> {
		const result = await run(async defer => {
			if (file.type !== "file" && file.type !== "sharedFile" && file.type !== "sharedRootFile") {
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
				return
			}

			// Skip if this file already exists inside a stored directory tree (overlap guard).
			const uuidToTopLevel = await this.buildUuidToTopLevelIndex()

			if (uuidToTopLevel.has(file.data.uuid)) {
				return
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
				let resolveCompletion!: () => void

				defer(() => {
					resolveCompletion()
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
		force,
		signal
	}: {
		directory: DriveItem
		parent: OfflineParent
		hideProgress?: boolean
		skipIndexUpdate?: boolean
		force?: boolean
		signal?: AbortSignal
	}): Promise<void> {
		const result = await run(async defer => {
			if (directory.type !== "directory" && directory.type !== "sharedDirectory" && directory.type !== "sharedRootDirectory") {
				throw new Error("Item not of type directory")
			}

			if (!directory.data.decryptedMeta) {
				throw new Error("Directory missing decrypted meta")
			}

			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			// Per-UUID lock (outermost of the store locks): serializes the whole guard→delete→download→index
			// section against another store call for the same directory, so neither wipes the other's in-flight target.
			const releaseStoreItemLock = await this.acquireStoreItemLock(directory.data.uuid)

			defer(() => {
				releaseStoreItemLock()
			})

			await this.storeMutex.acquire()

			defer(() => {
				this.storeMutex.release()
			})

			this.ensureDirectories()

			// force skips this check — used by sync() when we know the item is stored but needs re-download.
			if (!force && (await this.isItemStored(directory))) {
				return
			}

			// Skip if this dir is already nested inside another stored directory (but not if it IS a top-level entry).
			const uuidToTopLevel = await this.buildUuidToTopLevelIndex()
			const topLevelUuid = uuidToTopLevel.get(directory.data.uuid)

			if (topLevelUuid && topLevelUuid !== directory.data.uuid) {
				return
			}

			const dataDirectory = new FileSystem.Directory(FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, directory.data.uuid))
			const metaFile = new FileSystem.File(
				FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, directory.data.uuid, `${directory.data.uuid}.filenmeta`)
			)

			if (!dataDirectory.exists) {
				dataDirectory.create({
					intermediates: true,
					idempotent: true
				})
			}

			const innerResult = await run(async defer => {
				let resolveCompletion!: () => void

				defer(() => {
					resolveCompletion()
				})

				const completionPromise = new Promise<void>(resolve => {
					resolveCompletion = resolve
				})

				const transferred = await transfers.download({
					item: directory,
					destination: dataDirectory,
					hideProgress,
					awaitExternalCompletionBeforeMarkingAsFinished: () => completionPromise,
					signal
				})

				if (transferred) {
					const entries: DirectoryOfflineMeta["entries"] = {}

					// Anchor the SDK-returned paths on the directory's UUID rather than
					// slicing by a known prefix. The SDK returns canonical/realpath'd
					// paths (iOS: /private/var/mobile/..., Android: typically already
					// canonical) while dataDirectory.uri returns the platform-specific
					// symlinked form. Lexical prefix comparison can't reconcile that
					// difference and silently corrupts entry keys, which then breaks
					// top-level listing AND traps sync() in a constant re-download loop
					// (localFiles never matches remoteFiles). The UUID anchor is
					// symlink-agnostic — see extractPathInsideUuidDirectory().
					for (const { dir, path } of transferred.directories) {
						if (dir.tag === NonRootDir_Tags.Linked) {
							continue
						}

						const inside = extractPathInsideUuidDirectory(path, directory.data.uuid)

						if (!inside) {
							continue
						}

						const normalizedPath = normalizeFilePathForSdk(inside)

						entries[normalizedPath] = {
							item: unwrappedDirIntoDriveItem(unwrapDirMeta(dir.inner[0]))
						}
					}

					for (const { file, path } of transferred.files) {
						const inside = extractPathInsideUuidDirectory(path, directory.data.uuid)

						if (!inside) {
							continue
						}

						const normalizedPath = normalizeFilePathForSdk(inside)

						entries[normalizedPath] = {
							item: unwrappedFileIntoDriveItem(unwrapFileMeta(file))
						}
					}

					// Overlap dedup: if any entry in this directory tree was previously stored standalone,
					// delete the standalone copy — the directory tree now subsumes it.
					const currentIndex = await this.readIndex()

					for (const entryPath in entries) {
						const entry = entries[entryPath]

						if (!entry) {
							continue
						}

						const entryUuid = entry.item.data.uuid

						if (currentIndex.files[entryUuid]) {
							const standaloneFileDir = new FileSystem.Directory(FileSystem.Paths.join(FILES_DIRECTORY.uri, entryUuid))

							if (standaloneFileDir.exists) {
								standaloneFileDir.delete()
							}
						}

						// Don't delete ourselves — we're storing this directory, not a nested one.
						if (currentIndex.directories[entryUuid] && entryUuid !== directory.data.uuid) {
							const standaloneDirDir = new FileSystem.Directory(FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, entryUuid))

							if (standaloneDirDir.exists) {
								standaloneDirDir.delete()
							}
						}
					}

					// Must invalidate before writing meta — the dedup above changed the filesystem.
					this.invalidateCaches()

					atomicWrite(
						metaFile,
						serialize({
							item: directory,
							parent,
							entries
						} satisfies DirectoryOfflineMeta)
					)

					if (!skipIndexUpdate) {
						await this.updateIndex()
					}
				}
			})

			if (!innerResult.success) {
				if (dataDirectory.exists) {
					dataDirectory.delete()
				}

				throw innerResult.error
			}

			return {
				directory,
				parent,
				dataDirectory,
				metaFile
			}
		})

		if (!result.success) {
			throw result.error
		}
	}

	// Converts a directory DriveItem at the given path into an AnyDirWithContext for SDK calls.
	// Needed because listDirectories returns DriveItems but SDK listing APIs require AnyDirWithContext.
	private findParentAnyDirWithContext(pathToItem: Record<string, DriveItem>, dirname: string): OfflineParent | null {
		const item = pathToItem[dirname]

		if (!item || (item.type !== "directory" && item.type !== "sharedDirectory" && item.type !== "sharedRootDirectory")) {
			return null
		}

		switch (item.type) {
			case "directory": {
				return new AnyDirWithContext.Normal(new AnyNormalDir.Dir(item.data))
			}

			case "sharedDirectory": {
				const parentUuid = unwrapParentUuid(item.data.inner.parent)

				if (!parentUuid) {
					throw new Error("Shared directory is missing parent information.")
				}

				const parentDirFromCache = cache.directoryUuidToAnySharedDirWithContext.get(parentUuid)

				if (!parentDirFromCache) {
					throw new Error("Parent directory of shared directory not found in cache.")
				}

				return new AnyDirWithContext.Shared(
					AnySharedDirWithContext.new({
						dir: new AnySharedDir.Dir(item.data),
						shareInfo: parentDirFromCache.shareInfo
					})
				)
			}

			case "sharedRootDirectory": {
				return new AnyDirWithContext.Shared(
					AnySharedDirWithContext.new({
						dir: new AnySharedDir.Root(item.data),
						shareInfo: item.data.sharingRole
					})
				)
			}
		}
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

					if (
						meta.item.type !== "directory" &&
						meta.item.type !== "sharedDirectory" &&
						meta.item.type !== "sharedRootDirectory"
					) {
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

		for (const path in directoryMeta.entries) {
			const entryMeta = directoryMeta.entries[path]

			if (
				!entryMeta ||
				(entryMeta.item.type !== "directory" &&
					entryMeta.item.type !== "sharedDirectory" &&
					entryMeta.item.type !== "sharedRootDirectory")
			) {
				continue
			}

			const normalizedPath = normalizeFilePathForSdk(path)

			pathToItem[normalizedPath] = entryMeta.item
			uuidToPath[entryMeta.item.data.uuid] = normalizedPath
		}

		const targetPath = uuidToPath[parentUuid]

		if (!targetPath) {
			return {
				files,
				directories
			}
		}

		for (const path in directoryMeta.entries) {
			const entryMeta = directoryMeta.entries[path]

			if (!entryMeta) {
				continue
			}

			let dirname = FileSystem.Paths.dirname(normalizeFilePathForSdk(path))

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

				if (
					directoryMeta.item.type !== "directory" &&
					directoryMeta.item.type !== "sharedDirectory" &&
					directoryMeta.item.type !== "sharedRootDirectory"
				) {
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

				for (const path in directoryMeta.entries) {
					const entryMeta = directoryMeta.entries[path]

					if (
						!entryMeta ||
						(entryMeta.item.type !== "directory" &&
							entryMeta.item.type !== "sharedDirectory" &&
							entryMeta.item.type !== "sharedRootDirectory")
					) {
						continue
					}

					const normalizedPath = normalizeFilePathForSdk(path)

					pathToItem[normalizedPath] = entryMeta.item
				}

				for (const path in directoryMeta.entries) {
					const entryMeta = directoryMeta.entries[path]

					if (!entryMeta) {
						continue
					}

					let dirname = FileSystem.Paths.dirname(normalizeFilePathForSdk(path))

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

				if (
					!fileEntry ||
					(fileEntry.item.type !== "file" && fileEntry.item.type !== "sharedFile" && fileEntry.item.type !== "sharedRootFile")
				) {
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

				for (const path in directoryMeta.entries) {
					const entryMeta = directoryMeta.entries[path]

					if (
						!entryMeta ||
						(entryMeta.item.type !== "directory" &&
							entryMeta.item.type !== "sharedDirectory" &&
							entryMeta.item.type !== "sharedRootDirectory")
					) {
						continue
					}

					uuidToPath[entryMeta.item.data.uuid] = normalizeFilePathForSdk(path)
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

				for (const path in directoryMeta.entries) {
					const entryMeta = directoryMeta.entries[path]

					if (!entryMeta) {
						continue
					}

					let dirname = FileSystem.Paths.dirname(normalizeFilePathForSdk(path))

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

			if (item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile") {
				const parentDirectory = new FileSystem.Directory(FileSystem.Paths.join(FILES_DIRECTORY.uri, item.data.uuid))

				if (parentDirectory.exists) {
					parentDirectory.delete()

					didDelete = true
				}
			} else {
				const { directories: topLevelDirectories } = await this.listDirectories()

				for (const { item: directoryItem } of topLevelDirectories) {
					if (
						directoryItem.type !== "directory" &&
						directoryItem.type !== "sharedDirectory" &&
						directoryItem.type !== "sharedRootDirectory"
					) {
						continue
					}

					if (directoryItem.data.uuid !== item.data.uuid) {
						continue
					}

					// Read meta before deletion to get all nested entries for query invalidation
					const directoryMeta = await this.readDirectoryMeta(directoryItem.data.uuid)

					if (directoryMeta) {
						for (const path in directoryMeta.entries) {
							const entry = directoryMeta.entries[path]

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

	// Looks up a file's local path: first checks standalone files/, then searches inside directory trees.
	public async getLocalFile(item: DriveItem): Promise<FileSystem.File | null> {
		const cachedLocalFile = this.getLocalFileCache.get(item.data.uuid)

		if (cachedLocalFile) {
			return cachedLocalFile
		}

		if (item.type !== "file" && item.type !== "sharedFile" && item.type !== "sharedRootFile") {
			return null
		}

		this.ensureDirectories()

		const index = await this.readIndex()
		const fileEntry = index.files[item.data.uuid]

		if (
			fileEntry &&
			(fileEntry.item.type === "file" || fileEntry.item.type === "sharedFile" || fileEntry.item.type === "sharedRootFile")
		) {
			const file = new FileSystem.File(
				FileSystem.Paths.join(FILES_DIRECTORY.uri, fileEntry.item.data.uuid, fileEntry.item.data.decryptedMeta?.name ?? "")
			)

			if (file.exists) {
				this.getLocalFileCache.set(item.data.uuid, file)

				return file
			}
		}

		// Standalone lookup missed (either no index entry or the file isn't on
		// disk at the standalone path). Fall through to the directory-tree search
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

		for (const path in directoryMeta.entries) {
			const entryMeta = directoryMeta.entries[path]

			if (
				!entryMeta ||
				(entryMeta.item.type !== "file" && entryMeta.item.type !== "sharedFile" && entryMeta.item.type !== "sharedRootFile")
			) {
				continue
			}

			if (entryMeta.item.data.uuid === item.data.uuid) {
				const foundFile = new FileSystem.File(FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, topLevelUuid, path))

				if (foundFile.exists) {
					this.getLocalFileCache.set(item.data.uuid, foundFile)

					return foundFile
				}
			}
		}

		return null
	}

	public async getLocalDirectory(item: DriveItem): Promise<FileSystem.Directory | null> {
		const cachedLocalDir = this.getLocalDirectoryCache.get(item.data.uuid)

		if (cachedLocalDir) {
			return cachedLocalDir
		}

		if (item.type !== "directory" && item.type !== "sharedDirectory" && item.type !== "sharedRootDirectory") {
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

		// Check nested entries
		for (const path in directoryMeta.entries) {
			const entryMeta = directoryMeta.entries[path]

			if (
				!entryMeta ||
				(entryMeta.item.type !== "directory" &&
					entryMeta.item.type !== "sharedDirectory" &&
					entryMeta.item.type !== "sharedRootDirectory")
			) {
				continue
			}

			if (entryMeta.item.data.uuid === item.data.uuid) {
				const foundDirectory = new FileSystem.Directory(FileSystem.Paths.join(DIRECTORIES_DIRECTORY.uri, topLevelUuid, path))

				if (foundDirectory.exists) {
					this.getLocalDirectoryCache.set(item.data.uuid, foundDirectory)

					return foundDirectory
				}
			}
		}

		return null
	}
}

const offline = new Offline()

export default offline
