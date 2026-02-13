import auth from "@/lib/auth"
import { NonRootItem, NonRootItemTagged_Tags, CreatedTime, DirColor, type FileVersion } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { unwrapDirMeta, unwrapFileMeta, unwrapParentUuid, unwrappedDirIntoDriveItem, unwrappedFileIntoDriveItem } from "@/lib/utils"
import { driveItemsQueryUpdateGlobal, driveItemsQueryUpdate } from "@/queries/useDriveItems.query"
import { driveItemVersionsQueryUpdate } from "@/queries/useDriveItemVersions.query"

class Drive {
	public async favorite({ item, favorited, signal }: { item: DriveItem; favorited: boolean; signal?: AbortSignal }) {
		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		if (item.data.favorited === favorited) {
			return item
		}

		const sdkClient = await auth.getSdkClient()

		const modifiedItem = await sdkClient.setFavorite(
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

		return item
	}

	public async rename({ item, newName, signal }: { item: DriveItem; newName: string; signal?: AbortSignal }) {
		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		if (item.data.decryptedMeta?.name === newName || newName.trim().length === 0) {
			return item
		}

		const sdkClient = await auth.getSdkClient()

		const modifiedItem =
			item.type === "directory"
				? await sdkClient.updateDirMetadata(
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
				: await sdkClient.updateFileMetadata(
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

		const sdkClient = await auth.getSdkClient()
		const unwrappedParentUuidPrevious = unwrapParentUuid(item.data.parent)

		if (item.type === "directory") {
			await sdkClient.deleteDirPermanently(
				item.data,
				signal
					? {
							signal
						}
					: undefined
			)
		} else {
			await sdkClient.deleteFilePermanently(
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
				updater: prev =>
					prev.filter(i => {
						if (i.data.uuid === item.data.uuid && i.type === item.type) {
							return false
						}

						return true
					})
			})
		}

		return item
	}

	public async trash({ item, signal }: { item: DriveItem; signal?: AbortSignal }) {
		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const sdkClient = await auth.getSdkClient()
		const unwrappedParentUuidPrevious = unwrapParentUuid(item.data.parent)

		const modifiedItem =
			item.type === "directory"
				? await sdkClient.trashDir(
						item.data,
						signal
							? {
									signal
								}
							: undefined
					)
				: await sdkClient.trashFile(
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
				updater: prev =>
					prev.filter(i => {
						if (i.data.uuid === item.data.uuid && i.type === item.type) {
							return false
						}

						return true
					})
			})
		}

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "trash",
					uuid: null
				}
			},
			updater: prev => [
				...prev.filter(i => {
					if (i.data.uuid === item.data.uuid && i.type === item.type) {
						return false
					}

					return true
				}),
				item
			]
		})

		return item
	}

	public async setDirColor({ item, color, signal }: { item: DriveItem; color: DirColor; signal?: AbortSignal }) {
		if (item.type !== "directory") {
			throw new Error("Invalid item type")
		}

		const sdkClient = await auth.getSdkClient()

		const modifiedDir = await sdkClient.setDirColor(
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

		const sdkClient = await auth.getSdkClient()

		const modifiedFile = await sdkClient.restoreFileVersion(
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
		const sdkClient = await auth.getSdkClient()

		await sdkClient.emptyTrash(
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

		const sdkClient = await auth.getSdkClient()

		await sdkClient.deleteFileVersion(
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

		const sdkClient = await auth.getSdkClient()

		const modifiedItem =
			item.type === "directory"
				? await sdkClient.restoreDir(
						item.data,
						signal
							? {
									signal
								}
							: undefined
					)
				: await sdkClient.restoreFile(
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
				updater: prev => [
					...prev.filter(i => {
						if (i.data.uuid === item.data.uuid && i.type === item.type) {
							return false
						}

						return true
					}),
					item
				]
			})
		}

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "trash",
					uuid: null
				}
			},
			updater: prev =>
				prev.filter(i => {
					if (i.data.uuid === item.data.uuid && i.type === item.type) {
						return false
					}

					return true
				})
		})
	}
}

const drive = new Drive()

export default drive
