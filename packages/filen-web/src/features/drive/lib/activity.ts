import { driveItemName } from "@filen/shared"
import type { UuidStr } from "@filen/sdk-rs"
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

// How an action's succeeded items leave the selection. Trash, delete, restore, move and disable-link take
// the whole item out of the listing, so every receiver row of it goes ("uuid"); unshare removes only its
// own receiver's row, so the item's other rows stay selected ("row"). A function prunes some other
// selection, untracked.
export type DrivePrune<T extends DriveItem> = "uuid" | "row" | ((succeeded: T[]) => void)

interface SelectedThroughout {
	has: (uuid: UuidStr) => boolean
	settle: (uuids: readonly UuidStr[]) => void
}

// The uuids among `items` selected when the action starts, each kept only while it stays selected. One
// that leaves the selection (a navigation clears it, a listing drops it) and is picked again is a new
// selection the action never saw, and pruning it when the action ends would take it from under the user.
// Subscribed only while something is tracked, so an action over unselected items costs nothing.
function trackSelectedThroughout(items: readonly DriveItem[]): SelectedThroughout {
	const uuids = new Set(items.map(item => item.data.uuid))
	const tracked = new Set(
		useDriveStore
			.getState()
			.selectedItems.map(item => item.data.uuid)
			.filter(uuid => uuids.has(uuid))
	)
	let unsubscribe: (() => void) | null = null

	function stopIfDone(): void {
		if (tracked.size === 0) {
			unsubscribe?.()
			unsubscribe = null
		}
	}

	if (tracked.size > 0) {
		unsubscribe = useDriveStore.subscribe((state, previous) => {
			if (state.selectedItems === previous.selectedItems) {
				return
			}

			const selected = new Set(state.selectedItems.map(item => item.data.uuid))

			for (const uuid of tracked) {
				if (!selected.has(uuid)) {
					tracked.delete(uuid)
				}
			}

			stopIfDone()
		})
	}

	return {
		has: uuid => tracked.has(uuid),
		// A failed item stays tracked for a Try again; a succeeded one is done either way.
		settle: settled => {
			for (const uuid of settled) {
				tracked.delete(uuid)
			}

			stopIfDone()
		}
	}
}

// A drive action over items as an activity: named by each item's name, and the succeeded ones dropped
// from the selection once it ends, if they were selected throughout. A failed item stays selected so the
// user can retry without re-selecting. `onDone` follows the prune, on a Try again's run too.
export function driveActivity<T extends DriveItem>(
	items: readonly T[],
	keys: ActivityKeys,
	run: BulkActivitySpec<T>["run"],
	options?: { prune?: DrivePrune<T>; values?: ActivityValues; onDone?: (outcome: BulkOutcome<T>) => void }
): BulkActivitySpec<T> {
	const prune = options?.prune ?? "uuid"
	const selected = typeof prune === "function" ? null : trackSelectedThroughout(items)

	return {
		items,
		keys,
		name: driveItemName,
		run,
		onDone: outcome => {
			if (typeof prune === "function") {
				prune(outcome.succeeded)
			} else if (selected !== null) {
				const still = outcome.succeeded.filter(item => selected.has(item.data.uuid))

				if (prune === "uuid") {
					useDriveStore.getState().removeFromSelection(still.map(item => item.data.uuid))
				} else {
					useDriveStore.getState().removeRowsFromSelection(still)
				}

				selected.settle(outcome.succeeded.map(item => item.data.uuid))
			}

			options?.onDone?.(outcome)
		},
		...(options?.values !== undefined ? { values: options.values } : {})
	}
}
