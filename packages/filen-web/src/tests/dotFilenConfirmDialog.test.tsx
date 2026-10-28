// @vitest-environment jsdom

// The typed confirm for the root `.filen`: worded for its operation, armed only once `.filen` is typed, Cancel focused.
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@/lib/i18n"
import { DotFilenConfirmDialog } from "@/features/drive/components/dotFilenConfirmDialog"

afterEach(() => {
	cleanup()
})

describe("DotFilenConfirmDialog", () => {
	it("arms its button only once .filen is typed exactly, with Cancel focused", async () => {
		const onConfirm = vi.fn()

		render(
			<DotFilenConfirmDialog
				open
				pending={false}
				operation="trash"
				multiple={false}
				onOpenChange={vi.fn()}
				onConfirm={onConfirm}
			/>
		)

		const confirm = screen.getByRole<HTMLButtonElement>("button", { name: "Trash anyway" })

		expect(screen.getByText("Trash the .filen directory?")).toBeTruthy()
		await waitFor(() => {
			expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }))
		})
		expect(confirm.disabled).toBe(true)

		fireEvent.change(screen.getByRole("textbox"), { target: { value: ".Filen" } })
		expect(confirm.disabled).toBe(true)

		fireEvent.change(screen.getByRole("textbox"), { target: { value: ".filen" } })
		expect(confirm.disabled).toBe(false)

		fireEvent.click(confirm)
		expect(onConfirm).toHaveBeenCalledOnce()
	})

	it("names the operation and says a selection includes it", () => {
		render(
			<DotFilenConfirmDialog
				open
				pending={false}
				operation="move"
				multiple
				onOpenChange={vi.fn()}
				onConfirm={vi.fn()}
			/>
		)

		expect(screen.getByText("Move the .filen directory?")).toBeTruthy()
		expect(screen.getByText(/Your selection includes \.filen.*Proceeding includes it\./)).toBeTruthy()
		expect(screen.getByRole("button", { name: "Move anyway" })).toBeTruthy()
	})
})
