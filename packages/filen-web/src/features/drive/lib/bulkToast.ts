import { type BulkOutcome } from "@/lib/actions/bulk"
import { type DriveItem } from "@/features/drive/lib/item"
import { toastBulkSummary } from "@/lib/actions/bulkToast"
import { useDriveStore } from "@/features/drive/store/useDriveStore"

export function toastBulkOutcome(outcome: BulkOutcome<DriveItem>): void {
	toastBulkSummary(outcome, { complete: "drive:driveBulkActionComplete", withFailures: "drive:driveBulkActionCompleteWithFailures" })
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

// Toasts a bulk outcome, then drops the succeeded items from the selection. A failed item stays
// selected so the user can retry without re-selecting.
export function finishBulkOutcome(outcome: BulkOutcome<DriveItem>, prune: (succeeded: DriveItem[]) => void = pruneSelectionByUuid): void {
	toastBulkOutcome(outcome)
	prune(outcome.succeeded)
}
