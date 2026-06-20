import { type MenuButton } from "@/components/ui/menu"
import type { DriveItem } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"
import { type TFunction } from "i18next"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import drive from "@/features/drive/drive"
import alerts from "@/lib/alerts"
import { confirmedDriveAction } from "@/features/drive/components/item/menuActionsShared"
import logger from "@/lib/logger"

// Undecryptable items only support destructive disposition — every other
// action (rename/move/share/download/info/etc.) requires decrypted meta.
// In trash view we surface Restore + Delete-permanently so the user can
// still recover or purge. Everywhere else, only Trash is available.
export function buildUndecryptableMenuButtons({
	item,
	drivePath,
	isPreview,
	t
}: {
	item: DriveItem
	drivePath: DrivePath
	// True when rendered inside the preview (gallery) — destructive actions then pop
	// the preview on success. See `isPreview` in createMenuButtons.
	isPreview?: boolean
	t: TFunction
}): MenuButton[] {
	const undecryptableButtons: MenuButton[] = []

	if (drivePath.type === "trash") {
		if (item.type === "file" || item.type === "directory") {
			undecryptableButtons.push({
				id: "restore",
				requiresOnline: true,
				title: t("restore"),
				icon: "restore",
				onPress: async () => {
					const result = await runWithLoading(async () => {
						await drive.restore({
							item
						})
					})

					if (!result.success) {
						logger.error("drive", "restore undecryptable item failed", { error: result.error, uuid: item.data.uuid })
						alerts.error(result.error)

						return
					}
				}
			})

			undecryptableButtons.push({
				id: "deletePermanently",
				requiresOnline: true,
				title: t("delete_permanently"),
				icon: "delete",
				destructive: true,
				onPress: confirmedDriveAction({
					item,
					promptTitle: t("delete_permanently_item"),
					promptMessage: t("confirm_delete_permanently"),
					promptOkText: t("delete_permanently"),
					action: () => drive.deletePermanently({ item }),
					// Close the preview when deleting from inside it (stays put from the list).
					dismissOnSuccess: isPreview === true
				})
			})
		}

		return undecryptableButtons
	}

	// Normal / recents / favorites / sharedIn / sharedOut / links / offline /
	// linked surfaces — Trash is the only path forward.
	if (drivePath.type !== "sharedIn" && drivePath.type !== "offline" && drivePath.type !== "linked") {
		undecryptableButtons.push({
			id: "trash",
			requiresOnline: true,
			title: t("trash"),
			icon: "trash",
			destructive: true,
			onPress: confirmedDriveAction({
				item,
				promptTitle: t("trash_item"),
				promptMessage: t("confirm_trash"),
				promptOkText: t("trash"),
				action: () => drive.trash({ item }),
				// Close the preview when trashing from inside it.
				dismissOnSuccess: isPreview === true
			})
		})
	}

	return undecryptableButtons
}
