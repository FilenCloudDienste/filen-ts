import { describe, expect, it } from "vitest"
import type { MediaTiming } from "../core/anim/media"
import {
	knownMediaDuration,
	MediaTimingDriver,
	noteMediaDuration,
	type FrameSource,
	type TimedMedia
} from "../react/presentation/show/mediaTiming"

// The show's player applying a medium's trim, fade and bookmarks to its element, against a simulated element whose
// clock advances with the frames (60 Hz): playback starts at the trimmed start and stops at the trimmed end within
// 50 ms, the volume follows the fade, and each bookmark fires on the first frame its time is reached (within one
// frame), once, in order.

const FRAME_MS = 1000 / 60

class FakeMedia implements TimedMedia {
	currentTime = 0
	volume = 1
	paused = true
	readonly duration: number
	readonly seeks: number[] = []
	private readonly listeners = new Map<string, Set<() => void>>()

	constructor(durationSeconds: number) {
		this.duration = durationSeconds
	}

	pause(): void {
		if (this.paused) return

		this.paused = true
		this.emit("pause")
	}

	play(): Promise<void> {
		this.paused = false
		this.emit("play")

		return Promise.resolve()
	}

	seek(seconds: number): void {
		this.currentTime = seconds
		this.seeks.push(seconds)
		this.emit("seeked")
	}

	addEventListener(type: string, listener: () => void): void {
		let set = this.listeners.get(type)

		if (set === undefined) {
			set = new Set()
			this.listeners.set(type, set)
		}

		set.add(listener)
	}

	removeEventListener(type: string, listener: () => void): void {
		this.listeners.get(type)?.delete(listener)
	}

	listening(): number {
		let count = 0

		for (const set of this.listeners.values()) count += set.size

		return count
	}

	emit(type: string): void {
		for (const listener of this.listeners.get(type) ?? []) listener()
	}
}

// Frames on demand: each step advances the element by one frame of playback, then runs the frame callbacks.
class Frames implements FrameSource {
	private next = 1
	private readonly pending = new Map<number, () => void>()

	request(callback: () => void): number {
		const handle = this.next++

		this.pending.set(handle, callback)

		return handle
	}

	cancel(handle: number): void {
		this.pending.delete(handle)
	}

	get waiting(): number {
		return this.pending.size
	}

	step(media: FakeMedia): void {
		if (!media.paused) media.currentTime += FRAME_MS / 1000

		const callbacks = [...this.pending.values()]

		this.pending.clear()

		for (const callback of callbacks) callback()
	}
}

function harness(timing: MediaTiming, durationSeconds = 10, loop = false) {
	const media = new FakeMedia(durationSeconds)
	const frames = new Frames()
	const fired: { name: string; atMs: number }[] = []
	let ended = 0
	const driver = new MediaTimingDriver(
		media,
		timing,
		{
			bookmark: name => fired.push({ name, atMs: media.currentTime * 1000 }),
			ended: () => {
				ended++
			}
		},
		{ loop, volume: 0.8, frames }
	)

	return { media, frames, fired, driver, ended: () => ended }
}

