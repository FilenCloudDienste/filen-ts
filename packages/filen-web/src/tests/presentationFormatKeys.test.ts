// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { slideRef, type DeckOp, type Xfrm } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideLayer, SlideRender, TextSeed } from "@filen/office/dom/presentation"
import { createShapeSelection, createTextEditing, formatPainterOf } from "@filen/office/react/presentation"
import type { TextRibbonEditor } from "@/features/presentation/components/ribbon/homeText.logic"
import { onFormatKey } from "@/features/presentation/lib/formatKeys"
import { PRESENTATION_EDITOR_ACTIONS } from "@/features/presentation/lib/keymap/editor"

// PowerPoint's Copy Formatting and Paste Formatting keys (Ctrl+Shift+C, Ctrl+Shift+V; Cmd on a Mac): taken on the
// slide only, a copy holds the selection's format without turning the painter on, a paste applies it to the selection.

const EMU = 9525
const ref = slideRef(256)
const box: Xfrm = { x: 0, y: 0, cx: 100 * EMU, cy: 50 * EMU, rot: 0, flipH: false, flipV: false }

const slide = {
	ref,
	index: 0,
	revision: 1,
	hidden: false,
	background: {},
	layers: [2, 3].map(
		id =>
			({
				shape: { slide: ref, id },
				role: "shape",
				drawing: {},
				matrix: [1, 0, 0, 1, 0, 0],
				box: { id, xfrm: box, body: "shape" }
			}) as unknown as SlideLayer
	),
	notesText: "",
	animated: false
} as unknown as SlideRender

function editorOf(): { editor: TextRibbonEditor; commands: DeckOp[]; select: (id: number) => void } {
	const selection = createShapeSelection()
	const commands: DeckOp[] = []
	const session = {
		textSeed: (shape: { slide: number; id: number }) =>
			Promise.resolve({
				shape,
				revision: 1,
				body: { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text: "x", rPr: {} }] }] },
				resolved: [{ pPr: {}, runs: [shape.id === 2 ? { b: true, sz: 4000 } : { sz: 1800 }] }],
				page: {},
				layout: {},
				matrix: []
			} as unknown as TextSeed)
	} as unknown as PresentationSessionApi

	selection.show(ref)

	return {
		editor: {
			info: { slides: [{ ref, hidden: false }], customShows: [], editable: true } as unknown as OpenInfo,
			render: slide,
			selection,
			text: createTextEditing(),
			session,
			command: (op: DeckOp): Promise<CommandResult> => {
				commands.push(op)

				return Promise.resolve({ ok: true, revision: 1, dirty: true })
			}
		},
		commands,
		select: id => {
			selection.set([id])
		}
	}
}

function keyOn(target: Element, key: string, init: { readonly ctrlKey?: boolean; readonly metaKey?: boolean } = { ctrlKey: true }) {
	return {
		key,
		code: `Key${key.toUpperCase()}`,
		ctrlKey: init.ctrlKey ?? false,
		metaKey: init.metaKey ?? false,
		shiftKey: true,
		altKey: false,
		target,
		defaultPrevented: false,
		preventDefault: vi.fn()
	}
}

function canvas(): HTMLElement {
	const root = document.createElement("div")
	const inner = document.createElement("div")

	root.setAttribute("data-fo-slide-canvas", "")
	root.append(inner)
	document.body.append(root)

	return inner
}

afterEach(() => {
	document.body.replaceChildren()
})

describe("presentation format keys", () => {
	it("registers Copy and Paste Formatting as rebindable editor actions", () => {
		const combos = new Map(PRESENTATION_EDITOR_ACTIONS.map(action => [action.id, action.defaultCombo]))

		expect(combos.get("presentation.copyFormat")).toBe("mod+shift+c")
		expect(combos.get("presentation.pasteFormat")).toBe("mod+shift+v")
	})

	it("copies the selected shape's format and pastes it onto another, one undo step", async () => {
		const { editor, commands, select } = editorOf()
		const target = canvas()

		select(2)

		const copy = keyOn(target, "C")

		expect(onFormatKey(copy, editor, true, {}, false)).toBe(true)
		expect(copy.preventDefault).toHaveBeenCalled()
		// The click painter stays off.
		expect(formatPainterOf(editor.text).mode).toBe("off")

		// The copy reads the shape's text in the worker: wait for it to be held.
		const paste = keyOn(target, "V")

		await vi.waitFor(() => {
			select(3)
			expect(onFormatKey(paste, editor, true, {}, false)).toBe(true)
		})
		expect(paste.preventDefault).toHaveBeenCalled()
		await vi.waitFor(() => {
			expect(commands).toHaveLength(1)
		})

		const op = commands[0]

		expect(op?.family === "text" && op.kind === "setText" ? op.target : undefined).toEqual({ slide: ref, id: 3 })
		expect(
			op?.family === "text" && op.kind === "setText"
				? op.body.paragraphs[0]?.runs.map(each => ("rPr" in each ? each.rPr : undefined))
				: undefined
		).toEqual([{ b: true, sz: 4000 }])
	})

	it("takes the keys in a body being edited on the slide", () => {
		const { editor, select } = editorOf()
		const body = document.createElement("div")
		const editable = document.createElement("div")

		body.setAttribute("data-fo-text-editor", "")
		editable.setAttribute("contenteditable", "true")
		body.append(editable)
		canvas().append(body)
		select(2)
		expect(onFormatKey(keyOn(editable, "C"), editor, true, {}, false)).toBe(true)
	})

	it("uses Cmd on a Mac", () => {
		const { editor, select } = editorOf()

		select(2)
		expect(onFormatKey(keyOn(canvas(), "C", { metaKey: true }), editor, true, {}, true)).toBe(true)
		expect(onFormatKey(keyOn(canvas(), "C", { ctrlKey: true }), editor, true, {}, true)).toBe(false)
	})

	it("leaves the key to the browser off the slide, with nothing copied, or in a deck that can only be viewed", () => {
		const { editor, select } = editorOf()
		const outside = document.createElement("textarea")

		document.body.append(outside)
		select(2)

		// The notes or another field: Ctrl+Shift+V stays paste as plain text, Ctrl+Shift+C the browser's.
		expect(onFormatKey(keyOn(outside, "C"), editor, true, {}, false)).toBe(false)
		// A field on the slide that is not the body.
		const prompt = document.createElement("input")

		canvas().append(prompt)
		expect(onFormatKey(keyOn(prompt, "C"), editor, true, {}, false)).toBe(false)
		// Nothing copied yet.
		expect(onFormatKey(keyOn(canvas(), "V"), editor, true, {}, false)).toBe(false)
		expect(onFormatKey(keyOn(canvas(), "C"), editor, false, {}, false)).toBe(false)
		expect(onFormatKey(keyOn(canvas(), "C"), undefined, true, {}, false)).toBe(false)

		// Nothing with text selected.
		editor.selection.set([])
		expect(onFormatKey(keyOn(canvas(), "C"), editor, true, {}, false)).toBe(false)
	})

	it("follows a rebinding", () => {
		const { editor, select } = editorOf()

		select(2)
		expect(onFormatKey(keyOn(canvas(), "C"), editor, true, { "presentation.copyFormat": "alt+c" }, false)).toBe(false)
	})
})
