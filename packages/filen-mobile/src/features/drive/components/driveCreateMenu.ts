import { type TFunction } from "i18next"
import { AnyNormalDir } from "@filen/sdk-rs"
import { run } from "@filen/utils"
import { type DrivePath } from "@/hooks/useDrivePath"
import { type MenuButton } from "@/components/ui/menu"
import { type UseDriveUpload } from "@/features/drive/hooks/useDriveUpload"
import alerts from "@/lib/alerts"
import prompts from "@/lib/prompts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import drive from "@/features/drive/drive"
import cache from "@/lib/cache"
import logger from "@/lib/logger"

// Resolves the AnyNormalDir to create/upload into for the current Drive path, or null when the
// path has no user-owned parent directory (e.g. shared-in, trash, or an uncached directory).
// Single source for the drive header menu AND the empty-state CTA.
export function getDriveParent(drivePath: DrivePath): AnyNormalDir | null {
	// At the drive root with a cached root uuid, the parent is the root directory.
	if (drivePath.type === "drive" && drivePath.uuid === null && cache.rootUuid) {
		return new AnyNormalDir.Root({
			uuid: cache.rootUuid
		})
	}

	// Otherwise resolve the current directory from the AnyNormalDir cache (only user-owned
	// directories are present there — shared-in directories are not).
	const fromCache = cache.directoryUuidToAnyNormalDir.get(drivePath.uuid ?? "")

	return fromCache ?? null
}

// Whether the create/upload menu (and the matching empty-state CTA) should be shown: a writable
// context with a resolved parent directory, not in picker or selection mode. Single source so the
// header menu and the empty-state CTA appear under exactly the same conditions.
export function canShowDriveCreateMenu({
	drivePath,
	parent,
	selectionMode
}: {
	drivePath: DrivePath
	parent: AnyNormalDir | null
	selectionMode: boolean
}): boolean {
	return (
		parent !== null &&
		(drivePath.type === "drive" ||
			(drivePath.type === "links" && drivePath.uuid !== null) ||
			(drivePath.type === "favorites" && drivePath.uuid !== null) ||
			(drivePath.type === "sharedOut" && drivePath.uuid !== null)) &&
		!drivePath.selectOptions &&
		!selectionMode
	)
}

// The "Create directory" + "Upload" menu buttons. Single source for the drive header's right menu
// and the empty-state CTA's dropdown, so both always offer the identical actions.
export function buildDriveCreateMenuButtons({
	t,
	parent,
	upload
}: {
	t: TFunction
	parent: AnyNormalDir | null
	upload: UseDriveUpload
}): MenuButton[] {
	return [
		{
			id: "createFolder",
			title: t("create_folder"),
			icon: "plus",
			requiresOnline: true,
			onPress: async () => {
				if (!parent) {
					return
				}

				const promptResult = await run(async () => {
					return await prompts.input({
						title: t("create_folder"),
						message: t("enter_folder_name"),
						cancelText: t("cancel"),
						okText: t("create"),
						placeholder: t("folder_name")
					})
				})

				if (!promptResult.success) {
					logger.warn("drive", "create directory prompt failed", { error: String(promptResult.error) })
					alerts.error(promptResult.error)

					return
				}

				if (promptResult.data.cancelled || promptResult.data.type !== "string") {
					return
				}

				const folderName = promptResult.data.value.trim()

				if (folderName.length === 0) {
					return
				}

				const result = await runWithLoading(async () => {
					await drive.createDirectory({
						name: folderName,
						parent
					})
				})

				if (!result.success) {
					logger.error("drive", "create directory failed", { error: String(result.error) })
					alerts.error(result.error)
				}
			}
		},
		{
			id: "upload",
			title: t("upload"),
			icon: "upload",
			requiresOnline: true,
			subButtons: [
				{
					id: "uploadFiles",
					title: t("upload_files"),
					icon: "doc",
					requiresOnline: true,
					onPress: upload.uploadFiles
				},
				{
					id: "uploadPhotosOrVideos",
					requiresOnline: true,
					title: t("upload_photos_or_videos"),
					icon: "image",
					onPress: upload.uploadPhotosOrVideos
				},
				{
					id: "takePhotoOrVideo",
					title: t("take_photo_or_video"),
					icon: "camera",
					requiresOnline: true,
					onPress: upload.takePhotoOrVideo
				},
				{
					id: "scanDocument",
					requiresOnline: true,
					title: t("scan_document"),
					icon: "scan",
					onPress: upload.scanDocument
				},
				{
					id: "createTextFile",
					title: t("create_text_file"),
					icon: "text",
					requiresOnline: true,
					onPress: upload.createTextFile
				}
			]
		}
	]
}
