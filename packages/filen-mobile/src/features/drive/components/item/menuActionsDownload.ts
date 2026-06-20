import { type MenuButton } from "@/components/ui/menu"
import type { DriveItem } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"
import { type TFunction } from "i18next"
import { type PreviewType } from "@/lib/previewType"
import { type OfflineParent } from "@/features/offline/offlineHelpers"
import alerts from "@/lib/alerts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { run } from "@filen/utils"
import * as FileSystem from "expo-file-system"
import transfers from "@/features/transfers/transfers"
import { newTmpDir } from "@/lib/tmp"
import * as MediaLibrary from "expo-media-library/legacy"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import offline from "@/features/offline/offline"
import { appendOfflineSyncErrors } from "@/features/offline/store/useOffline.store"
import { resolveMimeType } from "@/lib/utils"
import { shareTmpFile } from "@/lib/share"
import cache from "@/lib/cache"
import { selectDriveItems } from "@/features/drive/screens/driveSelect"
import { downloadDriveItemToDevice } from "@/features/drive/driveDownload"
import { isFileItem } from "@/features/drive/driveSelectors"
import logger from "@/lib/logger"

// Builds the "Download" submenu buttons (download-to-device / make-available-offline /
// save-to-photos / export / import-into-directory) for a drive item, gated on item type,
// decrypted meta, offline state and preview type. Pure: returns the button list to nest
// under the menu's Download entry.
export function buildDownloadSubButtons({
	item,
	drivePath,
	isStoredOffline,
	parentForOfflineStorage,
	previewType,
	isOwner,
	t
}: {
	item: DriveItem
	drivePath: DrivePath
	isStoredOffline: boolean
	parentForOfflineStorage: OfflineParent | null
	previewType: PreviewType | null
	isOwner: boolean
	t: TFunction
}): MenuButton[] {
	const downloadSubButtons: MenuButton[] = []

	if (
		(item.type === "file" ||
			item.type === "directory" ||
			item.type === "sharedFile" ||
			item.type === "sharedRootFile" ||
			item.type === "sharedDirectory" ||
			item.type === "sharedRootDirectory") &&
		item.data.decryptedMeta
	) {
		downloadSubButtons.push({
			id: "downloadToDevice",
			title: t("download_to_device"),
			icon: "download",
			requiresOnline: true,
			onPress: async () => {
				const result = await downloadDriveItemToDevice({ item })

				if (!result.success) {
					logger.error("drive", "download to device failed", { error: result.error, uuid: item.data.uuid })
					alerts.error(result.error)

					return
				}
			}
		})
	}

	if (parentForOfflineStorage && !isStoredOffline) {
		downloadSubButtons.push({
			id: "makeAvailableOffline",
			requiresOnline: true,
			title: t("make_available_offline"),
			icon: "archive",
			onPress: async () => {
				if (isFileItem(item)) {
					const result = await run(async () => {
						return await offline.storeFile({
							file: item,
							parent: parentForOfflineStorage
						})
					})

					if (!result.success) {
						logger.warn("drive", "make available offline (file) failed", { error: result.error, uuid: item.data.uuid })
						alerts.error(result.error)

						return
					}
				} else {
					const result = await run(async () => {
						return await offline.storeDirectory({
							directory: item,
							parent: parentForOfflineStorage
						})
					})

					if (!result.success) {
						logger.warn("drive", "make available offline (directory) failed", { error: result.error, uuid: item.data.uuid })
						alerts.error(result.error)

						return
					}

					// Degraded warnings (e.g. a remote file whose content is shorter than its
					// metadata claims) mean the store COMMITTED — surface them via the offline
					// error badge/list, since sync passes won't re-warn for an already-recorded
					// observation.
					appendOfflineSyncErrors(result.data.filter(error => error.degraded === true))
				}
			}
		})
	}

	if (isFileItem(item) && (previewType === "image" || previewType === "video") && item.data.decryptedMeta) {
		downloadSubButtons.push({
			id: "saveToPhotos",
			requiresOnline: true,
			title: t("save_to_photos"),
			icon: "image",
			onPress: async () => {
				const permissionsResult = await run(async () => {
					return await hasAllNeededMediaPermissions({ shouldRequest: true, library: "any", needCamera: false })
				})

				if (!permissionsResult.success) {
					logger.warn("drive", "save to photos: media permissions check failed", { error: permissionsResult.error })
					alerts.error(permissionsResult.error)

					return
				}

				if (!permissionsResult.data) {
					alerts.error(t("no_permissions_enable_manually"))

					return
				}

				const result = await runWithLoading(async defer => {
					if (!item.data.decryptedMeta) {
						throw new Error("Missing decrypted metadata")
					}

					const destination = new FileSystem.File(FileSystem.Paths.join(newTmpDir().uri, item.data.decryptedMeta.name))

					defer(() => {
						if (destination.parentDirectory.exists) {
							destination.parentDirectory.delete()
						}
					})

					if (!destination.parentDirectory.exists) {
						destination.parentDirectory.create({
							intermediates: true,
							idempotent: true
						})
					}

					if (destination.exists) {
						destination.delete()
					}

					const result = await transfers.download({
						item,
						destination
					})

					if (!result) {
						return
					}

					await MediaLibrary.saveToLibraryAsync(destination.uri)
				})

				if (!result.success) {
					logger.error("drive", "save to photos failed", { error: result.error, uuid: item.data.uuid })
					alerts.error(result.error)

					return
				}
			}
		})
	}

	if (isFileItem(item) && item.data.decryptedMeta) {
		downloadSubButtons.push({
			id: "export",
			requiresOnline: true,
			title: t("export"),
			icon: "export",
			onPress: async () => {
				const result = await runWithLoading(async () => {
					if (!item.data.decryptedMeta) {
						throw new Error("Missing decrypted metadata")
					}

					const destination = new FileSystem.File(FileSystem.Paths.join(newTmpDir().uri, item.data.decryptedMeta.name))

					if (!destination.parentDirectory.exists) {
						destination.parentDirectory.create({
							intermediates: true,
							idempotent: true
						})
					}

					if (destination.exists) {
						destination.delete()
					}

					const downloadResult = await transfers.download({
						item,
						destination
					})

					if (!downloadResult) {
						return null
					}

					if (
						downloadResult.files.length === 0 ||
						downloadResult.directories.length > 0 ||
						!downloadResult.files[0] ||
						!destination.exists
					) {
						throw new Error("Downloaded item is not a file")
					}

					return destination
				})

				if (!result.success) {
					logger.error("drive", "export download failed", { error: result.error, uuid: item.data.uuid })
					alerts.error(result.error)

					return
				}

				if (!result.data) {
					return
				}

				const shareResult = await shareTmpFile({
					uri: result.data.uri,
					name: result.data.name,
					mimeType: resolveMimeType({ mime: item.data.decryptedMeta?.mime, name: result.data.name }),
					cleanup: () => {
						if (result.data && result.data.parentDirectory.exists) {
							result.data.parentDirectory.delete()
						}
					}
				})

				if (!shareResult.success) {
					logger.warn("drive", "export share sheet failed", { error: shareResult.error })
					alerts.error(shareResult.error)

					return
				}
			}
		})
	}

	if (
		(item.type === "file" ||
			item.type === "directory" ||
			item.type === "sharedFile" ||
			item.type === "sharedRootFile" ||
			item.type === "sharedDirectory" ||
			item.type === "sharedRootDirectory") &&
		item.data.decryptedMeta &&
		(!isOwner || drivePath.type === "linked")
	) {
		downloadSubButtons.push({
			id: "import",
			requiresOnline: true,
			title: t("import"),
			icon: "import",
			onPress: async () => {
				const selectResult = await run(async () => {
					return await selectDriveItems({
						type: "single",
						files: false,
						directories: true,
						items: []
					})
				})

				if (!selectResult.success) {
					logger.warn("drive", "import: drive item select failed", { error: selectResult.error })
					alerts.error(selectResult.error)

					return
				}

				if (selectResult.data.cancelled) {
					return
				}

				const selectedItem = selectResult.data.selectedItems[0]

				if (!selectedItem) {
					return
				}

				const remoteDir = (() => {
					if (selectedItem.type === "root") {
						return selectedItem.data
					}

					const fromCache = cache.directoryUuidToAnyNormalDir.get(selectedItem.data.data.uuid)

					if (!fromCache) {
						return null
					}

					return fromCache
				})()

				if (!remoteDir) {
					return
				}

				const result = await run(async defer => {
					if (!item.data.decryptedMeta) {
						throw new Error("Missing decrypted metadata")
					}

					const destination = isFileItem(item)
						? new FileSystem.File(FileSystem.Paths.join(newTmpDir().uri, item.data.decryptedMeta.name))
						: new FileSystem.Directory(FileSystem.Paths.join(newTmpDir().uri, item.data.decryptedMeta.name))

					// On a partial download/upload the staging copy is deliberately kept (filen-tmp/
					// is reclaimed by the tmp lifecycle anyway) — deleting it would discard the bytes
					// that DID transfer while the alert tells the user something is missing.
					let keepStagingForRetry = false

					defer(() => {
						if (!keepStagingForRetry && destination.parentDirectory.exists) {
							destination.parentDirectory.delete()
						}
					})

					if (!destination.parentDirectory.exists) {
						destination.parentDirectory.create({
							intermediates: true,
							idempotent: true
						})
					}

					if (destination.exists) {
						destination.delete()
					}

					const downloadResult = await transfers.download({
						item,
						destination
					})

					if (!downloadResult) {
						return
					}

					// Directory downloads resolve Ok while per-entry failures arrive only via the SDK's
					// error callbacks — re-uploading an incomplete tree would silently import a hollowed-out
					// copy, so bail before the upload and keep the staging copy.
					if ("errors" in downloadResult && downloadResult.errors.length > 0) {
						keepStagingForRetry = true

						throw new Error(t("import_partial_download", { count: downloadResult.errors.length }))
					}

					const uploadResult = await transfers.upload({
						localFileOrDir: destination,
						parent: remoteDir,
						name: item.data.decryptedMeta.name,
						created: isFileItem(item) && item.data.decryptedMeta.created ? Number(item.data.decryptedMeta.created) : undefined,
						modified:
							isFileItem(item) && item.data.decryptedMeta.modified ? Number(item.data.decryptedMeta.modified) : undefined,
						mime: isFileItem(item) && item.data.decryptedMeta.mime ? item.data.decryptedMeta.mime : undefined
					})

					if (!uploadResult) {
						return
					}

					// Same honesty for the upload leg: a resolved directory upload can still carry
					// per-entry failures.
					if ("errors" in uploadResult && uploadResult.errors.length > 0) {
						keepStagingForRetry = true

						throw new Error(t("import_partial_upload", { count: uploadResult.errors.length }))
					}
				})

				if (!result.success) {
					logger.error("drive", "import failed", { error: result.error, uuid: item.data.uuid })
					alerts.error(result.error)

					return
				}
			}
		})
	}

	return downloadSubButtons
}
