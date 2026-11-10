// @vitest-environment happy-dom
import { isMacPlatform } from "@filen/shared/keymap"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type ShapeLocks, type Xfrm } from "../core/presentation/model"
import type { SlideLayer, SlideRender } from "../core/presentation/output"
import type { CommandResult } from "../dom/presentation/protocol"
import type { ObjectKeyBindings } from "../react/presentation/edit/keyboard"
import { HIT_MARGIN_PX, ShapeEditLayer } from "../react/presentation/edit/overlay"
import { createShapeSelection, type ShapeSelection } from "../react/presentation/edit/selection"

// The canvas layer's pointer and keys against renders of plain boxes, at scale 1 (1 screen px = 1 slide px).

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
	duplicate: "mod+d",
	group: "mod+g",
	ungroup: "mod+shift+u",
	bringToFront: "mod+shift+]",
	sendToBack: "mod+shift+[",
	bringForward: "mod+]",
	sendBackward: "mod+["
}
// The app keymap's own Mac test, which the canvas reads.
const APPLE = isMacPlatform()
const MOD = APPLE ? { metaKey: true } : { ctrlKey: true }

interface Shape {
	readonly xfrm: Xfrm
	readonly role?: SlideLayer["role"]
	readonly locks?: ShapeLocks
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
					...(shape.locks === undefined ? {} : { locks: shape.locks }),
					...(shape.line === undefined ? {} : { line: shape.line })
				}
			}) as unknown as SlideLayer
	)

	return { ref, index: 0, revision: 1, hidden: false, background: {}, layers, notesText: "", animated: false } as unknown as SlideRender
}

let host: HTMLDivElement
let root: Root
let selection: ShapeSelection
let ops: DeckOp[]

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
				labels={{ canvas: "Slide editor", keys: "Press F6 to go to the ribbon.", describe: () => "" }}
				command={op => {
					ops.push(op)

					return Promise.resolve({ ok: true, revision: 1, dirty: true } as CommandResult)
				}}
			/>
		)
	})
	// The layer reaches past the slide by HIT_MARGIN_PX on every side, as it lies out in a page.
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

async function settle(): Promise<void> {
	await act(async () => {
		await Promise.resolve()
	})
}

const paths = (): string[] => [...layer().querySelectorAll("path")].map(path => path.getAttribute("d") ?? "")

beforeEach(() => {
	host = document.createElement("div")
	host.className = "fo-slide-frame"
	document.body.append(host)
	selection = createShapeSelection()
	ops = []
})

afterEach(() => {
	act(() => {
		root.unmount()
	})
	host.remove()
	vi.restoreAllMocks()
})

