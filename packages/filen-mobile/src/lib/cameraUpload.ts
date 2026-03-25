import * as MediaLibrary from "expo-media-library/next"
import auth from "@/lib/auth"
import { type Dir, type FileWithPath, AnyNormalDir, AnyDirWithContext } from "@filen/sdk-rs"
import {
	PauseSignal,
	normalizeFilePathForSdk,
	unwrapFileMeta,
	normalizeFilePathForExpo,
	unwrappedFileIntoDriveItem,
	normalizeModificationTimestampForComparison
} from "@/lib/utils"
import pathModule from "path"
import transfers from "@/lib/transfers"
import * as FileSystem from "expo-file-system"
import { run, Semaphore, fastLocaleCompare } from "@filen/utils"
import useCameraUploadStore from "@/stores/useCameraUpload.store"
import secureStore, { useSecureStore } from "@/lib/secureStore"
import { randomUUID } from "expo-crypto"
import { useShallow } from "zustand/shallow"
import { xxHash32 } from "js-xxhash"
import { EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS } from "@/constants"
import * as ImageManipulator from "expo-image-manipulator"
import events from "@/lib/events"
import { LRUCache } from "lru-cache"
import { parseExifDate } from "@/lib/exif"
import drive from "@/lib/drive"
import { useCallback } from "react"
import NetInfo from "@react-native-community/netinfo"
import * as Battery from "expo-battery"
import { getPermissionsAsync } from "expo-media-library"

export type LocalFile = {
	asset: MediaLibrary.Asset
	info: MediaLibrary.AssetInfo
	path: string
}

export type RemoteFile = FileWithPath

export type LocalTree = Record<string, LocalFile>
export type RemoteTree = Record<string, RemoteFile>

export type Delta = {
	type: "upload"
	file: LocalFile
}

export type Config = {
	enabled: boolean
	remoteDir: Dir | null
	albumIds: string[]
	activationTimestamp: number
	afterActivation: boolean
	includeVideos: boolean
	cellular: boolean
	background: boolean
	lowBattery: boolean
	compress: boolean
}

export type CollisionParams = {
	iteration: number
	path: string
	asset: {
		name: string
		creationTime: number
	}
}

export const DEFAULT_CONFIG: Config = {
	enabled: false,
	albumIds: [],
	remoteDir: null,
	activationTimestamp: 0,
	afterActivation: false,
	includeVideos: false,
	cellular: false,
	background: false,
	lowBattery: false,
	compress: false
}

/**
 * Generates a collision-resolved path for a camera upload asset.
 *
 * When multiple assets share the same filename, this function appends
 * a deterministic suffix based on the asset's metadata. The iteration
 * parameter controls which suffix strategy is used:
 *
 *   0 — append creationTime
 *   1 — append hash of name + creationTime
 *
 * Only creationTime is used because modificationTime can change when a
 * file is edited, which would produce different paths across syncs.
 *
 * Returns null when all iterations are exhausted or the path is invalid.
 */
export function modifyAssetPathOnCollision({ iteration, path, asset }: CollisionParams): string | null {
	const ext = pathModule.posix.extname(asset.name)
	const basename = pathModule.posix.basename(asset.name, ext)
	const parentDir = pathModule.posix.dirname(path)

	if (parentDir === "." || basename.length === 0 || parentDir.length === 0 || basename === ".") {
		return null
	}

	switch (iteration) {
		case 0: {
			return normalizeFilePathForSdk(pathModule.posix.join(parentDir, `${basename}_${asset.creationTime}${ext}`))
				.toLowerCase()
				.trim()
		}

		case 1: {
			return normalizeFilePathForSdk(
				pathModule.posix.join(parentDir, `${basename}_${xxHash32(`${asset.name}_${asset.creationTime}`).toString(16)}${ext}`)
			)
				.toLowerCase()
				.trim()
		}

		default: {
			return null
		}
	}
}

