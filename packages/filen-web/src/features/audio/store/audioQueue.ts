import type { AnyFile } from "@filen/sdk-rs"

// Pure, DOM-free playback+queue logic for the audio module: the shuffle/loop math, next/previous
// resolution, the smart-previous rule, the replace-queue builder, the bounded auto-skip predicate and
// the foreground reconcile decision. Everything here is a plain function over plain values so the whole
// core is unit-testable with no <audio> element, no service worker and no store — mirrors the
// transfers store's own split (useTransfersStore.ts) where the aggregate math is exported and tested
// against plain arrays. The stateful pieces (the zustand store, the singleton engine) sit on top of
// this and only ever call into these functions.

export type LoopMode = "off" | "all" | "one"

// Four playback phases the store surfaces to the UI. "loading" spans source resolution (SW-stream
// registration or the whole-buffer blob download) up to the element actually starting; a settled
// end-of-queue with no loop lands on "paused" (or "idle" when the queue is empty).
export type AudioPlaybackStatus = "idle" | "loading" | "playing" | "paused"

// Everything needed to build a playable source for one track without re-listing the directory. `file`
// is the runtime SDK handle the bytes layer streams/downloads from; `contentType` is the allowlisted
// inline mime the SW route accepts, or null when the file can only play through the whole-buffer blob
// fallback (mediaType.ts's allowedMediaContentType semantics). The queue is never persisted, so holding
// the live `AnyFile` here is fine — it never has to survive a reload.
export interface QueueTrack {
	uuid: string
	name: string
	mime: string
	contentType: string | null
	file: AnyFile
}

// Past this many ms into the current track, "previous" restarts it instead of stepping back a track —
// the standard media-player affordance, matching mobile's 3s rule (audio.ts's previous()).
export const SMART_PREVIOUS_THRESHOLD_MS = 3_000

// The minimal read-only slice the navigation reducers need — decoupled from the full store shape and
// from QueueTrack so a test can drive them with plain numbers.
export interface QueueNav {
	queueLength: number
	currentIndex: number
	shuffleEnabled: boolean
	shuffleOrder: number[]
	loopMode: LoopMode
}

// A resolved "play this next" decision: the queue index to move to plus the shuffle order that should
// be in effect afterwards (recomputed when a shuffle pass wraps, so the engine and store never disagree
// about the order). null from computeNext/computePrevious means "nowhere to go" (queue end/start with
// looping off) and the caller settles instead.
export interface AdvanceResult {
	index: number
	shuffleOrder: number[]
}

// A permutation of [0, length) with `currentIndex` pinned first when it is in range (so toggling
// shuffle on mid-track keeps the current track playing), the rest Fisher–Yates shuffled. `random` is
// injectable purely so tests can assert current-first placement and permutation-completeness
// deterministically; production passes Math.random. A currentIndex outside the range yields a full,
// unanchored shuffle (used when a loop pass reshuffles with no track to preserve).
export function buildShuffleOrder(length: number, currentIndex: number, random: () => number = Math.random): number[] {
	if (length <= 0) {
		return []
	}

	const indices: number[] = []

	for (let i = 0; i < length; i++) {
		indices.push(i)
	}

	const anchored = currentIndex >= 0 && currentIndex < length
	const pool = anchored ? indices.filter(i => i !== currentIndex) : indices

	for (let i = pool.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1))
		const a = pool[i] ?? 0
		const b = pool[j] ?? 0

		pool[i] = b
		pool[j] = a
	}

	return anchored ? [currentIndex, ...pool] : pool
}

// Resolves the current shuffle order against the queue, rebuilding it anchored at the current index if
// it is stale (wrong length, or the current index isn't in it — e.g. the queue changed underneath a
// shuffle). Returns the order plus the current index's position within it.
function resolveShuffleOrder(nav: QueueNav, random: () => number): { order: number[]; position: number } {
	if (nav.shuffleOrder.length === nav.queueLength) {
		const position = nav.shuffleOrder.indexOf(nav.currentIndex)

		if (position !== -1) {
			return { order: nav.shuffleOrder, position }
		}
	}

	return { order: buildShuffleOrder(nav.queueLength, nav.currentIndex, random), position: 0 }
}

// The next index to play after the current track — shuffle- and loop-aware. Loop "one" is intentionally
// treated like "off" here (no wrap): restarting the same track is the caller's concern (handleTrackEnd),
// so both user-next and auto-advance step forward identically and only loop "all" wraps. On a shuffle
// pass wrapping under loop "all" the order is reshuffled so the next lap differs (mobile parity).
export function computeNext(nav: QueueNav, random: () => number = Math.random): AdvanceResult | null {
	if (nav.queueLength <= 0) {
		return null
	}

	if (nav.shuffleEnabled) {
		const { order, position } = resolveShuffleOrder(nav, random)
		const next = position + 1

		if (next < order.length) {
			return { index: order[next] ?? 0, shuffleOrder: order }
		}

		if (nav.loopMode === "all") {
			const reshuffled = buildShuffleOrder(nav.queueLength, -1, random)

			return { index: reshuffled[0] ?? 0, shuffleOrder: reshuffled }
		}

		return null
	}

	const next = nav.currentIndex + 1

	if (next < nav.queueLength) {
		return { index: next, shuffleOrder: nav.shuffleOrder }
	}

	return nav.loopMode === "all" ? { index: 0, shuffleOrder: nav.shuffleOrder } : null
}

