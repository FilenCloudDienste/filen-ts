import { driveItemName, sortItems as sortItemsEngine, type SortMode, type SortEngineAccessors } from "@filen/shared"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"

// Field x direction. "type" groups files by MIME (directories have none, so they fall back to
// name — see typeSortKey); the other fields are self-explanatory. Recents forces uploadDateDesc
// unconditionally (see @/features/drive/lib/preferences) and never reaches this module through a menu.
export type DriveSortBy =
	| "nameAsc"
	| "nameDesc"
	| "sizeAsc"
	| "sizeDesc"
	| "typeAsc"
	| "typeDesc"
	| "uploadDateAsc"
	| "uploadDateDesc"
	| "lastModifiedAsc"
	| "lastModifiedDesc"

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
	const base = asDirectoryOrFile(item)
	return base.type === "file" ? (base.data.decryptedMeta?.mime ?? driveItemName(base)) : nameSortKey(item)
}

// Both Dir and File carry a native, server-assigned `timestamp` — the upload time — directly, so
// this needs no branching (unlike lastModified below, which reads client-supplied meta fields that
// differ per arm).
function uploadDateSortKey(item: DriveItem): number {
	return Number(item.data.timestamp)
}

function lastModifiedSortKey(item: DriveItem): number {
	const base = asDirectoryOrFile(item)
	return Number(
		base.type === "file"
			? (base.data.decryptedMeta?.modified ?? base.data.timestamp)
			: (base.data.decryptedMeta?.created ?? base.data.timestamp)
	)
}

const sortModes: Record<string, SortMode<DriveItem>> = {
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

function requiredSortMode(key: string): SortMode<DriveItem> {
	const mode = sortModes[key]

	if (mode === undefined) {
		throw new Error(`sort.ts: missing sort mode "${key}"`)
	}

	return mode
}

const FALLBACK_SORT_MODE = requiredSortMode("nameAsc")

function makeAccessors(directorySizes?: ReadonlyMap<string, number>): SortEngineAccessors<DriveItem> {
	return {
		getUuid: item => item.data.uuid,
		getSize: item => item.data.size,
		isDirectory: item => asDirectoryOrFile(item).type === "directory",
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
	const mode = sortModes[sortBy] ?? FALLBACK_SORT_MODE

	return sortItemsEngine(items, mode, makeAccessors(directorySizes))
}
