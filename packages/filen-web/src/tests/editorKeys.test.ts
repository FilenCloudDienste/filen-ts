import { describe, expect, it } from "vitest"
import { editorKeyMatcher } from "@/features/preview/lib/editorKeys.logic"

// The editor shortcuts as CodeMirror tests the keydown: by physical key, as every other surface matches them.

// The fields a matcher reads; CodeMirror hands it a real KeyboardEvent.
function press(code: string, key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) {
	const event = {
		code,
		key,
		ctrlKey: modifiers.ctrlKey ?? false,
		metaKey: modifiers.metaKey ?? false,
		shiftKey: modifiers.shiftKey ?? false,
		altKey: modifiers.altKey ?? false,
		getModifierState: () => false
	}

	return event as unknown as KeyboardEvent
}

describe("editorKeyMatcher", () => {
	it("binds nothing for an unbound combo", () => {
		expect(editorKeyMatcher("", false)).toBeUndefined()
	})

	it("matches the combo's keys by code, Mod per platform, every alternative", () => {
		const find = editorKeyMatcher("mod+f", false)
		const findMac = editorKeyMatcher("mod+f", true)
		const either = editorKeyMatcher("mod+shift+x,mod+alt+f", false)

		expect(find?.(press("KeyF", "f", { ctrlKey: true }))).toBe(true)
		expect(find?.(press("KeyF", "f", { metaKey: true }))).toBe(false)
		expect(findMac?.(press("KeyF", "f", { metaKey: true }))).toBe(true)
		expect(either?.(press("KeyX", "X", { ctrlKey: true, shiftKey: true }))).toBe(true)
		expect(either?.(press("KeyF", "f", { ctrlKey: true, altKey: true }))).toBe(true)
	})

	it("fires a recorded punctuation or Space key, which CodeMirror's names would miss on other layouts", () => {
		expect(editorKeyMatcher("mod+bracketleft", false)?.(press("BracketLeft", "ü", { ctrlKey: true }))).toBe(true)
		expect(editorKeyMatcher("ctrl+space", true)?.(press("Space", " ", { ctrlKey: true }))).toBe(true)
		expect(editorKeyMatcher("mod+shift+comma", false)?.(press("Comma", ";", { ctrlKey: true, shiftKey: true }))).toBe(true)
		// The French key printed A is KeyQ: a binding on "a" stays on KeyA, whatever it types.
		expect(editorKeyMatcher("mod+a", false)?.(press("KeyQ", "a", { ctrlKey: true }))).toBe(false)
	})
})
