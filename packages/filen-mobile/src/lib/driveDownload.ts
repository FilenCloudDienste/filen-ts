import { Platform } from "react-native"
import * as FileSystem from "expo-file-system"
import * as ReactNativeBlobUtil from "react-native-blob-util"
import mimeTypes from "mime-types"
import { run } from "@filen/utils"
import type { DriveItem } from "@/types"
import { listLocalDirectoryRecursive, normalizeFilePathForBlobUtil } from "@/lib/utils"
import { newTmpDir } from "@/lib/tmp"
import transfers from "@/lib/transfers"

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

		const result = await transfers.download({
			item,
			destination
		})

		if (!result) {
			return
		}

		if (Platform.OS === "android") {
			if (isFile && destination instanceof FileSystem.File) {
				await ReactNativeBlobUtil.default.MediaCollection.copyToMediaStore(
					{
						name: decodeURIComponent(item.data.decryptedMeta.name),
						parentFolder: "Filen",
						mimeType: item.data.decryptedMeta.mime
					},
					"Download",
					destination.uri
				)

				return
			}

			if (!isFile && destination instanceof FileSystem.Directory) {
				const entries = listLocalDirectoryRecursive(destination)

				await Promise.all(
					entries.map(async entry => {
						if (entry instanceof FileSystem.Directory) {
							return
						}

						const normalizedEntryPath = normalizeFilePathForBlobUtil(entry.uri)
						const destinationUriNormalized = normalizeFilePathForBlobUtil(destination.uri)

						const parentFolder = FileSystem.Paths.join(
							"Filen",
							item.data.decryptedMeta?.name ?? item.data.uuid,
							FileSystem.Paths.dirname(normalizedEntryPath.slice(destinationUriNormalized.length))
						)
							.split("/")
							.map(segment => (segment.length > 0 ? decodeURIComponent(segment) : segment))
							.join("/")

						await ReactNativeBlobUtil.default.MediaCollection.copyToMediaStore(
							{
								name: decodeURIComponent(entry.name),
								parentFolder: parentFolder.startsWith("/") ? parentFolder.slice(1) : parentFolder,
								mimeType: mimeTypes.lookup(decodeURIComponent(entry.name)) || "application/octet-stream"
							},
							"Download",
							normalizedEntryPath
						)
					})
				)
			}
		}
	})
}
