// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import type { DesktopDownloadDirectoryChoice, DesktopPrefs } from "@filen/shared/desktop"
import "@/lib/i18n"

const PREFS: DesktopPrefs = {
	minimizeToTray: false,
	startMinimized: false,
	launchAtLogin: false,
	lockAfterSeconds: 300,
	chatNotifications: true,
	contactNotifications: true,
	syncNotifications: true,
	notificationSound: true,
	downloadDirectory: null,
	speed: {
		sync: { preset: "balanced", uploadKbps: 0, downloadKbps: 0 },
		transfers: { preset: "balanced", uploadKbps: 0, downloadKbps: 0 }
	}
}

const prefs = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }))
const transfers = vi.hoisted(() => ({ chooseDownloadDirectory: vi.fn<() => Promise<DesktopDownloadDirectoryChoice>>() }))

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => ({ prefs, transfers }) }))

const { loadDesktopPrefs, setDesktopPref, useDesktopPrefs } = await import("@/features/desktop/lib/prefs")
const { DownloadDirectorySettings } = await import("@/features/desktop/components/downloadDirectorySettings")
const { SpeedSettings } = await import("@/features/desktop/components/speedSettings")

afterEach(() => {
	cleanup()
})

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
		prefs.set.mockResolvedValueOnce({ ...PREFS, chatNotifications: false, lockAfterSeconds: 3600 })
		await setDesktopPref({ chatNotifications: false, lockAfterSeconds: 3600 })
		expect(useDesktopPrefs.getState().prefs).toMatchObject({ chatNotifications: false, lockAfterSeconds: 3600 })

		prefs.set.mockRejectedValueOnce(new Error("invalid prefs"))
		await expect(setDesktopPref({ startMinimized: true })).rejects.toThrow("invalid prefs")
		expect(useDesktopPrefs.getState().prefs?.startMinimized).toBe(false)
	})
})

describe("download directory row", () => {
	function renderRow(downloadDirectory: string | null) {
		useDesktopPrefs.setState({ prefs: { ...PREFS, downloadDirectory } })
		render(createElement(DownloadDirectorySettings))
	}

	it("shows neither a directory nor Ask every time until the prefs loaded", () => {
		useDesktopPrefs.setState({ prefs: null })
		render(createElement(DownloadDirectorySettings))

		expect(screen.getByText("Save downloads to")).toBeTruthy()
		expect(screen.queryByText("Ask every time")).toBeNull()
		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Change…" }).disabled).toBe(true)
	})

	it("shows Ask every time by default and no Ask every time button", () => {
		renderRow(null)

		expect(screen.getByText("Save downloads to")).toBeTruthy()
		expect(screen.getByText("Ask every time")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Ask every time" })).toBeNull()
		expect(screen.getByRole("button", { name: "Change…" })).toBeTruthy()
	})

	it("Change stores the chosen directory and shows it without reloading prefs", async () => {
		renderRow(null)
		prefs.get.mockClear()
		transfers.chooseDownloadDirectory.mockResolvedValue({ status: "chosen", path: "/Users/me/Downloads" })

		fireEvent.click(screen.getByRole("button", { name: "Change…" }))

		expect(await screen.findByText("/Users/me/Downloads")).toBeTruthy()
		expect(useDesktopPrefs.getState().prefs?.downloadDirectory).toBe("/Users/me/Downloads")
		expect(screen.getByRole("button", { name: "Ask every time" })).toBeTruthy()
		expect(prefs.get).not.toHaveBeenCalled()
		expect(prefs.set).not.toHaveBeenCalled()
	})

	it("Ask every time resets to null", async () => {
		renderRow("/Users/me/Downloads")
		prefs.set.mockResolvedValue({ ...PREFS, downloadDirectory: null })

		fireEvent.click(screen.getByRole("button", { name: "Ask every time" }))

		await waitFor(() => {
			expect(screen.queryByRole("button", { name: "Ask every time" })).toBeNull()
		})
		expect(prefs.set).toHaveBeenCalledWith({ downloadDirectory: null })
		expect(screen.getByText("Ask every time")).toBeTruthy()
	})

	it("a canceled chooser changes nothing", async () => {
		renderRow("/Users/me/Downloads")
		transfers.chooseDownloadDirectory.mockResolvedValue({ status: "canceled" })

		fireEvent.click(screen.getByRole("button", { name: "Change…" }))

		await waitFor(() => {
			expect(screen.getByRole<HTMLButtonElement>("button", { name: "Change…" }).disabled).toBe(false)
		})
		expect(useDesktopPrefs.getState().prefs?.downloadDirectory).toBe("/Users/me/Downloads")
		expect(screen.getByText("/Users/me/Downloads")).toBeTruthy()
	})
})

describe("speed group", () => {
	function renderGroup() {
		useDesktopPrefs.setState({ prefs: PREFS })
		prefs.set.mockReset()
		render(createElement(SpeedSettings))
	}

	it("shows both clients with their preset and limits, and the note", () => {
		renderGroup()

		expect(screen.getByText("Sync")).toBeTruthy()
		expect(screen.getByText("Uploads & downloads")).toBeTruthy()
		expect(screen.getAllByText("Performance")).toHaveLength(2)
		expect(screen.getAllByText("KB/s")).toHaveLength(4)
		expect(screen.getByText("0 = unlimited. Applies at once.")).toBeTruthy()
		expect((document.getElementById("desktop-speed-transfers-upload") as HTMLInputElement).value).toBe("0")
	})

	it("stores a limit for its own client on Enter, the other client unchanged", async () => {
		renderGroup()
		prefs.set.mockImplementation((patch: Partial<DesktopPrefs>) => Promise.resolve({ ...PREFS, ...patch }))

		const input = document.getElementById("desktop-speed-transfers-download") as HTMLInputElement

		fireEvent.change(input, { target: { value: "2500" } })
		fireEvent.keyDown(input, { key: "Enter" })

		await waitFor(() => {
			expect(useDesktopPrefs.getState().prefs?.speed.transfers.downloadKbps).toBe(2500)
		})
		expect(prefs.set).toHaveBeenCalledWith({
			speed: { sync: PREFS.speed.sync, transfers: { preset: "balanced", uploadKbps: 0, downloadKbps: 2500 } }
		})
	})

	it("stores nothing for a value that is no whole number in range, and shows the stored one again", () => {
		renderGroup()

		const input = document.getElementById("desktop-speed-sync-upload") as HTMLInputElement

		for (const value of ["-1", "1.5", "abc", "10000001", "", "0"]) {
			fireEvent.change(input, { target: { value } })
			fireEvent.blur(input)
		}

		expect(prefs.set).not.toHaveBeenCalled()
		expect(input.value).toBe("0")
	})
})
