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
	File,
	Dir,
	SharingRole_Tags,
	DirEnum,
	SharedFile,
	DirWithMetaEnum_Tags,
	SharedDir
} from "@filen/sdk-rs"
import { unwrapFileMeta, listLocalDirectoryRecursive, normalizeFilePathForSdk, unwrapDirMeta } from "@/lib/utils"
import { validate as validateUuid } from "uuid"

export type OfflineMeta =
	| {
			item: DriveItem
			offlineType: "file"
			parent: AnyDirEnumWithShareInfo
	  }
	| {
			item: DriveItem
			offlineType: "directory"
			offlineParent: DriveItem | null
			parent: AnyDirEnumWithShareInfo
	  }

export type Index = {
	files: Record<string, OfflineMeta>
	directories: Record<string, OfflineMeta>
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

	public constructor() {
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

				const [files, directories] = await Promise.all([this.listFiles(), this.listDirectoriesRecursive()])
				const indexFiles: Record<string, OfflineMeta> = {}
				const indexDirectories: Record<string, OfflineMeta> = {}

				for (const { meta, file } of files) {
					indexFiles[file.data.uuid] = meta
				}

				for (const { directory, meta } of directories.directories) {
					indexDirectories[directory.data.uuid] = meta
				}

				for (const { file, meta } of directories.files) {
					indexFiles[file.data.uuid] = meta
				}

				const index: Index = {
					files: indexFiles,
					directories: indexDirectories
				}

				this.indexCache = index
				this.indexFile.write(new Uint8Array(pack(index satisfies Index)))
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

	public async isItemStored(file: DriveItem): Promise<boolean> {
		const index = await this.readIndex()

		switch (file.type) {
			case "directory":
			case "sharedDirectory": {
				return Boolean(index.directories[file.data.uuid])
			}

			case "file":
			case "sharedFile": {
				return Boolean(index.files[file.data.uuid])
			}
		}
	}

	public async sync(): Promise<void> {
		await run(
			async defer => {
				await this.syncMutex.acquire()

				defer(() => {
					this.syncMutex.release()
				})

				const [files, { directories }, sdkClient] = await Promise.all([
					this.listFiles(),
					this.listDirectories(),
					auth.getSdkClient()
				])

				await Promise.all([
					...files.map(async ({ meta, parent }) => {
						if (!meta.item.data.decryptedMeta) {
							return
						}

						const listParentResult = await run(async () => {
							switch (meta.parent.tag) {
								case AnyDirEnumWithShareInfo_Tags.Dir: {
									const { files } = await sdkClient.listDir(new DirEnum.Dir(meta.parent.inner[0]))

									return files
								}
								case AnyDirEnumWithShareInfo_Tags.Root: {
									const { files } = await sdkClient.listDir(new DirEnum.Root(meta.parent.inner[0]))

									return files
								}

								case AnyDirEnumWithShareInfo_Tags.SharedDir: {
									if (meta.parent.inner[0].sharingRole.tag === SharingRole_Tags.Sharer) {
										switch (meta.parent.inner[0].dir.tag) {
											case DirWithMetaEnum_Tags.Dir: {
												const { files } = await sdkClient.listDir(
													new DirEnum.Dir(meta.parent.inner[0].dir.inner[0])
												)

												return files
											}

											case DirWithMetaEnum_Tags.Root: {
												const { files } = await sdkClient.listDir(
													new DirEnum.Root(meta.parent.inner[0].dir.inner[0])
												)

												return files
											}
										}
									}

									const { files } = await sdkClient.listInShared(meta.parent.inner[0].dir)

									return files
								}
							}
						})

						// TODO: handle dir not found case
						if (!listParentResult.success) {
							return
						}

						// TODO: improve this
						const foundFile = listParentResult.data.find(f => {
							const unwrappedFileMeta = unwrapFileMeta(f)

							if (!unwrappedFileMeta.meta) {
								return false
							}

							return (
								unwrappedFileMeta.meta.name.trim().toLowerCase() ===
									meta.item.data.decryptedMeta?.name.trim().toLowerCase() &&
								(unwrappedFileMeta.shared ? unwrappedFileMeta.file.file.uuid : unwrappedFileMeta.file.uuid) !==
									meta.item.data.uuid
							)
						})

						if (!foundFile) {
							return
						}

						const unwrapped = unwrapFileMeta(foundFile)

						await this.storeFile({
							file: (unwrapped.shared
								? {
										type: "sharedFile",
										data: {
											...unwrapped.file,
											size: unwrapped.meta?.size ?? 0n,
											decryptedMeta: unwrapped.meta,
											uuid: unwrapped.file.file.uuid
										}
									}
								: {
										type: "file",
										data: {
											...unwrapped.file,
											decryptedMeta: unwrapped.meta
										}
									}) satisfies DriveItem,
							parent
						})
					}),
					...directories.map(async ({ directory, parent }) => {
						if (!directory.data.decryptedMeta) {
							return
						}

						const remoteDir = (() => {
							switch (directory.type) {
								case "directory": {
									return new AnyDirEnum.Dir(directory.data)
								}

								case "sharedDirectory": {
									switch (directory.data.dir.tag) {
										case DirWithMetaEnum_Tags.Dir: {
											return new AnyDirEnum.Dir(directory.data.dir.inner[0])
										}

										case DirWithMetaEnum_Tags.Root: {
											return new AnyDirEnum.Root(directory.data.dir.inner[0])
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

						// TODO: handle dir not found case
						if (!listParentResult.success) {
							return
						}

						const dataDirectory = new FileSystem.Directory(
							FileSystem.Paths.join(this.directoriesDirectory.uri, directory.data.uuid, directory.data.decryptedMeta.name)
						)

						if (
							!dataDirectory.exists ||
							listParentResult.data.length === 0 ||
							!listParentResult.data.find(d => {
								const { uuid } = unwrapDirMeta(d)

								if (!uuid) {
									return false
								}

								return uuid === directory.data.uuid
							})
						) {
							if (dataDirectory.parentDirectory.exists) {
								dataDirectory.parentDirectory.delete()
							}

							return
						}

						const [localDirectoryEntries, remoteDirectoryEntries] = await Promise.all([
							listLocalDirectoryRecursive(dataDirectory),
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
							)
						])

						const localFiles: Record<
							string,
							{
								meta: OfflineMeta
								file: FileSystem.File
							}
						> = {}
						const localDirectories: Record<
							string,
							{
								meta: OfflineMeta
								directory: FileSystem.Directory
							}
						> = {}

						const dataDirectoryUriNormalized = normalizeFilePathForSdk(dataDirectory.uri)

						await Promise.all(
							localDirectoryEntries.map(async entry => {
								if (!entry.name.endsWith(".filenmeta") || !(entry instanceof FileSystem.File)) {
									return
								}

								const meta: OfflineMeta = unpack(await entry.bytes())

								if (!meta.item.data.decryptedMeta) {
									return
								}

								const normalizedPath = normalizeFilePathForSdk(
									FileSystem.Paths.join(entry.parentDirectory.uri, meta.item.data.decryptedMeta.name)
								).slice(dataDirectoryUriNormalized.length)

								switch (meta.item.type) {
									case "file":
									case "sharedFile": {
										const dataFile = new FileSystem.File(
											FileSystem.Paths.join(entry.parentDirectory.uri, meta.item.data.decryptedMeta.name)
										)

										if (!dataFile.exists) {
											return
										}

										localFiles[normalizedPath] = {
											meta,
											file: dataFile
										}

										break
									}

									case "directory":
									case "sharedDirectory": {
										const dataDirectory = new FileSystem.Directory(
											FileSystem.Paths.join(entry.parentDirectory.uri, meta.item.data.decryptedMeta.name)
										)

										if (!dataDirectory.exists) {
											return
										}

										localDirectories[normalizedPath] = {
											meta,
											directory: dataDirectory
										}

										break
									}
								}
							})
						)

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

						let needsResync = false

						for (const path in localFiles) {
							const localFile = localFiles[path]
							const remoteFile = remoteFiles[path]

							if (!remoteFile && localFile && localFile.file.exists) {
								localFile.file.delete()

								continue
							}

							if (remoteFile && localFile && localFile.file.exists && localFile.file.modificationTime) {
								const unwrappedRemoteFile = unwrapFileMeta(remoteFile)

								if (
									unwrappedRemoteFile.meta &&
									Number(unwrappedRemoteFile.meta.modified) > localFile.file.modificationTime
								) {
									localFile.file.delete()

									needsResync = true
								}
							}
						}

						for (const path in remoteDirectories) {
							const remoteDirectory = remoteDirectories[path]
							const localDirectory = localDirectories[path]

							if (!localDirectory && remoteDirectory) {
								needsResync = true
							}
						}

						for (const path in remoteFiles) {
							const remoteFile = remoteFiles[path]
							const localFile = localFiles[path]

							if (!localFile && remoteFile) {
								needsResync = true
							}
						}

						if (needsResync) {
							await this.storeDirectory({
								directory,
								parent
							})
						}
					})
				])

				await this.updateIndex()

				//TODO update ui state
			},
			{
				throw: true
			}
		)
	}

	public async listFiles(): Promise<
		{
			dataFile: FileSystem.File
			metaFile: FileSystem.File
			file: DriveItem
			parent: AnyDirEnumWithShareInfo
			meta: OfflineMeta
		}[]
	> {
		const entries = this.filesDirectory.list()
		const files: {
			dataFile: FileSystem.File
			metaFile: FileSystem.File
			file: DriveItem
			parent: AnyDirEnumWithShareInfo
			meta: OfflineMeta
		}[] = []

		await Promise.all(
			entries.map(async entry => {
				if (!(entry instanceof FileSystem.Directory) || !validateUuid(entry.name)) {
					return
				}

				const innerEntries = entry.list()

				await Promise.all(
					innerEntries.map(async innerEntry => {
						if (!(innerEntry instanceof FileSystem.File)) {
							return
						}

						if (innerEntry.name === ".filenmeta") {
							return
						}

						const dataFile = innerEntry
						const metaFile = new FileSystem.File(FileSystem.Paths.join(dataFile.parentDirectory.uri, ".filenmeta"))

						if (!dataFile.exists || !metaFile.exists) {
							return
						}

						const meta: OfflineMeta = unpack(await metaFile.bytes())

						if (meta.item.type !== "file") {
							return
						}

						files.push({
							dataFile,
							metaFile,
							file: meta.item,
							parent: meta.parent,
							meta
						})
					})
				)
			})
		)

		return files
	}

	public async storeFile({ file, parent }: { file: DriveItem; parent: AnyDirEnumWithShareInfo }): Promise<{
		dataFile: FileSystem.File
		metaFile: FileSystem.File
		file: DriveItem
		parent: AnyDirEnumWithShareInfo
	}> {
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

			const dataFile = new FileSystem.File(
				FileSystem.Paths.join(this.filesDirectory.uri, file.data.uuid, file.data.decryptedMeta.name)
			)
			const metaFile = new FileSystem.File(FileSystem.Paths.join(this.filesDirectory.uri, file.data.uuid, ".filenmeta"))

			if (dataFile.parentDirectory.exists) {
				dataFile.parentDirectory.delete()
			}

			dataFile.parentDirectory.create({
				intermediates: true,
				idempotent: true
			})

			const innerResult = await run(async () => {
				await transfers.download({
					item: file,
					destination: dataFile,
					itemUuid: file.data.uuid
				})

				metaFile.write(
					new Uint8Array(
						pack({
							offlineType: "file",
							item: file,
							parent
						} satisfies OfflineMeta)
					)
				)

				await this.updateIndex()
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

		return result.data
	}

	public async storeDirectory({ directory, parent }: { directory: DriveItem; parent: AnyDirEnumWithShareInfo }): Promise<{
		directory: DriveItem
		parent: AnyDirEnumWithShareInfo
		dataDirectory: FileSystem.Directory
		metaFile: FileSystem.File
	}> {
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

			const dataDirectory = new FileSystem.Directory(
				FileSystem.Paths.join(this.directoriesDirectory.uri, directory.data.uuid, directory.data.decryptedMeta.name)
			)
			const metaFile = new FileSystem.File(FileSystem.Paths.join(this.directoriesDirectory.uri, directory.data.uuid, ".filenmeta"))

			if (!dataDirectory.parentDirectory.exists) {
				dataDirectory.parentDirectory.create({
					intermediates: true,
					idempotent: true
				})
			}

			const innerResult = await run(async () => {
				await transfers.download({
					item: directory,
					destination: dataDirectory,
					itemUuid: directory.data.uuid
				})

				const remoteDir = (() => {
					switch (directory.type) {
						case "directory": {
							return new AnyDirEnum.Dir(directory.data)
						}

						case "sharedDirectory": {
							switch (directory.data.dir.tag) {
								case DirWithMetaEnum_Tags.Dir: {
									return new AnyDirEnum.Dir(directory.data.dir.inner[0])
								}

								case DirWithMetaEnum_Tags.Root: {
									return new AnyDirEnum.Root(directory.data.dir.inner[0])
								}
							}
						}
					}
				})()

				const sdkClient = await auth.getSdkClient()
				const [localDirectoryEntries, remoteDirectoryEntries] = await Promise.all([
					listLocalDirectoryRecursive(dataDirectory),
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
					)
				])

				const localFiles: Record<string, FileSystem.File> = {}
				const localDirectories: Record<string, FileSystem.Directory> = {}
				const dataDirectoryUriNormalized = normalizeFilePathForSdk(dataDirectory.uri)

				for (const entry of localDirectoryEntries) {
					if (entry.name.endsWith(".filenmeta")) {
						continue
					}

					const normalizedPath = normalizeFilePathForSdk(entry.uri).slice(dataDirectoryUriNormalized.length)

					if (entry instanceof FileSystem.Directory) {
						localDirectories[normalizedPath] = entry
					} else {
						localFiles[normalizedPath] = entry
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

					if (!localDirectory || !localDirectory.exists) {
						continue
					}

					const remoteDirectory = remoteDirectories[path]

					if (!remoteDirectory) {
						continue
					}

					const dirname = FileSystem.Paths.dirname(path)
					const remoteParent =
						dirname === "." || dirname === "" || dirname === "/"
							? directory.type === "directory"
								? Dir.new(directory.data)
								: SharedDir.new(directory.data)
							: remoteDirectories[dirname]

					if (!remoteParent) {
						continue
					}

					const unwrappedDirMeta = unwrapDirMeta(remoteDirectory)
					const unwrappedParentDirMeta = unwrapDirMeta(remoteParent)

					if (!unwrappedDirMeta.uuid || !unwrappedParentDirMeta.uuid || !unwrappedParentDirMeta.meta || !unwrappedDirMeta.meta) {
						continue
					}

					const directoryMetaFile = new FileSystem.File(
						FileSystem.Paths.join(localDirectory.parentDirectory.uri, `${unwrappedDirMeta.uuid}.filenmeta`)
					)

					if (directoryMetaFile.exists) {
						directoryMetaFile.delete()
					}

					directoryMetaFile.write(
						new Uint8Array(
							pack({
								item: (unwrappedDirMeta.shared
									? {
											type: "sharedDirectory",
											data: {
												...unwrappedDirMeta.dir,
												size: 0n,
												decryptedMeta: unwrappedDirMeta.meta,
												uuid: unwrappedDirMeta.uuid
											}
										}
									: {
											type: "directory",
											data: {
												...unwrappedDirMeta.dir,
												size: 0n,
												decryptedMeta: unwrappedDirMeta.meta
											}
										}) satisfies DriveItem,
								parent:
									"sharingRole" in remoteParent
										? new AnyDirEnumWithShareInfo.SharedDir(remoteParent)
										: new AnyDirEnumWithShareInfo.Dir(remoteParent),
								offlineType: "directory",
								offlineParent: (unwrappedParentDirMeta.shared
									? {
											type: "sharedDirectory",
											data: {
												...unwrappedParentDirMeta.dir,
												size: 0n,
												decryptedMeta: unwrappedParentDirMeta.meta,
												uuid: unwrappedParentDirMeta.uuid
											}
										}
									: {
											type: "directory",
											data: {
												...unwrappedParentDirMeta.dir,
												size: 0n,
												decryptedMeta: unwrappedParentDirMeta.meta
											}
										}) satisfies DriveItem
							} satisfies OfflineMeta)
						)
					)
				}

				for (const path in localFiles) {
					const localFile = localFiles[path]

					if (!localFile || !localFile.exists) {
						continue
					}

					const remoteFile = remoteFiles[path]

					if (!remoteFile) {
						continue
					}

					const dirname = FileSystem.Paths.dirname(path)
					const remoteParent =
						dirname === "." || dirname === "" || dirname === "/"
							? directory.type === "directory"
								? Dir.new(directory.data)
								: SharedDir.new(directory.data)
							: remoteDirectories[dirname]

					if (!remoteParent) {
						continue
					}

					const unwrappedFileMeta = unwrapFileMeta(remoteFile)
					const unwrappedParentDirMeta = unwrapDirMeta(remoteParent)

					if (!unwrappedParentDirMeta.uuid || !unwrappedParentDirMeta.meta) {
						continue
					}

					const fileMetaFile = new FileSystem.File(
						FileSystem.Paths.join(
							localFile.parentDirectory.uri,
							`${unwrappedFileMeta.shared ? unwrappedFileMeta.file.file.uuid : unwrappedFileMeta.file.uuid}.filenmeta`
						)
					)

					if (fileMetaFile.exists) {
						fileMetaFile.delete()
					}

					fileMetaFile.write(
						new Uint8Array(
							pack({
								item: (unwrappedFileMeta.shared
									? {
											type: "sharedFile",
											data: {
												...unwrappedFileMeta.file,
												decryptedMeta: unwrappedFileMeta.meta,
												uuid: unwrappedFileMeta.file.file.uuid,
												size: unwrappedFileMeta.meta?.size ?? 0n
											}
										}
									: {
											type: "file",
											data: {
												...unwrappedFileMeta.file,
												decryptedMeta: unwrappedFileMeta.meta
											}
										}) satisfies DriveItem,
								parent:
									"sharingRole" in remoteParent
										? new AnyDirEnumWithShareInfo.SharedDir(remoteParent)
										: new AnyDirEnumWithShareInfo.Dir(remoteParent),
								offlineType: "directory",
								offlineParent: (unwrappedParentDirMeta.shared
									? {
											type: "sharedDirectory",
											data: {
												...unwrappedParentDirMeta.dir,
												size: 0n,
												decryptedMeta: unwrappedParentDirMeta.meta,
												uuid: unwrappedParentDirMeta.uuid
											}
										}
									: {
											type: "directory",
											data: {
												...unwrappedParentDirMeta.dir,
												size: 0n,
												decryptedMeta: unwrappedParentDirMeta.meta
											}
										}) satisfies DriveItem
							} satisfies OfflineMeta)
						)
					)
				}

				metaFile.write(
					new Uint8Array(
						pack({
							item: directory,
							parent,
							offlineType: "directory",
							offlineParent: null
						} satisfies OfflineMeta)
					)
				)

				await this.updateIndex()
			})

			if (!innerResult.success) {
				if (dataDirectory.parentDirectory.exists) {
					dataDirectory.parentDirectory.delete()
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

		return result.data
	}

	public async listDirectories(parent?: AnyDirEnumWithShareInfo): Promise<{
		files: {
			dataFile: FileSystem.File
			metaFile: FileSystem.File
			file: DriveItem
			parent: AnyDirEnumWithShareInfo
			meta: OfflineMeta
		}[]
		directories: {
			metaFile: FileSystem.File
			directory: DriveItem
			parent: AnyDirEnumWithShareInfo
			meta: OfflineMeta
		}[]
	}> {
		let dirPath: string | null = null

		if (parent) {
			switch (parent.tag) {
				case AnyDirEnumWithShareInfo_Tags.Dir: {
					const unwrapped = unwrapDirMeta(parent.inner[0])

					if (unwrapped.meta && unwrapped.uuid) {
						dirPath = FileSystem.Paths.join(unwrapped.uuid, unwrapped.meta.name)
					}

					break
				}

				case AnyDirEnumWithShareInfo_Tags.SharedDir: {
					const unwrapped = unwrapDirMeta(parent.inner[0])

					if (unwrapped.meta && unwrapped.uuid) {
						dirPath = FileSystem.Paths.join(unwrapped.uuid, unwrapped.meta.name)
					}

					break
				}

				case AnyDirEnumWithShareInfo_Tags.Root: {
					dirPath = FileSystem.Paths.join(parent.inner[0].uuid, parent.inner[0].uuid)

					break
				}
			}
		}

		const parentDirectory = new FileSystem.Directory(
			FileSystem.Paths.join(
				this.directoriesDirectory.uri,
				(dirPath ?? "")
					.split("/")
					.map(segment => (segment.length > 0 ? decodeURIComponent(segment) : segment))
					.join("/")
			)
		)

		if (!parentDirectory.exists) {
			return {
				files: [],
				directories: []
			}
		}

		const entries = parentDirectory.list()

		if (entries.length === 0) {
			return {
				files: [],
				directories: []
			}
		}

		// Fetch the root level if no parent dirPath is provided
		if (!dirPath) {
			const directories: {
				metaFile: FileSystem.File
				directory: DriveItem
				parent: AnyDirEnumWithShareInfo
				meta: OfflineMeta
			}[] = []

			await Promise.all(
				entries.map(async entry => {
					if (!(entry instanceof FileSystem.Directory) || !validateUuid(entry.name)) {
						return
					}

					const innerEntries = entry.list()
					const metaFile = innerEntries.find(e => e instanceof FileSystem.File && e.name === ".filenmeta")
					const dir = innerEntries.filter(e => e instanceof FileSystem.Directory).at(0)

					if (
						!metaFile ||
						!(metaFile instanceof FileSystem.File) ||
						!metaFile.exists ||
						!dir ||
						!(dir instanceof FileSystem.Directory) ||
						!dir.exists
					) {
						return
					}

					const meta: OfflineMeta = unpack(await metaFile.bytes())

					if (meta.item.type !== "directory") {
						return
					}

					const unwrappedDirMeta = unwrapDirMeta(meta.item.data)

					if (!unwrappedDirMeta.meta || unwrappedDirMeta.meta.name !== dir.name) {
						return
					}

					directories.push({
						metaFile,
						directory: meta.item,
						parent: meta.parent,
						meta
					})
				})
			)

			return {
				files: [],
				directories
			}
		}

		const directories: {
			metaFile: FileSystem.File
			directory: DriveItem
			parent: AnyDirEnumWithShareInfo
			meta: OfflineMeta
		}[] = []
		const files: {
			dataFile: FileSystem.File
			metaFile: FileSystem.File
			file: DriveItem
			parent: AnyDirEnumWithShareInfo
			meta: OfflineMeta
		}[] = []

		const localDirectories: Record<string, FileSystem.Directory> = {}

		for (const entry of entries) {
			if (!(entry instanceof FileSystem.Directory)) {
				continue
			}

			localDirectories[entry.name] = entry
		}

		await Promise.all(
			entries.map(async entry => {
				if (
					!(entry instanceof FileSystem.File) ||
					!entry.name.endsWith(".filenmeta") ||
					!validateUuid(entry.name.replace(".filenmeta", ""))
				) {
					return
				}

				const metaFile = entry
				const meta: OfflineMeta = unpack(await metaFile.bytes())

				if (!meta.item.data.decryptedMeta) {
					return
				}

				if (meta.item.type === "directory") {
					const localDirectory = localDirectories[meta.item.data.decryptedMeta.name]

					if (!localDirectory || !localDirectory.exists) {
						return
					}

					directories.push({
						metaFile,
						directory: meta.item,
						parent: meta.parent,
						meta
					})
				} else {
					const dataFile = new FileSystem.File(
						FileSystem.Paths.join(metaFile.parentDirectory.uri, meta.item.data.decryptedMeta.name)
					)

					if (!dataFile.exists) {
						return
					}

					files.push({
						dataFile,
						metaFile,
						file: meta.item,
						parent: meta.parent,
						meta
					})
				}
			})
		)

		return {
			files,
			directories
		}
	}

	public async listDirectoriesRecursive(): Promise<{
		files: {
			dataFile: FileSystem.File
			metaFile: FileSystem.File
			file: DriveItem
			parent: AnyDirEnumWithShareInfo
			meta: OfflineMeta
		}[]
		directories: {
			metaFile: FileSystem.File
			directory: DriveItem
			parent: AnyDirEnumWithShareInfo
			meta: OfflineMeta
		}[]
	}> {
		const entries = await this.listDirectories()
		const allFiles = [...entries.files]
		const allDirectories = [...entries.directories]

		for (const dirEntry of entries.directories) {
			if (dirEntry.directory.type !== "directory" && dirEntry.directory.type !== "sharedDirectory") {
				continue
			}

			const subEntries = await this.listDirectories(
				dirEntry.directory.type === "sharedDirectory"
					? new AnyDirEnumWithShareInfo.SharedDir(dirEntry.directory.data)
					: new AnyDirEnumWithShareInfo.Dir(dirEntry.directory.data)
			)

			allFiles.push(...subEntries.files)
			allDirectories.push(...subEntries.directories)
		}

		return {
			files: allFiles,
			directories: allDirectories
		}
	}
}

const offline = new Offline()

export default offline
