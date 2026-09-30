import * as FileSystem from "expo-file-system"
import { ManagedFuture, EmbeddedPreviewResult_Tags, type EmbeddedPreviewResult } from "@filen/sdk-rs"
import { Semaphore, run, runOrThrow } from "@filen/shared"
import { type DriveItemFileExtracted } from "@/types"
import auth from "@/lib/auth"
import { normalizeFilePathForSdk, normalizeFilePathForExpo } from "@/lib/paths"
import { wrapAbortSignalForSdk, disposeSdkAbortSignal, toSignalOpts } from "@/lib/signals"
import { driveItemToAnyFile } from "@/lib/sdkSources"
import offline from "@/features/offline/offline"
import { newTmpFile } from "@/lib/tmp"
import { DiskCache, gcIdleUntil, planGcCapEviction, type GcSurvivor } from "@/lib/diskCache"
import { RAW_PREVIEW_CACHE_DIRECTORY } from "@/lib/storageRoots"
import { RAW_PREVIEW_CACHE_MAX_SIZE_BYTES } from "@/lib/cacheEviction"
import { GC_AGE_MS, GC_CONCURRENCY } from "@/lib/cacheGc"
import logger from "@/lib/logger"

// `uri` = file:// URI of the JPEG the SDK extracted from the RAW container; `noPreview` = the SDK's
// verdict that the container embeds no JPEG a viewer could show (≥ 512 px long side). Nothing is
// stored for noPreview, so the next open re-probes: a decode-gate slot either way, plus the locate's
// two to four bounded reads — chunk fetches for a remote container, local disk reads for a
// stored-offline one, which reaches the network for nothing.
export type RawPreviewResult =
	| {
			kind: "uri"
			uri: string
	  }
	| {
			kind: "noPreview"
	  }

// Critical: When changing anything related to the on-disk layout, bump RAW_PREVIEW_CACHE_VERSION in storageRoots.ts to invalidate old caches.
const DIRECTORY = RAW_PREVIEW_CACHE_DIRECTORY

const PREVIEW_EXTENSION = ".jpg"

// Not a fileCache variant on purpose: fileCache keys on the file's own identity, short-circuits to
// the offline copy (which would hand the RAW bytes to the preview) and derives the extension from
// the file name — every one of those would need a branch. This cache is the derived artefact only.
export class RawPreviewCache extends DiskCache {
	public constructor() {
		super(DIRECTORY, "rawPreviewCache")
	}

	private previewFile(uuid: string): FileSystem.File {
		return new FileSystem.File(FileSystem.Paths.join(DIRECTORY.uri, `${uuid}${PREVIEW_EXTENSION}`))
	}

	// Synchronous probe for the query's ordering (hit → serve offline too; miss → offline or SDK).
	// A 0-byte file is a crashed write, not a hit.
	public has(item: DriveItemFileExtracted): boolean {
		const file = this.previewFile(item.data.uuid)

		return file.exists && file.size > 0
	}

