import { DriveEvent_Tags, NonRootItem_Tags, SocketEvent_Tags, type SocketEvent, type ParentUuid, type File, type Dir } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import {
	driveItemsQueryUpdateGlobal,
	driveItemsQueryUpdateRoot,
	driveItemsQueryUpdateForNormalParent,
	driveItemsQueryUpdateForPhotos,
	driveItemsQueryRemoveDirectoryFromPhotos,
	driveItemsQueryInvalidateAfterDeleteAll,
	driveItemsQueryMarkAllStale
} from "@/features/drive/queries/useDriveItems.query"
import { unwrapParentUuid, unwrapFileMeta, unwrappedFileIntoDriveItem, unwrapDirMeta, unwrappedDirIntoDriveItem } from "@/lib/sdkUnwrap"
import { applyMembershipPatch, upsertItem } from "@filen/shared"
import cache from "@/lib/cache"
import useDriveStore from "@/features/drive/store/useDrive.store"
import { markDirectorySizesStale } from "@/features/drive/queries/useDirectorySize.query"
import socketCreateBatcher from "@/features/drive/socketCreateBatcher"
import {
	clearClipboardAfterDeleteAll,
	dropDriveItem,
	followDriveItem,
	followFileSuccessor,
	heldDriveItem
} from "@/features/drive/clipboardFollow"
import logger from "@/lib/logger"
import events from "@/lib/events"
import { clearDotFilenDirectoryMemo } from "@/lib/dotFilenDirectory"

export type DriveSocketEvent = Extract<SocketEvent, { tag: typeof SocketEvent_Tags.Drive }>

// Renames, colours and favourites leave every directory's size and counts untouched (a content change
// arrives as a new file uuid, not a metadata change).
const SIZE_NEUTRAL_TAGS = new Set<DriveEvent_Tags>([
	DriveEvent_Tags.FileMetadataChanged,
	DriveEvent_Tags.FolderMetadataChanged,
	DriveEvent_Tags.FolderColorChanged,
	DriveEvent_Tags.ItemFavorite
])

// Applied in batches per parent (socketCreateBatcher), which also marks sizes stale once per batch.
const BATCHED_CREATE_TAGS = new Set<DriveEvent_Tags>([DriveEvent_Tags.FileNew, DriveEvent_Tags.FolderSubCreated])

// Any of these may change which directory a fresh listing of the root or ".filen" returns.
const FOLDER_STRUCTURE_TAGS = new Set<DriveEvent_Tags>([
	DriveEvent_Tags.FolderTrash,
	DriveEvent_Tags.FolderMove,
	DriveEvent_Tags.FolderMetadataChanged,
	DriveEvent_Tags.FolderDeletedPermanent,
	DriveEvent_Tags.FolderRestore,
	DriveEvent_Tags.FolderSubCreated,
	DriveEvent_Tags.DeleteAll
])

// A drive event the SDK couldn't read (SocketEvent_Tags.DriveMalformed): some change happened that no
// listing got, so every listing reads again on its next mount.
export function handleDriveMalformedEvent(): void {
	clearDotFilenDirectoryMemo()
	driveItemsQueryMarkAllStale()
	// An open editor, too, can no longer take its file for current: its next save checks.
	events.emit("driveChangesMissed")
}

// The item left its listing: also purged from the selection so the count, select-all toggle and bulk ops
// never target a ghost.
function leaveListings(uuid: string, parentUuid: string | null | undefined): void {
	useDriveStore.getState().removeFromSelection([uuid])

	if (parentUuid) {
		driveItemsQueryUpdateGlobal({
			parentUuid,
			updater: prev => prev.filter(i => i.data.uuid !== uuid)
		})
	}
}

// Route the listing patch via the payload item's own parent — no cache read needed; the map updater
// no-ops on any listing that doesn't already hold the item.
function applyFavoriteEcho(driveItem: DriveItem, parent: ParentUuid, favorited: boolean): void {
	const parentUuid = unwrapParentUuid(parent)

	if (parentUuid) {
		driveItemsQueryUpdateGlobal({
			parentUuid,
			// Same-type only: a role-stamped shared row must not be swapped for the payload's normal-typed rebuild.
			updater: prev => prev.map(i => (i.data.uuid === driveItem.data.uuid && i.type === driveItem.type ? driveItem : i))
		})
	}

	// The Favorites virtual root needs insert/remove semantics the replace-only global patch can't provide:
	// a newly-favorited item isn't a row there yet and an unfavorited one must leave.
	driveItemsQueryUpdateRoot("favorites", prev => applyMembershipPatch(prev, driveItem, favorited))
}

