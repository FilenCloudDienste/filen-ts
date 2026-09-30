import { describe, it, expect } from "vitest"
import { applyScopedPreference, type ScopedPreferences } from "@/features/drive/driveScopedPreference"

describe("applyScopedPreference", () => {
	it("writes the global value in global mode and leaves perDirectory untouched", () => {
		const prev: ScopedPreferences<string> = { mode: "global", global: "a", perDirectory: { "drive:x": "b" } }

		expect(applyScopedPreference(prev, "drive:y", "c")).toEqual({ mode: "global", global: "c", perDirectory: { "drive:x": "b" } })
	})

	it("writes only the keyed entry in perDirectory mode", () => {
		const prev: ScopedPreferences<string> = { mode: "perDirectory", global: "a", perDirectory: { "drive:x": "b" } }
		const next = applyScopedPreference(prev, "drive:y", "c")

		expect(next).toEqual({ mode: "perDirectory", global: "a", perDirectory: { "drive:x": "b", "drive:y": "c" } })
		expect(prev.perDirectory).toEqual({ "drive:x": "b" })
	})
})
