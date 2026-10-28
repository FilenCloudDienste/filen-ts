import { describe, expect, it } from "vitest"
import { photosChooserChoice, photosPickVerdict } from "@/features/photos/components/directoryChooserDialog.logic"
import { testUuid } from "@/tests/support/uuid"

describe("photosChooserChoice", () => {
	it("chooses the directory open in the picker", () => {
		expect(photosChooserChoice(testUuid("a"), testUuid("root"))).toBe(testUuid("a"))
	})

	it("chooses the whole drive by its root uuid at the top", () => {
		expect(photosChooserChoice(null, testUuid("root"))).toBe(testUuid("root"))
	})

	it("chooses nothing at the top until the root uuid is known", () => {
		expect(photosChooserChoice(null, undefined)).toBeNull()
		expect(photosChooserChoice(null, "")).toBeNull()
	})
})

describe("photosPickVerdict", () => {
	it("refuses a directory inside a photos directory, naming it", () => {
		expect(photosPickVerdict("2024", { ok: false, reason: "nested", replace: ["pics"], within: ["pics"] })).toEqual({
			kind: "inside",
			root: "pics"
		})
	})

	it("offers to replace the photos directories a pick holds, as Videos does", () => {
		expect(photosPickVerdict("media", { ok: false, reason: "nested", replace: ["a", "b"] })).toEqual({
			kind: "replace",
			replace: ["a", "b"]
		})
	})

	it("adds a separate directory, and blocks Filen's own", () => {
		expect(photosPickVerdict("x", { ok: true })).toEqual({ kind: "clear", replace: [] })
		expect(photosPickVerdict("x", { ok: false, reason: "systemDirectory" })).toEqual({ kind: "blocked", reason: "systemDirectory" })
	})
})
