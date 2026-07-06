import { parseNumbersFromString } from "@filen/utils"
import { type DriveItem, type Note, type NoteTag } from "@/types"
import type { ListItem as NoteListItem, Item as NoteItem } from "@/features/notes/components/note"
import i18n from "@/lib/i18n"
import { intlLanguage } from "@/lib/time"

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

const uuidCache = new Map<string, number>()
const lowerCache = new Map<string, string>()
const numericPartsCache = new Map<string, (string | number)[]>()

function getUuidNumber(uuid: string): number {
	let cached = uuidCache.get(uuid)

	if (cached === undefined) {
		cached = parseNumbersFromString(uuid)

		uuidCache.set(uuid, cached)
	}

	return cached
}

function getLowerName(name: string): string {
	let cached = lowerCache.get(name)

	if (cached === undefined) {
		cached = name.toLowerCase()

		lowerCache.set(name, cached)
	}

	return cached
}

function getNumericParts(str: string): (string | number)[] {
	let cached = numericPartsCache.get(str)

	if (!cached) {
		cached = []

		// Run-sliced scan: the previous shape extracted a 1-char string per character
		// (str[i]) and grew accumulator strings char-by-char — O(length) string
		// allocations per UNCACHED name. Runs are detected via charCodeAt only and
		// materialized with ONE slice each; digit runs keep parseInt so numeric
		// semantics (incl. precision rounding of absurdly long digit runs) stay
		// byte-identical to the previous implementation.
		const length = str.length
		let runStart = 0
		let runIsDigit = false
		let hasRun = false

		for (let i = 0; i < length; i++) {
			const code = str.charCodeAt(i)
			const isDigit = code >= 48 && code <= 57

			if (!hasRun) {
				hasRun = true
				runIsDigit = isDigit
				runStart = i

				continue
			}

			if (isDigit !== runIsDigit) {
				cached.push(runIsDigit ? parseInt(str.slice(runStart, i), 10) : str.slice(runStart, i))

				runStart = i
				runIsDigit = isDigit
			}
		}

		if (hasRun) {
			cached.push(runIsDigit ? parseInt(str.slice(runStart), 10) : str.slice(runStart))
		}

		numericPartsCache.set(str, cached)
	}

	return cached
}

function comparePartsNumeric(aParts: (string | number)[], bParts: (string | number)[]): number {
	// Identical strings resolve to the SAME cached parts array (numericPartsCache), so
	// reference equality short-circuits the whole walk — this makes tie-dense comparisons
	// (same mime across a group, duplicated names) O(1) instead of O(parts).
	if (aParts === bParts) {
		return 0
	}

	const minLen = Math.min(aParts.length, bParts.length)

	for (let i = 0; i < minLen; i++) {
		const aPart = aParts[i]
		const bPart = bParts[i]

		if (typeof aPart === "number" && typeof bPart === "number") {
			if (aPart !== bPart) {
				return aPart - bPart
			}
		} else if (typeof aPart === "string" && typeof bPart === "string") {
			if (aPart !== bPart) {
				return aPart < bPart ? -1 : 1
			}
		} else {
			return typeof aPart === "number" ? -1 : 1
		}
	}

	return aParts.length - bParts.length
}

function isDirectoryType(type: string): boolean {
	return type === "directory" || type === "sharedDirectory" || type === "sharedRootDirectory"
}

// Per-item sort keys are extracted ONCE per item into parallel key arrays, an index
// array is sorted with a comparator that only reads keys (and resolves the lazy
// numeric-uuid tiebreaker on key equality), and the permutation is applied in one
// write-back pass. The previous shape recomputed keys per COMPARISON — O(n log n)
// recomputes including Number(bigint) conversions and a fresh getTimestamp closure per
// comparison — and ran the dirs-before-files type check (up to 6 string comparisons)
// inside every comparison. Dirs-first is handled by partitioning ONCE instead: for a
// stable sort whose cross-class order is fully class-determined, [stable-sort(dirs),
// stable-sort(files)] is exactly equivalent. Index arrays instead of per-item wrapper
// objects keep the decoration overhead at two flat arrays per sort (cheap enough that
// the TimSort adaptive case — re-sorting an already-sorted listing — stays fast).
//
// EQUAL KEYS MUST NOT FALL THROUGH TO INPUT ORDER (#49): the input is the raw query
// data, whose order is not stable across refetches, so "stable sort" ties would
// reshuffle on every refresh. The size and string modes therefore resolve ties through
// a deterministic chain — primary key → name (numeric-aware, same compare as A-Z) →
// numeric-uuid → uuid string — so equal sizes come out alphabetical, the mime sort
// groups by type with names ordered within each group, and every ordering is a pure
// function of the item set. Descending modes invert the WHOLE chain (mirrors the
// timestamp modes' desc semantics). Timestamp modes keep their original
// timestamp → numeric-uuid chain (real-world timestamps don't mass-collide).

