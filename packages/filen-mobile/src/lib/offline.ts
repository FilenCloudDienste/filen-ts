import * as FileSystem from "expo-file-system"
import { Platform } from "react-native"
import { IOS_APP_GROUP_IDENTIFIER } from "@/constants"
import type { DriveItem } from "@/types"
import { run, Semaphore } from "@filen/utils"
import transfers from "@/lib/transfers"
import { pack, unpack } from "msgpackr"
import auth from "@/lib/auth"
import {
	AnyDirEnum,
	AnyDirEnumWithShareInfo,
	AnyDirEnumWithShareInfo_Tags,
	type File,
	type Dir,
	SharingRole_Tags,
	DirEnum,
	type SharedFile,
	DirWithMetaEnum_Tags,
	type SharedDir,
	ErrorKind
} from "@filen/sdk-rs"
import {
	unwrapFileMeta,
	normalizeFilePathForSdk,
	unwrapDirMeta,
	unwrappedDirIntoDriveItem,
	unwrappedFileIntoDriveItem,
	unwrapSdkError
} from "@/lib/utils"
import { validate as validateUuid } from "uuid"
import useOfflineStore from "@/stores/useOffline.store"
import { driveItemStoredOfflineQueryUpdate } from "@/queries/useDriveItemStoredOffline.query"

export type FileOrDirectoryOfflineMeta = {
	item: DriveItem
	parent: AnyDirEnumWithShareInfo
}

export type DirectoryOfflineMeta = FileOrDirectoryOfflineMeta & {
	entries: Record<
		string,
		{
			item: DriveItem
		}
	>
}

export type Uuid = string

export type Index = {
	files: Record<
		Uuid,
		{
			item: DriveItem
			parent: AnyDirEnumWithShareInfo
		}
	>
	directories: Record<
		Uuid,
		{
			item: DriveItem
			parent: AnyDirEnumWithShareInfo
		}
	>
}

export class Offline {
	private readonly version = 1
	private readonly directory: FileSystem.Directory = new FileSystem.Directory(
		Platform.select({
			ios: FileSystem.Paths.join(
				FileSystem.Paths.appleSharedContainers?.[IOS_APP_GROUP_IDENTIFIER]?.uri ?? FileSystem.Paths.document.uri,
				`offline_v${this.version}`
			),
			default: FileSystem.Paths.join(FileSystem.Paths.document.uri, `offline_v${this.version}`)
		})
	)
	private readonly filesDirectory: FileSystem.Directory = new FileSystem.Directory(FileSystem.Paths.join(this.directory.uri, "files"))
	private readonly directoriesDirectory: FileSystem.Directory = new FileSystem.Directory(
		FileSystem.Paths.join(this.directory.uri, "directories")
	)
	private readonly indexFile = new FileSystem.File(FileSystem.Paths.join(this.directory.uri, "index"))
	private readonly indexMutex = new Semaphore(1)
	private indexCache: Index | null = null
	private readonly syncMutex = new Semaphore(1)
	private readonly storeMutex = new Semaphore(1)
	private readonly listDirectoriesCache = new Map<string, Awaited<ReturnType<Offline["listDirectories"]>>>()
	private listFilesCache: Awaited<ReturnType<Offline["listFiles"]>> | null = null
	private listDirectoriesRecursiveCache: Awaited<ReturnType<Offline["listDirectoriesRecursive"]>> | null = null
	private readonly itemSizeCache = new Map<
		string,
		{
			size: number
			files: number
			dirs: number
		}
	>()
	private readonly isItemStoredCache = new Map<string, boolean>()
	private readonly getLocalFileCache = new Map<string, FileSystem.File>()
	private readonly getLocalDirectoryCache = new Map<string, FileSystem.Directory>()

	public constructor() {
		this.ensureDirectories()
	}

	private ensureDirectories(): void {
		if (!this.directory.exists) {
			this.directory.create({
				intermediates: true,
				idempotent: true
			})
		}

		if (!this.filesDirectory.exists) {
			this.filesDirectory.create({
				intermediates: true,
				idempotent: true
			})
		}

		if (!this.directoriesDirectory.exists) {
			this.directoriesDirectory.create({
				intermediates: true,
				idempotent: true
			})
		}
	}

	private invalidateCaches(): void {
		this.listFilesCache = null
		this.listDirectoriesCache.clear()
		this.listDirectoriesRecursiveCache = null
		this.itemSizeCache.clear()
		this.isItemStoredCache.clear()
		this.getLocalFileCache.clear()
		this.getLocalDirectoryCache.clear()
	}

	private async updateIndex(): Promise<void> {
		await run(
			async defer => {
				await this.indexMutex.acquire()

				defer(() => {
					this.indexMutex.release()
				})

				this.ensureDirectories()
				this.invalidateCaches()

				const [files, directories] = await Promise.all([this.listFiles(), this.listDirectoriesRecursive()])
				const indexFiles: Index["files"] = {}
				const indexDirectories: Index["directories"] = {}

				for (const { item, parent } of files) {
					indexFiles[item.data.uuid] = {
						item,
						parent
					}

					driveItemStoredOfflineQueryUpdate({
						updater: true,
						params: {
							uuid: item.data.uuid,
							type: item.type
						}
					})
				}

				for (const { item, parent } of directories.directories) {
					indexDirectories[item.data.uuid] = {
						item,
						parent
					}

					driveItemStoredOfflineQueryUpdate({
						updater: true,
						params: {
							uuid: item.data.uuid,
							type: item.type
						}
					})
				}

				for (const { item, parent } of directories.files) {
					indexFiles[item.data.uuid] = {
						item,
						parent
					}

					driveItemStoredOfflineQueryUpdate({
						updater: true,
						params: {
							uuid: item.data.uuid,
							type: item.type
						}
					})
				}

				const index: Index = {
					files: indexFiles,
					directories: indexDirectories
				}

				this.indexFile.write(new Uint8Array(pack(index satisfies Index)))
				this.indexCache = index
			},
			{
				throw: true
			}
		)
	}

