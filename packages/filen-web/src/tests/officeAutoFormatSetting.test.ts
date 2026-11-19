// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { fireEvent, render, screen } from "@testing-library/react"

// Word's AutoFormat As You Type the docx editor opens with: on for a choice stored before the setting existed,
// off where the user turned it off, from its switches in Settings, Office.

const { stored } = vi.hoisted(() => ({
	stored: new Map<string, unknown>([["office.viewSettings.v1", { markup: "all", docxView: "pages", slideRail: false, notesPane: true }]])
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(stored.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		stored.set(key, value)

		return Promise.resolve()
	}
}))

const { docxAutoFormat, loadOfficeViewSettings, officeViewSettings, setOfficeViewSettings } =
	await import("@/features/office/lib/officeViewSettings")

await import("@/lib/i18n")
const { settings: EN_SETTINGS } = await import("@/locales/en/settings")
const { OfficeWordRows } = await import("@/features/settings/components/office/deviceRows")

describe("docx AutoFormat setting", () => {
	it("keeps quotes and lists on for an older stored choice and stores each switch", async () => {
		await loadOfficeViewSettings()
		expect(officeViewSettings().markup).toBe("all")
		expect(docxAutoFormat()).toEqual({ quotes: true, lists: true })

		setOfficeViewSettings({ autoQuotes: false })
		expect(docxAutoFormat()).toEqual({ quotes: false, lists: true })

		setOfficeViewSettings({ autoLists: false })
		expect(docxAutoFormat()).toEqual({ quotes: false, lists: false })
		expect(stored.get("office.viewSettings.v1")).toMatchObject({ markup: "all", autoQuotes: false, autoLists: false })
	})

	it("turns each switch off from its Settings row", async () => {
		await loadOfficeViewSettings()
		setOfficeViewSettings({ autoQuotes: true, autoLists: true })
		render(createElement(OfficeWordRows))

		const quotes = screen.getByRole("switch", { name: EN_SETTINGS.settingsOfficeAutoQuotes })
		const lists = screen.getByRole("switch", { name: EN_SETTINGS.settingsOfficeAutoLists })

		expect(quotes.getAttribute("aria-checked")).toBe("true")
		fireEvent.click(quotes)
		expect(docxAutoFormat()).toEqual({ quotes: false, lists: true })

		fireEvent.click(lists)
		expect(docxAutoFormat()).toEqual({ quotes: false, lists: false })
		expect(screen.getByRole("switch", { name: EN_SETTINGS.settingsOfficeAutoLists }).getAttribute("aria-checked")).toBe("false")
	})
})
