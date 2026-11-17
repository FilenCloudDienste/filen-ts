import type { DriveItem } from "@/features/drive/lib/item"
import { entryKey } from "@/features/archive/lib/entryAccess.logic"
import { embeddedFileItem } from "@/features/preview/lib/embeddedFileItem"

// An archive entry as the stand-in item the viewers take (embeddedFileItem), keyed by the entry's key.
export function archiveEntryItem(archiveUuid: string, index: number, name: string, size: number, modified: number): DriveItem {
	return embeddedFileItem(entryKey(archiveUuid, index), name, size, modified)
}
