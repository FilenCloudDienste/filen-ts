import type { AspectPreset } from "@/features/preview/imageEdit/types"
import { aspectRatio } from "@/features/preview/imageEdit/lib/recipe"
import type {
	TextOverlay,
	TimeRange,
	VideoAdjustments,
	VideoCrop,
	VideoEditRecipe,
	VideoRotation
} from "@/features/preview/videoEdit/types"

// The video editor's recipe as the editor changes it: the untouched recipe, the kept ranges (trim and cut-outs), the
// crop in display pixels, speed, gain and text. Pure; the export plan reads the same recipe (plan.ts).

export interface Size {
	width: number
	height: number
}

// A normalised rectangle (0..1 of a frame).
export interface NormalisedRect {
	x: number
	y: number
	width: number
	height: number
}

// The shortest kept range: shorter than this would be a flash nobody can see, and the copy path could shrink it away.
export const MIN_KEEP_SECONDS = 0.1

export const MIN_SPEED = 0.25
export const MAX_SPEED = 4
export const SPEED_PRESETS: readonly number[] = [0.25, 0.5, 1, 1.5, 2, 4]

export const MIN_GAIN_DB = -20
export const MAX_GAIN_DB = 20

// A text box's size as a fraction of the output height.
export const MIN_TEXT_SIZE = 0.02
export const MAX_TEXT_SIZE = 0.3
export const DEFAULT_TEXT_SIZE = 0.08

// The crop presets the Crop tab offers.
export const VIDEO_ASPECTS: readonly AspectPreset[] = ["free", "original", "square", "16:9", "9:16", "4:3"]

export const IDENTITY_VIDEO_ADJUSTMENTS: Readonly<VideoAdjustments> = Object.freeze({
	exposure: 0,
	brightness: 0,
	contrast: 0,
	highlights: 0,
	shadows: 0,
	warmth: 0,
	tint: 0,
	saturation: 0,
	vibrance: 0
})

export const VIDEO_ADJUSTMENT_KEYS: readonly (keyof VideoAdjustments)[] = [
	"exposure",
	"brightness",
	"contrast",
	"highlights",
	"shadows",
	"warmth",
	"tint",
	"saturation",
	"vibrance"
]

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}

// The recipe that changes nothing: the whole source kept, at its own size, speed and sound.
export function identityVideoRecipe(duration: number): VideoEditRecipe {
	return {
		keep: [{ start: 0, end: Math.max(0, duration) }],
		crop: null,
		rotate: 0,
		flipH: false,
		flipV: false,
		output: { resolution: "original", quality: "high" },
		audio: { mute: false, gainDb: 0, keepTracks: "first" },
		speed: 1,
		adjust: { ...IDENTITY_VIDEO_ADJUSTMENTS },
		filter: null,
		text: [],
		precise: false,
		removeLocation: false
	}
}

function sameKeepTracks(a: VideoEditRecipe["audio"]["keepTracks"], b: VideoEditRecipe["audio"]["keepTracks"]): boolean {
	if (a === "first" || b === "first") {
		return a === b
	}

	return a.length === b.length && a.every((track, index) => track === b[index])
}

// Whether `recipe` changes anything at all (what makes the editor dirty). `precise` and the output settings change
// nothing on their own: a save of an otherwise untouched recipe would only re-encode the same picture.
export function isIdentityVideoRecipe(recipe: VideoEditRecipe, duration: number): boolean {
	const only = recipe.keep.length === 1 ? recipe.keep[0] : undefined

	return (
		only !== undefined &&
		only.start <= 0 &&
		only.end >= duration &&
		recipe.crop === null &&
		recipe.rotate === 0 &&
		!recipe.flipH &&
		!recipe.flipV &&
		recipe.output.resolution === "original" &&
		!recipe.audio.mute &&
		recipe.audio.gainDb === 0 &&
		sameKeepTracks(recipe.audio.keepTracks, "first") &&
		recipe.speed === 1 &&
		VIDEO_ADJUSTMENT_KEYS.every(key => recipe.adjust[key] === 0) &&
		recipe.filter === null &&
		recipe.text.length === 0 &&
		!recipe.removeLocation
	)
}

