import { getUuidNumber, getLowerName, getNumericParts, comparePartsNumeric } from "./naturalSort"

// Generic index-array decorate/sort/permute engine behind drive-item sorting on both platforms —
// three mode kinds (size / timestamp / lexicographic "parts"), a lazy name tiebreak nested inside
// the size branch, bigint-safe size handling, and the deterministic primary-key -> name ->
// numeric-uuid -> uuid tiebreak chain that guards against unstable refetch order (#49). Field
// access is injected via `accessors` so this stays free of any concrete item shape or SDK type;
// each app keeps its own mode table, key extractors and directory-ness check.
//
// Per-item sort keys are extracted ONCE into parallel flat arrays, an index array is sorted
// against a comparator that only reads those precomputed keys (resolving the lazy numeric-uuid
// tiebreak on equality), and the permutation is written back in one pass — recomputing keys
// inside the comparator would redo bigint conversions and accessor calls on every comparison
// instead of once per item. Dirs-first is handled by partitioning once: for a stable sort whose
// cross-class order is fully class-determined, [stable-sort(dirs), stable-sort(files)] is exactly
// equivalent to sorting the whole list with a dirs-before-files primary key. Index arrays instead
// of per-item wrapper objects keep decoration overhead at two flat arrays per sort.
//
// EQUAL KEYS MUST NOT FALL THROUGH TO INPUT ORDER: the input is raw query data whose order is not
// stable across refetches, so a "stable sort" tie would reshuffle on every refresh. The size and
// string modes resolve ties through a deterministic chain — primary key -> name (numeric-aware,
// same compare as A-Z) -> numeric-uuid -> uuid string — so equal sizes come out alphabetical, a
// type/mime sort groups by that key with names ordered within each group, and every ordering is a
// pure function of the item set. Descending modes invert the WHOLE chain. Timestamp modes keep
// their own timestamp -> numeric-uuid chain (real-world timestamps don't mass-collide).
export interface SortEngineAccessors<T> {
	getUuid: (item: T) => string
	getSize: (item: T) => bigint
	isDirectory: (item: T) => boolean
	nameKey: (item: T) => string
	// Real directory sizes (bytes) keyed by uuid, fed in by the caller (e.g. a directory-size query
	// cache). Directories missing from the map sort by their raw (synthetic) size and fall into the
	// deterministic name tiebreak.
	directorySizes?: ReadonlyMap<string, number>
}

export interface SortMode<T> {
	kind: "parts" | "size" | "timestamp"
	isAsc: boolean
	stringKey?: (item: T) => string
	timestampKey?: (item: T) => number
	// String modes whose primary key is NOT the name: break primary-key ties by name before the
	// uuid chain (e.g. so files sharing a mime/type come out alphabetical).
	tiebreakByName?: boolean
}

// noUncheckedIndexedAccess types every indexed read — plain arrays and typed arrays alike, both
// structurally just a numeric index signature — as `T | undefined`. Every index this module reads
// by is in bounds by construction (loop counters, sort-comparator indices supplied by
// `indices.sort` from the 0..length-1 range it was seeded with, permutation targets), so this
// narrows via a real bounds check instead of a non-null assertion or a bare cast.
function at<T>(array: Readonly<Record<number, T>>, index: number): T {
	const value = array[index]

	if (value === undefined) {
		throw new Error("driveSortEngine.ts: index out of bounds")
	}

	return value
}

export function sortPartition<T>(partition: T[], mode: SortMode<T>, accessors: SortEngineAccessors<T>): void {
	const length = partition.length

	if (length <= 1) {
		return
	}

	const { getUuid, getSize, isDirectory, nameKey, directorySizes } = accessors

	const indices: number[] = new Array<number>(length)

	for (let i = 0; i < length; i++) {
		indices[i] = i
	}

	// Deterministic tail of the size/string tiebreak chains: numeric-uuid, then the raw uuid
	// string (numeric-uuid projects the uuid onto its digit runs, so distinct uuids CAN collide).
	const compareUuids = (a: number, b: number): number => {
		const uuidA = getUuid(at(partition, a))
		const uuidB = getUuid(at(partition, b))
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
			// Directories carry no real size on the item itself — substitute the display cache's
			// value when the caller provided one. Values arrive as integral byte counts; guard the
			// BigInt conversion anyway (BigInt(NaN/fraction) throws).
			const known = directorySizes && isDirectory(item) ? directorySizes.get(getUuid(item)) : undefined

			// Sizes stay bigint end-to-end: Number() conversion would collapse values that differ
			// beyond 2^53 (pinned by the hardening suite).
			sizes[i] = known !== undefined && Number.isFinite(known) ? BigInt(Math.trunc(known)) : getSize(item)
		}

		// The name tiebreak stays LAZY here (memoized lower/parts caches, resolved per tie): file
		// sizes are mostly distinct, so precomputing name keys for the whole partition would tax
		// the common case for the rare tie. The tie-dense case this chain exists for — directories,
		// whose sizes are all equal/unknown — is the small dirs partition.
		const compareAsc = (a: number, b: number): number => {
			const sizeA = at(sizes, a)
			const sizeB = at(sizes, b)

			if (sizeA !== sizeB) {
				return sizeA > sizeB ? 1 : -1
			}

			const nameDiff = comparePartsNumeric(
				getNumericParts(getLowerName(nameKey(at(partition, a)))),
				getNumericParts(getLowerName(nameKey(at(partition, b))))
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
			throw new Error("driveSortEngine.ts: timestamp sort mode missing timestampKey")
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

						return getUuidNumber(getUuid(at(partition, a))) - getUuidNumber(getUuid(at(partition, b)))
					}
				: (a, b) => {
						const diff = at(keys, b) - at(keys, a)

						if (diff !== 0) {
							return diff
						}

						return getUuidNumber(getUuid(at(partition, b))) - getUuidNumber(getUuid(at(partition, a)))
					}
		)
	} else {
		const stringKey = mode.stringKey

		if (stringKey === undefined) {
			throw new Error("driveSortEngine.ts: parts sort mode missing stringKey")
		}

		const allParts: (string | number)[][] = new Array<(string | number)[]>(length)
		// Only tiebreakByName modes need the name secondary — for the name modes the primary
		// already IS the name, so a tie means identical names and the chain skips straight to the
		// uuids.
		const tieParts: (string | number)[][] | null = mode.tiebreakByName ? new Array<(string | number)[]>(length) : null

		for (let i = 0; i < length; i++) {
			const item = at(partition, i)

			allParts[i] = getNumericParts(getLowerName(stringKey(item)))

			if (tieParts) {
				tieParts[i] = getNumericParts(getLowerName(nameKey(item)))
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
// design note above).
export function sortItems<T>(items: T[], mode: SortMode<T>, accessors: SortEngineAccessors<T>): T[] {
	const dirs: T[] = []
	const files: T[] = []

	for (const item of items) {
		if (accessors.isDirectory(item)) {
			dirs.push(item)
		} else {
			files.push(item)
		}
	}

	sortPartition(dirs, mode, accessors)
	sortPartition(files, mode, accessors)

	if (dirs.length === 0) {
		return files
	}

	for (const file of files) {
		dirs.push(file)
	}

	return dirs
}
