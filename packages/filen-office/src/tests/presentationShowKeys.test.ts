import { describe, expect, it, vi } from "vitest"
import { slideRef } from "../core/presentation/model"
import { createInkStore } from "../react/presentation/ink/store"
import {
	createShowKeys,
	DEFAULT_SHOW_BINDINGS,
	pressesControl,
	showKeyCommand,
	type ShowKeyEvent
} from "../react/presentation/presenter/keys"
import { createShowSwipe } from "../react/presentation/presenter/swipe"
import { formatElapsed, pauseTimer, resetTimer, resumeTimer, startShowTimer, timerElapsed } from "../react/presentation/presenter/timer"
import { unavailableShowController, type ShowController } from "../react/presentation/show/controller"

// The slideshow's keys (PowerPoint's and a clicker's), touch swipes and the presenter's timer.

function key(code: string, init: Partial<ShowKeyEvent> = {}): ShowKeyEvent & { prevented: boolean; stopped: boolean } {
	const event = {
		key: init.key ?? code,
		code,
		shiftKey: init.shiftKey ?? false,
		ctrlKey: init.ctrlKey ?? false,
		metaKey: init.metaKey ?? false,
		altKey: init.altKey ?? false,
		repeat: init.repeat ?? false,
		prevented: false,
		stopped: false,
		preventDefault() {
			event.prevented = true
		},
		stopPropagation() {
			event.stopped = true
		}
	}

	return event
}

function spyController(): ShowController & { calls: string[] } {
	const calls: string[] = []
	const base = unavailableShowController()

	return {
		...base,
		calls,
		next: () => calls.push("next"),
		prev: () => calls.push("prev"),
		goto: index => calls.push(`goto ${String(index)}`),
		black: () => calls.push("black"),
		white: () => calls.push("white"),
		end: () => calls.push("end")
	}
}