function nameSortKey(item: DriveItem): string {
	return item.data.decryptedMeta?.name ?? item.data.uuid
}

function mimeSortKey(item: DriveItem): string {
	return item.type === "file" || item.type === "sharedFile" || item.type === "sharedRootFile"
		? (item.data.decryptedMeta?.mime ?? item.data.decryptedMeta?.name ?? item.data.uuid)
		: (item.data.decryptedMeta?.name ?? item.data.uuid)
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

// Client-written timestamps below this (1980-01-01) are treated as garbage — epoch-zero
// mtimes and similar artifacts of legacy uploaders — rather than as very old capture dates.
const CAPTURE_TIMESTAMP_FLOOR = Date.UTC(1980, 0, 1)

// Best-effort capture time (ms) for the photos timeline. Legacy clients stamped `created`
// with the upload time instead of the file's real creation date, stranding old photos at
// their upload position while the real date survived in `modified`. A photo cannot be
// modified before it was captured, so the earliest plausible client timestamp — above the
// garbage floor and no later than the server-assigned upload time (the only fully trusted
// stamp) — is the closest available estimate. Falls back to the upload time when neither
// client timestamp is usable. Shared items carry no server timestamp: only the floor
// applies, and they fall back to the plain creation key.
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
	let best = Number.POSITIVE_INFINITY

	for (const candidate of [item.data.decryptedMeta?.created, item.data.decryptedMeta?.modified]) {
		if (candidate === undefined) {
			continue
		}

		const value = Number(candidate)

		if (value > CAPTURE_TIMESTAMP_FLOOR && value <= uploaded && value < best) {
			best = value
		}
	}

	if (best !== Number.POSITIVE_INFINITY) {
		return best
	}

	return isFile ? Number(item.data.timestamp) : creationSortKey(item)
}

type SortMode = {
	kind: "parts" | "size" | "timestamp"
	isAsc: boolean
	stringKey?: (item: DriveItem) => string
	timestampKey?: (item: DriveItem) => number
	// String modes whose primary key is NOT the name (mime): break primary-key ties by
	// name before the uuid chain, so e.g. all "image/jpeg" files come out alphabetical.
	tiebreakByName?: boolean
}

