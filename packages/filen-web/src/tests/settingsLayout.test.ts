// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import { SettingsRow } from "@/features/settings/components/settingsLayout"
import { FormDialog } from "@/components/dialogs/formDialog"

afterEach(() => {
	cleanup()
})

describe("SettingsRow", () => {
	it("names the control it points at, so a row's input or select needs no second label", () => {
		render(
			createElement(
				SettingsRow,
				{ label: "Nickname", description: "Shown to contacts", htmlFor: "row-input" },
				createElement("input", { id: "row-input" })
			)
		)

		expect(screen.getByLabelText("Nickname").id).toBe("row-input")
	})

	it("renders a plain label when there is no control to point at", () => {
		render(createElement(SettingsRow, { label: "Storage" }))

		expect(screen.getByText("Storage").tagName).toBe("P")
		expect(screen.queryByLabelText("Storage")).toBeNull()
	})
})

function renderDialog(props: { pending: boolean; canSubmit: boolean; onOpenChange: (open: boolean) => void }) {
	render(
		createElement(FormDialog, {
			open: true,
			title: "Change email",
			description: "The address you sign in with",
			submitLabel: "Save",
			cancelLabel: "Cancel",
			onSubmit: e => {
				e.preventDefault()
			},
			children: createElement("input", { "aria-label": "Field" }),
			...props
		})
	)

	return screen.getByRole("dialog")
}

describe("FormDialog", () => {
	it("holds submit disabled until the caller's gate opens", () => {
		const dialog = renderDialog({ pending: false, canSubmit: false, onOpenChange: vi.fn() })

		expect(within(dialog).getByRole("button", { name: "Save" })).toHaveProperty("disabled", true)
	})

	it("closes through Cancel when idle", () => {
		const onOpenChange = vi.fn()
		const dialog = renderDialog({ pending: false, canSubmit: true, onOpenChange })

		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))

		expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
	})

	// The positive control for the pending case below: Escape does reach the dialog here.
	it("closes on Escape when idle", () => {
		const onOpenChange = vi.fn()
		const dialog = renderDialog({ pending: false, canSubmit: true, onOpenChange })

		fireEvent.keyDown(within(dialog).getByLabelText("Field"), { key: "Escape" })

		expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
	})

	it("cannot be dismissed while its operation runs", () => {
		const onOpenChange = vi.fn()
		const dialog = renderDialog({ pending: true, canSubmit: true, onOpenChange })

		expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true)
		// The submit's name gains the spinner's label while pending, hence the pattern.
		expect(within(dialog).getByRole("button", { name: /Save/ })).toHaveProperty("disabled", true)

		fireEvent.keyDown(within(dialog).getByLabelText("Field"), { key: "Escape" })

		expect(onOpenChange).not.toHaveBeenCalled()
		expect(screen.getByRole("dialog")).toBeTruthy()
	})
})