	private async readIndex(): Promise<Index> {
		if (this.indexCache) {
			return this.indexCache
		}

		const result = await run(async defer => {
			await this.indexMutex.acquire()

			defer(() => {
				this.indexMutex.release()
			})

			if (this.indexCache) {
				return this.indexCache
			}

			this.ensureDirectories()

			if (!this.indexFile.exists) {
				return {
					files: {},
					directories: {}
				} satisfies Index
			}

			const index: Index = unpack(await this.indexFile.bytes())

			this.indexCache = index

			return index
		})

		if (!result.success) {
			throw result.error
		}

		return result.data
	}

	public async isItemStored(item: DriveItem): Promise<boolean> {
		const cachedStored = this.isItemStoredCache.get(item.data.uuid)

		if (cachedStored !== undefined) {
			return cachedStored
		}

		this.ensureDirectories()

		const index = await this.readIndex()

		switch (item.type) {
			case "directory":
			case "sharedDirectory": {
				const storedDir = Boolean(index.directories[item.data.uuid])

				this.isItemStoredCache.set(item.data.uuid, storedDir)

				return storedDir
			}

			case "file":
			case "sharedFile": {
				const storedFile = Boolean(index.files[item.data.uuid])

				this.isItemStoredCache.set(item.data.uuid, storedFile)

				return storedFile
			}
		}
	}

