import auth from "@/lib/auth"
import { ErrorKind, type LinkedRootDir, DirMeta_Tags } from "@filen/sdk-rs"
import { linkedRootOf } from "@/features/drive/utils"
import { unwrapDirMeta, unwrappedDirIntoDriveItem, linkedFileIntoDriveItem } from "@/lib/sdkUnwrap"
import { unwrapSdkError } from "@/lib/sdkErrors"
import { inputPrompt } from "@/lib/promptFlow"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import alerts from "@/lib/alerts"
import { router } from "@/lib/router"
import { serialize } from "@/lib/serializer"
import type { Linked } from "@/hooks/useDrivePath"
import i18n from "@/lib/i18n"
import { enablePublicLink, disablePublicLink, updatePublicLink } from "@/features/drive/drivePublicLink"
import { deletePermanently, trash, restore, emptyTrash, restoreFileVersion, deleteVersion } from "@/features/drive/driveTrash"
import { createDirectory, move } from "@/features/drive/driveDirectory"
import { favorite, rename, setDirColor } from "@/features/drive/driveMetadata"
import { shareWithFilenUser, removeShare } from "@/features/drive/driveShare"
import { driveItemsQueryRefetchFailedLinkedListing } from "@/features/drive/queries/useDriveItems.query"
import logger from "@/lib/logger"
import cache from "@/lib/cache"

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
	createDirectory,
	move,
	enablePublicLink,
	disablePublicLink,
	updatePublicLink,

	async openLinkedDirectory({
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
			const linkedRoot = linkedRootOf(info, password)
			const { dirs } = await authedSdkClient.listLinkedDir(linkedRoot.dir, linkedRoot.meta, undefined)

			return {
				linkedRoot,
				dirs
			}
		})

		if (!result.success) {
			const unwrappedError = unwrapSdkError(result.error)

			if (unwrappedError?.kind() === ErrorKind.WrongPassword) {
				if (!password) {
					const enteredPassword = await inputPrompt(
						{
							title: i18n.t("password_required"),
							message: i18n.t("enter_public_link_directory_password"),
							cancelText: i18n.t("cancel"),
							okText: i18n.t("submit"),
							inputType: "secure-text"
						},
						{ tag: "drive-link", message: "openLinkedDirectory password prompt failed" },
						{ allowEmpty: true }
					)

					if (enteredPassword === null) {
						return
					}

					password = enteredPassword

					await this.openLinkedDirectory({
						linkUuid,
						linkKey,
						root,
						password
					})

					return
				}

				alerts.error(i18n.t("wrong_password"))

				return
			}

			logger.error("drive-link", "openLinkedDirectory failed", { linkUuid, error: result.error })
			alerts.error(result.error)

			return
		}

		// The link screen decides Save to Cloud Drive from the root in its first render, which happens before
		// its own listing fetch caches the root, and nothing re-renders it when that fetch does.
		cache.linkedRootByLinkUuid.set(linkUuid, result.data.linkedRoot)

		// Its subdirectories too, as the screen's own read caches them: one tapped in a restored listing before that
		// read lands has no other link context to be listed with.
		for (const dir of result.data.dirs) {
			const driveItem = unwrappedDirIntoDriveItem(unwrapDirMeta(dir.inner))

			cache.cacheNewLinkedDir(dir, driveItem, result.data.linkedRoot.meta)
			driveItemsQueryRefetchFailedLinkedListing(driveItem.data.uuid)
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

	async openLinkedFile({ linkUuid, fileKey, password }: { linkUuid: string; fileKey: string; password?: string }) {
		const { authedSdkClient } = await auth.getSdkClients()

		const result = await runWithLoading(async () => {
			return authedSdkClient.getLinkedFile(linkUuid, fileKey, password)
		})

		if (!result.success) {
			const unwrappedError = unwrapSdkError(result.error)

			if (unwrappedError?.kind() === ErrorKind.WrongPassword) {
				if (!password) {
					const enteredPassword = await inputPrompt(
						{
							title: i18n.t("password_required"),
							message: i18n.t("enter_public_link_file_password"),
							cancelText: i18n.t("cancel"),
							okText: i18n.t("submit"),
							inputType: "secure-text"
						},
						{ tag: "drive-link", message: "openLinkedFile password prompt failed" },
						{ allowEmpty: true }
					)

					if (enteredPassword === null) {
						return
					}

					password = enteredPassword

					await this.openLinkedFile({
						linkUuid,
						fileKey,
						password
					})

					return
				}

				alerts.error(i18n.t("wrong_password"))

				return
			}

			logger.error("drive-link", "openLinkedFile failed", { linkUuid, error: result.error })
			alerts.error(result.error)

			return
		}

		cache.linkedFileByUuid.set(result.data.uuid, result.data)

		router.push({
			pathname: "/linkedFile",
			params: {
				item: serialize(linkedFileIntoDriveItem(result.data))
			}
		})
	},

	// cache.rootUuid is set at boot for every authed session; the SDK is only the fallback.
	async getRootUuid(): Promise<string> {
		if (cache.rootUuid !== null) {
			return cache.rootUuid
		}

		const { authedSdkClient } = await auth.getSdkClients()

		return authedSdkClient.root().uuid
	}
}

export default drive
