import type { FileVerdict } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import { previewType } from "@/features/drive/lib/preview.logic"
import { isPhotoItem } from "@/features/photos/lib/predicate"
import { buildLapShuffleOrder, buildShuffleOrder } from "@/lib/shuffle"

// Pure order and dwell rules of the preview slideshow: which items take part, in which order, and when
// a slide is due. No DOM, no timers, no store.

// An image becomes animated only at runtime (the animated player reports it), so it is no kind of its own.
export type SlideKind = "image" | "video"

// Seconds each still image stays up.
export const SLIDESHOW_INTERVALS = [3, 5, 10, 20] as const

export const DEFAULT_SLIDESHOW_INTERVAL = 5

// A slide that never shows (load error, unsupported, a viewer that never reports) is left after this long from its mount.
export const SHOW_TIMEOUT_MS = 15_000

// `verdict` as isPhotoItem takes it: the store's when absent, none when null (the worker's case).
export function slideKindOf(item: DriveItem, verdict?: FileVerdict | null): SlideKind | null {
	if (!isPhotoItem(item, verdict)) {
		return null
	}

	return previewType(item, verdict) === "video" ? "video" : "image"
}

// `order` lists list indices of slideable items only; `position` is the current slide's place in it.
export interface SlideshowOrder {
	readonly order: readonly number[]
	readonly position: number
}

// Sequential: the slideable indices in list order, starting at `startIndex` or the next slideable one after it
// (the first when none follows). Shuffled: a permutation of them with that start first.
export function slideshowOrder(
	kinds: readonly (SlideKind | null)[],
	startIndex: number,
	shuffle: boolean,
	random: () => number = Math.random
): SlideshowOrder {
	const slideable: number[] = []
	let position = -1

	for (let i = 0; i < kinds.length; i++) {
		if (kinds[i] === null) {
			continue
		}

		if (position === -1 && i >= startIndex) {
			position = slideable.length
		}

		slideable.push(i)
	}

	if (slideable.length === 0) {
		return { order: [], position: 0 }
	}

	if (position === -1) {
		position = 0
	}

	if (!shuffle) {
		return { order: slideable, position }
	}

	return { order: buildShuffleOrder(slideable.length, position, random).map(p => slideable[p] ?? 0), position: 0 }
}

// One step, wrapping. A shuffled forward wrap starts a new lap (reshuffled, the slide just shown never first);
// stepping back never reshuffles.
export function nextSlide(order: SlideshowOrder, delta: 1 | -1, shuffle: boolean, random: () => number = Math.random): SlideshowOrder {
	const length = order.order.length

	if (length === 0) {
		return order
	}

	const next = order.position + delta

	if (next >= 0 && next < length) {
		return { order: order.order, position: next }
	}

	if (delta === -1) {
		return { order: order.order, position: length - 1 }
	}

	if (!shuffle) {
		return { order: order.order, position: 0 }
	}

	const sorted = [...order.order].sort((a, b) => a - b)
	const finished = sorted.indexOf(order.order[order.position] ?? -1)

	return { order: buildLapShuffleOrder(length, finished, random).map(p => sorted[p] ?? 0), position: 0 }
}

export interface SlideDueState {
	kind: SlideKind
	// The animated player plays this image (reported at runtime).
	animating: boolean
	// When the slide was first visible, null until then.
	shownAt: number | null
	mountedAt: number
	// An animated image's first loop or a video's end.
	mediaEnded: boolean
	intervalMs: number
	now: number
}

// An image is due once its interval ran from the moment it showed (and, when animated, its loop ended); a
// video once it ended. Any slide that has not shown is due after SHOW_TIMEOUT_MS from its mount.
export function slideDue(state: SlideDueState): boolean {
	if (state.shownAt === null) {
		return state.now - state.mountedAt >= SHOW_TIMEOUT_MS
	}

	if (state.kind === "video") {
		return state.mediaEnded
	}

	return state.now - state.shownAt >= state.intervalMs && (!state.animating || state.mediaEnded)
}
