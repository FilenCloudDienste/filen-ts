import { describe, expect, it } from "vitest"
import { appIdentity, closeAction, keepsRendererAlive, startsHidden } from "../main/lifecycle.ts"

describe("closeAction", () => {
	it.each([
		["darwin", false, false, "hide"],
		["darwin", false, true, "hide"],
		["win32", false, false, "quit"],
		["linux", false, false, "quit"],
		["win32", false, true, "hide"],
		["linux", false, true, "hide"],
		["darwin", true, false, "close"],
		["win32", true, true, "close"]
	] as const)("%s quitting=%s tray=%s → %s", (platform, quitting, minimizeToTray, expected) => {
		expect(closeAction(platform, quitting, minimizeToTray)).toBe(expected)
	})
})

describe("keepsRendererAlive", () => {
	it("lets an idle page go", () => {
		expect(keepsRendererAlive({ unloadHolds: 0, audioPlaying: false, notifications: false })).toBe(false)
	})

	it.each([
		{ unloadHolds: 2, audioPlaying: false, notifications: false },
		{ unloadHolds: 0, audioPlaying: true, notifications: false },
		{ unloadHolds: 0, audioPlaying: false, notifications: true }
	])("keeps %o", state => {
		expect(keepsRendererAlive(state)).toBe(true)
	})
})

describe("startsHidden", () => {
	it("starts with a window by default", () => {
		expect(startsHidden(["/app/Filen"], false, false)).toBe(false)
	})

	it("starts hidden from the login item, the macOS login launch or the pref", () => {
		expect(startsHidden(["/app/Filen", "--hidden"], false, false)).toBe(true)
		expect(startsHidden(["/app/Filen"], false, true)).toBe(true)
		expect(startsHidden(["/app/Filen"], true, false)).toBe(true)
	})
})

describe("appIdentity", () => {
	it("keeps the packaged app's name and directory", () => {
		expect(appIdentity(true)).toEqual({ name: "Filen", userData: "@filen/desktop" })
	})

	it("gives unpackaged runs their own, so their safeStorage entry is separate", () => {
		expect(appIdentity(false)).toEqual({ name: "Filen Dev", userData: "@filen/desktop-dev" })
	})
})
