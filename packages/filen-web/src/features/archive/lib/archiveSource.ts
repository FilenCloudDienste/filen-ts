import type { AnyFile, UuidStr } from "@filen/sdk-rs"
import { driveItemName } from "@filen/shared"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { FLAT_LISTING_KINDS } from "@/features/drive/lib/flatListing"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { normalizeParentUuid } from "@/features/drive/queries/drive"
import { isReadOnlySharedVariant } from "@/features/drive/lib/share/gating"

// The archive a browser lists and extracts from: any file the client can read. Whatever it is, an extract
// lands in the user's own drive.
export interface ArchiveSource {
	file: AnyFile
	// Also what the listing's ArchiveEntryIds name the archive by.
	uuid: UuidStr
	name: string
	size: number
	// The own directory the archive sits in (null the drive root), which "next to the archive" extracts
	// into; undefined when it has none to offer (shared with the user, linked, a chat's, in the trash).
	ownParent: string | null | undefined
}

const PSEUDO_PARENTS: ReadonlySet<string> = new Set<string>(FLAT_LISTING_KINDS)

// A shared root item's parent is itself.
function ownParentOf(uuid: string, parent: string, variant: DriveVariant, rootUuid: string): string | null | undefined {
	if (variant === "trash" || isReadOnlySharedVariant(variant) || PSEUDO_PARENTS.has(parent) || parent === uuid) {
		return undefined
	}

	return normalizeParentUuid(parent, rootUuid)
}

function fileSource(item: DriveItem, ownParent: string | null | undefined, file?: AnyFile): ArchiveSource {
	switch (item.type) {
		case "file":
		case "sharedFile":
		case "sharedRootFile":
			return {
				file: file ?? item.data,
				uuid: item.data.uuid,
				name: driveItemName(item),
				size: Number(item.data.size),
				ownParent
			}
		case "directory":
		case "sharedDirectory":
		case "sharedRootDirectory":
			throw new Error("an archive is a file")
	}
}

export function archiveSourceOf(item: DriveItem, variant: DriveVariant, rootUuid: string = currentRootUuid()): ArchiveSource {
	return fileSource(item, ownParentOf(item.data.uuid, item.data.parent, variant, rootUuid))
}

// A public link's or a chat's archive, shown through its drive-shaped stand-in: never in a directory of
// the user's own. `file` is the SDK's own linked file when the caller holds it.
export function linkedArchiveSource(item: DriveItem, file?: AnyFile): ArchiveSource {
	return fileSource(item, undefined, file)
}