	public async sync(): Promise<void> {
		await run(
			async defer => {
				await this.syncMutex.acquire()

				useOfflineStore.getState().setSyncing(true)

				defer(() => {
					useOfflineStore.getState().setSyncing(false)

					this.syncMutex.release()
				})

				this.ensureDirectories()

				const [files, { directories: topLevelDirectories }, { authedSdkClient }] = await Promise.all([
					this.listFiles(),
					this.listDirectories(),
					auth.getSdkClients()
				])

				const parentCacheKey = (parent: AnyDirEnumWithShareInfo): string => {
					switch (parent.tag) {
						case AnyDirEnumWithShareInfo_Tags.Dir: {
							return `dir:${parent.inner[0].uuid}`
						}

						case AnyDirEnumWithShareInfo_Tags.Root: {
							return `root:${parent.inner[0].uuid}`
						}

						case AnyDirEnumWithShareInfo_Tags.SharedDir: {
							const sharedDir = parent.inner[0]

							if (sharedDir.sharingRole.tag === SharingRole_Tags.Sharer) {
								switch (sharedDir.dir.tag) {
									case DirWithMetaEnum_Tags.Dir: {
										return `dir:${sharedDir.dir.inner[0].uuid}`
									}

									case DirWithMetaEnum_Tags.Root: {
										return `root:${sharedDir.dir.inner[0].uuid}`
									}
								}
							}

							switch (sharedDir.dir.tag) {
								case DirWithMetaEnum_Tags.Dir: {
									return `shared-dir:${sharedDir.dir.inner[0].uuid}`
								}

								case DirWithMetaEnum_Tags.Root: {
									return `shared-root:${sharedDir.dir.inner[0].uuid}`
								}
							}
						}
					}
				}

				const uniqueParents = new Map<string, AnyDirEnumWithShareInfo>()

				for (const { parent } of files) {
					const key = parentCacheKey(parent)

					if (!uniqueParents.has(key)) {
						uniqueParents.set(key, parent)
					}
				}

				for (const { parent } of topLevelDirectories) {
					const key = parentCacheKey(parent)

					if (!uniqueParents.has(key)) {
						uniqueParents.set(key, parent)
					}
				}

				const parentListings = new Map<
					string,
					Awaited<ReturnType<typeof authedSdkClient.listDir> | ReturnType<typeof authedSdkClient.listInShared>> | null
				>()

				await Promise.all(
					Array.from(uniqueParents.entries()).map(async ([key, parent]) => {
						const listResult = await run(async () => {
							switch (parent.tag) {
								case AnyDirEnumWithShareInfo_Tags.Dir: {
									return authedSdkClient.listDir(new DirEnum.Dir(parent.inner[0]))
								}

								case AnyDirEnumWithShareInfo_Tags.Root: {
									return authedSdkClient.listDir(new DirEnum.Root(parent.inner[0]))
								}

								case AnyDirEnumWithShareInfo_Tags.SharedDir: {
									if (parent.inner[0].sharingRole.tag === SharingRole_Tags.Sharer) {
										switch (parent.inner[0].dir.tag) {
											case DirWithMetaEnum_Tags.Dir: {
												return authedSdkClient.listDir(new DirEnum.Dir(parent.inner[0].dir.inner[0]))
											}

											case DirWithMetaEnum_Tags.Root: {
												return authedSdkClient.listDir(new DirEnum.Root(parent.inner[0].dir.inner[0]))
											}
										}
									}

									return authedSdkClient.listInShared(parent.inner[0].dir)
								}
							}
						})

						if (!listResult.success) {
							const unwrappedSdkError = unwrapSdkError(listResult.error)

							if (unwrappedSdkError && unwrappedSdkError.kind() === ErrorKind.FolderNotFound) {
								parentListings.set(key, null)

								return
							}

							throw listResult.error
						}

						parentListings.set(key, listResult.data)
					})
				)

				await Promise.all([
					...files.map(async ({ item, parent }) => {
						if (!item.data.decryptedMeta) {
							return
						}

						const dataFile = new FileSystem.File(
							FileSystem.Paths.join(this.filesDirectory.uri, item.data.uuid, item.data.decryptedMeta.name)
						)
						const metaFile = new FileSystem.File(
							FileSystem.Paths.join(this.filesDirectory.uri, item.data.uuid, `${item.data.uuid}.filenmeta`)
						)

						if (!dataFile.exists || !metaFile.exists) {
							if (dataFile.parentDirectory.exists) {
								dataFile.parentDirectory.delete()
							}

							return
						}

						const key = parentCacheKey(parent)
						const listing = parentListings.get(key)

						if (!listing) {
							if (dataFile.parentDirectory.exists) {
								dataFile.parentDirectory.delete()
							}

							return
						}

						const existingFile = listing.files.find(f => {
							const unwrappedFileMeta = unwrapFileMeta(f)

							if (!unwrappedFileMeta.meta) {
								return false
							}

							return (
								(unwrappedFileMeta.shared ? unwrappedFileMeta.file.file.uuid : unwrappedFileMeta.file.uuid) ===
								item.data.uuid
							)
						})

						if (!existingFile && dataFile.parentDirectory.exists) {
							dataFile.parentDirectory.delete()
						}

						if (existingFile && dataFile.exists && metaFile.exists) {
							const unwrappedFileMeta = unwrapFileMeta(existingFile)

							if (unwrappedFileMeta.meta && unwrappedFileMeta.meta.name !== item.data.decryptedMeta.name) {
								dataFile.rename(unwrappedFileMeta.meta.name)

								metaFile.write(
									new Uint8Array(
										pack({
											item: unwrappedFileIntoDriveItem(unwrappedFileMeta),
											parent
										} satisfies FileOrDirectoryOfflineMeta)
									)
								)
							}
						}

						const updatedFile = listing.files.find(f => {
							const unwrappedFileMeta = unwrapFileMeta(f)

							if (!unwrappedFileMeta.meta) {
								return false
							}

							return (
								unwrappedFileMeta.meta.name.trim().toLowerCase() === item.data.decryptedMeta?.name.trim().toLowerCase() &&
								(unwrappedFileMeta.shared ? unwrappedFileMeta.file.file.uuid : unwrappedFileMeta.file.uuid) !==
									item.data.uuid
							)
						})

						if (!updatedFile) {
							return
						}

						await this.storeFile({
							file: unwrappedFileIntoDriveItem(unwrapFileMeta(updatedFile)),
							parent,
							hideProgress: true,
							skipIndexUpdate: true
						})

						if (dataFile.parentDirectory.exists) {
							dataFile.parentDirectory.delete()
						}
					}),
					...topLevelDirectories.map(async ({ item, parent }) => {
						if (!item.data.decryptedMeta) {
							return
						}

						const metaFile = new FileSystem.File(
							FileSystem.Paths.join(this.directoriesDirectory.uri, item.data.uuid, `${item.data.uuid}.filenmeta`)
						)

						if (!metaFile.exists) {
							return
						}

						const key = parentCacheKey(parent)
						const listing = parentListings.get(key)

						if (!listing) {
							if (metaFile.parentDirectory.exists) {
								metaFile.parentDirectory.delete()
							}

							return
						}

						// TODO: handle root dir name change

						const remoteDir = (() => {
							switch (item.type) {
								case "directory": {
									return new AnyDirEnum.Dir(item.data)
								}

								case "sharedDirectory": {
									switch (item.data.dir.tag) {
										case DirWithMetaEnum_Tags.Dir: {
											return new AnyDirEnum.Dir(item.data.dir.inner[0])
										}

										case DirWithMetaEnum_Tags.Root: {
											return new AnyDirEnum.Root(item.data.dir.inner[0])
										}

										default: {
											throw new Error("Invalid dir tag")
										}
									}
								}

								default: {
									throw new Error("Invalid directory type")
								}
							}
						})()

						const [remoteDirectoryEntries, directoryMetaBytes] = await Promise.all([
							authedSdkClient.listDirRecursiveWithPaths(
								remoteDir,
								{
									onProgress() {
										// Noop
									}
								},
								{
									onErrors() {
										// Noop
									}
								}
							),
							metaFile.bytes()
						])

						const directoryMeta: DirectoryOfflineMeta = unpack(directoryMetaBytes)
						const localDirectories: Record<
							string,
							{
								item: DriveItem
								directory: FileSystem.Directory
							}
						> = {}
						const localFiles: Record<
							string,
							{
								item: DriveItem
								file: FileSystem.File
							}
						> = {}

						for (const path in directoryMeta.entries) {
							const entry = directoryMeta.entries[path]

							if (!entry) {
								continue
							}

							switch (entry.item.type) {
								case "directory":
								case "sharedDirectory": {
									const directory = new FileSystem.Directory(
										FileSystem.Paths.join(this.directoriesDirectory.uri, item.data.uuid, path)
									)

									if (directory.exists) {
										localDirectories[path] = {
											item: entry.item,
											directory
										}
									}

									break
								}

								case "file":
								case "sharedFile": {
									const file = new FileSystem.File(
										FileSystem.Paths.join(this.directoriesDirectory.uri, item.data.uuid, path)
									)

									if (file.exists) {
										localFiles[path] = {
											item: entry.item,
											file
										}
									}

									break
								}
							}
						}

						const remoteFiles: Record<string, File | SharedFile> = {}
						const remoteDirectories: Record<string, Dir | SharedDir> = {}

						for (const { dir, path } of remoteDirectoryEntries.dirs) {
							const normalizedPath = normalizeFilePathForSdk(path)

							remoteDirectories[normalizedPath] = dir
						}

						for (const { file, path } of remoteDirectoryEntries.files) {
							const normalizedPath = normalizeFilePathForSdk(path)

							remoteFiles[normalizedPath] = file
						}

						for (const path in localDirectories) {
							const localDirectory = localDirectories[path]
							const remoteDirectory = remoteDirectories[path]

							if (!remoteDirectory && localDirectory && localDirectory.directory.exists) {
								localDirectory.directory.delete()
							}
						}

						let needsFullResync = false

						for (const path in localFiles) {
							const localFile = localFiles[path]
							const remoteFile = remoteFiles[path]

							if (!remoteFile && localFile && localFile.file.exists) {
								localFile.file.delete()

								continue
							}

							if (
								remoteFile &&
								localFile &&
								localFile.item.data.decryptedMeta &&
								(localFile.item.type === "file" || localFile.item.type === "sharedFile")
							) {
								const unwrappedRemoteFile = unwrapFileMeta(remoteFile)

								if (
									unwrappedRemoteFile.meta &&
									unwrappedRemoteFile.meta.modified > localFile.item.data.decryptedMeta.modified &&
									localFile.file.exists
								) {
									localFile.file.delete()

									needsFullResync = true
								}
							}
						}

						for (const path in remoteDirectories) {
							const remoteDirectory = remoteDirectories[path]
							const localDirectory = localDirectories[path]

							if (!localDirectory && remoteDirectory) {
								needsFullResync = true
							}
						}

						for (const path in remoteFiles) {
							const remoteFile = remoteFiles[path]
							const localFile = localFiles[path]

							if (!localFile && remoteFile) {
								needsFullResync = true
							}
						}

						if (needsFullResync) {
							await this.storeDirectory({
								directory: item,
								parent,
								hideProgress: true,
								skipIndexUpdate: true
							})
						}
					})
				])

				await this.updateIndex()
			},
			{
				throw: true
			}
		)
	}