const sortModes: Record<string, SortMode> = {
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

const FALLBACK_SORT_MODE = sortModes["nameAsc"] as SortMode

export type SortItemsOptions = {
	// Real directory sizes (bytes) keyed by directory uuid, fed in by the drive screen from the
	// useDirectorySizeQuery cache (the same values the rows display). Directories are constructed
	// with `data.size: 0n` (sdkUnwrap), so without this the size modes cannot order them at all
	// (#49). Directories missing from the map sort as their raw `data.size` (0n) and fall into the
	// deterministic name tiebreak.
	directorySizes?: ReadonlyMap<string, number>
}

function sortPartition<T extends DriveItem>(partition: T[], mode: SortMode, options?: SortItemsOptions): void {
	const length = partition.length

	if (length <= 1) {
		return
	}

	const indices: number[] = new Array(length)

	for (let i = 0; i < length; i++) {
		indices[i] = i
	}

	// Deterministic tail of the size/string tiebreak chains: numeric-uuid, then the raw uuid
	// string (numeric-uuid projects the uuid onto its digit runs, so distinct uuids CAN collide).
	const compareUuids = (a: number, b: number): number => {
		const uuidA = (partition[a] as T).data.uuid
		const uuidB = (partition[b] as T).data.uuid
		const numericDiff = getUuidNumber(uuidA) - getUuidNumber(uuidB)

		if (numericDiff !== 0) {
			return numericDiff
		}

		return uuidA < uuidB ? -1 : uuidA > uuidB ? 1 : 0
	}

	if (mode.kind === "size") {
		const directorySizes = options?.directorySizes
		const sizes: bigint[] = new Array(length)

		for (let i = 0; i < length; i++) {
			const item = partition[i] as T
			// Directories carry no real size on the item itself — substitute the display cache's
			// value when the caller provided one. Values arrive as integral byte counts; guard the
			// BigInt conversion anyway (BigInt(NaN/fraction) throws).
			const known = directorySizes && isDirectoryType(item.type) ? directorySizes.get(item.data.uuid) : undefined

			// Sizes stay bigint end-to-end: Number() conversion would collapse values that
			// differ beyond 2^53 (pinned by the hardening suite).
			sizes[i] = known !== undefined && Number.isFinite(known) ? BigInt(Math.trunc(known)) : item.data.size
		}

		// The name tiebreak stays LAZY here (memoized lower/parts caches, resolved per tie):
		// file sizes are mostly distinct, so precomputing name keys for the whole partition
		// would tax the common case for the rare tie. The tie-dense case this chain exists for
		// — directories, whose sizes are all equal/unknown — is the small dirs partition.
		const compareAsc = (a: number, b: number): number => {
			const sizeA = sizes[a] as bigint
			const sizeB = sizes[b] as bigint

			if (sizeA !== sizeB) {
				return sizeA > sizeB ? 1 : -1
			}

			const nameDiff = comparePartsNumeric(
				getNumericParts(getLowerName(nameSortKey(partition[a] as T))),
				getNumericParts(getLowerName(nameSortKey(partition[b] as T)))
			)

			if (nameDiff !== 0) {
				return nameDiff
			}

			return compareUuids(a, b)
		}

		indices.sort(mode.isAsc ? compareAsc : (a, b) => compareAsc(b, a))
	} else if (mode.kind === "timestamp") {
		const timestampKey = mode.timestampKey as (item: DriveItem) => number
		const keys = new Float64Array(length)

		for (let i = 0; i < length; i++) {
			keys[i] = timestampKey(partition[i] as T)
		}

		indices.sort(
			mode.isAsc
				? (a, b) => {
						const diff = (keys[a] as number) - (keys[b] as number)

						if (diff !== 0) {
							return diff
						}

						return getUuidNumber((partition[a] as T).data.uuid) - getUuidNumber((partition[b] as T).data.uuid)
					}
				: (a, b) => {
						const diff = (keys[b] as number) - (keys[a] as number)

						if (diff !== 0) {
							return diff
						}

						return getUuidNumber((partition[b] as T).data.uuid) - getUuidNumber((partition[a] as T).data.uuid)
					}
		)
	} else {
		const stringKey = mode.stringKey as (item: DriveItem) => string
		const allParts: (string | number)[][] = new Array(length)
		// Only mime keys need the name secondary — for the name modes the primary already IS the
		// name, so a tie means identical names and the chain skips straight to the uuids.
		const tieParts: (string | number)[][] | null = mode.tiebreakByName ? new Array(length) : null

		for (let i = 0; i < length; i++) {
			const item = partition[i] as T

			allParts[i] = getNumericParts(getLowerName(stringKey(item)))

			if (tieParts) {
				tieParts[i] = getNumericParts(getLowerName(nameSortKey(item)))
			}
		}

		const compareAsc = (a: number, b: number): number => {
			const keyDiff = comparePartsNumeric(allParts[a] as (string | number)[], allParts[b] as (string | number)[])

			if (keyDiff !== 0) {
				return keyDiff
			}

			if (tieParts) {
				const nameDiff = comparePartsNumeric(tieParts[a] as (string | number)[], tieParts[b] as (string | number)[])

				if (nameDiff !== 0) {
					return nameDiff
				}
			}

			return compareUuids(a, b)
		}

		indices.sort(mode.isAsc ? compareAsc : (a, b) => compareAsc(b, a))
	}

	// Apply the permutation: snapshot once, write back by sorted index.
	const snapshot = partition.slice()

	for (let i = 0; i < length; i++) {
		partition[i] = snapshot[indices[i] as number] as T
	}
}

function sortItems<T extends DriveItem>(items: T[], type: SortByType, options?: SortItemsOptions): T[] {
	const mode = sortModes[type] ?? FALLBACK_SORT_MODE
	const dirs: T[] = []
	const files: T[] = []

	for (let i = 0; i < items.length; i++) {
		const item = items[i] as T

		if (isDirectoryType(item.type)) {
			dirs.push(item)
		} else {
			files.push(item)
		}
	}

	sortPartition(dirs, mode, options)
	sortPartition(files, mode, options)

	if (dirs.length === 0) {
		return files
	}

	for (let i = 0; i < files.length; i++) {
		dirs.push(files[i] as T)
	}

	return dirs
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
			title: new Intl.DateTimeFormat(intlLanguage, {
				month: "long"
			}).format(date),
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
