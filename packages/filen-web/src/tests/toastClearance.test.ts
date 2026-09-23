// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { toastObstructionRef, useToastClearance } from "@/lib/toastClearance"

// jsdom has no layout: rects are stubbed per element, and ResizeObserver/rAF are driven by hand so each
// test decides exactly when the store re-measures. jsdom's default viewport is 1024x768, which puts the
// toast column at [1024 - 24 - 356, 1024 - 24] = [644, 1000].
const observers: FakeResizeObserver[] = []
let frames: FrameRequestCallback[] = []

class FakeResizeObserver {
	readonly targets = new Set<Element>()
	readonly callback: ResizeObserverCallback

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback
		observers.push(this)
	}

	observe(target: Element): void {
		this.targets.add(target)
	}

	unobserve(target: Element): void {
		this.targets.delete(target)
	}

	disconnect(): void {
		this.targets.clear()
	}
}

function flushFrames(): void {
	const pending = frames

	frames = []

	for (const callback of pending) {
		callback(0)
	}
}

// Fires every observer still watching `target`, as the browser would after it resized.
function fireResize(target: Element): void {
	for (const observer of observers) {
		if (observer.targets.has(target)) {
			observer.callback([], observer)
		}
	}
}

interface Box {
	top: number
	left: number
	width: number
	height: number
}

// A registered surface inside its own wrapper (the wrapper is observed too), with a mutable box so a
// test can "resize" it.
function mountSurface(initial: Box): { element: HTMLElement; wrapper: HTMLElement; box: Box; unregister: () => void } {
	const wrapper = document.createElement("div")
	const element = document.createElement("div")
	const box = { ...initial }

	wrapper.append(element)
	document.body.append(wrapper)
	vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => ({
		top: box.top,
		left: box.left,
		right: box.left + box.width,
		bottom: box.top + box.height,
		width: box.width,
		height: box.height,
		x: box.left,
		y: box.top,
		toJSON: () => box
	}))

	let cleanup: (() => void) | undefined

	act(() => {
		cleanup = toastObstructionRef(element)
		flushFrames()
	})

	return {
		element,
		wrapper,
		box,
		unregister: () => {
			act(() => {
				cleanup?.()
				flushFrames()
			})
			wrapper.remove()
		}
	}
}

const unregisters: (() => void)[] = []

function surface(initial: Box): { element: HTMLElement; wrapper: HTMLElement; box: Box } {
	const mounted = mountSurface(initial)

	unregisters.push(mounted.unregister)

	return mounted
}

const selectionBar: Box = {
	top: 768 - 24 - 46,
	left: 450,
	width: 420,
	height: 46
}
const audioPlayer: Box = {
	top: 768 - 72,
	left: 0,
	width: 1024,
	height: 72
}

beforeEach(() => {
	observers.length = 0
	frames = []
	vi.stubGlobal("ResizeObserver", FakeResizeObserver)
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.push(callback)

		return frames.length
	})
})

afterEach(() => {
	// Module-level store: every surface must leave, or the next test starts lifted.
	for (const unregister of unregisters.splice(0)) {
		unregister()
	}
})

describe("toastClearance store", () => {
	it("reads 0 with nothing registered", () => {
		const { result } = renderHook(() => useToastClearance())

		expect(result.current).toBe(0)
	})

	it("lifts by the selection bar's clearance while it is mounted, and drops back when it leaves", () => {
		const { result } = renderHook(() => useToastClearance())
		const bar = mountSurface(selectionBar)

		expect(result.current).toBe(24 + 46)

		bar.unregister()

		expect(result.current).toBe(0)
	})

	it("lifts by the audio player's height", () => {
		const { result } = renderHook(() => useToastClearance())

		surface(audioPlayer)

		expect(result.current).toBe(72)
	})

	it("clears the higher surface when the bar floats above the player, and re-measures the bar when the player leaves", () => {
		const { result } = renderHook(() => useToastClearance())
		const bar = surface({
			...selectionBar,
			top: 768 - 72 - 24 - 46
		})
		const player = mountSurface(audioPlayer)

		expect(result.current).toBe(72 + 24 + 46)

		// The shell reflows: the bar drops back to the viewport floor without resizing itself.
		bar.box.top = selectionBar.top
		player.unregister()

		expect(result.current).toBe(24 + 46)
	})

	it("follows a resize of a registered surface", () => {
		const { result } = renderHook(() => useToastClearance())
		const player = surface(audioPlayer)

		act(() => {
			player.box.top = 768 - 96
			player.box.height = 96
			fireResize(player.element)
		})

		expect(result.current).toBe(96)
	})

	it("follows the bar moving out of the toast column when its wrapper resizes", () => {
		const { result } = renderHook(() => useToastClearance())
		const bar = surface(selectionBar)

		expect(result.current).toBe(70)

		act(() => {
			bar.box.left = 100
			fireResize(bar.wrapper)
		})

		expect(result.current).toBe(0)
	})

	it("re-measures on a viewport resize, which moves a docked surface without resizing it", () => {
		const { result } = renderHook(() => useToastClearance())
		const player = surface(audioPlayer)
		const original = window.innerHeight

		act(() => {
			Object.defineProperty(window, "innerHeight", {
				configurable: true,
				value: 900
			})
			player.box.top = 900 - 72
			window.dispatchEvent(new Event("resize"))
			flushFrames()
		})

		expect(result.current).toBe(72)

		act(() => {
			// Only the viewport grew: the player's old top edge now reads as a taller clearance.
			Object.defineProperty(window, "innerHeight", {
				configurable: true,
				value: 1000
			})
			window.dispatchEvent(new Event("resize"))
			flushFrames()
		})

		expect(result.current).toBe(1000 - (900 - 72))

		Object.defineProperty(window, "innerHeight", {
			configurable: true,
			value: original
		})
	})
})
