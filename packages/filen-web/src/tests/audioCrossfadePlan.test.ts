import { describe, expect, it } from "vitest"
import {
	committedValid,
	continuousBoundary,
	crossfadeEligible,
	curveValueAt,
	fadeCurves,
	manualFadePlan,
	microOverlapPlan,
	planTransition,
	seekCancelsCrossfade,
	shouldStartFade,
	usableEdges,
	MANUAL_FADE_MS,
	MICRO_OVERLAP_MS,
	type CommittedAdvance,
	type TransitionInput,
	type TransitionTrackInfo
} from "@/features/audio/lib/crossfade.logic"
import type { TrackEdges } from "@/features/audio/lib/smoothTransitions.types"

function info(overrides: Partial<TransitionTrackInfo> = {}): TransitionTrackInfo {
	return { name: "a.mp3", durationMs: 200_000, album: null, artist: null, ...overrides }
}

function edges(overrides: Partial<TrackEdges> = {}): TrackEdges {
	return {
		status: "ok",
		durationSec: 200,
		inStartMs: null,
		outEndFromEndMs: null,
		fadeOutFromEndMs: null,
		boundary: null,
		...overrides
	}
}

function input(overrides: Partial<TransitionInput> = {}): TransitionInput {
	return {
		out: info(),
		in: info({ name: "b.mp3" }),
		outEdges: null,
		inEdges: null,
		consecutive: false,
		fadeSeconds: 6,
		gaplessOnly: false,
		startLatencyMs: 0,
		...overrides
	}
}

describe("crossfadeEligible", () => {
	it("needs both tracks at least max(10 s, 3 × the fade) long", () => {
		expect(crossfadeEligible(info({ durationMs: 9_999 }), info(), 1_000)).toBe(false)
		expect(crossfadeEligible(info({ durationMs: 10_000 }), info(), 1_000)).toBe(true)
		expect(crossfadeEligible(info(), info({ durationMs: 35_999 }), 12_000)).toBe(false)
		expect(crossfadeEligible(info(), info({ durationMs: 36_000 }), 12_000)).toBe(true)
	})

	it("rules out tracks over 20 minutes and audiobooks", () => {
		expect(crossfadeEligible(info({ durationMs: 20 * 60_000 + 1 }), info(), 6_000)).toBe(false)
		expect(crossfadeEligible(info(), info({ name: "Chapter.M4B" }), 6_000)).toBe(false)
	})
})

describe("planTransition", () => {
	it("overlaps the last fade length without edges", () => {
		expect(planTransition(input())).toEqual({ kind: "crossfade", startAtMs: 194_000, stopAtMs: 200_000, inStartMs: 0, inFadeMs: 6_000 })
	})

	it("ends the fade where the outgoing audio ends and starts the incoming past its silence", () => {
		const plan = planTransition(input({ outEdges: edges({ outEndFromEndMs: 3_000 }), inEdges: edges({ inStartMs: 1_500 }) }))

		expect(plan).toEqual({ kind: "crossfade", startAtMs: 191_000, stopAtMs: 197_000, inStartMs: 1_500, inFadeMs: 6_000 })
	})

	it("keeps the late start when the track's own fade-out is shorter than the fade", () => {
		const plan = planTransition(input({ outEdges: edges({ fadeOutFromEndMs: 5_000 }) }))

		expect(plan?.startAtMs).toBe(194_000)
		expect(plan?.stopAtMs).toBe(200_000)
	})

	it("starts early at a long fade-out and still lasts the fade length", () => {
		const plan = planTransition(input({ outEdges: edges({ fadeOutFromEndMs: 15_000, outEndFromEndMs: 1_000 }) }))

		expect(plan).toEqual({ kind: "crossfade", startAtMs: 185_000, stopAtMs: 191_000, inStartMs: 0, inFadeMs: 6_000 })
	})

	it("clamps a fade-out longer than the analysed window to 18 s before the end", () => {
		// The analyser reports such a fade-out at the window's clamp: 18 s before the end.
		const plan = planTransition(input({ outEdges: edges({ fadeOutFromEndMs: 18_000 }) }))

		expect(plan?.startAtMs).toBe(182_000)
	})

	it("plays plain timing when the tail was all silence (end unknown)", () => {
		const plan = planTransition(input({ outEdges: edges({ outEndFromEndMs: null }) }))

		expect(plan?.startAtMs).toBe(194_000)
		expect(plan?.stopAtMs).toBe(200_000)
	})

	it("ignores edges analysed for another length of the file", () => {
		const plan = planTransition(
			input({ outEdges: edges({ durationSec: 190, outEndFromEndMs: 3_000 }), inEdges: edges({ durationSec: 150, inStartMs: 900 }) })
		)

		expect(plan).toEqual({ kind: "crossfade", startAtMs: 194_000, stopAtMs: 200_000, inStartMs: 0, inFadeMs: 6_000 })
		expect(usableEdges(edges({ durationSec: 201.4 }), 200_000)).not.toBeNull()
		expect(usableEdges(edges({ status: "skipped" }), 200_000)).toBeNull()
	})

	it("plays gapless where a crossfade does not belong", () => {
		expect(planTransition(input({ out: info({ durationMs: 8_000 }) }))?.kind).toBe("gapless")
		expect(planTransition(input({ gaplessOnly: true }))?.kind).toBe("gapless")
		expect(planTransition(input({ in: info({ durationMs: 0 }) }))?.kind).toBe("gapless")
	})

	it("waits for the outgoing length", () => {
		expect(planTransition(input({ out: info({ durationMs: 0 }) }))).toBeNull()
	})
})

