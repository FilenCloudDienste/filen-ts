import * as MediaLibrary from "expo-media-library/next"
import auth from "@/lib/auth"
import { type Dir, AnyDirEnum, type FileWithPath, DirEnum } from "@filen/sdk-rs"
import { PauseSignal, normalizeFilePathForSdk, unwrapFileMeta, normalizeFilePathForExpo } from "@/lib/utils"
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

export type Config =
	| {
			enabled: false
	  }
	| {
			enabled: true
			remoteDir: Dir
			albums: MediaLibrary.Album[]
			activationTimestamp: number
			afterActivation: boolean
			includeVideos: boolean
			cellular: boolean
			background: boolean
			lowBattery: boolean
			compress: boolean
	  }

class CameraUpload {
	private globalAbortController = new AbortController()
	private globalPauseSignal = new PauseSignal()
	private syncMutex: Semaphore = new Semaphore(1)
	public secureStoreKey: string = "cameraUploadConfig"
	private readonly getLocalAssetInfoSemaphore = new Semaphore(32)

	public constructor() {
		events.subscribe("secureStoreChange", ({ key }) => {
			if (key === this.secureStoreKey) {
				this.cancel()
			}
		})

		events.subscribe("secureStoreClear", () => {
			this.cancel()
		})

		events.subscribe("secureStoreRemove", ({ key }) => {
			if (key === this.secureStoreKey) {
				this.cancel()
			}
		})
	}

	public cancel(): void {
		this.globalAbortController.abort()
		this.globalAbortController = new AbortController()
	}

	public pause(): void {
		this.globalPauseSignal.pause()
	}

	public resume(): void {
		this.globalPauseSignal.resume()
	}

	public async compress(file: FileSystem.File): Promise<void> {
		const extname = pathModule.posix.extname(file.uri).toLowerCase()

		if (!EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS.includes(extname)) {
			return
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
			// If the manipulated file is larger than the original, delete it
			if (manipulatedFile.exists) {
				manipulatedFile.delete()
			}

			return
		}

		if (file.exists) {
			file.delete()
		}

		manipulatedFile.move(file)
	}

	private normalizeModificationTimestampForComparison(timestamp: number): number {
		return Math.floor(timestamp / 1000)
	}

	private modifyAssetPathOnCollision(
		iteration: number,
		path: string,
		asset: {
			name: string
			creationTime: number
			modificationTime: number
		}
	): string | null {
		const ext = pathModule.posix.extname(asset.name)
		const basename = pathModule.posix.basename(asset.name, ext)
		const parentDir = pathModule.posix.dirname(path)

		if (parentDir === "." || basename.length === 0 || parentDir.length === 0 || basename === ".") {
			return null
		}

		switch (iteration) {
			case 0: {
				return normalizeFilePathForSdk(pathModule.posix.join(parentDir, `${basename}_${asset.modificationTime}${ext}`))
					.toLowerCase()
					.trim()
			}

			case 1: {
				return normalizeFilePathForSdk(
					pathModule.posix.join(parentDir, `${basename}_${xxHash32(asset.modificationTime.toString()).toString(16)}${ext}`)
				)
					.toLowerCase()
					.trim()
			}

			case 2: {
				return normalizeFilePathForSdk(pathModule.posix.join(parentDir, `${basename}_${asset.creationTime}${ext}`))
					.toLowerCase()
					.trim()
			}

			case 3: {
				return normalizeFilePathForSdk(
					pathModule.posix.join(parentDir, `${basename}_${xxHash32(asset.creationTime.toString()).toString(16)}${ext}`)
				)
					.toLowerCase()
					.trim()
			}

			default: {
				return null
			}
		}
	}

