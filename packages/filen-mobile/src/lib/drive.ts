import auth from "@/lib/auth"
import {
	CreatedTime,
	DirColor,
	type FileVersion,
	SharedRootItem,
	type DirPublicLinkRw,
	type FilePublicLink,
	NonRootNormalItem,
	NonRootNormalItem_Tags,
	NonRootItem_Tags,
	AnyNormalDir,
	ErrorKind,
	AnyLinkedDir,
	type LinkedRootDir,
	DirMeta_Tags,
	type File,
	FileMeta,
	ParentUuid,
	MaybeEncryptedUniffi_Tags
} from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import {
	unwrapDirMeta,
	unwrapFileMeta,
	unwrapParentUuid,
	unwrappedDirIntoDriveItem,
	unwrappedFileIntoDriveItem,
	normalizeFilePathForSdk,
	unwrapSdkError
} from "@/lib/utils"
import { driveItemsQueryUpdateGlobal, driveItemsQueryUpdate } from "@/queries/useDriveItems.query"
import { driveItemVersionsQueryUpdate } from "@/queries/useDriveItemVersions.query"
import cache from "@/lib/cache"
import { driveItemPublicLinkStatusQueryUpdate } from "@/queries/useDriveItemPublicLinkStatus.query"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import { router } from "expo-router"
import { serialize } from "@/lib/serializer"
import type { Linked } from "@/hooks/useDrivePath"

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
			item.type === "directory" ? new NonRootNormalItem.Dir(item.data) : new NonRootNormalItem.File(item.data),
			favorited,
			signal
				? {
						signal
					}
				: undefined
		)

		if (modifiedItem.tag === NonRootNormalItem_Tags.Dir) {
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
				updater: prev => prev.map(i => (i.data.uuid === item.data.uuid ? item : i))
			})
		}

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "favorites",
					uuid: null
				}
			},
			updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
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
				updater: prev => prev.map(i => (i.data.uuid === item.data.uuid ? item : i))
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
				updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
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
				updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
			})
		}

		// We have to add it to recents again after removing it above in the global call
		driveItemsQueryUpdate({
			params: {
				path: {
					type: "recents",
					uuid: null
				}
			},
			updater: prev => [...prev.filter(i => i.data.uuid !== item.data.uuid), item]
		})

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "trash",
					uuid: null
				}
			},
			updater: prev => [...prev.filter(i => i.data.uuid !== item.data.uuid), item]
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
				updater: prev => prev.map(i => (i.data.uuid === item.data.uuid ? item : i))
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
			driveItemsQueryUpdate({
				params: {
					path: {
						type: "drive",
						uuid: unwrappedParentUuid
					}
				},
				updater: prev => [
					...prev.filter(
						i =>
							i.data.uuid !== item.data.uuid &&
							i.data.decryptedMeta?.name.toLowerCase().trim() !== item.data.decryptedMeta?.name.toLowerCase().trim()
					),
					item
				]
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
			driveItemsQueryUpdate({
				params: {
					path: {
						type: "drive",
						uuid: unwrappedParentUuid
					}
				},
				updater: prev => [
					...prev.filter(
						i =>
							i.data.uuid === item.data.uuid &&
							i.data.decryptedMeta?.name.toLowerCase().trim() !== item.data.decryptedMeta?.name.toLowerCase().trim()
					),
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
			updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
		})
	}

	public async removeShare({ item, signal, parentUuid }: { item: DriveItem; signal?: AbortSignal; parentUuid?: string }) {
		if (item.type !== "sharedRootDirectory" && item.type !== "sharedFile" && item.type !== "sharedRootFile") {
			throw new Error("Invalid item type")
		}

		const { authedSdkClient } = await auth.getSdkClients()

		await authedSdkClient.removeSharedItem(
			item.type === "sharedRootDirectory" ? new SharedRootItem.Dir(item.data) : new SharedRootItem.File(item.data),
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
				updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
			})

			driveItemsQueryUpdate({
				params: {
					path: {
						type: "sharedIn",
						uuid: parentUuid
					}
				},
				updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
			})
		}

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "sharedOut",
					uuid: null
				}
			},
			updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
		})

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "sharedIn",
					uuid: null
				}
			},
			updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
		})
	}

	public async removeDirLink({ item, signal, link }: { item: DriveItem; signal?: AbortSignal; link: DirPublicLinkRw }) {
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
			updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
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
			updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
		})
	}

	public async createDirectory({
		parent,
		signal,
		name
	}: {
		parent: DriveItem | "root" | AnyNormalDir
		signal?: AbortSignal
		name: string
	}) {
		if (!AnyNormalDir.instanceOf(parent) && parent !== "root" && parent.type !== "directory") {
			throw new Error("Invalid parent type")
		}

		const { authedSdkClient } = await auth.getSdkClients()
		let parentDir: AnyNormalDir | null = AnyNormalDir.instanceOf(parent) ? parent : null

		if (!parentDir && !AnyNormalDir.instanceOf(parent)) {
			if (parent === "root" || parent.data.uuid === authedSdkClient.root().uuid) {
				parentDir = new AnyNormalDir.Root(authedSdkClient.root())
			} else {
				const dir = cache.directoryUuidToAnyNormalDir.get(parent.data.uuid)

				if (!dir) {
					throw new Error("Parent not found in cache")
				}

				parentDir = dir
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

		driveItemsQueryUpdate({
			params: {
				path: {
					type: "drive",
					uuid: parentDir.inner[0].uuid
				}
			},
			updater: prev => [
				...prev.filter(
					i =>
						i.data.uuid !== createdDriveItem.data.uuid &&
						i.data.decryptedMeta?.name.toLowerCase().trim() !== createdDriveItem.data.decryptedMeta?.name.toLowerCase().trim()
				),
				createdDriveItem
			]
		})

		return createdDriveItem
	}

	public async move({
		item,
		newParent,
		signal
	}: {
		item: DriveItem
		newParent: DriveItem | "root" | AnyNormalDir
		signal?: AbortSignal
	}) {
		if (!AnyNormalDir.instanceOf(newParent) && newParent !== "root" && newParent.type !== "directory") {
			throw new Error("Invalid parent type")
		}

		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const unwrappedParentUuidPrevious = unwrapParentUuid(item.data.parent)
		const oldItemUuid = `${item.data.uuid}`
		const { authedSdkClient } = await auth.getSdkClients()
		let newParentDir: AnyNormalDir | null = AnyNormalDir.instanceOf(newParent) ? newParent : null

		if (!newParentDir && !AnyNormalDir.instanceOf(newParent)) {
			if (newParent === "root" || newParent.data.uuid === authedSdkClient.root().uuid) {
				newParentDir = new AnyNormalDir.Root(authedSdkClient.root())
			} else {
				const dir = cache.directoryUuidToAnyNormalDir.get(newParent.data.uuid)

				if (!dir) {
					throw new Error("New parent not found in cache")
				}

				newParentDir = dir
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
			driveItemsQueryUpdate({
				params: {
					path: {
						type: "drive",
						uuid: unwrappedParentUuidPrevious
					}
				},
				updater: prev => prev.filter(i => i.data.uuid !== oldItemUuid)
			})
		}

		const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

		if (unwrappedParentUuid) {
			driveItemsQueryUpdate({
				params: {
					path: {
						type: "drive",
						uuid: unwrappedParentUuid
					}
				},
				updater: prev => [
					...prev.filter(
						i =>
							i.data.uuid !== item.data.uuid &&
							i.data.decryptedMeta?.name.toLowerCase().trim() !== item.data.decryptedMeta?.name.toLowerCase().trim()
					),
					item
				]
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

		return result
			.map(({ item, path }) => {
				if (item.tag !== NonRootItem_Tags.NormalDir && item.tag !== NonRootItem_Tags.File) {
					return null
				}

				return {
					item:
						item.tag === NonRootItem_Tags.NormalDir
							? unwrappedDirIntoDriveItem(unwrapDirMeta(item.inner[0]))
							: unwrappedFileIntoDriveItem(unwrapFileMeta(item.inner[0])),
					path: normalizeFilePathForSdk(path)
				}
			})
			.filter(
				(
					i
				): i is {
					item: DriveItem
					path: string
				} => i !== null
			)
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
				updater: prev => prev.map(i => (i.data.uuid === item.data.uuid ? item : i))
			})
		}

		return item
	}

	public async enablePublicLink({
		item,
		signal,
		onProgress
	}: {
		item: DriveItem
		signal?: AbortSignal
		onProgress?: (bytesDownloaded: number, totalBytes: number | undefined) => void
	}) {
		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const { authedSdkClient } = await auth.getSdkClients()

		if (item.type === "directory") {
			let status = await authedSdkClient.getDirLinkStatus(
				item.data,
				signal
					? {
							signal
						}
					: undefined
			)

			if (status) {
				return {
					type: "directory" as const,
					link: status
				}
			}

			status = await authedSdkClient.publicLinkDir(
				item.data,
				onProgress
					? {
							onProgress: (bytesDownloaded, totalBytes) => {
								onProgress(Number(bytesDownloaded), totalBytes ? Number(totalBytes) : undefined)
							}
						}
					: undefined,
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
				updater: prev => [...prev.filter(i => i.data.uuid !== item.data.uuid), item]
			})

			driveItemPublicLinkStatusQueryUpdate({
				params: {
					uuid: item.data.uuid
				},
				updater: () => ({
					type: "directory" as const,
					status
				})
			})

			return {
				type: "directory" as const,
				link: status
			}
		} else {
			let status = await authedSdkClient.getFileLinkStatus(
				item.data,
				signal
					? {
							signal
						}
					: undefined
			)

			if (status) {
				return {
					type: "file" as const,
					link: status
				}
			}

			status = await authedSdkClient.publicLinkFile(
				item.data,
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
				updater: prev => [...prev.filter(i => i.data.uuid !== item.data.uuid), item]
			})

			driveItemPublicLinkStatusQueryUpdate({
				params: {
					uuid: item.data.uuid
				},
				updater: () => ({
					type: "file" as const,
					status
				})
			})

			return {
				type: "file" as const,
				link: status
			}
		}
	}

	public async disablePublicLink({ item, signal }: { item: DriveItem; signal?: AbortSignal }) {
		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const { authedSdkClient } = await auth.getSdkClients()

		if (item.type === "directory") {
			const status = await authedSdkClient.getDirLinkStatus(
				item.data,
				signal
					? {
							signal
						}
					: undefined
			)

			if (!status) {
				return
			}

			await authedSdkClient.removeDirLink(
				status,
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
				updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
			})

			driveItemPublicLinkStatusQueryUpdate({
				params: {
					uuid: item.data.uuid
				},
				updater: () => null
			})
		} else {
			const status = await authedSdkClient.getFileLinkStatus(
				item.data,
				signal
					? {
							signal
						}
					: undefined
			)

			if (!status) {
				return
			}

			await authedSdkClient.removeFileLink(
				item.data,
				status,
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
				updater: prev => prev.filter(i => i.data.uuid !== item.data.uuid)
			})

			driveItemPublicLinkStatusQueryUpdate({
				params: {
					uuid: item.data.uuid
				},
				updater: () => null
			})
		}
	}

	public async updatePublicLink({
		item,
		signal,
		link
	}: {
		item: DriveItem
		signal?: AbortSignal
		link:
			| {
					type: "directory"
					link: DirPublicLinkRw
			  }
			| {
					type: "file"
					link: FilePublicLink
			  }
	}) {
		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type")
		}

		const { authedSdkClient } = await auth.getSdkClients()

		if (item.type === "directory") {
			if (link.type !== "directory") {
				throw new Error("Invalid link type for directory")
			}

			const status = await authedSdkClient.getDirLinkStatus(
				item.data,
				signal
					? {
							signal
						}
					: undefined
			)

			if (!status) {
				return
			}

			const merged: DirPublicLinkRw = {
				...status,
				...link.link
			}

			await authedSdkClient.updateDirLink(
				item.data,
				merged,
				signal
					? {
							signal
						}
					: undefined
			)

			driveItemPublicLinkStatusQueryUpdate({
				params: {
					uuid: item.data.uuid
				},
				updater: () => ({
					type: "directory" as const,
					status: merged
				})
			})
		} else {
			if (link.type !== "file") {
				throw new Error("Invalid link type for file")
			}

			const status = await authedSdkClient.getFileLinkStatus(
				item.data,
				signal
					? {
							signal
						}
					: undefined
			)

			if (!status) {
				return
			}

			const merged: FilePublicLink = {
				...status,
				...link.link
			}

			await authedSdkClient.updateFileLink(
				item.data,
				merged,
				signal
					? {
							signal
						}
					: undefined
			)

			driveItemPublicLinkStatusQueryUpdate({
				params: {
					uuid: item.data.uuid
				},
				updater: () => ({
					type: "file" as const,
					status: merged
				})
			})
		}
	}

	public async openLinkedDirectory({
		linkUuid,
		linkKey,
		root,
		password
	}: {
		linkUuid: string
		linkKey: string
		root: LinkedRootDir
		password?: string
	}) {
		const { authedSdkClient } = await auth.getSdkClients()

		const result = await runWithLoading(async () => {
			const info = await authedSdkClient.getDirPublicLinkInfo(linkUuid, linkKey)

			return authedSdkClient.listLinkedDir(
				new AnyLinkedDir.Root(info.root),
				{
					...info.link,
					password
				},
				undefined
			)
		})

		if (!result.success) {
			const unwrappedError = unwrapSdkError(result.error)

			if (unwrappedError?.kind() === ErrorKind.WrongPassword) {
				if (!password) {
					const promptResult = await run(async () => {
						return await prompts.input({
							title: "tbd_password_required",
							message: "tbd_enter_public_link_directory_password",
							cancelText: "tbd_cancel",
							okText: "tbd_submit",
							inputType: "secure-text"
						})
					})

					if (!promptResult.success) {
						console.error(promptResult.error)
						alerts.error(promptResult.error)

						return
					}

					if (promptResult.data.cancelled || promptResult.data.type !== "string") {
						return
					}

					password = promptResult.data.value.trim()

					await this.openLinkedDirectory({
						linkUuid,
						linkKey,
						root,
						password
					})

					return
				}

				alerts.error("tbd_wrong_password")

				return
			}

			console.error(result.error)
			alerts.error(result.error)

			return
		}

		router.push({
			pathname: "/linkedDir/[uuid]",
			params: {
				linked: serialize({
					uuid: linkUuid,
					key: linkKey,
					rootName: root.inner.meta.tag === DirMeta_Tags.Decoded ? root.inner.meta.inner[0].name : root.inner.uuid,
					password
				} satisfies Linked)
			}
		})
	}

	public async openLinkedFile({ linkUuid, fileKey, password }: { linkUuid: string; fileKey: string; password?: string }) {
		const { authedSdkClient } = await auth.getSdkClients()

		const result = await runWithLoading(async () => {
			return authedSdkClient.getLinkedFile(linkUuid, fileKey, password)
		})

		if (!result.success) {
			const unwrappedError = unwrapSdkError(result.error)

			if (unwrappedError?.kind() === ErrorKind.WrongPassword) {
				if (!password) {
					const promptResult = await run(async () => {
						return await prompts.input({
							title: "tbd_password_required",
							message: "tbd_enter_public_link_file_password",
							cancelText: "tbd_cancel",
							okText: "tbd_submit",
							inputType: "secure-text"
						})
					})

					if (!promptResult.success) {
						console.error(promptResult.error)
						alerts.error(promptResult.error)

						return
					}

					if (promptResult.data.cancelled || promptResult.data.type !== "string") {
						return
					}

					password = promptResult.data.value.trim()

					await this.openLinkedFile({
						linkUuid,
						fileKey,
						password
					})

					return
				}

				alerts.error("tbd_wrong_password")

				return
			}

			console.error(result.error)
			alerts.error(result.error)

			return
		}

		router.push({
			pathname: "/linkedFile",
			params: {
				item: serialize(
					unwrappedFileIntoDriveItem(
						unwrapFileMeta({
							...result.data,
							meta: new FileMeta.Decoded({
								name:
									result.data.name.tag === MaybeEncryptedUniffi_Tags.Decrypted
										? result.data.name.inner[0]
										: result.data.uuid,
								mime:
									result.data.mime.tag === MaybeEncryptedUniffi_Tags.Decrypted
										? result.data.mime.inner[0]
										: "application/octet-stream",
								size: result.data.size,
								version: result.data.version,
								key: fileKey,
								created: result.data.timestamp,
								modified: result.data.timestamp,
								hash: undefined
							}),
							parent: new ParentUuid.Uuid(result.data.uuid),
							canMakeThumbnail: false,
							favorited: false
						} satisfies File)
					)
				)
			}
		})
	}
}

const drive = new Drive()

export default drive
