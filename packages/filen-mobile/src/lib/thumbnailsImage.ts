import * as FileSystem from "expo-file-system"
import * as ImageManipulator from "expo-image-manipulator"
import { normalizeFilePathForExpo } from "@/lib/paths"
import { run } from "@filen/utils"
import { abortError } from "@/lib/thumbnailsHelpers"

// The local-bytes encoder: an offline copy, a file-cache hit, or the file the device just uploaded
// (thumbnails.ts resolves the source; generateFromLocalFile hands its path straight in). Remote
// bytes never come through here — thumbnails.ts asks the SDK (thumbnailsSdk.ts) for those.
export async function generateImage(params: {
	localSourcePath: string
	outputPath: string
	width: number
	quality: number
	signal?: AbortSignal
}): Promise<void> {
	const result = await run(async defer => {
		if (params.signal?.aborted) {
			throw abortError(params.signal)
		}

		// Hold the Context in a local binding across the await. expo-image-manipulator's
		// Context overrides sharedObjectDidRelease to cancel its underlying coroutine task;
		// if the chained intermediate ref were eligible for Hermes GC during renderAsync,
		// the native task would be cancelled and renderAsync would reject with
		// JobCancellationException.
		const context = ImageManipulator.ImageManipulator.manipulate(normalizeFilePathForExpo(params.localSourcePath)).resize({
			width: params.width
		})

		let manipulated: ImageManipulator.ImageRef | null = null

		// Free the native SharedObjects (the manipulate Context and the rendered ImageRef) when this
		// run() scope exits. Both wrap decoded native bitmaps that Hermes GC does not track, so without
		// an explicit release they accumulate faster than GC reclaims them during bulk thumbnail
		// generation (a large camera upload generates one thumbnail per file via transferCore) until the
		// OS memory-pressure-kills the app. Deferred so release runs AFTER renderAsync/saveAsync settle —
		// releasing the Context mid-render cancels its coroutine (JobCancellationException, per above).
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
