import {
	estimateCaptureTimestamp,
	getUuidNumber,
	clearNaturalSortCaches,
	driveItemName,
	sortItems as sortItemsEngine,
	type SortMode,
	type SortEngineAccessors
} from "@filen/shared"
import { type DriveItem, type Note, type NoteTag } from "@/types"
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
	ts: number
	note: NoteItem
}

// Hoisted bucket comparator over the precomputed per-note timestamp — the previous
// per-group() closure recomputed Number(editedTimestamp ?? createdTimestamp) twice per
// comparison in every bucket sort.
function sortBucketEntriesDesc(a: GroupBucketEntry, b: GroupBucketEntry): number {
	return b.ts - a.ts
}

function group({
	notes,
	groupPinned,
	groupFavorited,
	groupArchived,
	groupTrashed,
	tag
}: {
	notes: (
		| Note
		| (Note & {
				content?: string
		  })
	)[]
	groupPinned?: boolean
	groupFavorited?: boolean
	groupArchived?: boolean
	groupTrashed?: boolean
	tag?: NoteTag
}): NoteListItem[] {
	if (tag) {
		notes = notes.filter(note => note.tags.some(t => t.uuid === tag.uuid))
	}

	const now = Date.now()
	const result: NoteListItem[] = []
	const todayMs = 24 * 60 * 60 * 1000
	const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
	const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
	const todayAgo = now - todayMs
	const sevenDaysAgo = now - sevenDaysMs
	const thirtyDaysAgo = now - thirtyDaysMs
	const nowDate = new Date(now)
	const currentYear = nowDate.getFullYear()
	const currentMonth = nowDate.getMonth()
	const twoMonthsAgo = new Date(currentYear, currentMonth - 2, nowDate.getDate()).getTime()
	const today: GroupBucketEntry[] = []
	const last7Days: GroupBucketEntry[] = []
	const last30Days: GroupBucketEntry[] = []
	const previousMonth: GroupBucketEntry[] = []
	const trashed: GroupBucketEntry[] = []
	const archived: GroupBucketEntry[] = []
	const pinned: GroupBucketEntry[] = []
	const favorited: GroupBucketEntry[] = []
	const yearBuckets: {
		[year: number]: GroupBucketEntry[]
	} = {}

	const len = notes.length

	for (let i = 0; i < len; i++) {
		const note = notes[i]

		if (!note) {
			continue
		}

		// One timestamp per note, shared by the bucket thresholds AND the per-bucket
		// sorts — the previous shape discarded this value after bucketing (and never
		// computed it for the special buckets) only to recompute it per comparison.
		const entry: GroupBucketEntry = {
			ts: Number(note.editedTimestamp ?? note.createdTimestamp),
			note
		}

		if (groupTrashed && note.trash) {
			trashed.push(entry)

			continue
		}

		if (groupArchived && note.archive) {
			archived.push(entry)

			continue
		}

		if (groupPinned && note.pinned) {
			pinned.push(entry)

			continue
		}

		if (groupFavorited && note.favorite) {
			favorited.push(entry)

			continue
		}

		if (entry.ts >= todayAgo) {
			today.push(entry)
		} else if (entry.ts >= sevenDaysAgo) {
			last7Days.push(entry)
		} else if (entry.ts >= thirtyDaysAgo) {
			last30Days.push(entry)
		} else if (entry.ts >= twoMonthsAgo) {
			previousMonth.push(entry)
		} else {
			const year = new Date(entry.ts).getFullYear()

			if (!yearBuckets[year]) {
				yearBuckets[year] = []
			}

			yearBuckets[year].push(entry)
		}
	}

	const emitBucket = (bucket: GroupBucketEntry[], header: NoteListItem): void => {
		bucket.sort(sortBucketEntriesDesc)

		result.push(header)

		for (let i = 0; i < bucket.length; i++) {
			const entry = bucket[i]

			if (!entry) {
				continue
			}

			result.push({
				...entry.note,
				type: "note"
			})
		}
	}

	if (groupPinned && pinned.length > 0) {
		emitBucket(pinned, {
			type: "header",
			id: "header-pinned",
			title: i18n.t("pinned"),
			icon: "pin-outline"
		})
	}

	if (groupFavorited && favorited.length > 0) {
		emitBucket(favorited, {
			type: "header",
			id: "header-favorited",
			title: i18n.t("favorited"),
			icon: "heart-outline"
		})
	}

	if (today.length > 0) {
		emitBucket(today, {
			type: "header",
			id: "header-today",
			title: i18n.t("today"),
			icon: "today-outline"
		})
	}

	if (last7Days.length > 0) {
		emitBucket(last7Days, {
			type: "header",
			id: "header-7days",
			title: i18n.t("previous_7_days"),
			icon: "calendar-outline"
		})
	}

	if (last30Days.length > 0) {
		emitBucket(last30Days, {
			type: "header",
			id: "header-30days",
			title: i18n.t("previous_30_days"),
			icon: "calendar-outline"
		})
	}

	if (previousMonth.length > 0) {
		const date = new Date(twoMonthsAgo)

		emitBucket(previousMonth, {
			type: "header",
			id: "header-month",
			title: monthFormatter().format(date),
			icon: "calendar-outline"
		})
	}

	const years = Object.keys(yearBuckets)
		.map(Number)
		.sort((a, b) => b - a)

	for (let i = 0; i < years.length; i++) {
		const year = years[i]

		if (year === undefined) {
			continue
		}

		const yearNotes = yearBuckets[year]

		if (!yearNotes) {
			continue
		}

		emitBucket(yearNotes, {
			type: "header",
			id: `header-${year}`,
			title: year.toString(),
			icon: "calendar-outline"
		})
	}

	if (archived.length > 0) {
		emitBucket(archived, {
			type: "header",
			id: "header-archived",
			title: i18n.t("archived"),
			icon: "archive-outline"
		})
	}

	if (trashed.length > 0) {
		emitBucket(trashed, {
			type: "header",
			id: "header-trashed",
			title: i18n.t("trashed"),
			icon: "trash-outline"
		})
	}

	return result
}

export const notesSorter = { sort, group }
