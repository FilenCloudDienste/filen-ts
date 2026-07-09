import { parseNumbersFromString } from "@filen/utils"
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

		// Run-sliced scan: runs are detected via charCodeAt only and materialized with ONE slice
		// each, so a name with k runs costs k allocations, not one per character. Digit runs keep
		// parseInt so numeric semantics (incl. precision rounding of absurdly long digit runs)
		// match a straightforward numeric parse.
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
	// Identical strings resolve to the SAME cached parts array (numericPartsCache), so reference
	// equality short-circuits the whole walk — tie-dense comparisons (same type across a group,
	// duplicated names) become O(1) instead of O(parts).
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

// Per-item sort keys are extracted ONCE into parallel flat arrays, an index array is sorted
// against a comparator that only reads those precomputed keys (resolving the lazy numeric-uuid
// tiebreak on equality), and the permutation is written back in one pass — recomputing keys
// inside the comparator would redo bigint conversions and type checks on every comparison instead
// of once per item. Dirs-first is handled by partitioning once: for a stable sort whose
// cross-class order is fully class-determined, [stable-sort(dirs), stable-sort(files)] is exactly
// equivalent to sorting the whole list with a dirs-before-files primary key. Index arrays instead
// of per-item wrapper objects keep decoration overhead at two flat arrays per sort.
//
// Equal keys must not fall through to input order: the input is raw query data whose order is not
// stable across refetches, so a "stable sort" tie would reshuffle on every refresh. The size and
// string modes resolve ties through a deterministic chain — primary key -> name (numeric-aware,
// same compare as A-Z) -> numeric-uuid -> uuid string — so equal sizes come out alphabetical, the
// type sort groups by MIME with names ordered within each group, and every ordering is a pure
// function of the item set. Descending modes invert the WHOLE chain. Timestamp modes keep their
// own timestamp -> numeric-uuid chain (real-world timestamps don't mass-collide).

function nameSortKey(item: DriveItem): string {
	return item.data.decryptedMeta?.name ?? item.data.uuid
}

