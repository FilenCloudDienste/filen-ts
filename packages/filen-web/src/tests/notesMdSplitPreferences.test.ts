import { beforeEach, describe, expect, it, vi } from "vitest"

// Same mock boundary/shape as drive's preferences.test.ts: `@/lib/storage/adapter` itself, backed by
// an in-memory Map reset per test — kvGetJson/kvSetJson's own envelope+schema contract is already
// covered by adapter.test.ts.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

import {
	DEFAULT_MD_SPLIT_RATIO,
	MD_SPLIT_RATIO_MIN,
	MD_SPLIT_RATIO_MAX,
	MD_SPLIT_RATIO_STEP,
	clampMdSplitRatio,
	ratioFromKey,
	getMdSplitRatio,
	setMdSplitRatio
} from "@/features/notes/lib/preferences"

beforeEach(() => {
	kvStore.clear()
})

describe("clampMdSplitRatio", () => {
	it("passes a value already inside the range through unchanged", () => {
		expect(clampMdSplitRatio(0.5)).toBe(0.5)
	})

	it("clamps below MD_SPLIT_RATIO_MIN up to the floor", () => {
		expect(clampMdSplitRatio(0.01)).toBe(MD_SPLIT_RATIO_MIN)
		expect(clampMdSplitRatio(-1)).toBe(MD_SPLIT_RATIO_MIN)
	})

	it("clamps above MD_SPLIT_RATIO_MAX down to the ceiling", () => {
		expect(clampMdSplitRatio(0.99)).toBe(MD_SPLIT_RATIO_MAX)
		expect(clampMdSplitRatio(2)).toBe(MD_SPLIT_RATIO_MAX)
	})
})

describe("ratioFromKey", () => {
	it("widens the left pane by one step on ArrowRight", () => {
		expect(ratioFromKey("ArrowRight", 0.5)).toBeCloseTo(0.5 + MD_SPLIT_RATIO_STEP)
	})

	it("narrows the left pane by one step on ArrowLeft", () => {
		expect(ratioFromKey("ArrowLeft", 0.5)).toBeCloseTo(0.5 - MD_SPLIT_RATIO_STEP)
	})

	it("stays clamped at both bounds instead of stepping past them", () => {
		expect(ratioFromKey("ArrowLeft", MD_SPLIT_RATIO_MIN)).toBeCloseTo(MD_SPLIT_RATIO_MIN)
		expect(ratioFromKey("ArrowRight", MD_SPLIT_RATIO_MAX)).toBeCloseTo(MD_SPLIT_RATIO_MAX)
	})

	it("jumps straight to the clamps on Home/End", () => {
		expect(ratioFromKey("Home", 0.5)).toBe(MD_SPLIT_RATIO_MIN)
		expect(ratioFromKey("End", 0.5)).toBe(MD_SPLIT_RATIO_MAX)
	})

	it("returns null for a key the separator does not handle, so the caller leaves the event alone", () => {
		expect(ratioFromKey("a", 0.5)).toBeNull()
		expect(ratioFromKey("ArrowUp", 0.5)).toBeNull()
	})
})

describe("md split ratio: get/set", () => {
	it("returns the default when nothing is persisted", async () => {
		await expect(getMdSplitRatio()).resolves.toBe(DEFAULT_MD_SPLIT_RATIO)
	})

	it("roundtrips a stored in-range value through set/get", async () => {
		await setMdSplitRatio(0.35)

		await expect(getMdSplitRatio()).resolves.toBe(0.35)
	})

	it("clamps an out-of-range value on the way in (set), not just on read", async () => {
		await setMdSplitRatio(0.99)

		await expect(getMdSplitRatio()).resolves.toBe(MD_SPLIT_RATIO_MAX)
	})

	it("clamps a persisted-but-out-of-range value on the way out (get) too", async () => {
		// Simulates a value written before the clamp bounds existed/changed — getMdSplitRatio must not
		// trust a stored value blindly, even though setMdSplitRatio always clamps on write.
		kvStore.set("notes.mdSplitRatio.v1", 5)

		await expect(getMdSplitRatio()).resolves.toBe(MD_SPLIT_RATIO_MAX)
	})
})
