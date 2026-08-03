import { describe, expect, it } from "vitest"
import { normalizeRecordedCombo } from "@/lib/keymap/captureCombo"

describe("normalizeRecordedCombo", () => {
	it("returns null while only modifiers are held", () => {
		expect(normalizeRecordedCombo(["meta"], true)).toBeNull()
		expect(normalizeRecordedCombo(["ctrl", "shift"], false)).toBeNull()
		expect(normalizeRecordedCombo([], false)).toBeNull()
	})

	it("folds the platform-primary modifier to the portable mod token", () => {
		expect(normalizeRecordedCombo(["meta", "s"], true)).toBe("mod+s")
		expect(normalizeRecordedCombo(["ctrl", "s"], false)).toBe("mod+s")
	})

	it("preserves a real ctrl chord on mac, where Control is not Command", () => {
		expect(normalizeRecordedCombo(["ctrl", "s"], true)).toBe("ctrl+s")
	})

	it("keeps a non-primary meta modifier off mac", () => {
		expect(normalizeRecordedCombo(["meta", "s"], false)).toBe("meta+s")
	})

	it("emits modifiers in a canonical order regardless of insertion order", () => {
		expect(normalizeRecordedCombo(["s", "shift", "alt", "meta"], true)).toBe("mod+alt+shift+s")
		expect(normalizeRecordedCombo(["meta", "alt", "shift", "s"], true)).toBe("mod+alt+shift+s")
	})

	it("records a bare non-modifier key", () => {
		expect(normalizeRecordedCombo(["shift", "slash"], false)).toBe("shift+slash")
		expect(normalizeRecordedCombo(["f2"], false)).toBe("f2")
	})

	it("normalizes the control alias to ctrl", () => {
		expect(normalizeRecordedCombo(["control", "s"], true)).toBe("ctrl+s")
	})

	it("lowercases what it records", () => {
		expect(normalizeRecordedCombo(["Meta", "S"], true)).toBe("mod+s")
	})
})
