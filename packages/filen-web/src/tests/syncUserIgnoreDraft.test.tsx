// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { registerAllActions } from "@/lib/keymap/actions"

// The unsaved ignore rules outlive a tab or pair switch, and a save keeps the editor (its focus and node) mounted.

const { api } = vi.hoisted(() => ({
	api: {
		userIgnore: vi.fn(),
		setUserIgnore: vi.fn(),
		ignoredPaths: vi.fn()
	}
}))

vi.mock("@/features/sync/lib/syncStore", () => ({
	syncApi: () => api
}))

vi.mock("sonner", () => ({
	toast: { success: vi.fn() }
}))

const { IgnoredTab } = await import("@/features/sync/components/ignoredTab")

registerAllActions()

function rulesBox(): HTMLTextAreaElement {
	return screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Ignore rules" })
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("user ignore draft", () => {
	it("restores the draft when the tab mounts again", async () => {
		api.userIgnore.mockResolvedValue({ ok: true, value: { text: "*.tmp", defaults: [] } })
		api.ignoredPaths.mockResolvedValue({ ok: true, value: { total: 0, entries: [] } })

		const first = render(<IgnoredTab pairId="pair-1" />)

		fireEvent.change(await screen.findByDisplayValue("*.tmp"), { target: { value: "*.tmp\nnode_modules" } })
		first.unmount()

		// Another pair: the rules are device-wide, so the draft is not keyed per pair.
		render(<IgnoredTab pairId="pair-2" />)

		await screen.findByRole("textbox", { name: "Ignore rules" })

		expect(rulesBox().value).toBe("*.tmp\nnode_modules")
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save rules" }).disabled).toBe(false)

		// Typed back to the rules as read: nothing is left to restore.
		fireEvent.change(rulesBox(), { target: { value: "*.tmp" } })
	})

	it("keeps the text box and its focus through a save, then drops the draft", async () => {
		api.userIgnore.mockResolvedValue({ ok: true, value: { text: "*.tmp", defaults: [] } })
		api.ignoredPaths.mockResolvedValue({ ok: true, value: { total: 0, entries: [] } })
		api.setUserIgnore.mockResolvedValue({ ok: true, value: null })

		const view = render(<IgnoredTab pairId="pair-1" />)
		const box = await screen.findByDisplayValue<HTMLTextAreaElement>("*.tmp")

		fireEvent.change(box, { target: { value: "*.log" } })
		box.focus()

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Save rules" }))
			await Promise.resolve()
		})

		expect(api.setUserIgnore).toHaveBeenCalledWith("*.log")
		expect(rulesBox()).toBe(box)
		expect(document.activeElement).toBe(box)
		expect(box.value).toBe("*.log")
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save rules" }).disabled).toBe(true)
		// Read once on mount only, not again after the save.
		expect(api.userIgnore).toHaveBeenCalledTimes(1)

		view.unmount()
		// The rules as the shell holds them next, not the saved draft.
		api.userIgnore.mockResolvedValue({ ok: true, value: { text: "*.cache", defaults: [] } })
		render(<IgnoredTab pairId="pair-1" />)

		expect(await screen.findByDisplayValue("*.cache")).toBeTruthy()
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save rules" }).disabled).toBe(true)
	})
})
