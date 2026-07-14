import * as FileSystem from "expo-file-system"
import * as ImageManipulator from "expo-image-manipulator"
import * as VideoThumbnails from "expo-video-thumbnails"
import { normalizeFilePathForExpo } from "@/lib/paths"
import { run } from "@filen/utils"
import { abortError } from "@/lib/thumbnailsHelpers"

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
				// Pre-resolved source URL (local-file URI or the HTTP-provider stream URL). The
				// caller resolves the offline lookup / provider readiness / online guard BEFORE
				// acquiring the shared concurrency slot so a provider wait never head-of-line-blocks
				// the semaphore (see thumbnails.ts).
				sourceUrl: string
		  }
	)
): Promise<void> {
	const result = await run(async defer => {
		const url = "localSourcePath" in params ? normalizeFilePathForExpo(params.localSourcePath) : params.sourceUrl

		if (params.signal?.aborted) {
			throw abortError(params.signal)
		}

		// Extract the frame to a FILE rather than an in-memory SharedRef. Feeding a
		// cross-module SharedRef (expo-video's VideoThumbnail) into the sync
		// ImageManipulator.manipulate(Either<URL, SharedRef>) traps in the SDK 56
		// ExpoModulesJSI getAny() layer; a file URI takes the safe string path that
		// the image flow already uses. getThumbnailAsync takes the time in ms and
		// extracts at full quality — the single lossy step is the WEBP save below.
		let thumbnail: VideoThumbnails.VideoThumbnailsResult

		try {
			thumbnail = await VideoThumbnails.getThumbnailAsync(url, {
				time: Math.max(0, Math.round(params.timestamp * 1000)),
				quality: 1
			})
		} catch (error) {
			if (params.signal?.aborted) {
				throw abortError(params.signal)
			}

			const message = error instanceof Error ? error.message : String(error)

			throw new Error(`Video thumbnail extraction failed at ${params.timestamp}s: ${message}`)
		}

		// getThumbnailAsync writes an intermediate frame file we no longer need once
		// it's been resized/re-encoded into the WEBP output.
		const sourceFile = new FileSystem.File(thumbnail.uri)

		defer(() => {
			try {
				if (sourceFile.exists) {
					sourceFile.delete()
				}
			} catch {
				// Best-effort cleanup of the intermediate extraction file
			}
		})

		if (params.signal?.aborted) {
			throw abortError(params.signal)
		}

		// Resize + re-encode to WEBP via the same string-URI path the image flow uses.
		// Hold the Context in a local binding across the await (see generateImage):
		// expo-image-manipulator's Context cancels its underlying coroutine task on
		// sharedObjectDidRelease, so letting it become Hermes-GC-eligible during
		// renderAsync would reject with JobCancellationException.
		const context = ImageManipulator.ImageManipulator.manipulate(normalizeFilePathForExpo(thumbnail.uri)).resize({
			width: params.width
		})

		let manipulated: ImageManipulator.ImageRef | null = null

		// Free the native SharedObjects (Context + rendered ImageRef) on scope exit — both wrap decoded
		// native bitmaps Hermes GC doesn't track, so without release they pile up during bulk generation
		// until the OS memory-kills the app. Deferred so it runs AFTER renderAsync/saveAsync settle
		// (releasing the Context mid-render cancels its coroutine — see the binding note above).
		defer(() => {
			manipulated?.release()
			context.release()
		})

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

			await savedFile.move(outputFile)
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
