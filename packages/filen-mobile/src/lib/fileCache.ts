import * as FileSystem from "expo-file-system"
import { extnameOf } from "@/lib/previewType"
import { AnyFile, ManagedFuture } from "@filen/sdk-rs"
import { Semaphore, run } from "@filen/shared"
import type { CacheItem, DriveItemFileExtracted } from "@/types"
import { serialize, deserialize } from "@/lib/serializer"
import { atomicWrite } from "@/lib/fsAtomic"
import auth from "@/lib/auth"
import { normalizeFilePathForSdk } from "@/lib/paths"
import { wrapAbortSignalForSdk, disposeSdkAbortSignal, toSignalOpts } from "@/lib/signals"
import { ensureDirectory, sumLocalDirectoryFileBytes } from "@/lib/fsUtils"
import { DiskCache, cacheItemId, planGcCapEviction, type GcSurvivor } from "@/lib/diskCache"
import offline from "@/features/offline/offline"
import { FILE_CACHE_PARENT_DIRECTORY } from "@/lib/storageRoots"
import { metaFileName } from "@/lib/metaFile"
import { CACHE_MAX_SIZE_BYTES } from "@/lib/cacheEviction"
import { GC_AGE_MS, GC_CONCURRENCY } from "@/lib/cacheGc"
import logger from "@/lib/logger"
import { isFileItem } from "@/features/drive/driveSelectors"

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

// Changing the storage index/persistence format requires bumping FILE_CACHE_VERSION in storageRoots.ts.

export const PARENT_DIRECTORY = FILE_CACHE_PARENT_DIRECTORY

// Empty or expired. A sidecar without a numeric cachedAt counts as stale: `now >= NaN` is false, so
// it would survive forever and its NaN would poison the size-cap eviction sort.
function isStaleSidecar(metadata: Metadata, now: number, ttlMs: number): boolean {
	return Object.keys(metadata).length === 0 || typeof metadata.cachedAt !== "number" || now >= metadata.cachedAt + ttlMs
}

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
		if (!isFileItem(item.data)) {
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

export class FileCache extends DiskCache {
	public constructor() {
		super(PARENT_DIRECTORY, "fileCache")
	}

	public getFiles(
		item: CacheItem,
		opts?: {
			// Default true (write paths need the directory in place). Read-only derivations —
			// has(), audioCache's metadata peeks — pass false so a pure existence/metadata query
			// doesn't materialize an empty per-uuid directory that only gc reclaims later.
			ensureParentDirectory?: boolean
		}
	): {
		file: FileSystem.File
		metadata: FileSystem.File
		parentDirectory: FileSystem.Directory
	} {
		if (item.type === "drive" && !item.data.data.decryptedMeta) {
			throw new Error("Item does not have decrypted metadata")
		}

		// Resolved once: an external item's id hashes its URL.
		const itemId = cacheItemId(item)
		const parentDirectory = new FileSystem.Directory(FileSystem.Paths.join(PARENT_DIRECTORY.uri, itemId))

		if (opts?.ensureParentDirectory ?? true) {
			ensureDirectory(parentDirectory)
		}

		return {
			file: new FileSystem.File(
				FileSystem.Paths.join(
					parentDirectory.uri,
					`${itemId}${extnameOf(item.type === "drive" ? (item.data.data.decryptedMeta?.name ?? "") : item.data.name)}`
				)
			),
			metadata: new FileSystem.File(
				FileSystem.Paths.join(
					parentDirectory.uri,
					metaFileName(itemId)
				)
			),
			parentDirectory
		}
	}

	public async has(item: CacheItem): Promise<boolean> {
		if (item.type === "drive" && !isFileItem(item.data)) {
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

			// Read-only probe: never materialize the per-uuid directory just to answer false.
			const { file, metadata } = this.getFiles(item, { ensureParentDirectory: false })

			if (!file.exists || !metadata.exists || metadata.size === 0) {
				return false
			}

			let metadataContent: Metadata | null = null

			try {
				metadataContent = deserialize(await metadata.text()) as Metadata
			} catch (e) {
				logger.warn("fileCache", "sidecar parse failed in has", {
					uuid: item.type === "drive" ? item.data.data.uuid : undefined,
					error: e
				})

				// Torn/unparseable sidecar (crash mid-write before sidecars became atomic,
				// disk corruption): self-heal at access time — treat as a miss and drop the
				// sidecar so the next get() re-downloads, instead of throwing until gc.
				//
				// TC-16: do the delete UNDER the per-key mutex (has() otherwise holds no per-key lock),
				// and re-check the sidecar under the lock first. A concurrent get() holds this same mutex
				// while writing a FRESH sidecar via atomicWrite (delete-temp-then-move) — without this,
				// has() could delete the valid sidecar get() just materialized, forcing a needless re-download.
				const mutex = this.getMutexForKey(cacheItemId(item))

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
		if (item.type === "drive" && !isFileItem(item.data)) {
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

			const mutex = this.getMutexForKey(cacheItemId(item))

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
					logger.warn("fileCache", "sidecar parse failed in get, re-downloading", {
						uuid: item.type === "drive" ? item.data.data.uuid : undefined,
						error: e
					})

					if (metadataFile.exists) {
						metadataFile.delete()
					}
				}
			}

			ensureDirectory(parentDirectory)

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
					if (!isFileItem(item.data)) {
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
						toSignalOpts(signal)
					)
				}

				if (!file.exists) {
					throw new Error("File does not exist after download")
				}

				// Atomic sidecar write (temp + single overwriting move): a crash mid-write can
				// no longer leave a torn sidecar. No delete-first — that would reopen the
				// window where a crash leaves the entry sidecar-less.
				if (item.type === "drive") {
					if (!isFileItem(item.data)) {
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

				logger.error("fileCache", "file download/cache failed", {
					uuid: cacheItemId(item),
					error: e
				})

				throw e
			}
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	}

	public async remove(item: CacheItem): Promise<void> {
		if (item.type === "drive" && !isFileItem(item.data)) {
			throw new Error("Item must be a file or shared file")
		}

		const result = await run(async defer => {
			await this.clearBarrier.enter()

			defer(() => {
				this.clearBarrier.leave()
			})

			const mutex = this.getMutexForKey(cacheItemId(item))

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

	protected async runGc(age?: number): Promise<void> {
		const toDelete: string[] = []
		const survivors: GcSurvivor[] = []
		const now = Date.now()
		const ttlMs = age ?? GC_AGE_MS
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
						const metadataFile = new FileSystem.File(FileSystem.Paths.join(entry.uri, metaFileName(uuid)))

						if (!metadataFile.exists) {
							return { kind: "delete" as const, uuid }
						}

						const metadata = deserialize(await metadataFile.text()) as Metadata | null

						if (!metadata || isStaleSidecar(metadata, now, ttlMs)) {
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

		const { evict: capEvict, plannedCachedAt: capCachedAt } = planGcCapEviction(survivors, CACHE_MAX_SIZE_BYTES)

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
					const metadataFile = new FileSystem.File(FileSystem.Paths.join(parentDirectory.uri, metaFileName(uuid)))
					const plannedCapCachedAt = capCachedAt.get(uuid)

					if (metadataFile.exists) {
						const recheck = await run(async () => {
							const metadata = deserialize(await metadataFile.text()) as Metadata | null

							if (!metadata || isStaleSidecar(metadata, now, ttlMs)) {
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
}

const fileCache = new FileCache()

export default fileCache