class CameraUpload {
	private globalAbortController = new AbortController()
	private globalPauseSignal = new PauseSignal()
	private syncMutex: Semaphore = new Semaphore(1)
	public secureStoreKey: string = "cameraUploadConfig"
	private readonly getLocalAssetInfoSemaphore = new Semaphore(32)
	private readonly ensureParentDirectoryExistsCache = new LRUCache<string, Dir>({
		max: 100,
		maxEntrySize: Number.MAX_SAFE_INTEGER,
		maxSize: Number.MAX_SAFE_INTEGER,
		ttl: 60000,
		allowStale: false,
		updateAgeOnGet: false,
		updateAgeOnHas: false
	})

	public constructor() {
		events.subscribe("secureStoreChange", ({ key }) => {
			if (key === this.secureStoreKey) {
				this.ensureParentDirectoryExistsCache.clear()

				this.cancel()
			}
		})

		events.subscribe("secureStoreClear", () => {
			this.ensureParentDirectoryExistsCache.clear()

			this.cancel()
		})

		events.subscribe("secureStoreRemove", ({ key }) => {
			if (key === this.secureStoreKey) {
				this.ensureParentDirectoryExistsCache.clear()

				this.cancel()
			}
		})
	}

	public cancel(): void {
		this.globalAbortController.abort()
		this.globalAbortController = new AbortController()
		// Replace the pause signal so the next sync starts unpaused. The aborted
		// controller above will already stop any in-flight transfers before they
		// can block on the old (possibly paused) signal.
		this.globalPauseSignal = new PauseSignal()
	}

	public pause(): void {
		this.globalPauseSignal.pause()
	}

	public resume(): void {
		this.globalPauseSignal.resume()
	}

	private async compress(file: FileSystem.File): Promise<FileSystem.File> {
		const extname = pathModule.posix.extname(file.uri).toLowerCase()

		if (!EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS.has(extname)) {
			return file
		}

		// Guard: only compress files within the app's cache directory to prevent
		// processing arbitrary paths if this method is ever called with an unexpected input.
		if (!file.uri.startsWith(FileSystem.Paths.cache.uri)) {
			throw new Error(`compress() called on file outside cache directory: ${file.uri}`)
		}

		const manipulated = await ImageManipulator.ImageManipulator.manipulate(normalizeFilePathForExpo(file.uri)).renderAsync()
		const result = await manipulated.saveAsync({
			compress: 0.8,
			format: ImageManipulator.SaveFormat.JPEG,
			base64: false
		})

		const manipulatedFile = new FileSystem.File(result.uri)

		if (!manipulatedFile.exists) {
			throw new Error(`Generated file at ${manipulatedFile.uri} does not exist.`)
		}

		if (!manipulatedFile.size || !file.size || manipulatedFile.size >= file.size) {
			if (manipulatedFile.exists) {
				manipulatedFile.delete()
			}

			return file
		}

		manipulatedFile.copy(file)

		if (manipulatedFile.exists) {
			manipulatedFile.delete()
		}

		// Correct the extension to .jpg since the content is now JPEG.
		// File.move() updates the uri property in place.
		if (extname !== ".jpg" && extname !== ".jpeg") {
			const newFile = new FileSystem.File(file.uri.replace(/\.[^.]+$/, ".jpg"))

			file.move(newFile)

			return newFile
		}

		return file
	}

