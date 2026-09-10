import * as FileSystem from "expo-file-system"
import { type DriveItem } from "@/types"
import { normalizeFilePathForExpo, normalizeFilePathForSdk } from "@/lib/paths"
import { run, Semaphore } from "@filen/utils"
import { ClearBarrier } from "@/lib/clearBarrier"
import { Platform } from "react-native"
import useHttpStore from "@/stores/useHttp.store"
import { onlineManager } from "@tanstack/react-query"
import { THUMBNAILS_VERSION, THUMBNAILS_DIRECTORY } from "@/lib/storageRoots"
import {
	type ThumbnailKind,
	abortError,
	isAbortError,
	OfflineAbortError,
	ProviderUnavailableError,
	getPath,
	ensureDirectory,
	driveItemToAnyFile,
	getThumbnailKind,
	getThumbnailKindForName,
	waitForHttpProvider
} from "@/lib/thumbnailsHelpers"
import offline from "@/features/offline/offline"
import fileCache from "@/lib/fileCache"
import { generateImageViaSdk, generateImageFromPathViaSdk, type SdkThumbnailOutcome } from "@/lib/thumbnailsSdk"
import { sweepStaleThumbnailVersions } from "@/lib/thumbnailsVersionSweep"
import { generateVideo } from "@/lib/thumbnailsVideo"
import logger from "@/lib/logger"

export type ThumbnailParams = {
	item: DriveItem
	width?: number
	quality?: number
	videoTimestamp?: number
	signal?: AbortSignal
}

// Resize width + WebP quality of the ONE remaining manipulator path: the extracted video frame.
// Every image thumbnail is an SDK decode with its own request box (thumbnailsSdk.ts), lossless.
export const DEFAULT_WIDTH = 256
export const DEFAULT_QUALITY = 0.9
export const DEFAULT_VIDEO_TIMESTAMP = 1.0
// Bounds the JS-side native work only: video frame extraction and its manipulator resize. NO image
// thumbnail is behind it any more — remote and local alike are SDK decodes, and the client owns
// decode concurrency and memory: a parked call holds no buffers, and cancelling it dequeues it.
export const MAX_CONCURRENT = Platform.select({
	ios: 3,
	android: 2,
	default: 2
})
export const MAX_FAILURES = 3

// Past this, the synchronous boot-path directory scan is worth a persisted warn rather than a
// debug breadcrumb (production keeps warn/error only).
const SLOW_RESTORE_WARN_MS = 250

// Critical: When changing anything related to storage index/store/persistence/width/height/quality format, bump THUMBNAILS_VERSION in storageRoots.ts to invalidate old caches and prevent potential issues from stale or incompatible data.
export const VERSION = THUMBNAILS_VERSION
export const DIRECTORY = THUMBNAILS_DIRECTORY

class Thumbnails {
	private readonly pending = new Map<string, Promise<string | null>>()
	private readonly failures = new Map<string, number>()
	private readonly semaphore = new Semaphore(MAX_CONCURRENT)
	private readonly clearBarrier = new ClearBarrier()

	// Disk-derived availability index: a uuid is present iff `<uuid>.webp` exists in DIRECTORY.
	// Seeded once by restore() at boot and kept coherent by every generate/invalidate/clear
	// path, so "file on disk ⇒ in Set" holds for any caller (drive rows read it synchronously).
	private readonly available = new Set<string>()

	// SESSION "no thumbnail" verdicts: the SDK's Unsupported / OverBudget / Corrupt. Never written
	// to disk — behind the canMakeThumbnail gate Unsupported is a rare magic-byte mismatch, a
	// persisted marker would go stale when the SDK learns new formats, and OverBudget / Corrupt may
	// be a transport blip wearing a verdict's hat — so a verdict lasts until the next online flip
	// (subscribeRecovery) or clear(), and never counts as a failure.
	private readonly unavailable = new Set<string>()
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

	// The last path segment of a file:// uri. `Paths.basename` is exact but routes every call through
	// `new URL()` — which on React Native is Expo's PURE-JS whatwg-url polyfill, not a native parser —
	// plus a decodeURIComponent. That is ~20µs per entry on desktop V8 and worse interpreted on Hermes,
	// so on an account with tens of thousands of thumbnails it costs seconds of SYNCHRONOUS boot time
	// (restore() runs ahead of setup's Promise.all, and RootLayout holds the splash until setup
	// resolves). A slice is equivalent here because the only thing basename adds is percent-decoding
	// and this directory is written exclusively as `${uuid}.webp` (thumbnailsHelpers getPath) — but the
	// escape check keeps that an optimization rather than an assumption: anything carrying a '%' falls
	// back to the exact decoder.
	private basenameOf(uri: string): string {
		const slash = uri.lastIndexOf("/")
		const sliced = slash === -1 ? uri : uri.slice(slash + 1)

		return sliced.includes("%") ? FileSystem.Paths.basename(uri) : sliced
	}