describe("show keys", () => {
	it("maps PowerPoint's and a clicker's keys to the show's commands", () => {
		const command = (code: string, init?: Partial<ShowKeyEvent>) => showKeyCommand(key(code, init), DEFAULT_SHOW_BINDINGS, false)

		for (const code of ["ArrowRight", "ArrowDown", "PageDown", "Space", "Enter", "NumpadEnter", "KeyN"])
			expect(command(code), code).toBe("next")
		for (const code of ["ArrowLeft", "ArrowUp", "PageUp", "KeyP"]) expect(command(code), code).toBe("previous")
		expect(command("Home")).toBe("first")
		expect(command("End")).toBe("last")
		expect(command("KeyB")).toBe("black")
		expect(command("KeyW")).toBe("white")
		expect(command("Escape")).toBe("end")
		expect(command("KeyE")).toBe("eraseAll")
		expect(command("KeyL", { ctrlKey: true })).toBe("laser")
		expect(command("KeyP", { ctrlKey: true })).toBe("pen")
		expect(command("KeyA", { ctrlKey: true })).toBe("arrow")
		expect(command("F5")).toBe("start")
		expect(command("F5", { shiftKey: true })).toBe("startCurrent")
		// Mod is Cmd on Apple platforms.
		expect(showKeyCommand(key("KeyP", { metaKey: true }), DEFAULT_SHOW_BINDINGS, true)).toBe("pen")
		expect(showKeyCommand(key("KeyP", { ctrlKey: true }), DEFAULT_SHOW_BINDINGS, true)).toBeUndefined()
		expect(command("KeyQ")).toBeUndefined()
	})

	it("takes PowerPoint's Backspace, period and comma in the presenter view too", () => {
		const command = (code: string, init?: Partial<ShowKeyEvent>) => showKeyCommand(key(code, init), DEFAULT_SHOW_BINDINGS, false)

		expect(command("Backspace")).toBe("previous")
		expect(command("Period", { key: "." })).toBe("black")
		expect(command("Comma", { key: "," })).toBe("white")
		// The recorder's tokens for those keys, and the characters older combos spelled them with.
		expect(showKeyCommand(key("Period"), { ...DEFAULT_SHOW_BINDINGS, black: "period" }, false)).toBe("black")
		expect(showKeyCommand(key("Comma"), { ...DEFAULT_SHOW_BINDINGS, white: "," }, false)).toBe("white")
		expect(showKeyCommand(key("Equal", { key: "=" }), { ...DEFAULT_SHOW_BINDINGS, togglePointer: "a,=" }, false)).toBe("togglePointer")
	})

	it("matches a recorded key the named table does not list by its code", () => {
		expect(showKeyCommand(key("Semicolon"), { ...DEFAULT_SHOW_BINDINGS, black: "semicolon" }, false)).toBe("black")
		expect(showKeyCommand(key("BracketLeft"), { ...DEFAULT_SHOW_BINDINGS, white: "bracketleft" }, false)).toBe("white")
	})

	it("Mod+E toggles the eraser and H shows the next slide only through the controller's hidden-slide step", () => {
		const calls: string[] = []
		const controller = { ...spyController(), nextHidden: () => calls.push("nextHidden") }
		const ink = createInkStore()
		const keys = createShowKeys({ controller: () => controller, ink, apple: false })

		expect(showKeyCommand(key("KeyE", { ctrlKey: true }), DEFAULT_SHOW_BINDINGS, false)).toBe("eraser")
		expect(showKeyCommand(key("KeyE", { metaKey: true }), DEFAULT_SHOW_BINDINGS, true)).toBe("eraser")
		keys.onKeyDown(key("KeyE", { ctrlKey: true }))
		expect(ink.getSnapshot().tool).toBe("eraser")
		keys.onKeyDown(key("KeyE", { ctrlKey: true }))
		expect(ink.getSnapshot().tool).toBe("none")
		keys.onKeyDown(key("KeyH"))
		expect(calls).toEqual(["nextHidden"])
		expect(controller.calls).toEqual([])
		// A player without the step takes H and does nothing.
		const plain = spyController()
		const fallback = createShowKeys({ controller: () => plain, apple: false })

		expect(fallback.onKeyDown(key("KeyH"))).toBe(true)
		expect(plain.calls).toEqual([])
	})

	it("matches every alternative and skips sequences", () => {
		const bindings = { ...DEFAULT_SHOW_BINDINGS, laser: "mod+shift+x,n", pen: "g>i" }

		expect(showKeyCommand(key("KeyX", { ctrlKey: true, shiftKey: true }), bindings, false)).toBe("laser")
		expect(showKeyCommand(key("KeyN"), { ...bindings, next: "" }, false)).toBe("laser")
		expect(showKeyCommand(key("KeyG"), bindings, false)).toBeUndefined()
	})

	it("drives the controller, goes to a typed slide number on Enter and stops the key there", () => {
		const controller = spyController()
		const keys = createShowKeys({ controller: () => controller, apple: false })
		const right = key("ArrowRight")

		expect(keys.onKeyDown(right)).toBe(true)
		expect(right.prevented && right.stopped).toBe(true)
		keys.onKeyDown(key("PageUp"))
		keys.onKeyDown(key("KeyB"))
		keys.onKeyDown(key("KeyW"))
		keys.onKeyDown(key("Digit1"))
		keys.onKeyDown(key("Numpad2"))
		expect(keys.typed).toBe("12")
		keys.onKeyDown(key("Enter"))
		// Enter without a number goes on.
		keys.onKeyDown(key("Enter"))
		keys.onKeyDown(key("Escape"))
		expect(controller.calls).toEqual(["next", "prev", "black", "white", "goto 11", "next", "end"])
		expect(keys.onKeyDown(key("KeyQ"))).toBe(false)
	})

	it("Home and End use the controller's first and last when it has them", () => {
		const calls: string[] = []
		const controller = { ...spyController(), first: () => calls.push("first"), last: () => calls.push("last") }
		const keys = createShowKeys({ controller: () => controller, apple: false })

		keys.onKeyDown(key("Home"))
		keys.onKeyDown(key("End"))
		expect(calls).toEqual(["first", "last"])

		const plain = spyController()
		const fallback = createShowKeys({ controller: () => plain, count: () => 7, apple: false })

		fallback.onKeyDown(key("Home"))
		fallback.onKeyDown(key("End"))
		expect(plain.calls).toEqual(["goto 0", "goto 6"])
	})

	it("switches the ink tools, erases the slide's ink, and puts the pen down before Escape ends the show", () => {
		const controller = spyController()
		const ink = createInkStore()
		const slide = slideRef(5)
		const keys = createShowKeys({ controller: () => controller, ink, slide: () => slide, apple: false })

		keys.onKeyDown(key("KeyP", { ctrlKey: true }))
		expect(ink.getSnapshot().tool).toBe("pen")
		ink.begin(slide, 10, 10)
		ink.extend([20, 20])
		ink.end()
		keys.onKeyDown(key("KeyE"))
		expect(ink.strokes(slide)).toHaveLength(0)
		keys.onKeyDown(key("KeyL", { ctrlKey: true }))
		expect(ink.getSnapshot().tool).toBe("laser")
		keys.onKeyDown(key("Escape"))
		expect(ink.getSnapshot().tool).toBe("none")
		expect(controller.calls).toEqual([])
		keys.onKeyDown(key("KeyP", { ctrlKey: true }))
		keys.onKeyDown(key("KeyA", { ctrlKey: true }))
		expect(ink.getSnapshot().tool).toBe("none")
		keys.onKeyDown(key("Escape"))
		expect(controller.calls).toEqual(["end"])
	})

	it("takes a clicker's F5 without doing anything and ignores a held toggle", () => {
		const controller = spyController()
		const keys = createShowKeys({ controller: () => controller, apple: false })
		const f5 = key("F5")

		expect(keys.onKeyDown(f5)).toBe(true)
		expect(f5.prevented).toBe(true)
		keys.onKeyDown(key("KeyB"))
		keys.onKeyDown(key("KeyB", { repeat: true }))
		keys.onKeyDown(key("ArrowRight", { repeat: true }))
		expect(controller.calls).toEqual(["black", "next"])
	})

	it("hides the pointer on Ctrl+H (Ctrl on a Mac too), toggles it on A or = and returns it to automatic on Mod+A", () => {
		const changes: string[] = []
		const ink = createInkStore()
		const pointer = (change: string): void => {
			changes.push(change)
		}
		const keys = createShowKeys({ controller: () => undefined, ink, apple: false, pointer })
		const mac = createShowKeys({ controller: () => undefined, ink, apple: true, pointer })

		const hide = key("KeyH", { ctrlKey: true })

		expect(keys.onKeyDown(hide)).toBe(true)
		expect(hide.prevented).toBe(true)
		keys.onKeyDown(key("KeyA"))
		keys.onKeyDown(key("Equal"))
		keys.onKeyDown(key("KeyA", { repeat: true }))
		ink.setTool("pen")
		keys.onKeyDown(key("KeyA", { ctrlKey: true }))
		expect(ink.getSnapshot().tool).toBe("none")
		mac.onKeyDown(key("KeyH", { ctrlKey: true }))
		mac.onKeyDown(key("KeyA", { metaKey: true }))
		expect(mac.onKeyDown(key("KeyH", { metaKey: true }))).toBe(false)
		expect(changes).toEqual(["hide", "toggle", "toggle", "automatic", "hide", "automatic"])

		// A typed slide number is unaffected.
		const controller = spyController()
		const numbered = createShowKeys({ controller: () => controller, apple: false, pointer })

		numbered.onKeyDown(key("Digit3"))
		numbered.onKeyDown(key("Enter"))
		expect(controller.calls).toEqual(["goto 2"])
	})

	it("follows rebound keys", () => {
		const controller = spyController()
		const keys = createShowKeys({
			controller: () => controller,
			bindings: { ...DEFAULT_SHOW_BINDINGS, next: "x", black: "mod+shift+b" },
			apple: false
		})

		keys.onKeyDown(key("ArrowRight"))
		keys.onKeyDown(key("KeyX"))
		keys.onKeyDown(key("KeyB"))
		keys.onKeyDown(key("KeyB", { ctrlKey: true, shiftKey: true }))
		expect(controller.calls).toEqual(["next", "black"])
	})
})