// Builds the row for a raw normal file/directory and writes both through the session caches.
function cacheFile(file: File): DriveItem {
	const driveItem = unwrappedFileIntoDriveItem(unwrapFileMeta(file))

	cache.cacheNewFile(file, driveItem)

	return driveItem
}

function cacheDir(dir: Dir): DriveItem {
	const driveItem = unwrappedDirIntoDriveItem(unwrapDirMeta(dir))

	cache.cacheNewNormalDir(dir, driveItem)

	return driveItem
}

export async function handleDriveEvent({ event }: { event: DriveSocketEvent }): Promise<void> {
	const [eventInner] = event.inner
	// Captured while the union is intact — the switch below is exhaustive, so `eventInner.inner`
	// narrows to `never` in the default branch, which is kept only as runtime defense against a
	// future SDK tag the pinned bindings don't yet know about.
	const eventTag = eventInner.inner.tag

	if (FOLDER_STRUCTURE_TAGS.has(eventTag)) {
		clearDotFilenDirectoryMemo()
	}

	if (!BATCHED_CREATE_TAGS.has(eventTag)) {
		// Queued creates land first, so nothing this event removes, moves or edits is re-added after it.
		socketCreateBatcher.flushNow()

		if (!SIZE_NEUTRAL_TAGS.has(eventTag)) {
			markDirectorySizesStale()
		}
	}

	switch (eventInner.inner.tag) {
		case DriveEvent_Tags.FileNew: {
			const [inner] = eventInner.inner.inner

			const unwrappedParentUuid = unwrapParentUuid(inner.file.parent)
			const driveItem = unwrappedFileIntoDriveItem(unwrapFileMeta(inner.file))

			if (unwrappedParentUuid) {
				socketCreateBatcher.enqueue({
					parentUuid: unwrappedParentUuid,
					item: driveItem,
					recent: true
				})
			} else {
				cache.cacheNewFile(inner.file, driveItem)
			}

			// A content edit arrives as a new file of the same lineage.
			followFileSuccessor(driveItem)
			events.emit("driveFileRevised", { item: driveItem })

			break
		}

		case DriveEvent_Tags.FileArchiveRestored:
		case DriveEvent_Tags.FileRestore: {
			const [inner] = eventInner.inner.inner

			const unwrappedParentUuid = unwrapParentUuid(inner.file.parent)
			// Cached so useFileUrlQuery / driveItemInfo / etc. resolve the item without a refetch.
			const driveItem = cacheFile(inner.file)

			if (unwrappedParentUuid) {
				driveItemsQueryUpdateForNormalParent({
					parentUuid: unwrappedParentUuid,
					updater: prev => upsertItem(prev, driveItem)
				})

				// Mirror into the recursive Photos grid too — a SEPARATE virtual-root query from the parent's
				// `drive` listing. Gated by parentUuid so only items actually under the camera-upload root land
				// there (an unrelated file must not be inserted into this recursive query).
				driveItemsQueryUpdateForPhotos({
					parentUuid: unwrappedParentUuid,
					updater: prev => [...prev.filter(i => i.data.uuid !== inner.file.uuid), driveItem]
				})
			}

			// The restored version takes over from the file's current one.
			if (eventInner.inner.tag === DriveEvent_Tags.FileArchiveRestored) {
				const [archiveRestored] = eventInner.inner.inner

				followDriveItem(archiveRestored.currentUuid, driveItem)
				events.emit("driveFileRevised", { item: driveItem, previousUuid: archiveRestored.currentUuid })
			}

			// A restore leaves mtime unchanged, so it is not surfaced in Recents (a new file is, via the batcher).
			if (eventInner.inner.tag === DriveEvent_Tags.FileRestore) {
				events.emit("driveFileRestored", { uuid: inner.file.uuid, stableUuid: inner.file.stableUuid })

				// In case of a restore from trash, we need to remove the item from the trash list
				driveItemsQueryUpdateRoot("trash", prev => prev.filter(i => i.data.uuid !== inner.file.uuid))
			}

			break
		}

		case DriveEvent_Tags.FileArchived: {
			const [inner] = eventInner.inner.inner

			// Not a forget: the file still exists in the archive listing and stays previewable there.
			const fromCache = cache.fileUuidToNormalFile.get(inner.uuid)

			leaveListings(inner.uuid, fromCache ? unwrapParentUuid(fromCache.parent) : null)

			// Without newUuid another file replaced this one and its lineage ended; with it, the clipboard
			// and an open editor follow the paired FileNew instead.
			if (!inner.newUuid) {
				dropDriveItem(inner.uuid)
				events.emit("driveFileGone", { uuid: inner.uuid, reason: "replaced", stableUuid: fromCache?.stableUuid })
			}

			break
		}

		case DriveEvent_Tags.FileDeletedPermanent: {
			const [inner] = eventInner.inner.inner

			const fromCache = cache.fileUuidToNormalFile.get(inner.uuid)

			leaveListings(inner.uuid, fromCache ? unwrapParentUuid(fromCache.parent) : null)
			cache.forgetItem(inner.uuid)

			// Without a stableUuid only an old version went, not the file.
			if (inner.stableUuid) {
				dropDriveItem(inner.uuid)
				events.emit("driveFileGone", { uuid: inner.uuid, reason: "deleted", stableUuid: inner.stableUuid })
			}

			break
		}

		case DriveEvent_Tags.FolderDeletedPermanent: {
			const [inner] = eventInner.inner.inner

			const fromCache = cache.getNormalDir(inner.uuid)

			leaveListings(inner.uuid, fromCache ? unwrapParentUuid(fromCache.parent) : null)

			driveItemsQueryRemoveDirectoryFromPhotos({
				dirUuid: inner.uuid
			})

			cache.forgetItem(inner.uuid)
			dropDriveItem(inner.uuid)

			break
		}

		case DriveEvent_Tags.FileMetadataChanged: {
			const [inner] = eventInner.inner.inner

			const fromCache = cache.fileUuidToNormalFile.get(inner.uuid)

			if (!fromCache) {
				// A session-scoped cache miss is routine for items not listed this session; the next
				// listing fetch converges, so these misses are debug, not warnings.
				logger.debug("drive-socket", "FileMetadataChanged: file not in cache, update skipped", { uuid: inner.uuid })

				// Uncached but on the clipboard (a search hit, say): it follows from the clipboard's row.
				const held = heldDriveItem(inner.uuid)

				if (held?.type === "file") {
					events.emit("driveItemUpdated", {
						previousUuid: inner.uuid,
						item: unwrappedFileIntoDriveItem(unwrapFileMeta({ ...held.data, meta: inner.metadata }))
					})
				}
			}

			if (fromCache) {
				const unwrappedParentUuid = unwrapParentUuid(fromCache.parent)
				// Cached so downstream readers see the new metadata immediately.
				const driveItem = cacheFile({ ...fromCache, meta: inner.metadata })

				if (unwrappedParentUuid) {
					driveItemsQueryUpdateGlobal({
						parentUuid: unwrappedParentUuid,
						updater: prev => prev.map(i => (i.data.uuid === inner.uuid ? driveItem : i))
					})
				}

				// The clipboard, a search and an open preview follow the new name; the preview's next save
				// writes under it.
				events.emit("driveItemUpdated", { previousUuid: inner.uuid, item: driveItem })
			}

			break
		}

		case DriveEvent_Tags.FileMove: {
			const [inner] = eventInner.inner.inner

			// The payload is the complete new state — write it through + insert at the destination
			// unconditionally, even on a cold cache. Only locating the PREVIOUS listing needs the
			// cached old shape, so that removal stays gated on the cache hit. Read the old shape
			// FIRST: the write-through below overwrites this same cache entry.
			const fromCacheOld = cache.fileUuidToNormalFile.get(inner.file.uuid)

			if (!fromCacheOld) {
				logger.debug("drive-socket", "FileMove: previous parent not cached, old-listing removal skipped", {
					uuid: inner.file.uuid
				})
			}

			const unwrappedParentUuidOld = fromCacheOld ? unwrapParentUuid(fromCacheOld.parent) : null
			const unwrappedParentUuidNew = unwrapParentUuid(inner.file.parent)
			// Cached from the payload: File.parent changed.
			const driveItem = cacheFile(inner.file)

			if (unwrappedParentUuidOld) {
				driveItemsQueryUpdateForNormalParent({
					parentUuid: unwrappedParentUuidOld,
					updater: prev => prev.filter(i => i.data.uuid !== inner.file.uuid)
				})
			}

			if (unwrappedParentUuidNew) {
				driveItemsQueryUpdateForNormalParent({
					parentUuid: unwrappedParentUuidNew,
					updater: prev => upsertItem(prev, driveItem)
				})
			}

			// As a rename: an open preview's next save lands in the new directory.
			events.emit("driveItemUpdated", { previousUuid: inner.file.uuid, item: driveItem })

			break
		}

		case DriveEvent_Tags.FolderMove: {
			const [inner] = eventInner.inner.inner

			// The payload is the complete new state — write it through + insert at the destination
			// unconditionally, even on a cold cache. Only locating the PREVIOUS listing needs the
			// cached old shape, so that removal stays gated on the cache hit. Read the old shape
			// FIRST: the write-through below overwrites this same cache entry.
			const fromCacheOldDir = cache.getNormalDir(inner.dir.uuid)

			if (!fromCacheOldDir) {
				logger.debug("drive-socket", "FolderMove: previous parent not cached, old-listing removal skipped", {
					uuid: inner.dir.uuid
				})
			}

			const unwrappedParentUuidOld = fromCacheOldDir ? unwrapParentUuid(fromCacheOldDir.parent) : null
			const unwrappedParentUuidNew = unwrapParentUuid(inner.dir.parent)
			// Cached from the payload: Dir.parent changed.
			const driveItem = cacheDir(inner.dir)

			if (unwrappedParentUuidOld) {
				driveItemsQueryUpdateForNormalParent({
					parentUuid: unwrappedParentUuidOld,
					updater: prev => prev.filter(i => i.data.uuid !== inner.dir.uuid)
				})
			}

			if (unwrappedParentUuidNew) {
				driveItemsQueryUpdateForNormalParent({
					parentUuid: unwrappedParentUuidNew,
					updater: prev => upsertItem(prev, driveItem)
				})

				driveItemsQueryRemoveDirectoryFromPhotos({
					dirUuid: inner.dir.uuid,
					newParentUuid: unwrappedParentUuidNew,
					previousParentUuid: unwrappedParentUuidOld
				})
			}

			followDriveItem(inner.dir.uuid, driveItem)

			break
		}

		case DriveEvent_Tags.FolderMetadataChanged: {
			const [inner] = eventInner.inner.inner

			const fromCache = cache.getNormalDir(inner.uuid)

			if (fromCache) {
				const unwrappedParentUuid = unwrapParentUuid(fromCache.parent)
				const driveItem = cacheDir({ ...fromCache, meta: inner.meta })

				if (unwrappedParentUuid) {
					driveItemsQueryUpdateGlobal({
						parentUuid: unwrappedParentUuid,
						updater: prev => prev.map(i => (i.data.uuid === inner.uuid ? driveItem : i))
					})
				}

				followDriveItem(inner.uuid, driveItem)
			} else {
				// Uncached but on the clipboard (a search hit, say): it follows from the clipboard's row.
				const held = heldDriveItem(inner.uuid)

				if (held?.type === "directory") {
					followDriveItem(inner.uuid, unwrappedDirIntoDriveItem(unwrapDirMeta({ ...held.data, meta: inner.meta })))
				}
			}

			break
		}

		case DriveEvent_Tags.FileTrash: {
			const [inner] = eventInner.inner.inner

			const fromCache = cache.fileUuidToNormalFile.get(inner.uuid)

			// With newUuid it was an edit (see below), which the clipboard and an open editor follow through the
			// paired FileNew.
			if (!inner.newUuid) {
				dropDriveItem(inner.uuid)
				events.emit("driveFileGone", { uuid: inner.uuid, reason: "trashed", stableUuid: fromCache?.stableUuid })
			}

			leaveListings(inner.uuid, fromCache ? unwrapParentUuid(fromCache.parent) : null)

			if (fromCache) {
				// `newUuid` means this uuid was superseded by an edit on a versioning-disabled account,
				// NOT a user trash action — the server retires the old version through the same event.
				// Dropping the superseded row above is right either way; showing it in Trash is not,
				// and would make every save on such an account look like the file was thrown away.
				if (!inner.newUuid) {
					const item = unwrappedFileIntoDriveItem(unwrapFileMeta(fromCache))

					// Do NOT re-add to recents: the global removal above already
					// removed the item from every listing including recents, which is
					// correct — trashed files must not appear there.
					driveItemsQueryUpdateRoot("trash", prev => [...prev.filter(i => i.data.uuid !== fromCache.uuid), item])
				}
			}

			break
		}

		case DriveEvent_Tags.FolderTrash: {
			const [inner] = eventInner.inner.inner

			dropDriveItem(inner.uuid)

			// The payload's `{ parent, uuid }` is enough to drop the item from its previous listing
			// without the cache. Building the trash-listing ROW still needs the full Dir, so that half
			// stays cache-gated (the `{ parent, uuid }` payload can't reconstruct a DriveItem).
			leaveListings(inner.uuid, inner.parent)

			driveItemsQueryRemoveDirectoryFromPhotos({
				dirUuid: inner.uuid
			})

			const fromCache = cache.getNormalDir(inner.uuid)

			if (fromCache) {
				const item = unwrappedDirIntoDriveItem(unwrapDirMeta(fromCache))

				// Do NOT re-add to recents: the global removal above already
				// removed the item from every listing including recents, which is
				// correct — trashed directories must not appear there (recents is
				// files-only per the server contract).
				driveItemsQueryUpdateRoot("trash", prev => [...prev.filter(i => i.data.uuid !== inner.uuid), item])
			}

			break
		}

		case DriveEvent_Tags.FolderColorChanged: {
			const [inner] = eventInner.inner.inner

			const fromCache = cache.getNormalDir(inner.uuid)

			if (fromCache) {
				const unwrappedParentUuid = unwrapParentUuid(fromCache.parent)
				// The cached Dir keeps the colour too: a later metadata change rebuilds the row from it.
				const driveItem = cacheDir({ ...fromCache, color: inner.color })

				if (unwrappedParentUuid) {
					driveItemsQueryUpdateGlobal({
						parentUuid: unwrappedParentUuid,
						updater: prev =>
							prev.map(i =>
								i.data.uuid === fromCache.uuid && i.type === "directory"
									? {
											...i,
											data: {
												...i.data,
												color: inner.color
											}
										}
									: i
							)
					})
				}

				followDriveItem(inner.uuid, driveItem)
			} else {
				// Uncached but on the clipboard (a search hit, say): it follows from the clipboard's row.
				const held = heldDriveItem(inner.uuid)

				if (held?.type === "directory") {
					followDriveItem(inner.uuid, {
						...held,
						data: {
							...held.data,
							color: inner.color
						}
					})
				}
			}

			break
		}

		case DriveEvent_Tags.FolderSubCreated: {
			const [inner] = eventInner.inner.inner

			const unwrappedParentUuid = unwrapParentUuid(inner.dir.parent)
			const driveItem = unwrappedDirIntoDriveItem(unwrapDirMeta(inner.dir))

			if (unwrappedParentUuid) {
				socketCreateBatcher.enqueue({
					parentUuid: unwrappedParentUuid,
					item: driveItem,
					recent: false
				})
			} else {
				cache.cacheNewNormalDir(inner.dir, driveItem)
			}

			break
		}

		case DriveEvent_Tags.FolderRestore: {
			const [inner] = eventInner.inner.inner

			const unwrappedParentUuid = unwrapParentUuid(inner.dir.parent)
			// Cached so the directory is navigable / previewable without a refetch.
			const driveItem = cacheDir(inner.dir)

			if (unwrappedParentUuid) {
				driveItemsQueryUpdateForNormalParent({
					parentUuid: unwrappedParentUuid,
					updater: prev => upsertItem(prev, driveItem)
				})
			}

			// In case of a restore from trash, we need to remove the item from the trash list
			driveItemsQueryUpdateRoot("trash", prev => prev.filter(i => i.data.uuid !== inner.dir.uuid))

			break
		}

		case DriveEvent_Tags.ItemFavorite: {
			const [inner] = eventInner.inner.inner

			switch (inner.item.tag) {
				case NonRootItem_Tags.File: {
					const file = inner.item.inner[0]

					// Mirror the local favorite() path: write the toggled state through the session
					// caches too, not just the listings.
					applyFavoriteEcho(cacheFile(file), file.parent, file.favorited)

					break
				}

				case NonRootItem_Tags.NormalDir: {
					const dir = inner.item.inner[0]

					applyFavoriteEcho(cacheDir(dir), dir.parent, dir.favorited)

					break
				}
			}

			break
		}

		case DriveEvent_Tags.TrashEmpty: {
			driveItemsQueryUpdateRoot("trash", () => [])

			break
		}

		case DriveEvent_Tags.DeleteAll: {
			// No per-item payload to patch listings with.
			driveItemsQueryInvalidateAfterDeleteAll()
			clearClipboardAfterDeleteAll()

			break
		}

		case DriveEvent_Tags.DeleteVersioned: {
			// Only old versions go, which no listing shows.
			break
		}

		default: {
			logger.error("drive-socket", "unhandled drive event tag", { tag: eventTag })

			throw new Error("Unhandled drive event")
		}
	}
}
