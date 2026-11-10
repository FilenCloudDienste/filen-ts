// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import type { SheetAutosaveInput } from "@/features/spreadsheet/save/useSheetAutosave"
import { officeSettingsView } from "@/tests/support/officeSettingsView"

// The spreadsheet's idle autosave, as the Word document editor's: once per pause after an edit, with the user's
// synced setting, never over an open cell entry, offline or before the setting was read.

const hooks = vi.hoisted(() => ({
	settings: { authorName: null as string | null, autosave: true, loaded: true },
	online: true,
	loads: 0
}))

vi.mock("@/features/office/lib/officeSettings", () => ({
	loadOfficeSettings: () => {
		hooks.loads++

		return Promise.resolve()
	},
	useOfficeSettings: () => officeSettingsView(hooks.settings)
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => hooks.online }))

const { useSheetAutosave } = await import("@/features/spreadsheet/save/useSheetAutosave")
const { AUTOSAVE_IDLE_MS } = await import("@/features/office/lib/officeAutosave")

function setup(initial: Partial<SheetAutosaveInput>, answer = true) {
	const onAutosave = vi.fn(() => answer)
	const view = renderHook(
		(props: SheetAutosaveInput) => {
			useSheetAutosave(props)
		},
		{
			initialProps: { version: 1, dirty: true, editing: false, canSave: true, onAutosave, ...initial }
		}
	)

	return { onAutosave, view }
}

beforeEach(() => {
	vi.useFakeTimers()
	hooks.settings = { authorName: null, autosave: true, loaded: true }
	hooks.online = true
	hooks.loads = 0
})

afterEach(() => {
	vi.useRealTimers()
})

describe("the spreadsheet's idle autosave", () => {
	it("saves once a pause after the last edit, and not again for the same version", () => {
		const { onAutosave, view } = setup({})

		expect(hooks.loads).toBe(1)
		act(() => {
			vi.advanceTimersByTime(AUTOSAVE_IDLE_MS - 1)
		})
		expect(onAutosave).not.toHaveBeenCalled()
		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(onAutosave).toHaveBeenCalledTimes(1)

		view.rerender({ version: 1, dirty: true, editing: false, canSave: true, onAutosave })
		act(() => {
			vi.advanceTimersByTime(AUTOSAVE_IDLE_MS * 2)
		})
		expect(onAutosave).toHaveBeenCalledTimes(1)
	})

	it("waits for the pause after the latest edit", () => {
		const { onAutosave, view } = setup({})

		act(() => {
			vi.advanceTimersByTime(AUTOSAVE_IDLE_MS / 2)
		})
		view.rerender({ version: 2, dirty: true, editing: false, canSave: true, onAutosave })
		act(() => {
			vi.advanceTimersByTime(AUTOSAVE_IDLE_MS - 1)
		})
		expect(onAutosave).not.toHaveBeenCalled()
		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(onAutosave).toHaveBeenCalledTimes(1)
	})

	it("tries again after the next pause when the save could not start", () => {
		const { onAutosave } = setup({}, false)

		act(() => {
			vi.advanceTimersByTime(AUTOSAVE_IDLE_MS)
		})
		expect(onAutosave).toHaveBeenCalledTimes(1)
		act(() => {
			vi.advanceTimersByTime(AUTOSAVE_IDLE_MS)
		})
		expect(onAutosave).toHaveBeenCalledTimes(2)
	})

	it("never saves over an open cell entry, unsaved changes it cannot save, offline, or what is saved already", () => {
		for (const input of [{ editing: true }, { canSave: false }, { dirty: false }]) {
			const { onAutosave, view } = setup(input)

			act(() => {
				vi.advanceTimersByTime(AUTOSAVE_IDLE_MS * 2)
			})
			expect(onAutosave, JSON.stringify(input)).not.toHaveBeenCalled()
			view.unmount()
		}

		hooks.online = false

		const offline = setup({})

		act(() => {
			vi.advanceTimersByTime(AUTOSAVE_IDLE_MS * 2)
		})
		expect(offline.onAutosave).not.toHaveBeenCalled()
	})

	it("follows the setting, and waits until it was read", () => {
		hooks.settings = { authorName: null, autosave: false, loaded: true }

		const off = setup({})

		act(() => {
			vi.advanceTimersByTime(AUTOSAVE_IDLE_MS * 2)
		})
		expect(off.onAutosave).not.toHaveBeenCalled()
		off.view.unmount()

		hooks.settings = { authorName: null, autosave: true, loaded: false }

		const unread = setup({})

		act(() => {
			vi.advanceTimersByTime(AUTOSAVE_IDLE_MS * 2)
		})
		expect(unread.onAutosave).not.toHaveBeenCalled()
	})

	it("reads nothing and saves nothing where nobody asks it to save", () => {
		const { view } = setup({ onAutosave: undefined })

		act(() => {
			vi.advanceTimersByTime(AUTOSAVE_IDLE_MS * 2)
		})
		expect(hooks.loads).toBe(0)
		view.unmount()
	})
})
