import { type MenuButton } from "@/components/ui/menu"
import type { DriveItem } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"
import { type TFunction } from "i18next"
import { run } from "@filen/shared"
import alerts from "@/lib/alerts"
import logger from "@/lib/logger"
import { selectCopyDestination } from "@/features/drive/screens/driveSelect"
import copyRunner from "@/features/copy/copyRunner"
import useDriveClipboardStore from "@/features/drive/store/useDriveClipboard.store"

// Every view but the trash; link views get their own save action instead of the clipboard.
export function offersCopy(drivePath: DrivePath): boolean {
	switch (drivePath.type) {
		case "drive":
		case "favorites":
		case "recents":
		case "sharedIn":
		case "sharedOut":
		case "links":
		case "photos":
		case "offline": {
			return true
		}

		default: {
			return false
		}
	}
}

const ITEM_IDS = {
	menu: "copyMenu",
	copy: "copyToClipboard",
	cut: "cutToClipboard",
	copyTo: "copyTo"
} as const

const BULK_IDS = {
	menu: "bulkCopyMenu",
	copy: "bulkCopyToClipboard",
	cut: "bulkCutToClipboard",
	copyTo: "bulkCopyTo"
} as const

// The "Copy" submenu: Copy and Cut for a later paste, and "Copy to…" into a picked directory as ONE copy
// job however many items. Only "Copy to…" needs the network. `onDone` runs once the items are on the
// clipboard or the job started.
export function buildCopyMenuButton({
	items,
	withCut,
	bulk,
	onDone,
	t
}: {
	items: DriveItem[]
	// Cut is offered wherever Move is.
	withCut: boolean
	bulk: boolean
	onDone?: () => void
	t: TFunction
}): MenuButton {
	const ids = bulk ? BULK_IDS : ITEM_IDS
	const subButtons: MenuButton[] = [
		{
			id: ids.copy,
			title: t("copy"),
			icon: "copyItems",
			onPress: () => {
				useDriveClipboardStore.getState().set({
					mode: "copy",
					items
				})

				onDone?.()
			}
		}
	]

	if (withCut) {
		subButtons.push({
			id: ids.cut,
			title: t("cut"),
			icon: "cut",
			onPress: () => {
				useDriveClipboardStore.getState().set({
					mode: "cut",
					items
				})

				onDone?.()
			}
		})
	}

	subButtons.push({
		id: ids.copyTo,
		title: t("copy_to"),
		icon: "copyTo",
		requiresOnline: true,
		onPress: async () => {
			const picked = await run(async () => {
				return await selectCopyDestination(items, t("drive"))
			})

			if (!picked.success) {
				logger.error("drive", "copy to: destination picker failed", { error: picked.error })
				alerts.error(picked.error)

				return
			}

			if (!picked.data) {
				return
			}

			const { destination, destinationDir } = picked.data
			const started = await run(async () => {
				return copyRunner.start({
					items,
					destination,
					destinationDir
				})
			})

			if (!started.success) {
				logger.error("drive", "copy to: failed to start", { error: started.error, count: items.length })
				alerts.error(started.error)

				return
			}

			onDone?.()
		}
	})

	return {
		id: ids.menu,
		title: t("copy"),
		icon: "copyItems",
		subButtons
	}
}
