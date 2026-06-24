import * as FileSystem from "expo-file-system"
import { AppState } from "react-native"
import { AnyFile, ManagedFuture } from "@filen/sdk-rs"
import { Semaphore, run } from "@filen/utils"
import { debounce } from "es-toolkit/function"
import type { CacheItem, DriveItemFileExtracted } from "@/types"
import { serialize, deserialize } from "@/lib/serializer"
import { atomicWrite } from "@/lib/fsAtomic"
import auth from "@/lib/auth"
import { normalizeFilePathForSdk } from "@/lib/paths"
import { wrapAbortSignalForSdk, disposeSdkAbortSignal } from "@/lib/signals"
import { sumLocalDirectoryFileBytes } from "@/lib/fsUtils"
import { ClearBarrier } from "@/lib/clearBarrier"
import offline from "@/features/offline/offline"
import { xxHash32 } from "js-xxhash"
import { FILE_CACHE_VERSION, FILE_CACHE_PARENT_DIRECTORY } from "@/lib/storageRoots"
import { planSizeCapEviction, CACHE_MAX_SIZE_BYTES } from "@/lib/cacheEviction"
import logger from "@/lib/logger"

export type Metadata = (
	| {
			type: "drive"
			data: DriveItemFileExtracted
	  }
	| {
			type: "external"
			data: {
				url: string
				name: string
			}
	  }
) & {
	cachedAt: number
}

// Critical: When changing anything related to storage index/store/persistence format, bump FILE_CACHE_VERSION in storageRoots.ts to invalidate old caches and prevent potential issues from stale or incompatible data.
export const VERSION = FILE_CACHE_VERSION

const DEFAULT_GC_AGE_MS = 24 * 60 * 60 * 1000
const GC_DEBOUNCE_MS = 30 * 1000
// TC-13: bound gc's two fan-out passes so a large cache (the ~250MB preview cache can hold hundreds
// of small files) doesn't launch O(N) concurrent native FS ops + JSON parses on the single Hermes JS
// thread — worst during the synchronous app-background sweep. The per-key mutexes are for correctness
// (don't delete an entry a concurrent get() is writing), NOT throttling, so a separate gc cap is needed.
const GC_CONCURRENCY = 8
export const PARENT_DIRECTORY = FILE_CACHE_PARENT_DIRECTORY

/**
 * Whether a stored metadata sidecar still identifies the same cached bytes as `item`.
 *
 * The backend rotates a file's uuid on EVERY content change — the same uuid implies
 * byte-identical content forever, so the type discriminators + uuid (plus the size as a
 * cheap sanity check) are a sufficient identity for the cached bytes. Deep equality is
 * deliberately NOT used: live SDK drive items carry UniffiEnum variant class instances
 * and present-but-undefined keys that a serializer round-trip cannot reproduce, so deep
 * comparison treated every revived sidecar as stale and killed the cache for drive items.
 * Metadata-only mutations (rename, favorite, move) keep the uuid and must NOT invalidate
 * the cached bytes.
 */
function metadataMatchesItem(metadata: Metadata, item: CacheItem): boolean {
	if (item.type === "drive") {
		if (item.data.type !== "file" && item.data.type !== "sharedFile" && item.data.type !== "sharedRootFile") {
			return false
		}

		// Guard the stored shape at runtime — a corrupt sidecar can carry the right
		// discriminator with a missing or malformed body.
		if (metadata.type !== "drive" || typeof metadata.data !== "object" || metadata.data === null) {
			return false
		}

		return (
			metadata.data.type === item.data.type &&
			metadata.data.data?.uuid === item.data.data.uuid &&
			metadata.data.data?.size === item.data.data.size
		)
	}

	if (metadata.type !== "external" || typeof metadata.data !== "object" || metadata.data === null) {
		return false
	}

	// External entries are keyed by xxHash32(url) and their stored name decides the
	// on-disk extension — compare both, exactly what the old deep equality compared.
	return metadata.data.url === item.data.url && metadata.data.name === item.data.name
}

export class FileCache {
	private readonly mutexes = new Map<string, Semaphore>()
	private readonly clearBarrier = new ClearBarrier()
	private directoryEnsured = false

	private ensureDirectory(): void {
		if (this.directoryEnsured) {
			return
		}

		if (!PARENT_DIRECTORY.exists) {
			PARENT_DIRECTORY.create({
				idempotent: true,
				intermediates: true
			})
		}

		this.directoryEnsured = true
	}