	private async listLocal(albums: MediaLibrary.Album[]): Promise<LocalTree> {
		const tree: LocalTree = {}

		await Promise.all(
			albums.map(async album => {
				const [title, assets] = await Promise.all([album.getTitle(), album.getAssets()])

				// Phase 1: fetch all asset infos concurrently (rate-limited by semaphore).
				const infos = await Promise.all(
					assets.map(async asset => {
						const result = await run(
							async defer => {
								await this.getLocalAssetInfoSemaphore.acquire()

								defer(() => {
									this.getLocalAssetInfoSemaphore.release()
								})

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
				// asset.id (localIdentifier) is used as a tiebreaker so equal creationTimes
				// are also resolved deterministically.
				infos.sort((a, b) => {
					const timeDiff = (a.info.creationTime ?? 0) - (b.info.creationTime ?? 0)

					if (timeDiff !== 0) {
						return timeDiff
					}

					return fastLocaleCompare(a.asset.id, b.asset.id)
				})

				// Phase 3: build tree sequentially so collision resolution is deterministic.
				for (const { asset, info } of infos) {
					let path = normalizeFilePathForSdk(pathModule.posix.join(title, info.filename)).toLowerCase().trim()
					let iteration = 0

					while (tree[path]) {
						path =
							this.modifyAssetPathOnCollision(iteration, path, {
								name: info.filename,
								creationTime: info.creationTime ?? 0,
								modificationTime: info.modificationTime ?? 0
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

	private async listRemote(remoteDir: Dir, signal?: AbortSignal): Promise<RemoteTree> {
		const { authedSdkClient } = await auth.getSdkClients()
		const { files } = await authedSdkClient.listDirRecursiveWithPaths(
			new AnyDirEnum.Dir(remoteDir),
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
				signal: signal ?? this.globalAbortController.signal
			}
		)

		const tree: RemoteTree = {}

		// Pre-unwrap metadata and sort by creationTime ascending with UUID as tiebreaker,
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

				return fastLocaleCompare(a.file.file.uuid, b.file.file.uuid)
			})

		for (const { file, meta } of sortedFiles) {
			let path = normalizeFilePathForSdk(file.path).toLowerCase().trim()
			let iteration = 0

			while (tree[path]) {
				path =
					this.modifyAssetPathOnCollision(iteration, path, {
						name: meta?.name ?? pathModule.posix.basename(path),
						creationTime: meta ? Number(meta.created) : 0,
						modificationTime: meta ? Number(meta.modified) : 0
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

	private async deltas(config: Config, signal?: AbortSignal): Promise<Delta[]> {
		if (!config.enabled) {
			return []
		}

		const [localTree, remoteTree] = await Promise.all([this.listLocal(config.albums), this.listRemote(config.remoteDir, signal)])
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
					this.normalizeModificationTimestampForComparison(Number(remoteFileMeta.meta.modified)) <
						this.normalizeModificationTimestampForComparison(localFile.info.modificationTime))
			) {
				if (
					(!config.includeVideos && localFile.info.mediaType === MediaLibrary.MediaType.VIDEO) ||
					(config.afterActivation && localFile.info.creationTime && localFile.info.creationTime < config.activationTimestamp)
				) {
					continue
				}

				deltas.push({
					type: "upload",
					file: localFile
				})
			}
		}

		return deltas
	}

	private async getConfig(): Promise<Config> {
		const config = await secureStore.get<Config>(this.secureStoreKey)

		if (!config) {
			return {
				enabled: false
			}
		}

		return config
	}

	public async setConfig(fn: Config | ((prev: Config) => Config)): Promise<void> {
		const currentConfig = await this.getConfig()
		const newConfig = typeof fn === "function" ? fn(currentConfig) : fn

		await secureStore.set(this.secureStoreKey, newConfig)
	}

	public async sync(params?: { signal?: AbortSignal; maxUploads?: number }): Promise<void> {
		const result = await run(async defer => {
			const config = await this.getConfig()

			if (!config.enabled || config.albums.length === 0) {
				return
			}

			await this.syncMutex.acquire()

			useCameraUploadStore.getState().setSyncing(true)

			defer(() => {
				useCameraUploadStore.getState().setSyncing(false)

				this.syncMutex.release()
			})

			const remoteDirEnum = new DirEnum.Dir(config.remoteDir)
			const allDeltas = await this.deltas(config, params?.signal ?? this.globalAbortController.signal)

			// When maxUploads is set (e.g. background sync), sort newest-modified files first so the most
			// recently captured media is prioritised within the limited OS execution window, then cap the
			// list. Without maxUploads (foreground sync) we use the full delta set as-is.
			const deltas =
				params?.maxUploads !== undefined
					? allDeltas
							.sort((a, b) => (b.file.info.modificationTime ?? 0) - (a.file.info.modificationTime ?? 0))
							.slice(0, params.maxUploads)
					: allDeltas

			await Promise.all(
				deltas.map(async delta => {
					const result = await run(async defer => {
						switch (delta.type) {
							case "upload": {
								const assetFile = new FileSystem.File(delta.file.info.uri)

								if (!assetFile.exists) {
									throw new Error(`File does not exist at path: ${delta.file.info.uri}`)
								}

								const tmpFile = new FileSystem.File(
									FileSystem.Paths.join(FileSystem.Paths.cache, randomUUID(), delta.file.info.filename)
								)

								defer(() => {
									if (tmpFile.parentDirectory.exists) {
										tmpFile.parentDirectory.delete()
									}
								})

								if (!tmpFile.parentDirectory.exists) {
									tmpFile.parentDirectory.create({
										intermediates: true,
										idempotent: true
									})
								}

								assetFile.copy(tmpFile)

								if (config.compress) {
									await this.compress(tmpFile)
								}

								// TODO: create parent dir (album title) first and then upload into it
								const { files } = await transfers.upload({
									id: delta.file.info.id,
									localFileOrDir: tmpFile,
									parent: remoteDirEnum,
									abortController: this.globalAbortController,
									pauseSignal: this.globalPauseSignal
								})

								// TODO update file timestamps based on exif > info

								return {
									type: "upload" as const,
									files
								}
							}
						}
					})

					if (!result.success) {
						console.error(result.error)

						useCameraUploadStore.getState().setErrors(errors => [...errors, result.error])

						return
					}

					return result.data
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
	const config = useSecureStore<Config>(cameraUpload.secureStoreKey, {
		enabled: false
	})

	return {
		syncing,
		errors,
		config,
		sync: () => cameraUpload.sync(),
		setConfig: (params: Parameters<CameraUpload["setConfig"]>[0]) => cameraUpload.setConfig(params),
		cancel: () => cameraUpload.cancel(),
		pause: () => cameraUpload.pause(),
		resume: () => cameraUpload.resume()
	}
}

export default cameraUpload
