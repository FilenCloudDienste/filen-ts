// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import useEffectOnce from "@/hooks/useEffectOnce"

describe("useEffectOnce", () => {
	it("runs the effect once on mount", () => {
		const effect = vi.fn()

		renderHook(() => useEffectOnce(effect))

		expect(effect).toHaveBeenCalledOnce()
	})

	it("does not re-run the effect on rerender", () => {
		const effect = vi.fn()

		const { rerender } = renderHook(() => useEffectOnce(effect))

		rerender()
		rerender()
		rerender()

		expect(effect).toHaveBeenCalledOnce()
	})

	it("calls the cleanup function on unmount", () => {
		const cleanup = vi.fn()
		const effect = vi.fn(() => cleanup)

		const { unmount } = renderHook(() => useEffectOnce(effect))

		expect(cleanup).not.toHaveBeenCalled()

		unmount()

		expect(cleanup).toHaveBeenCalledOnce()
	})

	it("does not call cleanup between rerenders", () => {
		const cleanup = vi.fn()
		const effect = vi.fn(() => cleanup)

		const { rerender } = renderHook(() => useEffectOnce(effect))

		rerender()
		rerender()

		expect(cleanup).not.toHaveBeenCalled()
	})
})
