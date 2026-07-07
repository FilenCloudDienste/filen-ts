import { formatBytes } from "@filen/utils"
import { type DriveItem } from "@/lib/drive/item"

// Directories carry no real size on the item itself (synthetic 0n — see narrowItem in
// @/lib/drive/item), so the size column is blank for them rather than showing "0 B".
export function formatItemSize(item: DriveItem): string {
	return item.type === "file" ? formatBytes(Number(item.data.size)) : ""
}

// Mirrors sort.ts's lastModifiedSortKey field resolution exactly, so the displayed date always
// matches what sorting by "last modified" actually orders by.
export function formatModifiedDate(item: DriveItem): string {
	const timestamp =
		item.type === "file"
			? (item.data.decryptedMeta?.modified ?? item.data.timestamp)
			: (item.data.decryptedMeta?.created ?? item.data.timestamp)

	return new Date(Number(timestamp)).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}
