import {
	estimateCaptureTimestamp,
	getUuidNumber,
	clearNaturalSortCaches,
	driveItemName,
	sortItems as sortItemsEngine,
	partitionNotesByBucket,
	type NoteBucketId,
	type SortMode,
	type SortEngineAccessors
} from "@filen/shared"
import { type DriveItem, type Note } from "@/types"
import type { ListItem as NoteListItem, Item as NoteItem } from "@/features/notes/components/note"
import i18n from "@/lib/i18n"
import { intlLanguage } from "@/lib/time"

// Constructing an Intl.DateTimeFormat is ~98% of the cost of formatting one date with it (measured
// 21.6µs vs 0.32µs), and this one sat inside the notes grouping pass — which re-runs on every
// keystroke in the notes search bar, every note socket event and every refetch. Keyed on the live
// `intlLanguage` (a mutable module binding that setIntlLanguage reassigns) so a language change still
// takes effect on the next call, mirroring how time.ts invalidates its own cachedLocaleInfo.
let cachedMonthFormatter: { language: string; formatter: Intl.DateTimeFormat } | null = null

function monthFormatter(): Intl.DateTimeFormat {
	if (cachedMonthFormatter && cachedMonthFormatter.language === intlLanguage) {
		return cachedMonthFormatter.formatter
	}

	const formatter = new Intl.DateTimeFormat(intlLanguage, {
		month: "long"
	})

	cachedMonthFormatter = {
		language: intlLanguage,
		formatter
	}

	return formatter
}

export type SortByType =
	| "nameAsc"
	| "sizeAsc"
	| "mimeAsc"
	| "lastModifiedAsc"
	| "nameDesc"
	| "sizeDesc"
	| "mimeDesc"
	| "lastModifiedDesc"
	| "uploadDateAsc"
	| "uploadDateDesc"
	| "creationAsc"
	| "creationDesc"
	| "captureAsc"
	| "captureDesc"

// Delegate kept so the existing logout wiring (src/lib/auth.ts) is untouched.
export function clearSortCaches(): void {
	clearNaturalSortCaches()
}

function isDirectoryType(type: string): boolean {
	return type === "directory" || type === "sharedDirectory" || type === "sharedRootDirectory"
}

// The index-array decorate/sort/permute engine (dirs-first partitioning, the lazy name
// tiebreak inside the size branch, the bigint-through size handling, and the deterministic
// primary-key → name → numeric-uuid → uuid tiebreak chain guarding against unstable
// refetch order, #49) lives in @filen/shared's driveSortEngine — this module only supplies
// the mode table and the field-accessor functions below.

function nameSortKey(item: DriveItem): string {
	return driveItemName(item)
}

function mimeSortKey(item: DriveItem): string {
	return item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile"
		? (item.data.decryptedMeta?.mime ?? driveItemName(item))
		: driveItemName(item)
}

function uploadDateSortKey(item: DriveItem): number {
	return Number(
		item.type === "file"
			? item.data.timestamp
			: item.type === "directory"
				? item.data.timestamp
				: item.type === "sharedFile" || item.type === "sharedRootFile"
					? (item.data.decryptedMeta?.created ?? item.data.decryptedMeta?.modified ?? 0)
					: (item.data.decryptedMeta?.created ?? 0)
	)
}

function lastModifiedSortKey(item: DriveItem): number {
	return Number(
		item.type === "file"
			? (item.data.decryptedMeta?.modified ?? item.data.timestamp)
			: item.type === "directory"
				? (item.data.decryptedMeta?.created ?? item.data.timestamp)
				: item.type === "sharedFile" || item.type === "sharedRootFile"
					? (item.data.decryptedMeta?.modified ?? item.data.decryptedMeta?.created ?? 0)
					: (item.data.decryptedMeta?.created ?? 0)
	)
}

function creationSortKey(item: DriveItem): number {
	return Number(
		item.type === "file"
			? (item.data.decryptedMeta?.created ?? item.data.timestamp)
			: item.type === "directory"
				? (item.data.decryptedMeta?.created ?? item.data.timestamp)
				: item.type === "sharedFile" || item.type === "sharedRootFile"
					? (item.data.decryptedMeta?.created ?? item.data.decryptedMeta?.modified ?? 0)
					: (item.data.decryptedMeta?.created ?? 0)
	)
}