	public async listFiles(): Promise<
		{
			item: DriveItem
			parent: AnyDirEnumWithShareInfo
		}[]
	> {
		if (this.listFilesCache) {
			return this.listFilesCache
		}

		this.ensureDirectories()

		const entries = this.filesDirectory.list()
		const files: Awaited<ReturnType<typeof this.listFiles>> = []

		await Promise.all(
			entries.map(async entry => {
				if (!(entry instanceof FileSystem.Directory) || !validateUuid(entry.name)) {
					return
				}

				const innerEntries = entry.list()

				await Promise.all(
					innerEntries.map(async innerEntry => {
						if (!(innerEntry instanceof FileSystem.File) || innerEntry.name.endsWith(".filenmeta")) {
							return
						}

						const dataFile = innerEntry
						const metaFile = new FileSystem.File(
							FileSystem.Paths.join(dataFile.parentDirectory.uri, `${dataFile.parentDirectory.name}.filenmeta`)
						)

						if (!dataFile.exists || !metaFile.exists) {
							return
						}

						const meta: FileOrDirectoryOfflineMeta = unpack(await metaFile.bytes())

						if (meta.item.type !== "file" && meta.item.type !== "sharedFile") {
							return
						}

						files.push({
							item: meta.item,
							parent: meta.parent
						})
					})
				)
			})
		)

		this.listFilesCache = files

		return files
	}

	public async storeFile({
		file,
		parent,
		hideProgress,
		skipIndexUpdate
	}: {
		file: DriveItem
		parent: AnyDirEnumWithShareInfo
		hideProgress?: boolean
		skipIndexUpdate?: boolean
	}): Promise<void> {
		const result = await run(async defer => {
			if (file.type !== "file" && file.type !== "sharedFile") {
				throw new Error("Item not of type file")
			}

			if (!file.data.decryptedMeta) {
				throw new Error("File missing decrypted meta")
			}

			await this.storeMutex.acquire()

			defer(() => {
				this.storeMutex.release()
			})

			this.ensureDirectories()

			if (await this.isItemStored(file)) {
				return
			}

			const dataFile = new FileSystem.File(
				FileSystem.Paths.join(this.filesDirectory.uri, file.data.uuid, file.data.decryptedMeta.name)
			)
			const metaFile = new FileSystem.File(
				FileSystem.Paths.join(this.filesDirectory.uri, file.data.uuid, `${file.data.uuid}.filenmeta`)
			)

			if (dataFile.parentDirectory.exists) {
				dataFile.parentDirectory.delete()
			}

			dataFile.parentDirectory.create({
				intermediates: true,
				idempotent: true
			})

			const innerResult = await run(async () => {
				let done = false

				await transfers.download({
					item: file,
					destination: dataFile,
					itemUuid: file.data.uuid,
					hideProgress,
					awaitExternalCompletionBeforeMarkingAsFinished: async () => {
						while (!done) {
							await new Promise<void>(resolve => setTimeout(resolve, 100))
						}
					}
				})

				try {
					metaFile.write(
						new Uint8Array(
							pack({
								item: file,
								parent
							} satisfies FileOrDirectoryOfflineMeta)
						)
					)

					if (!skipIndexUpdate) {
						await this.updateIndex()
					}
				} finally {
					done = true
				}
			})

			if (!innerResult.success) {
				if (dataFile.parentDirectory.exists) {
					dataFile.parentDirectory.delete()
				}

				throw innerResult.error
			}

			return {
				dataFile,
				metaFile,
				file,
				parent
			}
		})

		if (!result.success) {
			throw result.error
		}
	}

