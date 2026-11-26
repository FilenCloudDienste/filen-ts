import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	chapterTarget,
	FRAME_INTERVAL_MAX_FRAMES,
	FRAME_INTERVAL_SAMPLES,
	frameDuration,
	FrameIntervalMeter,
	STAGE_MEDIA_ACTIONS,
	stepPlaybackRate,
	videoKeyAction
} from "@/lib/media/videoKeys.logic"
import { mediaKeyAction } from "@/lib/media/mediaKeys.logic"
import { MEDIA_ACTIONS } from "@/lib/media/keymap"
import type { PlayerKeyTarget } from "@/lib/media/playerKeys.logic"
import { SEEK_COALESCE_MS, SeekCoalescer } from "@/lib/media/seekCoalescer.logic"

// The stage's action for a keydown on its defaults: the physical key (code), the character, Shift.
function key(code: string, character: string, shift = false, target: PlayerKeyTarget = "surface") {
	const media = mediaKeyAction(
		{ code, key: character, ctrlKey: false, metaKey: false, shiftKey: shift, altKey: false },
		target,
		STAGE_MEDIA_ACTIONS,
		{},
		false
	)

	return media === null ? null : videoKeyAction(media)
}

describe("the Videos player's keys", () => {
	it("maps the player's keys on the picture", () => {
		expect(key("Space", " ")).toEqual({ type: "togglePlay" })
		expect(key("KeyK", "k")).toEqual({ type: "togglePlay" })
		expect(key("ArrowLeft", "ArrowLeft")).toEqual({ type: "seekBy", seconds: -10 })
		expect(key("KeyJ", "j")).toEqual({ type: "seekBy", seconds: -10 })
		expect(key("ArrowRight", "ArrowRight")).toEqual({ type: "seekBy", seconds: 10 })
		expect(key("KeyL", "l")).toEqual({ type: "seekBy", seconds: 10 })
		expect(key("ArrowLeft", "ArrowLeft", true)).toEqual({ type: "seekBy", seconds: -60 })
		expect(key("ArrowRight", "ArrowRight", true)).toEqual({ type: "seekBy", seconds: 60 })
		expect(key("ArrowUp", "ArrowUp")).toEqual({ type: "volumeBy", delta: 0.05 })
		expect(key("ArrowDown", "ArrowDown")).toEqual({ type: "volumeBy", delta: -0.05 })
		expect(key("KeyM", "m")).toEqual({ type: "toggleMute" })
		expect(key("KeyF", "f")).toEqual({ type: "toggleFullscreen" })
		expect(key("KeyC", "c")).toEqual({ type: "toggleSubtitles" })
		expect(key("KeyC", "C", true)).toEqual({ type: "cycleSubtitles" })
		expect(key("KeyA", "a")).toEqual({ type: "cycleAudio" })
		expect(key("KeyE", "e")).toEqual({ type: "episodes" })
		expect(key("KeyS", "s")).toEqual({ type: "skip" })
		expect(key("KeyI", "i")).toEqual({ type: "togglePictureInPicture" })
		expect(key("KeyR", "r")).toEqual({ type: "toggleRepeat" })
		expect(key("KeyG", "g")).toEqual({ type: "subtitleDelay", seconds: -0.1 })
		expect(key("KeyH", "h")).toEqual({ type: "subtitleDelay", seconds: 0.1 })
		expect(key("Home", "Home")).toEqual({ type: "seekToStart" })
		expect(key("End", "End")).toEqual({ type: "seekToEnd" })
		expect(key("PageDown", "PageDown")).toEqual({ type: "chapter", direction: 1 })
		expect(key("PageUp", "PageUp")).toEqual({ type: "chapter", direction: -1 })
		expect(key("Comma", ",")).toEqual({ type: "frameStep", direction: -1 })
		expect(key("Period", ".")).toEqual({ type: "frameStep", direction: 1 })
		expect(key("Equal", "=")).toEqual({ type: "normalRate" })
		expect(key("Escape", "Escape")).toEqual({ type: "dismiss" })
		expect(key("Backspace", "Backspace")).toBeNull()
	})

	it("maps the number keys to tenths of the file", () => {
		expect(key("Digit0", "0")).toEqual({ type: "seekToFraction", fraction: 0 })
		expect(key("Digit5", "5")).toEqual({ type: "seekToFraction", fraction: 0.5 })
		expect(key("Numpad9", "9")).toEqual({ type: "seekToFraction", fraction: 0.9 })
	})

	it("takes its Shift combinations", () => {
		expect(key("KeyN", "N", true)).toEqual({ type: "next" })
		expect(key("KeyP", "P", true)).toEqual({ type: "previous" })
		expect(key("Comma", "<", true)).toEqual({ type: "rate", direction: -1 })
		expect(key("Period", ">", true)).toEqual({ type: "rate", direction: 1 })
		expect(key("KeyK", "K", true)).toBeNull()
	})

	it("leaves a slider its arrows, a button its Space and Enter, and menus and fields everything", () => {
		expect(key("ArrowLeft", "ArrowLeft", false, "slider")).toBeNull()
		expect(key("Home", "Home", false, "slider")).toBeNull()
		expect(key("PageUp", "PageUp", false, "slider")).toBeNull()
		expect(key("KeyM", "m", false, "slider")).toEqual({ type: "toggleMute" })
		expect(key("Space", " ", false, "button")).toBeNull()
		expect(key("KeyK", "k", false, "button")).toEqual({ type: "togglePlay" })
		expect(key("KeyK", "k", false, "menu")).toBeNull()
		expect(key("KeyK", "k", false, "field")).toBeNull()
	})

	it("acts on every media key it takes, and takes every one", () => {
		for (const def of MEDIA_ACTIONS) {
			expect(STAGE_MEDIA_ACTIONS, def.id).toContain(def.id)
			expect(videoKeyAction(def.id), def.id).not.toBeNull()
		}
	})
})

