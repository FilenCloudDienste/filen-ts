import { confirmedAction } from "@/lib/confirmedAction"
import type { DriveItem } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"
import { type MenuButton } from "@/components/ui/menu"
import { type TFunction } from "i18next"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import drive from "@/features/drive/drive"
import alerts from "@/lib/alerts"
import logger from "@/lib/logger"
import { isFileItem } from "@/features/drive/driveSelectors"

// Shared shape for confirmed destructive drive actions (trash / delete / remove
// offline / remove share / stop sharing / disable link): prompt → guard cancel →
// runWithLoading(action) → guard failure → optionally pop back when we just purged
// a file we may be previewing. Returns the onPress handler. Mirrors notes'
// `confirmedNoteAction`.
export function confirmedDriveAction({
	item,
	promptTitle,
	promptMessage,
	promptOkText,
	promptDestructive = true,
	action,
	dismissOnSuccess
}: {
	item: DriveItem
	promptTitle: string
	promptMessage: string
	promptOkText: string
	// The plain `trash` action (buildTrashButton) is the one site that omits destructive
	// styling on the alert itself — default true preserves the destructive look everywhere else.
	promptDestructive?: boolean
	// Return value is awaited then discarded (matches the original `await drive.X(...)`).
	action: () => Promise<unknown>
	// When true and the purged item is a previewable file, pop back (closes the
	// file preview / detail route sitting on top). Call sites set this from their
	// preview context — see `isPreview` in createMenuButtons.
	dismissOnSuccess: boolean
}): () => Promise<void> {
	return confirmedAction({
		promptTitle,
		promptMessage,
		promptOkText,
		promptDestructive,
		action,
		// Only files are previewed (a directory tap navigates into it), so the dismiss
		// targets any previewable file type — including the shared* variants opened from
		// the sharedIn/sharedOut/links galleries (the old `type === "file"` check missed those).
		dismiss: dismissOnSuccess ? () => isFileItem(item) : undefined
	})
}

// Trash / restore / delete-permanently are shared by the decryptable and undecryptable menus.
// All three emit driveItemRemoved, which the gallery's own subscriber acts on — advancing to a
// neighbour, or popping (once) when it was the last previewed item. So they never self-pop
// (dismissOnSuccess: false): a second pop double-navigated past a single-item preview and closed
// a multi-item gallery instead of advancing.

export function offersTrash(drivePath: DrivePath): boolean {
	return drivePath.type !== "trash" && drivePath.type !== "sharedIn" && drivePath.type !== "offline" && drivePath.type !== "linked"
}

export function buildTrashButton({ item, t }: { item: DriveItem; t: TFunction }): MenuButton {
	return {
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
			// Trash is recoverable, so its confirm alert is the one not styled destructive.
			promptDestructive: false,
			action: () => drive.trash({ item }),
			dismissOnSuccess: false
		})
	}
}

export function buildRestoreButton({ item, t }: { item: DriveItem; t: TFunction }): MenuButton {
	return {
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
				logger.error("drive", "restore failed", { error: result.error, uuid: item.data.uuid })
				alerts.error(result.error)
			}
		}
	}
}

export function buildDeletePermanentlyButton({ item, t }: { item: DriveItem; t: TFunction }): MenuButton {
	return {
		id: "deletePermanently",
		requiresOnline: true,
		title: t("delete_permanently"),
		icon: "delete",
		destructive: true,
		onPress: confirmedDriveAction({
			item,
			promptTitle: t("delete_permanently"),
			promptMessage: t("confirm_delete_permanently"),
			promptOkText: t("delete_permanently"),
			action: () => drive.deletePermanently({ item }),
			dismissOnSuccess: false
		})
	}
}