	public async storeDirectory({
		directory,
		parent,
		hideProgress,
		skipIndexUpdate
	}: {
		directory: DriveItem
		parent: AnyDirEnumWithShareInfo
		hideProgress?: boolean
		skipIndexUpdate?: boolean
	}): Promise<void> {
		const result = await run(async defer => {
			if (directory.type !== "directory" && directory.type !== "sharedDirectory") {
				throw new Error("Item not of type directory")
			}

			if (!directory.data.decryptedMeta) {
				throw new Error("Directory missing decrypted meta")
			}

			await this.storeMutex.acquire()

			defer(() => {
				this.storeMutex.release()
			})

			this.ensureDirectories()

			if (await this.isItemStored(directory)) {
				return
			}

			const dataDirectory = new FileSystem.Directory(FileSystem.Paths.join(this.directoriesDirectory.uri, directory.data.uuid))
			const metaFile = new FileSystem.File(
				FileSystem.Paths.join(this.directoriesDirectory.uri, directory.data.uuid, `${directory.data.uuid}.filenmeta`)
			)

			if (!dataDirectory.exists) {
				dataDirectory.create({
					intermediates: true,
					idempotent: true
				})
			}

			const innerResult = await run(async () => {
				let done = false

				const transferred = await transfers.download({
					item: directory,
					destination: dataDirectory,
					itemUuid: directory.data.uuid,
					hideProgress,
					awaitExternalCompletionBeforeMarkingAsFinished: async () => {
						while (!done) {
							await new Promise<void>(resolve => setTimeout(resolve, 100))
						}
					}
				})

				const entries: DirectoryOfflineMeta["entries"] = {}
				const dataDirectoryUriNormalized = normalizeFilePathForSdk(dataDirectory.uri)

				for (const { dir, path } of transferred.directories) {
					const normalizedPath = normalizeFilePathForSdk(path.slice(dataDirectoryUriNormalized.length))

					entries[normalizedPath] = {
						item: unwrappedDirIntoDriveItem(unwrapDirMeta(dir))
					}
				}

				for (const { file, path } of transferred.files) {
					const normalizedPath = normalizeFilePathForSdk(path.slice(dataDirectoryUriNormalized.length))

					entries[normalizedPath] = {
						item: unwrappedFileIntoDriveItem(unwrapFileMeta(file))
					}
				}

				try {
					metaFile.write(
						new Uint8Array(
							pack({
								item: directory,
								parent,
								entries
							} satisfies DirectoryOfflineMeta)
						)
					)

					if (!skipIndexUpdate) {
						await this.updateIndex()
					}
				} finally {
					done = true
				}
			})

			if (!innerResult.success) {
				if (dataDirectory.exists) {
					dataDirectory.delete()
				}

				throw innerResult.error
			}

			return {
				directory,
				parent,
				dataDirectory,
				metaFile
			}
		})

		if (!result.success) {
			throw result.error
		}
	}

	private findParentAnyDirEnumWithShareInfo(pathToItem: Record<string, DriveItem>, dirname: string): AnyDirEnumWithShareInfo | null {
		const item = pathToItem[dirname]

		if (!item || (item.type !== "directory" && item.type !== "sharedDirectory")) {
			return null
		}

		switch (item.type) {
			case "directory": {
				return new AnyDirEnumWithShareInfo.Dir(item.data)
			}

			case "sharedDirectory": {
				switch (item.data.dir.tag) {
					case DirWithMetaEnum_Tags.Dir: {
						return new AnyDirEnumWithShareInfo.SharedDir(item.data)
					}

					case DirWithMetaEnum_Tags.Root: {
						return new AnyDirEnumWithShareInfo.Root(item.data)
					}

					default: {
						return null
					}
				}
			}
		}
	}

