import { describe, expect, it } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import {
	buildShuffleOrder,
	computeNext,
	computePrevious,
	reconcileVisibility,
	replaceQueueAtIndex,
	smartPrevious,
	withinSkipBudget,
	type ElementSample,
	type LoopMode,
	type QueueNav,
	type QueueTrack
} from "@/features/audio/store/audioQueue"

// Pure-reducer coverage for the audio core — no store, no <audio>, no service worker (mirrors
// useTransfersStore.test.ts's plain-array approach for the transfers math).

// The reducers never read a track's fields (only its array position), so a placeholder file handle is
// enough for replaceQueueAtIndex's shape.
function track(uuid: string): QueueTrack {
	return { uuid, name: uuid, mime: "audio/mpeg", contentType: "audio/mpeg", file: {} as unknown as AnyFile }
}

function nav(overrides: Partial<QueueNav> = {}): QueueNav {
	return { queueLength: 3, currentIndex: 0, shuffleEnabled: false, shuffleOrder: [], loopMode: "off", ...overrides }
}

// Deterministic RNG that always picks index 0 in Fisher–Yates — lets the shuffle-dependent branches
// assert an exact resulting order.
const zeroRandom = (): number => 0

describe("buildShuffleOrder", () => {
	it("returns [] for an empty queue", () => {
		expect(buildShuffleOrder(0, 0)).toEqual([])
	})

	it("pins the current index first when in range", () => {
		for (let seed = 0; seed < 5; seed++) {
			const order = buildShuffleOrder(6, 3, () => seed / 5)

			expect(order[0]).toBe(3)
		}
	})

	it("is a complete permutation of [0, length)", () => {
		const order = buildShuffleOrder(8, 2, Math.random)

		expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
	})

	it("produces a full unanchored permutation when the index is out of range", () => {
		const order = buildShuffleOrder(4, -1, zeroRandom)

		expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
		expect(order.length).toBe(4)
	})
})

describe("computeNext", () => {
	it("returns null for an empty queue", () => {
		expect(computeNext(nav({ queueLength: 0 }))).toBeNull()
	})

	it("advances linearly mid-queue", () => {
		expect(computeNext(nav({ currentIndex: 1 }))).toEqual({ index: 2, shuffleOrder: [] })
	})

	it("returns null at the end with looping off", () => {
		expect(computeNext(nav({ currentIndex: 2, loopMode: "off" }))).toBeNull()
	})

	it("wraps to the start at the end with loop all", () => {
		expect(computeNext(nav({ currentIndex: 2, loopMode: "all" }))).toEqual({ index: 0, shuffleOrder: [] })
	})

	it("treats loop one like off for advancing (no wrap at the end)", () => {
		expect(computeNext(nav({ currentIndex: 2, loopMode: "one" }))).toBeNull()
	})

	it("treats loop one like off mid-queue (steps forward)", () => {
		expect(computeNext(nav({ currentIndex: 0, loopMode: "one" }))).toEqual({ index: 1, shuffleOrder: [] })
	})

	it("follows the shuffle order rather than the linear index", () => {
		const result = computeNext(nav({ shuffleEnabled: true, shuffleOrder: [2, 0, 1], currentIndex: 2 }))

		expect(result).toEqual({ index: 0, shuffleOrder: [2, 0, 1] })
	})

	it("reshuffles on a shuffle-pass wrap under loop all", () => {
		// currentIndex 1 is last in the order [2, 0, 1]; loop all → a fresh unanchored reshuffle.
		const result = computeNext(nav({ shuffleEnabled: true, shuffleOrder: [2, 0, 1], currentIndex: 1, loopMode: "all" }), zeroRandom)

		expect(result).not.toBeNull()
		expect([...(result?.shuffleOrder ?? [])].sort((a, b) => a - b)).toEqual([0, 1, 2])
	})

	it("rebuilds a stale (wrong-length) shuffle order anchored at the current index", () => {
		const result = computeNext(nav({ shuffleEnabled: true, shuffleOrder: [0, 1], currentIndex: 1, queueLength: 3 }), zeroRandom)

		expect(result).not.toBeNull()
		expect(result?.shuffleOrder[0]).toBe(1)
	})
})

describe("computePrevious", () => {
	it("steps back linearly mid-queue", () => {
		expect(computePrevious(nav({ currentIndex: 2 }))).toEqual({ index: 1, shuffleOrder: [] })
	})

	it("returns null at the start with looping off", () => {
		expect(computePrevious(nav({ currentIndex: 0, loopMode: "off" }))).toBeNull()
	})

	it("wraps to the end at the start with loop all", () => {
		expect(computePrevious(nav({ currentIndex: 0, loopMode: "all" }))).toEqual({ index: 2, shuffleOrder: [] })
	})

	it("follows the shuffle order backwards", () => {
		const result = computePrevious(nav({ shuffleEnabled: true, shuffleOrder: [2, 0, 1], currentIndex: 0 }))

		expect(result).toEqual({ index: 2, shuffleOrder: [2, 0, 1] })
	})

	it("wraps to the order's end at the start under shuffle + loop all (no reshuffle)", () => {
		const result = computePrevious(nav({ shuffleEnabled: true, shuffleOrder: [2, 0, 1], currentIndex: 2, loopMode: "all" }))

		expect(result).toEqual({ index: 1, shuffleOrder: [2, 0, 1] })
	})
})

