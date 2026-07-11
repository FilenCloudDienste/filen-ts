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
	clampMdSplitRatio,
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