	public async listDirectories(parent?: AnyDirEnumWithShareInfo): Promise<{
		files: {
			item: DriveItem
			parent: AnyDirEnumWithShareInfo
		}[]
		directories: {
			item: DriveItem
			parent: AnyDirEnumWithShareInfo
		}[]
	}> {
		const cacheKey: string = parent
			? ((() => {
					switch (parent.tag) {
						case AnyDirEnumWithShareInfo_Tags.Dir:
						case AnyDirEnumWithShareInfo_Tags.SharedDir: {
							return unwrapDirMeta(parent.inner[0]).uuid
						}

						case AnyDirEnumWithShareInfo_Tags.Root: {
							return parent.inner[0].uuid
						}
					}
				})() ?? "__root__")
			: "__root__"

		const cached = this.listDirectoriesCache.get(cacheKey)

		if (cached) {
			return cached
		}

		this.ensureDirectories()

		const directories: Awaited<ReturnType<typeof this.listDirectories>>["directories"] = []
		const files: Awaited<ReturnType<typeof this.listDirectories>>["files"] = []
		const topLevelEntries = this.directoriesDirectory.list()

		// Fetch the root level if no parent is provided
		if (!parent) {
			await Promise.all(
				topLevelEntries.map(async topLevelEntry => {
					if (!(topLevelEntry instanceof FileSystem.Directory) || !validateUuid(topLevelEntry.name)) {
						return
					}

					const innerEntries = topLevelEntry.list()
					const metaFile = innerEntries.find(e => e instanceof FileSystem.File && e.name === `${topLevelEntry.name}.filenmeta`)

					if (!metaFile || !(metaFile instanceof FileSystem.File) || !metaFile.exists) {
						return
					}

					const meta: DirectoryOfflineMeta = unpack(await metaFile.bytes())

					if (meta.item.type !== "directory") {
						return
					}

					directories.push({
						item: meta.item,
						parent: meta.parent
					})
				})
			)

			const noParentResult = {
				files,
				directories
			}

			this.listDirectoriesCache.set(cacheKey, noParentResult)

			return noParentResult
		}

		const parentUuid: string | null = (() => {
			let parentUuid: string | null = null

			switch (parent.tag) {
				case AnyDirEnumWithShareInfo_Tags.Dir:
				case AnyDirEnumWithShareInfo_Tags.SharedDir: {
					parentUuid = unwrapDirMeta(parent.inner[0]).uuid

					break
				}

				case AnyDirEnumWithShareInfo_Tags.Root: {
					parentUuid = parent.inner[0].uuid

					break
				}
			}

			return parentUuid
		})()

		if (!parentUuid) {
			return {
				files,
				directories
			}
		}

		const topLevelMetas = await Promise.all(
			topLevelEntries
				.filter((e): e is FileSystem.Directory => e instanceof FileSystem.Directory && validateUuid(e.name))
				.map(async topLevelEntry => {
					const innerEntries = topLevelEntry.list()
					const metaFile = innerEntries.find(e => e instanceof FileSystem.File && e.name === `${topLevelEntry.name}.filenmeta`)

					if (!metaFile || !(metaFile instanceof FileSystem.File) || !metaFile.exists) {
						return null
					}

					const meta: DirectoryOfflineMeta = unpack(await metaFile.bytes())

					if (meta.item.type !== "directory") {
						return null
					}

					return {
						meta,
						topLevelUuid: topLevelEntry.name
					}
				})
		)

		let directoryMeta: DirectoryOfflineMeta | null = null
		let topLevelUuid: string | null = null

		for (const result of topLevelMetas) {
			if (!result) {
				continue
			}

			if (result.meta.item.data.uuid === parentUuid) {
				directoryMeta = result.meta
				topLevelUuid = result.topLevelUuid
				break
			}

			for (const path in result.meta.entries) {
				const entryMeta = result.meta.entries[path]

				if (!entryMeta) {
					continue
				}

				if (
					entryMeta.item.data.uuid === parentUuid &&
					(entryMeta.item.type === "directory" || entryMeta.item.type === "sharedDirectory")
				) {
					directoryMeta = result.meta
					topLevelUuid = result.topLevelUuid
					break
				}
			}

			if (directoryMeta) {
				break
			}
		}

		if (!directoryMeta || !topLevelUuid) {
			return {
				files,
				directories
			}
		}

		const uuidToPath: Record<string, string> = {
			[topLevelUuid]: "/"
		}
		const pathToItem: Record<string, DriveItem> = {
			"/": directoryMeta.item
		}

		for (const path in directoryMeta.entries) {
			const entryMeta = directoryMeta.entries[path]

			if (!entryMeta || (entryMeta.item.type !== "directory" && entryMeta.item.type !== "sharedDirectory")) {
				continue
			}

			const normalizedPath = normalizeFilePathForSdk(path)

			pathToItem[normalizedPath] = entryMeta.item
			uuidToPath[entryMeta.item.data.uuid] = normalizedPath
		}

		const targetPath = uuidToPath[parentUuid]

		if (!targetPath) {
			return {
				files,
				directories
			}
		}

		for (const path in directoryMeta.entries) {
			const entryMeta = directoryMeta.entries[path]

			if (!entryMeta) {
				continue
			}

			let dirname = FileSystem.Paths.dirname(normalizeFilePathForSdk(path))

			if (dirname === "." || dirname === "") {
				dirname = "/"
			}

			if (dirname !== targetPath) {
				continue
			}

			switch (entryMeta.item.type) {
				case "directory":
				case "sharedDirectory": {
					const parent = this.findParentAnyDirEnumWithShareInfo(pathToItem, dirname)

					if (!parent) {
						continue
					}

					directories.push({
						item: entryMeta.item,
						parent
					})

					break
				}

				case "file":
				case "sharedFile": {
					const parent = this.findParentAnyDirEnumWithShareInfo(pathToItem, dirname)

					if (!parent) {
						continue
					}

					files.push({
						item: entryMeta.item,
						parent
					})

					break
				}
			}
		}

		const parentResult = {
			files,
			directories
		}

		this.listDirectoriesCache.set(cacheKey, parentResult)

		return parentResult
	}

	public async listDirectoriesRecursive(): Promise<Awaited<ReturnType<typeof this.listDirectories>>> {
		if (this.listDirectoriesRecursiveCache) {
			return this.listDirectoriesRecursiveCache
		}

		this.ensureDirectories()

		const directories: Awaited<ReturnType<typeof this.listDirectories>>["directories"] = []
		const files: Awaited<ReturnType<typeof this.listDirectories>>["files"] = []
		const topLevelEntries = this.directoriesDirectory.list()

		await Promise.all(
			topLevelEntries.map(async topLevelEntry => {
				if (!(topLevelEntry instanceof FileSystem.Directory) || !validateUuid(topLevelEntry.name)) {
					return
				}

				const innerEntries = topLevelEntry.list()

				await Promise.all(
					innerEntries.map(async innerEntry => {
						if (
							!(innerEntry instanceof FileSystem.File) ||
							!innerEntry.name.endsWith(".filenmeta") ||
							innerEntry.name !== `${topLevelEntry.name}.filenmeta`
						) {
							return
						}

						const directoryMeta: DirectoryOfflineMeta = unpack(await innerEntry.bytes())

						if (directoryMeta.item.type !== "directory" && directoryMeta.item.type !== "sharedDirectory") {
							return
						}

						directories.push({
							item: directoryMeta.item,
							parent: directoryMeta.parent
						})

						const pathToItem: Record<string, DriveItem> = {
							"/": directoryMeta.item
						}

						for (const path in directoryMeta.entries) {
							const entryMeta = directoryMeta.entries[path]

							if (!entryMeta || (entryMeta.item.type !== "directory" && entryMeta.item.type !== "sharedDirectory")) {
								continue
							}

							const normalizedPath = normalizeFilePathForSdk(path)

							pathToItem[normalizedPath] = entryMeta.item
						}

						for (const path in directoryMeta.entries) {
							const entryMeta = directoryMeta.entries[path]

							if (!entryMeta) {
								continue
							}

							let dirname = FileSystem.Paths.dirname(normalizeFilePathForSdk(path))

							if (dirname === "." || dirname === "") {
								dirname = "/"
							}

							switch (entryMeta.item.type) {
								case "directory":
								case "sharedDirectory": {
									const parent = this.findParentAnyDirEnumWithShareInfo(pathToItem, dirname)

									if (!parent) {
										continue
									}

									directories.push({
										item: entryMeta.item,
										parent
									})

									break
								}

								case "file":
								case "sharedFile": {
									const parent = this.findParentAnyDirEnumWithShareInfo(pathToItem, dirname)

									if (!parent) {
										continue
									}

									files.push({
										item: entryMeta.item,
										parent
									})

									break
								}
							}
						}
					})
				)
			})
		)

		const recursiveResult = {
			files,
			directories
		}

		this.listDirectoriesRecursiveCache = recursiveResult

		return recursiveResult
	}