describe("show swipe", () => {
	const pointer = (pointerId: number, clientX: number, clientY: number, timeStamp: number, pointerType = "touch") => ({
		pointerId,
		pointerType,
		clientX,
		clientY,
		timeStamp
	})

	it("goes on with a leftward swipe and back with a rightward one, and swallows the click it ends in", () => {
		const calls: string[] = []
		const swipe = createShowSwipe({ next: () => calls.push("next"), prev: () => calls.push("prev") })
		const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() }

		swipe.onPointerDown(pointer(1, 300, 200, 0))
		swipe.onPointerUp(pointer(1, 200, 210, 150))
		expect(swipe.onClickCapture(click)).toBe(true)
		expect(click.stopPropagation).toHaveBeenCalled()
		swipe.onPointerDown(pointer(2, 100, 200, 1000))
		swipe.onPointerUp(pointer(2, 260, 190, 1200))
		expect(calls).toEqual(["next", "prev"])
	})

	it("leaves taps, vertical drags, slow drags, mice and drawing alone", () => {
		const calls: string[] = []
		let drawing = false
		const swipe = createShowSwipe({ next: () => calls.push("next"), prev: () => calls.push("prev"), enabled: () => !drawing })

		swipe.onPointerDown(pointer(1, 300, 200, 0))
		swipe.onPointerUp(pointer(1, 302, 201, 80))
		expect(swipe.onClickCapture({ preventDefault: vi.fn(), stopPropagation: vi.fn() })).toBe(false)
		swipe.onPointerDown(pointer(2, 300, 100, 0))
		swipe.onPointerUp(pointer(2, 240, 300, 100))
		swipe.onPointerDown(pointer(3, 300, 100, 0))
		swipe.onPointerUp(pointer(3, 100, 100, 2000))
		swipe.onPointerDown(pointer(4, 300, 100, 0, "mouse"))
		swipe.onPointerUp(pointer(4, 100, 100, 100, "mouse"))
		drawing = true
		swipe.onPointerDown(pointer(5, 300, 100, 0))
		swipe.onPointerUp(pointer(5, 100, 100, 100))
		expect(calls).toEqual([])
	})
})

