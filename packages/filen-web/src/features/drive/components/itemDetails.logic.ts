import { asDirectoryOrFile, isSharedRootDriveItem, type DriveItem, type SharedRootDriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { driveRowKey } from "@/features/drive/lib/rowKey"

// How long a selection must hold still before the details panel starts its remote reads: arrowing through rows
// reads nothing for the rows passed over.
export const DETAILS_SETTLE_MS = 300

// One string per selection, so the panel's state resets and its reads restart only when the selection changes.
export function selectionKey(items: readonly DriveItem[]): string {
	return items.map(driveRowKey).join("|")
}

export interface SelectionTotals {
	files: number
	directories: number
	// Files' sizes plus every directory size known.
	knownBytes: number
	// Directories whose size is not known (yet).
	unknownDirectories: number
}

// `directorySize`: a directory's recursive size when known (the dirSize cache), else undefined.
export function selectionTotals(items: readonly DriveItem[], directorySize: (uuid: string) => bigint | undefined): SelectionTotals {
	const totals: SelectionTotals = { files: 0, directories: 0, knownBytes: 0, unknownDirectories: 0 }

	for (const item of items) {
		const base = asDirectoryOrFile(item)

		if (base.type === "file") {
			totals.files++
			totals.knownBytes += Number(base.data.size)

			continue
		}

		totals.directories++

		const size = directorySize(base.data.uuid)

		if (size === undefined) {
			totals.unknownDirectories++
		} else {
			totals.knownBytes += Number(size)
		}
	}

	return totals
}

// An owned item's Shared-by-me rows: the root listing holds it once per receiver.
export function recipientsOf(sharedOutRoot: readonly DriveItem[], uuid: string): SharedRootDriveItem[] {
	return sharedOutRoot.filter((row): row is SharedRootDriveItem => row.data.uuid === uuid && isSharedRootDriveItem(row))
}

// An item the account owns outright and can share, outside the trash (a shared arm is listed under Shared by me or
// Shared with me itself).
export function isOwnedLiveItem(item: DriveItem, variant: DriveVariant): boolean {
	return variant !== "trash" && variant !== "sharedIn" && (item.type === "directory" || item.type === "file")
}