// Ranges clamped to [0, duration], sorted, with overlapping or touching ones merged and slivers shorter than
// MIN_KEEP_SECONDS dropped. Touching ranges are merged on purpose: a join with nothing removed would still be a cut
// edge the copy path snaps (and a snapped join drops a whole group of pictures).
export function normaliseKeep(ranges: readonly TimeRange[], duration: number): TimeRange[] {
	const clamped = ranges
		.map(range => ({
			start: clamp(Math.min(range.start, range.end), 0, duration),
			end: clamp(Math.max(range.start, range.end), 0, duration)
		}))
		.filter(range => range.end > range.start)
		.sort((a, b) => a.start - b.start)
	const merged: TimeRange[] = []

	for (const range of clamped) {
		const last = merged[merged.length - 1]

		if (last !== undefined && range.start <= last.end) {
			last.end = Math.max(last.end, range.end)
		} else {
			merged.push({ ...range })
		}
	}

	return merged.filter(range => range.end - range.start >= MIN_KEEP_SECONDS - 1e-9)
}

// What the kept ranges leave out of [0, duration], in order.
export function removedRanges(keep: readonly TimeRange[], duration: number): TimeRange[] {
	const removed: TimeRange[] = []
	let at = 0

	for (const range of keep) {
		if (range.start > at) {
			removed.push({ start: at, end: range.start })
		}

		at = Math.max(at, range.end)
	}

	if (duration > at) {
		removed.push({ start: at, end: duration })
	}

	return removed
}

// `keep` with `section` taken out; null when nothing would be left (the recipe never keeps nothing).
export function removeSection(keep: readonly TimeRange[], section: TimeRange, duration: number): TimeRange[] | null {
	const start = Math.min(section.start, section.end)
	const end = Math.max(section.start, section.end)

	if (end - start <= 0) {
		return [...keep]
	}

	const pieces: TimeRange[] = []

	for (const range of keep) {
		if (range.end <= start || range.start >= end) {
			pieces.push(range)
			continue
		}

		if (range.start < start) {
			pieces.push({ start: range.start, end: start })
		}

		if (range.end > end) {
			pieces.push({ start: end, end: range.end })
		}
	}

	const next = normaliseKeep(pieces, duration)

	return next.length === 0 ? null : next
}

// `keep` with a removed `section` given back.
export function restoreSection(keep: readonly TimeRange[], section: TimeRange, duration: number): TimeRange[] {
	return normaliseKeep([...keep, section], duration)
}

export type KeepEdge = "start" | "end"

// The bounds an edge of keep range `index` may move within: past a neighbour it would swallow a removed section the
// user made, so it stops there (meeting it merges the two, normaliseKeep), and it never makes its range shorter than
// MIN_KEEP_SECONDS.
export function edgeBounds(keep: readonly TimeRange[], index: number, edge: KeepEdge, duration: number): TimeRange {
	const range = keep[index]

	if (range === undefined) {
		return { start: 0, end: duration }
	}

	if (edge === "start") {
		return { start: keep[index - 1]?.end ?? 0, end: Math.max(range.start, range.end - MIN_KEEP_SECONDS) }
	}

	return { start: Math.min(range.end, range.start + MIN_KEEP_SECONDS), end: keep[index + 1]?.start ?? duration }
}

// `keep` with one edge of range `index` moved to `time` (clamped to edgeBounds).
export function moveKeepEdge(keep: readonly TimeRange[], index: number, edge: KeepEdge, time: number, duration: number): TimeRange[] {
	const range = keep[index]

	if (range === undefined) {
		return [...keep]
	}

	const bounds = edgeBounds(keep, index, edge, duration)
	const at = clamp(time, bounds.start, bounds.end)
	const moved = edge === "start" ? { start: at, end: range.end } : { start: range.start, end: at }
	const next = normaliseKeep(
		keep.map((current, i) => (i === index ? moved : current)),
		duration
	)

	return next.length === 0 ? [...keep] : next
}

