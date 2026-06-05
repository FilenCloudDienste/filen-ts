import auth from "@/lib/auth"
import {
	CreatedTime,
	DirColor,
	SharedRootItem,
	NonRootNormalItem,
	NonRootNormalItem_Tags,
	ErrorKind,
	AnyLinkedDir,
	type LinkedRootDir,
	DirMeta_Tags,
	type File,
	FileMeta,
	ParentUuid,
	MaybeEncryptedUniffi_Tags,
	type Contact
} from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import {
	unwrapDirMeta,
	unwrapFileMeta,
	unwrapParentUuid,
	unwrappedDirIntoDriveItem,
	unwrappedFileIntoDriveItem,
	unwrapSdkError
} from "@/lib/utils"
import {
	driveItemsQueryUpdateGlobal,
	driveItemsQueryUpdate
} from "@/features/drive/queries/useDriveItems.query"
import cache from "@/lib/cache"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import { router } from "expo-router"
import { serialize } from "@/lib/serializer"
import type { Linked } from "@/hooks/useDrivePath"
import i18n from "@/lib/i18n"
import {
	enablePublicLink,
	disablePublicLink,
	updatePublicLink,
	removeDirLink,
	removeFileLink
} from "@/features/drive/drivePublicLink"
import {
	deletePermanently,
	trash,
	restore,
	emptyTrash,
	restoreFileVersion,
	deleteVersion
} from "@/features/drive/driveTrash"
import {
	createDirectory,
	move,
	findItemMatchesForName
} from "@/features/drive/driveDirectory"

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

		// Sync persistent caches — `favorited` flag changed on the raw Dir/File.
		if (item.type === "directory" && modifiedItem.tag === NonRootNormalItem_Tags.Dir) {
			cache.cacheNewNormalDir(modifiedItem.inner[0], item)
		} else if (item.type === "file" && modifiedItem.tag === NonRootNormalItem_Tags.File) {
			cache.cacheNewFile(modifiedItem.inner[0], item)
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

	/**
	 * Share a single owned file or directory with another Filen user. Dispatches
	 * to the right SDK call based on the item type. Re-encrypts directory
	 * contents under the recipient's public key (the SDK handles the heavy
	 * lifting; we pass a `undefined` progress callback for now). Throws on
	 * error so callers can wrap in `run()` / `runBulk` for UI feedback.
	 */
	public async shareWithFilenUser({ item, contact, signal }: { item: DriveItem; contact: Contact; signal?: AbortSignal }) {
		if (item.type !== "directory" && item.type !== "file") {
			throw new Error("Invalid item type for share")
		}

		const { authedSdkClient } = await auth.getSdkClients()

		if (item.type === "directory") {
			await authedSdkClient.shareDir(item.data, contact, undefined, signal ? { signal } : undefined)

			return
		}

		await authedSdkClient.shareFile(item.data, contact, signal ? { signal } : undefined)
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

		// Sync persistent caches — name (decryptedMeta) changed on the raw Dir/File.
		if (item.type === "file" && "region" in modifiedItem) {
			cache.cacheNewFile(modifiedItem, item)
		} else if (item.type === "directory" && !("region" in modifiedItem)) {
			cache.cacheNewNormalDir(modifiedItem, item)
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

	public deletePermanently = deletePermanently

	public trash = trash

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

		// Sync persistent caches — `color` changed on the raw Dir.
		cache.cacheNewNormalDir(modifiedDir, item)

		const unwrappedParentUuid = unwrapParentUuid(item.data.parent)

		if (unwrappedParentUuid) {
			driveItemsQueryUpdateGlobal({
				parentUuid: unwrappedParentUuid,
				updater: prev => prev.map(i => (i.data.uuid === item.data.uuid ? item : i))
			})
		}

		return item
	}

	public restoreFileVersion = restoreFileVersion

	public emptyTrash = emptyTrash

	public deleteVersion = deleteVersion

	public restore = restore

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

		// Item leaves the user's sharedIn/sharedOut view entirely — forget caches.
		cache.forgetItem(item.data.uuid)

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

	public removeDirLink = removeDirLink

	public removeFileLink = removeFileLink

	public createDirectory = createDirectory

	public move = move

	public findItemMatchesForName = findItemMatchesForName

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
							created: created !== undefined ? BigInt(created) : undefined
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
							lastModified: modified !== undefined ? BigInt(modified) : undefined,
							created: created !== undefined ? CreatedTime.Set.new(BigInt(created)) : CreatedTime.Keep.new()
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

		// Sync persistent caches — timestamps changed on the raw Dir/File.
		if (item.type === "file" && "region" in modifiedItem) {
			cache.cacheNewFile(modifiedItem, item)
		} else if (item.type === "directory" && !("region" in modifiedItem)) {
			cache.cacheNewNormalDir(modifiedItem, item)
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

	public enablePublicLink = enablePublicLink

	public disablePublicLink = disablePublicLink

	public updatePublicLink = updatePublicLink

	public async openLinkedDirectory({
		linkUuid,
		linkKey,
		root,
		password,
		signal
	}: {
		linkUuid: string
		linkKey: string
		root: LinkedRootDir
		password?: string
		signal?: AbortSignal
	}) {
		const { authedSdkClient } = await auth.getSdkClients()

		const result = await runWithLoading(async () => {
			const info = await authedSdkClient.getDirPublicLinkInfo(
				linkUuid,
				linkKey,
				signal
					? {
							signal
						}
					: undefined
			)

			return authedSdkClient.listLinkedDir(
				new AnyLinkedDir.Root(info.root),
				{
					...info.link,
					password
				},
				undefined,
				signal
					? {
							signal
						}
					: undefined
			)
		})

		if (!result.success) {
			const unwrappedError = unwrapSdkError(result.error)

			if (unwrappedError?.kind() === ErrorKind.WrongPassword) {
				if (!password) {
					const promptResult = await run(async () => {
						return await prompts.input({
							title: i18n.t("password_required"),
							message: i18n.t("enter_public_link_directory_password"),
							cancelText: i18n.t("cancel"),
							okText: i18n.t("submit"),
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

					password = promptResult.data.value

					await this.openLinkedDirectory({
						linkUuid,
						linkKey,
						root,
						password,
						signal
					})

					return
				}

				alerts.error(i18n.t("wrong_password"))

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

	public async openLinkedFile({
		linkUuid,
		fileKey,
		password,
		signal
	}: {
		linkUuid: string
		fileKey: string
		password?: string
		signal?: AbortSignal
	}) {
		const { authedSdkClient } = await auth.getSdkClients()

		const result = await runWithLoading(async () => {
			return authedSdkClient.getLinkedFile(
				linkUuid,
				fileKey,
				password,
				signal
					? {
							signal
						}
					: undefined
			)
		})

		if (!result.success) {
			const unwrappedError = unwrapSdkError(result.error)

			if (unwrappedError?.kind() === ErrorKind.WrongPassword) {
				if (!password) {
					const promptResult = await run(async () => {
						return await prompts.input({
							title: i18n.t("password_required"),
							message: i18n.t("enter_public_link_file_password"),
							cancelText: i18n.t("cancel"),
							okText: i18n.t("submit"),
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

					password = promptResult.data.value

					await this.openLinkedFile({
						linkUuid,
						fileKey,
						password,
						signal
					})

					return
				}

				alerts.error(i18n.t("wrong_password"))

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

	// The drive root uuid is stable for the lifetime of an authenticated session.
	// Cache it after the first resolve so repeated callers (header bulk-move,
	// per-item move) don't each round-trip through `getSdkClients()`.
	private cachedRootUuid: string | null = null

	public async getRootUuid(): Promise<string> {
		if (this.cachedRootUuid) {
			return this.cachedRootUuid
		}

		const { authedSdkClient } = await auth.getSdkClients()
		const rootUuid = authedSdkClient.root().uuid

		this.cachedRootUuid = rootUuid

		return rootUuid
	}
}

const drive = new Drive()

export default drive