describe("media timing in the show", () => {
	it("plays from the trimmed start and stops within 50 ms of the trimmed end", async () => {
		const h = harness({ trim: { startMs: 1500, endMs: 2500 } })

		await h.media.play()
		expect(h.media.currentTime).toBe(1.5)

		for (let k = 0; k < 2000 && !h.media.paused; k++) h.frames.step(h.media)

		expect(h.media.paused).toBe(true)
		expect(h.ended()).toBe(1)
		expect(Math.abs(h.media.currentTime * 1000 - 7500)).toBeLessThanOrEqual(50)
		expect(h.frames.waiting).toBe(0)
	})

	it("maps a play from a position and a stop into the trimmed part", () => {
		const h = harness({ trim: { startMs: 1500, endMs: 2500 } })

		expect(h.driver.seekSeconds(0)).toBe(1.5)
		expect(h.driver.seekSeconds(2000)).toBe(3.5)
		// Past the trimmed end: its end.
		expect(h.driver.seekSeconds(60_000)).toBe(7.5)
	})

	it("brings a seek before the trimmed start back to it", async () => {
		const h = harness({ trim: { startMs: 2000, endMs: 0 } })

		await h.media.play()
		h.media.seek(0.5)
		h.frames.step(h.media)
		expect(h.media.currentTime).toBe(2)
	})

	it("loops within the trimmed part", async () => {
		const h = harness({ trim: { startMs: 1000, endMs: 8000 }, bookmarks: [{ name: "b", timeMs: 1500 }] }, 10, true)

		await h.media.play()

		for (let k = 0; k < 200; k++) h.frames.step(h.media)

		expect(h.media.paused).toBe(false)
		expect(h.ended()).toBe(0)
		expect(h.media.currentTime).toBeGreaterThanOrEqual(1)
		expect(h.media.currentTime).toBeLessThanOrEqual(2.05)
		// One pass each second of trimmed part (200 frames: over three passes).
		expect(h.fired.length).toBeGreaterThanOrEqual(3)
	})

	it("fires each bookmark on the first frame its time is reached, once, in order", async () => {
		const bookmarks = [
			{ name: "a", timeMs: 500 },
			{ name: "b", timeMs: 510 },
			{ name: "c", timeMs: 2000 }
		]
		const h = harness({ bookmarks })

		await h.media.play()

		for (let k = 0; k < 200; k++) h.frames.step(h.media)

		expect(h.fired.map(entry => entry.name)).toEqual(["a", "b", "c"])

		for (const [index, entry] of h.fired.entries()) {
			const late = entry.atMs - (bookmarks[index]?.timeMs ?? 0)

			expect(late).toBeGreaterThanOrEqual(0)
			expect(late).toBeLessThan(FRAME_MS)
		}
	})

	it("fires none of the bookmarks a seek forward skips, and those ahead after a seek back", async () => {
		const h = harness({
			bookmarks: [
				{ name: "a", timeMs: 1000 },
				{ name: "b", timeMs: 3000 }
			]
		})

		await h.media.play()
		h.media.seek(2)
		h.frames.step(h.media)
		expect(h.fired).toEqual([])

		for (let k = 0; k < 70; k++) h.frames.step(h.media)

		expect(h.fired.map(entry => entry.name)).toEqual(["b"])

		h.media.seek(0.9)

		for (let k = 0; k < 10; k++) h.frames.step(h.media)

		expect(h.fired.map(entry => entry.name)).toEqual(["b", "a"])
	})

	it("scales the file's volume by the fade in and out", async () => {
		const h = harness({ trim: { startMs: 0, endMs: 0 }, fade: { inMs: 1000, outMs: 1000 } }, 4)

		await h.media.play()
		expect(h.media.volume).toBe(0)

		for (let k = 0; k < 30; k++) h.frames.step(h.media)

		expect(h.media.volume).toBeCloseTo(0.4, 1)

		for (let k = 0; k < 60; k++) h.frames.step(h.media)

		expect(h.media.volume).toBeCloseTo(0.8, 5)

		// 3.75 s: a quarter of the way through the last second.
		for (let k = 0; k < 135; k++) h.frames.step(h.media)

		expect(h.media.volume).toBeCloseTo(0.2, 2)
	})

	it("stops sampling while paused and lets go of the element when disposed", async () => {
		const h = harness({ bookmarks: [{ name: "a", timeMs: 100 }] })

		await h.media.play()
		h.frames.step(h.media)
		h.media.pause()
		expect(h.frames.waiting).toBe(0)

		h.driver.dispose()
		expect(h.media.listening()).toBe(0)
	})
})

describe("the lengths the player learnt", () => {
	it("keeps each medium's length per session in whole milliseconds, ignoring an unknown one", () => {
		const session = {}

		noteMediaDuration(session, "/ppt/media/media1.mp4", 10.0004)
		noteMediaDuration(session, "/ppt/media/media2.mp4", Number.NaN)
		noteMediaDuration(session, "/ppt/media/media3.mp4", Number.POSITIVE_INFINITY)

		expect(knownMediaDuration(session, "/ppt/media/media1.mp4")).toBe(10_000)
		expect(knownMediaDuration(session, "/ppt/media/media2.mp4")).toBeUndefined()
		expect(knownMediaDuration(session, "/ppt/media/media3.mp4")).toBeUndefined()
		expect(knownMediaDuration({}, "/ppt/media/media1.mp4")).toBeUndefined()
	})
})
