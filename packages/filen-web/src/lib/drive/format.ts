import { formatBytes } from "@filen/utils"
import { asDirectoryOrFile, type DriveItem } from "@/lib/drive/item"

// Directories carry no real size on the item itself (synthetic 0n — see narrowItem in
// @/lib/drive/item), so the size column is blank for them rather than showing "0 B". A shared file
// reads as a file, a shared directory as a directory (asDirectoryOrFile).
export function formatItemSize(item: DriveItem): string {
	const base = asDirectoryOrFile(item)
	return base.type === "file" ? formatBytes(Number(base.data.size)) : ""
}

function formatTimestamp(timestamp: bigint): string {
	return new Date(Number(timestamp)).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

// Mirrors sort.ts's lastModifiedSortKey field resolution exactly, so the displayed date always
// matches what sorting by "last modified" actually orders by. Routed through asDirectoryOrFile so a
// file arm's decryptedMeta (with `modified`) and a directory arm's (with `created`) each resolve
// against the correctly-typed meta, shared arms included.
export function formatModifiedDate(item: DriveItem): string {
	const base = asDirectoryOrFile(item)
	const timestamp =
		base.type === "file"
			? (base.data.decryptedMeta?.modified ?? base.data.timestamp)
			: (base.data.decryptedMeta?.created ?? base.data.timestamp)

	return formatTimestamp(timestamp)
}

// The info panel's own "Created" row: both item types carry an OPTIONAL `created` field on their
// decrypted meta (a file's `created` is optional, unlike its required `modified`), falling back to
// the item's own raw timestamp — same fallback formatModifiedDate uses for a directory with no
// `created` field, so an item missing this field never renders a blank/undefined date.
export function formatCreatedDate(item: DriveItem): string {
	return formatTimestamp(item.data.decryptedMeta?.created ?? item.data.timestamp)
}

// The versions panel's own per-row label. Unlike formatModifiedDate/formatCreatedDate this includes
// the time of day: a file's version history can carry several entries from the same calendar day
// (autosave, rapid re-uploads), where a date-only label would leave them indistinguishable.
export function formatVersionTimestamp(timestamp: bigint): string {
	return new Date(Number(timestamp)).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}