describe("show timer", () => {
	it("counts presenting time, pauses, resumes and resets", () => {
		let timer = startShowTimer(1000)

		expect(timerElapsed(timer, 4000)).toBe(3000)
		timer = pauseTimer(timer, 4000)
		expect(timer.since).toBeUndefined()
		expect(timerElapsed(timer, 9000)).toBe(3000)
		timer = resumeTimer(timer, 9000)
		expect(timerElapsed(timer, 10_000)).toBe(4000)
		timer = resetTimer(timer, 10_000)
		expect(timerElapsed(timer, 10_500)).toBe(500)
		expect(formatElapsed(65_000)).toBe("1:05")
		expect(formatElapsed(3_725_000)).toBe("1:02:05")
	})
})

// Enter and Space on a control of the show's own press it, never the show's next slide.
describe("pressesControl", () => {
	const stage = { closest: () => null }
	const button = { closest: (selector: string) => (selector.includes("button") ? {} : null) }

	it("is Enter or Space on a control below the stage", () => {
		expect(
			pressesControl({ key: "Enter", target: button as unknown as EventTarget, currentTarget: stage as unknown as EventTarget })
		).toBe(true)
		expect(pressesControl({ key: " ", target: button as unknown as EventTarget, currentTarget: stage as unknown as EventTarget })).toBe(
			true
		)
	})

	it("is neither another key, nor a key on the stage itself", () => {
		expect(pressesControl({ key: "n", target: button as unknown as EventTarget, currentTarget: stage as unknown as EventTarget })).toBe(
			false
		)
		expect(
			pressesControl({ key: "Enter", target: stage as unknown as EventTarget, currentTarget: stage as unknown as EventTarget })
		).toBe(false)
	})
})
