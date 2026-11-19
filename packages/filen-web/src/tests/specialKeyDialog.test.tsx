// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"

// The special keys picker serves screen reader users: on a Mac, where keys show as glyphs, the modifier toggles and
// the key list still name their keys in words.

vi.mock("@/lib/keymap/kbd.logic", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/keymap/kbd.logic")>()),
	isMacPlatform: () => true
}))

const { SpecialKeyDialog } = await import("@/lib/keymap/specialKeyDialog")

afterEach(() => {
	cleanup()
})

function renderDialog() {
	render(
		<SpecialKeyDialog
			actionName="Undo"
			open
			onOpenChange={vi.fn()}
			onAdd={vi.fn()}
		/>
	)
}

describe("SpecialKeyDialog", () => {
	it("names each modifier toggle in words", () => {
		renderDialog()

		for (const name of ["Control", "Option", "Shift", "Command"]) {
			expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("false")
		}
	})

	it("names the glyph keys in its list in words", async () => {
		renderDialog()

		expect(screen.getByRole("combobox").textContent).toContain("Escape")

		fireEvent.click(screen.getByRole("combobox"))

		expect(await screen.findByRole("option", { name: "Enter" })).toBeTruthy()
		expect(screen.getByRole("option", { name: "Backspace" })).toBeTruthy()
		expect(screen.getByRole("option", { name: "Left arrow" })).toBeTruthy()
	})
})
