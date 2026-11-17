import type { UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { extensionOf } from "@/features/drive/lib/preview.logic"
import { inlineTypeForExtension } from "@/features/preview/lib/mediaType"

// A file held inside another (an archive's entry, a message's attachment) as the stand-in item the viewers take, its
// bytes coming from its own origin (PreviewByteOriginProvider). `key` is its origin's key, so the preview cache keeps it
// apart from its container; it parents itself, so no drive action takes it for an item of the drive
// (isLinkedEmbedItem), and it carries no key, region or chunk anything could read. Its type is the one the inline route
// serves its extension as (<img> sniffs raster formats, never SVG).
export function embeddedFileItem(key: string, name: string, size: number, modified: number): DriveItem {
	// Never parsed as a uuid: only compared, and only keyed by.
	const uuid = key as UuidStr
	const timestamp = BigInt(Number.isNaN(modified) ? 0 : Math.trunc(modified))

	return narrowItem({
		uuid,
		stableUUID: undefined,
		meta: {
			type: "decoded",
			data: {
				name,
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