// Primary key is MIME for files (directories have none, so they use name instead) — NOT the name
// — so ties (many files sharing a MIME) are broken by name before the uuid chain (tiebreakByName
// on the sort mode below).
function typeSortKey(item: DriveItem): string {
	const base = asDirectoryOrFile(item)
	return base.type === "file" ? (base.data.decryptedMeta?.mime ?? base.data.decryptedMeta?.name ?? base.data.uuid) : nameSortKey(item)
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

interface SortMode {
	kind: "parts" | "size" | "timestamp"
	isAsc: boolean
	stringKey?: (item: DriveItem) => string
	timestampKey?: (item: DriveItem) => number
	tiebreakByName?: boolean
}

const sortModes: Record<string, SortMode> = {
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

// noUncheckedIndexedAccess types every indexed read — plain arrays and typed arrays alike, both
// structurally just a numeric index signature — as `T | undefined`. Every index this module reads
// by is in bounds by construction (loop counters, sort-comparator indices supplied by
// `indices.sort` from the 0..length-1 range it was seeded with, permutation targets), so this
// narrows via a real bounds check instead of a non-null assertion or a bare cast.
function at<T>(array: Readonly<Record<number, T>>, index: number): T {
	const value = array[index]

	if (value === undefined) {
		throw new Error("sort.ts: index out of bounds")
	}

	return value
}

function requiredSortMode(key: string): SortMode {
	const mode = sortModes[key]

	if (mode === undefined) {
		throw new Error(`sort.ts: missing sort mode "${key}"`)
	}

	return mode
}

const FALLBACK_SORT_MODE = requiredSortMode("nameAsc")

function sortPartition(partition: DriveItem[], mode: SortMode, directorySizes?: ReadonlyMap<string, number>): void {
	const length = partition.length

	if (length <= 1) {
		return
	}

	const indices: number[] = new Array<number>(length)

	for (let i = 0; i < length; i++) {
		indices[i] = i
	}

	// Deterministic tail of the size/string tiebreak chains: numeric-uuid, then the raw uuid
	// string (numeric-uuid projects the uuid onto its digit runs, so distinct uuids CAN collide).
	const compareUuids = (a: number, b: number): number => {
		const uuidA = at(partition, a).data.uuid
		const uuidB = at(partition, b).data.uuid
		const numericDiff = getUuidNumber(uuidA) - getUuidNumber(uuidB)

		if (numericDiff !== 0) {
			return numericDiff
		}

		return uuidA < uuidB ? -1 : uuidA > uuidB ? 1 : 0
	}

	if (mode.kind === "size") {
		const sizes: bigint[] = new Array<bigint>(length)

		for (let i = 0; i < length; i++) {
			const item = at(partition, i)
			// Directories carry no real size on the item itself (synthetic 0n — see narrowItem in
			// @/features/drive/lib/item) — substitute the caller's display-cache value when provided. Values
			// arrive as integral byte counts; guard the BigInt conversion anyway (BigInt(NaN/fraction)
			// throws).
			const known = directorySizes && asDirectoryOrFile(item).type === "directory" ? directorySizes.get(item.data.uuid) : undefined

			// Sizes stay bigint end-to-end: Number() conversion would collapse values that differ
			// beyond 2^53.
			sizes[i] = known !== undefined && Number.isFinite(known) ? BigInt(Math.trunc(known)) : item.data.size
		}

		// The name tiebreak stays LAZY here (memoized lower/parts caches, resolved per tie): file
		// sizes are mostly distinct, so precomputing name keys for the whole partition would tax the
		// common case for the rare tie. The tie-dense case this chain exists for — directories,
		// whose sizes are all equal/unknown — is the small dirs partition.
		const compareAsc = (a: number, b: number): number => {
			const sizeA = at(sizes, a)
			const sizeB = at(sizes, b)

			if (sizeA !== sizeB) {
				return sizeA > sizeB ? 1 : -1
			}

			const nameDiff = comparePartsNumeric(
				getNumericParts(getLowerName(nameSortKey(at(partition, a)))),
				getNumericParts(getLowerName(nameSortKey(at(partition, b))))
			)

			if (nameDiff !== 0) {
				return nameDiff
			}

			return compareUuids(a, b)
		}

		indices.sort(mode.isAsc ? compareAsc : (a, b) => compareAsc(b, a))
	} else if (mode.kind === "timestamp") {
		const timestampKey = mode.timestampKey

		if (timestampKey === undefined) {
			throw new Error("sort.ts: timestamp sort mode missing timestampKey")
		}

		const keys = new Float64Array(length)

		for (let i = 0; i < length; i++) {
			keys[i] = timestampKey(at(partition, i))
		}

		indices.sort(
			mode.isAsc
				? (a, b) => {
						const diff = at(keys, a) - at(keys, b)

						if (diff !== 0) {
							return diff
						}

						return getUuidNumber(at(partition, a).data.uuid) - getUuidNumber(at(partition, b).data.uuid)
					}
				: (a, b) => {
						const diff = at(keys, b) - at(keys, a)

						if (diff !== 0) {
							return diff
						}

						return getUuidNumber(at(partition, b).data.uuid) - getUuidNumber(at(partition, a).data.uuid)
					}
		)
	} else {
		const stringKey = mode.stringKey

		if (stringKey === undefined) {
			throw new Error("sort.ts: parts sort mode missing stringKey")
		}

		const allParts: (string | number)[][] = new Array<(string | number)[]>(length)
		// Only the type mode needs the name secondary — for the name modes the primary already IS
		// the name, so a tie means identical names and the chain skips straight to the uuids.
		const tieParts: (string | number)[][] | null = mode.tiebreakByName ? new Array<(string | number)[]>(length) : null

		for (let i = 0; i < length; i++) {
			const item = at(partition, i)

			allParts[i] = getNumericParts(getLowerName(stringKey(item)))

			if (tieParts) {
				tieParts[i] = getNumericParts(getLowerName(nameSortKey(item)))
			}
		}

		const compareAsc = (a: number, b: number): number => {
			const keyDiff = comparePartsNumeric(at(allParts, a), at(allParts, b))

			if (keyDiff !== 0) {
				return keyDiff
			}

			if (tieParts) {
				const nameDiff = comparePartsNumeric(at(tieParts, a), at(tieParts, b))

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
		partition[i] = at(snapshot, at(indices, i))
	}
}

// Directories sort before files, always (dirs-first is a partition, not a sort key — see the
// design note above). `directorySizes` lets a caller feed in real directory byte counts (keyed by
// uuid, e.g. from a size query cache) for the size modes; a directory absent from the map sorts by
// its raw synthetic 0n size and falls into the deterministic name tiebreak. Wiring real sizes in by
// default is a later enhancement — the 0n fallback is well-defined on its own.
export function sortDriveItems(items: DriveItem[], sortBy: DriveSortBy, directorySizes?: ReadonlyMap<string, number>): DriveItem[] {
	const mode = sortModes[sortBy] ?? FALLBACK_SORT_MODE
	const dirs: DriveItem[] = []
	const files: DriveItem[] = []

	for (const item of items) {
		if (asDirectoryOrFile(item).type === "directory") {
			dirs.push(item)
		} else {
			files.push(item)
		}
	}

	sortPartition(dirs, mode, directorySizes)
	sortPartition(files, mode, directorySizes)

	if (dirs.length === 0) {
		return files
	}

	for (const file of files) {
		dirs.push(file)
	}

	return dirs
}
