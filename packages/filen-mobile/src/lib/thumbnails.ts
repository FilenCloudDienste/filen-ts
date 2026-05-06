import * as FileSystem from "expo-file-system"
import * as ImageManipulator from "expo-image-manipulator"
import { type VideoThumbnail, createVideoPlayer } from "expo-video"
import type { DriveItem } from "@/types"
import { EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS, EXPO_VIDEO_SUPPORTED_EXTENSIONS, IOS_APP_GROUP_IDENTIFIER } from "@/constants"
import { normalizeFilePathForExpo, normalizeFilePathForSdk, wrapAbortSignalForSdk } from "@/lib/utils"
import { run, Semaphore } from "@filen/utils"
import { AnyFile, ManagedFuture } from "@filen/sdk-rs"
import auth from "@/lib/auth"
import useHttpStore from "@/stores/useHttp.store"
import { Platform } from "react-native"
import { randomUUID } from "expo-crypto"
import cache from "@/lib/cache"
import offline from "@/lib/offline"
import fileCache from "@/lib/fileCache"

export type ThumbnailParams = {
	item: DriveItem
	width?: number
	quality?: number
	videoTimestamp?: number
	signal?: AbortSignal
}

export const DEFAULT_WIDTH = 128
export const DEFAULT_QUALITY = 0.8
export const DEFAULT_VIDEO_TIMESTAMP = 1.0
export const MAX_CONCURRENT = Platform.select({
	ios: 3,
	android: 2,
	default: 2
})
export const MAX_FAILURES = 3

// Critical: When changing anything related to storage index/store/persistence/width/height/quality format, increment the VERSION constant to invalidate old caches and prevent potential issues from stale or incompatible data.
export const VERSION = 2

function abortError(signal?: AbortSignal): Error {
	const reason = signal?.reason

	if (reason instanceof Error) {
		return reason
	}

	if (typeof reason !== "undefined" && reason !== null) {
		return new Error(String(reason))
	}

	return new Error("Aborted")
}

