import { type DriveItem } from "@/features/drive/lib/item"

// A listing row's identity: the Shared by me root lists an item once per receiver, and each row unshares
// only its own receiver, so a shared root row is told apart by its counterpart too. Every other row is
// its uuid.
export function driveRowKey(item: DriveItem): string {
	if (item.type !== "sharedRootDirectory" && item.type !== "sharedRootFile") {
		return item.data.uuid
	}

	const role = item.data.sharingRole

	return `${item.data.uuid}:${String("Receiver" in role ? role.Receiver.id : role.Sharer.id)}`
}
