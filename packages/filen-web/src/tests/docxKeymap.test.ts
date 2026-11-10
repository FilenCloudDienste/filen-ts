import { describe, expect, it, vi } from "vitest"

// The registry's only storage calls, stubbed as in every other keymap test.
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve()
}))

const { DOCX_KEYS, docxKeyFor } = await import("@filen/office/core/docx/keys")
const { DOCX_ACTIONS, DOCX_KEY_ACTIONS, docxKeyBindings, lineSpacingAction } = await import("@/features/preview/lib/docxKeymap")
const { ALL_ACTIONS } = await import("@/lib/keymap/actions")
const { defaultComboOn } = await import("@/lib/keymap/registry")
const { ariaKeyShortcuts } = await import("@/lib/keymap/keyText")

const MAC_BROWSER = { mac: true, desktop: false }
const BROWSER = { mac: false, desktop: false }
const MAC_DESKTOP = { mac: true, desktop: true }
const DESKTOP = { mac: false, desktop: true }

function def(id: string) {
	const found = ALL_ACTIONS.find(action => action.id === id)

	if (found === undefined) throw new Error(id)

	return found
}

describe("the Word actions", () => {
	it("gives every key of the editor's an action, all under Editor → Word", () => {
		for (const key of DOCX_KEYS) {
			expect(DOCX_KEY_ACTIONS.get(key.id), key.id).toBeDefined()
		}

		for (const action of DOCX_ACTIONS) {
			expect([action.id, action.scope, action.section]).toEqual([action.id, "editor", "word"])
		}
	})

	it("defaults to Word's keys per platform, with a browser's in place of those it keeps", () => {
		expect(defaultComboOn(def("docx.styleNormal"), BROWSER)).toBe("mod+alt+0")
		expect(defaultComboOn(def("docx.styleNormal"), DESKTOP)).toBe("mod+shift+n")
		expect(defaultComboOn(def("docx.formattingMarks"), MAC_BROWSER)).toBe("mod+shift+8")
		expect(defaultComboOn(def("docx.formattingMarks"), MAC_DESKTOP)).toBe("mod+8")
		expect(defaultComboOn(def("docx.clearFormatting"), BROWSER)).toBe("mod+space")
		expect(defaultComboOn(def("docx.clearFormatting"), MAC_DESKTOP)).toBe("mod+shift+space")
		expect(defaultComboOn(def("docx.lineSpacingDouble"), BROWSER)).toBe("")
		expect(defaultComboOn(def("docx.lineSpacingDouble"), DESKTOP)).toBe("mod+2")
		expect(defaultComboOn(def("docx.replace"), BROWSER)).toBe("mod+h")
		expect(defaultComboOn(def("docx.replace"), MAC_BROWSER)).toBe("ctrl+h,mod+shift+h")
		expect(defaultComboOn(def("docx.repeat"), MAC_BROWSER)).toBe("")
		expect(defaultComboOn(def("docx.insertFootnote"), BROWSER)).toBe("mod+alt+f")
		expect(defaultComboOn(def("docx.insertEquation"), MAC_BROWSER)).toBe("ctrl+equal")
		expect(defaultComboOn(def("docx.pasteFormatting"), BROWSER)).toBe("")
		expect(defaultComboOn(def("docx.pasteFormatting"), DESKTOP)).toBe("mod+shift+v")
		expect(defaultComboOn(def("docx.zoomIn"), BROWSER)).toBe("mod+equal,mod+add")
		expect(defaultComboOn(def("docx.wordCount"), BROWSER)).toBe("mod+shift+g")
		expect(defaultComboOn(def("docx.downloadPdf"), BROWSER)).toBe("mod+p")
	})

	it("registers Word's keyless review, insert and view commands unbound", () => {
		for (const id of [
			"docx.acceptChange",
			"docx.rejectAll",
			"docx.nextComment",
			"docx.updateToc",
			"docx.insertSectionBreak",
			"docx.insertTable",
			"docx.pageSetup",
			"docx.navigationPane",
			"docx.mobileView"
		]) {
			expect(defaultComboOn(def(id), BROWSER), id).toBe("")
		}
	})

	it("hints the line spacing multiples that have a key", () => {
		expect(lineSpacingAction(240)).toBe("docx.lineSpacingSingle")
		expect(lineSpacingAction(360)).toBe("docx.lineSpacingOneAndHalf")
		expect(lineSpacingAction(480)).toBe("docx.lineSpacingDouble")
		expect(lineSpacingAction(276)).toBeUndefined()
	})
})

describe("docxKeyBindings", () => {
	const key = (code: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) => ({
		key: code,
		code,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		altKey: false,
		...mods
	})

	it("hands the editor the combos in effect by its keys, the shared editor actions' included", () => {
		const bindings = docxKeyBindings({
			"docx.underline": "mod+shift+u",
			"editor.find": "f3",
			"editor.bold": "",
			"docx.acceptAll": "alt+a"
		})

		expect(bindings["format.underline"]).toBe("mod+shift+u")
		expect(bindings["find"]).toBe("f3")
		expect(bindings["format.bold"]).toBe("")
		expect(docxKeyFor(key("KeyU", { ctrlKey: true, shiftKey: true }), bindings, false)).toEqual({
			kind: "command",
			command: { type: "format.underline" }
		})
		expect(docxKeyFor(key("KeyU", { ctrlKey: true }), bindings, false)).toBeUndefined()
		expect(docxKeyFor(key("KeyB", { ctrlKey: true }), bindings, false)).toBeUndefined()
		expect(docxKeyFor(key("F3"), bindings, false)).toEqual({ kind: "app", key: "find" })
		expect(docxKeyFor(key("KeyA", { altKey: true }), bindings, false)).toEqual({
			kind: "command",
			command: { type: "review.acceptAll" }
		})
	})

	it("defaults an action the combos leave out, and returns one object per combos object", () => {
		const combos = {}
		const bindings = docxKeyBindings(combos)

		expect(bindings["format.underline"]).toBe(defaultComboOn(def("docx.underline"), { mac: false, desktop: false }))
		expect(docxKeyBindings(combos)).toBe(bindings)
		expect(docxKeyBindings({})).not.toBe(bindings)
	})
})

describe("ariaKeyShortcuts", () => {
	it("names each chord's modifiers and key as ARIA does", () => {
		expect(ariaKeyShortcuts("mod+h", false)).toBe("Control+H")
		expect(ariaKeyShortcuts("ctrl+h,mod+shift+h", true)).toBe("Control+H Shift+Meta+H")
		expect(ariaKeyShortcuts("mod+alt+equal,f9,mod+arrowup", false)).toBe("Control+Alt+= F9 Control+ArrowUp")
		expect(ariaKeyShortcuts("", false)).toBe("")
	})
})
