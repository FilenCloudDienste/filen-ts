import { beforeEach, describe, expect, it, vi } from "vitest"

const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	},
	kvDelete: (key: string) => {
		kvStore.delete(key)

		return Promise.resolve()
	}
}))

import {
	EMPTY_LAYER,
	SIZE_LAYER_LIMIT,
	followShift,
	layeredSheet,
	loadLayer,
	saveLayer,
	updateLayer
} from "@/features/spreadsheet/lib/sizeLayer"

beforeEach(() => {
	kvStore.clear()
})

describe("updateLayer", () => {
	it("sets and clears one sheet's axis, dropping a sheet left with nothing", () => {
		const set = updateLayer(EMPTY_LAYER, 1, "cols", [[2, 120]])

		expect(set.get(1)?.cols.get(2)).toBe(120)

		const cleared = updateLayer(set, 1, "cols", [[2, null]])

		expect(cleared.has(1)).toBe(false)
	})
})

describe("persistence", () => {
	it("round-trips a layer under the file's stable id", async () => {
		const layer = updateLayer(updateLayer(EMPTY_LAYER, 0, "cols", [[1, 99]]), 2, "rows", [[4, 40]])

		await saveLayer({ kind: "stable", id: "s1" }, layer)

		const loaded = await loadLayer({ kind: "stable", id: "s1" })

		expect(loaded.get(0)?.cols.get(1)).toBe(99)
		expect(loaded.get(2)?.rows.get(4)).toBe(40)
	})

	it("reads a corrupt entry as empty", async () => {
		kvStore.set("spreadsheet.sizes.v1.bad", { sheets: 42 })

		expect((await loadLayer({ kind: "stable", id: "bad" })).size).toBe(0)
	})

	it("keeps session layers in memory only", async () => {
		await saveLayer({ kind: "session", id: "doc-1" }, updateLayer(EMPTY_LAYER, 0, "cols", [[0, 70]]))

		expect(kvStore.size).toBe(0)
		expect((await loadLayer({ kind: "session", id: "doc-1" })).get(0)?.cols.get(0)).toBe(70)
	})

	it("forgets the oldest file past the limit", async () => {
		const layer = updateLayer(EMPTY_LAYER, 0, "cols", [[0, 70]])

		for (let index = 0; index <= SIZE_LAYER_LIMIT; index++) {
			await saveLayer({ kind: "stable", id: `f${String(index)}` }, layer)
		}

		expect(kvStore.has("spreadsheet.sizes.v1.f0")).toBe(false)
		expect(kvStore.has(`spreadsheet.sizes.v1.f${String(SIZE_LAYER_LIMIT)}`)).toBe(true)
		expect(kvStore.get("spreadsheet.sizes.index.v1")).toHaveLength(SIZE_LAYER_LIMIT)
	})

	it("deletes a file's entry once its layer is empty", async () => {
		await saveLayer({ kind: "stable", id: "s2" }, updateLayer(EMPTY_LAYER, 0, "cols", [[0, 70]]))
		await saveLayer({ kind: "stable", id: "s2" }, EMPTY_LAYER)

		expect(kvStore.has("spreadsheet.sizes.v1.s2")).toBe(false)
		expect(kvStore.get("spreadsheet.sizes.index.v1")).toEqual([])
	})
})

describe("layeredSheet", () => {
	it("lays local sizes over the file's, and returns the sheet itself with none", () => {
		const sheet = { colWidths: new Map([[0, 40]]), rowHeights: new Map<number, number>() }

		expect(layeredSheet(sheet, undefined)).toBe(sheet)
		expect(layeredSheet(sheet, { cols: new Map([[0, 80]]), rows: new Map() }).colWidths.get(0)).toBe(80)
	})

	// sheetRows/sheetCols memoize by map identity: an unchanged layer must not rebuild the axes.
	it("returns the same sheet for the same sheet and sizes", () => {
		const sheet = { colWidths: new Map([[0, 40]]), rowHeights: new Map<number, number>() }
		const sizes = { cols: new Map([[1, 80]]), rows: new Map<number, number>() }

		expect(layeredSheet(sheet, sizes)).toBe(layeredSheet(sheet, sizes))
	})
})

describe("followShift", () => {
	const layer = updateLayer(EMPTY_LAYER, 0, "rows", [
		[1, 40],
		[3, 50],
		[5, 60]
	])

	function rows(next: ReturnType<typeof followShift>): [number, number][] {
		return [...(next.layer.get(0)?.rows ?? [])].sort((a, b) => a[0] - b[0])
	}

	it("moves sizes past an inserted run", () => {
		expect(rows(followShift(layer, 0, { axis: "rows", type: "insert", at: 2, count: 2, revert: false }, []))).toEqual([
			[1, 40],
			[5, 50],
			[7, 60]
		])
	})

	it("gives an undone delete its sizes back", () => {
		const deleted = followShift(layer, 0, { axis: "rows", type: "delete", at: 2, count: 2, revert: false }, [])

		expect(rows(deleted)).toEqual([
			[1, 40],
			[3, 60]
		])

		const undone = followShift(deleted.layer, 0, { axis: "rows", type: "delete", at: 2, count: 2, revert: true }, deleted.stash)

		expect(rows(undone)).toEqual([
			[1, 40],
			[3, 50],
			[5, 60]
		])
		expect(undone.stash).toEqual([])
	})

	it("takes an undone insert's run back out", () => {
		const inserted = followShift(layer, 0, { axis: "rows", type: "insert", at: 2, count: 2, revert: false }, [])

		expect(
			rows(followShift(inserted.layer, 0, { axis: "rows", type: "insert", at: 2, count: 2, revert: true }, inserted.stash))
		).toEqual([
			[1, 40],
			[3, 50],
			[5, 60]
		])
	})

	it("leaves a sheet with no sizes on that axis alone", () => {
		const next = followShift(layer, 0, { axis: "cols", type: "insert", at: 0, count: 1, revert: false }, [])

		expect(next.layer).toBe(layer)
	})
})