	// Rebuild the availability Set from disk once per process. Safe pre-auth / headless: it reads only
	// filenames (uuids), never decrypted data. A readdir failure logs a warn and leaves the Set empty —
	// the per-item generate path self-heals via its own disk exists-check. Idempotent (once-flag).
	//
	// Deliberately still SYNCHRONOUS and still on the boot path: drive rows read `hasThumbnail`
	// synchronously while rendering, and an empty Set reads as "no thumbnail on disk" — deferring this
	// would make the first rendered screen regenerate thumbnails it already has.
	public restore(): void {
		if (this.restored) {
			return
		}

		this.restored = true

		const start = performance.now()
		let scanned = 0

		try {
			// A version bump strands the previous tree — nothing else on disk reaches it, and it is
			// invisible to both clear() and size(), which only ever walk the current version.
			sweepStaleThumbnailVersions()

			ensureDirectory()

			for (const record of this.listThumbnailRecords()) {
				scanned++

				if (record.isDirectory) {
					continue
				}

				const basename = this.basenameOf(record.uri)

				// A `<uuid>.webp.tmp` seen at boot is an orphan of a write a kill interrupted — nothing
				// will ever rename it into place, so sweep it instead of leaving it to hold disk forever.
				if (basename.endsWith(".webp.tmp")) {
					try {
						new FileSystem.File(record.uri).delete()
					} catch {
						// Best-effort sweep; a surviving .tmp is inert (it is never read, only overwritten).
					}

					continue
				}

				// The Set holds ONLY <uuid>.webp basenames — any other transient file in DIRECTORY must
				// never enter it.
				if (!basename.endsWith(".webp")) {
					continue
				}

				this.available.add(basename.slice(0, -".webp".length))
			}
		} catch (e) {
			logger.warn("thumbnails", "restore failed to list thumbnails directory", { error: e })
		}

		// This step blocks first paint and had no instrumentation — a slow boot report could not tell
		// it apart from the SQLite restore. Warn past the threshold so it survives the production log
		// gate (prod persists warn/error only).
		const durationMs = performance.now() - start
		const payload = {
			scanned,
			available: this.available.size,
			durationMs: durationMs.toFixed(2)
		}

		if (durationMs > SLOW_RESTORE_WARN_MS) {
			logger.warn("thumbnails", "restore was slow", payload)
		} else {
			logger.debug("thumbnails", "restore completed", payload)
		}
	}

	public hasThumbnail(uuid: string): boolean {
		return this.available.has(uuid)
	}

	// Settled "no thumbnail" for this session. Rows read it synchronously to skip mounting the
	// generator; generate() resolves null for it without touching the SDK. It empties on the next
	// online flip, so a row that asks again then regenerates.
	public isUnavailable(uuid: string): boolean {
		return this.unavailable.has(uuid)
	}

