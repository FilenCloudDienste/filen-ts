import { describe, expect, it } from "vitest"
import { CellFlag, tileKey, tilePosition, type SheetTile, type SheetTilePatch } from "../core/sheet/protocol"
import { TileCache, entryInput, entryOf, entryRepeat, entryRuns, entryText, mergeTile } from "../react/sheet/tiles"
import { cpuMs } from "./timing"

// The grid's tile cache: least recently used out within its capacity, never a tile a frame needs; patches folded
// in by version; regions dropped; releases batched and withheld for tiles fetched again.

function tile(
	tileRow: number,
	tileCol: number,
	cells: readonly [row: number, col: number, text: string][],
	version = 1,
	layers?: SheetTile["layers"]
): SheetTile {
	const sorted = [...cells].sort((a, b) => tilePosition(a[0], a[1]) - tilePosition(b[0], b[1]))
	const strings = sorted.map(cell => cell[2])

	return {
		sheet: 1,
		tileRow,
		tileCol,
		version,
		count: sorted.length,
		positions: Uint16Array.from(sorted, cell => tilePosition(cell[0], cell[1])),
		texts: Int32Array.from(sorted, (_, k) => k),
		inputs: new Int32Array(sorted.length).fill(-1),
		styles: new Uint32Array(sorted.length),
		flags: new Uint32Array(sorted.length),
		strings,
		...(layers !== undefined && { layers })
	}
}

