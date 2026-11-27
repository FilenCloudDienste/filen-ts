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
		// Enter after the auto-submit finds the cleared field and must not submit again.
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

		fireEvent.change(input, { target: { value: "65432" } })

		expect(input.value).toBe("65432")
	})

	it("switches back from recovery-key mode to the authenticator code", () => {
		render(
			<TwoFactorDialog
				open
				pending={false}
				onOpenChange={vi.fn()}
				onSubmit={vi.fn()}
			/>
		)

		fireEvent.click(screen.getByRole("button", { name: "Use your recovery key instead" }))

		expect(screen.getByLabelText("Recovery key")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Use authenticator code" }))

		expect(screen.getByLabelText("Authenticator code")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Use authenticator code" })).toBeNull()
	})

	it("auto-submits once, only when six digits are entered in code mode", () => {
		const onSubmit = vi.fn()
		render(
			<TwoFactorDialog
				open
				pending={false}
				onOpenChange={vi.fn()}
				onSubmit={onSubmit}
			/>
		)
		const input = screen.getByRole<HTMLInputElement>("textbox")

		fireEvent.change(input, { target: { value: "12345" } })

		expect(onSubmit).not.toHaveBeenCalled()

		fireEvent.change(input, { target: { value: "123456" } })

		expect(onSubmit).toHaveBeenCalledExactlyOnceWith("123456")
		expect(input.value).toBe("")
	})

	it("does not auto-submit a six-digit value in recovery mode or while pending", () => {
		const onSubmit = vi.fn()
		const props = { open: true, onOpenChange: vi.fn(), onSubmit }
		const { rerender } = render(
			<TwoFactorDialog
				{...props}
				pending={false}
			/>
		)

		fireEvent.click(screen.getByRole("button", { name: "Use your recovery key instead" }))
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "123456" } })

		expect(onSubmit).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "Use authenticator code" }))
		rerender(
			<TwoFactorDialog
				{...props}
				pending
			/>
		)
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "654321" } })

		expect(onSubmit).not.toHaveBeenCalled()
	})
})
