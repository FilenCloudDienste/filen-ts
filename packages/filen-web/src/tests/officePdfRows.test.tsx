// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { SavedSignaturesView } from "@/features/pdf/fillSign/savedSignatures"

// Settings › Office › PDF: the no-autosave note, and the saved signatures with delete.

function emptyView(): SavedSignaturesView {
	return { loaded: true, readOnly: false, signatures: [], initials: [] }
}

const hooks = vi.hoisted(() => ({
	view: emptyView(),
	online: true,
	remove: vi.fn<(id: string) => Promise<void>>(),
	toastError: vi.fn()
}))

vi.mock("@/features/pdf/fillSign/savedSignatures", () => ({
	useSavedSignatures: () => hooks.view,
	loadSavedSignatures: () => Promise.resolve(),
	savedSignatures: { delete: hooks.remove }
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => hooks.online }))
vi.mock("sonner", () => ({ toast: { error: hooks.toastError } }))

import "@/lib/i18n"
import { settings as EN } from "@/locales/en/settings"
import { OfficePdfRows } from "@/features/settings/components/office/pdfRows"

beforeEach(() => {
	hooks.view = emptyView()
	hooks.online = true
	hooks.remove.mockResolvedValue(undefined)
})

async function settle(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
}

describe("Office › PDF settings", () => {
	it("says PDFs are never saved automatically", () => {
		render(createElement(OfficePdfRows))

		expect(screen.getByText("PDFs are never saved automatically. Use Save.")).toBeTruthy()
		expect(screen.getByText(EN.settingsOfficeSavedSignaturesNone)).toBeTruthy()
		expect(screen.getByRole("button", { name: EN.settingsOfficeSavedSignatures })).toHaveProperty("disabled", true)
	})

	it("lists the saved signatures and initials and deletes one; a failed delete is told", async () => {
		hooks.view = {
			...emptyView(),
			signatures: [
				{ id: "sig", role: "signature", at: 2, data: { kind: "strokes", width: 10, height: 10, strokes: [[0, 0, 10, 10]] } }
			],
			initials: [{ id: "ini", role: "initials", at: 1, data: { kind: "image", width: 10, height: 5, png: "AAAA" } }]
		}
		render(createElement(OfficePdfRows))

		expect(screen.getByText("2 saved")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: EN.settingsOfficeSavedSignatures }))
		fireEvent.click(await screen.findByRole("button", { name: "Delete initials 1" }))

		expect(hooks.remove).toHaveBeenCalledWith("ini")

		hooks.remove.mockRejectedValueOnce(new Error("offline"))
		fireEvent.click(screen.getByRole("button", { name: "Delete signature 1" }))
		await settle()

		expect(hooks.toastError).toHaveBeenCalledWith(EN.settingsOfficeSavedSignaturesDeleteFailed)
	})

	it("cannot delete offline", async () => {
		hooks.online = false
		hooks.view = {
			...emptyView(),
			signatures: [
				{ id: "sig", role: "signature", at: 2, data: { kind: "strokes", width: 10, height: 10, strokes: [[0, 0, 10, 10]] } }
			]
		}
		render(createElement(OfficePdfRows))
		fireEvent.click(screen.getByRole("button", { name: EN.settingsOfficeSavedSignatures }))

		expect(await screen.findByRole("button", { name: "Delete signature 1" })).toHaveProperty("disabled", true)
	})
})
