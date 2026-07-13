import { beforeEach, describe, expect, it, vi } from "vitest"

const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.has(key) ? kvStore.get(key) : null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)
		return Promise.resolve()
	}
}))

import {
	DENSITY_STEPS,
	DEFAULT_DENSITY_INDEX,
	clampDensityIndex,
	tileSizeForDensity,
	columnsForWidth,
	getPhotosGridDensity,
	setPhotosGridDensity
} from "@/features/photos/lib/gridDensity"

beforeEach(() => {
	kvStore.clear()
})

describe("clampDensityIndex", () => {
	it("clamps below zero up to 0", () => {
		expect(clampDensityIndex(-1)).toBe(0)
	})

	it("clamps above the last step down to the last index", () => {
		expect(clampDensityIndex(99)).toBe(DENSITY_STEPS.length - 1)
	})

	it("truncates a fractional index", () => {
		expect(clampDensityIndex(2.9)).toBe(2)
	})

	it("passes an in-range integer through unchanged", () => {
		expect(clampDensityIndex(3)).toBe(3)
	})
})

describe("tileSizeForDensity", () => {
	it("maps every step index to its DENSITY_STEPS value", () => {
		DENSITY_STEPS.forEach((size, index) => {
			expect(tileSizeForDensity(index)).toBe(size)
		})
	})

	it("clamps an out-of-range index instead of returning undefined", () => {
		expect(tileSizeForDensity(-5)).toBe(DENSITY_STEPS[0])
		expect(tileSizeForDensity(999)).toBe(DENSITY_STEPS[DENSITY_STEPS.length - 1])
	})

	it("the default index lands at the drive grid's own 176px tile width", () => {
		expect(tileSizeForDensity(DEFAULT_DENSITY_INDEX)).toBe(176)
	})

	it("is monotonically increasing across steps (smallest to largest)", () => {
		for (let i = 1; i < DENSITY_STEPS.length; i++) {
			expect(tileSizeForDensity(i)).toBeGreaterThan(tileSizeForDensity(i - 1))
		}
	})
})

describe("columnsForWidth", () => {
	it("computes an auto-fill column count from container width and tile size", () => {
		expect(columnsForWidth(1000, 176)).toBe(5) // floor(1000/176) = 5
	})

	it("never returns fewer than 1 column, even for a container narrower than one tile", () => {
		expect(columnsForWidth(50, 176)).toBe(1)
	})

	it("returns 1 for a zero-width container", () => {
		expect(columnsForWidth(0, 176)).toBe(1)
	})

	it("guards a non-positive tile size instead of dividing by zero", () => {
		expect(columnsForWidth(1000, 0)).toBe(1)
		expect(columnsForWidth(1000, -10)).toBe(1)
	})
})

describe("getPhotosGridDensity / setPhotosGridDensity", () => {
	it("defaults to DEFAULT_DENSITY_INDEX when nothing is persisted", async () => {
		expect(await getPhotosGridDensity()).toBe(DEFAULT_DENSITY_INDEX)
	})

	it("round-trips a persisted index", async () => {
		await setPhotosGridDensity(3)
		expect(await getPhotosGridDensity()).toBe(3)
	})

	it("clamps an out-of-range value on write", async () => {
		await setPhotosGridDensity(999)
		expect(await getPhotosGridDensity()).toBe(DENSITY_STEPS.length - 1)
	})

	it("clamps an out-of-range persisted value on read (a shrunk future DENSITY_STEPS must not brick a stale index)", async () => {
		kvStore.set("photos.gridDensity.v1", 999)
		expect(await getPhotosGridDensity()).toBe(DENSITY_STEPS.length - 1)
	})
})
