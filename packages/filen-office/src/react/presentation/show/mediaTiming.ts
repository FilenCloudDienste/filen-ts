import { pauseMedia, type PausableMedia } from "@filen/shared/heldPause"
import { BookmarkCursor, fadeGain, playWindow, type MediaTiming, type PlayWindow } from "../../../core/anim/media"

// A medium's trim, fade and bookmarks applied to its <video>/<audio> while it plays (core/anim/media.ts holds the
// rules): playback starts at the trimmed start and stops (or loops back) at the trimmed end, the volume follows the
// fade, and each bookmark reached fires its trigger. The element is sampled once per animation frame while it plays
// and never otherwise; a frame costs a few comparisons (the bookmark cursor walks only what was passed), so a
// bookmark fires within the frame its time is reached.

export interface MediaTimingHooks {
	// A bookmark reached while playing (its name).
	bookmark(name: string): void
	// The trimmed end reached without looping: the medium stopped there.
	ended(): void
}

// The length of each medium a page has loaded the metadata of (ms), by session and part: what the Video and Audio
// tabs' Trim dialog shows its start and end times against without loading the medium again. Held weakly by session.
const durations = new WeakMap<object, Map<string, number>>()

export function noteMediaDuration(session: object, part: string, durationSeconds: number): void {
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return

	let parts = durations.get(session)

	if (parts === undefined) {
		parts = new Map()
		durations.set(session, parts)
	}

	parts.set(part, Math.round(durationSeconds * 1000))
}

export function knownMediaDuration(session: object, part: string): number | undefined {
	return durations.get(session)?.get(part)
}

// What drives the frames: requestAnimationFrame on the page; tests pass their own.
export interface FrameSource {
	request(callback: () => void): number
	cancel(handle: number): void
}

// The page's animation frames, read from the global at call time (no DOM typings needed where this is imported).
const PAGE_FRAMES: FrameSource = {
	request: callback => (Reflect.get(globalThis, "requestAnimationFrame") as (callback: () => void) => number)(callback),
	cancel: handle => {
		const cancel = Reflect.get(globalThis, "cancelAnimationFrame") as (handle: number) => void

		cancel(handle)
	}
}

// What the driver reads and sets of the element (an HTMLMediaElement has all of it).
export interface TimedMedia extends PausableMedia {
	currentTime: number
	volume: number
	readonly duration: number
	readonly paused: boolean
	play(): Promise<void>
	addEventListener(type: string, listener: () => void): void
	removeEventListener(type: string, listener: () => void): void
}

// A position within a millisecond of the window's start or end counts as there (float seconds round-trip).
const END_SLACK_MS = 1

export class MediaTimingDriver {
	private readonly element: TimedMedia
	private readonly timing: MediaTiming
	private readonly hooks: MediaTimingHooks
	private readonly frames: FrameSource
	private readonly loop: boolean
	// The volume the file asks for (p:cMediaNode vol, 0..1), which the fade scales.
	private readonly volume: number
	private readonly cursor: BookmarkCursor
	private window: PlayWindow
	private frame = -1
	// The medium position the last frame saw (ms); bookmarks between it and the next are crossed.
	private lastMs = -1
	private disposed = false
	private readonly listeners: (readonly [string, () => void])[] = []
	private readonly fire = (name: string): void => {
		this.hooks.bookmark(name)
	}

	constructor(
		element: TimedMedia,
		timing: MediaTiming,
		hooks: MediaTimingHooks,
		options: { readonly loop: boolean; readonly volume: number; readonly frames?: FrameSource }
	) {
		this.element = element
		this.timing = timing
		this.hooks = hooks
		this.frames = options.frames ?? PAGE_FRAMES
		this.loop = options.loop
		this.volume = Math.max(0, Math.min(1, options.volume))
		this.cursor = new BookmarkCursor(timing.bookmarks)
		this.window = playWindow(timing, element.duration * 1000)

		this.listen("loadedmetadata", () => {
			this.window = playWindow(this.timing, this.element.duration * 1000)
		})
		this.listen("play", () => {
			this.resumed()
		})
		this.listen("seeked", () => {
			this.lastMs = this.element.currentTime * 1000
			this.cursor.seek(this.lastMs)
		})
		this.listen("pause", () => {
			this.stop()
		})
		this.listen("ended", () => {
			this.stop()
		})
		this.applyGain(this.window.startMs)
	}

	// The element time (seconds) for a show position `atMs` from the medium's (trimmed) start: playFrom(t), a stop's 0.
	seekSeconds(atMs: number): number {
		return Math.min(this.window.startMs + Math.max(0, atMs), this.window.endMs) / 1000
	}

	// The trimmed part to play.
	get playWindow(): PlayWindow {
		return this.window
	}

	// Playing starts, or goes on after a pause held for a seek was dropped (no play event: it never stopped).
	resumed(): void {
		if (this.disposed) return

		this.enter()
		this.schedule()
	}

	dispose(): void {
		if (this.disposed) return

		this.disposed = true
		this.stop()

		for (const [type, listener] of this.listeners) this.element.removeEventListener(type, listener)

		this.listeners.length = 0
	}

	// One frame's work (public for the per-frame budget test): the position against the trim, the fade and the
	// bookmarks. Returns whether the medium plays on.
	tick(): boolean {
		const element = this.element

		if (this.disposed || element.paused) return false

		const window = this.window
		let ms = element.currentTime * 1000

		// Before the trimmed start (a seek on the native bar, a play from 0): to the start.
		if (ms < window.startMs - END_SLACK_MS) {
			element.currentTime = window.startMs / 1000
			ms = window.startMs
			this.lastMs = ms
			this.cursor.seek(ms)
		}

		if (ms < this.lastMs) this.cursor.seek(ms)

		this.cursor.advance(ms, this.fire)
		this.lastMs = ms

		if (ms >= window.endMs - END_SLACK_MS) {
			if (this.loop) {
				element.currentTime = window.startMs / 1000
				this.lastMs = window.startMs
				this.cursor.seek(window.startMs)
				this.applyGain(window.startMs)

				return true
			}

			// A seek on the native bar past the end may still be in flight: the pause waits for it to land.
			pauseMedia(element)
			this.hooks.ended()

			return false
		}

		this.applyGain(ms)

		return true
	}

	private listen(type: string, listener: () => void): void {
		this.element.addEventListener(type, listener)
		this.listeners.push([type, listener])
	}

	// Playing starts: from the trimmed start when before it, with the bookmarks after the position still to come.
	private enter(): void {
		const ms = this.element.currentTime * 1000

		if (ms < this.window.startMs - END_SLACK_MS || ms >= this.window.endMs - END_SLACK_MS) {
			this.element.currentTime = this.window.startMs / 1000
			this.lastMs = this.window.startMs
		} else this.lastMs = ms

		// A bookmark exactly at the start fires as the medium starts there.
		this.cursor.seek(this.lastMs)
		this.cursor.advance(this.lastMs, this.fire)
		this.applyGain(this.lastMs)
	}

	private schedule(): void {
		if (this.frame >= 0 || this.disposed) return

		this.frame = this.frames.request(() => {
			this.frame = -1

			if (this.tick()) this.schedule()
		})
	}

	private stop(): void {
		if (this.frame >= 0) this.frames.cancel(this.frame)

		this.frame = -1
	}

	private applyGain(ms: number): void {
		if (this.timing.fade === undefined) return

		const volume = this.volume * fadeGain(this.timing, this.window, ms)

		if (Math.abs(this.element.volume - volume) > 0.001) this.element.volume = volume
	}
}
