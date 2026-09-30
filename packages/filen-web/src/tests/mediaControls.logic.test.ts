import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseBufferedRanges, percentOf, ratioAt, scrubberKeyTarget, SEEK_STEP_SECONDS, timeAtRatio } from "@/lib/media/scrubber.logic"
import { playerKeyAction, playerKeyTarget, VOLUME_STEP, type PlayerKeyInput } from "@/lib/media/playerKeys.logic"
import { CONTROLS_IDLE_MS, controlsVisible, IdleTimer, type ControlsVisibility } from "@/lib/media/autoHide.logic"

describe("scrubber math", () => {
	it("maps a pointer x onto the rail, clamped to its ends", () => {
		expect(ratioAt(150, 100, 200)).toBe(0.25)
		expect(ratioAt(50, 100, 200)).toBe(0)
		expect(ratioAt(400, 100, 200)).toBe(1)
		expect(ratioAt(150, 100, 0)).toBe(0)
	})

	it("turns a ratio into a time within the file", () => {
		expect(timeAtRatio(0.5, 120)).toBe(60)
		expect(timeAtRatio(1.5, 120)).toBe(120)
		expect(timeAtRatio(0.5, 0)).toBe(0)
	})

	it("clamps a time, and reads an unknown duration as nothing to seek", () => {
		expect(timeAtRatio(-0.1, 10)).toBe(0)
		expect(timeAtRatio(Number.NaN, 10)).toBe(0)
		expect(timeAtRatio(0.5, 0)).toBe(0)
	})

	it("gives the fill a percentage", () => {
		expect(percentOf(30, 120)).toBe(25)
		expect(percentOf(30, 0)).toBe(0)
		expect(percentOf(500, 120)).toBe(100)
	})
})

describe("scrubberKeyTarget", () => {
	const duration = 200

	it("steps the arrows by the seek step, both axes", () => {
		expect(scrubberKeyTarget("ArrowRight", 50, duration, SEEK_STEP_SECONDS)).toBe(55)
		expect(scrubberKeyTarget("ArrowUp", 50, duration, SEEK_STEP_SECONDS)).toBe(55)
		expect(scrubberKeyTarget("ArrowLeft", 50, duration, SEEK_STEP_SECONDS)).toBe(45)
		expect(scrubberKeyTarget("ArrowDown", 50, duration, SEEK_STEP_SECONDS)).toBe(45)
	})

	it("pages a tenth of the file, never less than a step", () => {
		expect(scrubberKeyTarget("PageUp", 50, duration, SEEK_STEP_SECONDS)).toBe(70)
		expect(scrubberKeyTarget("PageDown", 50, duration, SEEK_STEP_SECONDS)).toBe(30)
		expect(scrubberKeyTarget("PageUp", 0, 20, SEEK_STEP_SECONDS)).toBe(5)
	})

	it("jumps to either end and never past one", () => {
		expect(scrubberKeyTarget("Home", 50, duration, SEEK_STEP_SECONDS)).toBe(0)
		expect(scrubberKeyTarget("End", 50, duration, SEEK_STEP_SECONDS)).toBe(duration)
		expect(scrubberKeyTarget("ArrowRight", 198, duration, SEEK_STEP_SECONDS)).toBe(duration)
		expect(scrubberKeyTarget("ArrowLeft", 2, duration, SEEK_STEP_SECONDS)).toBe(0)
	})

	it("leaves other keys, and every key while the length is unknown, alone", () => {
		expect(scrubberKeyTarget("Enter", 50, duration, SEEK_STEP_SECONDS)).toBeNull()
		expect(scrubberKeyTarget("ArrowRight", 0, 0, SEEK_STEP_SECONDS)).toBeNull()
	})
})

describe("parseBufferedRanges", () => {
	it("reads back the serialized ranges", () => {
		expect(parseBufferedRanges("0~12.5,30~41")).toEqual([
			{ start: 0, end: 12.5 },
			{ start: 30, end: 41 }
		])
	})

	it("survives an exponent in a boundary", () => {
		expect(parseBufferedRanges("1e-7~3")).toEqual([{ start: 1e-7, end: 3 }])
	})

	it("drops empty and malformed parts", () => {
		expect(parseBufferedRanges("")).toEqual([])
		expect(parseBufferedRanges("5~5,x~3,4~2,1~2")).toEqual([{ start: 1, end: 2 }])
	})
})

