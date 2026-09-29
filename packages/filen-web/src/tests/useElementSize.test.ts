// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useElementSize } from "@/lib/useElementSize"

let resize: (width: number, height: number) => void = () => undefined
const disconnect = vi.fn()

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: (entries: { contentRect: { width: number; height: number } }[]) => void) {
				resize = (width, height) => {
					callback([{ contentRect: { width, height } }])
				}
			}

			observe = vi.fn()
			disconnect = disconnect
		}
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
	disconnect.mockClear()
})

describe("useElementSize", () => {
	it("is 0x0 without an element", () => {
		const { result } = renderHook(() => useElementSize(null))

		expect(result.current).toEqual({ width: 0, height: 0 })
	})

	it("follows the observed content box and keeps its object when nothing changed", () => {
		const element = document.createElement("div")
		const { result, unmount } = renderHook(() => useElementSize(element))

		act(() => {
			resize(300, 200)
		})

		const first = result.current

		expect(first).toEqual({ width: 300, height: 200 })

		act(() => {
			resize(300, 200)
		})

		expect(result.current).toBe(first)

		unmount()

		expect(disconnect).toHaveBeenCalledOnce()
	})
})