	// A provider-not-ready (ProviderUnavailableError) or transient transport failure can drive an item
	// to the MAX_FAILURES blacklist for the rest of the session. Clear the in-memory failure counters
	// whenever the underlying infrastructure recovers — the HTTP provider booting (port null→non-null)
	// or connectivity returning (offline→online) — so previously-blacklisted items get a fresh chance.
	// The online flip also drops the session verdicts: a Corrupt that was really a transport blip
	// inside the decoder heals on reconnect.
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
				this.unavailable.clear()
			}
		})
	}

	public canGenerate(item: DriveItem): boolean {
		return getThumbnailKind(item) !== null
	}

	// An existing `<uuid>.webp` is served as is and repairs `available`; a 0-byte file is a
	// crashed/interrupted write that would loop the consumer forever, so it is deleted and reported
	// absent. The one integrity check, shared by generate() and generateFromLocalFile().
	private readExistingThumbnail(uuid: string, outputPath: string): string | null {
		const outputFile = new FileSystem.File(outputPath)

		if (!outputFile.exists) {
			return null
		}

		if (outputFile.size > 0) {
			this.available.add(uuid)
			this.unavailable.delete(uuid)

			return normalizeFilePathForExpo(outputPath)
		}

		try {
			outputFile.delete()
		} catch {
			// Best-effort cleanup of the corrupt cache entry; if delete fails we'll regenerate anyway.
		}

		return null
	}

	// Resolves the file:// URI of the WebP, or null when this file has no thumbnail by verdict
	// (settled for the session — never retried by the caller). Throws for transient failures
	// (transport, provider, offline, abort) — those keep the failure ledger and the caller's retry.
	// Order: what is on disk wins (served even for a settled or vetoed uuid), then the session
	// verdict, then the eligibility gate and the failure ledger.
	public async generate(params: ThumbnailParams): Promise<string | null> {
		const result = await run(async defer => {
			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			if (params.signal?.aborted) {
				throw abortError(params.signal)
			}

			const uuid = params.item.data.uuid
			const outputPath = getPath(params.item)
			const existing = this.readExistingThumbnail(uuid, outputPath)

			if (existing !== null) {
				return existing
			}

			// A settled verdict is final for the session: no SDK call, no failure count, no retry.
			if (this.unavailable.has(uuid)) {
				return null
			}

			const kind = getThumbnailKind(params.item)

			if (!kind) {
				throw new Error("Unsupported file type")
			}

			if ((this.failures.get(uuid) ?? 0) >= MAX_FAILURES) {
				throw new Error("Max thumbnail generation failures reached")
			}

			const pendingPromise = this.pending.get(uuid)

			if (pendingPromise) {
				return pendingPromise
			}

			const promise = this.doGenerate({
				item: params.item,
				uuid,
				kind,
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
		kind: ThumbnailKind
		outputPath: string
		signal?: AbortSignal
		width: number
		quality: number
		videoTimestamp: number
	}): Promise<string | null> {
		const result = await run(async () => {
			ensureDirectory()

			if (params.kind === "image") {
				return await this.generateImageThumbnail(params)
			}

			return await this.generateVideoThumbnail(params)
		})

		if (!result.success) {
			// Aborts, offline and a provider that never came up are not verdicts about the file — only a
			// real failure counts toward the blacklist, and only that one is logged at error. An abort
			// has TWO possible flavours on the from-path call, which carries both cancellation channels:
			// the bindings' AbortError, or a FilenSdkError Cancelled that isAbortError does NOT match.
			// Testing `params.signal?.aborted` FIRST is therefore load-bearing, not a shortcut — it is
			// what makes the flavour irrelevant. Keep it first.
			if (
				!params.signal?.aborted &&
				!isAbortError(result.error) &&
				!(result.error instanceof OfflineAbortError) &&
				!(result.error instanceof ProviderUnavailableError)
			) {
				logger.error("thumbnails", "generation failed", {
					uuid: params.uuid,
					kind: params.kind,
					platform: Platform.OS,
					error: String(result.error)
				})

				this.failures.set(params.uuid, (this.failures.get(params.uuid) ?? 0) + 1)
			}

			for (const path of [params.outputPath, `${params.outputPath}.tmp`]) {
				const partial = new FileSystem.File(path)

				if (partial.exists) {
					try {
						partial.delete()
					} catch {
						// Best-effort cleanup of partial output
					}
				}
			}

			throw result.error
		}

		if (result.data !== null) {
			this.available.add(params.uuid)

			// Bytes on disk outrank any earlier session verdict for this uuid.
			this.unavailable.delete(params.uuid)
		}

		return result.data
	}

	// Local bytes first, zero network: an offline copy or a file-cache hit is decoded by the SDK
	// straight from its path; otherwise the SDK reads the file over the network, after the offline
	// guard. Both gates (displayability + canMakeThumbnail) were applied by getThumbnailKind before
	// this runs, and no format list gates the local lookup any more — the same decoder answers both
	// branches, so a local copy is worth looking for exactly when a remote decode would be. That is
	// how RAW gained an offline thumbnail: its offline copy used to be skipped because the manipulator
	// could not read it. Neither branch takes the semaphore (see MAX_CONCURRENT).
	private async generateImageThumbnail(params: {
		item: DriveItem
		uuid: string
		outputPath: string
		signal?: AbortSignal
	}): Promise<string | null> {
		const localSourcePath = await this.resolveLocalSourcePath(params.item, params.signal)

		if (params.signal?.aborted) {
			throw abortError(params.signal)
		}

		let outcome: SdkThumbnailOutcome

		if (localSourcePath !== null) {
			outcome = await generateImageFromPathViaSdk({
				localPath: localSourcePath,
				uuid: params.uuid,
				outputPath: params.outputPath,
				signal: params.signal
			})
		} else {
			// The SDK reads the bytes over the network. Offline it would fail with a transport error and
			// poison the failure counter for something that is not the file's fault — bail the same
			// abort-flavoured way the video path does (not counted, not logged at error).
			if (!onlineManager.isOnline()) {
				throw new OfflineAbortError()
			}

			const file = driveItemToAnyFile(params.item)

			if (!file) {
				throw new Error("Unsupported item type")
			}

			outcome = await generateImageViaSdk({
				file,
				uuid: params.uuid,
				outputPath: params.outputPath,
				signal: params.signal
			})
		}

		switch (outcome) {
			case "written": {
				return normalizeFilePathForExpo(params.outputPath)
			}

			case "settled": {
				this.unavailable.add(params.uuid)

				return null
			}
		}
	}

	// The offline store or the file cache holds the bytes already — no network, no SDK download. The
	// path comes back DECODED and plain (normalizeFilePathForSdk) because its only consumer is the SDK,
	// which opens it verbatim: a percent-encoded URI would ENOENT on any name carrying a space.
	private async resolveLocalSourcePath(item: DriveItem, signal?: AbortSignal): Promise<string | null> {
		const offlineFile = await offline.getLocalFile(item)

		if (offlineFile?.exists) {
			return normalizeFilePathForSdk(offlineFile.uri)
		}

		if (
			await fileCache.has({
				type: "drive",
				data: item
			})
		) {
			const cachedFile = await fileCache.get({
				item: {
					type: "drive",
					data: item
				},
				signal
			})

			return normalizeFilePathForSdk(cachedFile.uri)
		}

		return null
	}

	// Video: the frame comes from expo-video-thumbnails over the local HTTP provider (or an offline
	// copy) and is resized/encoded by the manipulator — real native work, so it stays behind the
	// semaphore. The source URL is resolved BEFORE the slot is taken: the provider boots
	// asynchronously and the wait can take up to 30s; holding a finite slot during that idle wait
	// would head-of-line-block every other thumbnail.
	private async generateVideoThumbnail(params: {
		item: DriveItem
		outputPath: string
		width: number
		quality: number
		videoTimestamp: number
		signal?: AbortSignal
	}): Promise<string> {
		const file = driveItemToAnyFile(params.item)

		if (!file) {
			throw new Error("Unsupported item type")
		}

		let videoSourceUrl: string

		const offlineFile = await offline.getLocalFile(params.item)

		if (offlineFile?.exists) {
			videoSourceUrl = normalizeFilePathForExpo(offlineFile.uri)
		} else {
			// Video thumbnails stream via the local HTTP provider, which internally streams from
			// Filen servers via the SDK. Offline would stall. Throw abort-flavoured so the failures
			// map isn't poisoned.
			if (!onlineManager.isOnline()) {
				throw new OfflineAbortError()
			}

			const getFileUrl = await waitForHttpProvider(params.signal)

			videoSourceUrl = getFileUrl(file)
		}

		if (params.signal?.aborted) {
			throw abortError(params.signal)
		}

		await this.semaphore.acquire()

		try {
			await generateVideo({
				sourceUrl: videoSourceUrl,
				outputPath: params.outputPath,
				width: params.width,
				quality: params.quality,
				timestamp: params.videoTimestamp,
				signal: params.signal
			})

			return normalizeFilePathForExpo(params.outputPath)
		} finally {
			this.semaphore.release()
		}
	}

	public async generateFromLocalFile(params: {
		localUri: string
		uuid: string
		name: string
		canMakeThumbnail: boolean
		width?: number
		quality?: number
		videoTimestamp?: number
		signal?: AbortSignal
	}): Promise<string | null> {
		// Ahead of the barrier: a file that gets no thumbnail must not wait out a cache clear to be told so.
		const kind = getThumbnailKindForName(params.name, params.canMakeThumbnail)

		if (kind === null) {
			return null
		}

		await this.clearBarrier.enter()

		try {
			return await this.generateFromLocalFileImpl(params, kind)
		} finally {
			this.clearBarrier.leave()
		}
	}

	// Post-upload hook (transferCore): the device just uploaded these bytes, so thumbnail them from the
	// local copy instead of fetching them back over the network. `localUri` is the percent-ENCODED expo
	// URI, the one form both branches can derive theirs from: the SDK image decode takes the decoded
	// plain path it opens verbatim, and the video extractor takes the URI unchanged. Deriving runs one
	// way only — normalizeFilePathForExpo decodes before it encodes, so handing it an already-decoded
	// path decodes a name's literal `%20` a second time and addresses a file that does not exist.
	// `width`/`quality` reach the video branch only: the SDK owns its own request box, so an image
	// ignores them.
	private async generateFromLocalFileImpl(
		params: {
			localUri: string
			uuid: string
			name: string
			canMakeThumbnail: boolean
			width?: number
			quality?: number
			videoTimestamp?: number
			signal?: AbortSignal
		},
		kind: ThumbnailKind
	): Promise<string | null> {
		const isImage = kind === "image"

		if ((this.failures.get(params.uuid) ?? 0) >= MAX_FAILURES) {
			logger.warn("thumbnails", "thumbnail generation blacklisted (max failures reached)", { uuid: params.uuid })
			return null
		}

		const outputPath = FileSystem.Paths.join(DIRECTORY.uri, `${params.uuid}.webp`)
		const existing = this.readExistingThumbnail(params.uuid, outputPath)

		if (existing !== null) {
			return existing
		}

		const pendingPromise = this.pending.get(params.uuid)

		if (pendingPromise) {
			return pendingPromise
		}

		const width = params.width ?? DEFAULT_WIDTH
		const quality = params.quality ?? DEFAULT_QUALITY

		const promise = (async (): Promise<string | null> => {
			try {
				ensureDirectory()

				if (isImage) {
					// An SDK decode on the client's own gate — NOT behind the semaphore, exactly like the
					// remote path (see MAX_CONCURRENT).
					const outcome = await generateImageFromPathViaSdk({
						localPath: normalizeFilePathForSdk(params.localUri),
						uuid: params.uuid,
						outputPath,
						signal: params.signal
					})

					// A verdict is not a failure: it settles the uuid for this session the way generate()
					// does and leaves the ledger untouched, so the next online flip lets a row ask again.
					if (outcome === "settled") {
						this.unavailable.add(params.uuid)

						return null
					}
				} else {
					// Real JS-side native work (frame extraction + manipulator resize) — behind the semaphore.
					await this.semaphore.acquire()

					try {
						await generateVideo({
							localSourceUri: params.localUri,
							outputPath,
							width,
							quality,
							timestamp: params.videoTimestamp ?? DEFAULT_VIDEO_TIMESTAMP,
							signal: params.signal
						})
					} finally {
						this.semaphore.release()
					}
				}

				this.available.add(params.uuid)

				// Bytes on disk outrank any earlier session verdict for this uuid.
				this.unavailable.delete(params.uuid)

				return normalizeFilePathForExpo(outputPath)
			} catch (error) {
				// Same exemptions as doGenerate, and for the same reason the signal test comes first:
				// the from-path call carries both cancellation channels, so an abort arrives as either
				// the bindings' AbortError or a FilenSdkError Cancelled. isAbortError was missing here
				// while its sibling had it, which counted a cancelled upload as a real failure.
				if (
					!params.signal?.aborted &&
					!isAbortError(error) &&
					!(error instanceof OfflineAbortError) &&
					!(error instanceof ProviderUnavailableError)
				) {
					logger.error("thumbnails", "generateFromLocalFile failed", {
						uuid: params.uuid,
						ext: FileSystem.Paths.extname(params.name).toLowerCase().trim(),
						kind,
						platform: Platform.OS,
						error: String(error)
					})

					this.failures.set(params.uuid, (this.failures.get(params.uuid) ?? 0) + 1)
				}

				for (const path of [outputPath, `${outputPath}.tmp`]) {
					const partial = new FileSystem.File(path)

					if (partial.exists) {
						try {
							partial.delete()
						} catch {
							// Best-effort cleanup of partial output
						}
					}
				}

				throw error
			} finally {
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

	// Invalidate a cached thumbnail WITHOUT resetting its failure counter or the session verdicts.
	// Used when a render-time decode failure (e.g. an undecodable-but-nonzero .webp) means the
	// on-disk artifact must be discarded, but the failure history must be preserved so the consumer
	// can give up permanently once MAX_ERROR_RETRIES is exhausted instead of looping generate-on-error forever.
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
			this.unavailable.clear()

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
