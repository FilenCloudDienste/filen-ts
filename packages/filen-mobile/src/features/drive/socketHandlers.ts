import { DriveEvent_Tags, NonRootItem_Tags, AnyNormalDir_Tags, SocketEvent_Tags, type SocketEvent } from "@filen/sdk-rs"
import { favoritesListingUpdater } from "@/features/drive/driveMetadata"
import {
	driveItemsQueryUpdateGlobal,
	driveItemsQueryUpdate,
	driveItemsQueryUpdateForNormalParent,
	driveItemsQueryUpdateForPhotos,
	driveItemsQueryRemoveDirectoryFromPhotos,
	driveItemsQueryInvalidateAfterDeleteAll,
	driveItemsQueryMarkAllStale
} from "@/features/drive/queries/useDriveItems.query"
import { unwrapParentUuid, unwrapFileMeta, unwrappedFileIntoDriveItem, unwrapDirMeta, unwrappedDirIntoDriveItem } from "@/lib/sdkUnwrap"
import { upsertItem } from "@filen/shared"
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

// A drive event the SDK couldn't read (SocketEvent_Tags.DriveMalformed): some change happened that no
// listing got, so every listing reads again on its next mount.
export function handleDriveMalformedEvent(): void {
	driveItemsQueryMarkAllStale()
}

