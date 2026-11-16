import type { UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { extensionOf } from "@/features/drive/lib/preview.logic"
import { entryKey } from "@/features/archive/lib/entryAccess.logic"
import { inlineTypeForExtension } from "@/features/preview/lib/mediaType"

// An archive entry as the stand-in item the viewers take, its bytes coming from the entry's origin
// (PreviewByteOriginProvider). Its uuid is the entry's key, so the preview cache keeps it apart from the
// archive itself; it parents itself, so no drive action takes it for an item of the drive
// (isLinkedEmbedItem), and it carries no key, region or chunk anything could read.
export function archiveEntryItem(archiveUuid: string, index: number, name: string, size: number, modified: number): DriveItem {
	// Never parsed as a uuid: only compared, and only keyed by.
	const uuid = entryKey(archiveUuid, index) as UuidStr
	const timestamp = BigInt(Number.isNaN(modified) ? 0 : Math.trunc(modified))

	return narrowItem({
		uuid,
		stableUUID: undefined,
		meta: {
			type: "decoded",
			data: {
				name,
				// What a blob of the entry is served as: <img> sniffs raster formats, never SVG.
				mime: inlineTypeForExtension(extensionOf(name)) ?? "application/octet-stream",
				size: BigInt(size),
				version: 2,
				key: "",
				modified: timestamp
			}
		},
		parent: uuid,
		size: BigInt(size),
		favorited: false,
		region: "",
		bucket: "",
		timestamp,
		chunks: 0n,
		canMakeThumbnail: false
	})
}
