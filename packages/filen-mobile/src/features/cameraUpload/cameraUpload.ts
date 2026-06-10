import * as MediaLibrary from "expo-media-library/next"
import * as MediaLibraryLegacy from "expo-media-library/legacy"
import auth from "@/lib/auth"
import { type FileWithPath, AnyNormalDir, AnyDirWithContext } from "@filen/sdk-rs"
import { normalizeModificationTimestampForComparison } from "@/lib/utils"
import { unwrapFileMeta } from "@/lib/sdkUnwrap"
import { normalizeFilePathForSdk, normalizeFilePathForExpo } from "@/lib/paths"
import { PauseSignal } from "@/lib/signals"
import transfers from "@/features/transfers/transfers"
import * as FileSystem from "expo-file-system"
import { run, Semaphore, fastLocaleCompare } from "@filen/utils"
import useCameraUploadStore from "@/features/cameraUpload/store/useCameraUpload.store"
import secureStore, { useSecureStore } from "@/lib/secureStore"
import { randomUUID } from "expo-crypto"
import { newTmpFile } from "@/lib/tmp"
import { useShallow } from "zustand/shallow"
import { EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS } from "@/constants"
import * as ImageManipulator from "expo-image-manipulator"
import events from "@/lib/events"
import NetInfo from "@react-native-community/netinfo"
import * as Battery from "expo-battery"
import { hasAllNeededMediaPermissions } from "@/hooks/useMediaPermissions"
import cache from "@/lib/cache"
import i18n from "@/lib/i18n"
import { modifyAssetPathOnCollision, sanitizePathSegment, dedupTreeKey, stripFilenameExtension } from "@/features/cameraUpload/cameraUploadHelpers"

