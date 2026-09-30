import { type MenuButton } from "@/components/ui/menu"
import type { DriveItem } from "@/types"
import { type TFunction } from "i18next"
import { type PreviewType } from "@/lib/previewType"
import { type OfflineParent } from "@/features/offline/offlineHelpers"
import alerts from "@/lib/alerts"
import { run } from "@filen/shared"
import { storeItemOffline } from "@/features/offline/storeItem"
import { resolveMimeType } from "@/lib/utils"
import { shareTmpFile } from "@/lib/share"
import { withSystemPresentation } from "@/lib/systemPresentation"
import { normalizeFilePathForSdk } from "@/lib/paths"
import * as ReactNativeBlobUtil from "react-native-blob-util"
import { Platform } from "react-native"
import {
	downloadDriveItemToDevice,
	downloadFileItemToTmp,
	ensureSaveToPhotosPermission,
	saveDriveItemToPhotos
} from "@/features/drive/driveDownload"
import { isFileItem } from "@/features/drive/driveSelectors"
import logger from "@/lib/logger"

// Builds the "Download" submenu buttons (download-to-device / make-available-offline /
// save-to-photos / export) for a drive item, gated on item type,
// decrypted meta, offline state and preview type. Pure: returns the button list to nest
// under the menu's Download entry.
export function buildDownloadSubButtons({
	item,
	isStoredOffline,
	parentForOfflineStorage,
	previewType,
	t
}: {
	item: DriveItem
	isStoredOffline: boolean
	parentForOfflineStorage: OfflineParent | null
	previewType: PreviewType | null
	t: TFunction
}): MenuButton[] {
	const downloadSubButtons: MenuButton[] = []

	if (item.data.decryptedMeta) {
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
				const result = await run(async () => {
					await storeItemOffline({ item, parent: parentForOfflineStorage })
				})

				if (!result.success) {
					logger.warn("drive", "make available offline failed", { error: result.error, uuid: item.data.uuid })
					alerts.error(result.error)
				}
			}
		})
	}

	// Literal types on purpose: "rawImage" is excluded from save-to-photos (product decision — the OS
	// photo libraries accept DNG but not every RAW family, and the app cannot verify per format).
	// The bulk action (driveSelectors.isImageOrVideoExtension) matches.
	if (isFileItem(item) && (previewType === "image" || previewType === "svg" || previewType === "video") && item.data.decryptedMeta) {
		downloadSubButtons.push({
			id: "saveToPhotos",
			requiresOnline: true,
			title: t("save_to_photos"),
			icon: "image",
			onPress: async () => {
				if (!(await ensureSaveToPhotosPermission(t))) {
					return
				}

				// Non-blocking: the download's progress + speed surface in the floating transfer bar
				// (and the Android notification); a full-screen blocking loader would freeze the app on
				// large media and hide that better progress UI. Mirrors "Download to device" / Export.
				const result = await run(async () => {
					await saveDriveItemToPhotos(item)
				})

				if (!result.success) {
					logger.error("drive", "save to photos failed", { error: result.error, uuid: item.data.uuid })
					alerts.error(result.error)
				}
			}
		})
	}

	const exportButton = buildExportButton({ item, id: "export", t })

	if (exportButton) {
		downloadSubButtons.push(exportButton)
	}

	const openWithButton = buildOpenWithButton({ item, id: "openWith", t })

	if (openWithButton) {
		downloadSubButtons.push(openWithButton)
	}

	return downloadSubButtons
}

