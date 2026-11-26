import { sniffImage } from "@/features/preview/lib/imageSniff/sniffImage"
import { startsWith, viewOf } from "@/features/preview/lib/imageSniff/bytes"
import type { MediaAction } from "@/lib/media/keymap"
import { stepPlaybackRate } from "@/lib/media/videoKeys.logic"

// Animated images in the preview: which files may animate, what their head says, and the frame clock's rules.

// The extensions whose files may hold an animation ImageDecoder plays; their bytes decide.
export const ANIMATABLE_EXTENSIONS: ReadonlySet<string> = new Set(["gif", "png", "apng", "webp", "avif", "avifs"])

// The decoder types an animation plays under (APNG decodes as image/png).
const ANIMATED_TYPES: ReadonlySet<string> = new Set(["image/gif", "image/png", "image/webp", "image/avif"])

// The brands of an ISOBMFF "ftyp" box (major, then compatible), or an empty list. An AVIF image sequence without a
// still item carries no meta box for the HEIF sniff to read; its "avis" brand alone says it animates.
function ftypBrands(head: Uint8Array): string[] {
	if (!startsWith(head, [0x66, 0x74, 0x79, 0x70], 4) || head.length < 16) {
		return []
	}

	const view = viewOf(head)
	const end = Math.min(view.getUint32(0), head.length)
	const brands: string[] = []

	for (let at = 8; at + 4 <= end; at += at === 8 ? 8 : 4) {
		brands.push(String.fromCharCode(...head.subarray(at, at + 4)))
	}

	return brands
}

// The ImageDecoder type of an animation, from the file's head (the whole file when held): a GIF with more than one
// image (or a looping block before a head cut short), a PNG with acTL before its first IDAT, a WebP with the VP8X
// animation flag or an ANIM chunk, an AVIF image sequence. Null for a still or anything else.
export function animatedImageType(head: Uint8Array, totalSize: number): string | null {
	const info = sniffImage(head, totalSize)

	if (info !== null) {
		return info.animated && ANIMATED_TYPES.has(info.mime) ? info.mime : null
	}

	return ftypBrands(head).includes("avis") ? "image/avif" : null
}

// A frame's delay as browsers show animated images: one of 10 ms or less (or none) lasts 100 ms. Chromium
// (DeferredImageDecoder::FrameDurationAtIndex), Firefox and WebKit all clamp so; ImageDecoder hands the raw value.
export const SHORT_FRAME_MAX_MS = 10
export const SHORT_FRAME_DELAY_MS = 100

// Milliseconds a frame shows at `rate`, from its VideoFrame duration (microseconds, null when unknown).
export function frameDelayMs(durationMicros: number | null, rate: number): number {
	const ms = durationMicros === null ? 0 : durationMicros / 1000
	const delay = ms <= SHORT_FRAME_MAX_MS ? SHORT_FRAME_DELAY_MS : ms

	return delay / (rate > 0 ? rate : 1)
}

export interface FramePosition {
	readonly index: number
	// Times the whole animation has played through.
	readonly plays: number
}

// The frame after `at`, or null once the last play has ended. `frameCount` is what the decoder knows so far and
// `complete` whether it has every byte: before then a frame past the known ones may still arrive. `repetitionCount`
// is ImageTrack's: repeats after the first play, Infinity for forever.
export function nextFramePosition(at: FramePosition, frameCount: number, complete: boolean, repetitionCount: number): FramePosition | null {
	if (at.index + 1 < frameCount || !complete) {
		return { index: at.index + 1, plays: at.plays }
	}

	const plays = at.plays + 1

	if (plays > repetitionCount) {
		return null
	}

	return { index: 0, plays }
}

// The frame a step of `direction` lands on, kept within the frames known (one past them while more may arrive).
export function stepFrameIndex(index: number, direction: 1 | -1, frameCount: number, complete: boolean): number {
	const last = complete ? frameCount - 1 : frameCount

	return Math.max(0, Math.min(last, index + direction))
}

// The media keys the player takes while focus is inside it: the seek keys step a frame, as the frame keys do.
export const ANIMATION_KEY_ACTIONS: readonly MediaAction[] = [
	"media.playPause",
	"media.seekBack",
	"media.seekForward",
	"media.frameBack",
	"media.frameForward",
	"media.toStart",
	"media.toEnd",
	"media.slower",
	"media.faster",
	"media.normalSpeed"
]

export type AnimationCommand =
	| { readonly type: "toggle" }
	| { readonly type: "step"; readonly direction: 1 | -1 }
	| { readonly type: "seek"; readonly to: "start" | "end" }
	| { readonly type: "rate"; readonly rate: number }

// What a media key does to an animation playing at `rate`; null for one it does not take.
export function animationKeyCommand(action: MediaAction, rate: number): AnimationCommand | null {
	switch (action) {
		case "media.playPause":
			return { type: "toggle" }
		case "media.seekBack":
		case "media.frameBack":
			return { type: "step", direction: -1 }
		case "media.seekForward":
		case "media.frameForward":
			return { type: "step", direction: 1 }
		case "media.toStart":
			return { type: "seek", to: "start" }
		case "media.toEnd":
			return { type: "seek", to: "end" }
		case "media.slower":
			return { type: "rate", rate: stepPlaybackRate(rate, -1) }
		case "media.faster":
			return { type: "rate", rate: stepPlaybackRate(rate, 1) }
		case "media.normalSpeed":
			return { type: "rate", rate: 1 }
		default:
			return null
	}
}
