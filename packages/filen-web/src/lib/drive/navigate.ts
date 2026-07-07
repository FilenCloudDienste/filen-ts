import { type DriveItem } from "@/lib/drive/item"
import { type DriveVariant } from "@/lib/drive/preferences"

export interface DriveNavigationTarget {
	to: "/drive/$uuid"
	params: { uuid: string }
}

// Files never navigate in 2a — opening one is a preview, a later slice's concern (2e).
//
// Every variant funnels a directory open into the "drive" variant's own route: recents/favorites
// are flat, single-level listings with no nested route of their own (see
// routes/_app/{recents,favorites}.tsx), so entering one of their directories means browsing it like
// any other directory. Trash mirrors mobile's rule instead (filen-mobile's
// src/features/drive/driveSelectors.ts resolveDriveNavigationTarget returns null unconditionally
// once drivePath.type === "trash") — a trashed directory's contents are never browsable, so this
// returns null rather than the drive/$uuid target the other two variants get.
export function resolveDriveNavigationTarget(item: DriveItem, variant: DriveVariant): DriveNavigationTarget | null {
	if (item.type !== "directory") {
		return null
	}

	if (variant === "trash") {
		return null
	}

	return { to: "/drive/$uuid", params: { uuid: item.data.uuid } }
}
