// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"

// The text viewers' wrap, line numbers and font size: one value on this device, read during boot so a viewer's first
// render already shows it, a font size stored before the steps changed moved to the nearest step.

const { stored } = vi.hoisted(() => ({ stored: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(stored.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		stored.set(key, value)

		return Promise.resolve()
	},
	kvDelete: () => Promise.resolve()
}))

// A fresh module per test: the value it holds is the one this test's boot read.
async function settingsModule() {
	vi.resetModules()

	return import("@/features/preview/lib/codeViewSettings")
}

beforeEach(() => {
	stored.clear()
	stored.set("preview.codeView.v1", { wrap: false, lineNumbers: true, fontSize: 15 })
})

describe("code view settings", () => {
	it("starts from the defaults before boot read anything", async () => {
		const { CODE_DEFAULT_FONT_SIZE, useCodeViewSettings } = await settingsModule()
		const { result } = renderHook(() => useCodeViewSettings())

		expect(result.current).toEqual({ wrap: true, lineNumbers: true, fontSize: CODE_DEFAULT_FONT_SIZE })
	})

	it("shows the stored value, normalised, from the first render once boot read it, with no update after", async () => {
		const { loadCodeViewSettings, useCodeViewSettings } = await settingsModule()

		await loadCodeViewSettings()

		let renders = 0
		const { result } = renderHook(() => {
			renders++

			return useCodeViewSettings()
		})

		expect(result.current).toEqual({ wrap: false, lineNumbers: true, fontSize: 14 })
		await act(() => new Promise(resolve => setTimeout(resolve, 0)))
		expect(renders).toBe(1)
	})

	it("stores a change and leaves an unchanged one alone", async () => {
		const { loadCodeViewSettings, setCodeViewSettings, useCodeViewSettings } = await settingsModule()

		await loadCodeViewSettings()

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