describe("the canvas layer's pointer", () => {
	it("Shift held from the press moves the selected shape along one axis and keeps it selected", async () => {
		mount([{ xfrm: box(100, 100, 200, 100) }])
		click(150, 150)
		pointer("pointerdown", 150, 150, { shiftKey: true })
		pointer("pointermove", 200, 155, { shiftKey: true })
		pointer("pointerup", 250, 160, { shiftKey: true })
		await settle()
		expect(selection.getSnapshot().ids).toEqual([2])
		expect(ops).toMatchObject([{ kind: "setXfrm", xfrm: { x: 200 * EMU, y: 100 * EMU } }])
	})

	it("Shift on a corner handle resizes with the proportions kept", async () => {
		mount([{ xfrm: box(100, 100, 200, 100) }])
		click(150, 150)
		pointer("pointerdown", 300, 200, { shiftKey: true })
		pointer("pointermove", 350, 210, { shiftKey: true })
		pointer("pointerup", 400, 210, { shiftKey: true })
		await settle()
		expect(ops).toMatchObject([{ kind: "setXfrm", xfrm: { cx: 300 * EMU, cy: 150 * EMU } }])
	})

	it("Shift+click on a selected shape, released without a drag, takes it out of the selection", () => {
		mount([{ xfrm: box(100, 100, 200, 100) }, { xfrm: box(400, 100, 100, 100) }])
		click(150, 150)
		click(450, 150, { shiftKey: true })
		expect(selection.getSnapshot().ids).toEqual([2, 3])
		click(150, 150, { shiftKey: true })
		expect(selection.getSnapshot().ids).toEqual([3])
	})

	it("a second pointer does not drive the first one's drag", async () => {
		mount([{ xfrm: box(100, 100, 200, 100) }])
		click(150, 150)
		pointer("pointerdown", 150, 150, { pointerType: "touch" })
		pointer("pointermove", 160, 150, { pointerType: "touch" })
		pointer("pointerdown", 800, 500, { pointerId: 2, pointerType: "touch" })
		pointer("pointermove", 820, 500, { pointerId: 2, pointerType: "touch" })
		pointer("pointerup", 820, 500, { pointerId: 2, pointerType: "touch" })
		pointer("pointerup", 170, 150, { pointerType: "touch" })
		await settle()
		expect(ops).toMatchObject([{ kind: "setXfrm", xfrm: { x: 120 * EMU } }])
	})

	it("the rotate handle of a shape at the slide's top edge, drawn above the slide, still turns it", async () => {
		mount([{ xfrm: box(100, 2, 200, 100) }])
		click(150, 50)
		// The knob sits 24 px above the top edge: at y = -22, outside the slide.
		pointer("pointerdown", 200, -22)
		pointer("pointermove", 400, 52)
		pointer("pointerup", 400, 52)
		await settle()
		expect(ops).toMatchObject([{ kind: "setXfrm", xfrm: { rot: 90 * 60000 } }])
	})

	it("a right click selects the shape under it, keeps a selection it lands in, and clears it on empty slide", () => {
		const menu = (x: number, y: number): void => {
			act(() => {
				layer().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y }))
			})
		}

		mount([{ xfrm: box(100, 100, 200, 100) }, { xfrm: box(400, 100, 100, 100) }])
		menu(450, 150)
		expect(selection.getSnapshot().ids).toEqual([3])
		click(150, 150, { shiftKey: true })
		menu(150, 150)
		expect(selection.getSnapshot().ids).toEqual([3, 2])
		// A corner handle of the selection, just outside its box, keeps it.
		menu(305, 205)
		expect(selection.getSnapshot().ids).toEqual([3, 2])
		menu(700, 400)
		expect(selection.getSnapshot().ids).toEqual([])
	})

	it("a secondary press neither selects nor starts a drag; the context menu event does the selecting", async () => {
		mount([{ xfrm: box(100, 100, 200, 100) }])
		pointer("pointerdown", 150, 150, { button: 2, pointerType: "mouse" })
		pointer("pointermove", 250, 150, { button: 2, pointerType: "mouse" })
		pointer("pointerup", 250, 150, { button: 2, pointerType: "mouse" })
		await settle()
		expect(selection.getSnapshot().ids).toEqual([])
		expect(ops).toEqual([])
	})

	it("Control+click on a Mac is the secondary click, not an additive press", () => {
		vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")
		mount([{ xfrm: box(100, 100, 200, 100) }, { xfrm: box(400, 100, 100, 100) }])
		click(150, 150)
		click(450, 150, { ctrlKey: true, pointerType: "mouse" })
		expect(selection.getSnapshot().ids).toEqual([2])
	})

	it("a press past the slide that misses every handle clears the selection, as empty canvas does", () => {
		mount([{ xfrm: box(100, 100, 200, 100) }])
		click(150, 150)
		click(500, -30)
		expect(selection.getSnapshot().ids).toEqual([])
	})
})

