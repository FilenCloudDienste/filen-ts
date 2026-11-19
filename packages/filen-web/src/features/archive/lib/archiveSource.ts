import type { AnyFile } from "@filen/sdk-rs"
import { nestedTarget, nestedUuid, type NestedSource, type ReaderTarget } from "@/features/archive/lib/archiveReaders"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import { driveItemName } from "@filen/shared"
import { currentRootUuid } from "@/features/drive/lib/actions"
import { FLAT_LISTING_KINDS } from "@/features/drive/lib/flatListing"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { normalizeParentUuid } from "@/features/drive/queries/drive"
import { isReadOnlySharedVariant } from "@/features/drive/lib/share/gating"

// The archive a browser lists and extracts from: any file the client can read. Whatever it is, an extract
// lands in the user's own drive.
export interface ArchiveSource extends ReaderTarget {
	// The drive or public link file the archive is, or the outermost one holding it (a nested archive's).
	file: AnyFile
	// Also what the page's ArchiveEntryIds name the archive by (the worker maps a nested one's to the SDK's).
	uuid: string
	name: string
	size: number
	// A public link's file: read through the public-link client, never the session's.
	anon: boolean
	// An archive inside another's entry; null for a file's own.
	nested: NestedSource | null
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

function fileSource(item: DriveItem, ownParent: string | null | undefined, anon: boolean, file?: AnyFile): ArchiveSource {
	switch (item.type) {
		case "file":
		case "sharedFile":
		case "sharedRootFile":
			return {
				file: file ?? item.data,
				uuid: item.data.uuid,
				name: driveItemName(item),
				size: Number(item.data.size),
				anon,
				nested: null,
				ownParent
			}
		case "directory":
		case "sharedDirectory":
		case "sharedRootDirectory":
			throw new Error("an archive is a file")
	}
}

export function archiveSourceOf(item: DriveItem, variant: DriveVariant, rootUuid: string = currentRootUuid()): ArchiveSource {
	return fileSource(item, ownParentOf(item.data.uuid, item.data.parent, variant, rootUuid), false)
}

// A public link's or a chat's archive, shown through its drive-shaped stand-in: never in a directory of
// the user's own. `file` is the SDK's own linked file when the caller holds it.
export function linkedArchiveSource(item: DriveItem, file?: AnyFile): ArchiveSource {
	return fileSource(item, undefined, true, file)
}

// The archive held in the entry `slot` of `parent`'s listing (opened with `parentPassword`), browsed in its
// place; null past MAX_NESTED_DEPTH. Never extracted from (no drive file of its own), and nowhere to extract next to.
export function nestedArchiveSource(
	parent: ArchiveSource,
	parentPassword: string | undefined,
	store: EntryStore,
	slot: number
): ArchiveSource | null {
	const index = store.index(slot)
	const nested = nestedTarget(parent, parentPassword, index)

	return nested === null
		? null
		: {
				file: parent.file,
				uuid: nestedUuid(parent, index),
				name: store.name(slot),
				size: Math.max(0, store.size(slot)),
				anon: parent.anon,
				nested,
				ownParent: undefined
			}
}