describe("smartPrevious", () => {
	it("restarts the current track when past the threshold", () => {
		expect(smartPrevious(nav({ currentIndex: 2 }), 5_000, 3_000)).toEqual({ kind: "restart" })
	})

	it("steps back when under the threshold and a previous track exists", () => {
		expect(smartPrevious(nav({ currentIndex: 2 }), 1_000, 3_000)).toEqual({ kind: "index", index: 1, shuffleOrder: [] })
	})

	it("restarts when at the queue start under the threshold with looping off", () => {
		expect(smartPrevious(nav({ currentIndex: 0, loopMode: "off" }), 1_000, 3_000)).toEqual({ kind: "restart" })
	})
})

describe("replaceQueueAtIndex", () => {
	it("returns an empty load for no tracks", () => {
		expect(replaceQueueAtIndex([], 3, true)).toEqual({ queue: [], currentIndex: 0, shuffleOrder: [] })
	})

	it("clamps a start index above the range to the last track", () => {
		const load = replaceQueueAtIndex([track("a"), track("b")], 9, false)

		expect(load.currentIndex).toBe(1)
		expect(load.shuffleOrder).toEqual([])
	})

	it("clamps a negative start index to 0", () => {
		const load = replaceQueueAtIndex([track("a"), track("b")], -4, false)

		expect(load.currentIndex).toBe(0)
	})

	it("builds a current-first shuffle order when shuffle is on", () => {
		const load = replaceQueueAtIndex([track("a"), track("b"), track("c")], 1, true, zeroRandom)

		expect(load.currentIndex).toBe(1)
		expect(load.shuffleOrder[0]).toBe(1)
		expect([...load.shuffleOrder].sort((a, b) => a - b)).toEqual([0, 1, 2])
	})
})

describe("withinSkipBudget", () => {
	it("allows up to queueLength consecutive skips", () => {
		expect(withinSkipBudget(3, 3)).toBe(true)
	})

	it("stops once the budget is exceeded", () => {
		expect(withinSkipBudget(4, 3)).toBe(false)
	})
})

describe("reconcileVisibility", () => {
	function sample(overrides: Partial<ElementSample> = {}): ElementSample {
		return { currentTimeMs: 12_000, durationMs: 200_000, paused: false, ended: false, ...overrides }
	}

	it("keeps a load in progress untouched (no status change, no advance)", () => {
		const result = reconcileVisibility(sample(), "loading")

		expect(result.status).toBe("loading")
		expect(result.shouldAdvance).toBe(false)
	})

	it("advances when the element ended while the store still thinks it is playing", () => {
		const result = reconcileVisibility(sample({ ended: true, paused: true }), "playing")

		expect(result.shouldAdvance).toBe(true)
		expect(result.status).toBe("playing")
	})

	it("does not advance an ended element the store already settled", () => {
		const result = reconcileVisibility(sample({ ended: true, paused: true }), "paused")

		expect(result.shouldAdvance).toBe(false)
	})

	it("derives paused status from a paused element", () => {
		const result = reconcileVisibility(sample({ paused: true }), "playing")

		expect(result.status).toBe("paused")
		expect(result.shouldAdvance).toBe(false)
	})

	it("derives playing status from a live element", () => {
		expect(reconcileVisibility(sample({ paused: false }), "paused").status).toBe("playing")
	})

	it("clamps a negative position and a non-finite duration to 0", () => {
		const result = reconcileVisibility(sample({ currentTimeMs: -5, durationMs: Number.NaN }), "playing")

		expect(result.positionMs).toBe(0)
		expect(result.durationMs).toBe(0)
	})
})

// Exhaustive next/prev × shuffle × loop sweep — asserts every cell resolves without throwing and stays
// in range (or null), catching any index escaping [0, length).
describe("next/prev shuffle × loop matrix", () => {
	const loops: LoopMode[] = ["off", "all", "one"]

	for (const shuffleEnabled of [false, true]) {
		for (const loopMode of loops) {
			for (let currentIndex = 0; currentIndex < 3; currentIndex++) {
				it(`stays in range for shuffle=${String(shuffleEnabled)} loop=${loopMode} at ${String(currentIndex)}`, () => {
					const snapshot = nav({
						shuffleEnabled,
						loopMode,
						currentIndex,
						shuffleOrder: shuffleEnabled ? [2, 0, 1] : []
					})

					for (const result of [computeNext(snapshot), computePrevious(snapshot)]) {
						if (result !== null) {
							expect(result.index).toBeGreaterThanOrEqual(0)
							expect(result.index).toBeLessThan(3)
						}
					}
				})
			}
		}
	}
})
