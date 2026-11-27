import { currentRootUuid, moveItems, restoreItems } from "@/features/drive/lib/actions"
import { DRIVE_MOVE_BACK, DRIVE_RESTORE, driveActivity } from "@/features/drive/lib/activity"
import { type DriveItem } from "@/features/drive/lib/item"
import { runBulkActivity } from "@/lib/activity/activity"
import type { BulkOutcome, BulkProgress } from "@/lib/actions/bulk"

// The Undo of a drive action's result toast, built from the items as the action was handed them: what they were
// before it ran is all undoing needs.

// A trash's way back: every trashed item restored into the directory it left.
export function undoTrash(trashed: DriveItem[]): (() => void) | null {
	if (trashed.length === 0) {
		return null
	}

	return () => {
		void runBulkActivity(driveActivity(trashed, DRIVE_RESTORE, restoreItems))
	}
}

// Moves each item back into the parent it had before the move, one moveItems run per parent, in parallel.
export async function moveItemsBack(items: DriveItem[], onSettled?: BulkProgress): Promise<BulkOutcome<DriveItem>> {
	const byParent = new Map<string, DriveItem[]>()

	for (const item of items) {
		const group = byParent.get(item.data.parent)

		if (group === undefined) {
			byParent.set(item.data.parent, [item])
		} else {
			group.push(item)
		}
	}

	let settled = 0
	const outcomes = await Promise.all(
		Array.from(byParent, ([parent, group]) =>
			moveItems(group, parent, () => {
				settled += 1
				onSettled?.(settled, items.length)
			})
		)
	)

	return { succeeded: outcomes.flatMap(outcome => outcome.succeeded), failed: outcomes.flatMap(outcome => outcome.failed) }
}

// A move's way back, for the items that changed directory (one already in the destination stayed where it was). A null
// destination is the drive root.
export function undoMove(moved: DriveItem[], destinationUuid: string | null): (() => void) | null {
	const destination = destinationUuid ?? currentRootUuid()
	const changed = moved.filter(item => item.data.parent !== destination)

	if (changed.length === 0) {
		return null
	}

	return () => {
		void runBulkActivity(driveActivity(changed, DRIVE_MOVE_BACK, moveItemsBack))
	}
}
