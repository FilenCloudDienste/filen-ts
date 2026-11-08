import { describe, expect, it } from "vitest"
import { DOCX_PARAGRAPH_STYLE_MENU, browserReservedShortcut, commandInfo, shortcutFor, shortcutHint } from "../core/docx/edit/index"
import { commandForKey, hostCommandForKey, type KeyLike } from "../core/docx/paged/keys"

function key(key: string, code: string, mods: Partial<Omit<KeyLike, "key" | "code">> = {}): KeyLike {
	return { key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }
}

const SPACE = (mods: Partial<KeyLike>): KeyLike => key(" ", "Space", mods)

function info(type: Parameters<typeof commandInfo>[0]) {
	const out = commandInfo(type)

	if (out === undefined) throw new Error(type)

	return out
}

describe("docx command shortcuts", () => {
	it("clears formatting with Ctrl+Space off Apple and Control+Space on a Mac, never Cmd+Space", () => {
		expect(commandForKey(SPACE({ ctrlKey: true }), false)).toEqual({ type: "format.clear" })
		expect(commandForKey(SPACE({ ctrlKey: true }), true)).toEqual({ type: "format.clear" })
		expect(commandForKey(SPACE({ metaKey: true }), true)).toBeUndefined()
		expect(shortcutFor(info("format.clear"), true)).toBe("ctrl+space")
		expect(shortcutFor(info("format.clear"), false)).toBe("mod+space")
	})

	it("bullets with Mod+Shift+L, leaving Mod+Shift+8 (Show/Hide ¶) free", () => {
		for (const apple of [false, true]) {
			const mod = apple ? { metaKey: true } : { ctrlKey: true }

			expect(commandForKey(key("L", "KeyL", { ...mod, shiftKey: true }), apple)).toEqual({ type: "list.bullet" })
			expect(commandForKey(key("*", "Digit8", { ...mod, shiftKey: true }), apple)).toBeUndefined()
			expect(shortcutFor(info("list.bullet"), apple)).toBe("mod+shift+l")
		}
	})

	it("advertises Mod+Y for redo and takes it on every platform, Mod+Shift+Z too", () => {
		for (const apple of [false, true]) {
			const mod = apple ? { metaKey: true } : { ctrlKey: true }

			expect(shortcutFor(info("history.redo"), apple)).toBe("mod+y")
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

	it("binds Normal's Mod+Shift+N but advertises it only outside a browser", () => {
		const normal = DOCX_PARAGRAPH_STYLE_MENU.find(entry => entry.style === "normal")

		expect(normal?.shortcut).toBe("mod+shift+n")
		expect(commandForKey(key("N", "KeyN", { ctrlKey: true, shiftKey: true }), false)).toEqual({ type: "style.set", style: "normal" })

		for (const apple of [false, true]) {
			expect(shortcutHint(normal ?? {}, apple, true)).toBeUndefined()
			expect(shortcutHint(normal ?? {}, apple, false)).toBe("mod+shift+n")
		}

		expect(browserReservedShortcut("mod+m", true)).toBe(true)
		expect(browserReservedShortcut("mod+m", false)).toBe(false)
		expect(shortcutHint(info("format.bold"), false, true)).toBe("mod+b")
	})

	it("advertises no shortcut a browser keeps for itself", () => {
		for (const apple of [false, true]) {
			for (const type of ["format.clear", "list.bullet", "list.indent", "list.outdent", "history.undo", "history.redo"] as const) {
				const shortcut = shortcutFor(info(type), apple)

				expect(shortcut === undefined || !browserReservedShortcut(shortcut, apple)).toBe(true)
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
			expect(shortcutHint(info("review.track"), apple, true)).toBe("mod+shift+e")
		}

		expect(hostCommandForKey(key("m", "KeyM", { ctrlKey: true, altKey: true }), false)).toBe("comment.add")
		expect(commandForKey(key("m", "KeyM", { ctrlKey: true, altKey: true }), false)).toBeUndefined()
		// Option composes a character: the physical key counts.
		expect(hostCommandForKey(key("å", "KeyA", { metaKey: true, altKey: true }), true)).toBe("comment.add")
		expect(hostCommandForKey(key("µ", "KeyM", { metaKey: true, altKey: true }), true)).toBeUndefined()
		// A character AltGr gives (Ctrl+Alt+M on a German layout) is text.
		expect(hostCommandForKey(key("µ", "KeyM", { ctrlKey: true, altKey: true }), false)).toBeUndefined()
		expect(hostCommandForKey(key("m", "KeyM", {}), false)).toBeUndefined()
		expect(shortcutHint(info("comment.add"), false, true)).toBe("mod+alt+m")
		expect(shortcutHint(info("comment.add"), true, true)).toBe("mod+alt+a")
	})
})