describe("player key helpers", () => {
	it("steps the playback rate along the list from wherever it is", () => {
		expect(stepPlaybackRate(1, 1)).toBe(1.25)
		expect(stepPlaybackRate(1, -1)).toBe(0.75)
		expect(stepPlaybackRate(2, 1)).toBe(2)
		expect(stepPlaybackRate(0.5, -1)).toBe(0.5)
		expect(stepPlaybackRate(1.1, 1)).toBe(1.25)
		expect(stepPlaybackRate(1.1, -1)).toBe(1)
	})

	it("finds the next and previous chapter, going back past a chapter's first seconds", () => {
		const starts = [0, 60, 300, 900]

		expect(chapterTarget(starts, 100, 1)).toBe(300)
		expect(chapterTarget(starts, 100, -1)).toBe(60)
		expect(chapterTarget(starts, 61, -1)).toBe(0)
		expect(chapterTarget(starts, 950, 1)).toBeNull()
		expect(chapterTarget([], 10, 1)).toBeNull()
	})

	it("uses the measured frame interval for a frame step, 24 fps when unknown", () => {
		expect(frameDuration(0.04)).toBeCloseTo(0.04)
		expect(frameDuration(null)).toBeCloseTo(1 / 24)
		expect(frameDuration(0)).toBeCloseTo(1 / 24)
	})
})

