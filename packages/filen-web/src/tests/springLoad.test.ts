// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	LISTING_SPRING,
	SPRING_BLINK_ATTRIBUTE,
	SPRING_LOAD_BLINK_PHASE_MS,
	SPRING_LOAD_DELAY_MS,
	TREE_EXPAND_SPRING,
	armSpringLoad,
	cancelSpringLoad,
	springBlinkSchedule
} from "@/features/drive/lib/springLoad"

function reducedMotion(reduce: boolean): void {
	vi.stubGlobal(
		"matchMedia",
		vi.fn((query: string) => ({ matches: reduce && query === "(prefers-reduced-motion: reduce)" }))
	)
}

function blink(element: Element): string | null {
	return element.getAttribute(SPRING_BLINK_ATTRIBUTE)
}

beforeEach(() => {
	vi.useFakeTimers()
	reducedMotion(false)
})

afterEach(() => {
	vi.useRealTimers()
})

describe("springBlinkSchedule", () => {
	it("blinks the highlight off and on twice, ending exactly at the open", () => {
		const phase = SPRING_LOAD_BLINK_PHASE_MS
		const start = SPRING_LOAD_DELAY_MS - 4 * phase

		expect(springBlinkSchedule(LISTING_SPRING, false)).toEqual([
			{ atMs: start, state: "off" },
			{ atMs: start + phase, state: "on" },
			{ atMs: start + 2 * phase, state: "off" },
			{ atMs: start + 3 * phase, state: "on" }
		])
	})

	it("doesn't blink under reduced motion, nor for the tree's expand", () => {
		expect(springBlinkSchedule(LISTING_SPRING, true)).toEqual([])
		expect(springBlinkSchedule(TREE_EXPAND_SPRING, false)).toEqual([])
	})
})

describe("armSpringLoad", () => {
	it("blinks the armed element just before opening it, once", () => {
		const element = document.createElement("div")
		const open = vi.fn()
		const owner = {}
		const [first] = springBlinkSchedule(LISTING_SPRING, false)

		armSpringLoad(owner, element, LISTING_SPRING, open)

		vi.advanceTimersByTime((first?.atMs ?? 0) - 1)
		expect(blink(element)).toBeNull()
		vi.advanceTimersByTime(1)
		expect(blink(element)).toBe("off")
		vi.advanceTimersByTime(SPRING_LOAD_BLINK_PHASE_MS)
		expect(blink(element)).toBe("on")
		vi.advanceTimersByTime(SPRING_LOAD_BLINK_PHASE_MS)
		expect(blink(element)).toBe("off")
		vi.advanceTimersByTime(SPRING_LOAD_BLINK_PHASE_MS)
		expect(blink(element)).toBe("on")
		expect(open).not.toHaveBeenCalled()

		vi.advanceTimersByTime(SPRING_LOAD_BLINK_PHASE_MS)
		expect(open).toHaveBeenCalledOnce()
		expect(blink(element)).toBeNull()

		vi.advanceTimersByTime(10 * SPRING_LOAD_DELAY_MS)
		expect(open).toHaveBeenCalledOnce()
	})

	it("opens after the delay without blinking under reduced motion", () => {
		reducedMotion(true)
		const element = document.createElement("div")
		const open = vi.fn()

		armSpringLoad({}, element, LISTING_SPRING, open)

		for (let elapsed = 0; elapsed < SPRING_LOAD_DELAY_MS - 1; elapsed += 50) {
			vi.advanceTimersByTime(Math.min(50, SPRING_LOAD_DELAY_MS - 1 - elapsed))
			expect(blink(element)).toBeNull()
		}

		expect(open).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(open).toHaveBeenCalledOnce()
	})

	it("keeps the running timer when the armed target arms again", () => {
		const element = document.createElement("div")
		const owner = {}
		const open = vi.fn()

		armSpringLoad(owner, element, LISTING_SPRING, open)
		vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS - 10)
		armSpringLoad(owner, element, LISTING_SPRING, open)
		vi.advanceTimersByTime(10)

		expect(open).toHaveBeenCalledOnce()
	})

	it("runs one timer for the page: arming another target disarms the first, blink included", () => {
		const first = document.createElement("div")
		const second = document.createElement("div")
		const openFirst = vi.fn()
		const openSecond = vi.fn()

		armSpringLoad({}, first, LISTING_SPRING, openFirst)
		vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS - 50)
		expect(blink(first)).not.toBeNull()

		armSpringLoad({}, second, LISTING_SPRING, openSecond)
		expect(blink(first)).toBeNull()

		vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS)
		expect(openFirst).not.toHaveBeenCalled()
		expect(openSecond).toHaveBeenCalledOnce()
	})

	it("cancels only for the target that armed it", () => {
		const armedOwner = {}
		const open = vi.fn()

		armSpringLoad(armedOwner, document.createElement("div"), LISTING_SPRING, open)
		cancelSpringLoad({})
		vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS)
		expect(open).toHaveBeenCalledOnce()

		armSpringLoad(armedOwner, document.createElement("div"), LISTING_SPRING, open)
		cancelSpringLoad(armedOwner)
		vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS)
		expect(open).toHaveBeenCalledOnce()
	})

	it.each([
		["a drop anywhere", () => new Event("drop")],
		["the drag ending", () => new Event("dragend")],
		["Escape", () => new KeyboardEvent("keydown", { key: "Escape" })]
	])("disarms on %s", (_label, event) => {
		const element = document.createElement("div")
		const open = vi.fn()

		armSpringLoad({}, element, LISTING_SPRING, open)
		vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS - 50)
		window.dispatchEvent(event())
		vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS)

		expect(open).not.toHaveBeenCalled()
		expect(blink(element)).toBeNull()
	})

	it("ignores other keys", () => {
		const open = vi.fn()

		armSpringLoad({}, document.createElement("div"), LISTING_SPRING, open)
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }))
		vi.advanceTimersByTime(SPRING_LOAD_DELAY_MS)

		expect(open).toHaveBeenCalledOnce()
	})
})
