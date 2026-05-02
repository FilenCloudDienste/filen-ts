import * as FileSystem from "expo-file-system"
import { AnyFile, ManagedFuture } from "@filen/sdk-rs"
import { Semaphore, run } from "@filen/utils"
import { IOS_APP_GROUP_IDENTIFIER } from "@/constants"
import { Platform } from "react-native"
import type { CacheItem, DriveItemFileExtracted } from "@/types"
import { serialize, deserialize } from "@/lib/serializer"
import isEqual from "react-fast-compare"
import auth from "@/lib/auth"
import { wrapAbortSignalForSdk, normalizeFilePathForSdk } from "@/lib/utils"
import offline from "@/lib/offline"
import { xxHash32 } from "js-xxhash"

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

export class FileCache {
	// Critical: When changing anything related to storage index/store/persistence format, increment the VERSION constant to invalidate old caches and prevent potential issues from stale or incompatible data.
	public readonly version = 1
	private readonly parentDirectory = new FileSystem.Directory(
		Platform.select({
			ios: FileSystem.Paths.join(
				FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER] ?? FileSystem.Paths.document,
				"fileCache",
				`v${this.version}`
			),
			default: FileSystem.Paths.join(FileSystem.Paths.document, "fileCache", `v${this.version}`)
		})
	)
	private readonly mutexes = new Map<string, Semaphore>()
	private directoryEnsured = false

	private ensureDirectory(): void {
		if (this.directoryEnsured) {
			return
		}

		if (!this.parentDirectory.exists) {
			this.parentDirectory.create({
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
			FileSystem.Paths.join(this.parentDirectory.uri, item.type === "drive" ? item.data.data.uuid : this.getExternalItemId(item))
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
		const toDelete: string[] = []
		const now = Date.now()
		const entries = this.parentDirectory.list()

		await Promise.all(
			entries.map(async entry => {
				if (!(entry instanceof FileSystem.Directory)) {
					return
				}

				const uuid = entry.name
				const metadataFile = new FileSystem.File(FileSystem.Paths.join(entry.uri, `${uuid}.filenmeta`))

				if (!metadataFile.exists) {
					toDelete.push(uuid)

					return
				}

				const metadata = deserialize(await metadataFile.text()) as Metadata

				if (Object.keys(metadata).length === 0 || now > metadata.cachedAt + (age ?? 86400 * 1000)) {
					toDelete.push(uuid)
				}
			})
		)

		await Promise.all(
			toDelete.map(async uuid => {
				await run(
					async defer => {
						const mutex = this.getMutexForKey(uuid)

						await mutex.acquire()

						defer(() => {
							mutex.release()
						})

						const parentDirectory = new FileSystem.Directory(FileSystem.Paths.join(this.parentDirectory.uri, uuid))

						if (parentDirectory.exists) {
							parentDirectory.delete()
						}
					},
					{
						throw: true
					}
				)
			})
		)
	}
}

const fileCache = new FileCache()

export default fileCache
