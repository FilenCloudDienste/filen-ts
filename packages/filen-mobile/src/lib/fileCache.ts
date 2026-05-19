import * as FileSystem from "expo-file-system"
import { AnyFile, ManagedFuture } from "@filen/sdk-rs"
import { Semaphore, run } from "@filen/utils"
import type { CacheItem, DriveItemFileExtracted } from "@/types"
import { serialize, deserialize } from "@/lib/serializer"
import isEqual from "react-fast-compare"
import auth from "@/lib/auth"
import { wrapAbortSignalForSdk, normalizeFilePathForSdk } from "@/lib/utils"
import { sumLocalDirectoryFileBytes } from "@/lib/fsUtils"
import { ClearBarrier } from "@/lib/clearBarrier"
import offline from "@/lib/offline"
import { xxHash32 } from "js-xxhash"
import { FILE_CACHE_VERSION, FILE_CACHE_PARENT_DIRECTORY } from "@/lib/storageRoots"

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
export const PARENT_DIRECTORY = FILE_CACHE_PARENT_DIRECTORY

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

	public constructor() {
		this.ensureDirectory()
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

			const metadataContent = deserialize(await metadata.text()) as Metadata

			if (Object.keys(metadataContent).length === 0) {
				return false
			}

			const { cachedAt: _, ...metadataWithoutCachedAt } = metadataContent

			return isEqual(metadataWithoutCachedAt, item)
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
				const metadata = deserialize(await metadataFile.text()) as Metadata

				if (Object.keys(metadata).length > 0) {
					const { cachedAt: _, ...metadataWithoutCachedAt } = metadata

					if (isEqual(metadataWithoutCachedAt, item)) {
						return file
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

				if (metadataFile.exists) {
					metadataFile.delete()
				}

				if (item.type === "drive") {
					if (item.data.type !== "file" && item.data.type !== "sharedFile" && item.data.type !== "sharedRootFile") {
						throw new Error("Item must be a file or shared file")
					}

					metadataFile.write(
						serialize({
							type: "drive",
							data: item.data,
							cachedAt: Date.now()
						} satisfies Metadata)
					)
				} else {
					metadataFile.write(
						serialize({
							type: "external",
							data: item.data,
							cachedAt: Date.now()
						} satisfies Metadata)
					)
				}

				return file
			} catch (e) {
				if (parentDirectory.exists) {
					parentDirectory.delete()
				}

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

		const toDelete: string[] = []
		const now = Date.now()
		const entries = PARENT_DIRECTORY.list()

		await Promise.all(
			entries.map(async entry => {
				const inspection = await run(async () => {
					if (!(entry instanceof FileSystem.Directory)) {
						return null
					}

					const uuid = entry.name
					const metadataFile = new FileSystem.File(FileSystem.Paths.join(entry.uri, `${uuid}.filenmeta`))

					if (!metadataFile.exists) {
						return uuid
					}

					const metadata = deserialize(await metadataFile.text()) as Metadata | null

					if (!metadata || Object.keys(metadata).length === 0 || now >= metadata.cachedAt + (age ?? 86400 * 1000)) {
						return uuid
					}

					return null
				})

				if (inspection.success && inspection.data) {
					toDelete.push(inspection.data)
				} else if (!inspection.success && entry instanceof FileSystem.Directory) {
					// A read/parse failure for a well-shaped directory means the entry is corrupted —
					// schedule it for deletion so a future gc/clear can recover.
					toDelete.push(entry.name)
				}
			})
		)

		await Promise.all(
			toDelete.map(async uuid => {
				await run(async defer => {
					const mutex = this.getMutexForKey(uuid)

					await mutex.acquire()

					defer(() => {
						mutex.release()
					})

					const parentDirectory = new FileSystem.Directory(FileSystem.Paths.join(PARENT_DIRECTORY.uri, uuid))

					if (parentDirectory.exists) {
						parentDirectory.delete()
					}
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
