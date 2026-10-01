import { driveItemName } from "@filen/shared"
import type { BulkOutcome } from "@/lib/actions/bulk"
import { type ActivityKeys, type ActivityValues, activityKeys } from "@/lib/activity/activity.logic"
import type { BulkActivitySpec } from "@/lib/activity/activity"
import { type DriveItem } from "@/features/drive/lib/item"
import { useDriveStore } from "@/features/drive/store/useDriveStore"

// The drive's actions in the words their activity toasts use (locales/en/drive.ts, "Activity toasts").
export const DRIVE_TRASH = activityKeys("drive:driveTrash")

export const DRIVE_DELETE_PERMANENTLY = activityKeys("drive:driveDeletePermanently")

export const DRIVE_RESTORE = activityKeys("drive:driveRestore")

export const DRIVE_UNSHARE = activityKeys("drive:driveUnshare")

export const DRIVE_DISABLE_LINK = activityKeys("drive:driveDisableLink")

export const DRIVE_MOVE = activityKeys("drive:driveMove")

export const DRIVE_FAVORITE = activityKeys("drive:driveFavorite")

export const DRIVE_UNFAVORITE = activityKeys("drive:driveUnfavorite")

export const DRIVE_SHARE = activityKeys("drive:driveShare")

export const DRIVE_DELETE_VERSIONS = activityKeys("drive:driveDeleteVersions")

// The words of setting `favorited` on items.
export function favoriteKeys(favorited: boolean): ActivityKeys {
	return favorited ? DRIVE_FAVORITE : DRIVE_UNFAVORITE
}

// Trash, delete, restore, move and disable-link take the whole item out of the listing, so every
// receiver row of it goes; unshare removes only its own receiver's row, so the item's other rows stay
// selected.
export function pruneSelectionByUuid(succeeded: DriveItem[]): void {
	useDriveStore.getState().removeFromSelection(succeeded.map(item => item.data.uuid))
}

export function pruneSelectionByRow(succeeded: DriveItem[]): void {
	useDriveStore.getState().removeRowsFromSelection(succeeded)
}

// A drive action over items as an activity: named by each item's name, and the succeeded ones dropped
// from the selection once it ends. A failed item stays selected so the user can retry without
// re-selecting. `onDone` follows the prune, on a Try again's run too.
export function driveActivity<T extends DriveItem>(
	items: readonly T[],
	keys: ActivityKeys,
	run: BulkActivitySpec<T>["run"],
	options?: { prune?: (succeeded: T[]) => void; values?: ActivityValues; onDone?: (outcome: BulkOutcome<T>) => void }
): BulkActivitySpec<T> {
	const prune = options?.prune ?? pruneSelectionByUuid

	return {
		items,
		keys,
		name: driveItemName,
		run,
		onDone: outcome => {
			prune(outcome.succeeded)
			options?.onDone?.(outcome)
		},
		...(options?.values !== undefined ? { values: options.values } : {})
	}
}
