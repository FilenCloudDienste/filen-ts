import type { DriveItem } from "@/features/drive/lib/item"

// The "drive" listing variant only ever returns the base directory/file arms (never a
// shared/shared-root/link arm — those are the other five DriveVariant values' own concern), so this
// narrows to exactly the arm carrying `.color`/`.decryptedMeta` (DirColor) the row renderer reads.
export type PhotosChooserDirectory = Extract<DriveItem, { type: "directory" }>

// The picker browses exclusively the "drive" listing variant (useDirectoryListingQuery("drive",
// uuid) in directoryChooserDialog.tsx), which never returns a shared/trash/link row to begin with —
// this filter's real job is dropping FILE rows out of that same listing, mirroring
// moveTargetDialog.tsx's own `directories` derivation one line above its JSX. An explicit type
// predicate (not a bare boolean callback) so the narrowed arm survives across this function's own
// declared return type — inline `.filter(item => item.type === "directory")` narrows fine at its own
// call site, but a wrapper function needs the predicate spelled out for callers to see the same
// narrowing.
export function photosChooserDirectories(items: DriveItem[]): PhotosChooserDirectory[] {
	return items.filter((item): item is PhotosChooserDirectory => item.type === "directory")
}

// An undecryptable directory has no name to show and can't be resolved as a root server-side either
// — mirrors moveTargetDialog.logic.ts's isMoveRowDisabled undecryptable branch. The photos chooser
// has no "moved items" ancestry concern of its own (it never forbids descending into a directory
// because of what's being relocated), so this is the whole row-level gate.
export function isPhotosChooserRowDisabled(row: DriveItem): boolean {
	return row.data.undecryptable
}

// What "Choose this directory" picks: the directory open in the picker, or at the top the whole drive,
// chosen by its root uuid — null until the account that names the root is loaded, so confirm stays
// disabled rather than saving an empty root.
export function photosChooserChoice(targetUuid: string | null, driveRootUuid: string | undefined): string | null {
	if (targetUuid !== null) {
		return targetUuid
	}

	return driveRootUuid !== undefined && driveRootUuid.length > 0 ? driveRootUuid : null
}