	// Debounced gc after fresh downloads + immediate gc on app-background:
	// reclamation runs where growth happens instead of competing with startup.
	// Log-only on failure — gc hygiene isn't user-actionable.
	private readonly scheduleGc = debounce(
		() => {
			this.gc().catch(err => {
				logger.warn("fileCache", "gc failed", { error: err })
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
					logger.warn("fileCache", "gc on background failed", { error: err })
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

	private getExternalItemId(item: Extract<CacheItem, { type: "external" }>): string {
		return xxHash32(item.data.url).toString(16)
	}

	public getFiles(item: CacheItem): {
		file: FileSystem.File
		metadata: FileSystem.File
		parentDirectory: FileSystem.Directory
	} {
		if (item.type === "drive" && !item.data.data.decryptedMeta) {
			throw new Error("Item does not have decrypted metadata")
		}

		const parentDirectory = new FileSystem.Directory(
			FileSystem.Paths.join(PARENT_DIRECTORY.uri, item.type === "drive" ? item.data.data.uuid : this.getExternalItemId(item))
		)

		if (!parentDirectory.exists) {
			parentDirectory.create({
				idempotent: true,
				intermediates: true
			})
		}

		return {
			file: new FileSystem.File(
				FileSystem.Paths.join(
					parentDirectory.uri,
					`${item.type === "drive" ? item.data.data.uuid : this.getExternalItemId(item)}${FileSystem.Paths.extname(item.type === "drive" ? (item.data.data.decryptedMeta?.name ?? "") : item.data.name)}`
				)
			),
			metadata: new FileSystem.File(
				FileSystem.Paths.join(
					parentDirectory.uri,
					`${item.type === "drive" ? item.data.data.uuid : this.getExternalItemId(item)}.filenmeta`
				)
			),
			parentDirectory
		}
	}

	public async has(item: CacheItem): Promise<boolean> {
		if (item.type === "drive" && item.data.type !== "file" && item.data.type !== "sharedFile" && item.data.type !== "sharedRootFile") {
			return false
		}

		if (item.type === "drive") {
			const offlineFile = await offline.getLocalFile(item.data)

			if (offlineFile?.exists) {
				return true
			}
		}

		const result = await run(async defer => {
			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			const { file, metadata } = this.getFiles(item)

			if (!file.exists || !metadata.exists || metadata.size === 0) {
				return false
			}

			let metadataContent: Metadata | null = null

			try {
				metadataContent = deserialize(await metadata.text()) as Metadata
			} catch (e) {
				logger.warn("fileCache", "sidecar parse failed in has", { uuid: item.type === "drive" ? item.data.data.uuid : undefined, error: e })

				// Torn/unparseable sidecar (crash mid-write before sidecars became atomic,
				// disk corruption): self-heal at access time — treat as a miss and drop the
				// sidecar so the next get() re-downloads, instead of throwing until gc.
				//
				// TC-16: do the delete UNDER the per-key mutex (has() otherwise holds no per-key lock),
				// and re-check the sidecar under the lock first. A concurrent get() holds this same mutex
				// while writing a FRESH sidecar via atomicWrite (delete-temp-then-move) — without this,
				// has() could delete the valid sidecar get() just materialized, forcing a needless re-download.
				const mutex = this.getMutexForKey(item.type === "drive" ? item.data.data.uuid : this.getExternalItemId(item))

				await mutex.acquire()

				try {
					if (!metadata.exists) {
						return false
					}

					try {
						const recheck = deserialize(await metadata.text()) as Metadata

						if (recheck && Object.keys(recheck).length > 0) {
							// A concurrent get() wrote a valid sidecar between our torn read and the lock —
							// don't delete it; report based on the fresh metadata.
							return metadataMatchesItem(recheck, item)
						}
					} catch {
						// Still torn under the lock — fall through to the delete.
					}

					try {
						metadata.delete()
					} catch {
						// best-effort — a failed delete just leaves the torn sidecar for gc
					}

					return false
				} finally {
					mutex.release()
				}
			}

			if (!metadataContent || Object.keys(metadataContent).length === 0) {
				return false
			}

			return metadataMatchesItem(metadataContent, item)
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	}

	public async get({ item, signal }: { item: CacheItem; signal?: AbortSignal }): Promise<FileSystem.File> {
		if (item.type === "drive" && item.data.type !== "file" && item.data.type !== "sharedFile" && item.data.type !== "sharedRootFile") {
			throw new Error("Item must be a file or shared file")
		}

		if (item.type === "drive") {
			const offlineFile = await offline.getLocalFile(item.data)

			if (offlineFile?.exists) {
				return offlineFile
			}
		}

		const result = await run(async defer => {
			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			const mutex = this.getMutexForKey(item.type === "drive" ? item.data.data.uuid : this.getExternalItemId(item))

			await mutex.acquire()

			defer(() => {
				mutex.release()
			})

			const { file, metadata: metadataFile, parentDirectory } = this.getFiles(item)

			if (file.exists && metadataFile.exists && metadataFile.size > 0) {
				try {
					const metadata = deserialize(await metadataFile.text()) as Metadata

					if (metadata && Object.keys(metadata).length > 0 && metadataMatchesItem(metadata, item)) {
						return file
					}
				} catch (e) {
					logger.warn("fileCache", "sidecar parse failed in get, re-downloading", { uuid: item.type === "drive" ? item.data.data.uuid : undefined, error: e })

					if (metadataFile.exists) {
						metadataFile.delete()
					}
				}
			}

			if (!parentDirectory.exists) {
				parentDirectory.create({
					idempotent: true,
					intermediates: true
				})
			}

			try {
				const { authedSdkClient } = await auth.getSdkClients()
				const wrappedSignal = signal ? wrapAbortSignalForSdk(signal) : undefined

				// TC-12: wrapAbortSignalForSdk allocates uniffi handles (controller + signal) with no GC;
				// free them once the download settles (success OR throw) — previously leaked on every fill.
				defer(() => {
					disposeSdkAbortSignal(wrappedSignal)
				})

				if (file.exists) {
					file.delete()
				}

				if (item.type === "external") {
					await FileSystem.File.downloadFileAsync(item.data.url, file, {
						idempotent: true
					})
				} else {
					if (item.data.type !== "file" && item.data.type !== "sharedFile" && item.data.type !== "sharedRootFile") {
						throw new Error("Item must be a file or shared file")
					}

					await authedSdkClient.downloadFileToPath(
						item.data.type === "file" ? new AnyFile.File(item.data.data) : new AnyFile.Shared(item.data.data),
						normalizeFilePathForSdk(file.uri),
						undefined,
						ManagedFuture.new({
							pauseSignal: undefined,
							abortSignal: wrappedSignal
						}),
						signal
							? {
									signal
								}
							: undefined
					)
				}

				if (!file.exists) {
					throw new Error("File does not exist after download")
				}

				// Atomic sidecar write (temp + single overwriting move): a crash mid-write can
				// no longer leave a torn sidecar. No delete-first — that would reopen the
				// window where a crash leaves the entry sidecar-less.
				if (item.type === "drive") {
					if (item.data.type !== "file" && item.data.type !== "sharedFile" && item.data.type !== "sharedRootFile") {
						throw new Error("Item must be a file or shared file")
					}

					atomicWrite(
						metadataFile,
						serialize({
							type: "drive",
							data: item.data,
							cachedAt: Date.now()
						} satisfies Metadata)
					)
				} else {
					atomicWrite(
						metadataFile,
						serialize({
							type: "external",
							data: item.data,
							cachedAt: Date.now()
						} satisfies Metadata)
					)
				}

				this.scheduleGc()

				return file
			} catch (e) {
				if (parentDirectory.exists) {
					parentDirectory.delete()
				}

				logger.error("fileCache", "file download/cache failed", { uuid: item.type === "drive" ? item.data.data.uuid : this.getExternalItemId(item as Extract<CacheItem, { type: "external" }>), error: e })

				throw e
			}
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	}

	public async remove(item: CacheItem): Promise<void> {
		if (item.type === "drive" && item.data.type !== "file" && item.data.type !== "sharedFile" && item.data.type !== "sharedRootFile") {
			throw new Error("Item must be a file or shared file")
		}

		const result = await run(async defer => {
			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			const mutex = this.getMutexForKey(item.type === "drive" ? item.data.data.uuid : this.getExternalItemId(item))

			await mutex.acquire()

			defer(() => {
				mutex.release()
			})

			const { file, metadata: metadataFile, parentDirectory } = this.getFiles(item)

			if (file.exists) {
				file.delete()
			}

			if (metadataFile.exists) {
				metadataFile.delete()
			}

			if (parentDirectory.exists) {
				parentDirectory.delete()
			}
		})

		if (!result.success) {
			throw result.error
		}
	}

	public async gc(age?: number): Promise<void> {
		if (!PARENT_DIRECTORY.exists) {
			return
		}

		// TC-14: participate in the ClearBarrier so a concurrent clear() (logout / "clear all disk caches" /
		// "clear preview cache") waits for this gc pass to drain instead of deleting+recreating
		// PARENT_DIRECTORY mid-sweep — matching has/get/remove, which already bracket their disk work with
		// enter()/leave().
		await this.clearBarrier.enter()

		try {
			await this.runGc(age)
		} finally {
			this.clearBarrier.leave()
		}
	}

	private async runGc(age?: number): Promise<void> {
		const toDelete: string[] = []
		const survivors: { key: string; cachedAt: number; size: number }[] = []
		const now = Date.now()
		const ttlMs = age ?? DEFAULT_GC_AGE_MS
		const entries = PARENT_DIRECTORY.list()
		const gcSemaphore = new Semaphore(GC_CONCURRENCY)

		await Promise.all(
			entries.map(async entry => {
				await gcSemaphore.acquire()

				try {
					const inspection = await run(async () => {
						if (!(entry instanceof FileSystem.Directory)) {
							return { kind: "skip" as const }
						}

						const uuid = entry.name
						const metadataFile = new FileSystem.File(FileSystem.Paths.join(entry.uri, `${uuid}.filenmeta`))

						if (!metadataFile.exists) {
							return { kind: "delete" as const, uuid }
						}

						const metadata = deserialize(await metadataFile.text()) as Metadata | null

						// TC-17: a parseable-but-malformed sidecar lacking a numeric cachedAt would make
						// `now >= NaN` false → it would survive forever AND its NaN cachedAt would poison the
						// size-cap eviction sort (NaN comparators are unstable). Treat a non-numeric cachedAt
						// as a corrupt deletion candidate (matches audioCache's parseMetadata cachedAt check).
						if (!metadata || Object.keys(metadata).length === 0 || typeof metadata.cachedAt !== "number" || now >= metadata.cachedAt + ttlMs) {
							return { kind: "delete" as const, uuid }
						}

						return {
							kind: "survive" as const,
							key: uuid,
							cachedAt: metadata.cachedAt,
							size: sumLocalDirectoryFileBytes(entry)
						}
					})

					if (inspection.success) {
						if (inspection.data.kind === "delete") {
							toDelete.push(inspection.data.uuid)
						} else if (inspection.data.kind === "survive") {
							survivors.push({
								key: inspection.data.key,
								cachedAt: inspection.data.cachedAt,
								size: inspection.data.size
							})
						}
					} else if (entry instanceof FileSystem.Directory) {
						// A read/parse failure for a well-shaped directory means the entry is corrupted —
						// schedule it for deletion so a future gc/clear can recover.
						logger.warn("fileCache", "gc inspection failed for entry, scheduling delete", { uuid: entry.name })
						toDelete.push(entry.name)
					}
				} finally {
					gcSemaphore.release()
				}
			})
		)

		// Soft size-cap eviction over the survivors: drop the oldest entries until the cache
		// is within CACHE_MAX_SIZE_BYTES, never the newest (the file just cached / in use). A
		// single entry larger than the cap is kept and ages out via the TTL above. cachedAt is
		// captured so Phase 2 skips any entry a concurrent get() refreshed since planning.
		const capCachedAt = new Map<string, number>()

		for (const survivor of survivors) {
			capCachedAt.set(survivor.key, survivor.cachedAt)
		}

		const capEvict = planSizeCapEviction(survivors, CACHE_MAX_SIZE_BYTES)

		await Promise.all(
			[...toDelete, ...capEvict].map(async uuid => {
				await run(async defer => {
					// TC-13: bound delete-pass concurrency too. Deferred first so it releases LAST (LIFO),
					// after the per-key mutex below — the mutex is correctness, this is the throughput cap.
					await gcSemaphore.acquire()

					defer(() => {
						gcSemaphore.release()
					})

					const mutex = this.getMutexForKey(uuid)

					await mutex.acquire()

					defer(() => {
						mutex.release()
					})

					const parentDirectory = new FileSystem.Directory(FileSystem.Paths.join(PARENT_DIRECTORY.uri, uuid))

					if (!parentDirectory.exists) {
						return
					}

					// Re-check inside the mutex. A concurrent get() may have written a fresh entry
					// for this uuid while we were queued behind it — Phase 1 ran without the mutex.
					// TTL/corrupt entries delete if still stale; a size-cap eviction only deletes if
					// its cachedAt is unchanged (a refresh makes it the newest → must be kept).
					const metadataFile = new FileSystem.File(FileSystem.Paths.join(parentDirectory.uri, `${uuid}.filenmeta`))
					const plannedCapCachedAt = capCachedAt.get(uuid)

					if (metadataFile.exists) {
						const recheck = await run(async () => {
							const metadata = deserialize(await metadataFile.text()) as Metadata | null

							if (!metadata || Object.keys(metadata).length === 0 || typeof metadata.cachedAt !== "number" || now >= metadata.cachedAt + ttlMs) {
								return true
							}

							return plannedCapCachedAt !== undefined && metadata.cachedAt === plannedCapCachedAt
						})

						if (recheck.success && !recheck.data) {
							return
						}
					}

					parentDirectory.delete()
				})
			})
		)
	}

	public async clear(): Promise<void> {
		await this.clearBarrier.runExclusive(() => {
			if (PARENT_DIRECTORY.exists) {
				PARENT_DIRECTORY.delete()
			}

			PARENT_DIRECTORY.create({
				idempotent: true,
				intermediates: true
			})

			this.directoryEnsured = true
		})
	}

	public size(): number {
		return sumLocalDirectoryFileBytes(PARENT_DIRECTORY)
	}
}

const fileCache = new FileCache()

export default fileCache