class Thumbnails {
	public readonly directory = new FileSystem.Directory(
		FileSystem.Paths.join(
			Platform.select({
				ios: FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER] ?? FileSystem.Paths.document,
				default: FileSystem.Paths.document
			}),
			"thumbnails",
			`v${VERSION}`
		)
	)
	private readonly pending = new Map<string, Promise<string>>()
	private readonly failures = new Map<string, number>()
	private readonly semaphore = new Semaphore(MAX_CONCURRENT)

	public constructor() {
		this.ensureDirectory()
	}

	private getPath(item: DriveItem): string {
		return FileSystem.Paths.join(this.directory.uri, `${item.data.uuid}.webp`)
	}

	private ensureDirectory(): void {
		if (!this.directory.exists) {
			this.directory.create({
				idempotent: true,
				intermediates: true
			})
		}
	}

	private driveItemToAnyFile(item: DriveItem): AnyFile | null {
		switch (item.type) {
			case "file": {
				return new AnyFile.File(item.data)
			}

			case "sharedFile":
			case "sharedRootFile": {
				return new AnyFile.Shared(item.data)
			}

			default: {
				return null
			}
		}
	}

	private getExtension(item: DriveItem): string | null {
		switch (item.type) {
			case "file":
			case "sharedFile":
			case "sharedRootFile": {
				const name = item.data.decryptedMeta?.name

				if (!name) {
					return null
				}

				return FileSystem.Paths.extname(name).toLowerCase().trim()
			}

			default: {
				return null
			}
		}
	}

	private waitForHttpProvider(signal?: AbortSignal): Promise<(file: AnyFile) => string> {
		const state = useHttpStore.getState()

		if (state.port !== null && state.getFileUrl) {
			return Promise.resolve(state.getFileUrl)
		}

		return new Promise<(file: AnyFile) => string>((resolve, reject) => {
			if (signal?.aborted) {
				reject(abortError(signal))

				return
			}

			let timeoutId: ReturnType<typeof setTimeout> | null = null

			const cleanup = () => {
				unsubscribe()

				signal?.removeEventListener("abort", onAbort)

				if (timeoutId !== null) {
					clearTimeout(timeoutId)

					timeoutId = null
				}
			}

			const unsubscribe = useHttpStore.subscribe(
				s => ({
					port: s.port,
					getFileUrl: s.getFileUrl
				}),
				({ port, getFileUrl }) => {
					if (port !== null && getFileUrl) {
						cleanup()

						resolve(getFileUrl)
					}
				}
			)

			const onAbort = () => {
				cleanup()

				reject(abortError(signal))
			}

			signal?.addEventListener("abort", onAbort, {
				once: true
			})

			timeoutId = setTimeout(() => {
				cleanup()

				reject(new Error("HTTP provider unavailable after 30s"))
			}, 30_000)
		})
	}

	private async generateImage(
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
					const { authedSdkClient } = await auth.getSdkClients()
					const tempDir = new FileSystem.Directory(FileSystem.Paths.join(this.directory.uri, `thumb_tmp_${randomUUID()}`))

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

					const ext = this.getExtension(params.item)

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

	private async generateVideo(
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
					const getFileUrl = await this.waitForHttpProvider(params.signal)

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

	public canGenerate(item: DriveItem): boolean {
		const ext = this.getExtension(item)

		if (!ext) {
			return false
		}

		const isImage = EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS.has(ext)
		const isVideo = EXPO_VIDEO_SUPPORTED_EXTENSIONS.has(ext)

		return isImage || isVideo
	}

	public async generate(params: ThumbnailParams): Promise<string> {
		const result = await run(async () => {
			if (params.signal?.aborted) {
				throw abortError(params.signal)
			}

			const uuid = params.item.data.uuid
			const ext = this.getExtension(params.item)

			if (!ext) {
				throw new Error("File has no extension")
			}

			const isImage = EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS.has(ext)
			const isVideo = EXPO_VIDEO_SUPPORTED_EXTENSIONS.has(ext)

			if (!isImage && !isVideo) {
				throw new Error("Unsupported file type")
			}

			if ((this.failures.get(uuid) ?? 0) >= MAX_FAILURES) {
				throw new Error("Max thumbnail generation failures reached")
			}

			const outputPath = this.getPath(params.item)
			const outputFile = new FileSystem.File(outputPath)

			if (outputFile.exists) {
				// Validate integrity — a 0-byte file is the result of a crashed/interrupted write and would loop the consumer forever.
				if (outputFile.size > 0) {
					return normalizeFilePathForExpo(outputPath)
				}

				try {
					outputFile.delete()
				} catch {
					// Best-effort cleanup of the corrupt cache entry; if delete fails we'll regenerate anyway.
				}
			}

			const pendingPromise = this.pending.get(uuid)

			if (pendingPromise) {
				return pendingPromise
			}

			const promise = this.doGenerate({
				item: params.item,
				uuid,
				ext,
				isImage,
				isVideo,
				outputPath,
				width: params.width ?? DEFAULT_WIDTH,
				quality: params.quality ?? DEFAULT_QUALITY,
				videoTimestamp: params.videoTimestamp ?? DEFAULT_VIDEO_TIMESTAMP,
				signal: params.signal
			})

			this.pending.set(uuid, promise)

			const result = await run(async defer => {
				defer(() => {
					this.pending.delete(uuid)
				})

				return await promise
			})

			if (!result.success) {
				throw result.error
			}

			return result.data
		})

		if (!result.success) {
			if (params.signal?.aborted) {
				throw abortError(params.signal)
			}

			throw result.error
		}

		return result.data
	}

	private async doGenerate(params: {
		item: DriveItem
		uuid: string
		ext: string
		isImage: boolean
		isVideo: boolean
		outputPath: string
		signal?: AbortSignal
		width: number
		quality: number
		videoTimestamp: number
	}): Promise<string> {
		// Acquire here (not in generate()) so concurrent callers waiting on the same in-flight pending promise don't each occupy a slot while idle.
		await this.semaphore.acquire()

		try {
			const result = await run(async () => {
				this.ensureDirectory()

				const file = this.driveItemToAnyFile(params.item)

				if (!file) {
					throw new Error("Unsupported item type")
				}

				if (params.isImage) {
					await this.generateImage({
						file,
						item: params.item,
						outputPath: params.outputPath,
						width: params.width,
						quality: params.quality,
						signal: params.signal
					})
				} else if (params.isVideo) {
					await this.generateVideo({
						file,
						item: params.item,
						outputPath: params.outputPath,
						width: params.width,
						quality: params.quality,
						timestamp: params.videoTimestamp,
						signal: params.signal
					})
				}

				return normalizeFilePathForExpo(params.outputPath)
			})

			if (!result.success) {
				if (!params.signal?.aborted) {
					console.error(
						"[Thumbnails] generation failed",
						{
							uuid: params.uuid,
							ext: params.ext,
							isImage: params.isImage,
							isVideo: params.isVideo,
							platform: Platform.OS
						},
						result.error
					)

					this.failures.set(params.uuid, (this.failures.get(params.uuid) ?? 0) + 1)
				}

				const outputFile = new FileSystem.File(params.outputPath)

				if (outputFile.exists) {
					try {
						outputFile.delete()
					} catch {
						// Best-effort cleanup of partial output
					}
				}

				throw result.error
			}

			return result.data
		} finally {
			this.semaphore.release()
		}
	}

	public async generateFromLocalFile(params: {
		localPath: string
		uuid: string
		name: string
		width?: number
		quality?: number
		videoTimestamp?: number
		signal?: AbortSignal
	}): Promise<string | null> {
		const ext = FileSystem.Paths.extname(params.name).toLowerCase().trim()

		if (!ext) {
			return null
		}

		const isImage = EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS.has(ext)
		const isVideo = EXPO_VIDEO_SUPPORTED_EXTENSIONS.has(ext)

		if (!isImage && !isVideo) {
			return null
		}

		if ((this.failures.get(params.uuid) ?? 0) >= MAX_FAILURES) {
			return null
		}

		const outputPath = FileSystem.Paths.join(this.directory.uri, `${params.uuid}.webp`)
		const outputFile = new FileSystem.File(outputPath)

		if (outputFile.exists) {
			// Validate integrity — a 0-byte file is the result of a crashed/interrupted write and would loop the consumer forever.
			if (outputFile.size > 0) {
				cache.availableThumbnails.set(params.uuid, true)

				return normalizeFilePathForExpo(outputPath)
			}

			try {
				outputFile.delete()
			} catch {
				// Best-effort cleanup of the corrupt cache entry; if delete fails we'll regenerate anyway.
			}
		}

		const pendingPromise = this.pending.get(params.uuid)

		if (pendingPromise) {
			return pendingPromise
		}

		const width = params.width ?? DEFAULT_WIDTH
		const quality = params.quality ?? DEFAULT_QUALITY

		const promise = (async (): Promise<string> => {
			await this.semaphore.acquire()

			try {
				this.ensureDirectory()

				if (isImage) {
					await this.generateImage({
						localSourcePath: params.localPath,
						outputPath,
						width,
						quality,
						signal: params.signal
					})
				} else {
					await this.generateVideo({
						localSourcePath: params.localPath,
						outputPath,
						width,
						quality,
						timestamp: params.videoTimestamp ?? DEFAULT_VIDEO_TIMESTAMP,
						signal: params.signal
					})
				}

				cache.availableThumbnails.set(params.uuid, true)

				return normalizeFilePathForExpo(outputPath)
			} catch (error) {
				if (!params.signal?.aborted) {
					console.error(
						"[Thumbnails] generateFromLocalFile failed",
						{
							uuid: params.uuid,
							ext,
							isImage,
							isVideo,
							platform: Platform.OS
						},
						error
					)

					this.failures.set(params.uuid, (this.failures.get(params.uuid) ?? 0) + 1)
				}

				if (outputFile.exists) {
					try {
						outputFile.delete()
					} catch {
						// Best-effort cleanup of partial output
					}
				}

				throw error
			} finally {
				this.semaphore.release()
				this.pending.delete(params.uuid)
			}
		})()

		this.pending.set(params.uuid, promise)

		const result = await run(async () => await promise)

		if (!result.success) {
			return null
		}

		return result.data
	}

	public exists(item: DriveItem):
		| {
				exists: false
		  }
		| {
				exists: true
				path: string
		  } {
		const file = new FileSystem.File(this.getPath(item))

		if (!file.exists) {
			return {
				exists: false
			}
		}

		return {
			exists: true,
			path: normalizeFilePathForExpo(file.uri)
		}
	}

	public remove(item: DriveItem): void {
		const file = new FileSystem.File(this.getPath(item))

		if (file.exists) {
			file.delete()
		}

		this.failures.delete(item.data.uuid)

		cache.availableThumbnails.delete(item.data.uuid)
	}

	public clear(): void {
		this.failures.clear()

		cache.availableThumbnails.clear()

		if (this.directory.exists) {
			this.directory.delete()
		}

		this.directory.create({
			idempotent: true,
			intermediates: true
		})
	}
}

const thumbnails = new Thumbnails()

export default thumbnails
