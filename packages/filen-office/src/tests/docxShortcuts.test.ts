import { describe, expect, it } from "vitest"
import type { DocxEditorCommandType } from "../core/docx/edit/index"
import { commandForKey, findForKey, matchesShortcut, type KeyLike } from "../core/docx/paged/keys"

// Shortcut matching on QWERTY, AZERTY and Dvorak, on Apple (Cmd) and other (Ctrl) platforms: the character
// the layout gives wins; the physical key counts only where the layout gives no Latin letter or digit.

type Mods = Partial<Omit<KeyLike, "key" | "code">>

function key(key: string, code: string, mods: Mods = {}): KeyLike {
	return { key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }
}

// The platform's primary modifier (Cmd on Apple platforms, Ctrl elsewhere) plus `mods`.
function withMod(apple: boolean, mods: Mods = {}): Mods {
	return { ...(apple ? { metaKey: true } : { ctrlKey: true }), ...mods }
}

const PLATFORMS = [false, true] as const

describe("matchesShortcut across layouts", () => {
	// [layout, event.key, event.code, extra modifiers, shortcut, matches]
	const cases: readonly [string, string, string, Mods, string, boolean][] = [
		["QWERTY", "b", "KeyB", {}, "mod+b", true],
		["QWERTY", "B", "KeyB", { shiftKey: true }, "mod+b", false],
		["QWERTY", "B", "KeyB", { shiftKey: true }, "mod+shift+b", true],
		["QWERTY", "1", "Digit1", {}, "mod+1", true],
		["QWERTY", ">", "Period", { shiftKey: true }, "mod+shift+.", true],
		["QWERTY", "_", "Minus", { shiftKey: true }, "mod+shift+-", true],
		["QWERTY", "]", "BracketRight", {}, "mod+]", true],
		["QWERTY", " ", "Space", {}, "mod+space", true],
		// AZERTY: A and Q, Z and W swap; the unshifted digit row gives punctuation.
		["AZERTY", "a", "KeyQ", {}, "mod+a", true],
		["AZERTY", "a", "KeyQ", {}, "mod+q", false],
		["AZERTY", "q", "KeyA", {}, "mod+q", true],
		["AZERTY", "q", "KeyA", {}, "mod+a", false],
		["AZERTY", "z", "KeyW", {}, "mod+z", true],
		["AZERTY", "z", "KeyW", {}, "mod+w", false],
		["AZERTY", "&", "Digit1", {}, "mod+1", true],
		["AZERTY", "1", "Digit1", { shiftKey: true }, "mod+shift+1", true],
		["AZERTY", "1", "Digit1", { shiftKey: true }, "mod+shift+&", false],
		// Dvorak: X sits on QWERTY's B, B on N, C on I, I on G.
		["Dvorak", "x", "KeyB", {}, "mod+b", false],
		["Dvorak", "x", "KeyB", {}, "mod+x", true],
		["Dvorak", "b", "KeyN", {}, "mod+b", true],
		["Dvorak", "b", "KeyN", {}, "mod+n", false],
		["Dvorak", "c", "KeyI", {}, "mod+i", false],
		["Dvorak", "i", "KeyG", {}, "mod+i", true],
		["Dvorak", "1", "Digit1", {}, "mod+1", true],
		// Non-Latin layout: the physical key.
		["Russian", "и", "KeyB", {}, "mod+b", true]
	]

	for (const apple of PLATFORMS) {
		it.each(cases)(`%s %j on %j with %j as %s: %s (apple ${String(apple)})`, (_layout, pressed, code, mods, shortcut, matches) => {
			expect(matchesShortcut(key(pressed, code, withMod(apple, mods)), shortcut, apple)).toBe(matches)
		})
	}

	it("takes Cmd for mod on Apple platforms and Ctrl elsewhere, never both", () => {
		expect(matchesShortcut(key("b", "KeyB", { ctrlKey: true }), "mod+b", true)).toBe(false)
		expect(matchesShortcut(key("b", "KeyB", { metaKey: true }), "mod+b", false)).toBe(false)
		expect(matchesShortcut(key("b", "KeyB", { ctrlKey: true, metaKey: true }), "mod+b", true)).toBe(false)
		expect(matchesShortcut(key("b", "KeyB"), "mod+b", false)).toBe(false)
		// "ctrl" is Control on every platform.
		expect(matchesShortcut(key(" ", "Space", { ctrlKey: true }), "ctrl+space", true)).toBe(true)
		expect(matchesShortcut(key(" ", "Space", { metaKey: true }), "ctrl+space", true)).toBe(false)
	})

	it("reads an Option-composed character on a Mac by its physical key, and an AltGr character elsewhere as text", () => {
		expect(matchesShortcut(key("©", "KeyG", { metaKey: true, altKey: true }), "mod+alt+g", true)).toBe(true)
		expect(matchesShortcut(key("&", "Digit1", { metaKey: true, altKey: true }), "mod+alt+1", true)).toBe(true)
		// AZERTY on Windows: Ctrl+Alt is AltGr, so a non-Latin character it gives is typing.
		expect(matchesShortcut(key("&", "Digit1", { ctrlKey: true, altKey: true }), "mod+alt+1", false)).toBe(false)
		expect(matchesShortcut(key("1", "Digit1", { ctrlKey: true, altKey: true }), "mod+alt+1", false)).toBe(true)
		expect(
			matchesShortcut(
				{ ...key("1", "Digit1", { ctrlKey: true, altKey: true }), getModifierState: name => name === "AltGraph" },
				"mod+alt+1",
				false
			)
		).toBe(false)
	})
})

