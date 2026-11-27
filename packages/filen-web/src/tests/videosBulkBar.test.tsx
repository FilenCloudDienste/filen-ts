// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"

const { online } = vi.hoisted(() => ({ online: { value: true } }))

vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => online.value }))
vi.mock("@/lib/keymap/kbd", () => ({ Kbd: () => null }))

import { VideosBulkBar } from "@/features/videos/components/videosBulkBar"
import { TooltipProvider } from "@/components/ui/tooltip"

function renderBar(busy = false) {
	const handlers = { onSetAs: vi.fn(), onHide: vi.fn(), onClear: vi.fn() }

	render(
		<TooltipProvider>
			<VideosBulkBar
				count={3}
				busy={busy}
				{...handlers}
			/>
		</TooltipProvider>
	)

	return handlers
}

beforeEach(() => {
	online.value = true
})

afterEach(() => {
	cleanup()
})

describe("Videos selection bar", () => {
	it("shows the count and runs Hide and Clear", () => {
		const handlers = renderBar()

		expect(screen.getByText("3 selected")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Hide from Videos" }))
		fireEvent.click(screen.getByRole("button", { name: "Clear selection" }))

		expect(handlers.onHide).toHaveBeenCalledTimes(1)
		expect(handlers.onClear).toHaveBeenCalledTimes(1)
	})

	it("offers Movie, Show… and Other video under Set as", async () => {
		const handlers = renderBar()

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Set as" }))
			await Promise.resolve()
		})

		expect(screen.getByRole("menuitem", { name: "Movie" })).toBeTruthy()
		expect(screen.getByRole("menuitem", { name: "Other video" })).toBeTruthy()

		fireEvent.click(screen.getByRole("menuitem", { name: "Show…" }))

		expect(handlers.onSetAs).toHaveBeenCalledWith("episode")
	})

	it("disables its actions offline and while a change runs", () => {
		online.value = false

		const handlers = renderBar()

		fireEvent.click(screen.getByRole("button", { name: "Hide from Videos" }))

		expect(handlers.onHide).not.toHaveBeenCalled()

		cleanup()
		online.value = true
		renderBar(true)

		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Hide from Videos" }).disabled).toBe(true)
	})
})
