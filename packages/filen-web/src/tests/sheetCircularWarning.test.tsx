// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { SheetGridHandle } from "@filen/office/react/sheet"
import "@/lib/i18n"
import { preview } from "@/locales/en/preview"
import { CircularWarning } from "@/features/spreadsheet/components/circularWarning"

// Excel's circular reference warning: its message, and OK closing it with focus back in the grid.

afterEach(() => {
	cleanup()
})

describe("the circular reference warning", () => {
	it("shows Excel's message and closes on OK, focus back in the grid", async () => {
		const onClose = vi.fn()
		const focus = vi.fn()
		const gridRef = { current: { focus } as unknown as SheetGridHandle }
		const { rerender } = render(
			<CircularWarning
				open
				onClose={onClose}
				gridRef={gridRef}
			/>
		)

		expect(screen.getByRole("alertdialog").textContent).toContain(
			"There are one or more circular references where a formula refers to its own cell either directly or indirectly."
		)
		expect(screen.getByText(preview.previewSheetCircularTitle)).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: preview.previewSheetCircularOk }))
		expect(onClose).toHaveBeenCalledTimes(1)

		rerender(
			<CircularWarning
				open={false}
				onClose={onClose}
				gridRef={gridRef}
			/>
		)
		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull()
		})
		expect(focus).toHaveBeenCalled()
	})
})
