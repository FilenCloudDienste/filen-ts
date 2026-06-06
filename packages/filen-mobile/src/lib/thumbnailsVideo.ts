import * as FileSystem from "expo-file-system"
import * as ImageManipulator from "expo-image-manipulator"
import { type VideoThumbnail, createVideoPlayer } from "expo-video"
import { AnyFile } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { normalizeFilePathForExpo } from "@/lib/paths"
import { run } from "@filen/utils"
import offline from "@/features/offline/offline"
import { onlineManager } from "@tanstack/react-query"
import { abortError, OfflineAbortError, waitForHttpProvider } from "@/lib/thumbnailsHelpers"

export async function generateVideo(
	params: {
		outputPath: string
		width: number
		quality: number
		timestamp: number
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
		let url: string

		if ("localSourcePath" in params) {
			url = normalizeFilePathForExpo(params.localSourcePath)
		} else {
			const offlineFile = await offline.getLocalFile(params.item)

			if (offlineFile?.exists) {
				url = normalizeFilePathForExpo(offlineFile.uri)
			} else {
				// Video thumbnails stream via the local HTTP provider, which
				// internally streams from Filen servers via the SDK. Offline
				// would stall. Throw abort-flavoured so the failures map isn't
				// poisoned (see generateImage for the same reasoning).
				if (!onlineManager.isOnline()) {
					throw new OfflineAbortError()
				}

				const getFileUrl = await waitForHttpProvider(params.signal)

				url = getFileUrl(params.file)
			}
		}

		if (params.signal?.aborted) {
			throw abortError(params.signal)
		}

		const player = createVideoPlayer(url)

		// The defer below releases the player on every exit path including abort.
		// Do NOT register a separate onAbort handler that also calls release() — that would double-release a native SharedObject.
		defer(() => {
			player.release()
		})

		if (player.status !== "readyToPlay") {
			await new Promise<void>((resolve, reject) => {
				if (params.signal?.aborted) {
					reject(abortError(params.signal))

					return
				}

				const cleanup = () => {
					subscription.remove()

					params.signal?.removeEventListener("abort", onAbort)
				}

				const subscription = player.addListener("statusChange", ({ status, error }) => {
					if (status === "readyToPlay") {
						cleanup()

						resolve()
					} else if (status === "error") {
						cleanup()

						reject(new Error(error?.message ?? "Video player failed to load"))
					}
				})

				const onAbort = () => {
					cleanup()

					reject(abortError(params.signal))
				}

				params.signal?.addEventListener("abort", onAbort, {
					once: true
				})
			})
		}

		if (params.signal?.aborted) {
			throw abortError(params.signal)
		}

		let thumbnails: VideoThumbnail[]

		try {
			thumbnails = await player.generateThumbnailsAsync([params.timestamp], {
				maxWidth: params.width,
				maxHeight: params.width
			})
		} catch (error) {
			if (params.signal?.aborted) {
				throw abortError(params.signal)
			}

			const message = error instanceof Error ? error.message : String(error)

			throw new Error(`Video thumbnail extraction failed at ${params.timestamp}s: ${message}`)
		}

		if (params.signal?.aborted) {
			throw abortError(params.signal)
		}

		const thumbnail = thumbnails[0] as VideoThumbnail | undefined

		if (!thumbnail) {
			throw new Error("No thumbnail generated")
		}

		// See generateImage: hold Context across renderAsync to prevent Hermes GC from
		// cancelling the underlying coroutine task via sharedObjectDidRelease.
		const context = ImageManipulator.ImageManipulator.manipulate(thumbnail)

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

			savedFile.move(outputFile)
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
