import * as FileSystem from "expo-file-system"
import type { DriveItem } from "@/types"
import { EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS, EXPO_VIDEO_SUPPORTED_EXTENSIONS } from "@/constants"
import { normalizeFilePathForExpo } from "@/lib/paths"
import { run, Semaphore } from "@filen/utils"
import { ClearBarrier } from "@/lib/clearBarrier"
import { Platform } from "react-native"
import useHttpStore from "@/stores/useHttp.store"
import { onlineManager } from "@tanstack/react-query"
import { THUMBNAILS_VERSION, THUMBNAILS_DIRECTORY } from "@/lib/storageRoots"
import {
	abortError,
	OfflineAbortError,
	ProviderUnavailableError,
	getPath,
	ensureDirectory,
	driveItemToAnyFile,
	getExtension,
	waitForHttpProvider
} from "@/lib/thumbnailsHelpers"
import offline from "@/features/offline/offline"
import { generateImage } from "@/lib/thumbnailsImage"
import { generateVideo } from "@/lib/thumbnailsVideo"
import logger from "@/lib/logger"

export type ThumbnailParams = {
	item: DriveItem
	width?: number
	quality?: number
	videoTimestamp?: number
	signal?: AbortSignal
}

export const DEFAULT_WIDTH = 256
export const DEFAULT_QUALITY = 0.9
export const DEFAULT_VIDEO_TIMESTAMP = 1.0
export const MAX_CONCURRENT = Platform.select({
	ios: 3,
	android: 2,
	default: 2
})
export const MAX_FAILURES = 3

// Critical: When changing anything related to storage index/store/persistence/width/height/quality format, bump THUMBNAILS_VERSION in storageRoots.ts to invalidate old caches and prevent potential issues from stale or incompatible data.
export const VERSION = THUMBNAILS_VERSION
export const DIRECTORY = THUMBNAILS_DIRECTORY

class Thumbnails {
	private readonly pending = new Map<string, Promise<string>>()
	private readonly failures = new Map<string, number>()
	private readonly semaphore = new Semaphore(MAX_CONCURRENT)
	private readonly clearBarrier = new ClearBarrier()

	// Disk-derived availability index: a uuid is present iff `<uuid>.webp` exists in DIRECTORY.
	// Seeded once by restore() at boot and kept coherent by every generate/invalidate/remove/clear
	// path, so "file on disk ⇒ in Set" holds for any caller (drive rows read it synchronously).
	private readonly available = new Set<string>()
	private restored = false

	public constructor() {
		ensureDirectory()

		this.subscribeRecovery()
	}

	// listAsRecords() is @internal upstream but is the cheap path: it returns plain { isDirectory, uri }
	// records with no per-entry native objects (unlike list(), which allocates a File/Directory each).
	// Fallback if an SDK bump removes it (dependency-pin policy): DIRECTORY.list().
	private listThumbnailRecords(): { isDirectory: boolean; uri: string }[] {
		return DIRECTORY.listAsRecords()
	}

	// Rebuild the availability Set from disk once per process. Safe pre-auth / headless: it reads only
	// filenames (uuids), never decrypted data. A readdir failure logs a warn and leaves the Set empty —
	// the per-item generate path self-heals via its own disk exists-check. Idempotent (once-flag).
	public restore(): void {
		if (this.restored) {
			return
		}

		this.restored = true

		ensureDirectory()

		try {
			for (const record of this.listThumbnailRecords()) {
				if (record.isDirectory) {
					continue
				}

				const basename = FileSystem.Paths.basename(record.uri)

				// The Set holds ONLY <uuid>.webp basenames — the generation pipeline also leaves
				// thumb_tmp_* subdirectories and transient files in DIRECTORY; those must never enter it.
				if (!basename.endsWith(".webp")) {
					continue
				}

				this.available.add(basename.slice(0, -".webp".length))
			}
		} catch (e) {
			logger.warn("thumbnails", "restore failed to list thumbnails directory", { error: e })
		}
	}

	public hasThumbnail(uuid: string): boolean {
		return this.available.has(uuid)
	}

	// A provider-not-ready (ProviderUnavailableError) or transient decode failure can drive an item
	// to the MAX_FAILURES blacklist for the rest of the session. Clear the in-memory failure counters
	// whenever the underlying infrastructure recovers — the HTTP provider booting (port null→non-null)
	// or connectivity returning (offline→online) — so previously-blacklisted items get a fresh chance.
	private subscribeRecovery(): void {
		useHttpStore.subscribe(
			state => state.port,
			(port, prevPort) => {
				if (port !== null && prevPort === null) {
					this.failures.clear()
				}
			}
		)

		onlineManager.subscribe(isOnline => {
			if (isOnline) {
				this.failures.clear()
			}
		})
	}

	public canGenerate(item: DriveItem): boolean {
		const ext = getExtension(item)

		if (!ext) {
			return false
		}

		const isImage = EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS.has(ext)
		const isVideo = EXPO_VIDEO_SUPPORTED_EXTENSIONS.has(ext)

		return isImage || isVideo
	}

