import { describe, expect, it } from "vitest"
import { rootPickVerdict } from "@/lib/rootChooser.logic"

describe("rootPickVerdict", () => {
	it("clears a separate directory", () => {
		expect(rootPickVerdict({ uuid: "pics", validation: { ok: true }, replacing: [] })).toEqual({ kind: "clear", replace: [] })
	})

	it("offers to replace the roots an overlapping pick holds", () => {
		expect(rootPickVerdict({ uuid: "media", validation: { ok: false, reason: "nested", replace: ["a", "b"] }, replacing: [] })).toEqual(
			{
				kind: "replace",
				replace: ["a", "b"]
			}
		)
	})

	it("blocks Filen's own directory, a root already there and one gone", () => {
		for (const reason of ["systemDirectory", "alreadyRoot", "notFound", "notOwnDrive"] as const) {
			expect(rootPickVerdict({ uuid: "x", validation: { ok: false, reason }, replacing: [] })).toEqual({ kind: "blocked", reason })
		}
	})

	it("counts overlap with only the roots being replaced anyway as clear", () => {
		expect(rootPickVerdict({ uuid: "new", validation: { ok: false, reason: "nested", replace: ["old"] }, replacing: ["old"] })).toEqual(
			{
				kind: "clear",
				replace: ["old"]
			}
		)
		expect(rootPickVerdict({ uuid: "old", validation: { ok: false, reason: "alreadyRoot" }, replacing: ["old"] })).toEqual({
			kind: "clear",
			replace: ["old"]
		})
	})
})
