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

// Confirm ("Choose this directory") only enables once the user has actually descended into a
// directory — browsing the root listing itself is not a choice. Root (My Drive itself, uuid null in
// the local pathStack) is deliberately never a pickable photos root: unlike moveTargetDialog's
// pathStack, which can legitimately target the drive root as a move destination, a photos root is
// meant to be a directory the user set aside for photos, not the whole drive.
export function isPhotosChooserConfirmDisabled(targetUuid: string | null): boolean {
	return targetUuid === null
}
