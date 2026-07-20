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
	t
}: {
	item: DriveItem
	drivePath: DrivePath
	// Accepted for signature parity with createMenuButtons; unused — the gallery owns
	// preview navigation for these destructive actions via driveItemRemoved.
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
					// deletePermanently emits driveItemRemoved, which the gallery's own subscriber
					// acts on — advancing to a neighbour, or popping (once) when it was the last
					// previewed item. A self-pop here too double-navigated (mirrors the decryptable
					// trash/delete actions).
					dismissOnSuccess: false
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
				// trash emits driveItemRemoved — same gallery-owned navigation as above; a self-pop
				// here closed the preview instead of advancing.
				dismissOnSuccess: false
			})
		})
	}

	return undecryptableButtons
}
