// Pure math behind the media scrubber: pointer position to time, keyboard steps, buffered ranges.

// Arrow keys move the playhead this far, the way every player seeks.
export const SEEK_STEP_SECONDS = 5

// PageUp/PageDown move a tenth of the file, never less than one arrow step.
const PAGE_FRACTION = 0.1

function clampTime(seconds: number, duration: number): number {
	if (!Number.isFinite(seconds) || duration <= 0) {
		return 0
	}

	return Math.max(0, Math.min(duration, seconds))
}

// The fraction of the rail left of `clientX`, clamped to it.
export function ratioAt(clientX: number, left: number, width: number): number {
	if (width <= 0) {
		return 0
	}

	return Math.max(0, Math.min(1, (clientX - left) / width))
}

export function timeAtRatio(ratio: number, duration: number): number {
	return clampTime(ratio * duration, duration)
}

// 0-100, for a CSS width or offset.
export function percentOf(seconds: number, duration: number): number {
	return duration > 0 ? (clampTime(seconds, duration) / duration) * 100 : 0
}

// The time a key moves the scrubber to, or null for a key the scrubber leaves alone.
export function scrubberKeyTarget(key: string, current: number, duration: number, step: number): number | null {
	if (duration <= 0) {
		return null
	}

	const page = Math.max(step, duration * PAGE_FRACTION)

	switch (key) {
		case "ArrowRight":
		case "ArrowUp":
			return clampTime(current + step, duration)
		case "ArrowLeft":
		case "ArrowDown":
			return clampTime(current - step, duration)
		case "PageUp":
			return clampTime(current + page, duration)
		case "PageDown":
			return clampTime(current - page, duration)
		case "Home":
			return 0
		case "End":
			return duration
		default:
			return null
	}
}

export interface TimeRange {
	start: number
	end: number
}

// Reads back useMediaBuffered's "start~end,start~end" snapshot, dropping anything malformed or empty.
export function parseBufferedRanges(serialized: string): TimeRange[] {
	if (serialized === "") {
		return []
	}

	const ranges: TimeRange[] = []

	for (const part of serialized.split(",")) {
		const [start, end] = part.split("~").map(Number)

		if (start !== undefined && end !== undefined && Number.isFinite(start) && Number.isFinite(end) && end > start) {
			ranges.push({ start, end })
		}
	}

	return ranges
}
