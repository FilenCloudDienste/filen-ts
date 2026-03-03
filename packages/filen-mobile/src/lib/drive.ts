import auth from "@/lib/auth"
import {
	NonRootItem,
	NonRootItemTagged_Tags,
	CreatedTime,
	DirColor,
	type FileVersion,
	SharedRootItem,
	type DirPublicLink,
	type FilePublicLink,
	DirEnum
} from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import {
	unwrapDirMeta,
	unwrapFileMeta,
	unwrapParentUuid,
	unwrappedDirIntoDriveItem,
	unwrappedFileIntoDriveItem,
	normalizeFilePathForSdk
} from "@/lib/utils"
import { driveItemsQueryUpdateGlobal, driveItemsQueryUpdate } from "@/queries/useDriveItems.query"
import { driveItemVersionsQueryUpdate } from "@/queries/useDriveItemVersions.query"
import cache from "@/lib/cache"

class Drive {
	public async favorite({ item, favorited, signal }: { item: DriveItem; favorited: boolean; signal?: AbortSignal }) {
		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		if (item.data.favorited === favorited) {
			return item
		}

		const { authedSdkClient } = await auth.getSdkClients()
		const modifiedItem = await authedSdkClient.setFavorite(
			item.type === "directory" ? new NonRootItem.Dir(item.data) : new NonRootItem.File(item.data),
			favorited,
			signal
				? {
						signal
					}
				: undefined
		)

		if (modifiedItem.tag === NonRootItemTagged_Tags.Dir) {
			item = unwrappedDirIntoDriveItem(unwrapDirMeta(modifiedItem.inner[0]))
		} else {
			item = unwrappedFileIntoDriveItem(unwrapFileMeta(modifiedItem.inner[0]))
		}

		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

		if (unwrappedParentUuid) {
			driveItemsQueryUpdateGlobal({
				parentUuid: unwrappedParentUuid,
				updater: prev => prev.map(i => (i.data.uuid === item.data.uuid && i.type === item.type ? item : i))
			})
		}

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "favorites",
					uuid: null
				}
			},
			updater: prev => prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type))
		})

		return item
	}

	public async rename({ item, newName, signal }: { item: DriveItem; newName: string; signal?: AbortSignal }) {
		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		if (item.data.decryptedMeta?.name === newName || newName.trim().length === 0) {
			return item
		}

		const { authedSdkClient } = await auth.getSdkClients()

		const modifiedItem =
			item.type === "directory"
				? await authedSdkClient.updateDirMetadata(
						item.data,
						{
							name: newName,
							created: undefined
						},
						signal
							? {
									signal
								}
							: undefined
					)
				: await authedSdkClient.updateFileMetadata(
						item.data,
						{
							name: newName,
							mime: undefined,
							lastModified: undefined,
							created: CreatedTime.Keep.new()
						},
						signal
							? {
									signal
								}
							: undefined
					)

		// Ugly but works for now, until we have a better way
		if (!("region" in modifiedItem)) {
			item = unwrappedDirIntoDriveItem(unwrapDirMeta(modifiedItem))
		} else {
			item = unwrappedFileIntoDriveItem(unwrapFileMeta(modifiedItem))
		}

		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

		if (unwrappedParentUuid) {
			driveItemsQueryUpdateGlobal({
				parentUuid: unwrappedParentUuid,
				updater: prev => prev.map(i => (i.data.uuid === item.data.uuid && i.type === item.type ? item : i))
			})
		}

		return item
	}

	public async deletePermanently({ item, signal }: { item: DriveItem; signal?: AbortSignal }) {
		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const { authedSdkClient } = await auth.getSdkClients()
		const unwrappedParentUuidPrevious = unwrapParentUuid(item.data.parent)

		if (item.type === "directory") {
			await authedSdkClient.deleteDirPermanently(
				item.data,
				signal
					? {
							signal
						}
					: undefined
			)
		} else {
			await authedSdkClient.deleteFilePermanently(
				item.data,
				signal
					? {
							signal
						}
					: undefined
			)
		}

		if (unwrappedParentUuidPrevious) {
			driveItemsQueryUpdateGlobal({
				parentUuid: unwrappedParentUuidPrevious,
				updater: prev => prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type))
			})
		}

		return item
	}

	public async trash({ item, signal }: { item: DriveItem; signal?: AbortSignal }) {
		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const { authedSdkClient } = await auth.getSdkClients()
		const unwrappedParentUuidPrevious = unwrapParentUuid(item.data.parent)

		const modifiedItem =
			item.type === "directory"
				? await authedSdkClient.trashDir(
						item.data,
						signal
							? {
									signal
								}
							: undefined
					)
				: await authedSdkClient.trashFile(
						item.data,
						signal
							? {
									signal
								}
							: undefined
					)

		// Ugly but works for now, until we have a better way
		if (!("region" in modifiedItem)) {
			item = unwrappedDirIntoDriveItem(unwrapDirMeta(modifiedItem))
		} else {
			item = unwrappedFileIntoDriveItem(unwrapFileMeta(modifiedItem))
		}

		if (unwrappedParentUuidPrevious) {
			driveItemsQueryUpdateGlobal({
				parentUuid: unwrappedParentUuidPrevious,
				updater: prev => prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type))
			})
		}

		// We have to add it to recents again after removing it above
		driveItemsQueryUpdate({
			params: {
				path: {
					type: "recents",
					uuid: null
				}
			},
			updater: prev => [...prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type)), item]
		})

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "trash",
					uuid: null
				}
			},
			updater: prev => [...prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type)), item]
		})

		return item
	}

	public async setDirColor({ item, color, signal }: { item: DriveItem; color: DirColor; signal?: AbortSignal }) {
		if (item.type !== "directory") {
			throw new Error("Invalid item type")
		}

		const { authedSdkClient } = await auth.getSdkClients()
		const modifiedDir = await authedSdkClient.setDirColor(
			item.data,
			color,
			signal
				? {
						signal
					}
				: undefined
		)

		item = unwrappedDirIntoDriveItem(unwrapDirMeta(modifiedDir))

		if (item.type !== "directory") {
			throw new Error("Invalid item type")
		}

		const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

		if (unwrappedParentUuid) {
			driveItemsQueryUpdateGlobal({
				parentUuid: unwrappedParentUuid,
				updater: prev => prev.map(i => (i.data.uuid === item.data.uuid && i.type === item.type ? item : i))
			})
		}

		return item
	}

	public async restoreFileVersion({ item, version, signal }: { item: DriveItem; version: FileVersion; signal?: AbortSignal }) {
		if (item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const { authedSdkClient } = await auth.getSdkClients()
		const modifiedFile = await authedSdkClient.restoreFileVersion(
			item.data,
			version,
			signal
				? {
						signal
					}
				: undefined
		)

		item = unwrappedFileIntoDriveItem(unwrapFileMeta(modifiedFile))

		if (item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

		if (unwrappedParentUuid) {
			driveItemsQueryUpdateGlobal({
				parentUuid: unwrappedParentUuid,
				updater: prev => prev.map(i => (i.data.uuid === item.data.uuid && i.type === item.type ? item : i))
			})
		}

		return item
	}

	public async emptyTrash({ signal }: { signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.emptyTrash(
			signal
				? {
						signal
					}
				: undefined
		)

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "trash",
					uuid: null
				}
			},
			updater: () => []
		})
	}

	public async deleteVersion({ item, version, signal }: { item: DriveItem; version: FileVersion; signal?: AbortSignal }) {
		if (item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.deleteFileVersion(
			version,
			signal
				? {
						signal
					}
				: undefined
		)

		driveItemVersionsQueryUpdate({
			params: {
				uuid: item.data.uuid
			},
			updater: prev => prev.filter(v => v.uuid !== version.uuid)
		})
	}

	public async restore({ item, signal }: { item: DriveItem; signal?: AbortSignal }) {
		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const { authedSdkClient } = await auth.getSdkClients()
		const modifiedItem =
			item.type === "directory"
				? await authedSdkClient.restoreDir(
						item.data,
						signal
							? {
									signal
								}
							: undefined
					)
				: await authedSdkClient.restoreFile(
						item.data,
						signal
							? {
									signal
								}
							: undefined
					)

		// Ugly but works for now, until we have a better way
		if (!("region" in modifiedItem)) {
			item = unwrappedDirIntoDriveItem(unwrapDirMeta(modifiedItem))
		} else {
			item = unwrappedFileIntoDriveItem(unwrapFileMeta(modifiedItem))
		}

		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

		if (unwrappedParentUuid) {
			driveItemsQueryUpdateGlobal({
				parentUuid: unwrappedParentUuid,
				updater: prev => [...prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type)), item]
			})
		}

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "trash",
					uuid: null
				}
			},
			updater: prev => prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type))
		})
	}

	public async removeShare({ item, signal, parentUuid }: { item: DriveItem; signal?: AbortSignal; parentUuid?: string }) {
		if (item.type !== "sharedDirectory" && item.type !== "sharedFile") {
			throw new Error("Invalid item type")
		}

		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.removeSharedItem(
			item.type === "sharedDirectory" ? new SharedRootItem.Dir(item.data) : new SharedRootItem.File(item.data),
			signal
				? {
						signal
					}
				: undefined
		)

		if (parentUuid) {
			driveItemsQueryUpdate({
				params: {
					path: {
						type: "sharedOut",
						uuid: parentUuid
					}
				},
				updater: prev => prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type))
			})

			driveItemsQueryUpdate({
				params: {
					path: {
						type: "sharedIn",
						uuid: parentUuid
					}
				},
				updater: prev => prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type))
			})
		}

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "sharedOut",
					uuid: null
				}
			},
			updater: prev => prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type))
		})

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "sharedIn",
					uuid: null
				}
			},
			updater: prev => prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type))
		})
	}

	public async removeDirLink({ item, signal, link }: { item: DriveItem; signal?: AbortSignal; link: DirPublicLink }) {
		if (item.type !== "directory") {
			throw new Error("Invalid item type")
		}

		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.removeDirLink(
			link,
			signal
				? {
						signal
					}
				: undefined
		)

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "links",
					uuid: null
				}
			},
			updater: prev => prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type))
		})
	}

	public async removeFileLink({ item, signal, link }: { item: DriveItem; signal?: AbortSignal; link: FilePublicLink }) {
		if (item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.removeFileLink(
			item.data,
			link,
			signal
				? {
						signal
					}
				: undefined
		)

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "links",
					uuid: null
				}
			},
			updater: prev => prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type))
		})
	}

	public async createDirectory({ parent, signal, name }: { parent: DriveItem | "root" | DirEnum; signal?: AbortSignal; name: string }) {
		if (!DirEnum.instanceOf(parent) && parent !== "root" && parent.type !== "directory") {
			throw new Error("Invalid parent type")
		}

		const { authedSdkClient } = await auth.getSdkClients()
		let parentDir: DirEnum | null = DirEnum.instanceOf(parent) ? parent : null

		if (!parentDir && !DirEnum.instanceOf(parent)) {
			if (parent === "root" || parent.data.uuid === authedSdkClient.root().uuid) {
				parentDir = new DirEnum.Root(authedSdkClient.root())
			} else {
				const dir = cache.directoryUuidToDir.get(parent.data.uuid)

				if (!dir) {
					throw new Error("Parent not found in cache")
				}

				parentDir = new DirEnum.Dir(dir)
			}
		}

		if (!parentDir) {
			throw new Error("Parent directory not found")
		}

		const createdDir = await authedSdkClient.createDir(
			parentDir,
			name,
			signal
				? {
						signal
					}
				: undefined
		)

		const createdDriveItem = unwrappedDirIntoDriveItem(unwrapDirMeta(createdDir))

		if (createdDriveItem.type !== "directory") {
			throw new Error("Invalid item type")
		}

		driveItemsQueryUpdateGlobal({
			parentUuid: parentDir.inner[0].uuid,
			updater: prev => [
				...prev.filter(i => !(i.data.uuid === createdDriveItem.data.uuid && i.type === createdDriveItem.type)),
				createdDriveItem
			]
		})

		return createdDriveItem
	}

	public async move({ item, newParent, signal }: { item: DriveItem; newParent: DriveItem | "root" | DirEnum; signal?: AbortSignal }) {
		if (!DirEnum.instanceOf(newParent) && newParent !== "root" && newParent.type !== "directory") {
			throw new Error("Invalid parent type")
		}

		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const unwrappedParentUuidPrevious = unwrapParentUuid(item.data.parent)
		const { authedSdkClient } = await auth.getSdkClients()
		let newParentDir: DirEnum | null = DirEnum.instanceOf(newParent) ? newParent : null

		if (!newParentDir && !DirEnum.instanceOf(newParent)) {
			if (newParent === "root" || newParent.data.uuid === authedSdkClient.root().uuid) {
				newParentDir = new DirEnum.Root(authedSdkClient.root())
			} else {
				const dir = cache.directoryUuidToDir.get(newParent.data.uuid)

				if (!dir) {
					throw new Error("New parent not found in cache")
				}

				newParentDir = new DirEnum.Dir(dir)
			}
		}

		if (!newParentDir) {
			throw new Error("New parent directory not found")
		}

		if (unwrappedParentUuidPrevious === newParentDir.inner[0].uuid) {
			return item
		}

		const modifiedItem =
			item.type === "directory"
				? await authedSdkClient.moveDir(
						item.data,
						newParentDir,
						signal
							? {
									signal
								}
							: undefined
					)
				: await authedSdkClient.moveFile(
						item.data,
						newParentDir,
						signal
							? {
									signal
								}
							: undefined
					)

		// Ugly but works for now, until we have a better way
		if (!("region" in modifiedItem)) {
			item = unwrappedDirIntoDriveItem(unwrapDirMeta(modifiedItem))
		} else {
			item = unwrappedFileIntoDriveItem(unwrapFileMeta(modifiedItem))
		}

		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		if (unwrappedParentUuidPrevious) {
			driveItemsQueryUpdateGlobal({
				parentUuid: unwrappedParentUuidPrevious,
				updater: prev => prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type))
			})
		}

		const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

		if (unwrappedParentUuid) {
			driveItemsQueryUpdateGlobal({
				parentUuid: unwrappedParentUuid,
				updater: prev => [...prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type)), item]
			})
		}

		return item
	}

	public async findItemMatchesForName({ name, signal }: { name: string; signal?: AbortSignal }) {
		const { authedSdkClient } = await auth.getSdkClients()

		const result = await authedSdkClient.findItemMatchesForName(
			name.trim().toLowerCase(),
			signal
				? {
						signal
					}
				: undefined
		)

		return result.map(({ item, path }) => ({
			item:
				item.tag === NonRootItemTagged_Tags.Dir
					? unwrappedDirIntoDriveItem(unwrapDirMeta(item.inner[0]))
					: unwrappedFileIntoDriveItem(unwrapFileMeta(item.inner[0])),
			path: normalizeFilePathForSdk(path)
		}))
	}

	public async updateTimestamps({
		item,
		created,
		modified,
		signal
	}: {
		item: DriveItem
		created?: number
		modified?: number
		signal?: AbortSignal
	}) {
		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const { authedSdkClient } = await auth.getSdkClients()

		const modifiedItem =
			item.type === "directory"
				? await authedSdkClient.updateDirMetadata(
						item.data,
						{
							name: undefined,
							created: created ? BigInt(created) : undefined
						},
						signal
							? {
									signal
								}
							: undefined
					)
				: await authedSdkClient.updateFileMetadata(
						item.data,
						{
							name: undefined,
							mime: undefined,
							lastModified: modified ? BigInt(modified) : undefined,
							created: created ? CreatedTime.Set.new(BigInt(created)) : CreatedTime.Keep.new()
						},
						signal
							? {
									signal
								}
							: undefined
					)

		// Ugly but works for now, until we have a better way
		if (!("region" in modifiedItem)) {
			item = unwrappedDirIntoDriveItem(unwrapDirMeta(modifiedItem))
		} else {
			item = unwrappedFileIntoDriveItem(unwrapFileMeta(modifiedItem))
		}

		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

		if (unwrappedParentUuid) {
			driveItemsQueryUpdateGlobal({
				parentUuid: unwrappedParentUuid,
				updater: prev => prev.map(i => (i.data.uuid === item.data.uuid && i.type === item.type ? item : i))
			})
		}

		return item
	}
}

const drive = new Drive()

export default drive
