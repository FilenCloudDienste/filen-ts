// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest"
import { EditorState, TextSelection, type Transaction } from "prosemirror-state"
import { bodyToDoc, type TextEditing } from "@filen/office/react/presentation"
import type { TextBody } from "@filen/office/core/presentation"
import { slideTransform } from "@/features/presentation/lib/slideTransformHost"

// A deck's text editing with one open body, its controller standing in for the page's: transactions applied, typing
// flagged.
function editing(body: TextBody, from: number, to: number) {
	const { doc } = bodyToDoc(body)
	const controller = {
		state: EditorState.create({ doc, selection: TextSelection.create(doc, from, to) }),
		closed: false,
		dispatch: vi.fn((tr: Transaction, _typing?: boolean) => {
			controller.state = controller.state.apply(tr)
		})
	}
	const text = { active: controller as unknown, flush: vi.fn(() => Promise.resolve()) }

	return { controller, text, host: slideTransform(text as unknown as TextEditing, () => true) }
}

const BODY: TextBody = {
	bodyPr: {},
	paragraphs: [
		{ pPr: { lvl: 0 }, runs: [{ kind: "r", text: "Quarterly results", rPr: { sz: 3200 } }] },
		{ pPr: { lvl: 1 }, runs: [{ kind: "r", text: "Revenue up", rPr: { sz: 2000 } }] }
	]
}

describe("the slide selection transform host", () => {
	it("replaces the selection as one transaction that is not typing, then sends it", () => {
		const { controller, text, host } = editing(BODY, 1, 31)
		const selection = host.selection()

		if (selection === null || selection === "unsupported") throw new Error("no selection")

		expect(selection.text).toBe("Quarterly results\nRevenue up")
		expect(selection.replace("Quartalszahlen\nUmsatz gestiegen")).toEqual({ undo: null })
		expect(controller.dispatch).toHaveBeenCalledTimes(1)
		expect(controller.dispatch.mock.calls[0]?.[1]).toBeUndefined()
		expect(text.flush).toHaveBeenCalledTimes(1)
		expect(controller.state.doc.child(1).attrs["pPr"]).toEqual({ lvl: 1 })
		expect(controller.state.doc.textBetween(0, controller.state.doc.content.size, "\n")).toBe("Quartalszahlen\nUmsatz gestiegen")
	})

	it("is no longer current once the text was typed into", () => {
		const { controller, host } = editing(BODY, 1, 10)
		const selection = host.selection()

		if (selection === null || selection === "unsupported") throw new Error("no selection")

		controller.state = controller.state.apply(controller.state.tr.insertText("x", 12))
		expect(selection.current()).toBe(false)
		expect(selection.replace("Quartal")).toBeNull()
	})

	it("refuses a selection holding a slide number, and offers nothing without one", () => {
		const withField: TextBody = {
			bodyPr: {},
			paragraphs: [
				{
					pPr: {},
					runs: [
						{ kind: "r", text: "Slide ", rPr: {} },
						{ kind: "fld", type: "slidenum", id: "{1}", text: "3", rPr: {} }
					]
				}
			]
		}

		expect(editing(withField, 1, 8).host.selection()).toBe("unsupported")
		expect(editing(BODY, 3, 3).host.selection()).toBeNull()
		expect(slideTransform({ active: undefined } as unknown as TextEditing, () => true).selection()).toBeNull()

		const readOnly = editing(BODY, 1, 10)

		expect(slideTransform(readOnly.text as unknown as TextEditing, () => false).selection()).toBeNull()
	})
})