describe("commandForKey across layouts", () => {
	// [layout, event.key, event.code, extra modifiers, command]
	const cases: readonly [string, string, string, Mods, DocxEditorCommandType | undefined][] = [
		["QWERTY", "b", "KeyB", {}, "format.bold"],
		["QWERTY", "i", "KeyI", {}, "format.italic"],
		["QWERTY", "z", "KeyZ", {}, "history.undo"],
		["QWERTY", "Z", "KeyZ", { shiftKey: true }, "history.redo"],
		["AZERTY", "z", "KeyW", {}, "history.undo"],
		["AZERTY", "w", "KeyZ", {}, undefined],
		["AZERTY", "q", "KeyA", { shiftKey: true }, undefined],
		["AZERTY", "A", "KeyQ", { shiftKey: true }, "format.allCaps"],
		["Dvorak", "x", "KeyB", {}, undefined],
		["Dvorak", "b", "KeyN", {}, "format.bold"],
		["Dvorak", "i", "KeyG", {}, "format.italic"],
		["Dvorak", "c", "KeyI", {}, undefined],
		["Dvorak", "u", "KeyF", {}, "format.underline"]
	]

	for (const apple of PLATFORMS) {
		it.each(cases)(`%s %j on %j with %j: %s (apple ${String(apple)})`, (_layout, pressed, code, mods, type) => {
			expect(commandForKey(key(pressed, code, withMod(apple, mods)), apple)?.type).toBe(type)
		})
	}
})

describe("findForKey", () => {
	it("opens Word's Find, Go To and Replace off Apple platforms", () => {
		expect(findForKey(key("f", "KeyF", { ctrlKey: true }), false)).toBe("find")
		expect(findForKey(key("g", "KeyG", { ctrlKey: true }), false)).toBe("goTo")
		expect(findForKey(key("h", "KeyH", { ctrlKey: true }), false)).toBe("replace")
		expect(findForKey(key("H", "KeyH", { ctrlKey: true, shiftKey: true }), false)).toBeUndefined()
		expect(findForKey(key("f", "KeyF", { metaKey: true }), false)).toBeUndefined()
		expect(findForKey(key("f", "KeyF"), false)).toBeUndefined()
	})

	it("opens Word for Mac's: Cmd+F and Cmd+G find, Cmd+Option+G goes to, Control+H or Cmd+Shift+H replaces", () => {
		expect(findForKey(key("f", "KeyF", { metaKey: true }), true)).toBe("find")
		expect(findForKey(key("g", "KeyG", { metaKey: true }), true)).toBe("find")
		expect(findForKey(key("©", "KeyG", { metaKey: true, altKey: true }), true)).toBe("goTo")
		expect(findForKey(key("h", "KeyH", { ctrlKey: true }), true)).toBe("replace")
		expect(findForKey(key("H", "KeyH", { metaKey: true, shiftKey: true }), true)).toBe("replace")
		// Cmd+H hides the app; Control+F is not Find on a Mac.
		expect(findForKey(key("h", "KeyH", { metaKey: true }), true)).toBeUndefined()
		expect(findForKey(key("f", "KeyF", { ctrlKey: true }), true)).toBeUndefined()
	})

	it("follows the character the layout gives", () => {
		for (const apple of PLATFORMS) {
			// Dvorak: F on QWERTY's Y, H on J; QWERTY's F gives U.
			expect(findForKey(key("f", "KeyY", withMod(apple)), apple)).toBe("find")
			expect(findForKey(key("u", "KeyF", withMod(apple)), apple)).toBeUndefined()
			// Russian: the physical key.
			expect(findForKey(key("а", "KeyF", withMod(apple)), apple)).toBe("find")
		}

		expect(findForKey(key("h", "KeyJ", { ctrlKey: true }), false)).toBe("replace")
		expect(findForKey(key("g", "KeyU", { ctrlKey: true }), false)).toBe("goTo")
	})
})
