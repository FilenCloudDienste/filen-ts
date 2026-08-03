import { describe, expect, it } from "vitest"
import { comboKeys } from "@/lib/keymap/kbd.logic"

describe("comboKeys (<Kbd> combo rendering)", () => {
	it("splits a modifier combo into one key per badge", () => {
		expect(comboKeys("mod+f")).toEqual(["mod", "f"])
	})

	it("renders only the first alternative of a comma-separated combo", () => {
		expect(comboKeys("delete,backspace")).toEqual(["delete"])
	})

	it("renders the first alternative's full modifier chain", () => {
		expect(comboKeys("mod+shift+arrowright,mod+shift+l")).toEqual(["mod", "shift", "arrowright"])
	})

	it("trims padding around a single key", () => {
		expect(comboKeys(" escape ")).toEqual(["escape"])
	})

	it("renders nothing for an unassigned combo", () => {
		expect(comboKeys("")).toEqual([])
	})
})
