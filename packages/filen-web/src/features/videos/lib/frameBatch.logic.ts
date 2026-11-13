import type { KeyframeRef } from "@filen/shared/videos"
import { displaySize, fitInBox, type Size } from "@/lib/media/framePick.logic"

// A filmstrip's batch of keyframe stills: which keyframes a list of positions needs, in what order they are
// read, and the size each bitmap is made at. Plain and DOM-free; the frame worker does the reading and decoding.

// Keyframes one batch decodes at most, whatever the caller asks for: a call stays short enough to cancel
// promptly and its bitmaps few enough to hold (at a filmstrip's size, well under a megabyte each).
export const FRAME_BATCH_MAX_FRAMES = 24

// One keyframe to decode and the requested positions (indexes into the request) it stands for.
export interface FrameBatchSlot {
	ref: KeyframeRef
	positions: number[]
}

export interface FrameBatchPlan {
	// In file order, so the reads walk forward through the file.
	slots: FrameBatchSlot[]
	// Positions with no keyframe, or past the batch's cap: ask again in a later batch.
	skipped: number[]
}

// `refs[i]` is the keyframe for position i (null when the index had none). Positions sharing a keyframe
// share its slot; past `maxFrames` distinct keyframes, the rest are skipped.
export function planFrameBatch(refs: readonly (KeyframeRef | null)[], maxFrames: number): FrameBatchPlan {
	const cap = Math.max(0, Math.min(FRAME_BATCH_MAX_FRAMES, Math.floor(maxFrames)))
	const byOffset = new Map<number, FrameBatchSlot>()
	const skipped: number[] = []

	for (let i = 0; i < refs.length; i++) {
		const ref = refs[i] ?? null

		if (ref === null) {
			skipped.push(i)

			continue
		}

		const slot = byOffset.get(ref.offset)

		if (slot !== undefined) {
			slot.positions.push(i)
		} else if (byOffset.size < cap) {
			byOffset.set(ref.offset, { ref, positions: [i] })
		} else {
			skipped.push(i)
		}
	}

	return { slots: [...byOffset.values()].sort((a, b) => a.ref.offset - b.ref.offset), skipped }
}

// The size a frame's bitmap is made at: the picture as displayed (pixel aspect ratio applied, turned by
// `rotation`) fitted inside `box`, then given back in the decoded orientation, so the bitmap is stretched but
// not turned. Whoever draws it turns it, which the compositor does for free.
export function frameBitmapSize(visible: Size, par: number, rotation: number, box: Size): Size {
	const fitted = fitInBox(displaySize({ width: visible.width, height: visible.height, par, rotation }), box)

	return rotation % 180 === 0 ? fitted : { width: fitted.height, height: fitted.width }
}
