// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { render, screen } from "@testing-library/react"

// Settings › Office › PDF: the saved signatures row is busy until the synced file is read, so "None" with a disabled
// Manage is told apart from a read that has not finished.

const hooks = vi.hoisted(() => ({
	view: { loaded: false, readOnly: false, signatures: [], initials: [] }
}))

vi.mock("@/features/pdf/fillSign/savedSignatures", () => ({
	useSavedSignatures: () => hooks.view,
	loadSavedSignatures: () => Promise.resolve(),
	savedSignatures: { delete: () => Promise.resolve() }
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))

import "@/lib/i18n"
import { settings as EN } from "@/locales/en/settings"
import { OfficePdfRows } from "@/features/settings/components/office/pdfRows"

function row(): HTMLElement | null {
	return screen.getByRole("button", { name: EN.settingsOfficeSavedSignaturesManageLabel }).parentElement
}

describe("Office › PDF saved signatures row", () => {
	it("is aria-busy while loading and not once loaded", () => {
		const { rerender } = render(createElement(OfficePdfRows))

		expect(row()?.getAttribute("aria-busy")).toBe("true")

		hooks.view = { ...hooks.view, loaded: true }
		rerender(createElement(OfficePdfRows))

		expect(row()?.hasAttribute("aria-busy")).toBe(false)
	})
})
