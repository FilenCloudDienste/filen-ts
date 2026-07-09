import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"

// The three splat routes a directory open can land on — one per browsable surface with a path of its
// own (My Drive plus the two shared roots). recents/favorites/trash have no splat route; a directory
// opened from one of them starts a fresh "/drive/$" path (see resolveDriveNavigationTarget).
export type DriveRouteId = "/drive/$" | "/shared-in/$" | "/shared-out/$"

// Which splat route a given variant's directories browse within: the shared variants descend into
// their own "/shared-in/$" / "/shared-out/$" routes so a nested share never lands on the owned
// "/drive/$" route; every other variant funnels into "/drive/$".
export function driveRouteIdFor(variant: DriveVariant): DriveRouteId {
	return variant === "sharedIn" ? "/shared-in/$" : variant === "sharedOut" ? "/shared-out/$" : "/drive/$"
}

export interface DriveNavigationTarget {
	to: DriveRouteId
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
// The target route is driveRouteIdFor(variant): the two shared variants descend into their own
// splat routes (a nested share stays under "/shared-in/$" / "/shared-out/$"), everything else funnels
// into "/drive/$". recents/favorites are flat, single-level listings with no path of their own (see
// routes/_app/{recents,favorites}.tsx), so entering one of their directories starts a fresh
// one-level path — same as opening a directory at the drive root (both pass an empty
// `currentSplat`). Trash mirrors mobile's rule instead (filen-mobile's
// src/features/drive/driveSelectors.ts resolveDriveNavigationTarget returns null unconditionally
// once drivePath.type === "trash") — a trashed directory's contents are never browsable, so this
// returns null rather than a splat target the other variants get.
export function resolveDriveNavigationTarget(item: DriveItem, variant: DriveVariant, currentSplat: string): DriveNavigationTarget | null {
	// A shared directory is navigable too (browsing into a nested share), so directory-vs-file routes
	// through asDirectoryOrFile — else descending into a shared-dir would be rejected as a non-directory.
	if (asDirectoryOrFile(item).type !== "directory") {
		return null
	}

	if (variant === "trash") {
		return null
	}

	const nextSplat = currentSplat === "" ? item.data.uuid : `${currentSplat}/${item.data.uuid}`

	return { to: driveRouteIdFor(variant), params: { _splat: nextSplat } }
}