	public async get({ item, signal }: { item: DriveItemFileExtracted; signal?: AbortSignal }): Promise<RawPreviewResult> {
		const uuid = item.data.uuid

		return await runOrThrow(async defer => {
			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			defer(await this.keyMutexes.acquire(uuid))

			const file = this.previewFile(uuid)

			if (file.exists && file.size > 0) {
				return {
					kind: "uri",
					uri: normalizeFilePathForExpo(file.uri)
				} satisfies RawPreviewResult
			}

			this.noteWrite()

			defer(() => {
				this.noteWrite()
			})

			if (file.exists) {
				file.delete()
			}

			this.ensureDirectory()

			// A stored-offline RAW already has its container on this device, and the JPEG lives inside
			// that container — so extract from the local copy and touch the network for nothing. This is
			// also what makes a RAW preview work at all while offline.
			const offlineFile = await offline.getLocalFile(item)
			// DECODED plain path: the SDK opens it verbatim, so a percent-encoded URI would ENOENT.
			const localSourcePath = offlineFile?.exists ? normalizeFilePathForSdk(offlineFile.uri) : null

			// Authed client only — no RAW preview is reachable logged out (the gallery sits behind
			// the authed shell and drive.openLinkedFile itself needs the authed client).
			const { authedSdkClient } = await auth.getSdkClients()
			const wrappedSignal = signal ? wrapAbortSignalForSdk(signal) : undefined

			// uniffi handles have no GC — free the controller + signal once the call settles.
			defer(() => {
				disposeSdkAbortSignal(wrappedSignal)
			})

			// Extract into filen-tmp, then move into place: the SDK writes beside the path it is given
			// and renames atomically, and the second move keeps a half-written preview out of
			// DIRECTORY, which has() reads synchronously. The path is a plain filesystem path, not a URI.
			//
			// expo-file-system REBINDS a handle to its destination as the last step of moveSync (both
			// platforms), so once the move has run `tmp` IS the cached preview. The staging cleanup
			// therefore goes by the URI captured before the move, never by the handle — deleting the
			// handle after a successful move would delete the preview it just cached.
			const tmp = newTmpFile()
			const tmpUri = tmp.uri

			defer(() => {
				const staging = new FileSystem.File(tmpUri)

				if (staging.exists) {
					try {
						staging.delete()
					} catch {
						// Best-effort; sweepTmpDir() reclaims orphans
					}
				}
			})

			// Extraction only — the SDK copies the container's embedded JPEG out without decoding the
			// RAW, from the local file when we have one and otherwise through the ranged reader; on
			// NoPreview nothing exists at the path. Cancel via the ManagedFuture abort → FilenSdkError
			// Cancelled (suppressed by decideQueryErrorAction).
			const managedFuture = ManagedFuture.new({
				pauseSignal: undefined,
				abortSignal: wrappedSignal
			})
			const previewPath = normalizeFilePathForSdk(tmpUri)

			let outcome: EmbeddedPreviewResult

			if (localSourcePath !== null) {
				outcome = await authedSdkClient.writeEmbeddedPreviewFromPath(
					localSourcePath,
					previewPath,
					managedFuture,
					toSignalOpts(signal)
				)
			} else {
				// The one AnyFile mapping site in the app (file → File; sharedFile and sharedRootFile →
				// Shared); null only for directories, which the parameter type already excludes.
				const anyFile = driveItemToAnyFile(item)

				if (!anyFile) {
					throw new Error("Unsupported item type")
				}

				outcome = await authedSdkClient.writeEmbeddedPreviewToPath(anyFile, previewPath, managedFuture, toSignalOpts(signal))
			}

			if (outcome.tag === EmbeddedPreviewResult_Tags.NoPreview) {
				logger.debug("rawPreviewCache", "no embedded preview", { uuid })

				return {
					kind: "noPreview"
				} satisfies RawPreviewResult
			}

			if (!tmp.exists) {
				throw new Error("Preview does not exist after extraction")
			}

			tmp.moveSync(file, {
				overwrite: true
			})

			logger.debug("rawPreviewCache", "preview extracted", {
				uuid,
				local: localSourcePath !== null,
				width: outcome.inner.width,
				height: outcome.inner.height,
				orientation: outcome.inner.orientation,
				bytes: Number(outcome.inner.bytes)
			})

			this.scheduleGc()

			return {
				kind: "uri",
				uri: normalizeFilePathForExpo(file.uri)
			} satisfies RawPreviewResult
		})
	}

	protected async runGc(age?: number): Promise<number | null> {
		const now = Date.now()
		const ttlMs = age ?? GC_AGE_MS
		const gcSemaphore = new Semaphore(GC_CONCURRENCY)
		const toDelete: string[] = []
		const survivors: GcSurvivor[] = []

		// Pass 1 (no mutexes, cheap stats): expired, empty and stray entries go; the rest are sized
		// for the cap pass. lastModified is cachedAt — the move stamps it at extraction.
		for (const entry of DIRECTORY.list()) {
			if (!(entry instanceof FileSystem.File)) {
				continue
			}

			if (!entry.name.endsWith(PREVIEW_EXTENSION) || (entry.size ?? 0) === 0) {
				toDelete.push(entry.name)

				continue
			}

			const cachedAt = entry.lastModified ?? 0

			if (now >= cachedAt + ttlMs) {
				toDelete.push(entry.name)

				continue
			}

			survivors.push({
				key: entry.name,
				cachedAt,
				size: entry.size ?? 0
			})
		}

		const { evict: capEvict, plannedCachedAt: capCachedAt } = planGcCapEviction(survivors, RAW_PREVIEW_CACHE_MAX_SIZE_BYTES)
		const idleUntil = gcIdleUntil(toDelete.length > 0 || capEvict.length > 0, survivors, ttlMs)

		await Promise.all(
			[...toDelete, ...capEvict].map(async name => {
				await run(async defer => {
					await gcSemaphore.acquire()

					defer(() => {
						gcSemaphore.release()
					})

					const uuid = name.endsWith(PREVIEW_EXTENSION) ? name.slice(0, -PREVIEW_EXTENSION.length) : name
					defer(await this.keyMutexes.acquire(uuid))

					const file = new FileSystem.File(FileSystem.Paths.join(DIRECTORY.uri, name))

					if (!file.exists) {
						return
					}

					// Re-check under the mutex: pass 1 ran without it, so a concurrent get() may have
					// refilled this entry since — and a refill makes it the newest, which must be kept.
					const plannedCachedAt = capCachedAt.get(name)

					if (plannedCachedAt !== undefined) {
						// Cap eviction: only fires while the entry is untouched since planning.
						if ((file.lastModified ?? 0) !== plannedCachedAt) {
							return
						}
					} else {
						// TTL / 0-byte candidate: only fires while it is still stale or still empty. A
						// stray (non-.jpg) has no writer at all, so it always goes.
						const stillStale =
							!name.endsWith(PREVIEW_EXTENSION) || (file.size ?? 0) === 0 || now >= (file.lastModified ?? 0) + ttlMs

						if (!stillStale) {
							return
						}
					}

					file.delete()
				})
			})
		)

		return idleUntil
	}
}

const rawPreviewCache = new RawPreviewCache()

export default rawPreviewCache
