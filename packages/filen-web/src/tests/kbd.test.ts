import { describe, expect, it } from "vitest"
import { comboAlternatives } from "@/lib/keymap/kbd.logic"

describe("comboAlternatives (<Kbd> rendering and conflict detection)", () => {
	it("splits a modifier combo into one key per badge", () => {
		expect(comboAlternatives("mod+f")).toEqual([["mod", "f"]])
	})

	it("splits a comma-separated combo into every alternative it fires on", () => {
		expect(comboAlternatives("delete,backspace")).toEqual([["delete"], ["backspace"]])
	})

	it("keeps each alternative's full modifier chain", () => {
		expect(comboAlternatives("mod+shift+arrowright,mod+shift+l")).toEqual([
			["mod", "shift", "arrowright"],
			["mod", "shift", "l"]
		])
	})

	it("trims padding around a single key", () => {
		expect(comboAlternatives(" escape ")).toEqual([["escape"]])
	})

	it("lowercases tokens, so two spellings of one chord compare equal", () => {
		expect(comboAlternatives("Mod+Shift+ArrowRight")).toEqual([["mod", "shift", "arrowright"]])
	})

	it("yields nothing for an unassigned combo", () => {
		expect(comboAlternatives("")).toEqual([])
	})

	// react-hotkeys-hook maps these onto the canonical token before matching, so the two spellings fire
	// on the same physical key — the shipped audio transport defaults are written in the alias form.
	it("resolves the library's key aliases, so an alias and its canonical token compare equal", () => {
		expect(comboAlternatives("mod+shift+right")).toEqual([["mod", "shift", "arrowright"]])
		expect(comboAlternatives("mod+shift+left")).toEqual([["mod", "shift", "arrowleft"]])
		expect(comboAlternatives("up,down")).toEqual([["arrowup"], ["arrowdown"]])
		expect(comboAlternatives("esc")).toEqual([["escape"]])
		expect(comboAlternatives("return")).toEqual([["enter"]])
	})
})