	private async listLocal({ config, signal }: { config: Config; signal: AbortSignal }): Promise<LocalTree> {
		const tree: LocalTree = {}
		const albums = config.albumIds.map(id => new MediaLibrary.Album(id))

		await Promise.all(
			albums.map(async album => {
				// Phase 1: query assets with native-level filters to avoid fetching
				// info for assets that would be discarded by includeVideos/afterActivation.
				let query = new MediaLibrary.Query().album(album)

				if (!config.includeVideos) {
					query = query.within(MediaLibrary.AssetField.MEDIA_TYPE, [
						MediaLibrary.MediaType.IMAGE,
						MediaLibrary.MediaType.AUDIO,
						MediaLibrary.MediaType.UNKNOWN
					])
				}

				if (config.afterActivation) {
					query = query.gte(MediaLibrary.AssetField.CREATION_TIME, config.activationTimestamp)
				}

				const [title, assets] = await Promise.all([album.getTitle(), query.exe()])

				// Phase 1.5: fetch asset infos concurrently (rate-limited by semaphore).
				const infos = await Promise.all(
					assets.map(async asset => {
						const result = await run(
							async defer => {
								if (signal.aborted) {
									throw new Error("Aborted")
								}

								await this.getLocalAssetInfoSemaphore.acquire()

								defer(() => {
									this.getLocalAssetInfoSemaphore.release()
								})

								if (signal.aborted) {
									throw new Error("Aborted")
								}

								return {
									asset,
									info: await asset.getInfo()
								}
							},
							{
								throw: true
							}
						)

						if (!result.success) {
							throw result.error
						}

						return result.data
					})
				)

				// Phase 2: sort by creationTime ascending before building the tree.
				// On iOS, asset filenames cycle (IMG_0001 … IMG_9999 → IMG_0001 …), so multiple
				// assets can share the same filename. Because getInfo() resolves in non-deterministic
				// order, building the tree directly inside Promise.all produces a different
				// winner for the base path slot on each run, causing re-uploads on every sync.
				// Sorting first ensures the oldest asset always wins the base slot and newer
				// duplicates consistently receive a collision suffix – stable across runs.
				// Filename is used as tiebreaker so both local and remote trees resolve
				// equal creationTimes in the same order.
				infos.sort((a, b) => {
					const timeDiff = (a.info.creationTime ?? 0) - (b.info.creationTime ?? 0)

					if (timeDiff !== 0) {
						return timeDiff
					}

					return fastLocaleCompare(a.info.filename, b.info.filename)
				})

				// Phase 3: build tree sequentially so collision resolution is deterministic.
				for (const { asset, info } of infos) {
					let path = normalizeFilePathForSdk(pathModule.posix.join(title, info.filename)).toLowerCase().trim()
					let iteration = 0

					while (tree[path]) {
						path =
							modifyAssetPathOnCollision({
								iteration,
								path,
								asset: {
									name: info.filename,
									creationTime: info.creationTime ?? 0
								}
							}) ?? ""

						if (path.length === 0) {
							break
						}

						iteration++
					}

					if (path.length === 0) {
						continue
					}

					tree[path] = {
						asset,
						info,
						path
					}
				}
			})
		)

		return tree
	}

	private async listRemote({ remoteDir, signal }: { remoteDir: Dir; signal: AbortSignal }): Promise<RemoteTree> {
		const { authedSdkClient } = await auth.getSdkClients()
		const { files } = await authedSdkClient.listDirRecursiveWithPaths(
			new AnyDirWithContext.Normal(new AnyNormalDir.Dir(remoteDir)),
			{
				onProgress() {
					// Noop
				}
			},
			{
				onErrors() {
					// Noop
				}
			},
			{
				signal
			}
		)

		const tree: RemoteTree = {}

		// Pre-unwrap metadata and sort by creationTime ascending with filename as tiebreaker,
		// mirroring the listLocal sort order. The server does not guarantee a stable return
		// order, so without sorting, collision resolution would assign different path slots
		// to the same files across runs, causing spurious re-uploads.
		const sortedFiles = files
			.map(file => ({
				file,
				meta: unwrapFileMeta(file.file).meta
			}))
			.sort((a, b) => {
				const timeDiff = (a.meta ? Number(a.meta.created) : 0) - (b.meta ? Number(b.meta.created) : 0)

				if (timeDiff !== 0) {
					return timeDiff
				}

				return fastLocaleCompare(a.meta?.name ?? "", b.meta?.name ?? "")
			})

		for (const { file, meta } of sortedFiles) {
			let path = normalizeFilePathForSdk(file.path).toLowerCase().trim()
			let iteration = 0

			while (tree[path]) {
				path =
					modifyAssetPathOnCollision({
						iteration,
						path,
						asset: {
							name: meta?.name ?? pathModule.posix.basename(path),
							creationTime: meta ? Number(meta.created) : 0
						}
					}) ?? ""

				if (path.length === 0) {
					break
				}

				iteration++
			}

			if (path.length === 0) {
				continue
			}

			tree[path] = file
		}

		return tree
	}