describe("FrameIntervalMeter", () => {
	it("measures the interval between frames presented one after another", () => {
		const meter = new FrameIntervalMeter()

		expect(meter.add({ mediaTime: 10, presentedFrames: 100 }, 1)).toBe(true)
		expect(meter.interval).toBeNull()
		meter.add({ mediaTime: 10 + 1 / 60, presentedFrames: 101 }, 1)
		expect(meter.interval).toBeCloseTo(1 / 60)
	})

	it("skips a frame the display dropped, a seek and other speeds, and keeps the shortest interval", () => {
		const meter = new FrameIntervalMeter()

		meter.add({ mediaTime: 0, presentedFrames: 1 }, 1)
		// Two presentations apart: not one interval.
		meter.add({ mediaTime: 2 / 50, presentedFrames: 3 }, 1)
		expect(meter.interval).toBeNull()
		// A jump: a seek or a stall.
		meter.add({ mediaTime: 30, presentedFrames: 4 }, 1)
		expect(meter.interval).toBeNull()
		meter.add({ mediaTime: 30 + 2 / 50, presentedFrames: 5 }, 1)
		meter.add({ mediaTime: 30 + 3 / 50, presentedFrames: 6 }, 1)
		expect(meter.interval).toBeCloseTo(1 / 50)
		expect(meter.add({ mediaTime: 31, presentedFrames: 7 }, 2)).toBe(false)
		expect(meter.interval).toBeCloseTo(1 / 50)
	})

	it("stops a run once it has its samples or has looked at enough frames", () => {
		const meter = new FrameIntervalMeter()
		let wants = true
		let frame = 0

		while (wants) {
			wants = meter.add({ mediaTime: frame / 30, presentedFrames: frame }, 1)
			frame++
		}

		expect(frame).toBe(FRAME_INTERVAL_SAMPLES + 1)

		meter.restart()
		wants = true
		frame = 0

		while (wants) {
			wants = meter.add({ mediaTime: frame, presentedFrames: frame * 2 }, 1)
			frame++
		}

		expect(frame).toBe(FRAME_INTERVAL_MAX_FRAMES)
		// The last run's interval stays until a run measures one; a new source forgets it.
		expect(meter.interval).toBeCloseTo(1 / 30)
		meter.reset()
		expect(meter.interval).toBeNull()
	})
})

describe("SeekCoalescer", () => {
	let now = 0
	let position = 100
	let seeks: number[] = []
	let pending: (number | null)[] = []

	function make(): SeekCoalescer {
		return new SeekCoalescer({
			current: () => position,
			duration: () => 600,
			seek: seconds => {
				seeks.push(seconds)
				position = seconds
			},
			onPending: seconds => {
				pending.push(seconds)
			},
			now: () => now,
			setTimer: (callback, ms) => setTimeout(callback, ms),
			clearTimer: timer => {
				clearTimeout(timer)
			}
		})
	}

	beforeEach(() => {
		vi.useFakeTimers()
		now = 0
		position = 100
		seeks = []
		pending = []
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("seeks at once on the first press", () => {
		make().seekBy(10)

		expect(seeks).toEqual([110])
		expect(pending).toEqual([])
	})

	it("collapses repeats within the window into one trailing seek", () => {
		const coalescer = make()

		coalescer.seekBy(10)
		now += 50
		coalescer.seekBy(10)
		now += 50
		coalescer.seekBy(10)
		now += 50
		coalescer.seekBy(10)

		expect(seeks).toEqual([110])
		expect(coalescer.target()).toBe(140)
		expect(pending.at(-1)).toBe(140)

		vi.advanceTimersByTime(SEEK_COALESCE_MS)

		expect(seeks).toEqual([110, 140])
		expect(pending.at(-1)).toBeNull()
	})

	it("starts a new window after a pause in the presses", () => {
		const coalescer = make()

		coalescer.seekBy(-10)
		now += SEEK_COALESCE_MS + 1
		coalescer.seekBy(-10)

		expect(seeks).toEqual([90, 80])
	})

	it("clamps to the file and drops a pending seek on cancel", () => {
		const coalescer = make()

		coalescer.seekTo(700)
		now += 10
		coalescer.seekBy(-1000)
		coalescer.cancel()
		vi.advanceTimersByTime(SEEK_COALESCE_MS)

		expect(seeks).toEqual([600])
		expect(pending.at(-1)).toBeNull()
	})
})
