import * as MediaLibrary from "expo-media-library/next"
import * as MediaLibraryLegacy from "expo-media-library/legacy"
import auth from "@/lib/auth"
import { type FileWithPath, AnyNormalDir, AnyNormalDir_Tags, AnyDirWithContext } from "@filen/sdk-rs"
import { normalizeModificationTimestampForComparison } from "@/lib/utils"
import { type UnwrapFileMetaResult, unwrapFileMeta } from "@/lib/sdkUnwrap"
import { normalizeFilePathForExpo } from "@/lib/paths"
import { isConvertHeicToJpgEnabled, convertHeicToJpg } from "@/lib/imageConversion"
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
import {
	modifyAssetPathOnCollision,
	collisionNameSuffix,
	albumFolderTitle,
	dedupTreeKey,
	stripFilenameExtension,
	effectiveCreationTimestamp,
	composeLocalTreePath,
	rawRemoteTreePath,
	normalizeCameraUploadHashEntry,
	isDirUsable,
	CAMERA_UPLOAD_REUPLOAD_DELETED_SECURE_STORE_KEY
} from "@/features/cameraUpload/cameraUploadHelpers"

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
	// #B2: the collision suffix this asset's tree key carries ("" for the base slot).
	// The upload pipeline appends it to the uploaded filename so the remote listing
	// reproduces the local key.
	collisionSuffix: string
}

export type RemoteFile = FileWithPath

export type LocalTree = Record<string, LocalFile>
export type RemoteTree = Record<string, RemoteFile>

// A listing plus whether it is KNOWN to be incomplete (enumeration/scan failures).
// A degraded listing's absences are not evidence of deletion — pruning and
// mirror-mode drops must only act on clean listings.
export type LocalListing = {
	tree: LocalTree
	degraded: boolean
}

export type RemoteListing = {
	tree: RemoteTree
	degraded: boolean
}

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
// Background runs skip assets with this many persisted budget-aborts (audit B4) — they
// upload on the next FOREGROUND sync, which has no run budget. Cleared on success.
export const MAX_BACKGROUND_UPLOAD_ABORTS = 2
// Critical: When changing the config type/object, increment the version to invalidate old
// CONFIGS (the secureStore key below rotates with it). Note this does NOT touch
// `cache.cameraUploadHashes` — that map lives under cache.ts's own versioned prefix and is
// never rotated from here; its value-shape changes rely on in-place lazy migration instead
// (see CameraUploadHashEntry / normalizeCameraUploadHashEntry).
export const VERSION = 1

// Width of the per-album asset-info worker pool in listLocal. Bounds concurrent
// native getInfo round trips without a Semaphore: a shared semaphore queued ONE
// pending acquire per asset beyond the width, and its FIFO waiter array shift()s
// per release — O(n²) churn at camera-roll scale.
const LOCAL_ASSET_INFO_CONCURRENCY = 32

// Width of the per-delta upload worker pool in sync(). Bounds the pre-staging
// probes (getUri/md5) and keeps the stagingMutex(4) waiter queue at O(width)
// instead of O(deltas) — the mutex itself remains the binding bound for
// staged-on-disk bytes (#B5).
const UPLOAD_PIPELINE_CONCURRENCY = 16

// listRemote unwraps every listed file once for its pre-sort pass; deltas() needs
// the same unwrap again for every matched path. Cache the result per file object
// so the diff loop reuses it instead of re-unwrapping O(n) times — entries die
// with the listing objects.
const remoteFileMetaCache = new WeakMap<object, UnwrapFileMetaResult>()

class CameraUpload {
	private globalAbortController = new AbortController()
	private globalPauseSignal = new PauseSignal()
	private syncing: boolean = false
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
		// File.move() updates the uri property in place.
		if (extname !== ".jpg" && extname !== ".jpeg") {
			const newFile = new FileSystem.File(file.uri.replace(/\.[^.]+$/, ".jpg"))

			await file.move(newFile)

			return newFile
		}