	public async itemSize(item: DriveItem): Promise<{
		size: number
		files: number
		dirs: number
	}> {
		const cachedSize = this.itemSizeCache.get(item.data.uuid)

		if (cachedSize) {
			return cachedSize
		}

		this.ensureDirectories()

		switch (item.type) {
			case "file":
			case "sharedFile": {
				const index = await this.readIndex()
				const fileEntry = index.files[item.data.uuid]

				if (!fileEntry || (fileEntry.item.type !== "file" && fileEntry.item.type !== "sharedFile")) {
					return {
						size: 0,
						files: 0,
						dirs: 0
					}
				}

				const size = Number(fileEntry.item.data.decryptedMeta?.size ?? 0)

				this.itemSizeCache.set(item.data.uuid, {
					size,
					files: 0,
					dirs: 0
				})

				return {
					size,
					files: 0,
					dirs: 0
				}
			}

			case "directory":
			case "sharedDirectory": {
				this.ensureDirectories()

				const topLevelEntries = this.directoriesDirectory.list()

				const sizes = await Promise.all(
					topLevelEntries
						.filter((e): e is FileSystem.Directory => e instanceof FileSystem.Directory && validateUuid(e.name))
						.map(async topLevelEntry => {
							const metaFile = new FileSystem.File(
								FileSystem.Paths.join(this.directoriesDirectory.uri, topLevelEntry.name, `${topLevelEntry.name}.filenmeta`)
							)

							if (!metaFile.exists) {
								return {
									size: 0,
									files: 0,
									dirs: 0
								}
							}

							const directoryMeta: DirectoryOfflineMeta = unpack(await metaFile.bytes())

							if (directoryMeta.item.data.uuid !== item.data.uuid) {
								let found = false

								for (const path in directoryMeta.entries) {
									const e = directoryMeta.entries[path]

									if (e && e.item.data.uuid === item.data.uuid && e.item.type === item.type) {
										found = true

										break
									}
								}

								if (!found) {
									return {
										size: 0,
										files: 0,
										dirs: 0
									}
								}
							}

							const uuidToPath: Record<string, string> = {
								[topLevelEntry.name]: "/"
							}

							for (const path in directoryMeta.entries) {
								const entryMeta = directoryMeta.entries[path]

								if (!entryMeta || (entryMeta.item.type !== "directory" && entryMeta.item.type !== "sharedDirectory")) {
									continue
								}

								uuidToPath[entryMeta.item.data.uuid] = normalizeFilePathForSdk(path)
							}

							const targetPath = uuidToPath[item.data.uuid]

							if (!targetPath) {
								return {
									size: 0,
									files: 0,
									dirs: 0
								}
							}

							let size = 0
							let files = 0
							let dirs = 0

							for (const path in directoryMeta.entries) {
								const entryMeta = directoryMeta.entries[path]

								if (!entryMeta) {
									continue
								}

								let dirname = FileSystem.Paths.dirname(normalizeFilePathForSdk(path))

								if (dirname === "." || dirname === "") {
									dirname = "/"
								}

								if (!dirname.startsWith(targetPath)) {
									continue
								}

								switch (entryMeta.item.type) {
									case "directory":
									case "sharedDirectory": {
										dirs += 1

										break
									}

									case "file":
									case "sharedFile": {
										size += Number(entryMeta.item.data.decryptedMeta?.size ?? 0)
										files += 1

										break
									}
								}
							}

							return {
								size,
								files,
								dirs
							}
						})
				)

				const { size, files, dirs } = sizes.reduce(
					(a, b) => ({
						size: a.size + b.size,
						files: a.files + b.files,
						dirs: a.dirs + b.dirs
					}),
					{
						size: 0,
						files: 0,
						dirs: 0
					}
				)

				this.itemSizeCache.set(item.data.uuid, {
					size,
					files,
					dirs
				})

				return {
					size,
					files,
					dirs
				}
			}
		}
	}

