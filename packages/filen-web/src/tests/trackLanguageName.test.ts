import { describe, expect, it } from "vitest"
import { trackLanguageName } from "@/features/videos/lib/player/trackLabels.logic"

// Track languages read in the UI language, not in the shared table's English.

describe("trackLanguageName", () => {
	it("names a track's language in the UI language, whatever code the file carries", () => {
		expect(trackLanguageName("ger", "de")).toBe("Deutsch")
		expect(trackLanguageName("deu", "de")).toBe("Deutsch")
		expect(trackLanguageName("de", "de")).toBe("Deutsch")
		expect(trackLanguageName("jpn", "de")).toBe("Japanisch")
		expect(trackLanguageName("ger", "en")).toBe("German")
	})

	it("falls back to the English name where the UI language cannot name the tag", () => {
		expect(trackLanguageName("ger", "not a locale!")).toBe("German")
	})

	it("is null for unknown or undetermined codes", () => {
		expect(trackLanguageName("zzz", "de")).toBeNull()
		expect(trackLanguageName("und", "de")).toBeNull()
		expect(trackLanguageName(null, "de")).toBeNull()
		expect(trackLanguageName("", "de")).toBeNull()
	})
})
