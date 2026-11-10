import { describe, expect, it } from "vitest"
import { DOCX_PARAGRAPH_STYLE_MENU, browserReservedShortcut, commandInfo, shortcutFor } from "../core/docx/edit/index"
import { DOCX_KEYS, docxKeyDefault, type KeyLike } from "../core/docx/paged/keys"
import { commandForKey, hostCommandForKey } from "./docxKeyHelpers"

function key(key: string, code: string, mods: Partial<Omit<KeyLike, "key" | "code">> = {}): KeyLike {
	return { key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }
}

const SPACE = (mods: Partial<KeyLike>): KeyLike => key(" ", "Space", mods)

function info(type: Parameters<typeof commandInfo>[0]) {
	const out = commandInfo(type)

	if (out === undefined) throw new Error(type)

	return out
}

function defaultOf(id: string, apple: boolean, desktop: boolean): string {
	const entry = DOCX_KEYS.find(candidate => candidate.id === id)

	if (entry === undefined) throw new Error(id)

	return docxKeyDefault(entry, apple, desktop)
}

describe("docx command shortcuts", () => {
	it("clears formatting with Ctrl+Space off Apple and Cmd+Shift+Space on a Mac, never Control+Space or Cmd+Space", () => {
		expect(commandForKey(SPACE({ ctrlKey: true }), false)).toEqual({ type: "format.clear" })
		expect(commandForKey(SPACE({ metaKey: true, shiftKey: true }), true)).toEqual({ type: "format.clear" })
		// Control+Space switches the input source on a Mac, Cmd+Space is Spotlight.
		expect(commandForKey(SPACE({ ctrlKey: true }), true)).toBeUndefined()
		expect(commandForKey(SPACE({ metaKey: true }), true)).toBeUndefined()
		expect(shortcutFor(info("format.clear"), true)).toBe("mod+shift+space")
		expect(shortcutFor(info("format.clear"), false)).toBe("mod+space")
	})

	it("bullets with Mod+Shift+L, leaving Ctrl+Shift+8 to Show/Hide ¶", () => {
		for (const apple of [false, true]) {
			const mod = apple ? { metaKey: true } : { ctrlKey: true }

			expect(commandForKey(key("L", "KeyL", { ...mod, shiftKey: true }), apple)).toEqual({ type: "list.bullet" })
			expect(shortcutFor(info("list.bullet"), apple)).toBe("mod+shift+l")
		}

		expect(commandForKey(key("*", "Digit8", { ctrlKey: true, shiftKey: true }), false)).toEqual({ type: "view.formattingMarks" })
		expect(commandForKey(key("*", "Digit8", { metaKey: true, shiftKey: true }), true, true)).toBeUndefined()
	})

	it("takes Mod+Y for redo on every platform, Mod+Shift+Z too", () => {
		for (const apple of [false, true]) {
			const mod = apple ? { metaKey: true } : { ctrlKey: true }

			expect(defaultOf("history.redo", apple, false)).toBe("mod+y,mod+shift+z")
			expect(commandForKey(key("y", "KeyY", mod), apple)).toEqual({ type: "history.redo" })
			expect(commandForKey(key("Z", "KeyZ", { ...mod, shiftKey: true }), apple)).toEqual({ type: "history.redo" })
		}
	})

	it("indents with Ctrl+M / Ctrl+Shift+M, and Control+Shift+M / Cmd+Shift+M on a Mac", () => {
		expect(commandForKey(key("m", "KeyM", { ctrlKey: true }), false)).toEqual({ type: "list.indent" })
		expect(commandForKey(key("M", "KeyM", { ctrlKey: true, shiftKey: true }), false)).toEqual({ type: "list.outdent" })
		expect(commandForKey(key("M", "KeyM", { ctrlKey: true, shiftKey: true }), true)).toEqual({ type: "list.indent" })
		expect(commandForKey(key("M", "KeyM", { metaKey: true, shiftKey: true }), true)).toEqual({ type: "list.outdent" })
		// Cmd+M minimises the window.
		expect(commandForKey(key("m", "KeyM", { metaKey: true }), true)).toBeUndefined()
		expect(shortcutFor(info("list.indent"), true)).toBe("ctrl+shift+m")
		expect(shortcutFor(info("list.indent"), false)).toBe("mod+m")
		expect(shortcutFor(info("list.outdent"), true)).toBe("mod+shift+m")
	})

	it("takes Normal's Mod+Shift+N in the desktop app and Mod+Alt+0 in a browser", () => {
		const normal = DOCX_PARAGRAPH_STYLE_MENU.find(entry => entry.style === "normal")

		expect(normal?.shortcut).toBe("mod+shift+n")
		expect(commandForKey(key("N", "KeyN", { ctrlKey: true, shiftKey: true }), false, true)).toEqual({
			type: "style.set",
			style: "normal"
		})
		expect(commandForKey(key("N", "KeyN", { ctrlKey: true, shiftKey: true }), false)).toBeUndefined()
		expect(commandForKey(key("0", "Digit0", { ctrlKey: true, altKey: true }), false)).toEqual({ type: "style.set", style: "normal" })

		for (const apple of [false, true]) {
			expect(defaultOf("style.normal", apple, true)).toBe("mod+shift+n")
			expect(defaultOf("style.normal", apple, false)).toBe("mod+alt+0")
		}

		expect(browserReservedShortcut("mod+m", true)).toBe(true)
		expect(browserReservedShortcut("mod+m", false)).toBe(false)
	})

	it("gives a browser no default it keeps for itself", () => {
		for (const apple of [false, true]) {
			for (const entry of DOCX_KEYS) {
				for (const chord of docxKeyDefault(entry, apple, false).split(",")) {
					expect(browserReservedShortcut(chord, apple), `${entry.id} ${chord}`).toBe(false)
				}
			}
		}
	})

	it("leaves Word's Track Changes (Mod+Shift+E) and New Comment (Ctrl+Alt+M, Cmd+Option+A) keys to the host", () => {
		for (const apple of [false, true]) {
			const mod = apple ? { metaKey: true } : { ctrlKey: true }
			const trackKey = key("E", "KeyE", { ...mod, shiftKey: true })

			expect(hostCommandForKey(trackKey, apple)).toBe("review.track")
			expect(commandForKey(trackKey, apple)).toBeUndefined()
			expect(hostCommandForKey(key("e", "KeyE", mod), apple)).toBeUndefined()
		}

		expect(hostCommandForKey(key("m", "KeyM", { ctrlKey: true, altKey: true }), false)).toBe("comment.add")
		expect(commandForKey(key("m", "KeyM", { ctrlKey: true, altKey: true }), false)).toBeUndefined()
		// Option composes a character: the physical key counts.
		expect(hostCommandForKey(key("å", "KeyA", { metaKey: true, altKey: true }), true)).toBe("comment.add")
		expect(hostCommandForKey(key("µ", "KeyM", { metaKey: true, altKey: true }), true)).toBeUndefined()
		// A character AltGr gives (AltGr+M on a German layout) is text.
		expect(
			hostCommandForKey(
				{ ...key("µ", "KeyM", { ctrlKey: true, altKey: true }), getModifierState: name => name === "AltGraph" },
				false
			)
		).toBeUndefined()
		expect(hostCommandForKey(key("m", "KeyM", {}), false)).toBeUndefined()
		expect(defaultOf("comment.add", false, false)).toBe("mod+alt+m")
		expect(defaultOf("comment.add", true, false)).toBe("mod+alt+a")
	})

	it("leaves the commands that ask for input first to the host: link, equation, table, symbol, page setup", () => {
		expect(hostCommandForKey(key("k", "KeyK", { ctrlKey: true }), false)).toBe("link.set")
		expect(hostCommandForKey(key("k", "KeyK", { metaKey: true }), true)).toBe("link.set")
		expect(hostCommandForKey(key("=", "Equal", { altKey: true }), false)).toBe("equation.insert")
		expect(hostCommandForKey(key("=", "Equal", { ctrlKey: true }), true)).toBe("equation.insert")

		for (const id of ["table.insert", "insert.symbol", "page.setup"]) {
			expect(DOCX_KEYS.find(entry => entry.id === id)?.run).toEqual({ kind: "host", type: id })
		}
	})

	it("inserts footnotes and endnotes with Ctrl+Alt+F and Ctrl+Alt+D, strikes through with Mod+Shift+X", () => {
		for (const apple of [false, true]) {
			const mod = apple ? { metaKey: true } : { ctrlKey: true }

			expect(commandForKey(key("f", "KeyF", { ...mod, altKey: true }), apple)).toEqual({ type: "note.insertFootnote" })
			expect(commandForKey(key("d", "KeyD", { ...mod, altKey: true }), apple)).toEqual({ type: "note.insertEndnote" })
			expect(commandForKey(key("X", "KeyX", { ...mod, shiftKey: true }), apple)).toEqual({ type: "format.strike" })
		}
	})

	it("copies and pastes formatting with Mod+Shift+C and V in the desktop app only", () => {
		expect(commandForKey(key("C", "KeyC", { ctrlKey: true, shiftKey: true }), false, true)).toEqual({ type: "format.copy" })
		expect(commandForKey(key("V", "KeyV", { metaKey: true, shiftKey: true }), true, true)).toEqual({ type: "format.paste" })
		expect(commandForKey(key("C", "KeyC", { ctrlKey: true, shiftKey: true }), false)).toBeUndefined()
		expect(commandForKey(key("V", "KeyV", { ctrlKey: true, shiftKey: true }), false)).toBeUndefined()
	})
})