	public async removeItem(item: DriveItem): Promise<void> {
		const result = await run(async defer => {
			await this.storeMutex.acquire()

			defer(() => {
				this.storeMutex.release()
			})

			this.ensureDirectories()

			if (item.type === "file" || item.type === "sharedFile") {
				const parentDirectory = new FileSystem.Directory(FileSystem.Paths.join(this.filesDirectory.uri, item.data.uuid))

				if (parentDirectory.exists) {
					parentDirectory.delete()

					await this.updateIndex()
				}
			} else {
				const { directories: topLevelDirectories } = await this.listDirectories()

				await Promise.all(
					topLevelDirectories.map(async ({ item: directoryItem }) => {
						if (directoryItem.type !== "directory" && directoryItem.type !== "sharedDirectory") {
							return
						}

						// Only allow removing the directory if it's top level
						if (directoryItem.data.uuid !== item.data.uuid) {
							return
						}

						const dataDirectory = new FileSystem.Directory(
							FileSystem.Paths.join(this.directoriesDirectory.uri, directoryItem.data.uuid)
						)

						if (!dataDirectory.exists) {
							return
						}

						dataDirectory.delete()

						await this.updateIndex()
					})
				)
			}

			driveItemStoredOfflineQueryUpdate({
				updater: false,
				params: {
					uuid: item.data.uuid,
					type: item.type
				}
			})
		})

		if (!result.success) {
			throw result.error
		}
	}

	public async getLocalFile(item: DriveItem): Promise<FileSystem.File | null> {
		const cachedLocalFile = this.getLocalFileCache.get(item.data.uuid)

		if (cachedLocalFile) {
			return cachedLocalFile
		}

		if (item.type !== "file" && item.type !== "sharedFile") {
			return null
		}

		this.ensureDirectories()

		const index = await this.readIndex()
		const fileEntry = index.files[item.data.uuid]

		if (!fileEntry || (fileEntry.item.type !== "file" && fileEntry.item.type !== "sharedFile")) {
			return null
		}

		const file = new FileSystem.File(
			FileSystem.Paths.join(this.filesDirectory.uri, fileEntry.item.data.uuid, fileEntry.item.data.decryptedMeta?.name ?? "")
		)

		if (file.exists) {
			this.getLocalFileCache.set(item.data.uuid, file)

			return file
		}

		const { directories: topLevelDirectories } = await this.listDirectories()

		const results = await Promise.all(
			topLevelDirectories.map(async ({ item: directoryItem }) => {
				if (directoryItem.type !== "directory" && directoryItem.type !== "sharedDirectory") {
					return null
				}

				const directoryMetaFile = new FileSystem.File(
					FileSystem.Paths.join(this.directoriesDirectory.uri, directoryItem.data.uuid, `${directoryItem.data.uuid}.filenmeta`)
				)

				if (!directoryMetaFile.exists) {
					return null
				}

				const directoryMeta: DirectoryOfflineMeta = unpack(await directoryMetaFile.bytes())

				for (const path in directoryMeta.entries) {
					const entryMeta = directoryMeta.entries[path]

					if (!entryMeta || (entryMeta.item.type !== "file" && entryMeta.item.type !== "sharedFile")) {
						continue
					}

					if (entryMeta.item.data.uuid === item.data.uuid) {
						const file = new FileSystem.File(
							FileSystem.Paths.join(this.directoriesDirectory.uri, directoryItem.data.uuid, path)
						)

						if (file.exists) {
							return file
						}
					}
				}

				return null
			})
		)

		const foundFile = results.find(f => f !== null) ?? null

		if (!foundFile || !foundFile.exists) {
			return null
		}

		this.getLocalFileCache.set(item.data.uuid, foundFile)

		return foundFile
	}

	public async getLocalDirectory(item: DriveItem): Promise<FileSystem.Directory | null> {
		const cachedLocalDir = this.getLocalDirectoryCache.get(item.data.uuid)

		if (cachedLocalDir) {
			return cachedLocalDir
		}

		if (item.type !== "directory" && item.type !== "sharedDirectory") {
			return null
		}

		this.ensureDirectories()

		const { directories: topLevelDirectories } = await this.listDirectories()

		const results = await Promise.all(
			topLevelDirectories.map(async ({ item: directoryItem }) => {
				if (directoryItem.type !== "directory" && directoryItem.type !== "sharedDirectory") {
					return null
				}

				const directoryMetaFile = new FileSystem.File(
					FileSystem.Paths.join(this.directoriesDirectory.uri, directoryItem.data.uuid, `${directoryItem.data.uuid}.filenmeta`)
				)

				if (!directoryMetaFile.exists) {
					return null
				}

				const directoryMeta: DirectoryOfflineMeta = unpack(await directoryMetaFile.bytes())

				if (
					directoryMeta.item.data.uuid === item.data.uuid &&
					(directoryMeta.item.type === "directory" || directoryMeta.item.type === "sharedDirectory")
				) {
					const directory = new FileSystem.Directory(
						FileSystem.Paths.join(this.directoriesDirectory.uri, directoryItem.data.uuid)
					)

					if (directory.exists) {
						return directory
					}
				}

				for (const path in directoryMeta.entries) {
					const entryMeta = directoryMeta.entries[path]

					if (!entryMeta || (entryMeta.item.type !== "directory" && entryMeta.item.type !== "sharedDirectory")) {
						continue
					}

					if (entryMeta.item.data.uuid === item.data.uuid) {
						const directory = new FileSystem.Directory(
							FileSystem.Paths.join(this.directoriesDirectory.uri, directoryItem.data.uuid, path)
						)

						if (directory.exists) {
							return directory
						}
					}
				}

				return null
			})
		)

		const foundDirectory = results.find(f => f !== null) ?? null

		if (!foundDirectory || !foundDirectory.exists) {
			return null
		}

		this.getLocalDirectoryCache.set(item.data.uuid, foundDirectory)

		return foundDirectory
	}
}

const offline = new Offline()

export default offline
