import type { UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { extensionOf } from "@/features/drive/lib/preview.logic"
import { entryKey } from "@/features/archive/lib/entryAccess.logic"

// What a blob of an image entry is served as: <img> sniffs raster formats, never SVG.
const IMAGE_MIMES: ReadonlyMap<string, string> = new Map([
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["png", "image/png"],
	["gif", "image/gif"],
	["webp", "image/webp"],
	["svg", "image/svg+xml"],
	["bmp", "image/bmp"],
	["ico", "image/x-icon"],
	["apng", "image/apng"],
	["avif", "image/avif"]
])

// An archive entry as the stand-in item the viewers take, its bytes coming from the entry's byte source
// (PreviewByteSourceProvider). Its uuid is the entry's key, so the preview cache keeps it apart from the
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
				mime: IMAGE_MIMES.get(extensionOf(name)) ?? "application/octet-stream",
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
