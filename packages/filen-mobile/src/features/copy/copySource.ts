import { AnyItemWithContext, AnyItemWithContext_Tags, type CopyEntry } from "@filen/sdk-rs"
import type { DriveItem } from "@/types"
import { driveItemToAnyDirWithContext, driveItemToAnyFile } from "@/lib/sdkSources"
import type { CopyJobGlyph } from "@/features/copy/copyAdapter"

// A drive item as the SDK copies it: the file itself, or the directory with the share context it is
// listed under. Linked sources (public links) arrive already built.
export function driveItemToCopyItem(item: DriveItem): AnyItemWithContext {
	switch (item.type) {
		case "file":
		case "sharedFile":
		case "sharedRootFile": {
			const file = driveItemToAnyFile(item)

			if (!file) {
				throw new Error("Invalid item type")
			}

			return new AnyItemWithContext.File(file)
		}

		case "directory":
		case "sharedDirectory":
		case "sharedRootDirectory": {
			return new AnyItemWithContext.Dir(driveItemToAnyDirWithContext(item))
		}
	}
}

export function copyGlyphForItems(items: readonly DriveItem[]): CopyJobGlyph {
	const [only] = items

	if (only === undefined || items.length > 1) {
		return "items"
	}

	return only.type === "directory" || only.type === "sharedDirectory" || only.type === "sharedRootDirectory" ? "directory" : "file"
}

export function copyGlyphForCopyItems(items: readonly AnyItemWithContext[]): CopyJobGlyph {
	const [only] = items

	if (only === undefined || items.length > 1) {
		return "items"
	}

	return only.tag === AnyItemWithContext_Tags.Dir ? "directory" : "file"
}

export function copyGlyphForEntries(entries: readonly CopyEntry[]): CopyJobGlyph {
	const [only] = entries

	if (only === undefined || entries.length > 1) {
		return "items"
	}

	return only.item.tag === AnyItemWithContext_Tags.Dir ? "directory" : "file"
}
