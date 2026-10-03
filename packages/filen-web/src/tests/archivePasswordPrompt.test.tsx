// @vitest-environment jsdom

// The archive browser's password prompt takes what the SDK takes: 1 to 1024 characters.
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { ArchivePasswordPrompt } from "@/features/archive/components/archivePasswordPrompt"

afterEach(() => {
	cleanup()
})

function submitButton(): HTMLButtonElement {
	return screen.getByRole("button", { name: "Unlock" })
}

describe("ArchivePasswordPrompt", () => {
	it("submits a password up to 1024 characters, and says why it won't take a longer one", () => {
		const onSubmit = vi.fn()

		render(
			<ArchivePasswordPrompt
				open
				name="photos.zip"
				wrong={false}
				onOpenChange={vi.fn()}
				onSubmit={onSubmit}
			/>
		)

		expect(submitButton().disabled).toBe(true)

		fireEvent.change(screen.getByRole("textbox"), { target: { value: "a".repeat(1025) } })

		expect(screen.getByText("A password can have at most 1024 characters")).toBeTruthy()
		expect(submitButton().disabled).toBe(true)

		fireEvent.change(screen.getByRole("textbox"), { target: { value: "😀".repeat(1024) } })

		expect(screen.queryByText("A password can have at most 1024 characters")).toBeNull()

		fireEvent.click(submitButton())

		expect(onSubmit).toHaveBeenCalledExactlyOnceWith("😀".repeat(1024))
	})
})
