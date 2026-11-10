import { describe, expect, it } from "vitest"
import type { DocxEditorCommandType } from "../core/docx/edit/index"
import { DOCX_KEYS, docxKeyBindings, docxKeyDefault, docxKeyFor, type KeyLike } from "../core/docx/paged/keys"
import { appKeyFor, commandForKey } from "./docxKeyHelpers"

// Word's keys are physical keys (@filen/shared/keymap), as every other binding in the app: on AZERTY, QWERTZ and
// Dvorak a key fires where its US letter sits, on Apple (Cmd) and other (Ctrl) platforms.

type Mods = Partial<Omit<KeyLike, "key" | "code">>

function key(key: string, code: string, mods: Mods = {}): KeyLike {
	return { key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }
}

// The platform's primary modifier (Cmd on Apple platforms, Ctrl elsewhere) plus `mods`.
function withMod(apple: boolean, mods: Mods = {}): Mods {
	return { ...(apple ? { metaKey: true } : { ctrlKey: true }), ...mods }
}

const PLATFORMS = [false, true] as const

describe("docxKeyFor across layouts", () => {
	// [layout, event.key, event.code, extra modifiers, command]
	const cases: readonly [string, string, string, Mods, DocxEditorCommandType | undefined][] = [
		["QWERTY", "b", "KeyB", {}, "format.bold"],
		["QWERTY", "i", "KeyI", {}, "format.italic"],
		["QWERTY", "z", "KeyZ", {}, "history.undo"],
		["QWERTY", "Z", "KeyZ", { shiftKey: true }, "history.redo"],
		["QWERTY", ">", "Period", { shiftKey: true }, "font.grow"],
		["QWERTY", "]", "BracketRight", {}, "font.growPoint"],
		// AZERTY: the key printed Z is QWERTY's W.
		["AZERTY", "z", "KeyW", {}, undefined],
		["AZERTY", "w", "KeyZ", {}, "history.undo"],
		["AZERTY", "A", "KeyQ", { shiftKey: true }, undefined],
		["AZERTY", "Q", "KeyA", { shiftKey: true }, "format.allCaps"],
		// Dvorak: X sits on QWERTY's B.
		["Dvorak", "x", "KeyB", {}, "format.bold"],
		["Dvorak", "b", "KeyN", {}, undefined],
		// A non-Latin layout: the physical key.
		["Russian", "и", "KeyB", {}, "format.bold"]
	]

	for (const apple of PLATFORMS) {
		it.each(cases)(`%s %j on %j with %j: %s (apple ${String(apple)})`, (_layout, pressed, code, mods, type) => {
			expect(commandForKey(key(pressed, code, withMod(apple, mods)), apple)?.type).toBe(type)
		})
	}

	it("takes Cmd for mod on Apple platforms and Ctrl elsewhere, never both", () => {
		expect(commandForKey(key("b", "KeyB", { ctrlKey: true }), true)).toBeUndefined()
		expect(commandForKey(key("b", "KeyB", { metaKey: true }), false)).toBeUndefined()
		expect(commandForKey(key("b", "KeyB", { ctrlKey: true, metaKey: true }), true)).toBeUndefined()
		expect(commandForKey(key("b", "KeyB"), false)).toBeUndefined()
	})

	it("reads an Option-composed character on a Mac by its key, and an AltGr character elsewhere as text", () => {
		expect(commandForKey(key("¡", "Digit1", { metaKey: true, altKey: true }), true)).toEqual({ type: "style.set", style: "heading1" })
		expect(commandForKey(key("1", "Digit1", { ctrlKey: true, altKey: true }), false)).toEqual({ type: "style.set", style: "heading1" })
		expect(
			commandForKey(
				{ ...key("¹", "Digit1", { ctrlKey: true, altKey: true }), getModifierState: (name: string) => name === "AltGraph" },
				false
			)
		).toBeUndefined()
	})
})

