import { DriveEvent_Tags, NonRootItem_Tags, AnyNormalDir_Tags, SocketEvent_Tags, type SocketEvent } from "@filen/sdk-rs"
import {
	driveItemsQueryUpdateGlobal,
	driveItemsQueryUpdate,
	driveItemsQueryUpdateForNormalParent,
	driveItemsQueryUpdateForPhotos,
	driveItemsQueryUpdateForRecents
} from "@/features/drive/queries/useDriveItems.query"
import { unwrapParentUuid, unwrapFileMeta, unwrappedFileIntoDriveItem, unwrapDirMeta, unwrappedDirIntoDriveItem } from "@/lib/sdkUnwrap"
import { keepAgainstIncomingDriveItem } from "@/features/drive/driveSelectors"
import cache from "@/lib/cache"
import useDriveStore from "@/features/drive/store/useDrive.store"
import logger from "@/lib/logger"

export type DriveSocketEvent = Extract<SocketEvent, { tag: typeof SocketEvent_Tags.Drive }>

export async function handleDriveEvent({ event }: { event: DriveSocketEvent }): Promise<void> {
	const [eventInner] = event.inner
	// Captured while the union is intact — the switch below is exhaustive, so `eventInner.inner`
	// narrows to `never` in the default branch, which is kept only as runtime defense against a
	// future SDK tag the pinned bindings don't yet know about.
	const eventTag = eventInner.inner.tag

	switch (eventInner.inner.tag) {
		case DriveEvent_Tags.FileArchiveRestored:
		case DriveEvent_Tags.FileRestore:
		case DriveEvent_Tags.FileNew: {
			const [inner] = eventInner.inner.inner

			const unwrappedParentUuid = unwrapParentUuid(inner.file.parent)
			const unwrappedFileMeta = unwrapFileMeta(inner.file)
			const driveItem = unwrappedFileIntoDriveItem(unwrappedFileMeta)

			// Mirror into persistent caches so useFileUrlQuery /
			// driveItemInfo / etc. resolve the item without a refetch.
			if (driveItem.type === "file") {
				cache.cacheNewFile(inner.file, driveItem)
			}

			if (unwrappedParentUuid) {
				driveItemsQueryUpdateForNormalParent({
					parentUuid: unwrappedParentUuid,
					updater: prev => [
						...prev.filter(i => keepAgainstIncomingDriveItem(i, unwrappedFileMeta.file.uuid, unwrappedFileMeta.meta?.name)),
						driveItem
					]
				})

				// Mirror into the recursive Photos grid too — a SEPARATE virtual-root query from the parent's
				// `drive` listing. Gated by parentUuid so only items actually under the camera-upload root land
				// there (an unrelated file must not be inserted into this recursive query).
				driveItemsQueryUpdateForPhotos({
					parentUuid: unwrappedParentUuid,
					updater: prev => [...prev.filter(i => i.data.uuid !== unwrappedFileMeta.file.uuid), driveItem]
				})
			}

			// Recents (`{ type: "recents", uuid: null }`) holds recently-modified files across the account, so
			// a genuinely NEW file belongs there. A restore leaves mtime unchanged, so it is not surfaced here.
			if (eventInner.inner.tag === DriveEvent_Tags.FileNew) {
				driveItemsQueryUpdateForRecents({
					updater: prev => [...prev.filter(i => i.data.uuid !== unwrappedFileMeta.file.uuid), driveItem]
				})
			}

			if (eventInner.inner.tag === DriveEvent_Tags.FileRestore) {
				// In case of a restore from trash, we need to remove the item from the trash list
				driveItemsQueryUpdate({
					params: {
						path: {
							type: "trash",
							uuid: null
						}
					},
					updater: prev => prev.filter(i => i.data.uuid !== unwrappedFileMeta.file.uuid)
				})
			}

			break
		}

		case DriveEvent_Tags.FileArchived:
		case DriveEvent_Tags.FileDeletedPermanent: {
			const [inner] = eventInner.inner.inner

			// The item left the current listing — purge it from the selection so
			// the count / select-all toggle / bulk ops never target a ghost.
			useDriveStore.getState().removeFromSelection([inner.uuid])

			const fromCache = cache.fileUuidToNormalFile.get(inner.uuid)

			if (fromCache) {
				const unwrappedParentUuid = unwrapParentUuid(fromCache.parent)

				if (unwrappedParentUuid) {
					driveItemsQueryUpdateGlobal({
						parentUuid: unwrappedParentUuid,
						updater: prev => prev.filter(i => i.data.uuid !== fromCache.uuid)
					})
				}
			}

			// Permanent delete — forget all cache entries. FileArchived
			// is NOT a forget (item still exists, just moves to the
			// archive listing — left in cache so it's previewable there).
			if (eventInner.inner.tag === DriveEvent_Tags.FileDeletedPermanent) {
				cache.forgetItem(inner.uuid)
			}

			break
		}

		case DriveEvent_Tags.FolderDeletedPermanent: {
			const [inner] = eventInner.inner.inner

			// The item left the current listing — purge it from the selection so
			// the count / select-all toggle / bulk ops never target a ghost.
			useDriveStore.getState().removeFromSelection([inner.uuid])

			const fromCache = cache.directoryUuidToAnyNormalDir.get(inner.uuid)

			if (fromCache && fromCache.tag === AnyNormalDir_Tags.Dir) {
				const unwrappedParentUuid = unwrapParentUuid(fromCache.inner[0].parent)

				if (unwrappedParentUuid) {
					driveItemsQueryUpdateGlobal({
						parentUuid: unwrappedParentUuid,
						updater: prev => prev.filter(i => i.data.uuid !== fromCache.inner[0].uuid)
					})
				}
			}

			cache.forgetItem(inner.uuid)

			break
		}

		case DriveEvent_Tags.FileMetadataChanged: {
			const [inner] = eventInner.inner.inner

			const fromCache = cache.fileUuidToNormalFile.get(inner.uuid)

			if (!fromCache) {
				// A session-scoped cache miss is routine for items not listed this session; the next
				// listing fetch converges, so these misses are debug, not warnings.
				logger.debug("drive-socket", "FileMetadataChanged: file not in cache, update skipped", { uuid: inner.uuid })
			}

			if (fromCache) {
				const updatedRawFile = {
					...fromCache,
					meta: inner.metadata
				}
				const unwrappedParentUuid = unwrapParentUuid(fromCache.parent)
				const unwrappedFileMeta = unwrapFileMeta(updatedRawFile)
				const driveItem = unwrappedFileIntoDriveItem(unwrappedFileMeta)

				// Sync persistent caches — file metadata changed; downstream
				// readers must see the new shape immediately.
				if (driveItem.type === "file") {
					cache.cacheNewFile(updatedRawFile, driveItem)
				}

				if (unwrappedParentUuid) {
					driveItemsQueryUpdateGlobal({
						parentUuid: unwrappedParentUuid,
						updater: prev => prev.map(i => (i.data.uuid === unwrappedFileMeta.file.uuid ? driveItem : i))
					})
				}
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
			const unwrappedFileMeta = unwrapFileMeta(inner.file)
			const driveItem = unwrappedFileIntoDriveItem(unwrappedFileMeta)

			// Sync persistent caches from the payload — File.parent changed.
			if (driveItem.type === "file") {
				cache.cacheNewFile(inner.file, driveItem)
			}

			if (unwrappedParentUuidOld) {
				driveItemsQueryUpdateForNormalParent({
					parentUuid: unwrappedParentUuidOld,
					updater: prev => prev.filter(i => i.data.uuid !== unwrappedFileMeta.file.uuid)
				})
			}

			if (unwrappedParentUuidNew) {
				driveItemsQueryUpdateForNormalParent({
					parentUuid: unwrappedParentUuidNew,
					updater: prev => [
						...prev.filter(i => keepAgainstIncomingDriveItem(i, unwrappedFileMeta.file.uuid, unwrappedFileMeta.meta?.name)),
						driveItem
					]
				})
			}

			break
		}

		case DriveEvent_Tags.FolderMove: {
			const [inner] = eventInner.inner.inner

			// The payload is the complete new state — write it through + insert at the destination
			// unconditionally, even on a cold cache. Only locating the PREVIOUS listing needs the
			// cached old shape, so that removal stays gated on the cache hit. Read the old shape
			// FIRST: the write-through below overwrites this same cache entry.
			const fromCacheOld = cache.directoryUuidToAnyNormalDir.get(inner.dir.uuid)
			const fromCacheOldDir = fromCacheOld && fromCacheOld.tag === AnyNormalDir_Tags.Dir ? fromCacheOld.inner[0] : null

			if (!fromCacheOldDir) {
				logger.debug("drive-socket", "FolderMove: previous parent not cached, old-listing removal skipped", {
					uuid: inner.dir.uuid
				})
			}

			const unwrappedParentUuidOld = fromCacheOldDir ? unwrapParentUuid(fromCacheOldDir.parent) : null
			const unwrappedParentUuidNew = unwrapParentUuid(inner.dir.parent)
			const unwrappedDirMeta = unwrapDirMeta(inner.dir)
			const driveItem = unwrappedDirIntoDriveItem(unwrappedDirMeta)

			// Sync persistent caches from the payload — Dir.parent changed.
			if (driveItem.type === "directory") {
				cache.cacheNewNormalDir(inner.dir, driveItem)
			}

			if (unwrappedParentUuidOld) {
				driveItemsQueryUpdateForNormalParent({
					parentUuid: unwrappedParentUuidOld,
					updater: prev => prev.filter(i => i.data.uuid !== unwrappedDirMeta.uuid)
				})
			}

			if (unwrappedParentUuidNew) {
				driveItemsQueryUpdateForNormalParent({
					parentUuid: unwrappedParentUuidNew,
					updater: prev => [
						...prev.filter(i => keepAgainstIncomingDriveItem(i, unwrappedDirMeta.uuid, unwrappedDirMeta.meta?.name)),
						driveItem
					]
				})
			}

			break
		}

		case DriveEvent_Tags.FolderMetadataChanged: {
			const [inner] = eventInner.inner.inner

			const fromCache = cache.directoryUuidToAnyNormalDir.get(inner.uuid)

			if (fromCache && fromCache.tag === AnyNormalDir_Tags.Dir) {
				const updatedRawDir = {
					...fromCache.inner[0],
					meta: inner.meta
				}
				const unwrappedParentUuid = unwrapParentUuid(fromCache.inner[0].parent)
				const unwrappedDirMeta = unwrapDirMeta(updatedRawDir)
				const driveItem = unwrappedDirIntoDriveItem(unwrappedDirMeta)

				// Sync persistent caches — dir metadata (name etc.) changed.
				if (driveItem.type === "directory") {
					cache.cacheNewNormalDir(updatedRawDir, driveItem)
				}

				if (unwrappedParentUuid) {
					driveItemsQueryUpdateGlobal({
						parentUuid: unwrappedParentUuid,
						updater: prev => prev.map(i => (i.data.uuid === unwrappedDirMeta.uuid ? driveItem : i))
					})
				}
			}

			break
		}

		case DriveEvent_Tags.FileTrash: {
			const [inner] = eventInner.inner.inner

			// The item left the current listing — purge it from the selection so
			// the count / select-all toggle / bulk ops never target a ghost.
			useDriveStore.getState().removeFromSelection([inner.uuid])

			const fromCache = cache.fileUuidToNormalFile.get(inner.uuid)

			if (fromCache) {
				const unwrappedParentUuid = unwrapParentUuid(fromCache.parent)

				if (unwrappedParentUuid) {
					driveItemsQueryUpdateGlobal({
						parentUuid: unwrappedParentUuid,
						updater: prev => prev.filter(i => i.data.uuid !== fromCache.uuid)
					})
				}

				const item = unwrappedFileIntoDriveItem(unwrapFileMeta(fromCache))

				// Do NOT re-add to recents: the global removal above already
				// removed the item from every listing including recents, which is
				// correct — trashed files must not appear there.
				driveItemsQueryUpdate({
					params: {
						path: {
							type: "trash",
							uuid: null
						}
					},
					updater: prev => [...prev.filter(i => i.data.uuid !== fromCache.uuid), item]
				})
			}

			break
		}

		case DriveEvent_Tags.FolderTrash: {
			const [inner] = eventInner.inner.inner

			// The item left the current listing — purge it from the selection so
			// the count / select-all toggle / bulk ops never target a ghost.
			useDriveStore.getState().removeFromSelection([inner.uuid])

			// The payload's `{ parent, uuid }` is enough to drop the item from its previous listing
			// without the cache. Building the trash-listing ROW still needs the full Dir, so that half
			// stays cache-gated (the `{ parent, uuid }` payload can't reconstruct a DriveItem).
			if (inner.parent) {
				driveItemsQueryUpdateGlobal({
					parentUuid: inner.parent,
					updater: prev => prev.filter(i => i.data.uuid !== inner.uuid)
				})
			}

			const fromCache = cache.directoryUuidToAnyNormalDir.get(inner.uuid)

			if (fromCache && fromCache.tag === AnyNormalDir_Tags.Dir) {
				const item = unwrappedDirIntoDriveItem(unwrapDirMeta(fromCache.inner[0]))

				// Do NOT re-add to recents: the global removal above already
				// removed the item from every listing including recents, which is
				// correct — trashed directories must not appear there (recents is
				// files-only per the server contract).
				driveItemsQueryUpdate({
					params: {
						path: {
							type: "trash",
							uuid: null
						}
					},
					updater: prev => [...prev.filter(i => i.data.uuid !== inner.uuid), item]
				})
			}

			break
		}

		case DriveEvent_Tags.FolderColorChanged: {
			const [inner] = eventInner.inner.inner

			const fromCache = cache.directoryUuidToAnyNormalDir.get(inner.uuid)

			if (fromCache && fromCache.tag === AnyNormalDir_Tags.Dir) {
				const unwrappedParentUuid = unwrapParentUuid(fromCache.inner[0].parent)

				if (unwrappedParentUuid) {
					driveItemsQueryUpdateGlobal({
						parentUuid: unwrappedParentUuid,
						updater: prev =>
							prev.map(i =>
								i.data.uuid === fromCache.inner[0].uuid && i.type === "directory"
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
			}

			break
		}

		case DriveEvent_Tags.FolderRestore:
		case DriveEvent_Tags.FolderSubCreated: {
			const [inner] = eventInner.inner.inner

			const unwrappedParentUuid = unwrapParentUuid(inner.dir.parent)
			const unwrappedDirMeta = unwrapDirMeta(inner.dir)
			const driveItem = unwrappedDirIntoDriveItem(unwrappedDirMeta)

			// Mirror into persistent caches so the new folder is
			// immediately navigable / previewable without a refetch.
			if (driveItem.type === "directory") {
				cache.cacheNewNormalDir(inner.dir, driveItem)
			}

			if (unwrappedParentUuid) {
				driveItemsQueryUpdateForNormalParent({
					parentUuid: unwrappedParentUuid,
					updater: prev => [
						...prev.filter(i => keepAgainstIncomingDriveItem(i, unwrappedDirMeta.uuid, unwrappedDirMeta.meta?.name)),
						driveItem
					]
				})
			}

			if (eventInner.inner.tag === DriveEvent_Tags.FolderRestore) {
				// In case of a restore from trash, we need to remove the item from the trash list
				driveItemsQueryUpdate({
					params: {
						path: {
							type: "trash",
							uuid: null
						}
					},
					updater: prev => prev.filter(i => i.data.uuid !== unwrappedDirMeta.uuid)
				})
			}

			break
		}

		case DriveEvent_Tags.ItemFavorite: {
			const [inner] = eventInner.inner.inner

			switch (inner.item.tag) {
				case NonRootItem_Tags.File: {
					// Route the listing patch via the payload item's own parent — no cache read needed;
					// the map updater no-ops on any listing that doesn't already hold the item.
					const file = inner.item.inner[0]
					const unwrappedParentUuid = unwrapParentUuid(file.parent)
					const unwrappedFileMeta = unwrapFileMeta(file)

					if (unwrappedParentUuid) {
						driveItemsQueryUpdateGlobal({
							parentUuid: unwrappedParentUuid,
							updater: prev =>
								prev.map(i =>
									i.data.uuid === unwrappedFileMeta.file.uuid ? unwrappedFileIntoDriveItem(unwrappedFileMeta) : i
								)
						})
					}

					break
				}

				case NonRootItem_Tags.NormalDir: {
					// Route the listing patch via the payload item's own parent — no cache read needed;
					// the map updater no-ops on any listing that doesn't already hold the item.
					const dir = inner.item.inner[0]
					const unwrappedParentUuid = unwrapParentUuid(dir.parent)
					const unwrappedDirMeta = unwrapDirMeta(dir)

					if (unwrappedParentUuid) {
						driveItemsQueryUpdateGlobal({
							parentUuid: unwrappedParentUuid,
							updater: prev =>
								prev.map(i => (i.data.uuid === unwrappedDirMeta.uuid ? unwrappedDirIntoDriveItem(unwrappedDirMeta) : i))
						})
					}

					break
				}
			}

			break
		}

		case DriveEvent_Tags.TrashEmpty: {
			driveItemsQueryUpdate({
				params: {
					path: {
						type: "trash",
						uuid: null
					}
				},
				updater: () => []
			})

			break
		}

		case DriveEvent_Tags.DeleteAll:
		case DriveEvent_Tags.DeleteVersioned: {
			// These carry no per-item payload a listing patch could apply; ignoring them beats
			// surfacing an error for a routine remote action.
			break
		}

		default: {
			logger.error("drive-socket", "unhandled drive event tag", { tag: eventTag })

			throw new Error("Unhandled drive event")
		}
	}
}
