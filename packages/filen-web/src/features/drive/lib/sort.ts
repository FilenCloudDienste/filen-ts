import { driveItemName, sortItems as sortItemsEngine, type SortMode, type SortEngineAccessors } from "@filen/shared"
import { isDirectoryItem, driveItemMime, lastModifiedOf, type DriveItem } from "@/features/drive/lib/item"

// Field x direction. "type" groups files by MIME (directories have none, so they fall back to
// name — see typeSortKey); the other fields are self-explanatory. Recents forces uploadDateDesc
// unconditionally (see @/features/drive/lib/preferences) and never reaches this module through a menu.
export const DRIVE_SORT_BY = [
	"nameAsc",
	"nameDesc",
	"sizeAsc",
	"sizeDesc",
	"typeAsc",
	"typeDesc",
	"uploadDateAsc",
	"uploadDateDesc",
	"lastModifiedAsc",
	"lastModifiedDesc"
] as const

export type DriveSortBy = (typeof DRIVE_SORT_BY)[number]

export type DriveSortField = "name" | "size" | "type" | "uploadDate" | "lastModified"
export type DriveSortDirection = "asc" | "desc"

// Exhaustive lookup tables instead of string-splicing "nameAsc" -> {name, asc}: a field added to
// DriveSortBy without a matching entry here fails to compile (Record<DriveSortBy, …> / Record
// <DriveSortField, Record<DriveSortDirection, …>> both require every key).
export const DRIVE_SORT_PARTS: Record<DriveSortBy, { field: DriveSortField; direction: DriveSortDirection }> = {
	nameAsc: { field: "name", direction: "asc" },
	nameDesc: { field: "name", direction: "desc" },
	sizeAsc: { field: "size", direction: "asc" },
	sizeDesc: { field: "size", direction: "desc" },
	typeAsc: { field: "type", direction: "asc" },
	typeDesc: { field: "type", direction: "desc" },
	uploadDateAsc: { field: "uploadDate", direction: "asc" },
	uploadDateDesc: { field: "uploadDate", direction: "desc" },
	lastModifiedAsc: { field: "lastModified", direction: "asc" },
	lastModifiedDesc: { field: "lastModified", direction: "desc" }
}

export const DRIVE_SORT_FROM_PARTS: Record<DriveSortField, Record<DriveSortDirection, DriveSortBy>> = {
	name: { asc: "nameAsc", desc: "nameDesc" },
	size: { asc: "sizeAsc", desc: "sizeDesc" },
	type: { asc: "typeAsc", desc: "typeDesc" },
	uploadDate: { asc: "uploadDateAsc", desc: "uploadDateDesc" },
	lastModified: { asc: "lastModifiedAsc", desc: "lastModifiedDesc" }
}

// A list column header click: another column starts ascending, the sorted one flips to descending, and a
// descending one clears (null) back to the default order.
export function nextColumnSort(current: DriveSortBy, field: DriveSortField): DriveSortBy | null {
	const parts = DRIVE_SORT_PARTS[current]

	if (parts.field !== field) {
		return DRIVE_SORT_FROM_PARTS[field].asc
	}

	return parts.direction === "asc" ? DRIVE_SORT_FROM_PARTS[field].desc : null
}

// The index-array decorate/sort/permute engine (dirs-first partitioning, the lazy name tiebreak
// inside the size branch, the bigint-through size handling, and the deterministic primary-key ->
// name -> numeric-uuid -> uuid tiebreak chain guarding against unstable refetch order) lives in
// @filen/shared's driveSortEngine — this module only supplies the mode table and the
// field-accessor functions below.

function nameSortKey(item: DriveItem): string {
	return driveItemName(item)
}

// Primary key is MIME for files (directories have none, so they use name instead) — NOT the name
// — so ties (many files sharing a MIME) are broken by name before the uuid chain (tiebreakByName
// on the sort mode below).
function typeSortKey(item: DriveItem): string {
	return driveItemMime(item) ?? driveItemName(item)
}

// Both Dir and File carry a native, server-assigned `timestamp` — the upload time — directly, so
// this needs no branching (unlike lastModified below, which reads client-supplied meta fields that
// differ per arm).
function uploadDateSortKey(item: DriveItem): number {
	return Number(item.data.timestamp)
}

function lastModifiedSortKey(item: DriveItem): number {
	return Number(lastModifiedOf(item))
}

const sortModes: Record<DriveSortBy, SortMode<DriveItem>> = {
	nameAsc: { kind: "parts", isAsc: true, stringKey: nameSortKey },
	nameDesc: { kind: "parts", isAsc: false, stringKey: nameSortKey },
	sizeAsc: { kind: "size", isAsc: true },
	sizeDesc: { kind: "size", isAsc: false },
	typeAsc: { kind: "parts", isAsc: true, stringKey: typeSortKey, tiebreakByName: true },
	typeDesc: { kind: "parts", isAsc: false, stringKey: typeSortKey, tiebreakByName: true },
	uploadDateAsc: { kind: "timestamp", isAsc: true, timestampKey: uploadDateSortKey },
	uploadDateDesc: { kind: "timestamp", isAsc: false, timestampKey: uploadDateSortKey },
	lastModifiedAsc: { kind: "timestamp", isAsc: true, timestampKey: lastModifiedSortKey },
	lastModifiedDesc: { kind: "timestamp", isAsc: false, timestampKey: lastModifiedSortKey }
}

function makeAccessors(directorySizes?: ReadonlyMap<string, number>): SortEngineAccessors<DriveItem> {
	return {
		getUuid: item => item.data.uuid,
		getSize: item => item.data.size,
		isDirectory: item => isDirectoryItem(item),
		nameKey: nameSortKey,
		...(directorySizes !== undefined ? { directorySizes } : {})
	}
}

// Directories sort before files, always (dirs-first is a partition, not a sort key — see the
// design note above). `directorySizes` lets a caller feed in real directory byte counts (keyed by
// uuid, e.g. from a size query cache) for the size modes; a directory absent from the map sorts by
// its raw synthetic 0n size and falls into the deterministic name tiebreak. Wiring real sizes in by
// default is a later enhancement — the 0n fallback is well-defined on its own.
export function sortDriveItems(items: DriveItem[], sortBy: DriveSortBy, directorySizes?: ReadonlyMap<string, number>): DriveItem[] {
	return sortItemsEngine(items, sortModes[sortBy], makeAccessors(directorySizes))
}

// The same order for rows that carry a DriveItem (a public link's browse entries), read through
// `getItem` so each key is still extracted once per row.
export function sortByDriveItem<T>(entries: T[], getItem: (entry: T) => DriveItem, sortBy: DriveSortBy): T[] {
	const mode = sortModes[sortBy]
	const { stringKey, timestampKey, tiebreakByName } = mode
	const accessors = makeAccessors()

	return sortItemsEngine(
		entries,
		{
			kind: mode.kind,
			isAsc: mode.isAsc,
			...(stringKey !== undefined ? { stringKey: (entry: T) => stringKey(getItem(entry)) } : {}),
			...(timestampKey !== undefined ? { timestampKey: (entry: T) => timestampKey(getItem(entry)) } : {}),
			...(tiebreakByName !== undefined ? { tiebreakByName } : {})
		},
		{
			getUuid: entry => accessors.getUuid(getItem(entry)),
			getSize: entry => accessors.getSize(getItem(entry)),
			isDirectory: entry => accessors.isDirectory(getItem(entry)),
			nameKey: entry => accessors.nameKey(getItem(entry))
		}
	)
}
