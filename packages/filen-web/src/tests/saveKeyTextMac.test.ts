import { describe, expect, it } from "vitest"
import { parseCombo } from "@filen/shared/keymap"

// The Save key the editors' autosave notices name, on a Mac: the Apple form, never Ctrl+S.
Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", configurable: true })

const { chordText } = await import("@/lib/keymap/keyText")

describe("Save key text on a Mac", () => {
	it("names Mod+S as ⌘S", () => {
		const chord = parseCombo("mod+s")[0]

		if (chord === undefined) {
			throw new Error("no chord")
		}

		expect(chordText(chord)).toBe("⌘S")
	})
})
