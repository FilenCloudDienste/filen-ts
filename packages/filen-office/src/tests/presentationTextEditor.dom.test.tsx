// @vitest-environment happy-dom
import { act } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type ShapeRef, type TextBody } from "../core/presentation/model"
import type { SlideRender, TextSeed } from "../core/presentation/output"
import type { PresentationSessionApi } from "../dom/presentation/protocol"
import { createTextEditing, type TextEditing } from "../react/presentation/edit/text/editing"
import { fakeSession, flushAll, frameWithLayers, laid, mountEditor, seedOf, SHAPE, THEME_TEXT } from "./presentationTextEditorFixtures.dom"

// The editor view on a slide: it paints the worker's page under the text matrix, hides the slide's own painting of
// the shape while open, takes keys through its input sink (Enter splits, composition replaces a selection, Mod+Z is
// the worker's undo with the body open), and leaves on Escape with its text sent and the slide's text shown again.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const RENDER = {
	ref: SHAPE.slide,
	index: 0,
	revision: 1,
	hidden: false,
	layers: [
		// A layout's layer names the layout, even where its shape's id is the slide shape's.
		{ shape: { slide: slideRef(2), id: SHAPE.id }, role: "layout", matrix: [1, 0, 0, 1, 0, 0], text: {} },
		{ shape: SHAPE, role: "placeholder", matrix: [1, 0, 0, 1, 0, 0], text: {} }
	],
	notesText: "",
	animated: false
} as unknown as SlideRender

// Where position `pos` of the open body is on screen, mid-line: the seed sits at (40, 50) on a slide at scale 1.
function clientAt(editing: TextEditing, pos: number): { clientX: number; clientY: number } {
	const caret = editing.active?.map.caret(pos)

	if (caret === undefined) throw new Error("no caret at " + String(pos))

	return { clientX: caret.x + 40, clientY: caret.top + caret.height / 2 + 50 }
}

function selected(editing: TextEditing): [number, number] | undefined {
	const selection = editing.active?.state.selection

	return selection === undefined ? undefined : [selection.anchor, selection.head]
}

function key(target: Element, init: KeyboardEventInit): void {
	target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }))
}

