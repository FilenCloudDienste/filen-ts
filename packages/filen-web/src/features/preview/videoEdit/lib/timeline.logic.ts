import type { SnappedEdge, TimeRange } from "@/features/preview/videoEdit/types"

// The timeline's own math: the zoomed window over the source, time↔x, timecodes, frame and key steps, which
// filmstrip tiles to ask for, and which snapped edges to show. Pure.

// The span the timeline shows, in source seconds.
export interface TimelineView {
	start: number
	end: number
}

// The shortest span zoom reaches: a few frames across the whole timeline.
export const MIN_VIEW_SPAN = 0.25

// The frame rate assumed when the source does not say (only frame stepping reads it).
export const FALLBACK_FPS = 30

// Each wheel notch (or Mod+=/−) zooms by this factor.
export const ZOOM_STEP = 1.5

// A snapped edge this much later or earlier gets the "Snaps 2.1 s later · Make precise" chip; smaller moves show
// the ghost marker only.
export const SNAP_CHIP_SECONDS = 1

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}

export function fullView(duration: number): TimelineView {
	return { start: 0, end: Math.max(duration, MIN_VIEW_SPAN) }
}

export function viewSpan(view: TimelineView): number {
	return view.end - view.start
}

// `view` moved to start at `start`, its span kept, inside [0, duration].
function placed(start: number, span: number, duration: number): TimelineView {
	const total = Math.max(duration, MIN_VIEW_SPAN)
	const width = Math.min(span, total)
	const at = clamp(start, 0, total - width)

	return { start: at, end: at + width }
}

// Zoomed by `factor` (above 1 zooms in) about `anchor`, which stays where it is on screen.
export function zoomView(view: TimelineView, factor: number, anchor: number, duration: number): TimelineView {
	const span = viewSpan(view)
	const total = Math.max(duration, MIN_VIEW_SPAN)
	const next = clamp(span / factor, Math.min(MIN_VIEW_SPAN, total), total)
	const ratio = span > 0 ? (clamp(anchor, view.start, view.end) - view.start) / span : 0

	return placed(anchor - ratio * next, next, duration)
}

// Panned by `delta` seconds.
export function panView(view: TimelineView, delta: number, duration: number): TimelineView {
	return placed(view.start + delta, viewSpan(view), duration)
}

// The view moved the least to show `time` (with a margin of a tenth of the span), unchanged when it already does.
export function revealTime(view: TimelineView, time: number, duration: number): TimelineView {
	const span = viewSpan(view)
	const margin = span / 10

	if (time >= view.start + margin && time <= view.end - margin) {
		return view
	}

	return time < view.start + margin ? placed(time - margin, span, duration) : placed(time - span + margin, span, duration)
}

export function isZoomed(view: TimelineView, duration: number): boolean {
	return viewSpan(view) < Math.max(duration, MIN_VIEW_SPAN) - 1e-6
}

export function timeToX(view: TimelineView, width: number, time: number): number {
	const span = viewSpan(view)

	return span > 0 ? ((time - view.start) / span) * width : 0
}

export function xToTime(view: TimelineView, width: number, x: number): number {
	return width > 0 ? view.start + (x / width) * viewSpan(view) : view.start
}

// "00:12.40" (minutes, seconds, hundredths), "1:02:03.40" from an hour on.
export function formatTimecode(seconds: number): string {
	const total = Math.max(0, Number.isFinite(seconds) ? seconds : 0)
	const hundredths = Math.floor(total * 100 + 1e-6)
	const cs = hundredths % 100
	const s = Math.floor(hundredths / 100) % 60
	const m = Math.floor(hundredths / 6000) % 60
	const h = Math.floor(hundredths / 360000)
	const tail = `${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`

	return h > 0 ? `${String(h)}:${String(m).padStart(2, "0")}:${tail}` : `${String(m).padStart(2, "0")}:${tail}`
}

// A typed timecode: "12", "12.4", "1:05", "01:05.25", "1:02:03.5"; null when it is not one.
export function parseTimecode(text: string): number | null {
	const trimmed = text.trim()

	if (!/^\d+(:\d{1,2}){0,2}([.,]\d*)?$/.test(trimmed)) {
		return null
	}

	const [whole = "", fraction = ""] = trimmed.replace(",", ".").split(".")
	const parts = whole.split(":").map(Number)
	let seconds = 0

	for (const part of parts) {
		seconds = seconds * 60 + part
	}

	// Seconds and minutes after the first part stay under 60.
	if (parts.slice(1).some(part => part >= 60)) {
		return null
	}

	return seconds + (fraction === "" ? 0 : Number(`0.${fraction}`))
}

export function frameDuration(fps: number): number {
	return 1 / (Number.isFinite(fps) && fps > 0 ? fps : FALLBACK_FPS)
}

