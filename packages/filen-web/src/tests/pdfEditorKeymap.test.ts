// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"

// The registry's only storage calls, stubbed as in every other keymap test.
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve()
}))

const {
	PDF_EDITOR_ACTIONS,
	PDF_EDITOR_FIXED_ACTIONS,
	PDF_PAGE_HINT,
	isPdfToolLetter,
	pdfToolAction,
	pdfToolKeysValid,
	pdfToolLetterAllowed
} = await import("@/features/pdf/lib/keymap")
const { PDF_TOOLS } = await import("@/features/pdf/tools")
const { ALL_ACTIONS } = await import("@/lib/keymap/actions")
const { PDF_VIEWER_ACTIONS, PREVIEW_ACTIONS } = await import("@/features/preview/lib/keymap")
const { OFFICE_ACTIONS } = await import("@/features/office/lib/keymap")
const { defaultComboOn } = await import("@/lib/keymap/registry")
const { combosOverlap, parseCombo } = await import("@filen/shared/keymap")

const MAC_BROWSER = { mac: true, desktop: false }
const BROWSER = { mac: false, desktop: false }

function def(id: string) {
	const found = ALL_ACTIONS.find(action => action.id === id)

	if (found === undefined) throw new Error(id)

	return found
}

function chord(combo: string) {
	const [first] = parseCombo(combo)

	if (first === undefined) throw new Error(combo)

	return first
}

describe("the pdfEditor section", () => {
	it("is the editor's fixed actions and every tool's, all registered under Editor → PDF editor", () => {
		const toolIds = PDF_TOOLS.flatMap(tool => tool.actions.map(action => action.id))

		expect(PDF_EDITOR_ACTIONS.map(action => action.id)).toEqual([...PDF_EDITOR_FIXED_ACTIONS.map(action => action.id), ...toolIds])

		for (const action of PDF_EDITOR_ACTIONS) {
			expect([action.scope, action.section], action.id).toEqual(["editor", "pdfEditor"])
			expect(def(action.id), action.id).toBe(action)
		}
	})

	it("lists every tool action id it declares in actionIds", () => {
		for (const tool of PDF_TOOLS) {
			expect(new Set(tool.actionIds), tool.id).toEqual(new Set(tool.actions.map(action => action.id)))
		}
	})

	it("defaults to the editors' undo, redo and page rotate keys", () => {
		expect(defaultComboOn(def("pdf.undo"), BROWSER)).toBe("mod+z")
		expect(defaultComboOn(def("pdf.redo"), MAC_BROWSER)).toBe("mod+shift+z")
		expect(defaultComboOn(def("pdf.redo"), BROWSER)).toBe("mod+shift+z,mod+y")
		expect(defaultComboOn(def("pdf.delete"), BROWSER)).toBe("delete,backspace")
		expect(defaultComboOn(def("pdf.escape"), BROWSER)).toBe("escape")
		expect(defaultComboOn(def("pdf.rotatePagesCw"), MAC_BROWSER)).toBe("mod+alt+bracketright")
		expect(defaultComboOn(def("pdf.rotatePagesCcw"), MAC_BROWSER)).toBe("mod+alt+bracketleft")
	})

	it("keeps save, print and the view rotate keys on their existing actions", () => {
		const ids = new Set(PDF_EDITOR_ACTIONS.map(action => action.id))

		for (const kept of ["preview.save", "office.print", "preview.pdfRotateCw", "preview.pdfRotateCcw"]) {
			expect(ids.has(kept), kept).toBe(false)
		}

		expect(PREVIEW_ACTIONS.find(action => action.id === "preview.save")?.defaultCombo).toBe("mod+s")
		expect(OFFICE_ACTIONS.find(action => action.id === "office.print")?.defaultCombo).toBe("mod+p")
		expect(PDF_VIEWER_ACTIONS.find(action => action.id === "preview.pdfRotateCw")?.defaultCombo).toBe("mod+bracketright")

		for (const platform of [MAC_BROWSER, BROWSER]) {
			for (const action of PDF_EDITOR_ACTIONS) {
				for (const viewer of ["preview.pdfRotateCw", "preview.pdfRotateCcw", "preview.save", "office.print"]) {
					expect(
						combosOverlap(defaultComboOn(action, platform), defaultComboOn(def(viewer), platform), platform.mac),
						`${action.id} ${viewer}`
					).toBe(false)
				}
			}
		}
	})
})

describe("tool letters", () => {
	it("accepts a bare letter a–z other than the viewer's N, P and F", () => {
		expect(isPdfToolLetter(chord("v"))).toBe(true)
		expect(isPdfToolLetter(chord("k"))).toBe(true)

		for (const combo of ["n", "p", "f", "shift+v", "mod+v", "alt+t", "1", "space"]) {
			expect(isPdfToolLetter(chord(combo)), combo).toBe(false)
		}
	})

	it("holds every tool's keys to the rule: allowed letters, on the page only", () => {
		for (const action of PDF_EDITOR_ACTIONS) {
			expect(pdfToolKeysValid(action), action.id).toBe(true)
		}
	})

	it("rejects a tool action that breaks it", () => {
		expect(pdfToolKeysValid(pdfToolAction("pdf.tool.select", "v", "preview:previewPdfKeyEscape"))).toBe(true)
		expect(pdfToolKeysValid(pdfToolAction("pdf.tool.next", "n", "preview:previewPdfKeyEscape"))).toBe(false)
		expect(pdfToolKeysValid(pdfToolAction("pdf.tool.shifted", "shift+t", "preview:previewPdfKeyEscape"))).toBe(false)
		expect(
			pdfToolKeysValid({ id: "pdf.tool.anywhere", defaultCombo: "t", scope: "editor", descriptionKey: "preview:previewPdfKeyEscape" })
		).toBe(false)
		expect(
			pdfToolKeysValid({
				...pdfToolAction("pdf.tool.platform", "mod+alt+t", "preview:previewPdfKeyEscape"),
				platformDefaults: [{ on: { mac: false }, combo: "f" }]
			})
		).toBe(false)
		expect(pdfToolAction("pdf.tool.select", "v", "preview:previewPdfKeyEscape").hintKey).toBe(PDF_PAGE_HINT)
	})

	it("runs a letter on the page surface only, never in a field", () => {
		const surface = document.createElement("div")
		const page = document.createElement("canvas")
		const input = document.createElement("input")
		const textarea = document.createElement("textarea")
		const textbox = document.createElement("div")
		const typed = document.createElement("span")
		const editable = document.createElement("div")
		const outside = document.createElement("button")

		textbox.setAttribute("role", "textbox")
		textbox.append(typed)
		editable.setAttribute("contenteditable", "true")
		editable.append(document.createElement("b"))
		surface.append(page, input, textarea, textbox, editable)
		document.body.append(surface, outside)

		expect(pdfToolLetterAllowed(page, surface)).toBe(true)
		expect(pdfToolLetterAllowed(surface, surface)).toBe(true)
		expect(pdfToolLetterAllowed(input, surface)).toBe(false)
		expect(pdfToolLetterAllowed(textarea, surface)).toBe(false)
		expect(pdfToolLetterAllowed(typed, surface)).toBe(false)
		expect(pdfToolLetterAllowed(outside, surface)).toBe(false)
		expect(pdfToolLetterAllowed(null, surface)).toBe(false)
		expect(pdfToolLetterAllowed(editable, surface)).toBe(false)
		expect(pdfToolLetterAllowed(editable.firstElementChild, surface)).toBe(false)

		surface.remove()
		outside.remove()
	})
})