// The trim: the first kept range's start or the last one's end, moved. Ranges the trim passes are dropped whole.
export function setTrim(keep: readonly TimeRange[], edge: KeepEdge, time: number, duration: number): TimeRange[] {
	const first = keep[0]
	const last = keep[keep.length - 1]

	if (first === undefined || last === undefined) {
		return [...keep]
	}

	if (edge === "start") {
		const at = clamp(time, 0, last.end - MIN_KEEP_SECONDS)
		const next = normaliseKeep(
			keep.filter(range => range.end > at).map(range => (range.start < at ? { start: at, end: range.end } : range)),
			duration
		)

		return next.length === 0 ? [...keep] : next
	}

	const at = clamp(time, first.start + MIN_KEEP_SECONDS, duration)
	const next = normaliseKeep(
		keep.filter(range => range.start < at).map(range => (range.end > at ? { start: range.start, end: at } : range)),
		duration
	)

	return next.length === 0 ? [...keep] : next
}

export function keptDuration(keep: readonly TimeRange[]): number {
	return keep.reduce((total, range) => total + (range.end - range.start), 0)
}

export function outputDuration(keep: readonly TimeRange[], speed: number): number {
	return keptDuration(keep) / (speed > 0 ? speed : 1)
}

// A source time on the output timeline (after cuts and speed); a time in a removed section maps to where it was cut.
export function sourceToOutput(keep: readonly TimeRange[], speed: number, time: number): number {
	let kept = 0

	for (const range of keep) {
		if (time <= range.start) {
			break
		}

		kept += Math.min(time, range.end) - range.start
	}

	return kept / (speed > 0 ? speed : 1)
}

// An output time back on the source timeline (the kept moment it shows).
export function outputToSource(keep: readonly TimeRange[], speed: number, time: number): number {
	let remaining = Math.max(0, time) * (speed > 0 ? speed : 1)

	for (const range of keep) {
		const length = range.end - range.start

		if (remaining <= length) {
			return range.start + remaining
		}

		remaining -= length
	}

	return keep[keep.length - 1]?.end ?? 0
}

// Where playback should be for a source time it reached: unchanged inside a kept range (and inside `loop` when one is
// set), else the next kept moment; past the end, back to the start of the loop or of the first kept range.
export function playableTime(keep: readonly TimeRange[], time: number, loop: TimeRange | null): { time: number; jumped: boolean } {
	const first = keep[0]

	if (first === undefined) {
		return { time, jumped: false }
	}

	if (loop !== null && (time >= loop.end || time < loop.start)) {
		return { time: playableTime(keep, loop.start, null).time, jumped: true }
	}

	for (const range of keep) {
		if (time < range.start) {
			return { time: range.start, jumped: true }
		}

		if (time < range.end) {
			return { time, jumped: false }
		}
	}

	return { time: loop?.start ?? first.start, jumped: true }
}

// The kept range holding `time`, by index; -1 in a removed section.
export function keepIndexAt(keep: readonly TimeRange[], time: number): number {
	return keep.findIndex(range => time >= range.start && time < range.end)
}

// ---- Geometry. The crop is in display space (the source as its own rotation metadata shows it); the recipe's
// rotation turns the cropped picture clockwise and the flips then mirror the turned picture (the output). ----

export function turnedSize(rotate: VideoRotation, size: Size): Size {
	return rotate === 90 || rotate === 270 ? { width: size.height, height: size.width } : size
}

// The output picture's size before any resize: the crop (or the whole display frame), turned.
export function croppedSize(recipe: Pick<VideoEditRecipe, "crop" | "rotate">, display: Size): Size {
	const base = recipe.crop === null ? display : { width: recipe.crop.width, height: recipe.crop.height }

	return turnedSize(recipe.rotate, base)
}

