import type { File as SdkFile, LinkedDir, LinkedDirsAndFiles, AnyLinkedDir, DirPublicInfo } from "@filen/sdk-rs"
import { driveItemName } from "@filen/shared"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { DRIVE_SORT_FROM_PARTS, sortByDriveItem, type DriveSortField } from "@/features/drive/lib/sort"

// Pure client-side model for browsing a linked directory. Navigation is a VIRTUAL stack (old-web
// parity): entering a subfolder pushes a crumb, breadcrumb clicks truncate it — the route's own uuid
// and URL fragment never change, so the decryption key and any verified password stay in memory for
// the whole session. Nothing here is async or React; the browse view drives every list/filter/sort
// decision through these transforms so they stay directly unit-testable.

// One navigable level. `dir` is the SDK handle the listing/size/zip calls want (a LinkedRootDir for the
// root crumb, a LinkedDir for every subfolder) — both are AnyLinkedDir. `name`/`uuid` are display only.
export interface BrowseCrumb {
	uuid: string
	name: string
	dir: AnyLinkedDir
}

// A listing row, pre-narrowed to a DriveItem so the SAME icon/name/size/date helpers the authed drive
// listing uses render it with no per-row branching. The raw SDK handle is kept alongside: `dir` for a
// deeper listing, `file` as the AnyFile a download/preview op wants.
export type BrowseEntry = { kind: "dir"; item: DriveItem; dir: LinkedDir } | { kind: "file"; item: DriveItem; file: SdkFile }

export type PublicSortField = "name" | "size" | "date"
export type SortDirection = "asc" | "desc"

export interface PublicSort {
	field: PublicSortField
	direction: SortDirection
}

// Name ascending — the drive's own default. Directories always precede files regardless (see sortEntries).
export const DEFAULT_PUBLIC_SORT: PublicSort = { field: "name", direction: "asc" }

// Root crumb from the resolved link info: the linked root dir plus its decrypted name (uuid fallback
// for a still-encrypted meta, mirroring the resource resolver).
export function rootCrumb(info: DirPublicInfo): BrowseCrumb {
	const meta = info.root.inner.meta

	return {
		uuid: info.root.inner.uuid,
		name: meta.type === "decoded" ? meta.data.name : info.root.inner.uuid,
		dir: info.root
	}
}

// Push a subfolder crumb onto the stack (returns a new array — never mutates).
export function enterCrumb(stack: readonly BrowseCrumb[], entry: Extract<BrowseEntry, { kind: "dir" }>): BrowseCrumb[] {
	return [...stack, { uuid: entry.item.data.uuid, name: entryName(entry), dir: entry.dir }]
}

// Truncate the stack to a breadcrumb the user clicked (keeps indices 0..index). An out-of-range index
// leaves the stack unchanged rather than emptying it — a stale click never strands the view above root.
export function jumpToCrumb(stack: readonly BrowseCrumb[], index: number): BrowseCrumb[] {
	if (index < 0 || index >= stack.length) {
		return [...stack]
	}

	return stack.slice(0, index + 1)
}

// Narrow a raw listing into display entries. Every dir/file goes through the same narrowItem the owned
// drive listing uses, so icon/name/size/date read identically; the raw SDK handle rides alongside.
export function toBrowseEntries(listing: LinkedDirsAndFiles): BrowseEntry[] {
	const dirs: BrowseEntry[] = listing.dirs.map(dir => ({ kind: "dir", item: narrowItem(dir.inner), dir }))
	const files: BrowseEntry[] = listing.files.map(file => ({ kind: "file", item: narrowItem(file), file }))

	return [...dirs, ...files]
}

export function entryName(entry: BrowseEntry): string {
	return driveItemName(entry.item)
}

// Case-insensitive substring filter over the current level's already-fetched entries — no server round
// trip (old-web parity). A blank/whitespace query returns the list unchanged.
export function filterEntries(entries: readonly BrowseEntry[], query: string): BrowseEntry[] {
	const needle = query.trim().toLowerCase()

	if (needle.length === 0) {
		return [...entries]
	}

	return entries.filter(entry => entryName(entry).toLowerCase().includes(needle))
}

// The drive listing's own order (@/features/drive/lib/sort): directories before files, the chosen field
// within each group, and the same deterministic tie order. A directory has no cheap size at this layer
// (getDirSize is a separate call), so a size sort orders directories by name alone.
const DRIVE_SORT_FIELD: Record<PublicSortField, DriveSortField> = { name: "name", size: "size", date: "lastModified" }

export function sortEntries(entries: readonly BrowseEntry[], sort: PublicSort): BrowseEntry[] {
	return sortByDriveItem([...entries], entry => entry.item, DRIVE_SORT_FROM_PARTS[DRIVE_SORT_FIELD[sort.field]][sort.direction])
}
