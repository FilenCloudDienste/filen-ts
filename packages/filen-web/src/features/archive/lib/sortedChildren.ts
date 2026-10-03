import type { EntryStore } from "@/features/archive/lib/entryStore"
import { compareNames } from "@/features/archive/lib/naturalCompare"

// A directory's rows in display order: its directories first, then its other entries, each read from
// a sorted Int32Array. While a listing streams, children only ever arrive at the end of a directory's
// lists, so a cached order takes in the newcomers by sorting just them and merging. Directories by size
// or date are the exception: those values move with every batch, so they resort (there are few).

// >= 0 an entry slot, < 0 a directory node as ~id.
export type RowRef = number

export type ChildSortKey = "name" | "size" | "modified"

export interface ChildSort {
	key: ChildSortKey
	descending: boolean
}

export interface RowView {
	count: number
	at: (i: number) => RowRef
}

type Comparator = (a: number, b: number) => number

interface SortedChildren {
	dir: number
	key: ChildSortKey
	descending: boolean
	// The store's version the directory order was taken at.
	version: number
	dirs: Int32Array
	entries: Int32Array
}

export const SORTED_CHILDREN_CACHE_SIZE = 8

// Most recent first, per store, so a finished listing's orders go with it.
const caches = new WeakMap<EntryStore, SortedChildren[]>()

export function dirRef(id: number): RowRef {
	return ~id
}

export function isDirRef(ref: RowRef): boolean {
	return ref < 0
}

export function dirOfRef(ref: RowRef): number {
	return ~ref
}

// Missing values (NaN) last in either direction; ties by name, then by arrival, so the order is total
// and a merged order equals a full sort.
function byValue(value: (x: number) => number, name: (x: number) => string, sign: number): Comparator {
	return (a, b) => {
		const va = value(a)
		const vb = value(b)

		if (va !== vb) {
			const aMissing = Number.isNaN(va)

			if (aMissing !== Number.isNaN(vb)) {
				return aMissing ? 1 : -1
			}

			if (!aMissing) {
				return va < vb ? -sign : sign
			}
		}

		return compareNames(name(a), name(b)) * sign || a - b
	}
}

function byName(name: (x: number) => string, sign: number): Comparator {
	return (a, b) => compareNames(name(a), name(b)) * sign || a - b
}

export function entryComparator(store: EntryStore, sort: ChildSort): Comparator {
	const sign = sort.descending ? -1 : 1

	switch (sort.key) {
		case "name":
			return byName(store.name, sign)
		case "size":
			return byValue(
				slot => {
					const size = store.size(slot)

					return size < 0 ? NaN : size
				},
				store.name,
				sign
			)
		case "modified":
			return byValue(store.modified, store.name, sign)
	}
}

export function dirComparator(store: EntryStore, sort: ChildSort): Comparator {
	const sign = sort.descending ? -1 : 1

	switch (sort.key) {
		case "name":
			return byName(store.dirName, sign)
		case "size":
			return byValue(store.aggBytes, store.dirName, sign)
		case "modified":
			return byValue(store.dirModified, store.dirName, sign)
	}
}

function sortedTail(all: readonly number[], from: number, compare: Comparator): Int32Array {
	const tail = new Int32Array(all.length - from)

	for (let i = 0; i < tail.length; i++) {
		tail[i] = all[from + i] ?? 0
	}

	return tail.sort(compare)
}

// `sorted` holds all[0, sorted.length) in order. Each newcomer finds its place by galloping from the last
// one's, then the sorted run before it moves as one block: k·log(n/k) comparisons instead of n.
function withNewcomers(sorted: Int32Array, all: readonly number[], compare: Comparator): Int32Array {
	if (all.length === sorted.length) {
		return sorted
	}

	const tail = sortedTail(all, sorted.length, compare)

	if (sorted.length === 0) {
		return tail
	}

	const merged = new Int32Array(all.length)
	const n = sorted.length
	let from = 0
	let k = 0

	for (const b of tail) {
		// The first of sorted[from, n) after b: past every one at or before it, as a merge takes ties.
		let lo = from
		let hi = from
		let step = 1

		while (hi < n && compare(sorted[hi] ?? 0, b) <= 0) {
			lo = hi + 1
			hi += step
			step *= 2
		}

		hi = Math.min(hi, n)

		while (lo < hi) {
			const mid = (lo + hi) >>> 1

			if (compare(sorted[mid] ?? 0, b) <= 0) {
				lo = mid + 1
			} else {
				hi = mid
			}
		}

		merged.set(sorted.subarray(from, lo), k)
		k += lo - from
		from = lo
		merged[k++] = b
	}

	merged.set(sorted.subarray(from), k)

	return merged
}

function sortedChildren(store: EntryStore, dir: number, sort: ChildSort): SortedChildren {
	let cache = caches.get(store)

	if (cache === undefined) {
		cache = []

		caches.set(store, cache)
	}

	const at = cache.findIndex(entry => entry.dir === dir && entry.key === sort.key && entry.descending === sort.descending)
	const found = at < 0 ? undefined : cache.splice(at, 1)[0]
	const entry = found ?? {
		dir,
		key: sort.key,
		descending: sort.descending,
		version: -1,
		dirs: new Int32Array(0),
		entries: new Int32Array(0)
	}

	if (found === undefined && cache.length >= SORTED_CHILDREN_CACHE_SIZE) {
		cache.pop()
	}

	cache.unshift(entry)

	const childDirs = store.childDirs(dir)
	const childEntries = store.childEntries(dir)

	// A directory's totals and date change as its contents arrive, so only its name order stays good.
	if (sort.key !== "name" && entry.version !== store.version) {
		entry.dirs = sortedTail(childDirs, 0, dirComparator(store, sort))
	} else if (childDirs.length !== entry.dirs.length) {
		entry.dirs = withNewcomers(entry.dirs, childDirs, dirComparator(store, sort))
	}

	entry.version = store.version

	if (childEntries.length !== entry.entries.length) {
		entry.entries = withNewcomers(entry.entries, childEntries, entryComparator(store, sort))
	}

	return entry
}

export function childRows(store: EntryStore, dir: number, sort: ChildSort): RowView {
	const { dirs, entries } = sortedChildren(store, dir, sort)
	const dirCount = dirs.length

	return {
		count: dirCount + entries.length,
		at: i => (i < dirCount ? ~(dirs[i] ?? 0) : (entries[i - dirCount] ?? 0))
	}
}
