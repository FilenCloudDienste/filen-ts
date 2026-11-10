// @vitest-environment happy-dom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"
import { rgba } from "../core/drawingml/index"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type ShapeRef, type TextBody } from "../core/presentation/model"
import type { SlideRender, TextSeed } from "../core/presentation/output"
import { layoutBody } from "../core/presentation/text/body"
import { resolveBody } from "../core/presentation/text/resolve"
import { transferableLayout } from "../core/presentation/text/transfer"
import { MeasureCache } from "../core/text/index"
import type { CommandResult, PresentationSessionApi } from "../dom/presentation/protocol"
import { PresentationTextEditor } from "../react/presentation/edit/text/TextEditor"
import { createTextEditing } from "../react/presentation/edit/text/editing"
import { FakeMeasurer, testFont } from "./textFixtures"

// The editor view on a slide: it paints the worker's page under the text matrix, hides the slide's own painting of
// the shape while open, takes keys through its input sink (Enter splits, composition replaces a selection, Mod+Z is
// the worker's undo with the body open), and leaves on Escape with its text sent and the slide's text shown again.

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SHAPE: ShapeRef = { slide: slideRef(7), id: 3 }
const ENV = { fonts: { resolve: () => testFont() }, cache: new MeasureCache(new FakeMeasurer()) }

function laid(body: TextBody) {
	const result = layoutBody(
		resolveBody(body, { listStyles: [], bodyPr: [], fonts: { color: () => rgba("000000"), typeface: typeface => typeface } }),
		{ width: 300, height: 100 },
		ENV
	)

	return { page: result.page, layout: transferableLayout(result) }
}

function seedOf(text: string): TextSeed {
	const body: TextBody = { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] }

	return { shape: SHAPE, revision: 1, body, resolved: [{ pPr: {}, runs: [{}] }], ...laid(body), matrix: [1, 0, 0, 1, 40, 50] }
}

function fakeSession(ops: DeckOp[], undos: (ShapeRef | undefined)[]): PresentationSessionApi {
	return {
		textSeed: () => Promise.resolve(seedOf("Hello")),
		layoutText: (_shape: ShapeRef, body: TextBody) => Promise.resolve({ ...laid(body), revision: 2 }),
		command: (op: DeckOp): Promise<CommandResult> => {
			ops.push(op)

			return Promise.resolve({ ok: true, revision: ops.length + 1, dirty: true })
		},
		undo: (open?: ShapeRef): Promise<CommandResult> => {
			undos.push(open)

			return Promise.resolve({ ok: true, revision: 9, dirty: false, seed: seedOf("Hello") })
		}
	} as unknown as PresentationSessionApi
}

// A slide painted the way paintSlide marks it: layer 0 is the layout's, layer 1 the shape's own.
function frameWithLayers(): HTMLElement {
	const frame = document.createElement("div")

	frame.className = "fo-slide-frame"
	frame.innerHTML =
		'<div class="fo-slide-content"><div class="fo-slide-layer" data-fo-layer="0"><div class="fo-slide-text">layout</div></div>' +
		'<div class="fo-slide-layer" data-fo-layer="1"><div class="fo-slide-text">Hello</div></div></div>'
	document.body.append(frame)

	return frame
}

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

async function flushAll(): Promise<void> {
	await act(async () => {
		await new Promise(resolve => setTimeout(resolve, 0))
	})
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

		const root = createRoot(host)

		await act(async () => {
			root.render(
				<PresentationTextEditor
					session={fakeSession(ops, [])}
					shape={SHAPE}
					scale={0.5}
					editing={editing}
					labels={{ editor: "Slide text" }}
					render={RENDER}
					apple={false}
					measurer={new FakeMeasurer()}
					onExit={() => exits.push(1)}
					onRefused={() => undefined}
				/>
			)
		})
		await flushAll()

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
		const root = createRoot(frame)

		await act(async () => {
			root.render(
				<PresentationTextEditor
					session={fakeSession(ops, undos)}
					shape={SHAPE}
					scale={1}
					editing={editing}
					labels={{ editor: "Slide text" }}
					apple={false}
					measurer={new FakeMeasurer()}
					onExit={() => undefined}
					onRefused={() => undefined}
				/>
			)
		})
		await flushAll()

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
		const root = createRoot(frame)

		await act(async () => {
			root.render(
				<PresentationTextEditor
					session={fakeSession([], [])}
					shape={SHAPE}
					scale={1}
					editing={editing}
					labels={{ editor: "Slide text" }}
					apple={false}
					measurer={new FakeMeasurer()}
					onExit={() => undefined}
					onRefused={() => undefined}
				/>
			)
		})
		await flushAll()

		editing.active?.setSelection(2, 5)

		const sink = frame.querySelector(".fo-text-sink.ProseMirror") as HTMLElement

		sink.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }))

		expect(editing.active?.state.doc.textContent).toBe("Ho")

		await act(async () => {
			root.unmount()
		})
	})
})
