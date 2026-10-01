import { shareIdentityFromRole } from "@filen/shared"
import { isSharedRootDriveItem, type DriveItem } from "@/features/drive/lib/item"

// A listing row's identity: the Shared by me root lists an item once per receiver, and each row unshares
// only its own receiver, so a shared root row is told apart by its counterpart too. Every other row is
// its uuid.
export function driveRowKey(item: DriveItem): string {
	if (!isSharedRootDriveItem(item)) {
		return item.data.uuid
	}

	const counterpart = shareIdentityFromRole(item.data.sharingRole)

	return counterpart === null ? item.data.uuid : `${item.data.uuid}:${String(counterpart.userId)}`
}