describe("playerKeyAction", () => {
	function action(overrides: Partial<PlayerKeyInput>) {
		return playerKeyAction({ key: " ", target: "surface", modified: false, fullscreen: true, ...overrides })
	}

	it("plays and pauses on Space and K", () => {
		expect(action({ key: " " })).toEqual({ type: "togglePlay" })
		expect(action({ key: "k" })).toEqual({ type: "togglePlay" })
		expect(action({ key: "K" })).toEqual({ type: "togglePlay" })
	})

	it("seeks on the side arrows and steps the volume on the others", () => {
		expect(action({ key: "ArrowRight" })).toEqual({ type: "seekBy", seconds: 5 })
		expect(action({ key: "ArrowLeft" })).toEqual({ type: "seekBy", seconds: -5 })
		expect(action({ key: "ArrowUp" })).toEqual({ type: "volumeBy", delta: VOLUME_STEP })
		expect(action({ key: "ArrowDown" })).toEqual({ type: "volumeBy", delta: -VOLUME_STEP })
	})

	it("mutes on M and fullscreens on F, but only where the player can", () => {
		expect(action({ key: "m" })).toEqual({ type: "toggleMute" })
		expect(action({ key: "f" })).toEqual({ type: "toggleFullscreen" })
		expect(action({ key: "f", fullscreen: false })).toBeNull()
	})

	it("leaves a focused button its own Space, and a slider its own arrows", () => {
		expect(action({ key: " ", target: "button" })).toBeNull()
		expect(action({ key: "ArrowRight", target: "button" })).toEqual({ type: "seekBy", seconds: 5 })
		expect(action({ key: "ArrowRight", target: "slider" })).toBeNull()
		expect(action({ key: "ArrowUp", target: "slider" })).toBeNull()
		expect(action({ key: " ", target: "slider" })).toEqual({ type: "togglePlay" })
	})

	it("leaves chords, menus and text fields entirely alone", () => {
		expect(action({ key: "k", modified: true })).toBeNull()
		expect(action({ key: "ArrowRight", target: "menu" })).toBeNull()
		expect(action({ key: "m", target: "field" })).toBeNull()
	})

	it("ignores keys it has no action for", () => {
		expect(action({ key: "Escape" })).toBeNull()
		expect(action({ key: "Tab" })).toBeNull()
	})
})

describe("playerKeyTarget", () => {
	// Element-shaped: `closest` answers for the selectors naming one of `ancestors`.
	function element(ancestors: readonly string[]): EventTarget {
		return {
			closest: (selector: string) => (ancestors.some(fragment => selector.includes(fragment)) ? {} : null)
		} as unknown as EventTarget
	}

	it("reads a non-element (the document, null) as the surface", () => {
		expect(playerKeyTarget(null)).toBe("surface")
	})

	it("classifies sliders, fields, menus and buttons", () => {
		expect(playerKeyTarget(element(["input[type='range']"]))).toBe("slider")
		expect(playerKeyTarget(element(["textarea"]))).toBe("field")
		expect(playerKeyTarget(element(["[role='menuitem']"]))).toBe("menu")
		expect(playerKeyTarget(element(["button"]))).toBe("button")
		expect(playerKeyTarget(element([]))).toBe("surface")
	})
})

describe("controlsVisible", () => {
	const playing: ControlsVisibility = {
		paused: false,
		waiting: false,
		pointerActive: false,
		keyboardFocus: false,
		menuOpen: false,
		scrubbing: false
	}

	it("hides only while playback runs untouched", () => {
		expect(controlsVisible(playing)).toBe(false)
	})

	it.each(["paused", "waiting", "pointerActive", "keyboardFocus", "menuOpen", "scrubbing"] as const)("shows while %s", key => {
		expect(controlsVisible({ ...playing, [key]: true })).toBe(true)
	})
})

describe("IdleTimer", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("goes active on a poke and idle after the delay, reporting only the edges", () => {
		const onChange = vi.fn<(active: boolean) => void>()
		const timer = new IdleTimer(onChange, CONTROLS_IDLE_MS)

		timer.poke()
		timer.poke()
		vi.advanceTimersByTime(CONTROLS_IDLE_MS - 1)
		timer.poke()
		vi.advanceTimersByTime(CONTROLS_IDLE_MS - 1)

		expect(onChange.mock.calls).toEqual([[true]])

		vi.advanceTimersByTime(1)

		expect(onChange.mock.calls).toEqual([[true], [false]])
	})

	it("goes idle at once when told to, and stop leaves it as it is", () => {
		const onChange = vi.fn<(active: boolean) => void>()
		const timer = new IdleTimer(onChange, CONTROLS_IDLE_MS)

		timer.poke()
		timer.idle()

		expect(onChange.mock.calls).toEqual([[true], [false]])

		timer.poke()
		timer.stop()
		vi.advanceTimersByTime(CONTROLS_IDLE_MS * 2)

		expect(onChange.mock.calls).toEqual([[true], [false], [true]])
	})
})
