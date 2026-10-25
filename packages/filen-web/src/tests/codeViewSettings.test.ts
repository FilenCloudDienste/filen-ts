// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

// The text viewers' wrap, line numbers and font size: one value on this device, read once a viewer mounts, a font size
// stored before the steps changed moved to the nearest step.

const { stored } = vi.hoisted(() => ({
	stored: new Map<string, unknown>([["preview.codeView.v1", { wrap: false, lineNumbers: true, fontSize: 15 }]])
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(stored.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		stored.set(key, value)

		return Promise.resolve()
	},
	kvDelete: () => Promise.resolve()
}))

const { CODE_DEFAULT_FONT_SIZE, setCodeViewSettings, useCodeViewSettings } = await import("@/features/preview/lib/codeViewSettings")

describe("code view settings", () => {
	it("starts from the defaults, then reads the stored value once, normalised", async () => {
		const { result } = renderHook(() => useCodeViewSettings())

		expect(result.current).toEqual({ wrap: true, lineNumbers: true, fontSize: CODE_DEFAULT_FONT_SIZE })
		await waitFor(() => {
			expect(result.current).toEqual({ wrap: false, lineNumbers: true, fontSize: 14 })
		})
	})

	it("stores a change and leaves an unchanged one alone", async () => {
		const { result } = renderHook(() => useCodeViewSettings())

		act(() => {
			setCodeViewSettings({ lineNumbers: false, fontSize: 20 })
		})
		expect(result.current).toEqual({ wrap: false, lineNumbers: false, fontSize: 20 })
		await waitFor(() => {
			expect(stored.get("preview.codeView.v1")).toEqual({ wrap: false, lineNumbers: false, fontSize: 20 })
		})

		const before = result.current

		act(() => {
			setCodeViewSettings({ fontSize: 20 })
		})
		expect(result.current).toBe(before)
	})
})