describe("continuous album boundary", () => {
	const album = { album: "Kind of Blue", artist: "Miles Davis" }
	const quiet = (tailDb: number, headDb: number) => ({
		outEdges: edges({ boundary: { headDb: -20, tailDb } }),
		inEdges: edges({ boundary: { headDb, tailDb: -20 } })
	})

	it("plays the same album and artist in order gapless", () => {
		const plan = planTransition(input({ out: info(album), in: info({ ...album, name: "b.mp3" }), consecutive: true }))

		expect(plan).toEqual(microOverlapPlan(200_000))
	})

	it("crossfades an album with real gaps between its tracks", () => {
		const boundary = input({ out: info(album), in: info({ ...album, name: "b.mp3" }), consecutive: true, ...quiet(-70, -65) })

		expect(continuousBoundary(boundary)).toBe(false)
		expect(planTransition(boundary)?.kind).toBe("crossfade")
	})

	it("fails safe to gapless on unknown or one-sided edges and quiet segues", () => {
		const base = { out: info(album), in: info({ ...album, name: "b.mp3" }), consecutive: true }

		expect(continuousBoundary(input({ ...base, ...quiet(-70, -30) }))).toBe(true)
		expect(continuousBoundary(input({ ...base, outEdges: edges({ boundary: { headDb: -20, tailDb: -70 } }) }))).toBe(true)
	})

	it("crossfades another artist's track and anything shuffled", () => {
		expect(planTransition(input({ out: info(album), in: info({ ...album, artist: "Other" }), consecutive: true }))?.kind).toBe(
			"crossfade"
		)
		expect(planTransition(input({ out: info(album), in: info({ ...album, name: "b.mp3" }), consecutive: false }))?.kind).toBe(
			"crossfade"
		)
	})
})

describe("manual and micro-overlap plans", () => {
	it("fades a skip over the short fade from where the outgoing is, into 0:00", () => {
		expect(manualFadePlan(42_000)).toEqual({
			kind: "crossfade",
			startAtMs: 42_000,
			stopAtMs: 42_000 + MANUAL_FADE_MS,
			inStartMs: 0,
			inFadeMs: MANUAL_FADE_MS
		})
	})

	it("asks for a gapless switch early by the incoming's start latency", () => {
		expect(microOverlapPlan(30_000, 60).startAtMs).toBe(30_000 - MICRO_OVERLAP_MS - 60)
		expect(planTransition(input({ gaplessOnly: true, startLatencyMs: 40 }))?.startAtMs).toBe(200_000 - MICRO_OVERLAP_MS - 40)
	})

	it("overlaps a gapless switch by 80 ms at the very end", () => {
		expect(microOverlapPlan(30_000)).toEqual({
			kind: "gapless",
			startAtMs: 30_000 - MICRO_OVERLAP_MS,
			stopAtMs: 30_000,
			inStartMs: 0,
			inFadeMs: MICRO_OVERLAP_MS
		})
	})
})

