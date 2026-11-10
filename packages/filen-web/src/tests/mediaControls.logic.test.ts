import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parseBufferedRanges, percentOf, ratioAt, scrubberKeyTarget, timeAtRatio } from "@/lib/media/scrubber.logic"
import { playerKeyTarget, type PlayerKeyTarget } from "@/lib/media/playerKeys.logic"
import { MEDIA_JUMP_ACTIONS, type MediaAction } from "@/lib/media/keymap"
import {
	jumpFraction,
	MEDIA_SEEK_STEP_SECONDS as SEEK_STEP_SECONDS,
	mediaKeyAction,
	mediaKeyRepeats,
	type MediaKeyEvent
} from "@/lib/media/mediaKeys.logic"
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
		expect(scrubberKeyTarget("ArrowRight", 50, duration, SEEK_STEP_SECONDS)).toBe(60)
		expect(scrubberKeyTarget("ArrowUp", 50, duration, SEEK_STEP_SECONDS)).toBe(60)
		expect(scrubberKeyTarget("ArrowLeft", 50, duration, SEEK_STEP_SECONDS)).toBe(40)
		expect(scrubberKeyTarget("ArrowDown", 50, duration, SEEK_STEP_SECONDS)).toBe(40)
	})

	it("pages a tenth of the file, never less than a step", () => {
		expect(scrubberKeyTarget("PageUp", 50, duration, SEEK_STEP_SECONDS)).toBe(70)
		expect(scrubberKeyTarget("PageDown", 50, duration, SEEK_STEP_SECONDS)).toBe(30)
		expect(scrubberKeyTarget("PageUp", 0, 20, SEEK_STEP_SECONDS)).toBe(10)
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

// A keydown as the matchers read it: its physical key (code) and the character it typed (key).
function keydown(code: string, key: string, modifiers: Partial<Pick<MediaKeyEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey">> = {}) {
	return { code, key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...modifiers }
}

describe("mediaKeyAction", () => {
	const actions: readonly MediaAction[] = [
		"media.playPause",
		"media.seekBack",
		"media.seekForward",
		"media.volumeUp",
		"media.mute",
		"media.jump.fifty"
	]

	function action(event: MediaKeyEvent, target: PlayerKeyTarget = "surface", combos: Readonly<Record<string, string>> = {}) {
		return mediaKeyAction(event, target, actions, combos, false)
	}

	it("matches the defaults by physical key", () => {
		expect(action(keydown("Space", " "))).toBe("media.playPause")
		expect(action(keydown("KeyK", "k"))).toBe("media.playPause")
		expect(action(keydown("ArrowLeft", "ArrowLeft"))).toBe("media.seekBack")
		expect(action(keydown("KeyL", "l"))).toBe("media.seekForward")
		expect(action(keydown("ArrowUp", "ArrowUp"))).toBe("media.volumeUp")
		expect(action(keydown("KeyM", "m"))).toBe("media.mute")
		expect(action(keydown("Digit5", "5"))).toBe("media.jump.fifty")
		// The physical key, whatever it types: a French keyboard's ; key types "," yet is not Comma.
		expect(action(keydown("KeyM", ","))).toBe("media.mute")
	})

	it("follows a rebound action and drops its default", () => {
		const combos = { "media.mute": "u", "media.playPause": "none" }

		expect(action(keydown("KeyU", "u"), "surface", combos)).toBe("media.mute")
		expect(action(keydown("KeyM", "m"), "surface", combos)).toBeNull()
		expect(action(keydown("Space", " "), "surface", combos)).toBeNull()
	})

	it("matches modifiers exactly and leaves actions the player does not take", () => {
		expect(action(keydown("KeyK", "k", { ctrlKey: true }))).toBeNull()
		expect(action(keydown("ArrowLeft", "ArrowLeft", { shiftKey: true }))).toBeNull()
		expect(action(keydown("KeyF", "f"))).toBeNull()
	})

	it("leaves a slider its arrows, a button its Space and menus and fields everything", () => {
		expect(action(keydown("ArrowRight", "ArrowRight"), "slider")).toBeNull()
		expect(action(keydown("KeyM", "m"), "slider")).toBe("media.mute")
		expect(action(keydown("Space", " "), "button")).toBeNull()
		expect(action(keydown("ArrowRight", "ArrowRight"), "button")).toBe("media.seekForward")
		expect(action(keydown("KeyK", "k"), "menu")).toBeNull()
		expect(action(keydown("KeyM", "m"), "field")).toBeNull()
	})

	it("leaves a key an input method is composing with", () => {
		expect(action({ ...keydown("KeyK", "Process"), isComposing: true })).toBeNull()
	})

	it("repeats seeks and volume steps only", () => {
		expect(mediaKeyRepeats("media.seekBack")).toBe(true)
		expect(mediaKeyRepeats("media.volumeUp")).toBe(true)
		expect(mediaKeyRepeats("media.playPause")).toBe(false)
		expect(mediaKeyRepeats("media.mute")).toBe(false)
	})

	it("jumps the number keys to tenths of the file", () => {
		expect(MEDIA_JUMP_ACTIONS.map(jumpFraction)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])
		expect(jumpFraction("media.mute")).toBeNull()
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
