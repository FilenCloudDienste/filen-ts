import auth from "@/lib/auth"
import {
	ErrorKind,
	AnyLinkedDir,
	type LinkedRootDir,
	DirMeta_Tags,
	type File,
	FileMeta,
	ParentUuid,
	MaybeEncryptedUniffi_Tags
} from "@filen/sdk-rs"
import { unwrapFileMeta, unwrappedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import { unwrapSdkError } from "@/lib/sdkErrors"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import { run } from "@filen/utils"
import alerts from "@/lib/alerts"
import { router } from "expo-router"
import { serialize } from "@/lib/serializer"
import type { Linked } from "@/hooks/useDrivePath"
import i18n from "@/lib/i18n"
import { enablePublicLink, disablePublicLink, updatePublicLink, removeDirLink, removeFileLink } from "@/features/drive/drivePublicLink"
import { deletePermanently, trash, restore, emptyTrash, restoreFileVersion, deleteVersion } from "@/features/drive/driveTrash"
import { createDirectory, move } from "@/features/drive/driveDirectory"
import { favorite, rename, setDirColor, updateTimestamps } from "@/features/drive/driveMetadata"
import { shareWithFilenUser, removeShare } from "@/features/drive/driveShare"

const drive = {
	favorite,
	shareWithFilenUser,
	rename,
	deletePermanently,
	trash,
	setDirColor,
	restoreFileVersion,
	emptyTrash,
	deleteVersion,
	restore,
	removeShare,
	removeDirLink,
	removeFileLink,
	createDirectory,
	move,
	updateTimestamps,
	enablePublicLink,
	disablePublicLink,
	updatePublicLink,

	async openLinkedDirectory({
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
	},

	async openLinkedFile({
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
	},

	// The drive root uuid is stable for the lifetime of an authenticated session.
	// Cache it after the first resolve so repeated callers (header bulk-move,
	// per-item move) don't each round-trip through `getSdkClients()`.
	cachedRootUuid: null as string | null,

	async getRootUuid(): Promise<string> {
		if (this.cachedRootUuid) {
			return this.cachedRootUuid
		}

		const { authedSdkClient } = await auth.getSdkClients()
		const rootUuid = authedSdkClient.root().uuid

		this.cachedRootUuid = rootUuid

		return rootUuid
	}
}

export default drive