describe("the file's locks and lines on the canvas", () => {
	it("a shape locked against turning and resizing shows neither handle, and a drag on a corner moves nothing", async () => {
		mount([{ xfrm: box(100, 100, 200, 100), locks: { noRot: true, noResize: true, noMove: true } }])
		click(150, 150)

		const [, outline, rotate, handles] = paths()

		expect(outline).not.toBe("")
		expect(rotate).toBe("")
		expect(handles).toBe("")
		pointer("pointerdown", 300, 200)
		pointer("pointermove", 350, 250)
		pointer("pointerup", 350, 250)
		await settle()
		expect(ops).toEqual([])
	})

	it("a shape locked against selection is never selected by a click, the marquee or Select All", () => {
		mount([{ xfrm: box(100, 100, 200, 100), locks: { noSelect: true } }, { xfrm: box(400, 100, 100, 100) }])
		click(150, 150)
		expect(selection.getSnapshot().ids).toEqual([])
		pointer("pointerdown", 50, 50)
		pointer("pointermove", 600, 300)
		pointer("pointerup", 600, 300)
		expect(selection.getSnapshot().ids).toEqual([3])
		act(() => {
			layer().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a", code: "KeyA", ...MOD }))
		})
		expect(selection.getSnapshot().ids).toEqual([3])
	})

	it("a line shows a handle on each end and no rotate handle, and dragging an end moves only that end", async () => {
		mount([{ xfrm: box(100, 300, 400, 0), line: true }])
		click(300, 300)

		const [, outline, rotate] = paths()

		expect(outline).toBe("M100.0 300.0L500.0 300.0")
		expect(rotate).toBe("")
		pointer("pointerdown", 500, 300)
		pointer("pointermove", 500, 250)
		pointer("pointerup", 500, 200)
		await settle()
		expect(ops).toMatchObject([{ kind: "setXfrm", xfrm: { x: 100 * EMU, y: 200 * EMU, cx: 400 * EMU, cy: 100 * EMU, flipV: true } }])
	})
})