	public async generate(params: ThumbnailParams): Promise<string> {
		const result = await run(async defer => {
			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			if (params.signal?.aborted) {
				throw abortError(params.signal)
			}

			const uuid = params.item.data.uuid
			const ext = getExtension(params.item)

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

			const outputPath = getPath(params.item)
			const outputFile = new FileSystem.File(outputPath)

			if (outputFile.exists) {
				// Validate integrity — a 0-byte file is the result of a crashed/interrupted write and would loop the consumer forever.
				if (outputFile.size > 0) {
					this.available.add(uuid)

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
		const file = driveItemToAnyFile(params.item)

		if (!file) {
			throw new Error("Unsupported item type")
		}

		// Resolve the video source URL (offline lookup / online guard / HTTP-provider readiness)
		// BEFORE acquiring the concurrency slot. The provider boots asynchronously and the wait can
		// take up to 30s; holding a finite semaphore slot during that idle wait head-of-line-blocks
		// ALL thumbnail generation (including images). Doing it here means the slot only ever covers
		// real extract/encode work.
		let videoSourceUrl: string | null = null

		if (params.isVideo) {
			const offlineFile = await offline.getLocalFile(params.item)

			if (offlineFile?.exists) {
				videoSourceUrl = normalizeFilePathForExpo(offlineFile.uri)
			} else {
				// Video thumbnails stream via the local HTTP provider, which internally streams from
				// Filen servers via the SDK. Offline would stall. Throw abort-flavoured so the failures
				// map isn't poisoned (see generateImage for the same reasoning).
				if (!onlineManager.isOnline()) {
					throw new OfflineAbortError()
				}

				const getFileUrl = await waitForHttpProvider(params.signal)

				videoSourceUrl = getFileUrl(file)
			}
		}

		if (params.signal?.aborted) {
			throw abortError(params.signal)
		}

		// Acquire here (not in generate()) so concurrent callers waiting on the same in-flight pending promise don't each occupy a slot while idle.
		await this.semaphore.acquire()

		try {
			const result = await run(async () => {
				ensureDirectory()

				if (params.isImage) {
					await generateImage({
						file,
						item: params.item,
						outputPath: params.outputPath,
						width: params.width,
						quality: params.quality,
						signal: params.signal
					})
				} else if (params.isVideo && videoSourceUrl !== null) {
					await generateVideo({
						sourceUrl: videoSourceUrl,
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
				if (
					!params.signal?.aborted &&
					!(result.error instanceof OfflineAbortError) &&
					!(result.error instanceof ProviderUnavailableError)
				) {
					logger.error("thumbnails", "generation failed", {
						uuid: params.uuid,
						ext: params.ext,
						isImage: params.isImage,
						isVideo: params.isVideo,
						platform: Platform.OS,
						error: String(result.error)
					})

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

			this.available.add(params.uuid)

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
		await this.clearBarrier.enter()

		try {
			return await this.generateFromLocalFileImpl(params)
		} finally {
			this.clearBarrier.leave()
		}
	}

	private async generateFromLocalFileImpl(params: {
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
			logger.warn("thumbnails", "thumbnail generation blacklisted (max failures reached)", { uuid: params.uuid })
			return null
		}

		const outputPath = FileSystem.Paths.join(DIRECTORY.uri, `${params.uuid}.webp`)
		const outputFile = new FileSystem.File(outputPath)

		if (outputFile.exists) {
			// Validate integrity — a 0-byte file is the result of a crashed/interrupted write and would loop the consumer forever.
			if (outputFile.size > 0) {
				this.available.add(params.uuid)

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
				ensureDirectory()

				if (isImage) {
					await generateImage({
						localSourcePath: params.localPath,
						outputPath,
						width,
						quality,
						signal: params.signal
					})
				} else {
					await generateVideo({
						localSourcePath: params.localPath,
						outputPath,
						width,
						quality,
						timestamp: params.videoTimestamp ?? DEFAULT_VIDEO_TIMESTAMP,
						signal: params.signal
					})
				}

				this.available.add(params.uuid)

				return normalizeFilePathForExpo(outputPath)
			} catch (error) {
				if (!params.signal?.aborted && !(error instanceof OfflineAbortError) && !(error instanceof ProviderUnavailableError)) {
					logger.error("thumbnails", "generateFromLocalFile failed", {
						uuid: params.uuid,
						ext,
						isImage,
						isVideo,
						platform: Platform.OS,
						error: String(error)
					})

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
			logger.warn("thumbnails", "generateFromLocalFile run wrapper failed", { uuid: params.uuid, error: result.error })
			return null
		}

		return result.data
	}

	// Invalidate a cached thumbnail WITHOUT resetting its failure counter. Used when a render-time
	// decode failure (e.g. an undecodable-but-nonzero .webp) means the on-disk artifact must be
	// discarded, but the failure history must be preserved so the consumer can give up permanently
	// once MAX_ERROR_RETRIES is exhausted instead of looping generate-on-error forever.
	public invalidateFile(item: DriveItem): void {
		const file = new FileSystem.File(getPath(item))

		if (file.exists) {
			try {
				file.delete()
			} catch {
				// Best-effort removal of the corrupt cache entry
			}
		}

		this.available.delete(item.data.uuid)
	}

	public async clear(): Promise<void> {
		await this.clearBarrier.runExclusive(() => {
			this.failures.clear()
			this.available.clear()

			if (DIRECTORY.exists) {
				DIRECTORY.delete()
			}

			DIRECTORY.create({
				idempotent: true,
				intermediates: true
			})
		})
	}

	public size(): number {
		if (!DIRECTORY.exists) {
			return 0
		}

		let total = 0

		for (const entry of DIRECTORY.list()) {
			if (!(entry instanceof FileSystem.File)) {
				continue
			}

			total += entry.size ?? 0
		}

		return total
	}
}

const thumbnails = new Thumbnails()

export default thumbnails
