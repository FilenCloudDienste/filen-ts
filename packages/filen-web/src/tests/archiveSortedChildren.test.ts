import { describe, expect, it } from "vitest"
import { createEntryStore, type EntryStore } from "@/features/archive/lib/entryStore"
import {
	childRows,
	dirOfRef,
	dirRef,
	isDirRef,
	SORTED_CHILDREN_CACHE_SIZE,
	type ChildSort,
	type RowView
} from "@/features/archive/lib/sortedChildren"
import { packEntries, storeOf, type EntrySpec } from "@/tests/support/archiveEntries"

const BY_NAME: ChildSort = { key: "name", descending: false }

function names(store: EntryStore, view: RowView): string[] {
	return Array.from({ length: view.count }, (_, i) => {
		const ref = view.at(i)

		return isDirRef(ref) ? `${store.dirName(dirOfRef(ref))}/` : store.name(ref)
	})
}

function refs(view: RowView): number[] {
	return Array.from({ length: view.count }, (_, i) => view.at(i))
}

describe("childRows", () => {
	it("lists directories first, each group in natural, case-insensitive order", () => {
		const store = storeOf(["file10", "B/x", "file2", "a/x", "File1", "c10/", "c9/", "_under"])
		const view = childRows(store, 0, BY_NAME)

		expect(names(store, view)).toEqual(["a/", "B/", "c9/", "c10/", "_under", "File1", "file2", "file10"])
		expect(isDirRef(view.at(0))).toBe(true)
		expect(dirOfRef(view.at(0))).toBe(store.findDir("a"))
		expect(dirRef(store.findDir("a"))).toBe(view.at(0))
		expect(names(store, childRows(store, 0, { key: "name", descending: true }))).toEqual([
			"c10/",
			"c9/",
			"B/",
			"a/",
			"file10",
			"file2",
			"File1",
			"_under"
		])
	})

	it("orders non-ASCII names by the collator", () => {
		const store = storeOf(["zebra", "Äpfel", "apple", "éclair", "Eclair"])

		expect(names(store, childRows(store, 0, BY_NAME))).toEqual(["Äpfel", "apple", "Eclair", "éclair", "zebra"])
	})

	it("sorts by size and date with unknown values last in both directions, ties by name", () => {
		const specs: EntrySpec[] = [
			{ path: "big", size: 900, modified: 3 },
			{ path: "small", size: 1, modified: 1 },
			{ path: "nodate", size: 5 },
			{ path: "b-mid", size: 5, modified: 2 },
			{ path: "a-mid", size: 5, modified: 2 },
			{ path: "dirA/", modified: 9 },
			{ path: "dirA/f", size: 50 },
			{ path: "dirB/f", size: 10 }
		]
		const store = storeOf(specs)

		expect(names(store, childRows(store, 0, { key: "size", descending: false }))).toEqual([
			"dirB/",
			"dirA/",
			"small",
			"a-mid",
			"b-mid",
			"nodate",
			"big"
		])
		expect(names(store, childRows(store, 0, { key: "size", descending: true }))).toEqual([
			"dirA/",
			"dirB/",
			"big",
			"nodate",
			"b-mid",
			"a-mid",
			"small"
		])
		expect(names(store, childRows(store, 0, { key: "modified", descending: false }))).toEqual([
			"dirA/",
			"dirB/",
			"small",
			"a-mid",
			"b-mid",
			"big",
			"nodate"
		])
		expect(names(store, childRows(store, 0, { key: "modified", descending: true }))).toEqual([
			"dirA/",
			"dirB/",
			"big",
			"b-mid",
			"a-mid",
			"small",
			"nodate"
		])
	})

	it("breaks ties by arrival, so equal names keep a stable order", () => {
		const store = storeOf(["x", "X", "x"])

		expect(refs(childRows(store, 0, BY_NAME))).toEqual([0, 1, 2])
		expect(refs(childRows(store, 0, { key: "name", descending: true }))).toEqual([0, 1, 2])
	})

	it("merges entries arriving while streaming into the order a full sort gives", () => {
		const specs = Array.from({ length: 3000 }, (_, i): EntrySpec => {
			const n = (i * 7919) % 3000

			return {
				path: `${n % 3 === 0 ? `d${String(n % 40)}/` : ""}item ${String(n)}${n % 7 === 0 ? "/x" : ""}`,
				size: n % 13,
				modified: n % 5
			}
		})
		const batches = packEntries(specs, 250)
		const sorts: ChildSort[] = [BY_NAME, { key: "size", descending: true }, { key: "modified", descending: false }]
		const streaming = createEntryStore()

		for (const batch of batches) {
			streaming.append(batch)

			for (const sort of sorts) {
				childRows(streaming, 0, sort)
			}
		}

		const whole = createEntryStore()

		for (const batch of batches) {
			whole.append(batch)
		}

		for (const sort of sorts) {
			expect(refs(childRows(streaming, 0, sort))).toEqual(refs(childRows(whole, 0, sort)))
		}

		expect(childRows(streaming, 0, BY_NAME).count).toBe(streaming.childDirs(0).length + streaming.childEntries(0).length)
	})

	it("places newcomers before, between and after the sorted rows, equal names in arrival order", () => {
		const store = createEntryStore()
		const batches = packEntries(["m", "n", "p", "a", "o", "z", "n", "m"], 3)

		for (const batch of batches) {
			store.append(batch)
			childRows(store, 0, BY_NAME)
		}

		expect(names(store, childRows(store, 0, BY_NAME))).toEqual(["a", "m", "m", "n", "n", "o", "p", "z"])
		expect(refs(childRows(store, 0, BY_NAME))).toEqual([3, 0, 7, 1, 6, 4, 2, 5])
	})

	it("keeps the last eight orders and resorts only an evicted one", () => {
		const base = storeOf(Array.from({ length: SORTED_CHILDREN_CACHE_SIZE + 1 }, (_, i) => `d${String(i)}/a`).concat(["z", "y"]))
		let calls = 0
		const store: EntryStore = {
			...base,
			name: slot => {
				calls++

				return base.name(slot)
			},
			dirName: id => {
				calls++

				return base.dirName(id)
			}
		}
		const dirs = base.childDirs(0)
		const sorted = (dir: number): number => {
			calls = 0

			childRows(store, dir, BY_NAME)

			return calls
		}

		expect(sorted(0)).toBeGreaterThan(0)
		expect(sorted(0)).toBe(0)

		for (const dir of dirs.slice(0, SORTED_CHILDREN_CACHE_SIZE - 1)) {
			sorted(dir)
		}

		expect(sorted(0)).toBe(0)

		for (const dir of dirs.slice(0, SORTED_CHILDREN_CACHE_SIZE)) {
			sorted(dir)
		}

		expect(sorted(0)).toBeGreaterThan(0)
	})

	it("sorts a flat directory of 250k names, then gallops a streamed batch into place", () => {
		const sorted = 250_000
		const arriving = 4096
		const total = sorted + arriving
		const base = createEntryStore()

		const append = (start: number, count: number): void => {
			base.append({
				archive: "a",
				count,
				index: Uint32Array.from({ length: count }, (_, i) => start + i),
				kind: new Uint8Array(count),
				skip: new Uint8Array(count),
				flags: new Uint8Array(count),
				size: new Float64Array(count).fill(1),
				modified: new Float64Array(count).fill(NaN),
				// A permutation of 0..total, so the newcomers interleave with the sorted names.
				name: Array.from({ length: count }, (_, i) => `IMG_${String(((start + i) * 7919) % total)}.jpg`),
				parent: new Uint32Array(count),
				parents: [""],
				links: [],
				stored: []
			})
		}

		for (let start = 0; start < sorted; start += 4096) {
			append(start, Math.min(4096, sorted - start))
		}

		// Two name reads per comparison: counts what the sort does, not how long a loaded machine takes.
		let reads = 0
		const store: EntryStore = {
			...base,
			name: slot => {
				reads++

				return base.name(slot)
			}
		}
		const first = childRows(store, 0, BY_NAME)

		expect(first.count).toBe(sorted)
		expect(reads).toBeLessThanOrEqual(2 * 2 * sorted * Math.ceil(Math.log2(sorted)))

		append(sorted, arriving)
		reads = 0

		const view = childRows(store, 0, BY_NAME)

		// Sorting the newcomers, then galloping each into place: k·log2(k) + k·(2·log2(n/k) + 2), far below
		// a linear merge's n, let alone a full resort's 2·n·log2(n) ≈ 9M names.
		const galloping = arriving * (2 * Math.ceil(Math.log2(total / arriving)) + 2)

		expect(reads).toBeLessThanOrEqual(2 * (2 * arriving * Math.ceil(Math.log2(arriving)) + galloping))
		expect(reads).toBeLessThan(total)
		expect(view.count).toBe(total)
		expect(store.name(view.at(0))).toBe("IMG_0.jpg")
		expect(store.name(view.at(1))).toBe("IMG_1.jpg")
		expect(store.name(view.at(total - 1))).toBe(`IMG_${String(total - 1)}.jpg`)
	})
})
