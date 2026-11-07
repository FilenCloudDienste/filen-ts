// Linux WebKit's GStreamer backend mishandles a pause that lands while a seek is in flight: once the seek
// completes, playback resumes on its own (a `play` event nobody asked for), and the next seek lands at 0.
// So a pause asked for mid-seek is held until the seek lands (`seeked`), then made. A seek that never lands
// must not swallow the pause, so the hold also ends after HELD_PAUSE_MAX_MS. Measured on Linux WebKit under
// load: a preview seek over the service worker lands in 0.1-1 s, the slowest seen in 1.9 s.

export const HELD_PAUSE_MAX_MS = 3_000

// The parts of a media element the hold uses, so a test can hand in a fake.
export interface PausableMedia {
	readonly seeking: boolean
	pause(): void
	addEventListener(type: "seeked" | "emptied", listener: () => void): void
	removeEventListener(type: "seeked" | "emptied", listener: () => void): void
}

// The element's held pause, as the function that drops it.
const held = new WeakMap<PausableMedia, () => void>()

// Pauses `media` now, or, while it seeks, once the seek lands. Asking again while a pause is held changes
// nothing.
export function pauseMedia(media: PausableMedia): void {
	if (held.has(media)) {
		return
	}

	if (!media.seeking) {
		media.pause()

		return
	}

	function drop(): void {
		clearTimeout(timer)
		media.removeEventListener("seeked", apply)
		media.removeEventListener("emptied", drop)
		held.delete(media)
	}

	function apply(): void {
		drop()
		media.pause()
	}

	const timer = setTimeout(apply, HELD_PAUSE_MAX_MS)

	media.addEventListener("seeked", apply)
	// A new source (or none): the pause was for what played before.
	media.addEventListener("emptied", drop)
	held.set(media, drop)
}

// Drops a held pause without making it: playing was asked for after it, or the element is going away.
// Returns whether one was held.
export function cancelHeldPause(media: PausableMedia): boolean {
	const drop = held.get(media)

	if (drop === undefined) {
		return false
	}

	drop()

	return true
}

// Whether a pause is waiting on `media`'s seek: it still plays, but the user has asked it to stop.
export function hasHeldPause(media: PausableMedia): boolean {
	return held.has(media)
}
