// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type ShapeRef, type TextBody, type Xfrm } from "../core/presentation/model"
import type { ShapeBodyKind, SlideLayer, SlideRender, TextSeed } from "../core/presentation/output"
import type { CommandResult } from "../dom/presentation/protocol"
import type { ObjectKeyBindings } from "../react/presentation/edit/keyboard"
import { HIT_MARGIN_PX, ShapeEditLayer } from "../react/presentation/edit/overlay"
import { createShapeSelection, type ShapeSelection } from "../react/presentation/edit/selection"
import { createTextEditing, type TextEditing } from "../react/presentation/edit/text/editing"

// The canvas layer and the shapes' text: which shapes a click, a double-click, Enter or a typed key opens (PowerPoint
// opens no text in a picture, a group, a chart or a line, and reports no error for one), the formatting keys on shapes
// selected as objects, Escape during a marquee, and a refused group. Scale 1 (1 screen px = 1 slide px).

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const EMU = 9525
const ref = slideRef(256)
const box = (x: number, y: number, cx: number, cy: number): Xfrm => ({
	x: x * EMU,
	y: y * EMU,
	cx: cx * EMU,
	cy: cy * EMU,
	rot: 0,
	flipH: false,
	flipV: false
})
const BINDINGS: ObjectKeyBindings = {
	selectAll: "mod+a",
	group: "mod+g",
	ungroup: "mod+shift+u",
	bringToFront: "mod+shift+]",
	sendToBack: "mod+shift+[",
	bringForward: "mod+]",
	sendBackward: "mod+["
}
const APPLE = /Mac|iPhone|iPad/u.test(String(Reflect.get(globalThis.navigator, "platform")))
const MOD = APPLE ? { metaKey: true } : { ctrlKey: true }

interface Shape {
	readonly xfrm: Xfrm
	readonly role?: SlideLayer["role"]
	readonly body?: ShapeBodyKind
	readonly line?: true
}

function renderOf(shapes: readonly Shape[]): SlideRender {
	const layers = shapes.map(
		(shape, index) =>
			({
				shape: { slide: ref, id: index + 2 },
				role: shape.role ?? "shape",
				drawing: { width: shape.xfrm.cx / EMU, height: shape.xfrm.cy / EMU },
				matrix: [1, 0, 0, 1, shape.xfrm.x / EMU, shape.xfrm.y / EMU],
				box: {
					id: index + 2,
					xfrm: shape.xfrm,
					...(shape.body === undefined ? {} : { body: shape.body }),
					...(shape.line === undefined ? {} : { line: shape.line })
				}
			}) as unknown as SlideLayer
	)

	return { ref, index: 0, revision: 1, hidden: false, background: {}, layers, notesText: "", animated: false } as unknown as SlideRender
}

function seedOf(shape: ShapeRef, text: string): TextSeed {
	const body: TextBody = { bodyPr: {}, paragraphs: [{ pPr: {}, runs: [{ kind: "r", text, rPr: {} }] }] }

	return { shape, revision: 1, body, resolved: [{ pPr: {}, runs: [{}] }], matrix: [1, 0, 0, 1, 0, 0] } as unknown as TextSeed
}

let host: HTMLDivElement
let root: Root
let selection: ShapeSelection
let editing: TextEditing
let ops: DeckOp[]
let entered: { shape: ShapeRef; at: { x: number; y: number } | undefined }[]
let answer: CommandResult

function mount(shapes: readonly Shape[]): void {
	const content = document.createElement("div")
	const overlay = document.createElement("div")
	const render = renderOf(shapes)

	content.className = "fo-slide-content"
	render.layers.forEach((_layer, index) => {
		const element = document.createElement("div")

		element.dataset["foLayer"] = String(index)
		content.append(element)
	})
	host.replaceChildren(content, overlay)
	root = createRoot(overlay)
	act(() => {
		root.render(
			<ShapeEditLayer
				render={render}
				size={{ cx: 960 * EMU, cy: 540 * EMU }}
				scale={1}
				selection={selection}
				editable
				bindings={BINDINGS}
				labels={{ canvas: "Slide editor", describe: () => "" }}
				command={op => {
					ops.push(op)

					return Promise.resolve(answer)
				}}
				onEnterText={(shape, at) => entered.push({ shape, at })}
				text={{ editing, session: { textSeed: shape => Promise.resolve(seedOf(shape, "Title")) } }}
			/>
		)
	})
	vi.spyOn(layer(), "getBoundingClientRect").mockReturnValue({
		left: -HIT_MARGIN_PX,
		top: -HIT_MARGIN_PX,
		width: 960 + 2 * HIT_MARGIN_PX,
		height: 540 + 2 * HIT_MARGIN_PX
	} as DOMRect)
}