describe("presentation text editor view", () => {
	afterEach(() => {
		document.body.replaceChildren()
		vi.useRealTimers()
	})

	it("paints the body over the shape's own text, which it hides, and shows it again on Escape", async () => {
		const ops: DeckOp[] = []
		const frame = frameWithLayers()
		const host = document.createElement("div")
		const editing = createTextEditing()
		const exits: number[] = []

		frame.append(host)

		const { root } = await mountEditor(host, {
			session: fakeSession(ops, []),
			scale: 0.5,
			editing,
			render: RENDER,
			onExit: () => exits.push(1)
		})

		const layers = frame.querySelectorAll<HTMLElement>(".fo-slide-text")

		expect(layers[0]?.style.visibility).toBe("")
		expect(layers[1]?.style.visibility).toBe("hidden")
		expect(editing.active?.shape).toEqual(SHAPE)
		expect(frame.querySelector(".fo-text-edit-box")?.getAttribute("style")?.replace(/\s/gu, "")).toContain("matrix(0.5,0,0,0.5,20,25)")
		expect(frame.querySelector('[role="textbox"]')?.getAttribute("aria-label")).toBe("Slide text")

		const sink = frame.querySelector(".fo-text-sink.ProseMirror") as HTMLElement

		const canvas = document.createElement("div")

		canvas.dataset["foShapeEdit"] = ""
		canvas.tabIndex = 0
		frame.append(canvas)
		key(sink, { key: "Escape" })
		await flushAll()

		expect(exits).toEqual([1])
		// Focus goes back to the slide's canvas (where the shape stays selected), not the dialog around it.
		expect(document.activeElement).toBe(canvas)

		await act(async () => {
			root.unmount()
		})

		expect(layers[1]?.style.visibility).toBe("")
		expect(editing.active).toBeUndefined()
	})

	it("Enter splits the paragraph, Mod+Z sends the pending text then the worker's undo with the body open", async () => {
		const ops: DeckOp[] = []
		const undos: (ShapeRef | undefined)[] = []
		const frame = frameWithLayers()
		const editing = createTextEditing()
		const { root } = await mountEditor(frame, { session: fakeSession(ops, undos), editing })

		const controller = editing.active

		expect(controller).toBeDefined()
		controller?.setSelection(3)

		const sink = frame.querySelector(".fo-text-sink.ProseMirror") as HTMLElement

		key(sink, { key: "Enter" })
		expect(controller?.body.paragraphs.map(paragraph => paragraph.runs.map(run => ("text" in run ? run.text : "")).join(""))).toEqual([
			"He",
			"llo"
		])

		key(sink, { key: "z", code: "KeyZ", ctrlKey: true })
		await flushAll()
		await flushAll()

		expect(ops.map(op => op.kind)).toEqual(["setText"])
		expect(undos).toEqual([SHAPE])
		// The worker's seed is the body again.
		expect(editing.active?.state.doc.textContent).toBe("Hello")

		await act(async () => {
			root.unmount()
		})
	})

	it("a composition over a selection first deletes the selection, as typing over it does", async () => {
		const frame = frameWithLayers()
		const editing = createTextEditing()
		const { root } = await mountEditor(frame, { editing })

		editing.active?.setSelection(2, 5)

		const sink = frame.querySelector(".fo-text-sink.ProseMirror") as HTMLElement

		sink.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }))

		expect(editing.active?.state.doc.textContent).toBe("Ho")

		await act(async () => {
			root.unmount()
		})
	})

	it("draws the caret in the colour of the text at it, not black", async () => {
		const white = { kind: "solid", color: { kind: "srgb", rgb: "FFFFFF" } } as const
		const red = { kind: "solid", color: { kind: "srgb", rgb: "FF0000" } } as const
		const theme = { kind: "solid", color: { kind: "scheme", slot: "tx1" } } as const
		const body: TextBody = {
			bodyPr: {},
			paragraphs: [
				{
					pPr: {},
					runs: [
						{ kind: "r", text: "White", rPr: { fill: white } },
						{ kind: "r", text: "Red", rPr: { fill: red } },
						{ kind: "r", text: "Theme", rPr: { fill: theme } }
					]
				},
				{ pPr: {}, runs: [{ kind: "r", text: "Plain", rPr: {} }] },
				{ pPr: {}, runs: [] }
			]
		}
		const seed: TextSeed = {
			shape: SHAPE,
			revision: 1,
			body,
			resolved: [
				{ pPr: {}, runs: [{}, {}, {}] },
				{ pPr: {}, runs: [{}] },
				{ pPr: {}, runs: [] }
			],
			...laid(body),
			matrix: [1, 0, 0, 1, 0, 0]
		}
		const session = { ...fakeSession([], []), textSeed: () => Promise.resolve(seed) } as PresentationSessionApi
		const frame = frameWithLayers()
		const editing = createTextEditing()
		const { root } = await mountEditor(frame, { session, editing })

		const caretAt = (pos: number): string => {
			editing.active?.setSelection(pos)

			return (frame.querySelector(".fo-text-caret") as HTMLElement).style.background.replace(/\s/gu, "").toLowerCase()
		}
		const colors = (hex: string): string[] => [
			`#${hex.toLowerCase()}`,
			`rgb(${[0, 2, 4].map(at => String(parseInt(hex.slice(at, at + 2), 16))).join(",")})`
		]

		// Inside the white run, and at the start of the body (the run after the caret).
		expect(colors("FFFFFF")).toContain(caretAt(3))
		expect(colors("FFFFFF")).toContain(caretAt(1))
		// It follows the caret into a run of another colour.
		expect(colors("FF0000")).toContain(caretAt(8))
		// A theme colour: the colour the worker painted the run in.
		expect(colors(THEME_TEXT)).toContain(caretAt(13))
		// No colour of its own: the body's default text colour as painted.
		expect(colors(THEME_TEXT)).toContain(caretAt(21))
		// An empty paragraph: the body's default text colour too.
		expect(colors(THEME_TEXT)).toContain(caretAt(24))

		await act(async () => {
			root.unmount()
		})
	})
	it("a finger or a pen dragging across a line selects the range, the pointer captured on the box", async () => {
		const frame = frameWithLayers()
		const session = { ...fakeSession([], []), textSeed: () => Promise.resolve(seedOf("Hello world")) } as PresentationSessionApi
		const { root, editing } = await mountEditor(frame, { session })
		const box = frame.querySelector(".fo-text-edit-box") as HTMLElement
		const pointer = (type: string, pos: number, init: PointerEventInit = {}): void => {
			box.dispatchEvent(
				new PointerEvent(type, {
					bubbles: true,
					cancelable: true,
					pointerId: 5,
					pointerType: "touch",
					isPrimary: true,
					button: type === "pointermove" ? -1 : 0,
					...clientAt(editing, pos),
					...init
				})
			)
		}

		// The body takes no touch panning while open: the page neither scrolls nor zooms under the drag.
		expect(box.style.touchAction).toBe("none")

		pointer("pointerdown", 2)
		expect(selected(editing)).toEqual([2, 2])
		expect(box.hasPointerCapture(5)).toBe(true)

		pointer("pointermove", 5)
		expect(selected(editing)).toEqual([2, 5])

		// Another finger does not move the range.
		pointer("pointermove", 9, { pointerId: 6, isPrimary: false })
		expect(selected(editing)).toEqual([2, 5])

		pointer("pointerup", 5)
		pointer("pointermove", 9)
		expect(selected(editing)).toEqual([2, 5])

		// A pen, its compatibility mouse press arriving while it drags: the pen places the selection.
		pointer("pointerdown", 3, { pointerId: 7, pointerType: "pen" })
		box.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1, ...clientAt(editing, 3) }))
		pointer("pointermove", 10, { pointerId: 7, pointerType: "pen" })
		document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ...clientAt(editing, 8) }))
		expect(selected(editing)).toEqual([3, 10])
		pointer("pointerup", 10, { pointerId: 7, pointerType: "pen" })
		document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))

		// A pen's double tap selects the word, and the rest of that contact does not drag it away.
		const penTap = (pos: number, detail: number, id: number): void => {
			pointer("pointerdown", pos, { pointerId: id, pointerType: "pen" })
			box.dispatchEvent(
				new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail, ...clientAt(editing, pos) })
			)
			pointer("pointermove", pos + 1, { pointerId: id, pointerType: "pen" })
		}

		penTap(8, 2, 8)
		expect(selected(editing)).toEqual([7, 12])
		pointer("pointerup", 9, { pointerId: 8, pointerType: "pen" })

		// A triple tap: the paragraph stays selected.
		penTap(3, 3, 9)
		expect(selected(editing)).toEqual([1, 12])
		pointer("pointerup", 4, { pointerId: 9, pointerType: "pen" })

		// A finger whose up never reached the box does not hold the drag: the next finger and the mouse drag again.
		pointer("pointerdown", 2, { pointerId: 10 })
		pointer("pointerdown", 4, { pointerId: 11 })
		pointer("pointermove", 6, { pointerId: 11 })
		expect(selected(editing)).toEqual([4, 6])
		pointer("pointermove", 9, { pointerId: 10 })
		expect(selected(editing)).toEqual([4, 6])

		box.dispatchEvent(
			new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0 })
		)
		box.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1, ...clientAt(editing, 2) }))
		document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ...clientAt(editing, 5) }))
		document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
		expect(selected(editing)).toEqual([2, 5])

		await act(async () => {
			root.unmount()
		})
	})

	it("the mouse places the caret, drags a range, and selects a word on a double click and a paragraph on a triple", async () => {
		const frame = frameWithLayers()
		const session = { ...fakeSession([], []), textSeed: () => Promise.resolve(seedOf("Hello world")) } as PresentationSessionApi
		const { root, editing } = await mountEditor(frame, { session })
		const box = frame.querySelector(".fo-text-edit-box") as HTMLElement
		const press = (pos: number, detail: number): MouseEvent => {
			const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail, ...clientAt(editing, pos) })

			box.dispatchEvent(event)

			return event
		}

		const opened = selected(editing)

		// The mouse's own pointer events leave the selection to its mouse events.
		box.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				pointerId: 1,
				pointerType: "mouse",
				isPrimary: true,
				button: 0,
				...clientAt(editing, 9)
			})
		)
		expect(selected(editing)).toEqual(opened)

		expect(press(2, 1).defaultPrevented).toBe(true)
		expect(selected(editing)).toEqual([2, 2])

		document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ...clientAt(editing, 5) }))
		expect(selected(editing)).toEqual([2, 5])

		document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
		document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, ...clientAt(editing, 9) }))
		expect(selected(editing)).toEqual([2, 5])

		press(8, 2)
		expect(selected(editing)).toEqual([7, 12])

		press(3, 3)
		expect(selected(editing)).toEqual([1, 12])

		await act(async () => {
			root.unmount()
		})
	})
})
