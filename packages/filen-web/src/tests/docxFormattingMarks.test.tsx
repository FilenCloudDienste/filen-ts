// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react"
import { registerAllActions } from "@/lib/keymap/actions"
import { renderRibbon } from "@/tests/docxRibbonHarness"

// Word's Show/Hide ¶: one choice kept on this device for every document (read once an editor mounts, a change made
// before it arrives winning), and its toggle button at the end of Home's Paragraph group.

const { stored } = vi.hoisted(() => ({ stored: new Map<string, unknown>([["preview.docxFormattingMarks.v1", true]]) }))

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 2000, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(stored.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		stored.set(key, value)

		return Promise.resolve()
	},
	kvDelete: () => Promise.resolve()
}))

const { setDocxFormattingMarks, useDocxFormattingMarks } = await import("@/features/preview/lib/docxFormattingMarks")

registerAllActions()

afterEach(() => {
	cleanup()
})

describe("formatting marks setting", () => {
	it("starts hidden, reads the stored choice once, and stores a change", async () => {
		const { result } = renderHook(() => useDocxFormattingMarks())

		expect(result.current).toBe(false)
		await waitFor(() => {
			expect(result.current).toBe(true)
		})

		act(() => {
			setDocxFormattingMarks(false)
		})
		expect(result.current).toBe(false)
		await waitFor(() => {
			expect(stored.get("preview.docxFormattingMarks.v1")).toBe(false)
		})
	})
})

describe("Show/Hide ¶ on the ribbon", () => {
	it("ends Home's Paragraph group, shows whether the marks are shown, and toggles them", () => {
		const { execute } = renderRibbon({ formattingMarks: true })
		const paragraph = within(screen.getByRole("toolbar", { name: "Commands" })).getByRole("group", { name: "Paragraph" })
		const buttons = within(paragraph).getAllByRole("button")
		const toggle = within(paragraph).getByRole("button", { name: "Show/Hide ¶" })

		expect(buttons[buttons.length - 1]).toBe(toggle)
		expect(toggle.getAttribute("aria-pressed")).toBe("true")
		fireEvent.click(toggle)
		expect(execute).toHaveBeenCalledWith({ type: "view.formattingMarks" })
		cleanup()

		renderRibbon({ formattingMarks: false })
		expect(screen.getByRole("button", { name: "Show/Hide ¶" }).getAttribute("aria-pressed")).toBe("false")
	})
})
