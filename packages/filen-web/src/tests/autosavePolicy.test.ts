import { describe, expect, it } from "vitest"
import {
	AUTOSAVE_ENCRYPTED_BYTES,
	AUTOSAVE_LARGE_BYTES,
	AUTOSAVE_RETRY_MAX_MS,
	AUTOSAVE_SMALL_BYTES,
	AUTOSAVE_THROTTLE_MS,
	autosaveDueIn,
	autosaveTier,
	type AutosaveState
} from "@/features/presentation/lib/autosavePolicy"
import { AUTOSAVE_IDLE_MS } from "@/features/office/lib/officeAutosave"

// The deck autosave tiers by package size, at their boundaries, and when each tier lets a save run.

const MiB = 1024 * 1024

describe("presentation autosave tiers", () => {
	it("autosaves after 30 s idle up to and including 32 MiB", () => {
		for (const size of [0, 1, AUTOSAVE_SMALL_BYTES]) {
			expect(autosaveTier(size, false)).toEqual({ kind: "idle", idleMs: AUTOSAVE_IDLE_MS, minIntervalMs: AUTOSAVE_IDLE_MS })
		}

		expect(AUTOSAVE_SMALL_BYTES).toBe(32 * MiB)
	})

	it("waits the user's pause in the idle tier only", () => {
		expect(autosaveTier(1, false, 15_000)).toEqual({ kind: "idle", idleMs: 15_000, minIntervalMs: 15_000 })
		expect(autosaveTier(AUTOSAVE_SMALL_BYTES + 1, false, 15_000)).toMatchObject({ kind: "throttled", idleMs: AUTOSAVE_IDLE_MS })
	})

	it("throttles above 32 MiB up to and including 256 MiB", () => {
		for (const size of [AUTOSAVE_SMALL_BYTES + 1, AUTOSAVE_LARGE_BYTES]) {
			expect(autosaveTier(size, false)).toEqual({
				kind: "throttled",
				idleMs: AUTOSAVE_IDLE_MS,
				minIntervalMs: 5 * 60_000,
				minDirtyBytes: 1024,
				maxDirtyAgeMs: 5 * 60_000
			})
		}

		expect(AUTOSAVE_LARGE_BYTES).toBe(256 * MiB)
	})

	it("turns autosave off above 256 MiB, and for an encrypted deck above 64 MiB", () => {
		expect(autosaveTier(AUTOSAVE_LARGE_BYTES + 1, false)).toEqual({ kind: "off", reason: "large" })
		expect(autosaveTier(AUTOSAVE_ENCRYPTED_BYTES, true).kind).toBe("throttled")
		expect(autosaveTier(AUTOSAVE_ENCRYPTED_BYTES + 1, true)).toEqual({ kind: "off", reason: "encrypted" })
		expect(autosaveTier(AUTOSAVE_SMALL_BYTES, true).kind).toBe("idle")
		expect(autosaveTier(AUTOSAVE_LARGE_BYTES + 1, true)).toEqual({ kind: "off", reason: "encrypted" })
		expect(AUTOSAVE_ENCRYPTED_BYTES).toBe(64 * MiB)
	})
})

const T0 = 1_000_000

function state(overrides: Partial<AutosaveState>): AutosaveState {
	return { now: T0, dirty: true, lastEditAt: T0, firstUnsavedAt: T0, lastStoredAt: undefined, dirtyBytes: undefined, ...overrides }
}

describe("presentation autosave timing", () => {
	it("never autosaves a clean deck or one whose tier is off", () => {
		expect(autosaveDueIn(autosaveTier(1, false), state({ dirty: false }))).toBeUndefined()
		expect(autosaveDueIn(autosaveTier(AUTOSAVE_LARGE_BYTES + 1, false), state({ now: T0 + 3_600_000 }))).toBeUndefined()
	})

	it("saves a small deck 30 s after the last edit, and at most every 30 s", () => {
		const tier = autosaveTier(1 * MiB, false)

		expect(autosaveDueIn(tier, state({ now: T0 + 10_000 }))).toBe(20_000)
		expect(autosaveDueIn(tier, state({ now: T0 + 30_000 }))).toBe(0)
		expect(autosaveDueIn(tier, state({ now: T0 + 30_000, lastStoredAt: T0 + 10_000 }))).toBe(10_000)
	})

	it("backs off after failed saves: the tier's interval, doubled for each further failure, at most 30 minutes", () => {
		const tier = autosaveTier(1 * MiB, false)
		const failed = (failures: number, now: number) => state({ now, failures, lastFailedAt: T0 + 30_000 })

		expect(autosaveDueIn(tier, failed(1, T0 + 30_000))).toBe(30_000)
		expect(autosaveDueIn(tier, failed(2, T0 + 30_000))).toBe(60_000)
		expect(autosaveDueIn(tier, failed(3, T0 + 90_000))).toBe(60_000)
		expect(autosaveDueIn(tier, failed(40, T0 + 30_000))).toBe(AUTOSAVE_RETRY_MAX_MS)
		expect(autosaveDueIn(autosaveTier(100 * MiB, false), failed(1, T0 + 30_000))).toBe(AUTOSAVE_THROTTLE_MS)
		// None failed: as before.
		expect(autosaveDueIn(tier, state({ now: T0 + 30_000, failures: 0 }))).toBe(0)
	})

	it("waits for 1 KiB of net changes or five minutes in the 32–256 MiB tier", () => {
		const tier = autosaveTier(100 * MiB, false)

		// Idle and spaced, but only 10 bytes changed and the first change is a minute old.
		expect(autosaveDueIn(tier, state({ now: T0 + 60_000, lastEditAt: T0 + 20_000, dirtyBytes: 10 }))).toBe(
			AUTOSAVE_THROTTLE_MS - 60_000
		)
		// 1 KiB is enough once idle.
		expect(autosaveDueIn(tier, state({ now: T0 + 60_000, lastEditAt: T0 + 20_000, dirtyBytes: 1024 }))).toBe(0)
		// Unknown net bytes: only the age rule applies.
		expect(autosaveDueIn(tier, state({ now: T0 + AUTOSAVE_THROTTLE_MS, lastEditAt: T0 }))).toBe(0)
		// Five minutes between stored saves, however much changed.
		expect(autosaveDueIn(tier, state({ now: T0 + 60_000, lastEditAt: T0, lastStoredAt: T0, dirtyBytes: 1_000_000 }))).toBe(
			AUTOSAVE_THROTTLE_MS - 60_000
		)
		// Still typing: the idle wait comes first.
		expect(
			autosaveDueIn(tier, state({ now: T0 + AUTOSAVE_THROTTLE_MS, lastEditAt: T0 + AUTOSAVE_THROTTLE_MS - 1000, dirtyBytes: 5000 }))
		).toBe(AUTOSAVE_IDLE_MS - 1000)
	})
})
