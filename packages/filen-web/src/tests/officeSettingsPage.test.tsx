// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { officeSettingsView } from "@/tests/support/officeSettingsView"
import type { OfficeSettingsView } from "@/features/office/lib/officeSettings"

// Settings → Office: each synced row writes its setting, tells a failed upload with the shared toast, and is
// disabled offline or before the file was read; the device rows write to this device only.
// A declaration, so vi.hoisted (moved above everything) can call it.
function noSettings(): Partial<OfficeSettingsView> {
	return {}
}

const hooks = vi.hoisted(() => ({
	online: true,
	settings: noSettings(),
	save: vi.fn<(key: string, value: unknown) => Promise<void>>(),
	view: vi.fn<(change: Record<string, unknown>) => void>(),
	toastError: vi.fn()
}))

vi.mock("@/features/office/lib/officeSettings", () => ({
	useOfficeSettings: () => officeSettingsView(hooks.settings),
	saveOfficeSetting: hooks.save,
	saveAuthorName: () => Promise.resolve()
}))
vi.mock("@/features/office/lib/officeViewSettings", () => ({
	useOfficeViewSettings: () => ({ markup: "simple", docxView: "auto", slideRail: true, notesPane: true }),
	setOfficeViewSettings: hooks.view
}))
vi.mock("@/features/office/lib/regionalFormat", () => ({ useRegionalLanguage: () => "en-US" }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => hooks.online }))
vi.mock("sonner", () => ({ toast: { error: hooks.toastError } }))

import "@/lib/i18n"
import { settings as EN_SETTINGS } from "@/locales/en/settings"
import { OfficeGeneralRows } from "@/features/settings/components/office/generalRows"
import { OfficeProofingRows } from "@/features/settings/components/office/proofingRows"
import { OfficeLayoutRows } from "@/features/settings/components/office/deviceRows"

beforeEach(() => {
	hooks.online = true
	hooks.settings = {}
	hooks.save.mockResolvedValue(undefined)
})

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

describe("the Office settings", () => {
	it("writes a synced setting, and says so when it could not be saved", async () => {
		hooks.save.mockRejectedValue(new Error("upload"))
		render(createElement(OfficeProofingRows))

		fireEvent.click(screen.getByRole("switch", { name: EN_SETTINGS.settingsOfficeSpellCheck }))
		await settle()

		expect(hooks.save).toHaveBeenCalledExactlyOnceWith("spellCheck", false)
		expect(hooks.toastError).toHaveBeenCalledExactlyOnceWith(EN_SETTINGS.settingsDocumentsSaveFailed)
	})

	it("disables the synced rows offline and before the file was read", () => {
		hooks.online = false

		const { unmount } = render(createElement(OfficeGeneralRows))

		expect(screen.getByRole("switch", { name: EN_SETTINGS.settingsDocumentsAutosave }).hasAttribute("data-disabled")).toBe(true)
		expect(screen.getByRole("button", { name: EN_SETTINGS.settingsOfficeAuthorInitials }).hasAttribute("disabled")).toBe(true)
		unmount()

		hooks.online = true
		hooks.settings = { loaded: false }
		render(createElement(OfficeGeneralRows))

		expect(screen.getByRole("switch", { name: EN_SETTINGS.settingsDocumentsAutosave }).hasAttribute("data-disabled")).toBe(true)
	})

	it("keeps the proofing options off while spelling is off", () => {
		hooks.settings = { spellCheck: false }
		render(createElement(OfficeProofingRows))

		expect(screen.getByRole("switch", { name: EN_SETTINGS.settingsOfficeFlagRepeated }).hasAttribute("data-disabled")).toBe(true)
		// The dictionary stays reachable: its words are the user's, whatever spelling does now.
		expect(screen.getByRole("button", { name: EN_SETTINGS.settingsOfficeDictionary }).hasAttribute("disabled")).toBe(false)
	})

	it("writes the layout to this device, also offline", () => {
		hooks.online = false
		render(createElement(OfficeLayoutRows))

		fireEvent.click(screen.getByRole("switch", { name: EN_SETTINGS.settingsOfficeNotesPane }))

		expect(hooks.view).toHaveBeenCalledExactlyOnceWith({ notesPane: false })
		expect(hooks.save).not.toHaveBeenCalled()
	})
})
