import type { AdvanceResult, ElementSample, LoopMode } from "@/features/audio/store/audioQueue"
import type { TrackEdges } from "@/features/audio/lib/smoothTransitions.types"

// Pure planning for smooth transitions: when an overlap starts and stops, how the two gains move, and which
// transitions play gapless instead. Times are ms unless a name says otherwise.

// Tracks outside these bounds never crossfade (audiobooks, mixes, jingles): a fade would eat a real part of them.
export const CROSSFADE_MIN_TRACK_MS = 10_000
export const CROSSFADE_MAX_TRACK_MS = 20 * 60_000

// Back-to-back gapless playback still overlaps this much, so the element switch never leaves an audible gap.
export const MICRO_OVERLAP_MS = 80

// A skip the user asked for, with the "short fade" setting.
export const MANUAL_FADE_MS = 1_500

// Edges analysed for a file whose length differs this much from what the element reports are for another
// encoding of it (or a misread VBR length) and are ignored.
const EDGE_DURATION_TOLERANCE_MS = 1_500

// Below this level a boundary second is silence: an ordinary album gap rather than one movement running into the next.
const BOUNDARY_SILENCE_DB = -50

const CURVE_POINTS = 64
const PEAK_STEP = 0.05

export interface TransitionTrackInfo {
	name: string
	durationMs: number
	album: string | null
	artist: string | null
}

export interface TransitionInput {
	out: TransitionTrackInfo
	in: TransitionTrackInfo
	outEdges: TrackEdges | null
	inEdges: TrackEdges | null
	// The incoming track follows the outgoing one in queue order with shuffle off.
	consecutive: boolean
	fadeSeconds: number
	// A crossfade was ruled out for this transition (the user sought into its window): gapless only.
	gaplessOnly: boolean
	// How long the incoming element takes to start once asked: a gapless switch is asked for that much earlier.
	startLatencyMs: number
}

// `crossfade`: overlap from `startAtMs` (outgoing position) for `inFadeMs`, the outgoing reaching 0 at `stopAtMs`, the
// incoming starting at `inStartMs`. `gapless`: the micro-overlap at the very end.
export interface TransitionPlan {
	kind: "crossfade" | "gapless"
	startAtMs: number
	stopAtMs: number
	inStartMs: number
	inFadeMs: number
}

export function crossfadeEligible(out: TransitionTrackInfo, incoming: TransitionTrackInfo, fadeMs: number): boolean {
	const minMs = Math.max(CROSSFADE_MIN_TRACK_MS, 3 * fadeMs)

	return [out, incoming].every(
		track => track.durationMs >= minMs && track.durationMs <= CROSSFADE_MAX_TRACK_MS && !track.name.toLowerCase().endsWith(".m4b")
	)
}

// Same non-null album and artist: tracks of one release.
export function sameRelease(
	a: { album: string | null; artist: string | null },
	b: { album: string | null; artist: string | null }
): boolean {
	return a.album !== null && a.album === b.album && a.artist === b.artist
}

// A run of one album played in order: gapless, unless both boundary seconds are known and silent (an ordinary album
// with gaps between tracks). Unknown edges and quiet segues fail safe to gapless.
export function continuousBoundary(input: TransitionInput): boolean {
	if (!input.consecutive || !sameRelease(input.out, input.in)) {
		return false
	}

	const tail = input.outEdges?.boundary?.tailDb
	const head = input.inEdges?.boundary?.headDb

	return !(tail !== undefined && head !== undefined && tail < BOUNDARY_SILENCE_DB && head < BOUNDARY_SILENCE_DB)
}

// Edges usable for a play of a file the element reports as `durationMs` long.
export function usableEdges(edges: TrackEdges | null, durationMs: number): TrackEdges | null {
	if (edges?.status !== "ok" || edges.durationSec === null) {
		return null
	}

	return Math.abs(edges.durationSec * 1000 - durationMs) <= EDGE_DURATION_TOLERANCE_MS ? edges : null
}

// The incoming is asked to play `startLatencyMs` ahead, so the overlap that is heard is the micro-overlap itself.
export function microOverlapPlan(outDurationMs: number, startLatencyMs = 0): TransitionPlan {
	return {
		kind: "gapless",
		startAtMs: Math.max(0, outDurationMs - MICRO_OVERLAP_MS - startLatencyMs),
		stopAtMs: outDurationMs,
		inStartMs: 0,
		inFadeMs: MICRO_OVERLAP_MS
	}
}