describe("the canvas layer's keys", () => {
	it("describes how to leave the canvas, since Tab moves between shapes", () => {
		mount([{ xfrm: box(100, 100, 200, 100) }])

		const described = layer().getAttribute("aria-describedby")

		expect(described).not.toBeNull()
		expect(host.ownerDocument.getElementById(described ?? "")?.textContent).toBe("Press F6 to go to the ribbon.")
	})

	it("ungroups every selected group as one op", async () => {
		mount([
			{ xfrm: box(100, 100, 200, 100), role: "group" },
			{ xfrm: box(400, 100, 200, 100), role: "group" }
		])
		act(() => {
			selection.set([2, 3])
		})
		act(() => {
			layer().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "U", code: "KeyU", shiftKey: true, ...MOD }))
		})
		await settle()
		expect(ops).toEqual([
			{
				family: "batch",
				kind: "batch",
				ops: [
					{ family: "shape", kind: "ungroup", slide: ref, group: 2 },
					{ family: "shape", kind: "ungroup", slide: ref, group: 3 }
				]
			}
		])
	})

	it("Mod+D duplicates the selected objects back to front and stops the key there (not the slide's)", async () => {
		mount([{ xfrm: box(100, 100, 200, 100) }, { xfrm: box(400, 100, 200, 100) }])
		act(() => {
			selection.set([3, 2])
		})

		const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "d", code: "KeyD", ...MOD })

		act(() => {
			layer().dispatchEvent(event)
		})
		await settle()
		expect(event.defaultPrevented).toBe(true)
		expect(ops).toEqual([{ family: "shape", kind: "duplicate", slide: ref, shapes: [2, 3], dx: 10 * EMU, dy: 10 * EMU }])
		// Compared at every level (the slide's is 0).
		expect(selection.getSnapshot().pending?.before).toEqual(new Set(["0:2", "0:3"]))
	})

	it("Ctrl+drag copies the selection to the drop and selects the copies; the originals stay", async () => {
		const COPY = APPLE ? { altKey: true } : { ctrlKey: true }

		mount([{ xfrm: box(100, 100, 200, 100) }, { xfrm: box(400, 100, 200, 100) }])
		act(() => {
			selection.set([3, 2])
		})
		pointer("pointerdown", 150, 150, COPY)
		pointer("pointermove", 200, 170, COPY)
		pointer("pointerup", 250, 190, COPY)
		await settle()
		expect(ops).toEqual([{ family: "shape", kind: "duplicate", slide: ref, shapes: [2, 3], dx: 100 * EMU, dy: 40 * EMU }])
		expect(selection.getSnapshot().pending?.before).toEqual(new Set(["0:2", "0:3"]))
		// The press on a selected shape with Ctrl became a drag: it does not leave the selection.
		expect(selection.getSnapshot().ids).toEqual([3, 2])
	})

	it("Ctrl pressed during a move drag shows the originals where they are and copies at the drop", async () => {
		mount([{ xfrm: box(100, 100, 200, 100) }])
		click(150, 150)
		pointer("pointerdown", 150, 150)
		pointer("pointermove", 200, 150)
		await vi.waitFor(() => {
			expect(host.querySelector<HTMLElement>("[data-fo-layer='0']")?.style.transform).not.toBe("")
		})
		act(() => {
			layer().dispatchEvent(
				new KeyboardEvent("keydown", {
					bubbles: true,
					key: APPLE ? "Alt" : "Control",
					...(APPLE ? { altKey: true } : { ctrlKey: true })
				})
			)
		})
		await vi.waitFor(() => {
			expect(host.querySelector<HTMLElement>("[data-fo-layer='0']")?.style.transform).toBe("")
		})
		pointer("pointerup", 200, 150, APPLE ? { altKey: true } : { ctrlKey: true })
		await settle()
		expect(ops).toMatchObject([{ kind: "duplicate", shapes: [2], dx: 50 * EMU, dy: 0 }])
	})

	it("Escape during a marquee hides it and keeps the release from selecting", async () => {
		mount([{ xfrm: box(100, 100, 200, 100) }])

		const marquee = (): SVGRectElement | null => layer().querySelector("rect")

		pointer("pointerdown", 50, 50)
		pointer("pointermove", 600, 300)
		await vi.waitFor(() => {
			expect(marquee()?.style.display).toBe("")
		})

		const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape", code: "Escape" })

		act(() => {
			layer().dispatchEvent(event)
		})
		expect(event.defaultPrevented).toBe(true)
		expect(marquee()?.style.display).toBe("none")
		pointer("pointermove", 650, 320)
		pointer("pointerup", 650, 320)
		await settle()
		expect(marquee()?.style.display).toBe("none")
		expect(selection.getSnapshot().ids).toEqual([])
		expect(ops).toEqual([])
	})

	it("Escape during a move drag puts the shape back and the release sends no op", async () => {
		mount([{ xfrm: box(100, 100, 200, 100) }])
		click(150, 150)

		const [, outline] = paths()
		const painted = (): string | undefined => host.querySelector<HTMLElement>("[data-fo-layer='0']")?.style.transform

		pointer("pointerdown", 150, 150)
		pointer("pointermove", 230, 190)
		await vi.waitFor(() => {
			expect(painted()).not.toBe("")
		})

		const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape", code: "Escape" })

		act(() => {
			layer().dispatchEvent(event)
		})
		expect(event.defaultPrevented).toBe(true)
		expect(painted()).toBe("")
		expect(paths()[0]).toBe("")
		expect(paths()[1]).toBe(outline)
		pointer("pointerup", 250, 200)
		await settle()
		expect(ops).toEqual([])
		expect(selection.getSnapshot().ids).toEqual([2])
	})

	it("Alt+Right turns the selection 15° clockwise, Alt+Left back; a shape locked against turning stays", async () => {
		mount([{ xfrm: box(100, 100, 200, 100) }, { xfrm: box(400, 100, 200, 100), locks: { noRot: true } }])
		act(() => {
			selection.set([2, 3])
		})
		act(() => {
			layer().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight", code: "ArrowRight", altKey: true }))
		})
		await settle()
		expect(ops).toEqual([
			{ family: "shape", kind: "setXfrm", target: { slide: ref, id: 2 }, xfrm: { ...box(100, 100, 200, 100), rot: 900_000 } }
		])
	})
})
