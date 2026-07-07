import { type DriveItem } from "@/lib/drive/item"
import { type DriveVariant } from "@/lib/drive/preferences"

export interface DriveNavigationTarget {
	to: "/drive/$"
	params: { _splat: string }
}

// The drive route's full ancestor-uuid path lives entirely in the URL (the "/drive/$" splat) — no
// getItemPath/getDirectoryPath round trip builds it. Splits a splat ("" for root, else a "/"-joined
// uuid chain with no leading/trailing slash) into its uuid segments; the inverse of the
// append-a-segment building resolveDriveNavigationTarget does below. Shared by the breadcrumb
// (every ancestor) and the drive route (the current directory is always the last segment).
export function splatToUuids(splat: string): string[] {
	return splat === "" ? [] : splat.split("/")
}

// Files never navigate here — opening one is a preview, a later concern.
//
// Every variant funnels a directory open into the "drive" variant's own splat route:
// recents/favorites are flat, single-level listings with no path of their own (see
// routes/_app/{recents,favorites}.tsx), so entering one of their directories starts a fresh
// one-level path — same as opening a directory at the drive root (both pass an empty
// `currentSplat`). Trash mirrors mobile's rule instead (filen-mobile's
// src/features/drive/driveSelectors.ts resolveDriveNavigationTarget returns null unconditionally
// once drivePath.type === "trash") — a trashed directory's contents are never browsable, so this
// returns null rather than a splat target the other variants get.
export function resolveDriveNavigationTarget(item: DriveItem, variant: DriveVariant, currentSplat: string): DriveNavigationTarget | null {
	if (item.type !== "directory") {
		return null
	}

	if (variant === "trash") {
		return null
	}

	const nextSplat = currentSplat === "" ? item.data.uuid : `${currentSplat}/${item.data.uuid}`

	return { to: "/drive/$", params: { _splat: nextSplat } }
}
