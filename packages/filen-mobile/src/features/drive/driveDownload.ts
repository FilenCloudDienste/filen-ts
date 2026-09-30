import { Platform } from "react-native"
import * as FileSystem from "expo-file-system"
import * as ReactNativeBlobUtil from "react-native-blob-util"
import * as MediaLibrary from "expo-media-library/legacy"
import mimeTypes from "mime-types"
import { type TFunction } from "i18next"
import { run, runOrThrow, type Result, driveItemName } from "@filen/shared"
import type { DriveItem } from "@/types"
import { ensureDirectory, listLocalDirectoryRecursive } from "@/lib/fsUtils"
import { normalizeFilePathForBlobUtil } from "@/lib/paths"
import { newTmpDir, newTmpStagedFile } from "@/lib/tmp"
import { createCompletionGate } from "@/lib/completionGate"
import { isFileItem } from "@/features/drive/driveSelectors"
import transfers from "@/features/transfers/transfers"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import alerts from "@/lib/alerts"
import i18n from "@/lib/i18n"
import logger from "@/lib/logger"

/**
 * Remove an existing public copy at the target path before re-inserting (#86).
 *
 * MediaStore inserts never overwrite — they auto-rename ("name (1)"), so every copy must be
 * preceded by removing the previous copy or re-downloads duplicate forever. Under scoped
 * storage the app can stat and unlink its OWN contributed media by direct path (the normal
 * case: we created these files); files owned by another app or a previous install are
 * invisible to the FUSE view, so the unlink no-ops and the subsequent insert auto-renames —
 * the Android-conventional outcome. Best-effort by design: a failed unlink must never block
 * the copy (fresh content beats duplicate-avoidance), it only logs.
 *
 * Replace-then-copy (matching iOS' delete-then-write into its own sandbox) is deliberately
 * NOT skip-when-exists: Filen rotates file uuids on content change, so re-downloading an
 * edited file is a normal flow — skipping would silently keep serving the stale local copy.
 * This also subsumes retry idempotency persistently (the previous in-process session cache
 * lost its memory on app restart and, worse, skipped the copy entirely after the user
 * deleted the file from Downloads — the transfer reported success with no file recreated).
 */
async function removeExistingPublicCopy(relativePath: string): Promise<void> {
	const publicPath = `${ReactNativeBlobUtil.default.fs.dirs.LegacyDownloadDir}/${relativePath}`

	try {
		if (await ReactNativeBlobUtil.default.fs.exists(publicPath)) {
			await ReactNativeBlobUtil.default.fs.unlink(publicPath)
		}
	} catch (e) {
		logger.warn("drive-download", "Could not remove existing public copy before re-copy; MediaStore may auto-rename", {
			relativePath,
			error: e
		})
	}
}

async function copyToPublicDownloads({
	name,
	parentFolder,
	mimeType,
	sourceUri
}: {
	name: string
	parentFolder: string
	mimeType: string
	sourceUri: string
}): Promise<void> {
	await removeExistingPublicCopy(`${parentFolder}/${name}`)

	await ReactNativeBlobUtil.default.MediaCollection.copyToMediaStore(
		{
			name,
			parentFolder,
			mimeType
		},
		"Download",
		sourceUri
	)
}

/**
 * Download a single Drive item (file or directory) to the device's downloads
 * area. Encapsulates the platform-specific destination + post-download
 * MediaStore copy on Android. Used by both the single-item context-menu
 * action and the bulk Download action.
 *
 * Returns a Result<void, Error> via `run()`. Throws nothing.
 */
