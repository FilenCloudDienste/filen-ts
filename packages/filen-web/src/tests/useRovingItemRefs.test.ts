// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useRovingItemRefs } from "@/features/drive/hooks/useRovingItemRefs"

let frames: FrameRequestCallback[] = []

function flushFrame(): void {
	const pending = frames

	frames = []

	for (const callback of pending) {
		callback(0)
	}
}

function tile(): HTMLDivElement {
	const el = document.createElement("div")

	el.tabIndex = 0
	document.body.appendChild(el)

	return el
}

beforeEach(() => {
	frames = []
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.push(callback)

		return frames.length
	})
})

afterEach(() => {
	vi.unstubAllGlobals()
	document.body.replaceChildren()
})

describe("useRovingItemRefs", () => {
	it("focuses an already-mounted item on the next frame", () => {
		const { result } = renderHook(() => useRovingItemRefs())
		const el = tile()

		result.current.registerRef(3, el)
		result.current.focusItem(3)

		expect(document.activeElement).not.toBe(el)

		flushFrame()

		expect(document.activeElement).toBe(el)
		expect(frames).toHaveLength(0)
	})

	it("polls until the item mounts", () => {
		const { result } = renderHook(() => useRovingItemRefs())
		const el = tile()

		result.current.focusItem(5)
		flushFrame()
		flushFrame()
		result.current.registerRef(5, el)
		flushFrame()

		expect(document.activeElement).toBe(el)
	})

	it("gives up after a bounded number of frames", () => {
		const { result } = renderHook(() => useRovingItemRefs())

		result.current.focusItem(1)

		let flushed = 0

		while (frames.length > 0) {
			flushFrame()
			flushed++
		}

		expect(flushed).toBe(11)
	})

	it("lets a newer request invalidate an older, still-polling one", () => {
		const { result } = renderHook(() => useRovingItemRefs())
		const older = tile()
		const newer = tile()

		result.current.focusItem(1)
		result.current.focusItem(2)
		result.current.registerRef(1, older)
		result.current.registerRef(2, newer)
		flushFrame()

		expect(document.activeElement).toBe(newer)
		expect(frames).toHaveLength(0)
	})
})
