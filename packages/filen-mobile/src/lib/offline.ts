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

class Offline {
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
	private listDirectoriesCache: Awaited<ReturnType<Offline["listDirectories"]>> | null = null
	private listFilesCache: Awaited<ReturnType<Offline["listFiles"]>> | null = null
	private listDirectoriesRecursiveCache: Awaited<ReturnType<Offline["listDirectoriesRecursive"]>> | null = null
	private itemSizeCache: Record<
		string,
		{
			size: number
			files: number
			dirs: number
		}
	> = {}
	private isItemStoredCache: Record<string, boolean> = {}
	private getLocalFileCache: Record<string, FileSystem.File> = {}
	private getLocalDirectoryCache: Record<string, FileSystem.Directory> = {}

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

	private async updateIndex(): Promise<void> {
		await run(
			async defer => {
				await this.indexMutex.acquire()

				defer(() => {
					this.indexMutex.release()
				})

				this.ensureDirectories()

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
		if (this.isItemStoredCache[item.data.uuid]) {
			return Boolean(this.isItemStoredCache[item.data.uuid])
		}

		const index = await this.readIndex()

		switch (item.type) {
			case "directory":
			case "sharedDirectory": {
				this.isItemStoredCache[item.data.uuid] = Boolean(index.directories[item.data.uuid])

				return Boolean(index.directories[item.data.uuid])
			}

			case "file":
			case "sharedFile": {
				this.isItemStoredCache[item.data.uuid] = Boolean(index.files[item.data.uuid])

				return Boolean(index.files[item.data.uuid])
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

				const [files, { directories: topLevelDirectories }, sdkClient] = await Promise.all([
					this.listFiles(),
					this.listDirectories(),
					auth.getSdkClient()
				])

				await Promise.all([
					...files.map(async ({ item, parent }) => {
						if (!item.data.decryptedMeta) {
							return
						}

						const dataFile = new FileSystem.File(
							FileSystem.Paths.join(this.filesDirectory.uri, item.data.uuid, item.data.decryptedMeta.name)
						)
						const metaFile = new FileSystem.File(
							FileSystem.Paths.join(this.filesDirectory.uri, item.data.uuid, `${item.data.uuid}.meta`)
						)

						if (!dataFile.exists || !metaFile.exists) {
							if (dataFile.parentDirectory.exists) {
								dataFile.parentDirectory.delete()
							}

							return
						}

						const listParentResult = await run(async () => {
							switch (parent.tag) {
								case AnyDirEnumWithShareInfo_Tags.Dir: {
									const { files } = await sdkClient.listDir(new DirEnum.Dir(parent.inner[0]))

									return files
								}
								case AnyDirEnumWithShareInfo_Tags.Root: {
									const { files } = await sdkClient.listDir(new DirEnum.Root(parent.inner[0]))

									return files
								}

								case AnyDirEnumWithShareInfo_Tags.SharedDir: {
									if (parent.inner[0].sharingRole.tag === SharingRole_Tags.Sharer) {
										switch (parent.inner[0].dir.tag) {
											case DirWithMetaEnum_Tags.Dir: {
												const { files } = await sdkClient.listDir(new DirEnum.Dir(parent.inner[0].dir.inner[0]))

												return files
											}

											case DirWithMetaEnum_Tags.Root: {
												const { files } = await sdkClient.listDir(new DirEnum.Root(parent.inner[0].dir.inner[0]))

												return files
											}
										}
									}

									const { files } = await sdkClient.listInShared(parent.inner[0].dir)

									return files
								}
							}
						})

						if (!listParentResult.success) {
							const unwrappedSdkError = unwrapSdkError(listParentResult.error)

							if (unwrappedSdkError && unwrappedSdkError.kind() === ErrorKind.FolderNotFound) {
								if (dataFile.parentDirectory.exists) {
									dataFile.parentDirectory.delete()
								}

								return
							}

							throw listParentResult.error
						}

						const existingFile = listParentResult.data.find(f => {
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

						const updatedFile = listParentResult.data.find(f => {
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
							hideProgress: true
						})

						if (dataFile.parentDirectory.exists) {
							dataFile.parentDirectory.delete()
						}
					}),
					...topLevelDirectories.map(async ({ item, parent }) => {
						if (!item.data.decryptedMeta) {
							return
						}

						const listParentResult = await run(async () => {
							switch (parent.tag) {
								case AnyDirEnumWithShareInfo_Tags.Dir: {
									const { dirs } = await sdkClient.listDir(new DirEnum.Dir(parent.inner[0]))

									return dirs
								}

								case AnyDirEnumWithShareInfo_Tags.Root: {
									const { dirs } = await sdkClient.listDir(new DirEnum.Root(parent.inner[0]))

									return dirs
								}

								case AnyDirEnumWithShareInfo_Tags.SharedDir: {
									if (parent.inner[0].sharingRole.tag === SharingRole_Tags.Sharer) {
										switch (parent.inner[0].dir.tag) {
											case DirWithMetaEnum_Tags.Dir: {
												const { dirs } = await sdkClient.listDir(new DirEnum.Dir(parent.inner[0].dir.inner[0]))

												return dirs
											}

											case DirWithMetaEnum_Tags.Root: {
												const { dirs } = await sdkClient.listDir(new DirEnum.Root(parent.inner[0].dir.inner[0]))

												return dirs
											}
										}
									}

									const { dirs } = await sdkClient.listInShared(parent.inner[0].dir)

									return dirs
								}
							}
						})

						const metaFile = new FileSystem.File(
							FileSystem.Paths.join(this.directoriesDirectory.uri, item.data.uuid, `${item.data.uuid}.filenmeta`)
						)

						if (!metaFile.exists) {
							return
						}

						if (!listParentResult.success) {
							const unwrappedSdkError = unwrapSdkError(listParentResult.error)

							if (unwrappedSdkError && unwrappedSdkError.kind() === ErrorKind.FolderNotFound) {
								if (metaFile.parentDirectory.exists) {
									metaFile.parentDirectory.delete()
								}

								return
							}

							throw listParentResult.error
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
							sdkClient.listDirRecursiveWithPaths(
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
								hideProgress: true
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

						if (meta.item.type !== "file") {
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

		return files
	}

	public async storeFile({
		file,
		parent,
		hideProgress
	}: {
		file: DriveItem
		parent: AnyDirEnumWithShareInfo
		hideProgress?: boolean
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
						while (!metaFile.exists || metaFile.size === 0 || !done) {
							await new Promise<void>(resolve => setTimeout(resolve, 100))
						}
					}
				})

				metaFile.write(
					new Uint8Array(
						pack({
							item: file,
							parent
						} satisfies FileOrDirectoryOfflineMeta)
					)
				)

				await this.updateIndex()

				this.itemSizeCache = {}
				this.listFilesCache = null
				this.getLocalFileCache = {}
				this.isItemStoredCache = {}
				this.getLocalDirectoryCache = {}

				done = true
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
		hideProgress
	}: {
		directory: DriveItem
		parent: AnyDirEnumWithShareInfo
		hideProgress?: boolean
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
						while (!metaFile.exists || metaFile.size === 0 || !done) {
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

				metaFile.write(
					new Uint8Array(
						pack({
							item: directory,
							parent,
							entries
						} satisfies DirectoryOfflineMeta)
					)
				)

				await this.updateIndex()

				this.itemSizeCache = {}
				this.listDirectoriesCache = null
				this.listDirectoriesRecursiveCache = null
				this.getLocalFileCache = {}
				this.isItemStoredCache = {}
				this.getLocalDirectoryCache = {}

				done = true
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
		if (this.listDirectoriesCache) {
			return this.listDirectoriesCache
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

			return {
				files,
				directories
			}
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

		const { directoryMeta, topLevelUuid } = await (async () => {
			for (const topLevelEntry of topLevelEntries) {
				if (!(topLevelEntry instanceof FileSystem.Directory) || !validateUuid(topLevelEntry.name)) {
					continue
				}

				const innerEntries = topLevelEntry.list()
				const metaFile = innerEntries.find(e => e instanceof FileSystem.File && e.name === `${topLevelEntry.name}.filenmeta`)

				if (!metaFile || !(metaFile instanceof FileSystem.File) || !metaFile.exists) {
					continue
				}

				const meta: DirectoryOfflineMeta = unpack(await metaFile.bytes())

				if (meta.item.type !== "directory") {
					continue
				}

				if (meta.item.data.uuid === parentUuid) {
					return {
						directoryMeta: meta,
						topLevelUuid: topLevelEntry.name
					}
				}

				for (const path in meta.entries) {
					const entryMeta = meta.entries[path]

					if (!entryMeta) {
						continue
					}

					if (
						entryMeta.item.data.uuid === parentUuid &&
						(entryMeta.item.type === "directory" || entryMeta.item.type === "sharedDirectory")
					) {
						return {
							directoryMeta: meta,
							topLevelUuid: topLevelEntry.name
						}
					}
				}
			}

			return {
				directoryMeta: null,
				topLevelUuid: null
			}
		})()

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

		return {
			files,
			directories
		}
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

		return {
			files,
			directories
		}
	}

	public async itemSize(item: DriveItem): Promise<{
		size: number
		files: number
		dirs: number
	}> {
		if (this.itemSizeCache[item.data.uuid]) {
			return (
				this.itemSizeCache[item.data.uuid] ?? {
					size: 0,
					files: 0,
					dirs: 0
				}
			)
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

				this.itemSizeCache[item.data.uuid] = {
					size,
					files: 0,
					dirs: 0
				}

				return {
					size,
					files: 0,
					dirs: 0
				}
			}

			case "directory":
			case "sharedDirectory": {
				const { directories: topLevelDirectories } = await this.listDirectories()

				const sizes = await Promise.all(
					topLevelDirectories.map(async ({ item: directoryItem }) => {
						if (directoryItem.type !== "directory" && directoryItem.type !== "sharedDirectory") {
							return {
								size: 0,
								files: 0,
								dirs: 0
							}
						}

						const directoryMetaFile = new FileSystem.File(
							FileSystem.Paths.join(
								this.directoriesDirectory.uri,
								directoryItem.data.uuid,
								`${directoryItem.data.uuid}.filenmeta`
							)
						)

						if (!directoryMetaFile.exists) {
							return {
								size: 0,
								files: 0,
								dirs: 0
							}
						}

						const directoryMeta: DirectoryOfflineMeta = unpack(await directoryMetaFile.bytes())

						if (
							directoryItem.data.uuid !== item.data.uuid &&
							!Object.values(directoryMeta.entries).some(
								e => e.item.data.uuid === item.data.uuid && e.item.type === item.type
							)
						) {
							return {
								size: 0,
								files: 0,
								dirs: 0
							}
						}

						const uuidToPath: Record<string, string> = {
							[directoryItem.data.uuid]: "/"
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

				this.itemSizeCache[item.data.uuid] = {
					size,
					files,
					dirs
				}

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

					this.itemSizeCache = {}
					this.listFilesCache = null
					this.getLocalFileCache = {}
					this.isItemStoredCache = {}
					this.getLocalDirectoryCache = {}
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

						this.itemSizeCache = {}
						this.listDirectoriesCache = null
						this.listDirectoriesRecursiveCache = null
						this.getLocalFileCache = {}
						this.isItemStoredCache = {}
						this.getLocalDirectoryCache = {}
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
		if (this.getLocalFileCache[item.data.uuid]) {
			return this.getLocalFileCache[item.data.uuid] ?? null
		}

		if (item.type !== "file" && item.type !== "sharedFile") {
			return null
		}

		const index = await this.readIndex()
		const fileEntry = index.files[item.data.uuid]

		if (!fileEntry || (fileEntry.item.type !== "file" && fileEntry.item.type !== "sharedFile")) {
			return null
		}

		const file = new FileSystem.File(
			FileSystem.Paths.join(this.filesDirectory.uri, fileEntry.item.data.uuid, fileEntry.item.data.decryptedMeta?.name ?? "")
		)

		if (file.exists) {
			this.getLocalFileCache[item.data.uuid] = file

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

		this.getLocalFileCache[item.data.uuid] = foundFile

		return foundFile
	}

	public async getLocalDirectory(item: DriveItem): Promise<FileSystem.Directory | null> {
		if (this.getLocalDirectoryCache[item.data.uuid]) {
			return this.getLocalDirectoryCache[item.data.uuid] ?? null
		}

		if (item.type !== "directory" && item.type !== "sharedDirectory") {
			return null
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

		this.getLocalDirectoryCache[item.data.uuid] = foundDirectory

		return foundDirectory
	}
}

const offline = new Offline()

export default offline