export async function downloadDriveItemToDevice({ item }: { item: DriveItem }): Promise<ReturnType<typeof run<void>>> {
	return await run<void>(async defer => {
		if (!item.data.decryptedMeta) {
			throw new Error("Missing decrypted metadata")
		}

		const { name } = item.data.decryptedMeta
		// Only a file has a mime of its own; a directory's entries resolve theirs by name.
		const fileMime = isFileItem(item) ? item.data.decryptedMeta.mime : null
		const path = FileSystem.Paths.join(
			Platform.OS === "ios" ? FileSystem.Paths.join(FileSystem.Paths.document, "Downloads") : newTmpDir().uri,
			name
		)
		const destination = fileMime === null ? new FileSystem.Directory(path) : new FileSystem.File(path)

		defer(() => {
			if (Platform.OS === "android" && destination.parentDirectory.exists) {
				destination.parentDirectory.delete()
			}
		})

		ensureDirectory(destination.parentDirectory)

		if (destination.exists) {
			destination.delete()
		}

		const gate = createCompletionGate()

		// Safety net: abort (null result), a download throw and the missing-files throw below all
		// skip the MediaStore block whose own defer normally opens the gate.
		defer(gate.open)

		const result = await transfers.download({
			item,
			destination,
			awaitExternalCompletionBeforeMarkingAsFinished: () =>
				Platform.select({
					android: gate.wait(),
					default: Promise.resolve()
				})
		})

		if (!result) {
			return
		}

		// Per-entry download failures (directory downloads resolve Ok and report them only via
		// the SDK's error callbacks). The throw is deferred to AFTER the Android MediaStore block
		// so everything that DID download still gets copied to Downloads first.
		const missingFileCount = "errors" in result ? result.errors.length : 0

		let mediaStoreCopyResult: Result<void> | null = null

		if (Platform.OS === "android") {
			mediaStoreCopyResult = await run<void>(async defer => {
				defer(gate.open)

				if (fileMime !== null && destination instanceof FileSystem.File) {
					await copyToPublicDownloads({
						name,
						parentFolder: "Filen",
						mimeType: fileMime,
						sourceUri: normalizeFilePathForBlobUtil(destination.uri)
					})

					return
				}

				if (destination instanceof FileSystem.Directory) {
					const entries = listLocalDirectoryRecursive(destination)

					const files = entries.filter(entry => entry instanceof FileSystem.File)

					// Use allSettled so a single failure does not abort sibling copies that are
					// still in flight, and so the defer does not delete the staging dir while a
					// copy is still reading from it.
					const results = await Promise.allSettled(
						files.map(async entry => {
							const normalizedEntryPath = normalizeFilePathForBlobUtil(entry.uri)
							const destinationUriNormalized = normalizeFilePathForBlobUtil(destination.uri)

							// Relative path of this entry inside the destination dir — drives the
							// public Download/ path (parentFolder) for this entry.
							const relPath = normalizedEntryPath.slice(destinationUriNormalized.length)

							// `entry.name` (already decoded by expo's Paths.basename) and the decrypted
							// plaintext name are passed raw — decoding them again threw URIError on names
							// with a bare "%" (e.g. "50% off.jpg"). The parentFolder segments are
							// different: FileSystem.Paths.join re-encodes them (" " -> "%20", "%" -> "%25"),
							// so they must be decoded back, otherwise files land in literally mis-named
							// directories ("Sub%20Folder"). The per-segment decode is guarded so a malformed
							// sequence falls back to the raw segment instead of throwing.
							const parentFolder = FileSystem.Paths.join(
								"Filen",
								driveItemName(item),
								FileSystem.Paths.dirname(relPath)
							)
								.split("/")
								.map(segment => {
									if (segment.length === 0) {
										return segment
									}

									try {
										return decodeURIComponent(segment)
									} catch {
										return segment
									}
								})
								.join("/")

							const normalizedParentFolder = parentFolder.startsWith("/") ? parentFolder.slice(1) : parentFolder

							// Replace-then-copy per entry (see removeExistingPublicCopy): keeps retries
							// duplicate-free WITHOUT the old session cache, and recreates entries the
							// user deleted from Downloads.
							await copyToPublicDownloads({
								name: entry.name,
								parentFolder: normalizedParentFolder,
								mimeType: mimeTypes.lookup(entry.name) || "application/octet-stream",
								sourceUri: normalizedEntryPath
							})
						})
					)

					const failedCount = results.filter(r => r.status === "rejected").length

					if (failedCount > 0) {
						logger.error("drive-download", "MediaStore copy partially failed", {
							uuid: item.data.uuid,
							failedCount,
							total: files.length
						})
						throw new Error(i18n.t("download_partial_failure", { failed: failedCount, total: files.length }))
					}
				}
			})
		}

		// One alert per run, root cause first: files the SDK never downloaded outrank a
		// (secondary) MediaStore copy failure of the files that DID download — a retry
		// surfaces whatever failure class remains.
		if (missingFileCount > 0) {
			logger.error("drive-download", "directory download incomplete: some files missing", { uuid: item.data.uuid, missingFileCount })
			throw new Error(i18n.t("download_missing_files", { count: missingFileCount }))
		}

		// Propagate the MediaStore copy failure — without this rethrow, run() silently
		// swallows the aggregated partial-failure error into its discarded Result.
		if (mediaStoreCopyResult && !mediaStoreCopyResult.success) {
			throw mediaStoreCopyResult.error
		}
	})
}

// Requests photo-library write access for save-to-photos. Alerts and returns false when the
// action must not proceed.
export async function ensureSaveToPhotosPermission(t: TFunction): Promise<boolean> {
	const result = await run(async () => {
		return await hasAllNeededMediaPermissions({ shouldRequest: true, library: "any", needCamera: false })
	})

	if (!result.success) {
		logger.warn("drive-download", "save to photos: media permissions check failed", { error: result.error })
		alerts.error(result.error)

		return false
	}

	if (!result.data) {
		alerts.error(t("no_permissions_enable_manually"))

		return false
	}

	return true
}

// Stages the file in a fresh tmp directory, downloads it and saves it to the OS photo library.
// Returns quietly on abort, throws on failure.
export async function saveDriveItemToPhotos(item: DriveItem): Promise<void> {
	await runOrThrow(async defer => {
		if (!item.data.decryptedMeta) {
			throw new Error("Missing decrypted metadata")
		}

		const destination = newTmpStagedFile(item.data.decryptedMeta.name)

		defer(() => {
			if (destination.parentDirectory.exists) {
				destination.parentDirectory.delete()
			}
		})

		if (!(await transfers.download({ item, destination }))) {
			return
		}

		await MediaLibrary.saveToLibraryAsync(destination.uri)
	})
}

// Stages a single file in a fresh tmp directory and downloads it there. Returns null on abort,
// throws on failure. The caller owns deleting the staging directory.
export async function downloadFileItemToTmp(item: DriveItem): Promise<FileSystem.File | null> {
	if (!item.data.decryptedMeta) {
		throw new Error("Missing decrypted metadata")
	}

	const destination = newTmpStagedFile(item.data.decryptedMeta.name)
	const downloadResult = await transfers.download({
		item,
		destination
	})

	if (!downloadResult) {
		return null
	}

	if (downloadResult.files.length === 0 || downloadResult.directories.length > 0 || !downloadResult.files[0] || !destination.exists) {
		throw new Error("Downloaded item is not a file")
	}

	return destination
}
