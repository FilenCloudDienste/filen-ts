// @vitest-environment jsdom

// The login two-factor dialog keeps its code field focused across a rejected retry.
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { TwoFactorDialog } from "@/features/auth/components/twoFactorDialog"

afterEach(() => {
	cleanup()
})

describe("TwoFactorDialog", () => {
	it("keeps the code field focused and editable after a wrong code", () => {
		const onSubmit = vi.fn()
		const props = { open: true, onOpenChange: vi.fn(), onSubmit }
		const { rerender } = render(
			<TwoFactorDialog
				{...props}
				pending={false}
			/>
		)
		const input = screen.getByRole<HTMLInputElement>("textbox")

		input.focus()
		fireEvent.change(input, { target: { value: "123456" } })
		fireEvent.submit(input)

		expect(onSubmit).toHaveBeenCalledExactlyOnceWith("123456")

		rerender(
			<TwoFactorDialog
				{...props}
				pending
			/>
		)

		expect(input.disabled).toBe(false)
		expect(input.readOnly).toBe(true)
		expect(input.getAttribute("aria-busy")).toBe("true")
		expect(document.activeElement).toBe(input)

		rerender(
			<TwoFactorDialog
				{...props}
				pending={false}
				error="Wrong code"
			/>
		)

		expect(document.activeElement).toBe(input)
		expect(input.readOnly).toBe(false)
		expect(input.value).toBe("")

		fireEvent.change(input, { target: { value: "654321" } })

		expect(input.value).toBe("654321")
	})
})
