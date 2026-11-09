// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { autoHidePointer, POINTER_IDLE_MS } from "../react/presentation/show/pointer"

function move(stage: HTMLElement, pointerType: string, type = "pointermove"): void {
	stage.dispatchEvent(new PointerEvent(type, { pointerType, bubbles: true }))
}

describe("show pointer auto-hide", () => {
	let stage: HTMLElement

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
		stage = document.createElement("div")
		document.body.append(stage)
	})

	afterEach(() => {
		stage.remove()
		vi.useRealTimers()
	})

	it("hides after the mouse is still and shows again on a move", () => {
		const stop = autoHidePointer(stage)

		vi.advanceTimersByTime(POINTER_IDLE_MS - 1)
		expect(stage.hasAttribute("data-fo-pointer")).toBe(false)

		vi.advanceTimersByTime(1)
		expect(stage.getAttribute("data-fo-pointer")).toBe("hidden")

		move(stage, "mouse")
		expect(stage.hasAttribute("data-fo-pointer")).toBe(false)

		// Moves keep it shown; the idle period counts from the last one.
		vi.advanceTimersByTime(2000)
		move(stage, "mouse")
		vi.advanceTimersByTime(POINTER_IDLE_MS - 1)
		expect(stage.hasAttribute("data-fo-pointer")).toBe(false)
		vi.advanceTimersByTime(1)
		expect(stage.getAttribute("data-fo-pointer")).toBe("hidden")

		move(stage, "mouse", "pointerdown")
		expect(stage.hasAttribute("data-fo-pointer")).toBe(false)

		stop()
	})

	it("ignores touch and pen", () => {
		const stop = autoHidePointer(stage)

		vi.advanceTimersByTime(POINTER_IDLE_MS)
		move(stage, "touch")
		move(stage, "pen", "pointerdown")
		expect(stage.getAttribute("data-fo-pointer")).toBe("hidden")

		stop()
	})

	it("runs one timer however many moves come, and stops cleanly", () => {
		const stop = autoHidePointer(stage)
		const set = vi.spyOn(globalThis, "setTimeout")

		for (let i = 0; i < 1000; i++) move(stage, "mouse")

		expect(set).not.toHaveBeenCalled()

		vi.advanceTimersByTime(POINTER_IDLE_MS)
		stop()
		expect(stage.hasAttribute("data-fo-pointer")).toBe(false)
		expect(vi.getTimerCount()).toBe(0)

		vi.advanceTimersByTime(POINTER_IDLE_MS * 2)
		move(stage, "mouse")
		expect(stage.hasAttribute("data-fo-pointer")).toBe(false)
		expect(vi.getTimerCount()).toBe(0)
	})
})