export type LocalFile = {
	asset: MediaLibrary.Asset
	info: {
		mediaType: MediaLibrary.MediaType
		filename: string
		creationTime: number | null
		modificationTime: number | null
		id: string
	}
	path: string
	originalPath: string
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
	remoteDir: AnyNormalDir | null
	albumIds: string[]
	activationTimestamp: number
	afterActivation: boolean
	includeVideos: boolean
	cellular: boolean
	background: boolean
	lowBattery: boolean
	compress: boolean
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

type AlbumEntry = {
	id: string
	title: string
}

export const MAX_UPLOAD_FAILURES = 3
// Critical: When changing the config type/object, increment the version to invalidate old configs and clear caches that may contain entries based on the old config structure.
export const VERSION = 1

class CameraUpload {
	private globalAbortController = new AbortController()
	private globalPauseSignal = new PauseSignal()
	private syncing: boolean = false
	private readonly getLocalAssetInfoSemaphore = new Semaphore(32)
	// stagingMutex(4): bounds how many deltas may stage their asset bytes in filen-tmp
	// concurrently (copy → optional compress → upload → deferred cleanup). The SDK already
	// bounds network/memory concurrency internally; this bounds app-side DISK usage so a
	// large pending set cannot stage the whole camera roll at once.
	private readonly stagingMutex = new Semaphore(4)
	private readonly uploadFailures = new Map<string, number>()
	public secureStoreKey: string = `cameraUploadConfig:v${VERSION}`

	private readonly ensureParentDirectoryExistsCache = new Map<
		string,
		{
			value: AnyNormalDir
			expires: number
		}
	>()

	// Dedupes concurrent createDir calls for the same parent before the TTL cache above
	// populates: the first caller creates the promise, the rest await it. Entries remove
	// themselves once settled, so a failed createDir can be retried.
	private readonly ensureParentDirectoryExistsInFlight = new Map<string, Promise<AnyNormalDir>>()

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
		// can block on the old (possibly paused) signal. Free the old signal's SDK
		// handle first — uniffi handles are not GC'd.
		this.globalPauseSignal.dispose()
		this.globalPauseSignal = new PauseSignal()
		this.syncing = false
		this.uploadFailures.clear()

		useCameraUploadStore.getState().clearSkippedAssets()
	}

	public pause(): void {
		this.globalPauseSignal.pause()
	}

	public resume(): void {
		this.globalPauseSignal.resume()
	}

	private async compress(file: FileSystem.File): Promise<FileSystem.File> {
		const extname = FileSystem.Paths.extname(file.uri).toLowerCase()

		if (!EXPO_IMAGE_MANIPULATOR_SUPPORTED_EXTENSIONS.has(extname)) {
			return file
		}

		// Guard: only compress files within the app's cache directory to prevent
		// processing arbitrary paths if this method is ever called with an unexpected input.
		if (!file.uri.startsWith(FileSystem.Paths.cache.uri)) {
			throw new Error(`compress() called on file outside cache directory: ${file.uri}`)
		}

		// Hold the Context in a local binding across the await. expo-image-manipulator's
		// Context overrides sharedObjectDidRelease to cancel its underlying coroutine task;
		// if the chained intermediate ref were eligible for Hermes GC during renderAsync,
		// the native task would be cancelled and renderAsync would reject with
		// JobCancellationException.
		const context = ImageManipulator.ImageManipulator.manipulate(normalizeFilePathForExpo(file.uri))
		const manipulated = await context.renderAsync()
		const result = await manipulated.saveAsync({
			compress: 0.8,
			format: ImageManipulator.SaveFormat.JPEG,
			base64: false
		})

		const manipulatedFile = new FileSystem.File(result.uri)

		if (!manipulatedFile.exists) {
			throw new Error(i18n.t("camera_upload_processing_failed"))
		}

		if (!manipulatedFile.size || !file.size || manipulatedFile.size >= file.size) {
			if (manipulatedFile.exists) {
				manipulatedFile.delete()
			}

			return file
		}

		// The destination is the tmp staging file, which ALWAYS exists by construction
		// (the asset was copied into it before compress() was called). Native copy throws
		// when the destination exists unless overwrite is requested.
		await manipulatedFile.copy(file, {
			overwrite: true
		})

		if (manipulatedFile.exists) {
			manipulatedFile.delete()
		}

		// Correct the extension to .jpg since the content is now JPEG.
		// File.moveSync() updates the uri property in place.
		if (extname !== ".jpg" && extname !== ".jpeg") {
			const newFile = new FileSystem.File(file.uri.replace(/\.[^.]+$/, ".jpg"))

			file.moveSync(newFile)

			return newFile
		}

		return file
	}

	private async listLocal({ config, signal }: { config: Config; signal: AbortSignal }): Promise<LocalTree> {
		const tree: LocalTree = {}

		// Defense-in-depth: config persistence is Set-backed in the album-selection UI,
		// but dedupe here too so a legacy / hand-edited config can't race two iterations
		// into the same tree slot.
		const selectedIds = [...new Set(config.albumIds)]

		if (selectedIds.length === 0) {
			return tree
		}

		// Enumerate ALL device albums up front for two reasons:
		//   1. We get every (id, title) in one call instead of N getTitle() round trips.
		//   2. The bare-title winner among same-titled albums is determined over the
		//      whole device catalogue, not just the currently-selected subset — so
		//      adding/removing an album from the selection does NOT shift another
		//      selected album's folder name.
		// A failure here aborts the whole sync (caller decides). This is intentional:
		// if we can't enumerate albums we can't safely disambiguate, so we'd rather
		// fail loudly than silently drop selected albums.
		// Residual edge cases this approach still cannot stabilize, by design:
		//   - A newly CREATED device album with the same title and a lower id steals
		//     the bare slot (iOS uses random UUIDs, so this is possible on creation).
		//   - Deleting the current bare-title winner from the device lets the next
		//     album by id take the bare slot, causing a one-time re-upload + orphan.
		// Truly stable disambiguation would require persisting (albumId -> folderName)
		// in Config; this implementation does NOT do that.
		const allDeviceAlbums: AlbumEntry[] = (await MediaLibraryLegacy.getAlbumsAsync({ includeSmartAlbums: true })).map(album => ({
			id: album.id,
			title: album.title
		}))

		// Resolve the bare-title winner per canonical title across ALL device albums.
		// Canonical form: trimmed (so " Screenshots " and "Screenshots" don't double-create
		// folders), lowercased (so cross-device casing differences don't split). Empty
		// titles after trimming cannot safely participate in folder naming and are skipped.
		const sortedAllDeviceAlbums = allDeviceAlbums.slice().sort((a, b) => fastLocaleCompare(a.id, b.id))
		const bareTitleWinnerByKey = new Map<string, string>()

		for (const album of sortedAllDeviceAlbums) {
			const canonical = album.title.trim()

			if (canonical.length === 0) {
				continue
			}

			const key = canonical.toLowerCase()

			if (!bareTitleWinnerByKey.has(key)) {
				bareTitleWinnerByKey.set(key, album.id)
			}
		}

		// Project selected ids onto the device catalogue. A selected id that no longer
		// exists on the device (album deleted in Photos but still in our config) is
		// silently skipped — the next sync naturally heals when the UI re-saves the
		// updated selection.
		const deviceAlbumById = new Map<string, AlbumEntry>()

		for (const album of allDeviceAlbums) {
			deviceAlbumById.set(album.id, album)
		}

		const folderTitleByAlbumId = new Map<string, string>()

		for (const id of selectedIds) {
			const deviceAlbum = deviceAlbumById.get(id)

			if (!deviceAlbum) {
				continue
			}

			const canonical = deviceAlbum.title.trim()

			if (canonical.length === 0) {
				console.warn(`[cameraUpload] Skipping selected album ${id}: title is empty after trim.`)

				continue
			}

			const sanitizedTitle = sanitizePathSegment(canonical)
			const winnerId = bareTitleWinnerByKey.get(canonical.toLowerCase())
			const folderTitle = winnerId === id ? sanitizedTitle : `${sanitizedTitle} (${sanitizePathSegment(id)})`

			folderTitleByAlbumId.set(id, folderTitle)
		}

		// Enumeration failures must not vanish silently: an asset (or whole album) whose
		// info fetch persistently fails would otherwise be permanently excluded from backup
		// with zero signal. Each rejection below is surfaced once per sync pass into the
		// same error store the cameraUploadErrors screen reads, while the failing entry is
		// still (correctly) excluded from the tree. The set dedupes assets that belong to
		// several selected albums.
		const reportedFailedAssetIds = new Set<string>()

		const albumEntries = Array.from(folderTitleByAlbumId.entries())
		const albumResults = await Promise.allSettled(
			albumEntries.map(async ([id, folderTitle]) => {
				const album = new MediaLibrary.Album(id)

				// Phase 1: query assets with native-level filters to avoid fetching
				// info for assets that would be discarded by includeVideos/afterActivation.
				let query = new MediaLibrary.Query().album(album)

				if (!config.includeVideos) {
					query = query.within(MediaLibrary.AssetField.MEDIA_TYPE, [MediaLibrary.MediaType.IMAGE])
				} else {
					query = query.within(MediaLibrary.AssetField.MEDIA_TYPE, [MediaLibrary.MediaType.IMAGE, MediaLibrary.MediaType.VIDEO])
				}

				if (config.afterActivation) {
					query = query.gte(MediaLibrary.AssetField.CREATION_TIME, config.activationTimestamp)
				}

				const assets = await query.exe()

				// Phase 1.5: fetch asset infos concurrently (rate-limited by semaphore).
				const infoResults = await Promise.allSettled(
					assets.map(async asset => {
						const result = await run(async defer => {
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

							const [filename, creationTime, modificationTime, mediaType] = await Promise.all([
								asset.getFilename(),
								asset.getCreationTime(),
								asset.getModificationTime(),
								asset.getMediaType()
							])

							return {
								asset,
								info: {
									id: asset.id,
									filename,
									creationTime,
									modificationTime,
									mediaType
								}
							}
						})

						if (!result.success) {
							throw result.error
						}

						return result.data
					})
				)

				const infos = infoResults.filter(result => result.status === "fulfilled").map(result => result.value)

				// Surface per-asset enumeration failures (once per asset per pass) into the
				// error store, then keep them out of the tree below. Abort-driven rejections
				// are teardown, not failures, and are skipped.
				for (let index = 0; index < infoResults.length; index++) {
					const result = infoResults[index]

					if (!result || result.status !== "rejected") {
						continue
					}

					const failedAsset = assets[index]

					if (signal.aborted || !failedAsset || reportedFailedAssetIds.has(failedAsset.id)) {
						continue
					}

					reportedFailedAssetIds.add(failedAsset.id)

					console.error(result.reason)

					useCameraUploadStore.getState().setErrors(errors => [
						...errors,
						{
							id: randomUUID(),
							timestamp: Date.now(),
							error: result.reason,
							asset: failedAsset
						}
					])
				}

				// Phase 2: sort by creationTime ascending before building the tree.
				// On iOS, asset filenames cycle (IMG_0001 … IMG_9999 → IMG_0001 …), so multiple
				// assets can share the same filename. Because getInfo() resolves in non-deterministic
				// order, building the tree directly inside Promise.all produces a different
				// winner for the base path slot on each run, causing re-uploads on every sync.
				// Sorting first ensures the oldest asset always wins the base slot and newer
				// duplicates consistently receive a collision suffix – stable across runs.
				// Filename is used as tiebreaker so both local and remote trees resolve
				// equal creationTimes in the same order.
				//
				// Timestamps are floored to seconds before comparison so that sub-second
				// rounding differences between the local PHAsset timestamp and the server's
				// stored value (after EXIF-override or network round-trip) do not produce
				// different orderings across syncs. #14: null creationTime falls back to 0
				// ONLY (NOT to modificationTime) so the key is symmetric with the remote
				// side, which has no modificationTime to consult — a modificationTime
				// fallback here would make the same null-creation asset hash differently
				// local vs remote and re-evaluate every sync.
				infos.sort((a, b) => {
					const tA = Math.floor((a.info.creationTime ?? 0) / 1000)
					const tB = Math.floor((b.info.creationTime ?? 0) / 1000)
					const timeDiff = tA - tB

					if (timeDiff !== 0) {
						return timeDiff
					}

					return fastLocaleCompare(a.info.filename, b.info.filename)
				})

				// Phase 3: build tree sequentially so collision resolution is deterministic.
				for (const { asset, info } of infos) {
					const originalPath = normalizeFilePathForSdk(FileSystem.Paths.join(folderTitle, info.filename)).trim()
					// #15: when compress is enabled the upload may rewrite the extension
					// (e.g. .png → .jpg), so the dedup key is made extension-agnostic here
					// and symmetrically on the remote side. The collision-suffix name is
					// likewise stripped of its extension so the suffix path stays symmetric.
					const fullPath = normalizeFilePathForSdk(FileSystem.Paths.join(folderTitle, info.filename)).toLowerCase().trim()
					let path = dedupTreeKey({ path: fullPath, compress: config.compress })
					const collisionName = config.compress ? stripFilenameExtension(info.filename) : info.filename
					let iteration = 0

					// Use a seconds-floored creation timestamp as the collision identity.
					// Flooring to seconds absorbs sub-second drift from EXIF-override or
					// network round-trips, keeping local and remote trees symmetric without
					// any per-asset file read at listing time. #14: null creationTime falls
					// back to 0 ONLY (NOT to modificationTime) so it matches the remote
					// side, which has no modificationTime to consult.
					const localContentHash = String(Math.floor((info.creationTime ?? 0) / 1000))

					while (tree[path]) {
						path =
							modifyAssetPathOnCollision({
								iteration,
								path,
								asset: {
									name: collisionName,
									contentHash: localContentHash
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
						path,
						originalPath
					}
				}
			})
		)

		// Surface per-album enumeration failures: a whole album whose query rejected is
		// absent from the tree this pass, which must not stay invisible. The album title
		// identifies the failing album in the recorded entry (album entries are unique per
		// pass, so this is naturally one entry per failing album per sync).
		for (let index = 0; index < albumResults.length; index++) {
			const result = albumResults[index]
			const entry = albumEntries[index]

			if (!result || result.status !== "rejected" || !entry || signal.aborted) {
				continue
			}

			console.error(result.reason)

			useCameraUploadStore.getState().setErrors(errors => [
				...errors,
				{
					id: randomUUID(),
					timestamp: Date.now(),
					error: new Error(
						i18n.t("camera_upload_album_listing_failed", {
							album: entry[1]
						})
					)
				}
			])
		}

		return tree
	}

	private async listRemote({
		remoteDir,
		signal,
		compress
	}: {
		remoteDir: AnyNormalDir
		signal: AbortSignal
		compress: boolean
	}): Promise<RemoteTree> {
		const { authedSdkClient } = await auth.getSdkClients()
		// Per the SDK contract, entries inside errored subtrees are silently ABSENT from
		// the listing while the call still resolves Ok — collect the scan errors instead
		// of discarding them.
		const scanErrors: unknown[] = []
		const { files } = await authedSdkClient.listDirRecursiveWithPaths(
			new AnyDirWithContext.Normal(remoteDir),
			{
				onProgress() {
					// Noop
				}
			},
			{
				onErrors(errors) {
					scanErrors.push(...errors)
				}
			},
			{
				signal
			}
		)

		// A degraded listing must not be silently authoritative: the diff would see the
		// local counterparts of the missing entries as "missing remotely" and re-upload
		// them. Surface ONE degraded-listing error per pass and PROCEED — a permanent scan
		// error must not stop camera backup forever. The md5 gate shields re-uploads of
		// anything this device already uploaded; the residual risk is version churn on
		// fresh devices, accepted and surfaced here.
		if (scanErrors.length > 0 && !signal.aborted) {
			console.error("[cameraUpload] Remote listing degraded by scan errors:", scanErrors)

			useCameraUploadStore.getState().setErrors(errors => [
				...errors,
				{
					id: randomUUID(),
					timestamp: Date.now(),
					error: new Error(i18n.t("camera_upload_remote_listing_incomplete"))
				}
			])
		}

		const tree: RemoteTree = {}

		// Pre-unwrap metadata and sort by creationTime ascending with filename as tiebreaker,
		// mirroring the listLocal sort order. The server does not guarantee a stable return
		// order, so without sorting, collision resolution would assign different path slots
		// to the same files across runs, causing spurious re-uploads.
		//
		// Timestamps are floored to seconds before comparison to match the listLocal
		// sort behaviour and absorb sub-second drift introduced by EXIF-override or
		// network round-trips.  Null meta falls back to 0, mirroring the local side.
		const sortedFiles = files
			.map(file => ({
				file,
				meta: unwrapFileMeta(file.file).meta
			}))
			.sort((a, b) => {
				const tA = Math.floor(Number(a.meta?.created ?? 0) / 1000)
				const tB = Math.floor(Number(b.meta?.created ?? 0) / 1000)
				const timeDiff = tA - tB

				if (timeDiff !== 0) {
					return timeDiff
				}

				return fastLocaleCompare(a.meta?.name ?? "", b.meta?.name ?? "")
			})

		for (const { file, meta } of sortedFiles) {
			const fullPath = normalizeFilePathForSdk(file.path).toLowerCase().trim()
			// #15: mirror listLocal — when compress is enabled, the remote filename may
			// be the compressed `.jpg` (or the original extension when compression lost),
			// so the dedup key is made extension-agnostic and the collision-suffix name is
			// stripped of its extension. This keeps the remote key symmetric with the local
			// stem-based key for the same physical asset.
			let path = dedupTreeKey({ path: fullPath, compress })
			const remoteName = meta?.name ?? FileSystem.Paths.basename(fullPath)
			const collisionName = compress ? stripFilenameExtension(remoteName) : remoteName
			let iteration = 0

			// Use a seconds-floored creation timestamp as the contentHash, matching
			// the local listLocal computation exactly for symmetric collision resolution.
			const remoteContentHash = String(Math.floor(Number(meta?.created ?? 0) / 1000))

			while (tree[path]) {
				path =
					modifyAssetPathOnCollision({
						iteration,
						path,
						asset: {
							name: collisionName,
							contentHash: remoteContentHash
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
				signal,
				compress: config.compress
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
					remoteFileMeta.meta?.modified != null &&
					localFile.info.modificationTime != null &&
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

	private async ensureParentDirectoryExists({
		config,
		signal,
		originalPath
	}: {
		config: Config
		signal: AbortSignal
		originalPath: string
	}): Promise<AnyNormalDir> {
		if (!config.remoteDir) {
			throw new Error("Remote directory is not set in config")
		}

		const slashCount = originalPath.split("/").length - 1

		if (slashCount <= 1) {
			return config.remoteDir
		}

		if (slashCount !== 2) {
			throw new Error(i18n.t("error_generic"))
		}

		const parentDirName = FileSystem.Paths.dirname(originalPath).replace(/\//g, "")
		const cacheKey = `${config.remoteDir.inner[0].uuid}:${parentDirName.toLowerCase().trim()}`
		const entry = this.ensureParentDirectoryExistsCache.get(cacheKey)

		if (entry && entry.expires > Date.now()) {
			return entry.value
		}

		this.ensureParentDirectoryExistsCache.delete(cacheKey)

		if (parentDirName.length === 0 || parentDirName === ".") {
			throw new Error(i18n.t("error_generic"))
		}

		// Dedupe concurrent createDir calls for the same parent: before the TTL cache
		// populates, every concurrent delta for one album fired its own createDir round
		// trip (server-side get-or-create under a global drive lock — correct, but N
		// serialized round trips). The first caller creates the in-flight promise, the
		// rest await it; a failed promise is removed in the finally below so retries work.
		const inFlight = this.ensureParentDirectoryExistsInFlight.get(cacheKey)

		if (inFlight) {
			return await inFlight
		}

		const remoteDir = config.remoteDir
		const promise = (async () => {
			const { authedSdkClient } = await auth.getSdkClients()
			const dir = new AnyNormalDir.Dir(
				await authedSdkClient.createDir(remoteDir, parentDirName, {
					signal
				})
			)

			this.ensureParentDirectoryExistsCache.set(cacheKey, { value: dir, expires: Date.now() + 60000 })

			return dir
		})()

		this.ensureParentDirectoryExistsInFlight.set(cacheKey, promise)

		try {
			return await promise
		} finally {
			// Only remove the entry if it is still OUR promise, so a slow settle cannot
			// evict a newer in-flight created after this one finished.
			if (this.ensureParentDirectoryExistsInFlight.get(cacheKey) === promise) {
				this.ensureParentDirectoryExistsInFlight.delete(cacheKey)
			}
		}
	}

	public async sync(params?: { maxUploads?: number; background?: boolean }): Promise<void> {
		// Capture both signals once so that cancel() — which aborts the current
		// controller and creates fresh instances for future syncs — reliably
		// stops every operation in this sync via the captured references,
		// regardless of when during execution cancel() fires.
		const abortController = this.globalAbortController
		const pauseSignal = this.globalPauseSignal

		const result = await run(async defer => {
			if (this.syncing) {
				return
			}

			this.syncing = true

			defer(() => {
				this.syncing = false
			})

			const config = await this.getConfig()

			if (!config.enabled || config.albumIds.length === 0 || !config.remoteDir) {
				return
			}

			if (params?.background && !config.background) {
				return
			}

			const [netState, permissions] = await Promise.all([NetInfo.fetch(), hasAllNeededMediaPermissions({ library: "all", needCamera: false })])

			if (!permissions) {
				return
			}

			// Camera upload requires server reachability for listing + uploading.
			// Without it, every listRemote / createDir / transfers.upload call
			// fails into useCameraUploadStore.errors and surfaces banners. Bail
			// silently when offline; the next AppState→active wake-up (which
			// happens after reconnect) retries cleanly.
			if (!netState.isConnected || !netState.isInternetReachable) {
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

			// Update UI state
			useCameraUploadStore.getState().setSyncing(true)

			defer(() => {
				useCameraUploadStore.getState().setSyncing(false)
			})

			const allDeltas = await this.deltas({
				config: params?.background
					? {
							...config,
							includeVideos: false
						}
					: config,
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
					const assetId = delta.file.info.id

					if ((this.uploadFailures.get(assetId) ?? 0) >= MAX_UPLOAD_FAILURES) {
						useCameraUploadStore.getState().addSkippedAsset(assetId)

						return
					}

					const result = await run(async defer => {
						switch (delta.type) {
							case "upload": {
								const uri = await delta.file.asset.getUri()

								if (!uri) {
									throw new Error(i18n.t("camera_upload_file_missing"))
								}

								const assetFile = new FileSystem.File(uri)

								if (!assetFile.exists) {
									throw new Error(i18n.t("camera_upload_file_missing"))
								}

								const md5 = assetFile.md5

								if (!md5) {
									throw new Error(i18n.t("camera_upload_processing_failed"))
								}

								if (md5 === cache.cameraUploadHashes.get(delta.file.path)) {
									break
								}

								// Bound the staged-on-disk set: without this, every pending delta
								// copied its full asset into filen-tmp before its upload got an SDK
								// slot, staging the whole camera roll at once. run() executes
								// deferred functions LIFO, so this release runs AFTER the tmp-file
								// cleanup registered below — the slot is freed only once the staged
								// bytes are gone, keeping disk usage truly bounded.
								await this.stagingMutex.acquire()

								defer(() => {
									this.stagingMutex.release()
								})

								// Create the staging tmp file WITH the original extension so that
								// compress() can pass the supported-extension gate (it checks
								// extname(file.uri) — a bare UUID with no extension always fails).
								const srcExt = FileSystem.Paths.extname(delta.file.info.filename).toLowerCase()
								const tmpFile = newTmpFile(`${randomUUID()}${srcExt}`)

								defer(() => {
									if (tmpFile.exists) {
										tmpFile.delete()
									}
								})

								if (tmpFile.exists) {
									tmpFile.delete()
								}

								await assetFile.copy(tmpFile)

								let uploadFile = tmpFile

								if (config.compress) {
									uploadFile = await this.compress(tmpFile)
								}

								// When compress() rewrites the content to JPEG (e.g. .png → .jpg),
								// it renames the file to have a .jpg extension.  Mirror that rename
								// in the upload's `name` parameter so the remote filename and MIME
								// type stay consistent with the actual bytes.
								const uploadExt = FileSystem.Paths.extname(uploadFile.uri).toLowerCase()
								const uploadName =
									uploadExt !== "" && uploadExt !== srcExt
										? `${FileSystem.Paths.basename(delta.file.info.filename, FileSystem.Paths.extname(delta.file.info.filename))}${uploadExt}`
										: delta.file.info.filename

								const parentDir = await this.ensureParentDirectoryExists({
									config,
									signal: abortController.signal,
									originalPath: delta.file.originalPath
								})

								const transferResult = await transfers.upload({
									localFileOrDir: uploadFile,
									parent: parentDir,
									signal: abortController.signal,
									pauseSignal,
									name: uploadName,
									modified: delta.file.info.modificationTime ?? delta.file.info.creationTime ?? undefined,
									created: delta.file.info.creationTime ?? delta.file.info.modificationTime ?? undefined,
									hideProgress: params?.background ?? undefined
								})

								if (!transferResult) {
									break
								}

								cache.cameraUploadHashes.set(delta.file.path, md5)

								break
							}

							default: {
								throw new Error(i18n.t("error_generic"))
							}
						}
					})

					if (!result.success) {
						if (abortController.signal.aborted) {
							return
						}

						this.uploadFailures.set(assetId, (this.uploadFailures.get(assetId) ?? 0) + 1)

						console.error(result.error)

						useCameraUploadStore.getState().setErrors(errors => [
							...errors,
							{
								id: randomUUID(),
								timestamp: Date.now(),
								error: result.error,
								asset: delta.file.asset
							}
						])

						return
					}
				})
			)
		})

		if (!result.success) {
			if (abortController.signal.aborted) {
				return
			}

			console.error(result.error)

			useCameraUploadStore.getState().setErrors(errors => [
				...errors,
				{
					id: randomUUID(),
					timestamp: Date.now(),
					error: result.error
				}
			])

			return
		}
	}
}

const cameraUpload = new CameraUpload()

export function useCameraUploadConfig() {
	const [config, setConfig] = useSecureStore<Config>(cameraUpload.secureStoreKey, DEFAULT_CONFIG)

	return { config, setConfig }
}

export function useCameraUpload() {
	const syncing = useCameraUploadStore(useShallow(state => state.syncing))
	const errors = useCameraUploadStore(useShallow(state => state.errors))
	const [config, setConfig] = useSecureStore<Config>(cameraUpload.secureStoreKey, DEFAULT_CONFIG)

	const sync = (params?: Parameters<CameraUpload["sync"]>[0]) => cameraUpload.sync(params)
	const cancel = () => cameraUpload.cancel()
	const pause = () => cameraUpload.pause()
	const resume = () => cameraUpload.resume()

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
