import { describe, expect, it } from "vitest"
import { autostartEntry, autostartFile } from "../main/autostart.ts"

describe("autostartFile", () => {
	it("lives in XDG_CONFIG_HOME/autostart, else ~/.config/autostart", () => {
		expect(autostartFile("/cfg", "/home/u")).toBe("/cfg/autostart/Filen.desktop")
		expect(autostartFile(undefined, "/home/u")).toBe("/home/u/.config/autostart/Filen.desktop")
		expect(autostartFile("", "/home/u")).toBe("/home/u/.config/autostart/Filen.desktop")
	})
})

describe("autostartEntry", () => {
	it("starts the app hidden", () => {
		expect(autostartEntry(["/opt/Filen/Filen", "--hidden"])).toContain("\nExec=/opt/Filen/Filen --hidden\n")
	})

	it("quotes and escapes arguments per the Desktop Entry spec", () => {
		expect(autostartEntry(["/home/u/My Apps/Filen.AppImage", "--hidden"])).toContain(
			'\nExec="/home/u/My Apps/Filen.AppImage" --hidden\n'
		)
		expect(autostartEntry(['/a"b$c/100%', "--hidden"])).toContain('\nExec="/a\\\\"b\\\\$c/100%%" --hidden\n')
	})
})
