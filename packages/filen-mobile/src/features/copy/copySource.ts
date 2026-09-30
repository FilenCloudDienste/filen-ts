import { AnyItemWithContext, AnyItemWithContext_Tags } from "@filen/sdk-rs"
import { copyJobGlyph, type CopyJobGlyph } from "@filen/shared"
import type { DriveItem } from "@/types"
import { driveItemToAnyDirWithContext, driveItemToAnyFile } from "@/lib/sdkSources"

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

// Takes the count and the first item so a retry's entries need no mapped array.
export function copyGlyph(itemCount: number, first: AnyItemWithContext | undefined): CopyJobGlyph {
	return copyJobGlyph(itemCount, first?.tag === AnyItemWithContext_Tags.Dir)
}
