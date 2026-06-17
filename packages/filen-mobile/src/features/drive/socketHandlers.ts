import { DriveEvent_Tags, NonRootItem_Tags, AnyNormalDir_Tags, SocketEvent_Tags, type SocketEvent } from "@filen/sdk-rs"
import {
	driveItemsQueryUpdateGlobal,
	driveItemsQueryUpdate,
	driveItemsQueryUpdateForNormalParent
} from "@/features/drive/queries/useDriveItems.query"
import { unwrapParentUuid, unwrapFileMeta, unwrappedFileIntoDriveItem, unwrapDirMeta, unwrappedDirIntoDriveItem } from "@/lib/sdkUnwrap"
import cache from "@/lib/cache"
import useDriveStore from "@/features/drive/store/useDrive.store"
import logger from "@/lib/logger"

export type DriveSocketEvent = Extract<SocketEvent, { tag: typeof SocketEvent_Tags.Drive }>

export async function handleDriveEvent({ event }: { event: DriveSocketEvent }): Promise<void> {
	const [eventInner] = event.inner

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
						...prev.filter(
							i =>
								i.data.uuid !== unwrappedFileMeta.file.uuid &&
								i.data.decryptedMeta?.name.toLowerCase().trim() !== unwrappedFileMeta.meta?.name.toLowerCase().trim()
						),
						driveItem
					]
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
				logger.warn("drive-socket", "FileMetadataChanged: file not in cache, update skipped", { uuid: inner.uuid })
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

			const fromCacheOld = cache.fileUuidToNormalFile.get(inner.file.uuid)

			if (!fromCacheOld) {
				logger.warn("drive-socket", "FileMove: file not in cache, listing not updated", { uuid: inner.file.uuid })
			}

			if (fromCacheOld) {
				const unwrappedParentUuidOld = unwrapParentUuid(fromCacheOld.parent)
				const unwrappedParentUuidNew = unwrapParentUuid(inner.file.parent)
				const unwrappedFileMeta = unwrapFileMeta(inner.file)
				const driveItem = unwrappedFileIntoDriveItem(unwrappedFileMeta)

				// Sync persistent caches — File.parent changed.
				if (driveItem.type === "file") {
					cache.cacheNewFile(inner.file, driveItem)
				}

				if (unwrappedParentUuidNew && unwrappedParentUuidOld) {
					driveItemsQueryUpdateForNormalParent({
						parentUuid: unwrappedParentUuidOld,
						updater: prev => prev.filter(i => i.data.uuid !== fromCacheOld.uuid)
					})

					driveItemsQueryUpdateForNormalParent({
						parentUuid: unwrappedParentUuidNew,
						updater: prev => [
							...prev.filter(
								i =>
									i.data.uuid !== unwrappedFileMeta.file.uuid &&
									i.data.decryptedMeta?.name.toLowerCase().trim() !== unwrappedFileMeta.meta?.name.toLowerCase().trim()
							),
							driveItem
						]
					})
				}
			}

			break
		}

		case DriveEvent_Tags.FolderMove: {
			const [inner] = eventInner.inner.inner

			const fromCacheOld = cache.directoryUuidToAnyNormalDir.get(inner.dir.uuid)

			if (!fromCacheOld) {
				logger.warn("drive-socket", "FolderMove: directory not in cache, listing not updated", { uuid: inner.dir.uuid })
			}

			if (fromCacheOld && fromCacheOld.tag === AnyNormalDir_Tags.Dir) {
				const unwrappedParentUuidOld = unwrapParentUuid(fromCacheOld.inner[0].parent)
				const unwrappedParentUuidNew = unwrapParentUuid(inner.dir.parent)
				const unwrappedDirMeta = unwrapDirMeta(inner.dir)
				const driveItem = unwrappedDirIntoDriveItem(unwrappedDirMeta)

				// Sync persistent caches — Dir.parent changed.
				if (driveItem.type === "directory") {
					cache.cacheNewNormalDir(inner.dir, driveItem)
				}

				if (unwrappedParentUuidNew && unwrappedParentUuidOld) {
					driveItemsQueryUpdateForNormalParent({
						parentUuid: unwrappedParentUuidOld,
						updater: prev => prev.filter(i => i.data.uuid !== fromCacheOld.inner[0].uuid)
					})

					driveItemsQueryUpdateForNormalParent({
						parentUuid: unwrappedParentUuidNew,
						updater: prev => [
							...prev.filter(
								i =>
									i.data.uuid !== unwrappedDirMeta.uuid &&
									i.data.decryptedMeta?.name.toLowerCase().trim() !== unwrappedDirMeta.meta?.name.toLowerCase().trim()
							),
							driveItem
						]
					})
				}
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

			const fromCache = cache.directoryUuidToAnyNormalDir.get(inner.uuid)

			if (fromCache && fromCache.tag === AnyNormalDir_Tags.Dir) {
				const unwrappedParentUuid = unwrapParentUuid(fromCache.inner[0].parent)

				if (unwrappedParentUuid) {
					driveItemsQueryUpdateGlobal({
						parentUuid: unwrappedParentUuid,
						updater: prev => prev.filter(i => i.data.uuid !== fromCache.inner[0].uuid)
					})
				}

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
					updater: prev => [...prev.filter(i => i.data.uuid !== fromCache.inner[0].uuid), item]
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
						...prev.filter(
							i =>
								i.data.uuid !== unwrappedDirMeta.uuid &&
								i.data.decryptedMeta?.name.toLowerCase().trim() !== unwrappedDirMeta.meta?.name.toLowerCase().trim()
						),
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
					const fromCache = cache.fileUuidToNormalFile.get(inner.item.inner[0].uuid)

					if (fromCache) {
						const unwrappedParentUuid = unwrapParentUuid(fromCache.parent)
						const unwrappedFileMeta = unwrapFileMeta(inner.item.inner[0])

						if (unwrappedParentUuid) {
							driveItemsQueryUpdateGlobal({
								parentUuid: unwrappedParentUuid,
								updater: prev =>
									prev.map(i =>
										i.data.uuid === unwrappedFileMeta.file.uuid ? unwrappedFileIntoDriveItem(unwrappedFileMeta) : i
									)
							})
						}
					}

					break
				}

				case NonRootItem_Tags.NormalDir: {
					const fromCache = cache.directoryUuidToAnyNormalDir.get(inner.item.inner[0].uuid)

					if (fromCache && fromCache.tag === AnyNormalDir_Tags.Dir) {
						const unwrappedParentUuid = unwrapParentUuid(fromCache.inner[0].parent)
						const unwrappedDirMeta = unwrapDirMeta(inner.item.inner[0])

						if (unwrappedParentUuid) {
							driveItemsQueryUpdateGlobal({
								parentUuid: unwrappedParentUuid,
								updater: prev =>
									prev.map(i => (i.data.uuid === unwrappedDirMeta.uuid ? unwrappedDirIntoDriveItem(unwrappedDirMeta) : i))
							})
						}
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

		default: {
			logger.error("drive-socket", "unhandled drive event tag", { tag: eventInner.inner.tag })

			throw new Error("Unhandled drive event")
		}
	}
}
