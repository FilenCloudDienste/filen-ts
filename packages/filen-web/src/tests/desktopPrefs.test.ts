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
	downloadDirectory: null
}

const prefs = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }))
const transfers = vi.hoisted(() => ({ chooseDownloadDirectory: vi.fn<() => Promise<DesktopDownloadDirectoryChoice>>() }))

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => ({ prefs, transfers }) }))

const { loadDesktopPrefs, setDesktopPref, useDesktopPrefs } = await import("@/features/desktop/lib/prefs")
const { DownloadDirectorySettings } = await import("@/features/desktop/components/downloadDirectorySettings")

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
