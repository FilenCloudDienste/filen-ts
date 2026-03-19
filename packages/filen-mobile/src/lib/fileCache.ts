import * as FileSystem from "expo-file-system"
import { AnyFile, ManagedFuture } from "@filen/sdk-rs"
import { Semaphore, run } from "@filen/utils"
import { IOS_APP_GROUP_IDENTIFIER } from "@/constants"
import { Platform } from "react-native"
import type { DriveItem, DriveItemFileExtracted } from "@/types"
import { pack, unpack } from "@/lib/msgpack"
import isEqual from "react-fast-compare"
import auth from "@/lib/auth"
import { wrapAbortSignalForSdk, normalizeFilePathForSdk } from "@/lib/utils"

export type Metadata = DriveItemFileExtracted & {
	cachedAt: number
}

export class FileCache {
	public readonly version = 1
	private readonly parentDirectory = new FileSystem.Directory(
		Platform.select({
			ios: FileSystem.Paths.join(
				FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER]?.uri ?? FileSystem.Paths.document.uri,
				"fileCache",
				`v${this.version}`
			),
			default: FileSystem.Paths.join(FileSystem.Paths.document.uri, "fileCache", `v${this.version}`)
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

	public getFiles(item: DriveItem): {
		file: FileSystem.File
		metadata: FileSystem.File
		parentDirectory: FileSystem.Directory
	} {
		if (!item.data.decryptedMeta) {
			throw new Error("Item does not have decrypted metadata")
		}

		const parentDirectory = new FileSystem.Directory(FileSystem.Paths.join(this.parentDirectory.uri, item.data.uuid))

		if (!parentDirectory.exists) {
			parentDirectory.create({
				idempotent: true,
				intermediates: true
			})
		}

		return {
			file: new FileSystem.File(FileSystem.Paths.join(parentDirectory.uri, item.data.uuid)),
			metadata: new FileSystem.File(FileSystem.Paths.join(parentDirectory.uri, `${item.data.uuid}.filenmeta`)),
			parentDirectory
		}
	}

	public async has(item: DriveItem): Promise<boolean> {
		if (item.type !== "file" && item.type !== "sharedFile") {
			return false
		}

		const { file, metadata } = this.getFiles(item)

		if (!file.exists || !metadata.exists || metadata.size === 0) {
			return false
		}

		const metadataContent = unpack(await metadata.bytes()) as Metadata

		if (Object.keys(metadataContent).length === 0) {
			return false
		}

		const { cachedAt: _, ...metadataWithoutCachedAt } = metadataContent

		return isEqual(metadataWithoutCachedAt, item)
	}

	public async get({ item, signal }: { item: DriveItem; signal?: AbortSignal }): Promise<FileSystem.File> {
		if (item.type !== "file" && item.type !== "sharedFile") {
			throw new Error("Item must be a file or shared file")
		}

		const result = await run(async defer => {
			const mutex = this.getMutexForKey(item.data.uuid)

			await mutex.acquire()

			defer(() => {
				mutex.release()
			})

			const { file, metadata: metadataFile, parentDirectory } = this.getFiles(item)

			if (file.exists && metadataFile.exists && metadataFile.size > 0) {
				const metadata = unpack(await metadataFile.bytes()) as Metadata

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

				await authedSdkClient.downloadFileToPath(
					item.type === "file" ? new AnyFile.File(item.data) : new AnyFile.Shared(item.data),
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

				if (!file.exists) {
					throw new Error("File does not exist after download")
				}

				if (metadataFile.exists) {
					metadataFile.delete()
				}

				metadataFile.write(
					new Uint8Array(
						pack({
							...item,
							cachedAt: Date.now()
						} satisfies Metadata)
					)
				)

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

	public async remove(item: DriveItem): Promise<void> {
		if (item.type !== "file" && item.type !== "sharedFile") {
			throw new Error("Item must be a file or shared file")
		}

		const result = await run(async defer => {
			const mutex = this.getMutexForKey(item.data.uuid)

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

				const metadata = unpack(await metadataFile.bytes()) as Metadata

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