const layer = (): HTMLElement => host.querySelector<HTMLElement>("[data-fo-shape-edit]") as HTMLElement

function pointer(type: string, x: number, y: number, init: Partial<PointerEventInit> = {}): void {
	act(() => {
		layer().dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y, ...init }))
	})
}

function click(x: number, y: number, init: Partial<PointerEventInit> = {}): void {
	pointer("pointerdown", x, y, init)
	pointer("pointerup", x, y, init)
}

function doubleClick(x: number, y: number): void {
	act(() => {
		layer().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: x, clientY: y }))
	})
}

function key(init: KeyboardEventInit): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })

	act(() => {
		layer().dispatchEvent(event)
	})

	return event
}

async function settle(): Promise<void> {
	for (let k = 0; k < 5; k++) {
		await act(async () => {
			await Promise.resolve()
		})
	}
}

beforeEach(() => {
	host = document.createElement("div")
	host.className = "fo-slide-frame"
	document.body.append(host)
	selection = createShapeSelection()
	editing = createTextEditing()
	ops = []
	entered = []
	answer = { ok: true, revision: 1, dirty: true } as CommandResult
})

afterEach(() => {
	editing.drop()
	act(() => {
		root.unmount()
	})
	host.remove()
	vi.restoreAllMocks()
})

describe("which shapes open their text", () => {
	it("a double-click or Enter on a picture, a group, a chart or a line opens nothing", () => {
		mount([
			{ xfrm: box(0, 0, 100, 100), role: "picture" },
			{ xfrm: box(200, 0, 100, 100), role: "group" },
			{ xfrm: box(400, 0, 100, 100), role: "chart" },
			{ xfrm: box(600, 50, 200, 0), body: "shape", line: true }
		])

		for (const [x, y] of [
			[50, 50],
			[250, 50],
			[450, 50],
			[700, 50]
		] as const) {
			doubleClick(x, y)
			click(x, y)
			key({ key: "Enter", code: "Enter" })
		}

		expect(entered).toEqual([])
	})

	it("a double-click or Enter on a shape with a body opens it", () => {
		mount([{ xfrm: box(100, 100, 200, 100), body: "shape" }])
		doubleClick(150, 150)
		click(150, 150)
		key({ key: "Enter", code: "Enter" })
		expect(entered).toEqual([
			{ shape: { slide: ref, id: 2 }, at: { x: 150, y: 150 } },
			{ shape: { slide: ref, id: 2 }, at: undefined }
		])
	})

	it("a click puts the caret in a placeholder or text box where it lands, and only selects another shape", () => {
		mount([
			{ xfrm: box(100, 100, 200, 100), role: "placeholder", body: "placeholder" },
			{ xfrm: box(400, 100, 200, 100), body: "textBox" },
			{ xfrm: box(100, 300, 200, 100), body: "shape" }
		])
		click(150, 120)
		click(450, 130)
		click(150, 350)
		expect(entered).toEqual([
			{ shape: { slide: ref, id: 2 }, at: { x: 150, y: 120 } },
			{ shape: { slide: ref, id: 3 }, at: { x: 450, y: 130 } }
		])
		expect(selection.getSnapshot().ids).toEqual([4])
	})

	it("a drag on a placeholder moves it and opens nothing; a click in a selection of several keeps it", async () => {
		mount([
			{ xfrm: box(100, 100, 200, 100), body: "placeholder" },
			{ xfrm: box(400, 100, 200, 100), body: "textBox" }
		])
		pointer("pointerdown", 150, 150)
		pointer("pointermove", 200, 150)
		pointer("pointerup", 250, 150)
		await settle()
		expect(ops).toMatchObject([{ kind: "setXfrm" }])
		act(() => {
			selection.set([2, 3])
		})
		click(450, 150)
		expect(entered).toEqual([])
		expect(selection.getSnapshot().ids).toEqual([2, 3])
	})

	it("a character typed on a selected shape opens its body and is held for it, in order with what follows", () => {
		mount([{ xfrm: box(100, 100, 200, 100), body: "shape" }])
		click(150, 150)
		layer().focus()

		const typed = key({ key: "H", code: "KeyH", shiftKey: true })

		expect(typed.defaultPrevented).toBe(true)
		expect(entered).toEqual([{ shape: { slide: ref, id: 2 }, at: undefined }])
		key({ key: "i", code: "KeyI" })
		expect([...editing.take()]).toEqual([{ kind: "text", text: "Hi" }])
	})

	it("a character typed on a picture or on several shapes opens nothing", () => {
		mount([
			{ xfrm: box(100, 100, 200, 100), role: "picture" },
			{ xfrm: box(400, 100, 200, 100), body: "shape" }
		])
		click(150, 150)
		key({ key: "x", code: "KeyX" })
		act(() => {
			selection.set([2, 3])
		})
		key({ key: "x", code: "KeyX" })
		expect(entered).toEqual([])
	})
})