// What a key does to a time slider (a trim handle): one frame on the arrows, a second with Shift, ten on Page Up/Down,
// the bounds on Home/End; null for any other key.
export function sliderKeyTarget(key: string, shift: boolean, value: number, bounds: TimeRange, fps: number): number | null {
	const frame = frameDuration(fps)
	let next: number

	switch (key) {
		case "ArrowLeft":
		case "ArrowDown":
			next = value - (shift ? 1 : frame)
			break
		case "ArrowRight":
		case "ArrowUp":
			next = value + (shift ? 1 : frame)
			break
		case "PageDown":
			next = value - 10
			break
		case "PageUp":
			next = value + 10
			break
		case "Home":
			next = bounds.start
			break
		case "End":
			next = bounds.end
			break
		default:
			return null
	}

	return clamp(next, bounds.start, bounds.end)
}

// A filmstrip slot's length in source seconds: about `tileWidth` px of `view`, rounded up to a power of two of a
// millisecond grid so nearby zooms share slots (and the tiles already fetched for them).
export function filmstripStep(view: TimelineView, width: number, tileWidth: number): number {
	const raw = (viewSpan(view) * tileWidth) / Math.max(1, width)

	return 2 ** Math.ceil(Math.log2(Math.max(raw, 0.001)))
}

// The filmstrip's slots across `view`: each one `step` seconds long on a grid fixed in source time, so a pan reuses the
// tiles it already has; a slot shows the frame at its centre.
export function filmstripSlots(view: TimelineView, width: number, tileWidth: number, duration: number): { step: number; times: number[] } {
	if (width <= 0 || tileWidth <= 0 || duration <= 0) {
		return { step: 0, times: [] }
	}

	const step = filmstripStep(view, width, tileWidth)
	const times: number[] = []

	for (let slot = Math.floor(view.start / step); slot * step < Math.min(view.end, duration) && times.length < 200; slot++) {
		times.push(Math.min(duration, slot * step + step / 2))
	}

	return { step, times }
}

// The filmstrip cache's byte budget: `screens` times the RGBA tiles (`tileWidth` × `tileHeight` CSS px at `ratio`
// device px each) that cover `width`, one more for the partly shown slot.
export function filmstripBudget(width: number, tileWidth: number, tileHeight: number, ratio: number, screens: number): number {
	const slots = Math.ceil(Math.max(0, width) / Math.max(1, tileWidth)) + 1
	const tileBytes = Math.round(tileWidth * ratio) * Math.round(tileHeight * ratio) * 4

	return Math.round(slots * tileBytes * screens)
}

const TICK_STEPS: readonly number[] = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]

// The ruler's labelled step: the smallest of TICK_STEPS that leaves `minGap` px between labels.
export function rulerStep(view: TimelineView, width: number, minGap: number): number {
	const perPixel = viewSpan(view) / Math.max(1, width)

	return TICK_STEPS.find(step => step / perPixel >= minGap) ?? TICK_STEPS[TICK_STEPS.length - 1] ?? 3600
}

export function rulerTicks(view: TimelineView, width: number, minGap: number): number[] {
	const step = rulerStep(view, width, minGap)
	const ticks: number[] = []

	for (let at = Math.ceil(view.start / step) * step; at <= view.end && ticks.length < 500; at += step) {
		ticks.push(Math.round(at * 1000) / 1000)
	}

	return ticks
}

export interface SnapMark {
	requested: number
	actual: number
	// Positive: the edge lands later than asked.
	delta: number
	// Big enough to offer "Make precise".
	chip: boolean
}

// The edges the fast path moves by at least a frame, with the chip on those moved SNAP_CHIP_SECONDS or more.
export function snapMarks(snapped: readonly SnappedEdge[], fps: number): SnapMark[] {
	const frame = frameDuration(fps)

	return snapped
		.map(edge => ({ requested: edge.requested, actual: edge.actual, delta: edge.actual - edge.requested }))
		.filter(mark => Math.abs(mark.delta) >= frame)
		.map(mark => ({ ...mark, chip: Math.abs(mark.delta) >= SNAP_CHIP_SECONDS }))
		.sort((a, b) => a.requested - b.requested)
}

// The time two pointers' distance change zooms by (pinch), clamped so one gesture frame never jumps wildly.
export function pinchFactor(startDistance: number, distance: number): number {
	if (startDistance <= 0 || distance <= 0) {
		return 1
	}

	return clamp(distance / startDistance, 0.2, 5)
}

// A wheel event's zoom factor (deltaY in px or lines; negative zooms in).
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
	const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY

	return Math.exp(-clamp(pixels, -200, 200) / 200)
}
