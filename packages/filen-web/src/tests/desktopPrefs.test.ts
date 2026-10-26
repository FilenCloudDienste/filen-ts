import { describe, expect, it, vi } from "vitest"
import type { DesktopPrefs } from "@filen/shared/desktop"

const PREFS: DesktopPrefs = { minimizeToTray: false, startMinimized: false, launchAtLogin: false, notifications: true }

const prefs = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }))

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => ({ prefs }) }))

const { loadDesktopPrefs, setDesktopPref, useDesktopPrefs } = await import("@/features/desktop/lib/prefs")

describe("desktop prefs mirror", () => {
	it("reads the shell's prefs once and retries after a failure", async () => {
		prefs.get.mockRejectedValueOnce(new Error("ipc")).mockResolvedValue(PREFS)

		await loadDesktopPrefs()
		expect(useDesktopPrefs.getState().prefs).toBeNull()

		await loadDesktopPrefs()
		await loadDesktopPrefs()
		expect(useDesktopPrefs.getState().prefs).toEqual(PREFS)
		expect(prefs.get).toHaveBeenCalledTimes(2)
	})

	it("mirrors what the shell stored, and keeps the prefs when it refuses", async () => {
		prefs.set.mockResolvedValueOnce({ ...PREFS, notifications: false })
		await setDesktopPref({ notifications: false })
		expect(useDesktopPrefs.getState().prefs?.notifications).toBe(false)

		prefs.set.mockRejectedValueOnce(new Error("invalid prefs"))
		await expect(setDesktopPref({ startMinimized: true })).rejects.toThrow("invalid prefs")
		expect(useDesktopPrefs.getState().prefs?.startMinimized).toBe(false)
	})
})
