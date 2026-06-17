import { Platform } from "react-native"
import * as FileSystem from "expo-file-system"
import * as ReactNativeBlobUtil from "react-native-blob-util"
import mimeTypes from "mime-types"
import { run, type Result } from "@filen/utils"
import type { DriveItem } from "@/types"
import { listLocalDirectoryRecursive } from "@/lib/utils"
import { normalizeFilePathForBlobUtil } from "@/lib/paths"
import { newTmpDir } from "@/lib/tmp"
import transfers from "@/features/transfers/transfers"
import i18n from "@/lib/i18n"
import logger from "@/lib/logger"

/**
 * Per-item cache of already-completed MediaStore copies.
 *
 * The outer key is the Drive item UUID. The inner Set holds relative entry
 * paths (relative to the staging destination dir) that have already been
 * successfully copied into MediaStore during this app session. This makes
 * `copyToMediaStore` idempotent across retries: if a partial directory
 * download fails and the user retries, the files whose copies already
 * landed in MediaStore are skipped instead of being re-inserted, which
 * would produce duplicate `Download/Filen/<dir>` entries.
 *
 * Limitation: the cache is in-process only. An app restart clears it, so a
 * partial copy followed by a cold-start retry could still produce duplicates.
 * A persistent query-before-insert approach would require a MediaStore query
 * API that `react-native-blob-util` does not expose (its `MediaCollection`
 * surface only provides `copyToMediaStore` / `createMediafile` /
 * `writeToMediafile` — there is no `queryMediaStore` or equivalent).
 *
 * @internal Exported only for test reset (`clearMediaStoreCopiedCache`).
 */
export const _mediaStoreCopiedCache = new Map<string, Set<string>>()

/**
 * Reset the MediaStore deduplication cache.
 * Must be called in `beforeEach` of any test that exercises retry behaviour.
 */
export function clearMediaStoreCopiedCache(): void {
	_mediaStoreCopiedCache.clear()
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

		const isFile = item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile"

		const destination = Platform.select({
			ios: isFile
				? new FileSystem.File(FileSystem.Paths.join(FileSystem.Paths.document, "Downloads", item.data.decryptedMeta.name))
				: new FileSystem.Directory(FileSystem.Paths.join(FileSystem.Paths.document, "Downloads", item.data.decryptedMeta.name)),
			default: isFile
				? new FileSystem.File(FileSystem.Paths.join(newTmpDir().uri, item.data.decryptedMeta.name))
				: new FileSystem.Directory(FileSystem.Paths.join(newTmpDir().uri, item.data.decryptedMeta.name))
		})

		defer(() => {
			if (Platform.OS === "android" && destination.parentDirectory.exists) {
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

		let resolveCompletion: (() => void) | undefined

		const completionPromise = new Promise<void>(resolve => {
			resolveCompletion = resolve
		})

		// Safety net: the transfer entry (notification/floating bar) stays alive until this
		// promise resolves, so it MUST resolve on EVERY exit — abort (null result), a download
		// throw, and the missing-files throw below all skip the MediaStore block whose own defer
		// normally resolves it. Registered before the download starts; resolving twice is a no-op.
		defer(() => {
			resolveCompletion?.()
		})

		const result = await transfers.download({
			item,
			destination,
			awaitExternalCompletionBeforeMarkingAsFinished: () =>
				Platform.select({
					android: completionPromise,
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
				if (!item.data.decryptedMeta) {
					throw new Error("Missing decrypted metadata")
				}

				defer(() => {
					resolveCompletion?.()
				})

				if (isFile && destination instanceof FileSystem.File) {
					// Idempotency key for a single-file download: the item UUID is sufficient
					// since a single-file download always lands under the same name/parentFolder.
					const singleFileKey = `${item.data.uuid}:`

					let copiedSet = _mediaStoreCopiedCache.get(item.data.uuid)

					if (copiedSet === undefined) {
						copiedSet = new Set<string>()
						_mediaStoreCopiedCache.set(item.data.uuid, copiedSet)
					}

					if (!copiedSet.has(singleFileKey)) {
						await ReactNativeBlobUtil.default.MediaCollection.copyToMediaStore(
							{
								name: item.data.decryptedMeta.name,
								parentFolder: "Filen",
								mimeType: item.data.decryptedMeta.mime
							},
							"Download",
							normalizeFilePathForBlobUtil(destination.uri)
						)

						copiedSet.add(singleFileKey)
					}

					return
				}

				if (!isFile && destination instanceof FileSystem.Directory) {
					const entries = listLocalDirectoryRecursive(destination)

					const files = entries.filter(entry => entry instanceof FileSystem.File)

					let copiedSet = _mediaStoreCopiedCache.get(item.data.uuid)

					if (copiedSet === undefined) {
						copiedSet = new Set<string>()
						_mediaStoreCopiedCache.set(item.data.uuid, copiedSet)
					}

					// Capture the reference so the closure below always sees the same Set
					// even if _mediaStoreCopiedCache is mutated on another call concurrently.
					const copiedSetRef = copiedSet

					// Use allSettled so a single failure does not abort sibling copies that are
					// still in flight, and so the defer does not delete the staging dir while a
					// copy is still reading from it.
					const results = await Promise.allSettled(
						files.map(async entry => {
							const normalizedEntryPath = normalizeFilePathForBlobUtil(entry.uri)
							const destinationUriNormalized = normalizeFilePathForBlobUtil(destination.uri)

							// Relative path of this entry inside the destination dir — stable across
							// retries because the source directory structure is always the same.
							const relPath = normalizedEntryPath.slice(destinationUriNormalized.length)

							// Skip files already successfully copied in a prior invocation.
							if (copiedSetRef.has(relPath)) {
								return
							}

							// `entry.name` (already decoded by expo's Paths.basename) and the decrypted
							// plaintext name are passed raw — decoding them again threw URIError on names
							// with a bare "%" (e.g. "50% off.jpg"). The parentFolder segments are
							// different: FileSystem.Paths.join re-encodes them (" " -> "%20", "%" -> "%25"),
							// so they must be decoded back, otherwise files land in literally mis-named
							// directories ("Sub%20Folder"). The per-segment decode is guarded so a malformed
							// sequence falls back to the raw segment instead of throwing.
							const parentFolder = FileSystem.Paths.join(
								"Filen",
								item.data.decryptedMeta?.name ?? item.data.uuid,
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

							await ReactNativeBlobUtil.default.MediaCollection.copyToMediaStore(
								{
									name: entry.name,
									parentFolder: parentFolder.startsWith("/") ? parentFolder.slice(1) : parentFolder,
									mimeType: mimeTypes.lookup(entry.name) || "application/octet-stream"
								},
								"Download",
								normalizedEntryPath
							)

							// Record success so a subsequent retry skips this entry.
							copiedSetRef.add(relPath)
						})
					)

					const failedCount = results.filter(r => r.status === "rejected").length

					if (failedCount > 0) {
						logger.error("drive-download", "MediaStore copy partially failed", { uuid: item.data.uuid, failedCount, total: files.length })
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