describe("triggers", () => {
	const plan = { kind: "crossfade" as const, startAtMs: 100_000, stopAtMs: 106_000, inStartMs: 0, inFadeMs: 6_000 }
	const sample = (currentTimeMs: number, paused = false) => ({ currentTimeMs, durationMs: 106_000, paused, ended: false })

	it("starts only while playing inside the window", () => {
		expect(shouldStartFade(sample(99_999), plan)).toBe(false)
		expect(shouldStartFade(sample(100_000), plan)).toBe(true)
		expect(shouldStartFade(sample(100_500, true), plan)).toBe(false)
		expect(shouldStartFade(sample(106_000), plan)).toBe(false)
	})

	it("cancels the crossfade on a seek into or past its window, not before it", () => {
		expect(seekCancelsCrossfade(99_000, plan)).toBe(false)
		expect(seekCancelsCrossfade(100_000, plan)).toBe(true)
		expect(seekCancelsCrossfade(150_000, plan)).toBe(true)
		expect(seekCancelsCrossfade(150_000, microOverlapPlan(106_000))).toBe(false)
	})
})

describe("fade curves", () => {
	it("is pure equal power at matched loudness", () => {
		const { out, in: incoming } = fadeCurves(0.5, 0.5)

		for (let i = 0; i < out.length; i++) {
			expect((out[i] ?? 0) ** 2 + (incoming[i] ?? 0) ** 2).toBeCloseTo(1, 5)
		}
	})

	it("starts and ends exactly at full and silent, so no edge jumps", () => {
		const { out, in: incoming } = fadeCurves(1, 1)

		expect(out[0]).toBe(1)
		expect(out[out.length - 1]).toBe(0)
		expect(incoming[0]).toBe(0)
		expect(incoming[incoming.length - 1]).toBe(1)
	})

	it("never lets the summed peaks pass full scale", () => {
		for (const [pOut, pIn] of [
			[1, 1],
			[1, 0.6],
			[0.8, 0.95],
			[0.33, 1]
		] as const) {
			const curves = fadeCurves(pOut, pIn)

			for (let step = 0; step <= 200; step++) {
				const x = step / 200

				expect(pOut * curveValueAt(curves.out, x) + pIn * curveValueAt(curves.in, x)).toBeLessThanOrEqual(1 + 1e-6)
			}
		}
	})

	it("dips the midpoint only as far as the peaks require", () => {
		const { out } = fadeCurves(1, 1)
		const mid = curveValueAt(out, 0.5)

		expect(mid).toBeGreaterThan(0.45)
		expect(mid).toBeLessThan(Math.SQRT1_2)
	})

	it("caches one pair per rounded peak pair", () => {
		expect(fadeCurves(0.71, 0.4)).toBe(fadeCurves(0.72, 0.38))
	})

	it("reads a held value between points", () => {
		const curve = new Float32Array([1, 0])

		expect(curveValueAt(curve, 0.25)).toBeCloseTo(0.75)
		expect(curveValueAt(curve, -1)).toBe(1)
		expect(curveValueAt(curve, 2)).toBe(0)
	})
})

describe("committedValid", () => {
	const queue: unknown[] = []
	const order = [2, 0, 1]
	const committed: CommittedAdvance = {
		advance: { index: 0, shuffleOrder: order },
		queue,
		fromIndex: 1,
		loopMode: "all",
		shuffleEnabled: true,
		shuffleOrder: order
	}
	const key = { queue, currentIndex: 1, loopMode: "all" as const, shuffleEnabled: true, shuffleOrder: order }

	it("holds while nothing it was taken against changed", () => {
		expect(committedValid(committed, key)).toBe(true)
		expect(committedValid(null, key)).toBe(false)
	})

	it("breaks on another queue, index, loop mode, shuffle flag or order", () => {
		expect(committedValid(committed, { ...key, queue: [] })).toBe(false)
		expect(committedValid(committed, { ...key, currentIndex: 2 })).toBe(false)
		expect(committedValid(committed, { ...key, loopMode: "off" })).toBe(false)
		expect(committedValid(committed, { ...key, shuffleEnabled: false })).toBe(false)
		expect(committedValid(committed, { ...key, shuffleOrder: [2, 0, 1] })).toBe(false)
	})
})