		return file
	}

	private async listLocal({
		config,
		convertHeic,
		signal
	}: {
		config: Config
		convertHeic: boolean
		signal: AbortSignal
	}): Promise<LocalListing> {
		const tree: LocalTree = {}
		// Set when any album query or asset-info fetch fails (abort-driven teardown
		// excluded): the tree is then known-incomplete and its absences must not be
		// treated as "asset gone from device" by the md5-cache pruning.
		let degraded = false

		// Defense-in-depth: config persistence is Set-backed in the album-selection UI,
		// but dedupe here too so a legacy / hand-edited config can't race two iterations
		// into the same tree slot.
		const selectedIds = [...new Set(config.albumIds)]

		if (selectedIds.length === 0) {
			return {
				tree,
				degraded
			}
		}

		// Resolve every device album's (id, title) in one call so selected ids map to
		// their titles. includeSmartAlbums so a selected smart album resolves too. A
		// failure here aborts the whole sync (caller decides): if we can't enumerate
		// albums we can't name folders, so we fail loudly rather than silently drop
		// selected albums. A selected id no longer on the device (album deleted in Photos
		// but still in our config) is skipped below; the next sync heals when the UI
		// re-saves the selection.
		const deviceAlbumById = new Map<string, AlbumEntry>()

		for (const album of await MediaLibraryLegacy.getAlbumsAsync({ includeSmartAlbums: true })) {
			deviceAlbumById.set(album.id, {
				id: album.id,
				title: album.title
			})
		}

		const folderTitleByAlbumId = new Map<string, string>()

		for (const id of selectedIds) {
			const deviceAlbum = deviceAlbumById.get(id)

			if (!deviceAlbum) {
				continue
			}

			// Folder = the album's (trimmed) title; same-titled albums deliberately share
			// one folder (legacy-compatible — see albumFolderTitle). Empty-after-trim
			// titles can't form a valid segment and are skipped.
			const folderTitle = albumFolderTitle(deviceAlbum.title)

			if (folderTitle === null) {
				console.warn(`[cameraUpload] Skipping selected album ${id}: title is empty after trim.`)

				continue
			}

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

				// Phase 1.5: fetch asset infos concurrently, bounded by an index-cursor
				// worker pool (LOCAL_ASSET_INFO_CONCURRENCY workers pulling the next
				// index). Results land in a slot per asset, so the array stays aligned
				// with `assets` exactly like the previous Promise.allSettled shape —
				// the failure-surfacing loop below depends on that alignment. Aborts
				// reject with the same Error("Aborted") the old path threw.
				const infoResults: PromiseSettledResult<{
					asset: MediaLibrary.Asset
					info: LocalFile["info"]
				}>[] = new Array(assets.length)
				let nextAssetIndex = 0

				const infoWorker = async (): Promise<void> => {
					while (true) {
						const index = nextAssetIndex++

						if (index >= assets.length) {
							return
						}

						const asset = assets[index] as MediaLibrary.Asset

						if (signal.aborted) {
							infoResults[index] = {
								status: "rejected",
								reason: new Error("Aborted")
							}

							continue
						}

						try {
							const [filename, creationTime, modificationTime, mediaType] = await Promise.all([
								asset.getFilename(),
								asset.getCreationTime(),
								asset.getModificationTime(),
								asset.getMediaType()
							])

							infoResults[index] = {
								status: "fulfilled",
								value: {
									asset,
									info: {
										id: asset.id,
										filename,
										creationTime,
										modificationTime,
										mediaType
									}
								}
							}
						} catch (error) {
							infoResults[index] = {
								status: "rejected",
								reason: error
							}
						}
					}
				}

				const infoWorkers: Promise<void>[] = []
				const infoWorkerCount = Math.min(LOCAL_ASSET_INFO_CONCURRENCY, assets.length)

				for (let workerIndex = 0; workerIndex < infoWorkerCount; workerIndex++) {
					infoWorkers.push(infoWorker())
				}

				await Promise.all(infoWorkers)

				// Single pass over the settled results, precomputing each entry's
				// floored-seconds sort key once — the comparator below otherwise
				// recomputes it O(n log n) times.
				const infos: {
					asset: MediaLibrary.Asset
					info: LocalFile["info"]
					sortSec: number
				}[] = []

				for (const result of infoResults) {
					if (result.status === "fulfilled") {
						infos.push({
							asset: result.value.asset,
							info: result.value.info,
							sortSec: Math.floor(effectiveCreationTimestamp(result.value.info) / 1000)
						})
					}
				}

				// Surface per-asset enumeration failures (once per asset per pass) into the
				// error store, then keep them out of the tree below. Abort-driven rejections
				// are teardown, not failures, and are skipped.
				for (let index = 0; index < infoResults.length; index++) {
					const result = infoResults[index]

					if (!result || result.status !== "rejected") {
						continue
					}

					if (signal.aborted) {
						continue
					}

					degraded = true

					const failedAsset = assets[index]

					if (!failedAsset || reportedFailedAssetIds.has(failedAsset.id)) {
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

				// Phase 2: sort by effective creation timestamp ascending before building the
				// tree. On iOS, asset filenames cycle (IMG_0001 … IMG_9999 → IMG_0001 …), so
				// multiple assets can share the same filename. Because getInfo() resolves in
				// non-deterministic order, building the tree directly inside Promise.all
				// produces a different winner for the base path slot on each run, causing
				// re-uploads on every sync. Sorting first ensures the oldest asset always wins
				// the base slot and newer duplicates consistently receive a collision suffix –
				// stable across runs. Filename is used as tiebreaker so both local and remote
				// trees resolve equal timestamps in the same order.
				//
				// Timestamps are floored to seconds before comparison so that sub-second
				// rounding differences between the local PHAsset timestamp and the server's
				// stored value (after EXIF-override or network round-trip) do not produce
				// different orderings across syncs. #B7: effectiveCreationTimestamp
				// (creationTime ?? modificationTime ?? 0) is the ONE rule shared by this sort,
				// the collision suffix AND the upload's `created` parameter — so the remote
				// side's `meta.created`-based sort mirrors this ordering exactly.
				infos.sort((a, b) => {
					const timeDiff = a.sortSec - b.sortSec

					if (timeDiff !== 0) {
						return timeDiff
					}

					return fastLocaleCompare(a.info.filename, b.info.filename)
				})

				// Phase 3: build tree sequentially so collision resolution is deterministic.
				for (const { asset, info, sortSec } of infos) {
					// #E2: keys are composed from RAW segments (plain "/" joins) — Paths.join
					// percent-ENCODES segments and normalizeFilePathForSdk percent-DECODES
					// them, corrupting literal %XX sequences in real filenames (the eternal
					// re-upload class). For names without decodable %XX the composed key is
					// byte-identical to the previous pipeline's output.
					const originalPath = composeLocalTreePath({ folderTitle, filename: info.filename })
					// #15: when compress is enabled the upload may rewrite the extension
					// (e.g. .png → .jpg), so the dedup key is made extension-agnostic here
					// and symmetrically on the remote side. The collision-suffix name is
					// likewise stripped of its extension so the suffix path stays symmetric.
					const fullPath = originalPath.toLowerCase()
					let path = dedupTreeKey({ path: fullPath, compress: config.compress, convertHeic })
					let iteration = 0
					// #B2: remember the suffix the winning slot carries so the upload can
					// reproduce it in the uploaded filename ("" = base slot, plain name).
					let collisionSuffixApplied = ""

					// Collision-only inputs, computed lazily on the first occupied slot.
					// The collision identity is the seconds-floored creation timestamp.
					// Flooring to seconds absorbs sub-second drift from EXIF-override or
					// network round-trips, keeping local and remote trees symmetric without
					// any per-asset file read at listing time. #B7: the identity is
					// effectiveCreationTimestamp — the exact value the upload sends as
					// `created` — so the remote `meta.created`-derived hash mirrors it
					// (including the null-creationTime → modificationTime fallback);
					// sortSec IS that value, floored once during the pre-sort pass.
					let collisionName: string | null = null
					let localContentHash: string | null = null

					while (tree[path]) {
						if (collisionName === null || localContentHash === null) {
							collisionName = config.compress || convertHeic ? stripFilenameExtension(info.filename) : info.filename
							localContentHash = String(sortSec)
						}

						const collisionAsset = {
							name: collisionName,
							contentHash: localContentHash
						}
						const resolvedPath = modifyAssetPathOnCollision({
							iteration,
							path,
							asset: collisionAsset
						})

						if (resolvedPath === null || resolvedPath.length === 0) {
							path = ""

							break
						}

						path = resolvedPath
						collisionSuffixApplied = collisionNameSuffix({ iteration, asset: collisionAsset }) ?? ""
						iteration++
					}

					if (path.length === 0) {
						continue
					}

					tree[path] = {
						asset,
						info,
						path,
						originalPath,
						collisionSuffix: collisionSuffixApplied
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

			degraded = true

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

		return {
			tree,
			degraded
		}
	}

	private async listRemote({
		remoteDir,
		signal,
		compress,
		convertHeic
	}: {
		remoteDir: AnyNormalDir
		signal: AbortSignal
		compress: boolean
		convertHeic: boolean
	}): Promise<RemoteListing> {
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
		// network round-trips. #B7: `meta.created` carries the value the upload sent —
		// effectiveCreationTimestamp(info) — so this sort mirrors the local one,
		// including for null-creationTime assets. Null meta falls back to 0, matching
		// the local side's both-null fallback (the upload sends created=0 for those).
		const sortedFiles = files
			.map(file => {
				const unwrapped = unwrapFileMeta(file.file)

				remoteFileMetaCache.set(file.file, unwrapped)

				const meta = unwrapped.meta

				return {
					file,
					meta,
					// Floored-seconds sort key + tiebreak name, precomputed ONCE per
					// file — the comparator otherwise pays Number(bigint) twice per
					// comparison, O(n log n) times.
					sortSec: Math.floor(Number(meta?.created ?? 0) / 1000),
					sortName: meta?.name ?? ""
				}
			})
			.sort((a, b) => {
				const timeDiff = a.sortSec - b.sortSec

				if (timeDiff !== 0) {
					return timeDiff
				}

				return fastLocaleCompare(a.sortName, b.sortName)
			})

		for (const { file, meta, sortSec } of sortedFiles) {
			// #E2: `file.path` is the RAW decrypted path — never percent-encoded. It must
			// NOT be percent-decoded (a literal "%20" in a name would corrupt and a
			// literal "%2F" would gain a phantom "/" separator), or the key diverges from
			// the local raw composition and the asset re-uploads forever.
			const fullPath = rawRemoteTreePath(file.path).toLowerCase()
			// HEIC→JPG mirror of #15: convertHeic also rewrites the uploaded extension
			// (.heic → .jpg), so strip it from the remote key + collision name too.
			// #15: mirror listLocal — when compress is enabled, the remote filename may
			// be the compressed `.jpg` (or the original extension when compression lost),
			// so the dedup key is made extension-agnostic and the collision-suffix name is
			// stripped of its extension. This keeps the remote key symmetric with the local
			// stem-based key for the same physical asset.
			let path = dedupTreeKey({ path: fullPath, compress, convertHeic })
			let iteration = 0

			// Collision-only inputs, computed lazily on the first occupied slot. The
			// contentHash is the seconds-floored creation timestamp, matching the local
			// listLocal computation exactly for symmetric collision resolution — sortSec
			// IS that value, floored once during the pre-sort pass.
			let collisionName: string | null = null
			let remoteContentHash: string | null = null

			while (tree[path]) {
				if (collisionName === null || remoteContentHash === null) {
					const remoteName = meta?.name ?? FileSystem.Paths.basename(fullPath)

					collisionName = compress || convertHeic ? stripFilenameExtension(remoteName) : remoteName
					remoteContentHash = String(sortSec)
				}

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

		return {
			tree,
			// #B4: a degraded listing's absences are not evidence of remote deletion —
			// mirror-mode cache drops must only act when this is false.
			degraded: scanErrors.length > 0
		}
	}

	private async deltas({ config, convertHeic, signal }: { config: Config; convertHeic: boolean; signal: AbortSignal }): Promise<{
		deltas: Delta[]
		localListing: LocalListing
		remoteListing: RemoteListing
	}> {
		if (!config.remoteDir) {
			throw new Error("Remote directory is not set in config")
		}

		const [localListing, remoteListing] = await Promise.all([
			this.listLocal({
				config,
				convertHeic,
				signal
			}),
			this.listRemote({
				remoteDir: config.remoteDir,
				signal,
				compress: config.compress,
				convertHeic
			})
		])

		const localTree = localListing.tree
		const remoteTree = remoteListing.tree
		const deltas: Delta[] = []

		for (const path in localTree) {
			const localFile = localTree[path]

			if (!localFile) {
				continue
			}

			const remoteFile = remoteTree[path]

			if (!remoteFile) {
				deltas.push({
					type: "upload",
					file: localFile
				})

				continue
			}

			// Reuse the unwrap listRemote already performed for this exact file object —
			// the fallback covers nothing in practice (every tree entry was unwrapped
			// during the pre-sort pass) but keeps the loop total.
			const remoteFileMeta = remoteFileMetaCache.get(remoteFile.file) ?? unwrapFileMeta(remoteFile.file)
			const remoteModified = remoteFileMeta.meta?.modified
			const localModified = localFile.info.modificationTime

			if (
				remoteModified != null &&
				localModified != null &&
				normalizeModificationTimestampForComparison(Number(remoteModified)) <
					normalizeModificationTimestampForComparison(localModified)
			) {
				deltas.push({
					type: "upload",
					file: localFile
				})
			}
		}

		return {
			deltas,
			localListing,
			remoteListing
		}
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

		// Count separators without split()'s per-call array allocation — this runs
		// once per uploading delta.
		let slashCount = 0

		for (let charIndex = 0; charIndex < originalPath.length; charIndex++) {
			if (originalPath.charCodeAt(charIndex) === 47) {
				slashCount++
			}
		}

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

			// Respect a pause left armed in the foreground (audit B5, 2026-06-11): sync()
			// captures the live globalPauseSignal below, so a background upload would park
			// on it until the run-budget deadline — a whole OS window wasted, reported as
			// Success. The user asked for uploads to pause; skip, never auto-resume.
			if (params?.background && this.globalPauseSignal.isPaused()) {
				return
			}

			const [netState, permissions] = await Promise.all([
				NetInfo.fetch(),
				hasAllNeededMediaPermissions({ library: "all", needCamera: false })
			])

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

			// Destination-existence gate: if the configured remote directory was deleted or moved
			// to the trash on the server, every listRemote / createDir / upload below would fail
			// into the error store and surface banners forever. Exit early and silently — same
			// shape as the `!config.remoteDir` bail above (the setSyncing-false defer is not armed
			// yet). Only a DEFINITIVE verdict bails: undefined (deleted) or a Trash-parented Dir.
			// The account root can never be deleted/trashed, so it needs no request. A TRANSIENT
			// getDirOptional failure (network) must NOT bail — fall through to the normal pipeline,
			// which already tolerates a degraded remote listing; the md5 cache shields re-uploads.
			const remoteDir = config.remoteDir

			if (remoteDir.tag !== AnyNormalDir_Tags.Root) {
				const destinationCheck = await run(async () => {
					const { authedSdkClient } = await auth.getSdkClients()

					return isDirUsable(
						await authedSdkClient.getDirOptional(remoteDir.inner[0].uuid, {
							signal: abortController.signal
						})
					)
				})

				if (destinationCheck.success && !destinationCheck.data) {
					return
				}
			}

			// Update UI state
			useCameraUploadStore.getState().setSyncing(true)

			defer(() => {
				useCameraUploadStore.getState().setSyncing(false)
			})

			// Read the global HEIC→JPG toggle ONCE per sync so listLocal, listRemote and
			// the upload pipeline all use the SAME value. A mid-sync flip can't then make
			// the local (.heic) and remote (.jpg) dedup keys diverge and re-upload forever.
			const convertHeic = await isConvertHeicToJpgEnabled()

			const {
				deltas: allDeltas,
				localListing,
				remoteListing
			} = await this.deltas({
				config: params?.background
					? {
							...config,
							includeVideos: false
						}
					: config,
				convertHeic,
				signal: abortController.signal
			})

			// #B4/B6 hygiene: drop md5-cache entries whose local asset is gone from the
			// device (cheap set difference against the local tree). Gated on a
			// foreground pass (background forces includeVideos=false, so every video
			// would falsely look "gone") and a CLEAN local listing (a degraded
			// listing's absences are not evidence the asset left the device).
			if (!params?.background && !localListing.degraded) {
				for (const key of cache.cameraUploadHashes.keys()) {
					if (!localListing.tree[key]) {
						cache.cameraUploadHashes.delete(key)
					}
				}
			}

			// #B4 mirror mode ("Re-upload deleted photos", default OFF): when enabled,
			// an entry whose key is present locally but ABSENT from a CLEAN remote
			// listing loses its md5-cache shield, so the already-fired delta below
			// re-uploads it naturally. A degraded listing's absences are not evidence
			// of deletion and never drop anything. When OFF (default), the shield is
			// deliberate: photos deleted remotely stay deleted.
			const reuploadDeleted = (await secureStore.get<boolean>(CAMERA_UPLOAD_REUPLOAD_DELETED_SECURE_STORE_KEY)) === true

			if (reuploadDeleted && !remoteListing.degraded) {
				for (const key in localListing.tree) {
					if (!remoteListing.tree[key]) {
						cache.cameraUploadHashes.delete(key)
					}
				}
			}

			// When maxUploads is set (e.g. background sync), sort newest-modified files first so the most
			// recently captured media is prioritised within the limited OS execution window, then cap the
			// list. Without maxUploads (foreground sync) we use the full delta set as-is.
			//
			// Background picks also skip assets whose uploads already burned >= MAX_BACKGROUND_UPLOAD_ABORTS
			// run budgets (audit B4): without the persisted skip, an asset too large for the OS window is
			// re-picked every run forever — partial-upload data + battery with zero forward progress. The
			// skip is silent and background-only; the asset uploads on the next unbudgeted foreground sync.
			const deltas = params?.maxUploads
				? allDeltas
						.filter(
							delta =>
								!params?.background ||
								(cache.cameraUploadBackgroundAborts.get(delta.file.info.id) ?? 0) < MAX_BACKGROUND_UPLOAD_ABORTS
						)
						.sort(
							(a, b) =>
								(b.file.info.modificationTime ?? b.file.info.creationTime ?? 0) -
								(a.file.info.modificationTime ?? a.file.info.creationTime ?? 0)
						)
						.slice(0, params.maxUploads)
				: allDeltas

			// Per-delta pipelines run through an index-cursor worker pool instead of one
			// async closure per delta inside Promise.allSettled: beyond the pool width,
			// the old shape queued every remaining delta on the staging Semaphore, whose
			// FIFO waiter array shift()s per release — O(n²) churn at camera-roll scale.
			let nextDeltaIndex = 0

			const uploadWorker = async (): Promise<void> => {
				while (true) {
					const index = nextDeltaIndex++

					if (index >= deltas.length || abortController.signal.aborted) {
						return
					}

					const delta = deltas[index] as Delta
					const assetId = delta.file.info.id

					if ((this.uploadFailures.get(assetId) ?? 0) >= MAX_UPLOAD_FAILURES) {
						useCameraUploadStore.getState().addSkippedAsset(assetId)

						continue
					}

					// #B6 fast path: iOS bumps asset modificationTime on mere VIEWING,
					// so this delta fires every sync for view-touched photos. When the
					// mtime equals the one we last verified the md5 against, skip
					// immediately — no getUri() (which re-downloads iCloud-offloaded
					// originals) and no md5 hash. -1 is the "never verified" sentinel
					// (legacy string entries migrate through it) and never matches.
					// Hoisted out of the run() wrapper: pure cache reads that cannot
					// throw, so the steady-state skip pays no run/defer machinery.
					const cachedEntry = normalizeCameraUploadHashEntry(cache.cameraUploadHashes.get(delta.file.path))
					const modificationTime = delta.file.info.modificationTime

					if (
						cachedEntry &&
						modificationTime != null &&
						cachedEntry.verifiedModificationTime !== -1 &&
						cachedEntry.verifiedModificationTime === modificationTime
					) {
						continue
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

								if (cachedEntry && md5 === cachedEntry.md5) {
									// Content unchanged (view-touched mtime bump or a remotely-
									// deleted photo with mirror mode off). Record the mtime this
									// md5 was just verified against so the next pass takes the
									// fast path above — this also upgrades legacy string entries
									// to the object shape.
									cache.cameraUploadHashes.set(delta.file.path, {
										md5,
										verifiedModificationTime: modificationTime ?? -1
									})

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

								// HEIC→JPG runs BEFORE compress so the two compose: convert at max
								// quality, then (optionally) compress for size. convertHeicToJpg
								// returns a SEPARATE tmp file (compress renames in place), so it is
								// cleaned up below alongside the staging file.
								if (convertHeic) {
									uploadFile = await convertHeicToJpg(uploadFile)
								}

								if (config.compress) {
									uploadFile = await this.compress(uploadFile)
								}

								if (uploadFile.uri !== tmpFile.uri) {
									defer(() => {
										if (uploadFile.exists) {
											uploadFile.delete()
										}
									})
								}

								// When compress() rewrites the content to JPEG (e.g. .png → .jpg),
								// it renames the file to have a .jpg extension.  Mirror that rename
								// in the upload's `name` parameter so the remote filename and MIME
								// type stay consistent with the actual bytes.
								const uploadExt = FileSystem.Paths.extname(uploadFile.uri).toLowerCase()
								const plainUploadName =
									uploadExt !== "" && uploadExt !== srcExt
										? `${FileSystem.Paths.basename(delta.file.info.filename, FileSystem.Paths.extname(delta.file.info.filename))}${uploadExt}`
										: delta.file.info.filename
								// #B2: a collision member uploads under its collision-resolved name
								// (`name_<suffix>.ext`) so the remote listing's base key reproduces
								// this asset's local tree key — uploading the plain name would
								// silently REPLACE the base member as a new version (backend: same
								// name + same parent = new version). The suffix composes onto the
								// FINAL name, AFTER the compress extension rewrite, and adds only
								// [a-z0-9_-] characters, so it needs no sanitization beyond the
								// plain name's. Non-colliding assets keep their plain name.
								const plainUploadExt = FileSystem.Paths.extname(plainUploadName)
								const uploadName =
									delta.file.collisionSuffix.length > 0
										? `${FileSystem.Paths.basename(plainUploadName, plainUploadExt)}${delta.file.collisionSuffix}${plainUploadExt}`
										: plainUploadName

								const parentDir = await this.ensureParentDirectoryExists({
									config,
									signal: abortController.signal,
									originalPath: delta.file.originalPath
								})

								// #B7: `created` is effectiveCreationTimestamp — the SAME value the
								// dedup key suffix and the tree sort are derived from — so the
								// remote `meta.created` mirrors the local identity on the next
								// listing (epoch 0 for both-null assets survives end-to-end).
								const transferResult = await transfers.upload({
									localFileOrDir: uploadFile,
									parent: parentDir,
									signal: abortController.signal,
									pauseSignal,
									name: uploadName,
									modified: delta.file.info.modificationTime ?? delta.file.info.creationTime ?? undefined,
									created: effectiveCreationTimestamp(delta.file.info),
									hideProgress: params?.background ?? undefined
								})

								if (!transferResult) {
									// Null ⇔ the upload was aborted mid-flight. In a background run
									// that means the budget deadline / OS expiration killed it —
									// count it persistently (audit B4): cancel() wipes the in-memory
									// failure counter and the next run may be a fresh process.
									if (params?.background && abortController.signal.aborted) {
										cache.cameraUploadBackgroundAborts.set(
											assetId,
											(cache.cameraUploadBackgroundAborts.get(assetId) ?? 0) + 1
										)
									}

									break
								}

								cache.cameraUploadHashes.set(delta.file.path, {
									md5,
									verifiedModificationTime: modificationTime ?? -1
								})
								// Any completed upload proves the asset fits a window — forget its
								// background-abort history (audit B4).
								cache.cameraUploadBackgroundAborts.delete(assetId)

								break
							}

							default: {
								throw new Error(i18n.t("error_generic"))
							}
						}
					})

					if (!result.success) {
						if (abortController.signal.aborted) {
							// Thrown-abort surface (staging copy / parent-dir creation aborted
							// before transfers.upload resolved null) — same persistent counting
							// as the null-return surface above (audit B4).
							if (params?.background) {
								cache.cameraUploadBackgroundAborts.set(assetId, (cache.cameraUploadBackgroundAborts.get(assetId) ?? 0) + 1)
							}

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
					}
				}
			}

			const uploadWorkers: Promise<void>[] = []
			const uploadWorkerCount = Math.min(UPLOAD_PIPELINE_CONCURRENCY, deltas.length)

			for (let workerIndex = 0; workerIndex < uploadWorkerCount; workerIndex++) {
				uploadWorkers.push(uploadWorker())
			}

			await Promise.all(uploadWorkers)
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
