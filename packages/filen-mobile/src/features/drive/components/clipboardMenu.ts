import { type TFunction } from "i18next"
import { type AnyNormalDir } from "@filen/sdk-rs"
import { run } from "@filen/shared"
import { type MenuButton } from "@/components/ui/menu"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import type { DriveItem } from "@/types"
import type { DrivePath } from "@/hooks/useDrivePath"
import alerts from "@/lib/alerts"
import cache from "@/lib/cache"
import logger from "@/lib/logger"
import drive from "@/features/drive/drive"
import copyRunner from "@/features/copy/copyRunner"
import { canPasteInto, copyDestinationOf } from "@/features/drive/clipboard"
import useDriveClipboardStore, { type DriveClipboardEntry } from "@/features/drive/store/useDriveClipboard.store"

// Pastes the clipboard into `targetDir`. A copy starts one copy job and stays on the clipboard for more
// pastes; a cut moves each item behind the full-screen loader like Move, leaves the clipboard as it
// starts, and puts back whatever failed to move.
export async function pasteClipboard({ targetDir, allowCut, t }: { targetDir: AnyNormalDir; allowCut: boolean; t: TFunction }): Promise<void> {
	const store = useDriveClipboardStore.getState()
	const entry = store.entry

	// The menu may be older than the clipboard.
	if (!canPasteInto({ entry, targetUuid: targetDir.inner[0].uuid, allowCut }) || entry === null) {
		return
	}

	if (entry.mode === "copy") {
		const started = await run(async () => {
			return copyRunner.start({
				items: entry.items,
				destination: copyDestinationOf(targetDir, cache.rootUuid, t("drive")),
				destinationDir: targetDir
			})
		})

		if (!started.success) {
			logger.error("drive", "paste: copy failed to start", { error: started.error, count: entry.items.length })
			alerts.error(started.error)
		}

		return
	}

	store.clear()

	const result = await runWithLoading(async () => {
		return await Promise.allSettled(
			entry.items.map(async item => {
				await drive.move({
					item,
					newParent: targetDir
				})
			})
		)
	})

	const failed: DriveItem[] = []
	let firstError: unknown = result.success ? null : result.error

	if (result.success) {
		result.data.forEach((outcome, index) => {
			const item = entry.items[index]

			if (outcome.status === "rejected" && item) {
				failed.push(item)
				firstError ??= outcome.reason
			}
		})
	} else {
		failed.push(...entry.items)
	}

	if (failed.length === 0) {
		return
	}

	useDriveClipboardStore.getState().restoreCut(failed)
	logger.error("drive", "paste: move failed", { error: firstError, failed: failed.length, count: entry.items.length })
	alerts.error(firstError)
}

function pasteTitle(entry: DriveClipboardEntry, t: TFunction): string {
	return entry.items.length === 1 ? t("paste") : t("paste_items", { count: entry.items.length })
}

// "Paste" and "Clear clipboard" for the directory on screen (header menu and the empty-state Add menu),
// present while the clipboard holds something. Paste is disabled where it can't land.
export function buildPasteHereMenuButtons({
	entry,
	targetDir,
	allowCut,
	t
}: {
	entry: DriveClipboardEntry | null
	targetDir: AnyNormalDir | null
	allowCut: boolean
	t: TFunction
}): MenuButton[] {
	if (entry === null) {
		return []
	}

	return [
		{
			id: "paste",
			title: pasteTitle(entry, t),
			icon: "paste",
			requiresOnline: true,
			disabled: targetDir === null || !canPasteInto({ entry, targetUuid: targetDir.inner[0].uuid, allowCut }),
			onPress: async () => {
				if (targetDir) {
					await pasteClipboard({ targetDir, allowCut, t })
				}
			}
		},
		{
			id: "clearClipboard",
			title: t("clear_clipboard"),
			icon: "clearClipboard",
			onPress: () => {
				useDriveClipboardStore.getState().clear()
			}
		}
	]
}

// Own directory rows in the writable browsing views; only these rows follow the clipboard.
export function offersPasteInto(drivePath: DrivePath, item: DriveItem): boolean {
	return (
		item.type === "directory" &&
		(drivePath.type === "drive" ||
			drivePath.type === "favorites" ||
			drivePath.type === "recents" ||
			drivePath.type === "links" ||
			drivePath.type === "sharedOut")
	)
}

// "Paste into" on a directory row: only where the paste can land.
export function buildPasteIntoMenuButton({
	entry,
	targetDir,
	allowCut,
	t
}: {
	entry: DriveClipboardEntry | null
	targetDir: AnyNormalDir | undefined
	allowCut: boolean
	t: TFunction
}): MenuButton | null {
	if (!entry || !targetDir || !canPasteInto({ entry, targetUuid: targetDir.inner[0].uuid, allowCut })) {
		return null
	}

	return {
		id: "pasteInto",
		title: t("paste_into"),
		icon: "paste",
		requiresOnline: true,
		onPress: async () => {
			await pasteClipboard({ targetDir, allowCut, t })
		}
	}
}