// Best-effort capture time (ms) for the photos timeline — see @filen/shared's
// estimateCaptureTimestamp for the floor/ceiling/min-of-candidates rationale. Non-file,
// non-shared arms have no capture concept and fall back to creationSortKey; shared items
// carry no server upload timestamp, so the ceiling is unbounded and a fully-disqualified
// estimate (non-finite) also falls back to creationSortKey.
//
// Exported because it is ALSO the display date for the photos grid — the floating date
// chip must label rows with the same timestamp the timeline is ordered by (#43), or
// clamped-away garbage dates (epoch-zero `created`) resurface in the UI.
export function captureTimestamp(item: DriveItem): number {
	const isFile = item.type === "file"

	if (!isFile && item.type !== "sharedFile" && item.type !== "sharedRootFile") {
		return creationSortKey(item)
	}

	const uploaded = isFile ? Number(item.data.timestamp) : Number.POSITIVE_INFINITY
	const estimate = estimateCaptureTimestamp(uploaded, item.data.decryptedMeta?.created, item.data.decryptedMeta?.modified)

	return Number.isFinite(estimate) ? estimate : creationSortKey(item)
}

const sortModes: Record<string, SortMode<DriveItem>> = {
	nameAsc: { kind: "parts", isAsc: true, stringKey: nameSortKey },
	nameDesc: { kind: "parts", isAsc: false, stringKey: nameSortKey },
	sizeAsc: { kind: "size", isAsc: true },
	sizeDesc: { kind: "size", isAsc: false },
	mimeAsc: { kind: "parts", isAsc: true, stringKey: mimeSortKey, tiebreakByName: true },
	mimeDesc: { kind: "parts", isAsc: false, stringKey: mimeSortKey, tiebreakByName: true },
	lastModifiedAsc: { kind: "timestamp", isAsc: true, timestampKey: lastModifiedSortKey },
	lastModifiedDesc: { kind: "timestamp", isAsc: false, timestampKey: lastModifiedSortKey },
	uploadDateAsc: { kind: "timestamp", isAsc: true, timestampKey: uploadDateSortKey },
	uploadDateDesc: { kind: "timestamp", isAsc: false, timestampKey: uploadDateSortKey },
	creationAsc: { kind: "timestamp", isAsc: true, timestampKey: creationSortKey },
	creationDesc: { kind: "timestamp", isAsc: false, timestampKey: creationSortKey },
	captureAsc: { kind: "timestamp", isAsc: true, timestampKey: captureTimestamp },
	captureDesc: { kind: "timestamp", isAsc: false, timestampKey: captureTimestamp }
}

const FALLBACK_SORT_MODE = sortModes["nameAsc"] as SortMode<DriveItem>

export type SortItemsOptions = {
	// Real directory sizes (bytes) keyed by directory uuid, fed in by the drive screen from the
	// useDirectorySizeQuery cache (the same values the rows display). Directories are constructed
	// with `data.size: 0n` (sdkUnwrap), so without this the size modes cannot order them at all
	// (#49). Directories missing from the map sort as their raw `data.size` (0n) and fall into the
	// deterministic name tiebreak.
	directorySizes?: ReadonlyMap<string, number>
}

function makeSortAccessors<T extends DriveItem>(directorySizes?: ReadonlyMap<string, number>): SortEngineAccessors<T> {
	return {
		getUuid: item => item.data.uuid,
		getSize: item => item.data.size,
		isDirectory: item => isDirectoryType(item.type),
		nameKey: nameSortKey,
		...(directorySizes !== undefined ? { directorySizes } : {})
	}
}

function sortItems<T extends DriveItem>(items: T[], type: SortByType, options?: SortItemsOptions): T[] {
	const mode = (sortModes[type] ?? FALLBACK_SORT_MODE) as SortMode<T>

	return sortItemsEngine(items, mode, makeSortAccessors<T>(options?.directorySizes))
}

export const itemSorter = { sortItems }

type SortableNote =
	| Note
	| (Note & {
			content?: string
	  })

type NoteSortEntry = {
	note: SortableNote
	// Composite bucket: pinned-first then trash/archive tier, folded into ONE integer —
	// pinned notes occupy 0..2, unpinned 3..5, tier (none 0 / archive 1 / trash 2) adds
	// within each half. Ordering ascending by this bucket is EXACTLY the previous
	// pinned-then-tier branch pair.
	bucket: number
	key: number
	// Raw editedTimestamp for the EQUALITY check: the uuid tiebreaker fires on raw
	// identity (bigint === bigint, and undefined === undefined for never-edited notes —
	// pinned by the hardening suite), NOT on Number() equality.
	raw: bigint | undefined
}