// Builds the "Export" action — download the file to a temp location, then hand it to the OS share
// sheet — or null when the item isn't an exportable file (directory, or missing decrypted meta).
// The id is supplied by the caller so the same action can appear under both the Download and Share
// submenus: the Menu's unique-id check blanks the whole menu if two buttons share an id, so the two
// call sites pass distinct ids ("export" / "shareExport").
export function buildExportButton({ item, id, t }: { item: DriveItem; id: string; t: TFunction }): MenuButton | null {
	if (!isFileItem(item) || !item.data.decryptedMeta) {
		return null
	}

	return {
		id,
		requiresOnline: true,
		title: t("export"),
		icon: "export",
		onPress: async () => {
			// Run the download non-blocking: progress + speed already surface in the floating transfer
			// bar (and the Android notification) via transfers.download, so a full-screen blocking
			// loader would only freeze the app on large files and hide that better progress UI. The OS
			// share sheet opens once the download resolves. Mirrors the non-blocking "Download to device".
			const result = await run(async () => await downloadFileItemToTmp(item))

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
	}
}

// Builds the "Open with" action — Android only. Downloads the file to a temp location (surfacing the
// normal transfer-progress UI), then hands it to the native app chooser via ACTION_VIEW. iOS omits it:
// its share sheet (Export) already offers "Open in / Copy to app", so a second entry would be identical.
// Read-only by design — ACTION_VIEW grants read access only; round-trip editing belongs to the Documents
// Provider. Returns null on iOS or when the item isn't an openable file. The id is supplied by the caller
// so the action can appear under both the Download and Share submenus (the Menu blanks itself on duplicate
// ids), mirroring Export.
export function buildOpenWithButton({ item, id, t }: { item: DriveItem; id: string; t: TFunction }): MenuButton | null {
	if (Platform.OS !== "android" || !isFileItem(item) || !item.data.decryptedMeta) {
		return null
	}

	return {
		id,
		requiresOnline: true,
		title: t("open_with"),
		icon: "openExternal",
		onPress: async () => {
			// Run the download non-blocking: progress + speed already surface in the floating transfer bar
			// (and the Android notification) via transfers.download, so a full-screen blocking loader would
			// only freeze the app on large files. The native app chooser opens once the download resolves.
			// Mirrors Export, but hands the file to ACTION_VIEW instead of the OS share sheet.
			const result = await run(async () => await downloadFileItemToTmp(item))

			if (!result.success) {
				logger.error("drive", "open with download failed", { error: result.error, uuid: item.data.uuid })
				alerts.error(result.error)

				return
			}

			if (!result.data) {
				return
			}

			// Deliberately NOT deleted after the chooser opens: ACTION_VIEW hands the external app a content
			// URI it reads lazily, so the staged bytes must outlive this handler. filen-tmp/ lives under the
			// OS cache — reclaimed under cache pressure and by the Advanced "Clean up temporary files" sweep.
			const destination = result.data

			// actionViewIntent expects a raw filesystem path (it does `new File(path)` and wraps it through
			// its own FileProvider) — normalizeFilePathForSdk, NOT normalizeFilePathForBlobUtil (which re-adds
			// the file:// scheme). filen-tmp/ lives under the app cache dir, which blob-util's FileProvider
			// cache-path root covers.
			const openResult = await run(async () => {
				// No chooserTitle argument on purpose: passing one makes blob-util wrap the intent in
				// Intent.createChooser(), which returns a fresh ACTION_CHOOSER intent WITHOUT the
				// FLAG_ACTIVITY_NEW_TASK that the underlying ACTION_VIEW intent carries — startActivity()
				// from our (non-Activity) app context then throws. Omitting it keeps the flagged VIEW intent;
				// Android still shows its own "Open with" picker when more than one app can handle the type.
				await withSystemPresentation(() =>
					ReactNativeBlobUtil.default.android.actionViewIntent(
						normalizeFilePathForSdk(destination.uri),
						resolveMimeType({ mime: item.data.decryptedMeta?.mime, name: destination.name })
					)
				)
			})

			if (!openResult.success) {
				logger.warn("drive", "open with intent failed", { error: openResult.error, uuid: item.data.uuid })

				// blob-util rejects with code "ENOAPP" when no installed app can handle the MIME type — the
				// one expected, user-actionable failure. Surface a friendly message for it; anything else
				// (unexpected) shows the raw error.
				const noApp =
					typeof openResult.error === "object" &&
					openResult.error !== null &&
					"code" in openResult.error &&
					openResult.error.code === "ENOAPP"

				alerts.error(noApp ? t("no_app_to_open_file") : openResult.error)

				return
			}
		}
	}
}