export async function handleDriveEvent({ event }: { event: DriveSocketEvent }): Promise<void> {
	const [eventInner] = event.inner
	// Captured while the union is intact — the switch below is exhaustive, so `eventInner.inner`
	// narrows to `never` in the default branch, which is kept only as runtime defense against a
	// future SDK tag the pinned bindings don't yet know about.
	const eventTag = eventInner.inner.tag

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
			} else if (driveItem.type === "file") {
				cache.cacheNewFile(inner.file, driveItem)
			}

			// A content edit arrives as a new file of the same lineage.
			followFileSuccessor(driveItem)

			break
		}

		case DriveEvent_Tags.FileArchiveRestored:
		case DriveEvent_Tags.FileRestore: {
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
					updater: prev => upsertItem(prev, driveItem)
				})

				// Mirror into the recursive Photos grid too — a SEPARATE virtual-root query from the parent's
				// `drive` listing. Gated by parentUuid so only items actually under the camera-upload root land
				// there (an unrelated file must not be inserted into this recursive query).
				driveItemsQueryUpdateForPhotos({
					parentUuid: unwrappedParentUuid,
					updater: prev => [...prev.filter(i => i.data.uuid !== unwrappedFileMeta.file.uuid), driveItem]
				})
			}

			// The restored version takes over from the file's current one.
			if (eventInner.inner.tag === DriveEvent_Tags.FileArchiveRestored) {
				const [archiveRestored] = eventInner.inner.inner

				followDriveItem(archiveRestored.currentUuid, driveItem)
			}

			// A restore leaves mtime unchanged, so it is not surfaced in Recents (a new file is, via the batcher).
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

				// Without a stableUuid only an old version went, not the file.
				if (inner.stableUuid) {
					dropDriveItem(inner.uuid)
				}
			} else {
				const [archived] = eventInner.inner.inner

				// Without newUuid another file replaced this one and its lineage ended; with it, the clipboard
				// follows the paired FileNew instead.
				if (!archived.newUuid) {
					dropDriveItem(archived.uuid)
				}
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
					followDriveItem(inner.uuid, unwrappedFileIntoDriveItem(unwrapFileMeta({ ...held.data, meta: inner.metadata })))
				}
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

				followDriveItem(inner.uuid, driveItem)
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
					updater: prev => upsertItem(prev, driveItem)
				})
			}

			followDriveItem(inner.file.uuid, driveItem)

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
					updater: prev => upsertItem(prev, driveItem)
				})

				driveItemsQueryRemoveDirectoryFromPhotos({
					dirUuid: unwrappedDirMeta.uuid,
					newParentUuid: unwrappedParentUuidNew,
					previousParentUuid: unwrappedParentUuidOld
				})
			}

			followDriveItem(inner.dir.uuid, driveItem)

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

			// The item left the current listing — purge it from the selection so
			// the count / select-all toggle / bulk ops never target a ghost.
			useDriveStore.getState().removeFromSelection([inner.uuid])

			// With newUuid it was an edit (see below), which the clipboard follows through the paired FileNew.
			if (!inner.newUuid) {
				dropDriveItem(inner.uuid)
			}

			const fromCache = cache.fileUuidToNormalFile.get(inner.uuid)

			if (fromCache) {
				const unwrappedParentUuid = unwrapParentUuid(fromCache.parent)

				if (unwrappedParentUuid) {
					driveItemsQueryUpdateGlobal({
						parentUuid: unwrappedParentUuid,
						updater: prev => prev.filter(i => i.data.uuid !== fromCache.uuid)
					})
				}

				// `newUuid` means this uuid was superseded by an edit on a versioning-disabled account,
				// NOT a user trash action — the server retires the old version through the same event.
				// Dropping the superseded row above is right either way; showing it in Trash is not,
				// and would make every save on such an account look like the file was thrown away.
				if (!inner.newUuid) {
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
			}

			break
		}

		case DriveEvent_Tags.FolderTrash: {
			const [inner] = eventInner.inner.inner

			// The item left the current listing — purge it from the selection so
			// the count / select-all toggle / bulk ops never target a ghost.
			useDriveStore.getState().removeFromSelection([inner.uuid])
			dropDriveItem(inner.uuid)

			// The payload's `{ parent, uuid }` is enough to drop the item from its previous listing
			// without the cache. Building the trash-listing ROW still needs the full Dir, so that half
			// stays cache-gated (the `{ parent, uuid }` payload can't reconstruct a DriveItem).
			if (inner.parent) {
				driveItemsQueryUpdateGlobal({
					parentUuid: inner.parent,
					updater: prev => prev.filter(i => i.data.uuid !== inner.uuid)
				})
			}

			driveItemsQueryRemoveDirectoryFromPhotos({
				dirUuid: inner.uuid
			})

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
				const updatedRawDir = {
					...fromCache.inner[0],
					color: inner.color
				}
				const driveItem = unwrappedDirIntoDriveItem(unwrapDirMeta(updatedRawDir))

				// The cached Dir keeps the colour too: a later metadata change rebuilds the row from it.
				if (driveItem.type === "directory") {
					cache.cacheNewNormalDir(updatedRawDir, driveItem)
				}

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
			} else if (driveItem.type === "directory") {
				cache.cacheNewNormalDir(inner.dir, driveItem)
			}

			break
		}

		case DriveEvent_Tags.FolderRestore: {
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
					updater: prev => upsertItem(prev, driveItem)
				})
			}

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
					const driveItem = unwrappedFileIntoDriveItem(unwrappedFileMeta)

					// Mirror the local favorite() path: write the toggled state through the session
					// caches too, not just the listings.
					cache.cacheNewFile(file, driveItem)

					if (unwrappedParentUuid) {
						driveItemsQueryUpdateGlobal({
							parentUuid: unwrappedParentUuid,
							updater: prev =>
								prev.map(i =>
									// Same-type only: a role-stamped shared row must not be swapped
									// for the payload's normal-typed rebuild.
									i.data.uuid === unwrappedFileMeta.file.uuid && i.type === driveItem.type ? driveItem : i
								)
						})
					}

					// The Favorites virtual root needs insert/remove semantics the replace-only
					// global patch can't provide: a newly-favorited item isn't a row there yet and
					// an unfavorited one must leave — favoritesListingUpdater (the local path's
					// updater) handles both.
					driveItemsQueryUpdate({
						params: {
							path: {
								type: "favorites",
								uuid: null
							}
						},
						updater: prev => favoritesListingUpdater(prev, driveItem, file.favorited)
					})

					break
				}

				case NonRootItem_Tags.NormalDir: {
					// Route the listing patch via the payload item's own parent — no cache read needed;
					// the map updater no-ops on any listing that doesn't already hold the item.
					const dir = inner.item.inner[0]
					const unwrappedParentUuid = unwrapParentUuid(dir.parent)
					const unwrappedDirMeta = unwrapDirMeta(dir)
					const driveItem = unwrappedDirIntoDriveItem(unwrappedDirMeta)

					// Mirror the local favorite() path: write the toggled state through the session
					// caches too, not just the listings.
					cache.cacheNewNormalDir(dir, driveItem)

					if (unwrappedParentUuid) {
						driveItemsQueryUpdateGlobal({
							parentUuid: unwrappedParentUuid,
							updater: prev =>
								// Same-type only: a role-stamped shared row must not be swapped for
								// the payload's normal-typed rebuild.
								prev.map(i => (i.data.uuid === unwrappedDirMeta.uuid && i.type === driveItem.type ? driveItem : i))
						})
					}

					// Same insert/remove fix-up for the Favorites virtual root as the File arm.
					driveItemsQueryUpdate({
						params: {
							path: {
								type: "favorites",
								uuid: null
							}
						},
						updater: prev => favoritesListingUpdater(prev, driveItem, dir.favorited)
					})

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