function compareNoteEntries(a: NoteSortEntry, b: NoteSortEntry): number {
	if (a.bucket !== b.bucket) {
		return a.bucket - b.bucket
	}

	if (a.raw === b.raw) {
		return getUuidNumber(b.note.uuid) - getUuidNumber(a.note.uuid)
	}

	return b.key - a.key
}

function sort(notes: SortableNote[]): SortableNote[] {
	const length = notes.length
	const wrapped: NoteSortEntry[] = new Array(length)

	for (let i = 0; i < length; i++) {
		const note = notes[i] as SortableNote

		// Keys once per note — the previous comparator allocated a `tier` closure and
		// paid Number(bigint) twice per COMPARISON.
		wrapped[i] = {
			note,
			bucket: (note.pinned ? 0 : 3) + (note.trash ? 2 : note.archive ? 1 : 0),
			key: Number(note.editedTimestamp),
			raw: note.editedTimestamp
		}
	}

	wrapped.sort(compareNoteEntries)

	const result: SortableNote[] = new Array(length)

	for (let i = 0; i < length; i++) {
		result[i] = (wrapped[i] as NoteSortEntry).note
	}

	return result
}

type GroupBucketEntry = {
	id: string
	pinned: boolean
	favorite: boolean
	archive: boolean
	trash: boolean
	ts: number
	note: NoteItem
}

// Hoisted bucket comparator over the precomputed per-note timestamp — the previous
// per-group() closure recomputed Number(editedTimestamp ?? createdTimestamp) twice per
// comparison in every bucket sort. No uuid tiebreak, matching this app's existing order.
function sortBucketEntriesDesc(a: GroupBucketEntry, b: GroupBucketEntry): number {
	return b.ts - a.ts
}

// Resolves the shared core's abstract bucket id into this app's translated header row — the
// presentation layer the shared classification core deliberately excludes.
function headerForBucket(bucketId: NoteBucketId): NoteListItem {
	if (bucketId === "pinned") {
		return { type: "header", id: "header-pinned", title: i18n.t("pinned"), icon: "pin-outline" }
	}

	if (bucketId === "favorited") {
		return { type: "header", id: "header-favorited", title: i18n.t("favorited"), icon: "heart-outline" }
	}

	if (bucketId === "today") {
		return { type: "header", id: "header-today", title: i18n.t("today"), icon: "today-outline" }
	}

	if (bucketId === "previous7Days") {
		return { type: "header", id: "header-7days", title: i18n.t("previous_7_days"), icon: "calendar-outline" }
	}

	if (bucketId === "previous30Days") {
		return { type: "header", id: "header-30days", title: i18n.t("previous_30_days"), icon: "calendar-outline" }
	}

	if (bucketId === "archived") {
		return { type: "header", id: "header-archived", title: i18n.t("archived"), icon: "archive-outline" }
	}

	if (bucketId === "trashed") {
		return { type: "header", id: "header-trashed", title: i18n.t("trashed"), icon: "trash-outline" }
	}

	if (bucketId.kind === "month") {
		return {
			type: "header",
			id: "header-month",
			title: monthFormatter().format(new Date(bucketId.monthTimestamp)),
			icon: "calendar-outline"
		}
	}

	return {
		type: "header",
		id: `header-${bucketId.year}`,
		title: bucketId.year.toString(),
		icon: "calendar-outline"
	}
}

// Pinned/favorited/archived/trashed are always their own tier (the app's single production
// caller always wants all four — see @filen/shared's partitionNotesByBucket); tag pre-filtering
// now lives with this function's caller, which already has the tag in hand.
function group(
	notes: (
		| Note
		| (Note & {
				content?: string
		  })
	)[]
): NoteListItem[] {
	const now = Date.now()
	const entries: GroupBucketEntry[] = new Array(notes.length)

	for (let i = 0; i < notes.length; i++) {
		const note = notes[i] as Note

		entries[i] = {
			id: note.uuid,
			pinned: note.pinned,
			favorite: note.favorite,
			archive: note.archive,
			trash: note.trash,
			ts: Number(note.editedTimestamp ?? note.createdTimestamp),
			note
		}
	}

	const buckets = partitionNotesByBucket(entries, now, sortBucketEntriesDesc)
	const result: NoteListItem[] = []

	for (const bucket of buckets) {
		result.push(headerForBucket(bucket.bucketId))

		for (const entry of bucket.notes) {
			result.push({
				...entry.note,
				type: "note"
			})
		}
	}

	return result
}

export const notesSorter = { sort, group }
