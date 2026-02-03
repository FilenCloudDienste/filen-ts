import auth from "@/lib/auth"
import { NonRootItem, NonRootItemTagged_Tags, CreatedTime } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { unwrapDirMeta, unwrapFileMeta, unwrapParentUuid } from "@/lib/utils"
import { driveItemsQueryUpdateGlobal, driveItemsQueryUpdate } from "@/queries/useDriveItems.query"

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
			const { meta, shared, dir } = unwrapDirMeta(modifiedItem.inner[0])

			if (!shared) {
				item = {
					type: "directory",
					data: {
						...dir,
						size: item.data.size,
						decryptedMeta: meta
					}
				}
			}
		} else {
			const { meta, shared, file } = unwrapFileMeta(modifiedItem.inner[0])

			if (!shared) {
				item = {
					type: "file",
					data: {
						...file,
						decryptedMeta: meta
					}
				}
			}
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
			const { meta, shared, dir } = unwrapDirMeta(modifiedItem)

			if (!shared) {
				item = {
					type: "directory",
					data: {
						...dir,
						size: item.data.size,
						decryptedMeta: meta
					}
				}
			}
		} else {
			const { meta, shared, file } = unwrapFileMeta(modifiedItem)

			if (!shared) {
				item = {
					type: "file",
					data: {
						...file,
						decryptedMeta: meta
					}
				}
			}
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
			const { meta, shared, dir } = unwrapDirMeta(modifiedItem)

			if (!shared) {
				item = {
					type: "directory",
					data: {
						...dir,
						size: item.data.size,
						decryptedMeta: meta
					}
				}
			}
		} else {
			const { meta, shared, file } = unwrapFileMeta(modifiedItem)

			if (!shared) {
				item = {
					type: "file",
					data: {
						...file,
						decryptedMeta: meta
					}
				}
			}
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
}

const drive = new Drive()

export default drive