// A rectangle in the display frame as it shows in the output frame (turned, then mirrored), both normalised.
export function rectToView(rect: NormalisedRect, rotate: VideoRotation, flipH: boolean, flipV: boolean): NormalisedRect {
	let out: NormalisedRect

	switch (rotate) {
		case 90:
			out = { x: 1 - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width }
			break
		case 180:
			out = { x: 1 - rect.x - rect.width, y: 1 - rect.y - rect.height, width: rect.width, height: rect.height }
			break
		case 270:
			out = { x: rect.y, y: 1 - rect.x - rect.width, width: rect.height, height: rect.width }
			break
		default:
			out = { ...rect }
	}

	if (flipH) {
		out = { ...out, x: 1 - out.x - out.width }
	}

	if (flipV) {
		out = { ...out, y: 1 - out.y - out.height }
	}

	return out
}

// rectToView's inverse.
export function rectFromView(view: NormalisedRect, rotate: VideoRotation, flipH: boolean, flipV: boolean): NormalisedRect {
	let rect = { ...view }

	if (flipH) {
		rect = { ...rect, x: 1 - rect.x - rect.width }
	}

	if (flipV) {
		rect = { ...rect, y: 1 - rect.y - rect.height }
	}

	// Turning back by `rotate` is turning on by the rest of the circle.
	const back = ((360 - rotate) % 360) as VideoRotation

	return rectToView(rect, back, false, false)
}

function even(value: number): number {
	return 2 * Math.round(value / 2)
}

// A normalised display-space rectangle as the recipe's crop: whole even pixels inside the frame, at least 2×2; null when
// it is the whole frame.
export function cropFromNormalised(rect: NormalisedRect, display: Size): VideoCrop | null {
	const maxWidth = even(display.width) > display.width ? even(display.width) - 2 : even(display.width)
	const maxHeight = even(display.height) > display.height ? even(display.height) - 2 : even(display.height)
	const x = clamp(even(rect.x * display.width), 0, Math.max(0, maxWidth - 2))
	const y = clamp(even(rect.y * display.height), 0, Math.max(0, maxHeight - 2))
	const width = clamp(even(rect.width * display.width), 2, maxWidth - x)
	const height = clamp(even(rect.height * display.height), 2, maxHeight - y)

	if (x === 0 && y === 0 && width >= maxWidth && height >= maxHeight) {
		return null
	}

	return { x, y, width, height }
}

export function cropToNormalised(crop: VideoCrop | null, display: Size): NormalisedRect {
	if (crop === null || display.width <= 0 || display.height <= 0) {
		return { x: 0, y: 0, width: 1, height: 1 }
	}

	return {
		x: crop.x / display.width,
		y: crop.y / display.height,
		width: crop.width / display.width,
		height: crop.height / display.height
	}
}

// The largest crop of `aspect`'s ratio as the OUTPUT shows it (after the turn), centred on the display frame; null for
// free (the crop stays) and for a ratio the whole frame already has.
export function aspectCrop(aspect: AspectPreset, display: Size, rotate: VideoRotation): VideoCrop | null {
	const view = turnedSize(rotate, display)
	const ratio = aspectRatio(aspect, view)

	if (ratio === null || display.width <= 0 || display.height <= 0) {
		return null
	}

	// The ratio in display space: a quarter turn swaps the sides.
	const displayRatio = view === display ? ratio : 1 / ratio
	const width = Math.min(display.width, display.height * displayRatio)
	const height = width / displayRatio

	return cropFromNormalised(
		{
			x: (display.width - width) / 2 / display.width,
			y: (display.height - height) / 2 / display.height,
			width: width / display.width,
			height: height / display.height
		},
		display
	)
}

