import { describe, expect, it } from "vitest"
import { DESKTOP_SHELL_STRINGS, DESKTOP_SHELL_STRING_MAX_LENGTH, formatShellString } from "@filen/shared/desktopShellStrings"

describe("desktop shell strings", () => {
	it("are camelCase keys prefixed shell, short enough for main to accept", () => {
		for (const [key, text] of Object.entries(DESKTOP_SHELL_STRINGS)) {
			expect(key).toMatch(/^shell[A-Z]\w*$/)
			expect(text.length).toBeLessThanOrEqual(DESKTOP_SHELL_STRING_MAX_LENGTH)
		}
	})

	it("fill placeholders and keep unknown ones", () => {
		expect(formatShellString("Mounted at {{path}} ({{ count }})", { path: "/mnt", count: 2 })).toBe("Mounted at /mnt (2)")
		expect(formatShellString("{{missing}} stays", {})).toBe("{{missing}} stays")
	})
})
