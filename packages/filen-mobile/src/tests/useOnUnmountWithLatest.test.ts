// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import useOnUnmountWithLatest from "@/hooks/useOnUnmountWithLatest"

describe("useOnUnmountWithLatest", () => {
	it("does not call onUnmount on rerender, even when the value identity changes", () => {
		const onUnmount = vi.fn()

		const { rerender } = renderHook(({ value }) => useOnUnmountWithLatest(value, onUnmount), {
			initialProps: {
				value: { id: "a" }
			}
		})

		rerender({
			value: { id: "a" }
		})
		rerender({
			value: { id: "b" }
		})

		expect(onUnmount).not.toHaveBeenCalled()
	})

	it("calls the latest onUnmount once on unmount with the latest value", () => {
		const first = vi.fn()
		const latest = vi.fn()

		const { rerender, unmount } = renderHook(({ value, cb }) => useOnUnmountWithLatest(value, cb), {
			initialProps: {
				value: { id: "a" },
				cb: first
			}
		})

		rerender({
			value: { id: "b" },
			cb: latest
		})

		unmount()

		expect(first).not.toHaveBeenCalled()
		expect(latest).toHaveBeenCalledOnce()
		expect(latest).toHaveBeenCalledWith({ id: "b" })
	})
})
