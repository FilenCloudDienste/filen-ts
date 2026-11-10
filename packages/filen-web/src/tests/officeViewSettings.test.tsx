// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

// How the office editors open on this device: read from kv during boot, held in memory, so an editor's first render
// reads the user's choice synchronously; a change is shown at once and stored.

const { stored, reads } = vi.hoisted(() => ({
	stored: new Map<string, unknown>([["office.viewSettings.v1", { markup: "all", docxView: "pages", slideRail: false, notesPane: true }]]),
	reads: { count: 0 }
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => {
		reads.count++

		return Promise.resolve(stored.get(key) ?? null)
	},
	kvSetJson: (key: string, value: unknown) => {
		stored.set(key, value)

		return Promise.resolve()
	}
}))

const { DEFAULT_OFFICE_VIEW_SETTINGS, loadOfficeViewSettings, officeViewSettings, setOfficeViewSettings, useOfficeViewSettings } =
	await import("@/features/office/lib/officeViewSettings")

describe("office view settings", () => {
	it("holds the defaults until boot read the stored choice once, then the choice, and stores a change", async () => {
		// Before boot read it (a test, a worker): valid defaults.
		expect(officeViewSettings()).toBe(DEFAULT_OFFICE_VIEW_SETTINGS)

		await Promise.all([loadOfficeViewSettings(), loadOfficeViewSettings()])
		expect(reads.count).toBe(1)
		// What an editor's first render reads, with nothing to wait for.
		expect(officeViewSettings()).toEqual({ markup: "all", docxView: "pages", slideRail: false, notesPane: true })

		const { result } = renderHook(() => useOfficeViewSettings())

		act(() => {
			setOfficeViewSettings({ notesPane: false })
		})

		expect(result.current.notesPane).toBe(false)
		expect(stored.get("office.viewSettings.v1")).toEqual({ markup: "all", docxView: "pages", slideRail: false, notesPane: false })
	})
})
