import * as FileSystem from "expo-file-system"
import { AppState } from "react-native"
import { ManagedFuture, EmbeddedPreviewResult_Tags } from "@filen/sdk-rs"
import { Semaphore, run } from "@filen/utils"
import { debounce } from "es-toolkit/function"
import { type DriveItemFileExtracted } from "@/types"
import auth from "@/lib/auth"
import { normalizeFilePathForSdk, normalizeFilePathForExpo } from "@/lib/paths"
import { wrapAbortSignalForSdk, disposeSdkAbortSignal, toSignalOpts } from "@/lib/signals"
import { driveItemToAnyFile } from "@/lib/thumbnailsHelpers"
import { newTmpFile } from "@/lib/tmp"
import { ClearBarrier } from "@/lib/clearBarrier"
import { RAW_PREVIEW_CACHE_DIRECTORY } from "@/lib/storageRoots"
import { planSizeCapEviction, RAW_PREVIEW_CACHE_MAX_SIZE_BYTES } from "@/lib/cacheEviction"
import logger from "@/lib/logger"

// `uri` = file:// URI of the JPEG the SDK extracted from the RAW container; `noPreview` = the SDK's
// verdict that the container embeds no JPEG a viewer could show (≥ 512 px long side). Nothing is
// stored for noPreview: it is re-probed on the next open (one chunk + a decode-gate slot — rare).
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
const GC_AGE_MS = 24 * 60 * 60 * 1000
const GC_DEBOUNCE_MS = 30 * 1000
// Bound gc's fan-out so a full cache doesn't launch O(N) concurrent native FS ops on the single
// Hermes JS thread — mirrors fileCache.gc's GC_CONCURRENCY.
const GC_CONCURRENCY = 8

// Not a fileCache variant on purpose: fileCache keys on the file's own identity, short-circuits to
// the offline copy (which would hand the RAW bytes to the preview) and derives the extension from
// the file name — every one of those would need a branch. This cache is the derived artefact only.
export class RawPreviewCache {
	private readonly mutexes = new Map<string, Semaphore>()
	private readonly clearBarrier = new ClearBarrier()

	private ensureDirectory(): void {
		if (!DIRECTORY.exists) {
			DIRECTORY.create({
				idempotent: true,
				intermediates: true
			})
		}
	}

	// Debounced gc after fresh extractions + immediate gc on app-background: reclamation runs where
	// growth happens instead of competing with startup. Log-only on failure — not user-actionable.
	private readonly scheduleGc = debounce(
		() => {
			this.gc().catch(err => {
				logger.warn("rawPreviewCache", "gc failed", { error: err })
			})
		},
		GC_DEBOUNCE_MS,
		{
			edges: ["trailing"]
		}
	)

	public constructor() {
		this.ensureDirectory()

		AppState.addEventListener("change", nextAppState => {
			if (nextAppState === "background") {
				this.scheduleGc.cancel()

				this.gc().catch(err => {
					logger.warn("rawPreviewCache", "gc on background failed", { error: err })
				})
			}
		})
	}

	private getMutexForKey(key: string): Semaphore {
		let mutex = this.mutexes.get(key)

		if (!mutex) {
			mutex = new Semaphore(1)

			this.mutexes.set(key, mutex)
		}

		return mutex
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

		const result = await run(async defer => {
			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			const mutex = this.getMutexForKey(uuid)

			await mutex.acquire()

			defer(() => {
				mutex.release()
			})

			const file = this.previewFile(uuid)

			if (file.exists && file.size > 0) {
				return {
					kind: "uri",
					uri: normalizeFilePathForExpo(file.uri)
				} satisfies RawPreviewResult
			}

			if (file.exists) {
				file.delete()
			}

			this.ensureDirectory()

			// The one AnyFile mapping site in the app (file → File; sharedFile and sharedRootFile →
			// Shared); null only for directories, which the parameter type already excludes.
			const anyFile = driveItemToAnyFile(item)

			if (!anyFile) {
				throw new Error("Unsupported item type")
			}

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

			// Extraction only — the SDK copies the container's embedded JPEG out through the ranged
			// reader without decoding the RAW; on NoPreview nothing exists at the path. Cancel via the
			// ManagedFuture abort → FilenSdkError Cancelled (suppressed by decideQueryErrorAction).
			const outcome = await authedSdkClient.writeEmbeddedPreviewToPath(
				anyFile,
				normalizeFilePathForSdk(tmpUri),
				ManagedFuture.new({
					pauseSignal: undefined,
					abortSignal: wrappedSignal
				}),
				toSignalOpts(signal)
			)

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

		if (!result.success) {
			throw result.error
		}

		return result.data
	}

	public async gc(): Promise<void> {
		if (!DIRECTORY.exists) {
			return
		}

		// Under the ClearBarrier so a concurrent clear() (logout / clear preview cache) waits for
		// this pass instead of deleting + recreating DIRECTORY mid-sweep.
		await this.clearBarrier.enter()

		try {
			await this.runGc()
		} finally {
			this.clearBarrier.leave()
		}
	}

	private async runGc(): Promise<void> {
		const now = Date.now()
		const gcSemaphore = new Semaphore(GC_CONCURRENCY)
		const toDelete: string[] = []
		const survivors: { key: string; cachedAt: number; size: number }[] = []

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

			if (now >= cachedAt + GC_AGE_MS) {
				toDelete.push(entry.name)

				continue
			}

			survivors.push({
				key: entry.name,
				cachedAt,
				size: entry.size ?? 0
			})
		}

		// Soft size cap over the survivors: oldest first, never the newest (the one being viewed).
		const capCachedAt = new Map<string, number>()

		for (const survivor of survivors) {
			capCachedAt.set(survivor.key, survivor.cachedAt)
		}

		const capEvict = planSizeCapEviction(survivors, RAW_PREVIEW_CACHE_MAX_SIZE_BYTES)

		await Promise.all(
			[...toDelete, ...capEvict].map(async name => {
				await run(async defer => {
					await gcSemaphore.acquire()

					defer(() => {
						gcSemaphore.release()
					})

					const uuid = name.endsWith(PREVIEW_EXTENSION) ? name.slice(0, -PREVIEW_EXTENSION.length) : name
					const mutex = this.getMutexForKey(uuid)

					await mutex.acquire()

					defer(() => {
						mutex.release()
					})

					const file = new FileSystem.File(FileSystem.Paths.join(DIRECTORY.uri, name))

					if (!file.exists) {
						return
					}

					// A cap eviction only fires if the entry is untouched since planning — a concurrent
					// get() that re-extracted it made it the newest and it must be kept.
					const plannedCachedAt = capCachedAt.get(name)

					if (plannedCachedAt !== undefined && (file.lastModified ?? 0) !== plannedCachedAt) {
						return
					}

					file.delete()
				})
			})
		)
	}

	public async clear(): Promise<void> {
		await this.clearBarrier.runExclusive(() => {
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

const rawPreviewCache = new RawPreviewCache()

export default rawPreviewCache
