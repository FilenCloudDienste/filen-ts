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

export type ThumbnailParams = {
	item: DriveItem
	width?: number
	quality?: number
	videoTimestamp?: number
	signal?: AbortSignal
}

const DEFAULT_WIDTH = 256
const DEFAULT_QUALITY = 0.8
const DEFAULT_VIDEO_TIMESTAMP = 1.0
const MAX_CONCURRENT = 3
const MAX_FAILURES = 3
const VERSION = 1

function abortError(signal?: AbortSignal): Error {
	const reason = signal?.reason

	if (reason instanceof Error) {
		return reason
	}

	if (reason !== undefined && reason !== null) {
		return new Error(String(reason))
	}

	return new Error("Aborted")
}

class Thumbnails {
	private readonly directory = new FileSystem.Directory(
		FileSystem.Paths.join(
			Platform.select({
				ios: FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER]?.uri ?? FileSystem.Paths.document.uri,
				default: FileSystem.Paths.document.uri
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
		return FileSystem.Paths.join(this.directory.uri, `${item.data.uuid}.png`)
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

			case "sharedFile": {
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
			case "sharedFile": {
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

			const cleanup = () => {
				unsubscribe()

				signal?.removeEventListener("abort", onAbort)
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
		})
	}

	private async generateImage(params: {
		file: AnyFile
		item: DriveItem
		outputPath: string
		width: number
		quality: number
		signal?: AbortSignal
	}): Promise<void> {
		const result = await run(async defer => {
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

			const manipulated = await ImageManipulator.ImageManipulator.manipulate(normalizeFilePathForExpo(tempPath))
				.resize({
					width: params.width
				})
				.renderAsync()

			if (params.signal?.aborted) {
				throw abortError(params.signal)
			}

			const saved = await manipulated.saveAsync({
				compress: params.quality,
				format: ImageManipulator.SaveFormat.PNG,
				base64: false
			})

			const savedFile = new FileSystem.File(saved.uri)
			const outputFile = new FileSystem.File(params.outputPath)

			if (outputFile.exists) {
				outputFile.delete()
			}

			savedFile.move(outputFile)
		})

		if (!result.success) {
			throw result.error
		}
	}

	private async generateVideo(params: {
		file: AnyFile
		outputPath: string
		width: number
		quality: number
		timestamp: number
		signal?: AbortSignal
	}): Promise<void> {
		const result = await run(async defer => {
			const getFileUrl = await this.waitForHttpProvider(params.signal)
			const url = getFileUrl(params.file)

			if (params.signal?.aborted) {
				throw abortError(params.signal)
			}

			const player = createVideoPlayer(url)

			defer(() => {
				player.release()
			})

			if (params.signal) {
				const onAbort = () => {
					player.release()
				}

				params.signal.addEventListener("abort", onAbort, {
					once: true
				})

				defer(() => {
					params.signal?.removeEventListener("abort", onAbort)
				})
			}

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

			const thumbnails = await player.generateThumbnailsAsync([params.timestamp], {
				maxWidth: params.width,
				maxHeight: params.width
			})

			if (params.signal?.aborted) {
				throw abortError(params.signal)
			}

			const thumbnail = thumbnails[0] as VideoThumbnail | undefined

			if (!thumbnail) {
				throw new Error("No thumbnail generated")
			}

			const manipulated = await ImageManipulator.ImageManipulator.manipulate(thumbnail).renderAsync()

			if (params.signal?.aborted) {
				throw abortError(params.signal)
			}

			const saved = await manipulated.saveAsync({
				compress: params.quality,
				format: ImageManipulator.SaveFormat.PNG,
				base64: false
			})

			const savedFile = new FileSystem.File(saved.uri)
			const outputFile = new FileSystem.File(params.outputPath)

			if (outputFile.exists) {
				outputFile.delete()
			}

			savedFile.move(outputFile)
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
		const result = await run(async defer => {
			await this.semaphore.acquire()

			defer(() => {
				this.semaphore.release()
			})

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
				return normalizeFilePathForExpo(outputPath)
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
			throw result.error
		}

		return result.data
	}

	private async doGenerate(params: {
		item: DriveItem
		uuid: string
		ext: string
		isImage: boolean
		outputPath: string
		signal?: AbortSignal
		width: number
		quality: number
		videoTimestamp: number
	}): Promise<string> {
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
			} else {
				await this.generateVideo({
					file,
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
				this.failures.set(params.uuid, (this.failures.get(params.uuid) ?? 0) + 1)
			}

			const outputFile = new FileSystem.File(params.outputPath)

			if (outputFile.exists) {
				outputFile.delete()
			}

			throw result.error
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