describe("grid tiles", () => {
	it("looks cells up by position and reads their text, input, runs and repeat fill", () => {
		const base = tile(0, 0, [
			[0, 0, "a"],
			[3, 7, "b"]
		])
		const rich: SheetTile = {
			...base,
			inputs: Int32Array.of(-1, 0),
			flags: Uint32Array.of(CellFlag.RICH, CellFlag.REPEAT),
			layers: {
				runs: { runEntries: Uint16Array.of(0, 0), runStarts: Uint32Array.of(0, 1), runStyles: Uint32Array.of(2, 3) },
				repeats: { entries: Uint16Array.of(1), offsets: Uint32Array.of(1), chars: ["-"] }
			}
		}

		expect(entryOf(rich, 3, 7)).toBe(1)
		expect(entryOf(rich, 3, 8)).toBe(-1)
		expect(entryText(rich, 1)).toBe("b")
		expect(entryInput(rich, 1)).toBe("a")
		expect(entryInput(rich, 0)).toBe("a")
		expect(entryRuns(rich, 0)).toEqual([0, 2, 1, 3])
		expect(entryRepeat(rich, 1)).toEqual({ offset: 1, char: "-" })
	})

	it("folds a merge patch into the tile: replaced and cleared positions, strings and layers kept for the rest", () => {
		const base = tile(
			0,
			0,
			[
				[0, 0, "keep"],
				[1, 1, "old"],
				[2, 2, "gone"]
			],
			1,
			{ repeats: { entries: Uint16Array.of(0), offsets: Uint32Array.of(2), chars: ["*"] } }
		)
		const patch: SheetTilePatch = {
			...tile(
				0,
				0,
				[
					[1, 1, "new"],
					[5, 5, "added"]
				],
				4
			),
			mode: "merge",
			cleared: Uint16Array.of(tilePosition(2, 2))
		}
		const merged = mergeTile(base, patch)

		expect(merged.version).toBe(4)
		expect(merged.count).toBe(3)
		expect(entryText(merged, entryOf(merged, 0, 0))).toBe("keep")
		expect(entryText(merged, entryOf(merged, 1, 1))).toBe("new")
		expect(entryText(merged, entryOf(merged, 5, 5))).toBe("added")
		expect(entryOf(merged, 2, 2)).toBe(-1)
		expect(entryRepeat(merged, entryOf(merged, 0, 0))).toEqual({ offset: 2, char: "*" })
		expect([...merged.positions]).toEqual([...merged.positions].sort((a, b) => a - b))
	})

	it("keeps the most recently used tiles within capacity, never one a frame needs, and batches the releases", () => {
		const cache = new TileCache()

		for (let col = 0; col < 6; col++) cache.put(tile(0, col, []))

		cache.touch(tileKey(1, 0, 0))
		cache.evict(3, new Set([tileKey(1, 0, 1)]))

		expect(cache.size).toBe(3)
		expect(cache.has(tileKey(1, 0, 0))).toBe(true)
		expect(cache.has(tileKey(1, 0, 1))).toBe(true)
		expect(cache.has(tileKey(1, 0, 5))).toBe(true)

		// A tile about to be fetched again is not released.
		cache.keep(new Set([tileKey(1, 0, 2)]))

		expect([...(cache.takeReleased() ?? [])]).toEqual([tileKey(1, 0, 3), tileKey(1, 0, 4)])
		expect(cache.takeReleased()).toBeNull()
	})

	it("ignores a patch older than the tile held and asks again for a merge it has no base for", () => {
		const cache = new TileCache()

		cache.put(tile(0, 0, [[0, 0, "v5"]], 5))

		expect(cache.patch({ ...tile(0, 0, [[0, 0, "v3"]], 3), mode: "replace" })).toBe(true)
		expect(entryText(cache.peek(tileKey(1, 0, 0)) as SheetTile, 0)).toBe("v5")
		expect(cache.patch({ ...tile(4, 0, [], 6), mode: "merge" })).toBe(false)
	})

	it("drops the tiles a region covers unless a patch of the same change replaced them", () => {
		const cache = new TileCache()

		cache.put(tile(0, 0, []))
		cache.put(tile(1, 0, []))
		cache.put(tile(2, 0, []))
		cache.invalidate({ sheet: 1, startRow: 64, startCol: 0, endRow: 1_048_575, endCol: 16_383 }, new Set([tileKey(1, 2, 0)]))

		expect(cache.has(tileKey(1, 0, 0))).toBe(true)
		expect(cache.has(tileKey(1, 1, 0))).toBe(false)
		expect(cache.has(tileKey(1, 2, 0))).toBe(true)
	})

	it("reads runs and repeat fills from tables not sorted by entry, runs in table order, first repeat winning", () => {
		const base = tile(0, 0, [
			[0, 0, "abc"],
			[0, 1, "def"],
			[0, 2, "ghi"]
		])
		const layered: SheetTile = {
			...base,
			layers: {
				runs: {
					runEntries: Uint16Array.of(2, 0, 2, 0),
					runStarts: Uint32Array.of(0, 0, 2, 1),
					runStyles: Uint32Array.of(5, 6, 7, 8)
				},
				repeats: { entries: Uint16Array.of(2, 0, 2), offsets: Uint32Array.of(1, 3, 9), chars: ["-", "*", "="] }
			}
		}

		expect(entryRuns(layered, 0)).toEqual([0, 6, 1, 8])
		expect(entryRuns(layered, 1)).toBeNull()
		expect(entryRuns(layered, 2)).toEqual([0, 5, 2, 7])
		expect(entryRuns(layered, 9)).toBeNull()
		expect(entryRepeat(layered, 0)).toEqual({ offset: 3, char: "*" })
		expect(entryRepeat(layered, 1)).toBeNull()
		expect(entryRepeat(layered, 2)).toEqual({ offset: 1, char: "-" })
		expect(entryRuns(base, 0)).toBeNull()
		expect(entryRepeat(base, 0)).toBeNull()

		// A tile held by the cache shares the layers: same answers.
		const held = new TileCache().put(layered)

		expect(entryRuns(held, 2)).toEqual([0, 5, 2, 7])
		expect(entryRepeat(held, 0)).toEqual({ offset: 3, char: "*" })
	})

	it("looks runs and repeats up in at most 10 ms of CPU for 10 frames of 1500 cells of a 2048-entry rich tile", () => {
		const ENTRIES = 2048
		const RUNS_PER_ENTRY = 3
		const total = ENTRIES * RUNS_PER_ENTRY
		const runEntries = new Uint16Array(total)
		const runStarts = new Uint32Array(total)
		const runStyles = new Uint32Array(total)

		// Interleaved by run index so the table is not grouped by entry.
		for (let r = 0; r < RUNS_PER_ENTRY; r++)
			for (let e = 0; e < ENTRIES; e++) {
				const i = r * ENTRIES + e

				runEntries[i] = e
				runStarts[i] = r
				runStyles[i] = e + r
			}

		const repeatEntries = Uint16Array.from({ length: ENTRIES }, (_, e) => ENTRIES - 1 - e)
		const make = (): SheetTile => ({
			sheet: 1,
			tileRow: 0,
			tileCol: 0,
			version: 1,
			count: ENTRIES,
			positions: Uint16Array.from({ length: ENTRIES }, (_, e) => e),
			texts: new Int32Array(ENTRIES).fill(-1),
			inputs: new Int32Array(ENTRIES).fill(-1),
			styles: new Uint32Array(ENTRIES),
			flags: new Uint32Array(ENTRIES).fill(CellFlag.RICH | CellFlag.REPEAT),
			strings: [],
			layers: {
				runs: { runEntries, runStarts: runStarts.slice(), runStyles },
				repeats: { entries: repeatEntries, offsets: new Uint32Array(ENTRIES), chars: new Array<string>(ENTRIES).fill("-") }
			}
		})
		let best = Number.POSITIVE_INFINITY
		let found = 0

		for (let run = 0; run < 3; run++) {
			// A fresh tile each run: the cost includes indexing it.
			const subject = make()
			const start = cpuMs()

			for (let frame = 0; frame < 10; frame++)
				for (let cell = 0; cell < 750; cell++) {
					const entry = (cell * 7 + frame) % ENTRIES

					// Painting asks twice per cell.
					for (let twice = 0; twice < 2; twice++) {
						found += entryRuns(subject, entry)?.length ?? 0
						found += entryRepeat(subject, entry) === null ? 0 : 1
					}
				}

			best = Math.min(best, cpuMs() - start)
		}

		expect(found).toBe(3 * 10 * 750 * 2 * (RUNS_PER_ENTRY * 2 + 1))
		expect(best).toBeLessThan(10)
	})
})