describe("the formatting keys on shapes selected as objects", () => {
	it("Mod+B bolds the whole text of every selected shape with a body, as one op", async () => {
		mount([
			{ xfrm: box(100, 100, 200, 100), body: "placeholder" },
			{ xfrm: box(400, 100, 200, 100), body: "shape" },
			{ xfrm: box(100, 300, 200, 100), role: "picture" }
		])
		act(() => {
			selection.set([2, 3, 4])
		})

		const pressed = key({ key: "b", code: "KeyB", ...MOD })

		expect(pressed.defaultPrevented).toBe(true)
		await settle()
		expect(ops).toHaveLength(1)
		expect(ops[0]).toMatchObject({
			family: "batch",
			ops: [
				{
					family: "text",
					kind: "setText",
					target: { id: 2 },
					body: { paragraphs: [{ runs: [{ text: "Title", rPr: { b: true } }] }] }
				},
				{
					family: "text",
					kind: "setText",
					target: { id: 3 },
					body: { paragraphs: [{ runs: [{ text: "Title", rPr: { b: true } }] }] }
				}
			]
		})
		expect(entered).toEqual([])
	})

	it("an object binding wins where the keys collide, and a non-formatting body key does nothing", async () => {
		mount([{ xfrm: box(100, 100, 200, 100), body: "shape" }])
		click(150, 150)
		key({ key: "a", code: "KeyA", ...MOD })
		key({ key: "Enter", code: "Enter", shiftKey: true })
		await settle()
		expect(ops).toEqual([])
	})
})

describe("Escape and refusals", () => {
	it("Escape during a marquee takes the marquee off the slide", () => {
		mount([{ xfrm: box(100, 100, 200, 100) }])
		pointer("pointerdown", 50, 50)
		pointer("pointermove", 400, 300)

		return new Promise<void>(resolve => {
			requestAnimationFrame(() => {
				const rect = layer().querySelector("rect") as SVGRectElement

				expect(rect.style.display).toBe("")
				key({ key: "Escape", code: "Escape" })
				expect(rect.style.display).toBe("none")
				pointer("pointerup", 400, 300)
				expect(rect.style.display).toBe("none")
				expect(selection.getSnapshot().ids).toEqual([])
				resolve()
			})
		})
	})

	it("a refused group leaves the selection as it was, with nothing waiting to select a later shape", async () => {
		mount([{ xfrm: box(100, 100, 100, 100) }, { xfrm: box(300, 100, 100, 100) }])
		answer = { ok: false, refusal: "locked" } as CommandResult
		act(() => {
			selection.set([2, 3])
		})
		key({ key: "g", code: "KeyG", ...MOD })
		await settle()
		expect(ops).toHaveLength(1)
		expect(selection.getSnapshot()).toEqual({ slide: ref, ids: [2, 3] })
	})
})
