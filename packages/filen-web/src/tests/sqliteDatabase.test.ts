import { describe, expect, it, vi } from "vitest"
import type * as Comlink from "comlink"
import type { AnyFile } from "@filen/sdk-rs"
import type { SqliteBrowseWorkerApi } from "@/features/preview/workers/sqliteBrowse.worker"
import { SqliteUnreadable } from "@/features/preview/lib/sqliteBrowser"
import { INTERRUPT_COUNT, INTERRUPT_TILES, SQLITE_INTERRUPT_SLOTS, SQLITE_TILE_ROWS } from "@/features/preview/lib/sqliteBrowse.logic"
import { readsInRanges, sqliteReads } from "@/features/preview/lib/sqliteDatabase"

vi.mock("@/features/preview/workers/sqliteBrowse.worker.ts?worker", () => ({ default: vi.fn() }))

// The grid's reads of an open database: stale tile requests and a count a grid read went ahead of are named in the
// interrupt flag, one cell is read once for both its readers, a failed read reaches the viewer, and a database the
// check reads whole anyway is read whole once.

type Remote = Comlink.Remote<SqliteBrowseWorkerApi>

function worker(remote: Partial<Record<keyof SqliteBrowseWorkerApi, (...args: never[]) => unknown>>) {
	return { run: <R>(call: (r: Remote) => Promise<R>) => call(remote as unknown as Remote) }
}

function slots(): Int32Array {
	return new Int32Array(new SharedArrayBuffer(4 * SQLITE_INTERRUPT_SLOTS))
}

describe("sqlite grid reads", () => {
	it("marks every earlier tile request stale, and stops the count in flight on a grid read", async () => {
		const interrupt = slots()
		const pendingCount = Promise.withResolvers<null>()
		const tiles = vi.fn(() => Promise.resolve([]))
		const reads = sqliteReads(worker({ tiles, count: () => pendingCount.promise }), interrupt)

		void reads.count(0, 1000)
		await reads.reads(0).tiles(0, Uint32Array.of(0, 0))
		await reads.reads(0).tiles(0, Uint32Array.of(1, 0))

		const [, , , firstId] = tiles.mock.calls[0] as unknown as [number, number, Uint32Array, number]
		const [, , , secondId] = tiles.mock.calls[1] as unknown as [number, number, Uint32Array, number]

		expect(Atomics.load(interrupt, INTERRUPT_TILES)).toBe(secondId - 1)
		expect(firstId).toBeLessThan(secondId)
		// The count was the first request.
		expect(Atomics.load(interrupt, INTERRUPT_COUNT)).toBe(1)
		pendingCount.resolve(null)
	})

	it("passes the step's size, stops the step in flight when asked, and tracks how far the grid read", async () => {
		const interrupt = slots()
		const pendingCount = Promise.withResolvers<null>()
		const count = vi.fn(() => pendingCount.promise)
		const reads = sqliteReads(worker({ tiles: () => Promise.resolve([]), count }), interrupt)
		const reached: [number, number][] = []

		reads.onReach((table, row) => reached.push([table, row]))

		void reads.count(3, 256)
		await Promise.resolve()
		expect(count).toHaveBeenCalledWith(3, 1, 256)

		reads.stopCount()
		expect(Atomics.load(interrupt, INTERRUPT_COUNT)).toBe(1)

		// Tile row 2 of a window at row 1,000: its last data row is 1,000 + 3 × 64 − 1.
		await reads.reads(3).tiles(1000, Uint32Array.of(0, 0, 2, 1))
		await reads.reads(3).tiles(1000, Uint32Array.of(1, 0))

		expect(reads.reach(3)).toBe(1000 + 3 * SQLITE_TILE_ROWS - 1)
		expect(reached).toEqual([[3, 1000 + 3 * SQLITE_TILE_ROWS - 1]])
		pendingCount.resolve(null)
	})

	it("reads one cell once for both its readers, and asks again after a failure", async () => {
		const cell = vi.fn().mockRejectedValueOnce(new Error("gone")).mockResolvedValue({ type: "text", bytes: 1, value: "a" })
		const table = sqliteReads(worker({ cell }), slots()).reads(0)

		await expect(table.cell(0, 1, 0)).rejects.toThrow()
		await Promise.all([table.cell(0, 1, 0), table.cell(0, 1, 0)])

		expect(cell).toHaveBeenCalledTimes(2)
	})

	it("tells the viewer when a read failed", async () => {
		const reads = sqliteReads(worker({ tiles: () => Promise.reject(new SqliteUnreadable("deadline")) }), slots())
		const listener = vi.fn()

		reads.onUnreadable(listener)
		await expect(reads.reads(0).tiles(0, Uint32Array.of(0, 0))).rejects.toThrow()

		expect(listener).toHaveBeenCalledOnce()
	})

	it("reads a drive file in ranges only past the check's size", () => {
		const file = (size: number) => ({ kind: "file", file: { size: BigInt(size) } as unknown as AnyFile }) as const

		expect(readsInRanges(file(256 * 1024 * 1024))).toBe(false)
		expect(readsInRanges(file(256 * 1024 * 1024 + 1))).toBe(true)
		expect(readsInRanges({ kind: "bytes", blob: { size: 512 * 1024 * 1024 } as Blob, cacheKey: "k" })).toBe(false)
	})
})