// The previous index — the mirror of computeNext. A previous-wrap under loop "all" goes to the end of
// the SAME shuffle order (unlike next-wrap it does not reshuffle: stepping back should be deterministic,
// matching mobile's wrapToEnd).
export function computePrevious(nav: QueueNav, random: () => number = Math.random): AdvanceResult | null {
	if (nav.queueLength <= 0) {
		return null
	}

	if (nav.shuffleEnabled) {
		const { order, position } = resolveShuffleOrder(nav, random)
		const prev = position - 1

		if (prev >= 0) {
			return { index: order[prev] ?? 0, shuffleOrder: order }
		}

		if (nav.loopMode === "all") {
			return { index: order[order.length - 1] ?? 0, shuffleOrder: order }
		}

		return null
	}

	const prev = nav.currentIndex - 1

	if (prev >= 0) {
		return { index: prev, shuffleOrder: nav.shuffleOrder }
	}

	return nav.loopMode === "all" ? { index: nav.queueLength - 1, shuffleOrder: nav.shuffleOrder } : null
}

export type SmartPreviousResult = { kind: "restart" } | { kind: "index"; index: number; shuffleOrder: number[] }

// "Previous" with the restart-if-past-threshold rule: past the threshold, or when there is no earlier
// track to step to (queue start with looping off), it restarts the current track (seek to 0); otherwise
// it steps back one track.
export function smartPrevious(
	nav: QueueNav,
	positionMs: number,
	thresholdMs: number = SMART_PREVIOUS_THRESHOLD_MS,
	random: () => number = Math.random
): SmartPreviousResult {
	if (positionMs > thresholdMs) {
		return { kind: "restart" }
	}

	const prev = computePrevious(nav, random)

	if (prev === null) {
		return { kind: "restart" }
	}

	return { kind: "index", index: prev.index, shuffleOrder: prev.shuffleOrder }
}

export interface QueueLoad {
	queue: QueueTrack[]
	currentIndex: number
	shuffleOrder: number[]
}

// Builds the store state for a whole-queue replacement positioned at a given track — the folder-open
// and playlist-play entry point. Clamps the start index into range, and precomputes the shuffle order
// (anchored at the start track) when shuffle is on. Callers are expected to have already filtered out
// undecryptable tracks before building this list.
export function replaceQueueAtIndex(
	tracks: QueueTrack[],
	startIndex: number,
	shuffleEnabled: boolean,
	random: () => number = Math.random
): QueueLoad {
	if (tracks.length === 0) {
		return { queue: [], currentIndex: 0, shuffleOrder: [] }
	}

	const currentIndex = Math.max(0, Math.min(tracks.length - 1, startIndex))
	const shuffleOrder = shuffleEnabled ? buildShuffleOrder(tracks.length, currentIndex, random) : []

	return { queue: tracks, currentIndex, shuffleOrder }
}

// Bounds the failed-track auto-skip to a single pass over the queue: the engine increments a guard on
// every consecutive skip (reset to 0 on any successful play) and settles once this returns false, so a
// queue where every remaining track is broken can never spin forever. `queueLength` skips are allowed
// before settling.
export function withinSkipBudget(skipGuard: number, queueLength: number): boolean {
	return skipGuard <= queueLength
}

// A snapshot read straight off the media element, used by the foreground reconcile below. Times are ms.
export interface ElementSample {
	currentTimeMs: number
	durationMs: number
	paused: boolean
	ended: boolean
}

export interface ReconcileResult {
	positionMs: number
	durationMs: number
	status: AudioPlaybackStatus
	shouldAdvance: boolean
}

// On returning to a foreground tab, the throttled/coalesced background timers left the store's position
// and status stale while the element kept playing (and possibly ended). This re-derives them straight
// off a fresh element sample. If the element ended while the store still thinks it is playing, the
// caller advances the queue (the missed `ended` recovery); the resulting status is left to that advance,
// so `status` is unchanged in the ended case. A load in progress is never overridden.
export function reconcileVisibility(sample: ElementSample, currentStatus: AudioPlaybackStatus): ReconcileResult {
	const positionMs = Math.max(0, sample.currentTimeMs)
	const durationMs = Number.isFinite(sample.durationMs) && sample.durationMs > 0 ? sample.durationMs : 0

	if (currentStatus === "loading") {
		return { positionMs, durationMs, status: "loading", shouldAdvance: false }
	}

	if (sample.ended) {
		return { positionMs, durationMs, status: currentStatus, shouldAdvance: currentStatus === "playing" }
	}

	return { positionMs, durationMs, status: sample.paused ? "paused" : "playing", shouldAdvance: false }
}
