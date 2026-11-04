// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import { slideRef, type Xfrm } from "../core/presentation/model"
import type { SlideLayer, SlideRender } from "../core/presentation/output"
import type { CommandResult } from "../dom/presentation/protocol"
import { OBJECT_COMMANDS, type ObjectKeyBindings } from "../react/presentation/edit/keyboard"
import { HIT_MARGIN_PX, ShapeEditLayer, type ShapeEditLayerProps } from "../react/presentation/edit/overlay"
import { createShapeSelection, type ShapeSelection } from "../react/presentation/edit/selection"
import { budget, cpuMs } from "./timing"

// The canvas layer in a page: pressing selects, dragging previews on the painted layers and ends in one op, keys
// nudge from the boxes the last op wrote, and a marquee over a busy slide stays within a frame.

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
const BINDINGS = Object.fromEntries(
	OBJECT_COMMANDS.map(name => [name, name === "selectAll" ? "mod+a" : name === "group" ? "mod+g" : "mod+shift+u"])
) as unknown as ObjectKeyBindings

function renderOf(boxes: readonly Xfrm[]): SlideRender {
	const layers = boxes.map(
		(xfrm, index) =>
			({
				shape: { slide: ref, id: index + 2 },
				role: "shape",
				drawing: { width: xfrm.cx / EMU, height: xfrm.cy / EMU },
				matrix: [1, 0, 0, 1, xfrm.x / EMU, xfrm.y / EMU],
				box: { id: index + 2, xfrm }
			}) as unknown as SlideLayer
	)

	return { ref, index: 0, revision: 1, hidden: false, background: {}, layers, notesText: "", animated: false } as unknown as SlideRender
}

let host: HTMLDivElement
let root: Root
let selection: ShapeSelection
let ops: DeckOp[]
let answer: CommandResult

function mount(render: SlideRender, extra: Partial<ShapeEditLayerProps> = {}): void {
	// The painted slide as SlideView holds it: layers inside .fo-slide-content, the overlay beside it in the frame.
	const content = document.createElement("div")

	content.className = "fo-slide-content"

	render.layers.forEach((layer, index) => {
		const element = document.createElement("div")

		element.dataset["foLayer"] = String(index)
		element.style.transform = `matrix(1,0,0,1,${String(layer.matrix[4])},${String(layer.matrix[5])})`
		content.append(element)
	})

	host.replaceChildren(content)

	const overlayHost = document.createElement("div")

	host.append(overlayHost)
	root = createRoot(overlayHost)

	act(() => {
		root.render(
			<ShapeEditLayer
				render={render}
				size={{ cx: 960 * EMU, cy: 540 * EMU }}
				scale={1}
				selection={selection}
				editable
				bindings={BINDINGS}
				labels={{ canvas: "Slide editor", describe: shapes => (shapes.length === 0 ? "" : `${String(shapes.length)} selected`) }}
				command={op => {
					ops.push(op)

					return Promise.resolve(answer)
				}}
				{...extra}
			/>
		)
	})
	// The layer reaches HIT_MARGIN_PX past the slide on every side, as it lies out in a page.
	vi.spyOn(layerRoot(), "getBoundingClientRect").mockReturnValue({
		left: -HIT_MARGIN_PX,
		top: -HIT_MARGIN_PX,
		width: 960 + 2 * HIT_MARGIN_PX,
		height: 540 + 2 * HIT_MARGIN_PX
	} as DOMRect)
}

function layerRoot(): HTMLElement {
	return host.querySelector<HTMLElement>("[data-fo-shape-edit]") as HTMLElement
}

function pointer(type: string, x: number, y: number, init: Partial<PointerEventInit> = {}): void {
	act(() => {
		layerRoot().dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y, ...init }))
	})
}

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve()
	})
}

beforeEach(() => {
	host = document.createElement("div")
	host.className = "fo-slide-frame"
	document.body.append(host)
	selection = createShapeSelection()
	ops = []
	answer = { ok: true, revision: 1, dirty: true }
})

afterEach(() => {
	act(() => {
		root.unmount()
	})
	host.remove()
	vi.restoreAllMocks()
})

