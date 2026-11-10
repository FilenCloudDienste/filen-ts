import { describe, expect, it } from "vitest"
import { isTypedCharacter } from "@filen/office/core/sheet"
import { isImeKeydown } from "@filen/shared/keymap"

describe("typing into the grid", () => {
	const typed = (key: string, extra: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
		isTypedCharacter({ key, ctrlKey: false, metaKey: false, altKey: false, ...extra })

	it("types characters, AltGr and Option ones included, but not shortcuts", () => {
		expect(typed("a")).toBe(true)
		expect(typed("@", { ctrlKey: true, altKey: true })).toBe(true)
		expect(typed("å", { altKey: true })).toBe(true)
		expect(typed("😀")).toBe(true)
		expect(typed("c", { ctrlKey: true })).toBe(false)
		expect(typed("c", { metaKey: true })).toBe(false)
		expect(typed("ArrowDown")).toBe(false)
		expect(typed("Dead")).toBe(false)
	})

	it("recognises input-method keydowns, Safari's confirming Enter included", () => {
		expect(isImeKeydown({ key: "Enter", isComposing: false, keyCode: 229 })).toBe(true)
		expect(isImeKeydown({ key: "Process", isComposing: false, keyCode: 0 })).toBe(true)
		expect(isImeKeydown({ key: "a", isComposing: true, keyCode: 65 })).toBe(true)
		expect(isImeKeydown({ key: "Enter", isComposing: false, keyCode: 13 })).toBe(false)
	})
})
