import { TextSelection } from "prosemirror-state"
import { describe, expect, it } from "vitest"
import { parseDocxEditorCommand, type DocxEditorSession } from "@filen/office/core/docx/edit"
import { DOCX_KEY_BINDINGS, commandForKey, commandShortcut, type KeyLike } from "../core/docx/paged/keys"
import { sessionOf } from "./docxEditFixtures"
import { p } from "./docxSynthetic"

function key(key: string, code: string, mods: Partial<Omit<KeyLike, "key" | "code">> = {}): KeyLike {
	return { key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }
}

function indentOf(session: DocxEditorSession, index = 0): unknown {
	return session.state.doc.child(index).attrs["indent"]
}

function selectAll(session: DocxEditorSession): void {
	const doc = session.state.doc

	session.dispatch(session.state.tr.setSelection(TextSelection.create(doc, 1, doc.content.size - 1)))
}

const HANG = { type: "paragraph.hangingIndent", direction: 1 } as const
const UNHANG = { type: "paragraph.hangingIndent", direction: -1 } as const

describe("hanging indent (Ctrl+T, Ctrl+Shift+T)", () => {
	it("moves the lines after the first one tab stop per press, the first line staying put", async () => {
		const session = await sessionOf({ body: p("One") })

		selectAll(session)
		expect(session.execute(HANG)).toBe(true)
		expect(indentOf(session)).toEqual({ start: 720, hanging: 720 })
		expect(session.execute(HANG)).toBe(true)
		expect(indentOf(session)).toEqual({ start: 1440, hanging: 1440 })
		expect(session.execute(UNHANG)).toBe(true)
		expect(indentOf(session)).toEqual({ start: 720, hanging: 720 })
		expect(session.execute(UNHANG)).toBe(true)
		expect(indentOf(session)).toEqual({ start: 0, hanging: 0 })
		// No hanging indent left: Unhang changes nothing.
		expect(session.execute(UNHANG)).toBe(false)
	})

	it("steps by the document's default tab stop, from each paragraph's own indent", async () => {
		const session = await sessionOf({
			body: p("One", '<w:ind w:left="500"/>') + p("Two", '<w:ind w:left="0" w:firstLine="600"/>'),
			settings: '<w:defaultTabStop w:val="400"/>'
		})

		selectAll(session)
		session.execute(HANG)
		expect(indentOf(session, 0)).toEqual({ start: 800, hanging: 300 })
		// Past the first line: a hanging indent from the first press.
		expect(indentOf(session, 1)).toEqual({ start: 800, hanging: 200 })
		session.execute(UNHANG)
		expect(indentOf(session, 0)).toEqual({ start: 500, hanging: 0 })
		expect(indentOf(session, 1)).toEqual({ start: 600, hanging: 0 })
	})

	it("parses only a direction of 1 or -1", () => {
		expect(parseDocxEditorCommand(HANG)).toEqual(HANG)
		expect(parseDocxEditorCommand({ type: "paragraph.hangingIndent", direction: 2 })).toBeUndefined()
		expect(parseDocxEditorCommand({ type: "paragraph.hangingIndent" })).toBeUndefined()
	})

	it("binds Mod+T and Mod+Shift+T in the desktop app only", () => {
		for (const apple of [false, true]) {
			const mod = apple ? { metaKey: true } : { ctrlKey: true }

			expect(commandForKey(key("t", "KeyT", mod), apple, true)).toEqual(HANG)
			expect(commandForKey(key("T", "KeyT", { ...mod, shiftKey: true }), apple, true)).toEqual(UNHANG)
			expect(commandForKey(key("t", "KeyT", mod), apple, false)).toBeUndefined()
			expect(commandForKey(key("T", "KeyT", { ...mod, shiftKey: true }), apple, false)).toBeUndefined()
		}

		// Word for Mac's Control+Shift+T stays the TIME field.
		expect(commandForKey(key("T", "KeyT", { ctrlKey: true, shiftKey: true }), true, true)?.type).toBe("insert.field")
	})
})

describe("argument bindings' shortcuts", () => {
	it("gives Word's line spacing keys to the menu items they run, in the desktop app", () => {
		const spacing = (value: number) => ({ type: "paragraph.lineSpacing", rule: "auto", value }) as const

		expect(commandShortcut(spacing(240), false, true)).toBe("mod+1")
		expect(commandShortcut(spacing(480), true, true)).toBe("mod+2")
		expect(commandShortcut(spacing(360), false, true)).toBe("mod+5")
		expect(commandShortcut(spacing(276), false, true)).toBeUndefined()
		expect(commandShortcut(spacing(240), false, false)).toBeUndefined()
		expect(commandShortcut({ type: "paragraph.lineSpacing", rule: "exact", value: 240 }, false, true)).toBeUndefined()
	})

	it("finds every binding's own shortcut", () => {
		for (const binding of DOCX_KEY_BINDINGS) {
			for (const apple of [false, true]) {
				expect(commandShortcut(binding.command, apple, true)).toBe(
					apple ? (binding.appleShortcut ?? binding.shortcut) : binding.shortcut
				)
			}
		}
	})
})