// The plan for a natural (not user-picked) transition. Null when the outgoing length is not known yet.
export function planTransition(input: TransitionInput): TransitionPlan | null {
	if (!(input.out.durationMs > 0)) {
		return null
	}

	const fadeMs = input.fadeSeconds * 1000

	if (input.gaplessOnly || !crossfadeEligible(input.out, input.in, fadeMs) || continuousBoundary(input)) {
		return microOverlapPlan(input.out.durationMs, input.startLatencyMs)
	}

	const outEdges = usableEdges(input.outEdges, input.out.durationMs)
	const inEdges = input.in.durationMs > 0 ? usableEdges(input.inEdges, input.in.durationMs) : null
	const endAt = input.out.durationMs - (outEdges?.outEndFromEndMs ?? 0)
	const fadeOutFromEnd = outEdges?.fadeOutFromEndMs ?? null
	const fadeOutStart = fadeOutFromEnd !== null ? input.out.durationMs - fadeOutFromEnd : null
	const early = fadeOutStart !== null && endAt - fadeOutStart > fadeMs
	const startAtMs = early ? fadeOutStart : endAt - fadeMs

	return {
		kind: "crossfade",
		startAtMs: Math.max(0, startAtMs),
		stopAtMs: early ? fadeOutStart + fadeMs : endAt,
		inStartMs: inEdges?.inStartMs ?? 0,
		inFadeMs: fadeMs
	}
}

// A skip the user asked for: the target starts at 0:00, both gains move over the short fade.
export function manualFadePlan(outPositionMs: number): TransitionPlan {
	return {
		kind: "crossfade",
		startAtMs: outPositionMs,
		stopAtMs: outPositionMs + MANUAL_FADE_MS,
		inStartMs: 0,
		inFadeMs: MANUAL_FADE_MS
	}
}

// Due once the outgoing plays inside the window.
export function shouldStartFade(sample: ElementSample, plan: TransitionPlan): boolean {
	return !sample.paused && !sample.ended && sample.currentTimeMs >= plan.startAtMs && sample.currentTimeMs < plan.stopAtMs
}

// The prepared transition no longer applies once the user seeks into or past its window.
export function seekCancelsCrossfade(targetMs: number, plan: TransitionPlan): boolean {
	return plan.kind === "crossfade" && targetMs >= plan.startAtMs
}

// Peaks rounded up, so the headroom never comes out short.
function quantisePeak(peak: number): number {
	return Math.min(1, Math.max(PEAK_STEP, Math.ceil(peak / PEAK_STEP - 1e-9) * PEAK_STEP))
}

export interface FadeCurves {
	out: Float32Array
	in: Float32Array
}

const curveCache = new Map<string, FadeCurves>()

// Equal-power curves (cos for the outgoing, sin for the incoming), shaped so the sum of the two signals at their known
// peaks never passes full scale: wherever pOut·cos + pIn·sin would exceed 1, both gains dip by the same factor. With
// matched loudness (typical peaks well under 0.7) that never happens and the curves stay pure equal-power. Both
// curves start and end at exactly 1 / 0, so neither edge jumps. Cached per quantised peak pair.
export function fadeCurves(outPeak: number, inPeak: number): FadeCurves {
	const pOut = quantisePeak(outPeak)
	const pIn = quantisePeak(inPeak)
	const key = `${pOut.toFixed(2)}:${pIn.toFixed(2)}`
	const cached = curveCache.get(key)

	if (cached !== undefined) {
		return cached
	}

	const out = new Float32Array(CURVE_POINTS)
	const incoming = new Float32Array(CURVE_POINTS)

	for (let i = 0; i < CURVE_POINTS; i++) {
		const theta = ((i / (CURVE_POINTS - 1)) * Math.PI) / 2
		const cos = i === CURVE_POINTS - 1 ? 0 : Math.cos(theta)
		const sin = i === 0 ? 0 : Math.sin(theta)
		const sum = pOut * cos + pIn * sin
		const shape = sum > 1 ? 1 / sum : 1

		out[i] = cos * shape
		incoming[i] = sin * shape
	}

	const curves = { out, in: incoming }

	curveCache.set(key, curves)

	return curves
}

// The value an automation curve holds `fraction` (0-1) of the way through, linearly interpolated as the browser
// does. Read instead of AudioParam.value, which Firefox does not update during automation.
export function curveValueAt(curve: Float32Array, fraction: number): number {
	const last = curve.length - 1

	if (last < 0) {
		return 1
	}

	const position = Math.min(1, Math.max(0, fraction)) * last
	const index = Math.floor(position)
	const from = curve[index] ?? 0
	const to = curve[Math.min(last, index + 1)] ?? from

	return from + (to - from) * (position - index)
}

// What the next-track decision was taken against. It stays the answer for the track end, the fade, a skip and a
// failure as long as none of these changed; a shuffle lap's reshuffle is random, so recomputing it would disagree with
// what was warmed.
export interface CommittedAdvance {
	advance: AdvanceResult
	// The queue array the decision was taken on: every queue replace or edit makes a new one.
	queue: readonly unknown[]
	fromIndex: number
	loopMode: LoopMode
	shuffleEnabled: boolean
	shuffleOrder: readonly number[]
}

export interface CommitKey {
	queue: readonly unknown[]
	currentIndex: number
	loopMode: LoopMode
	shuffleEnabled: boolean
	shuffleOrder: readonly number[]
}

export function committedValid(committed: CommittedAdvance | null, now: CommitKey): committed is CommittedAdvance {
	return (
		committed !== null &&
		committed.queue === now.queue &&
		committed.fromIndex === now.currentIndex &&
		committed.loopMode === now.loopMode &&
		committed.shuffleEnabled === now.shuffleEnabled &&
		committed.shuffleOrder === now.shuffleOrder
	)
}