describe("the app's keys", () => {
	it("opens Word's Find, Go To and Replace off Apple platforms", () => {
		expect(appKeyFor(key("f", "KeyF", { ctrlKey: true }), false)).toBe("find")
		expect(appKeyFor(key("g", "KeyG", { ctrlKey: true }), false)).toBe("goTo")
		expect(appKeyFor(key("h", "KeyH", { ctrlKey: true }), false)).toBe("replace")
		expect(appKeyFor(key("H", "KeyH", { ctrlKey: true, shiftKey: true }), false)).toBeUndefined()
		expect(appKeyFor(key("f", "KeyF", { metaKey: true }), false)).toBeUndefined()
		expect(appKeyFor(key("f", "KeyF"), false)).toBeUndefined()
	})

	it("opens Word for Mac's: Cmd+F and Cmd+G find, Cmd+Option+G goes to, Control+H or Cmd+Shift+H replaces", () => {
		expect(appKeyFor(key("f", "KeyF", { metaKey: true }), true)).toBe("find")
		expect(appKeyFor(key("g", "KeyG", { metaKey: true }), true)).toBe("find")
		expect(appKeyFor(key("©", "KeyG", { metaKey: true, altKey: true }), true)).toBe("goTo")
		expect(appKeyFor(key("h", "KeyH", { ctrlKey: true }), true)).toBe("replace")
		expect(appKeyFor(key("H", "KeyH", { metaKey: true, shiftKey: true }), true)).toBe("replace")
		// Cmd+H hides the app; Control+F is not Find on a Mac.
		expect(appKeyFor(key("h", "KeyH", { metaKey: true }), true)).toBeUndefined()
		expect(appKeyFor(key("f", "KeyF", { ctrlKey: true }), true)).toBeUndefined()
	})

	it("takes Repeat on F4 off Apple platforms only", () => {
		expect(appKeyFor(key("F4", "F4"), false)).toBe("repeat")
		expect(appKeyFor(key("F4", "F4"), true)).toBeUndefined()
	})
})

describe("a host's bindings", () => {
	it("fire the keys the host gives and no longer the default ones", () => {
		const bindings = { ...docxKeyBindings(false, false), "format.bold": "mod+shift+b", find: "f3,mod+e" }

		expect(docxKeyFor(key("B", "KeyB", { ctrlKey: true, shiftKey: true }), bindings, false)).toEqual({
			kind: "command",
			command: { type: "format.bold" }
		})
		expect(docxKeyFor(key("b", "KeyB", { ctrlKey: true }), bindings, false)).toBeUndefined()
		expect(docxKeyFor(key("F3", "F3"), bindings, false)).toEqual({ kind: "app", key: "find" })
		expect(docxKeyFor(key("e", "KeyE", { ctrlKey: true }), bindings, false)).toEqual({ kind: "app", key: "find" })
		expect(docxKeyFor(key("f", "KeyF", { ctrlKey: true }), bindings, false)).toBeUndefined()
	})

	it("leave a key unbound that they omit or bind to nothing", () => {
		expect(docxKeyFor(key("b", "KeyB", { ctrlKey: true }), {}, false)).toBeUndefined()
		expect(docxKeyFor(key("b", "KeyB", { ctrlKey: true }), { "format.bold": "" }, false)).toBeUndefined()
		expect(docxKeyFor(key("b", "KeyB", { ctrlKey: true }), { "format.bold": "none" }, false)).toBeUndefined()
	})
})

describe("docxKeyDefault", () => {
	const byId = new Map(DOCX_KEYS.map(entry => [entry.id, entry]))
	const defaultOf = (id: string, apple: boolean, desktop: boolean): string | undefined => {
		const entry = byId.get(id)

		return entry === undefined ? undefined : docxKeyDefault(entry, apple, desktop)
	}

	it("ships every key once, in the canonical token spelling", () => {
		expect(new Set(DOCX_KEYS.map(entry => entry.id)).size).toBe(DOCX_KEYS.length)
		expect(defaultOf("font.grow", false, false)).toBe("mod+shift+period")
		expect(defaultOf("history.redo", false, false)).toBe("mod+y,mod+shift+z")
		expect(defaultOf("field.unlink", false, false)).toBe("mod+shift+f9")
	})

	it("leaves out in a browser what the browser keeps, with a browser's key in its place where there is one", () => {
		expect(defaultOf("style.normal", false, true)).toBe("mod+shift+n")
		expect(defaultOf("style.normal", false, false)).toBe("mod+alt+0")
		expect(defaultOf("view.formattingMarks", true, true)).toBe("mod+8")
		expect(defaultOf("view.formattingMarks", true, false)).toBe("mod+shift+8")
		expect(defaultOf("paragraph.hangingIndent", false, true)).toBe("mod+t")
		expect(defaultOf("paragraph.hangingIndent", false, false)).toBe("")
		expect(defaultOf("format.paste", false, true)).toBe("mod+shift+v")
		expect(defaultOf("format.paste", false, false)).toBe("")
	})

	it("registers Word's keyless commands unbound", () => {
		for (const id of ["review.acceptAll", "comment.next", "toc.update", "insert.sectionBreak", "table.insert", "page.setup"]) {
			expect(defaultOf(id, false, true), id).toBe("")
		}
	})
})