// A quarter turn left or right of what the output shows. The crop is in display space, so it stays as it is.
export function turnRecipe(recipe: VideoEditRecipe, direction: "left" | "right"): VideoEditRecipe {
	const rotate = ((recipe.rotate + (direction === "right" ? 90 : 270)) % 360) as VideoRotation

	// Flips mirror the output, which the turn swaps the axes of: turning then mirroring one way is mirroring the other
	// way then turning, so the mirrors trade places to keep what was shown mirrored as it was.
	return { ...recipe, rotate, flipH: recipe.flipV, flipV: recipe.flipH }
}

export function flipRecipe(recipe: VideoEditRecipe, axis: "horizontal" | "vertical"): VideoEditRecipe {
	return axis === "horizontal" ? { ...recipe, flipH: !recipe.flipH } : { ...recipe, flipV: !recipe.flipV }
}

// ---- Speed, sound, text. ----

export function clampSpeed(speed: number): number {
	return Number.isFinite(speed) ? clamp(Math.round(speed * 100) / 100, MIN_SPEED, MAX_SPEED) : 1
}

export function clampGain(gainDb: number): number {
	return Number.isFinite(gainDb) ? clamp(Math.round(gainDb * 10) / 10, MIN_GAIN_DB, MAX_GAIN_DB) : 0
}

// The element volume that previews a gain (an element cannot amplify, so a boost previews at full volume).
export function previewVolume(gainDb: number): number {
	return Math.min(1, 10 ** (gainDb / 20))
}

// Whether audio track `number` is kept.
export function keepsTrack(keepTracks: VideoEditRecipe["audio"]["keepTracks"], number: number, first: number | undefined): boolean {
	return keepTracks === "first" ? number === first : keepTracks.includes(number)
}

// The tracks kept after `number` is switched; never none (mute is the way to drop every sound).
export function toggleTrack(
	keepTracks: VideoEditRecipe["audio"]["keepTracks"],
	number: number,
	all: readonly number[]
): VideoEditRecipe["audio"]["keepTracks"] {
	const first = all[0]
	const current = keepTracks === "first" ? (first === undefined ? [] : [first]) : [...keepTracks]
	const next = current.includes(number) ? current.filter(track => track !== number) : [...current, number].sort((a, b) => a - b)

	if (next.length === 0) {
		return keepTracks
	}

	return next.length === 1 && next[0] === first ? "first" : next
}

export function clampTextSize(size: number): number {
	return clamp(size, MIN_TEXT_SIZE, MAX_TEXT_SIZE)
}

// A text box's times kept on the output timeline, at least a tenth of a second long.
export function clampTextTimes(text: TextOverlay, output: number): TextOverlay {
	const end = clamp(Math.max(text.startSec, text.endSec), 0, output)
	const start = clamp(Math.min(text.startSec, text.endSec), 0, Math.max(0, end - MIN_KEEP_SECONDS))

	return { ...text, startSec: start, endSec: Math.max(end, Math.min(output, start + MIN_KEEP_SECONDS)) }
}

// A new text box at the centre for the next few seconds of the output from `at`.
export function newTextOverlay(id: string, text: string, at: number, output: number): TextOverlay {
	return clampTextTimes(
		{ id, text, startSec: at, endSec: at + 3, x: 0.5, y: 0.5, size: DEFAULT_TEXT_SIZE, color: "#ffffff", background: true },
		output
	)
}

export function withText(recipe: VideoEditRecipe, id: string, change: (text: TextOverlay) => TextOverlay): VideoEditRecipe {
	return { ...recipe, text: recipe.text.map(text => (text.id === id ? change(text) : text)) }
}

// Text boxes kept when the kept ranges or the speed change the output's length.
export function clampTexts(recipe: VideoEditRecipe): VideoEditRecipe {
	const output = outputDuration(recipe.keep, recipe.speed)

	return { ...recipe, text: recipe.text.filter(text => text.startSec < output).map(text => clampTextTimes(text, output)) }
}
