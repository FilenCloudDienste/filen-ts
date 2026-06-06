import * as FileSystem from "expo-file-system"
import * as ImageManipulator from "expo-image-manipulator"
import { AnyFile, ManagedFuture } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { normalizeFilePathForExpo, normalizeFilePathForSdk } from "@/lib/paths"
import { wrapAbortSignalForSdk } from "@/lib/signals"
import { run } from "@filen/utils"
import auth from "@/lib/auth"
import offline from "@/features/offline/offline"
import fileCache from "@/lib/fileCache"
import { randomUUID } from "expo-crypto"
import { onlineManager } from "@tanstack/react-query"
import { THUMBNAILS_DIRECTORY as DIRECTORY } from "@/lib/storageRoots"
import { abortError, OfflineAbortError, getExtension } from "@/lib/thumbnailsHelpers"

export async function generateImage(
	params: {
		outputPath: string
		width: number
		quality: number
		signal?: AbortSignal
	} & (
		| {
				localSourcePath: string
		  }
		| {
				file: AnyFile
				item: DriveItem
		  }
	)
): Promise<void> {
	const result = await run(async defer => {
		let sourcePath: string

		if ("localSourcePath" in params) {
			sourcePath = params.localSourcePath
		} else {
			const offlineFile = await offline.getLocalFile(params.item)

			if (offlineFile?.exists) {
				sourcePath = normalizeFilePathForExpo(offlineFile.uri)
			} else if (
				await fileCache.has({
					type: "drive",
					data: params.item
				})
			) {
				const cachedFile = await fileCache.get({
					item: {
						type: "drive",
						data: params.item
					},
					signal: params.signal
				})

				sourcePath = normalizeFilePathForExpo(cachedFile.uri)
			} else {
				// Source is in neither offline-store nor file-cache; without network
				// we can't fetch it. Throw an abort-flavoured error so the catch
				// block (line ~671) treats it as aborted, NOT as a real failure —
				// otherwise the 3-strike `failures` map would permanently skip the
				// item even after we come back online.
				if (!onlineManager.isOnline()) {
					throw new OfflineAbortError()
				}

				const { authedSdkClient } = await auth.getSdkClients()
				const tempDir = new FileSystem.Directory(FileSystem.Paths.join(DIRECTORY.uri, `thumb_tmp_${randomUUID()}`))

				defer(() => {
					if (tempDir.exists) {
						tempDir.delete()
					}
				})

				if (!tempDir.exists) {
					tempDir.create({
						idempotent: true,
						intermediates: true
					})
				}

				const ext = getExtension(params.item)

				if (!ext) {
					throw new Error("File has no extension")
				}

				const tempPath = FileSystem.Paths.join(tempDir.uri, `source${ext}`)
				const wrappedSignal = params.signal ? wrapAbortSignalForSdk(params.signal) : undefined

				await authedSdkClient.downloadFileToPath(
					params.file,
					normalizeFilePathForSdk(tempPath),
					undefined,
					ManagedFuture.new({
						pauseSignal: undefined,
						abortSignal: wrappedSignal
					}),
					params.signal
						? {
								signal: params.signal
							}
						: undefined
				)

				if (params.signal?.aborted) {
					throw abortError(params.signal)
				}

				sourcePath = tempPath
			}
		}

		// Hold the Context in a local binding across the await. expo-image-manipulator's
		// Context overrides sharedObjectDidRelease to cancel its underlying coroutine task;
		// if the chained intermediate ref were eligible for Hermes GC during renderAsync,
		// the native task would be cancelled and renderAsync would reject with
		// JobCancellationException.
		const context = ImageManipulator.ImageManipulator.manipulate(normalizeFilePathForExpo(sourcePath)).resize({
			width: params.width
		})

		let manipulated: ImageManipulator.ImageRef | null = null

		try {
			manipulated = await context.renderAsync()
		} catch (error) {
			if (params.signal?.aborted) {
				throw abortError(params.signal)
			}

			throw error
		}

		if (params.signal?.aborted) {
			throw abortError(params.signal)
		}

		let saved: ImageManipulator.ImageResult | null = null

		try {
			saved = await manipulated.saveAsync({
				compress: params.quality,
				format: ImageManipulator.SaveFormat.WEBP,
				base64: false
			})
		} catch (error) {
			if (params.signal?.aborted) {
				throw abortError(params.signal)
			}

			throw error
		}

		const savedFile = new FileSystem.File(saved.uri)
		const outputFile = new FileSystem.File(params.outputPath)

		try {
			if (outputFile.exists) {
				outputFile.delete()
			}

			savedFile.moveSync(outputFile)
		} catch (error) {
			try {
				if (savedFile.exists) {
					savedFile.delete()
				}
			} catch {
				// Best-effort cleanup of the orphaned manipulated file
			}

			const message = error instanceof Error ? error.message : String(error)

			throw new Error(`Failed to move thumbnail to output path: ${message}`)
		}
	})

	if (!result.success) {
		throw result.error
	}
}