	private async deltas({ config, signal }: { config: Config; signal: AbortSignal }): Promise<Delta[]> {
		if (!config.remoteDir) {
			throw new Error("Remote directory is not set in config")
		}

		const [localTree, remoteTree] = await Promise.all([
			this.listLocal({
				config,
				signal
			}),
			this.listRemote({
				remoteDir: config.remoteDir,
				signal
			})
		])

		const deltas: Delta[] = []

		for (const path in localTree) {
			const localFile = localTree[path]
			const remoteFile = remoteTree[path]
			const remoteFileMeta = remoteFile ? unwrapFileMeta(remoteFile.file) : null

			if (
				(!remoteFile && localFile) ||
				(remoteFile &&
					localFile &&
					remoteFileMeta &&
					remoteFileMeta.meta?.modified &&
					localFile.info.modificationTime &&
					normalizeModificationTimestampForComparison(Number(remoteFileMeta.meta.modified)) <
						normalizeModificationTimestampForComparison(localFile.info.modificationTime))
			) {
				deltas.push({
					type: "upload",
					file: localFile
				})
			}
		}

		return deltas
	}

	public async getConfig(): Promise<Config> {
		const config = await secureStore.get<Config>(this.secureStoreKey)

		if (!config) {
			return DEFAULT_CONFIG
		}

		return config
	}

	public async setConfig(fn: Config | ((prev: Config) => Config)): Promise<void> {
		const currentConfig = await this.getConfig()
		const newConfig = typeof fn === "function" ? fn(currentConfig) : fn

		await secureStore.set(this.secureStoreKey, newConfig)
	}

	private async ensureParentDirectoryExists({ path, config, signal }: { path: string; config: Config; signal: AbortSignal }) {
		if (!config.remoteDir) {
			throw new Error("Remote directory is not set in config")
		}

		const parentDirName = pathModule.posix.dirname(path)
		const cacheKey = `${config.remoteDir.uuid}:${parentDirName}`
		const fromCache = this.ensureParentDirectoryExistsCache.get(cacheKey)

		if (fromCache) {
			return fromCache
		}

		if (parentDirName.length === 0 || parentDirName === ".") {
			throw new Error(`Invalid parent directory path: ${parentDirName}`)
		}

		const { authedSdkClient } = await auth.getSdkClients()
		const parentDirEnum = new AnyNormalDir.Dir(config.remoteDir)
		const dir = await authedSdkClient.createDir(parentDirEnum, parentDirName, {
			signal
		})

		this.ensureParentDirectoryExistsCache.set(cacheKey, dir)

		return dir
	}