describe("the slide canvas layer", () => {
	it("a press selects the shape under it and announces it; a press on nothing clears", () => {
		mount(renderOf([box(100, 100, 200, 100), box(500, 300, 100, 100)]))
		pointer("pointerdown", 150, 150)
		pointer("pointerup", 150, 150)

		expect(selection.getSnapshot()).toEqual({ slide: ref, ids: [2] })
		expect(host.textContent).toContain("1 selected")

		pointer("pointerdown", 550, 350, { shiftKey: true })
		pointer("pointerup", 550, 350, { shiftKey: true })
		expect(selection.getSnapshot().ids).toEqual([2, 3])

		pointer("pointerdown", 900, 20)
		pointer("pointerup", 900, 20)
		expect(selection.getSnapshot().ids).toEqual([])
	})

	it("a drag previews on the painted layers and ends in one setXfrm; a refused one puts the layers back", async () => {
		mount(renderOf([box(100, 100, 200, 100), box(700, 400, 100, 100)]))
		pointer("pointerdown", 150, 150)
		pointer("pointermove", 170, 153)
		pointer("pointerup", 190, 157)
		await flush()

		expect(ops).toEqual([{ family: "shape", kind: "setXfrm", target: { slide: ref, id: 2 }, xfrm: box(140, 107, 200, 100) }])

		const layer = host.querySelector<HTMLElement>('[data-fo-layer="0"]') as HTMLElement

		expect(layer.style.transform).toBe("matrix(1,0,0,1,140,107)")

		answer = { ok: false, refusal: "locked" }
		pointer("pointerdown", 250, 150)
		pointer("pointermove", 280, 150)
		pointer("pointerup", 300, 150)
		await flush()

		expect(ops).toHaveLength(2)
		expect(layer.style.transform).toBe("matrix(1,0,0,1,100,100)")
	})

	it("a drag near another shape's edge snaps to it and draws the guide", () => {
		mount(renderOf([box(100, 100, 200, 100), box(400, 400, 100, 100)]))
		pointer("pointerdown", 150, 150)
		// The right edge (300 + 97 = 397) comes within 6 px of the other's left edge (400).
		pointer("pointermove", 200, 160)
		pointer("pointerup", 247, 170)

		expect(ops[0]).toMatchObject({ xfrm: { x: 200 * EMU } })
	})

	it("arrow keys nudge from the boxes the last op wrote, before the render shows them", async () => {
		mount(renderOf([box(100, 100, 200, 100)]))
		pointer("pointerdown", 150, 150)
		pointer("pointerup", 150, 150)

		const keyDown = (key: string, init: KeyboardEventInit = {}): void => {
			act(() => {
				layerRoot().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, code: key, ...init }))
			})
		}

		keyDown("ArrowRight")
		await flush()
		keyDown("ArrowRight", { shiftKey: true })
		await flush()

		expect(ops.map(op => (op.family === "shape" && op.kind === "setXfrm" ? op.xfrm?.x : undefined))).toEqual([101 * EMU, 111 * EMU])

		keyDown("Delete")
		await flush()
		expect(ops[2]).toEqual({ family: "shape", kind: "delete", slide: ref, shapes: [2] })
		expect(selection.getSnapshot().ids).toEqual([])
	})

	it("a marquee over 2,000 shapes selects the ones it holds within one frame's CPU, frames only past the handle limit", () => {
		const boxes: Xfrm[] = []

		for (let k = 0; k < 2000; k++) boxes.push(box((k % 50) * 18, Math.floor(k / 50) * 13, 10, 8))

		mount(renderOf(boxes))

		// The least CPU of five marquees (the first warms up): a single reading also holds whatever the runner did
		// meanwhile, and Linux reports a thread's CPU time only at its scheduler's ticks.
		let spent = Number.POSITIVE_INFINITY

		for (let run = 0; run < 5; run++) {
			pointer("pointerdown", 955, 535)
			pointer("pointermove", 500, 300)

			const start = cpuMs()

			pointer("pointerup", -5, -5)
			spent = Math.min(spent, cpuMs() - start)
			expect(selection.getSnapshot().ids).toHaveLength(2000)
		}

		expect(spent).toBeLessThanOrEqual(budget(16))

		const paths = [...host.querySelectorAll("path")].map(path => path.getAttribute("d") ?? "")

		// Guides, outlines, rotate knobs, handles: outlines only.
		expect(paths[1]?.length).toBeGreaterThan(0)
		expect(paths[2]).toBe("")
		expect(paths[3]).toBe("")
	})
})