	public async sync(params?: { maxUploads?: number }): Promise<void> {
		const result = await run(async defer => {
			const config = await this.getConfig()

			if (!config.enabled || config.albumIds.length === 0 || !config.remoteDir) {
				return
			}

			const [netState, permissions] = await Promise.all([NetInfo.fetch(), getPermissionsAsync()])

			if (!permissions.granted) {
				return
			}

			if (!config.cellular && netState.type === "cellular") {
				return
			}

			if (!config.lowBattery) {
				const lowPowerMode = await Battery.isLowPowerModeEnabledAsync()

				if (lowPowerMode) {
					return
				}
			}

			await this.syncMutex.acquire()

			useCameraUploadStore.getState().setSyncing(true)

			defer(() => {
				useCameraUploadStore.getState().setSyncing(false)

				this.syncMutex.release()
			})

			// Capture both signals once so that cancel() — which aborts the current
			// controller and creates fresh instances for future syncs — reliably
			// stops every operation in this sync via the captured references,
			// regardless of when during execution cancel() fires.
			const abortController = this.globalAbortController
			const pauseSignal = this.globalPauseSignal

			const allDeltas = await this.deltas({
				config,
				signal: abortController.signal
			})

			// When maxUploads is set (e.g. background sync), sort newest-modified files first so the most
			// recently captured media is prioritised within the limited OS execution window, then cap the
			// list. Without maxUploads (foreground sync) we use the full delta set as-is.
			const deltas = params?.maxUploads
				? allDeltas
						.sort(
							(a, b) =>
								(b.file.info.modificationTime ?? b.file.info.creationTime ?? 0) -
								(a.file.info.modificationTime ?? a.file.info.creationTime ?? 0)
						)
						.slice(0, params.maxUploads)
				: allDeltas

			await Promise.allSettled(
				deltas.map(async delta => {
					const result = await run(async defer => {
						switch (delta.type) {
							case "upload": {
								const assetFile = new FileSystem.File(delta.file.info.uri)

								if (!assetFile.exists) {
									throw new Error(`File does not exist at path: ${delta.file.info.uri}`)
								}

								const tmpFile = new FileSystem.File(
									FileSystem.Paths.join(FileSystem.Paths.cache, `${randomUUID()}${assetFile.extension}`)
								)

								defer(() => {
									if (tmpFile.exists) {
										tmpFile.delete()
									}
								})

								if (tmpFile.exists) {
									tmpFile.delete()
								}

								assetFile.copy(tmpFile)

								let uploadFile = tmpFile

								if (config.compress) {
									uploadFile = await this.compress(tmpFile)
								}

								const parentDir = await this.ensureParentDirectoryExists({
									path: delta.file.path,
									config,
									signal: abortController.signal
								})

								const parentDirEnum = new AnyNormalDir.Dir(parentDir)

								const { files } = await transfers.upload({
									id: delta.file.info.id,
									localFileOrDir: uploadFile,
									parent: parentDirEnum,
									abortController,
									pauseSignal
								})

								await Promise.all(
									files.map(async file =>
										run(async () => {
											// Images use EXIF for the most accurate capture timestamp.
											// Videos don't carry standard EXIF; use media library metadata instead.
											const exifDate =
												delta.file.info.mediaType === MediaLibrary.MediaType.IMAGE
													? parseExifDate(await delta.file.asset.getExif())
													: null

											await drive.updateTimestamps({
												item: unwrappedFileIntoDriveItem(unwrapFileMeta(file)),
												created:
													exifDate ??
													delta.file.info.creationTime ??
													delta.file.info.modificationTime ??
													Date.now(),
												modified:
													delta.file.info.modificationTime ??
													exifDate ??
													delta.file.info.creationTime ??
													Date.now(),
												signal: abortController.signal
											})
										})
									)
								)

								return {
									type: "upload" as const,
									files
								}
							}

							default: {
								throw new Error(`Unknown delta type: ${delta.type}`)
							}
						}
					})

					if (!result.success) {
						console.error(result.error)

						useCameraUploadStore.getState().setErrors(errors => [...errors, result.error])

						return
					}
				})
			)
		})

		if (!result.success) {
			console.error(result.error)

			useCameraUploadStore.getState().setErrors(errors => [...errors, result.error])

			return
		}
	}
}

const cameraUpload = new CameraUpload()

export function useCameraUpload() {
	const syncing = useCameraUploadStore(useShallow(state => state.syncing))
	const errors = useCameraUploadStore(useShallow(state => state.errors))
	const [config, setConfig] = useSecureStore<Config>(cameraUpload.secureStoreKey, DEFAULT_CONFIG)

	const sync = useCallback((params?: Parameters<CameraUpload["sync"]>[0]) => cameraUpload.sync(params), [])
	const cancel = useCallback(() => cameraUpload.cancel(), [])
	const pause = useCallback(() => cameraUpload.pause(), [])
	const resume = useCallback(() => cameraUpload.resume(), [])

	return {
		syncing,
		errors,
		config,
		sync,
		setConfig,
		cancel,
		pause,
		resume
	}
}

export default cameraUpload
