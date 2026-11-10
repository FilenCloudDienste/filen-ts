// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DeckOp } from "../core/presentation/edit/ops"
import { shownThrough } from "../core/presentation/groupSpace"
import { slideRef, type ShapeRef, type Xfrm } from "../core/presentation/model"
import type { GroupMember, SlideLayer, SlideRender } from "../core/presentation/output"
import type { CommandResult } from "../dom/presentation/protocol"
import type { ObjectKeyBindings } from "../react/presentation/edit/keyboard"
import { HIT_MARGIN_PX, ShapeEditLayer } from "../react/presentation/edit/overlay"
import {
	clickTarget,
	createShapeSelection,
	hitPath,
	placements,
	selectedShapes,
	type ShapeSelection
} from "../react/presentation/edit/selection"

// Selecting and editing shapes inside a group on the canvas, as PowerPoint: the first click selects the group, a click
// on it once selected selects the member under it (the group framed dashed), Escape goes back to the group, Tab goes
// round its members, and a member's moves are written in the group's child space. Scale 1 (1 screen px = 1 slide px).

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const EMU = 9525
const ref = slideRef(256)
const box = (x: number, y: number, cx: number, cy: number, extra: Partial<Xfrm> = {}): Xfrm => ({
	x: x * EMU,
	y: y * EMU,
	cx: cx * EMU,
	cy: cy * EMU,
	rot: 0,
	flipH: false,
	flipV: false,
	...extra
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
const APPLE = /Mac|iPhone|iPad/u.test(String(Reflect.get(globalThis.navigator, "platform")))
const MOD = APPLE ? { metaKey: true } : { ctrlKey: true }

// The group: 500×100 px at (100, 100), its child space half as wide (scaled 2× along x).
const GROUP = box(100, 100, 500, 100, { chX: 0, chY: 0, chCx: 250 * EMU, chCy: 100 * EMU })

function member(id: number, own: Xfrm, extra: Pick<GroupMember, "body" | "locks"> = {}): GroupMember {
	return { id, role: "shape", own, xfrm: shownThrough([GROUP], own), ...extra }
}

// A shape behind the group (id 5, under the gap between the members), the group (id 2) holding members 3 and 4 (and
// 6, locked against selection, over member 4's right half).
function renderOf(locked = false): SlideRender {
	const members = [
		member(3, box(0, 0, 100, 100), { body: "textBox" }),
		member(4, box(150, 0, 100, 100)),
		...(locked ? [member(6, box(200, 0, 50, 100), { locks: { noSelect: true } })] : [])
	]
	const layers = [
		{
			shape: { slide: ref, id: 5 },
			role: "shape",
			drawing: { width: 100, height: 300 },
			matrix: [1, 0, 0, 1, 300, 50],
			box: { id: 5, xfrm: box(300, 50, 100, 300) }
		},
		{
			shape: { slide: ref, id: 2 },
			role: "group",
			drawing: { width: 500, height: 100 },
			matrix: [1, 0, 0, 1, 100, 100],
			box: { id: 2, xfrm: GROUP, members }
		}
	] as unknown as SlideLayer[]

	return { ref, index: 0, revision: 1, hidden: false, background: {}, layers, notesText: "", animated: false } as unknown as SlideRender
}

let host: HTMLDivElement
let root: Root
let selection: ShapeSelection
let ops: DeckOp[]
let entered: ShapeRef[]

function mount(render: SlideRender = renderOf()): void {
	const content = document.createElement("div")
	const overlay = document.createElement("div")

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

					return Promise.resolve({ ok: true, revision: 1, dirty: true } as CommandResult)
				}}
				onEnterText={shape => {
					entered.push(shape)
				}}
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
const groupFrame = (): string => host.querySelector("[data-fo-group-frame]")?.getAttribute("d") ?? ""

function pointer(type: string, x: number, y: number, init: Partial<PointerEventInit> = {}): void {
	act(() => {
		layer().dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y, ...init }))
	})
}

function click(x: number, y: number, init: Partial<PointerEventInit> = {}): void {
	pointer("pointerdown", x, y, init)
	pointer("pointerup", x, y, init)
}

function key(init: KeyboardEventInit): void {
	act(() => {
		layer().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }))
	})
}

async function settle(): Promise<void> {
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
	entered = []
})

afterEach(() => {
	act(() => {
		root.unmount()
	})
	host.remove()
	vi.restoreAllMocks()
})

describe("what a click selects in a group", () => {
	it("the group first, then the member under a second click, framing the group dashed", () => {
		mount()
		click(450, 150)
		expect(selection.getSnapshot().ids).toEqual([2])
		expect(groupFrame()).toBe("")

		click(450, 150)
		expect(selection.getSnapshot().ids).toEqual([4])
		expect(groupFrame()).toBe("M100.0 100.0L600.0 100.0L600.0 200.0L100.0 200.0Z")
	})

	it("another member of the open group at once; a text box member's second click puts the caret in", () => {
		mount()
		click(450, 150)
		click(450, 150)
		click(150, 150)
		expect(selection.getSnapshot().ids).toEqual([3])
		expect(entered).toEqual([{ slide: ref, id: 3 }])
	})

	it("goes through the empty space between members to the shape behind", () => {
		mount()
		click(350, 150)
		expect(selection.getSnapshot().ids).toEqual([5])
	})

	it("passes over a member locked against selection to the one behind it", () => {
		const render = renderOf(true)

		expect(hitPath(render, { x: 550 * EMU, y: 150 * EMU }, 0).map(shape => shape.id)).toEqual([2, 4])
		expect(clickTarget(render, [2], { x: 550 * EMU, y: 150 * EMU }, 0)).toMatchObject({ shape: { id: 2 }, into: { id: 4 } })
		expect(clickTarget(render, [3], { x: 550 * EMU, y: 150 * EMU }, 0)?.shape.id).toBe(4)
		expect(clickTarget(render, [3], { x: 350 * EMU, y: 75 * EMU }, 0)?.shape.id).toBe(5)
	})

	it("a drag from a selected group moves the group, not its member", async () => {
		mount()
		click(450, 150)
		pointer("pointerdown", 450, 150)
		pointer("pointermove", 470, 150)
		pointer("pointerup", 490, 150)
		await settle()
		expect(selection.getSnapshot().ids).toEqual([2])
		expect(ops).toMatchObject([{ kind: "setXfrm", target: { id: 2 }, xfrm: { x: 140 * EMU, chX: 0, chCx: 250 * EMU } }])
	})
})

describe("the keys inside a group", () => {
	it("Escape goes back to the group, then clears", () => {
		mount()
		click(450, 150)
		click(450, 150)
		key({ key: "Escape", code: "Escape" })
		expect(selection.getSnapshot().ids).toEqual([2])
		key({ key: "Escape", code: "Escape" })
		expect(selection.getSnapshot().ids).toEqual([])
	})

	it("Tab goes round the group's members; Select All selects them", () => {
		mount()
		click(450, 150)
		click(450, 150)
		key({ key: "Tab", code: "Tab" })
		expect(selection.getSnapshot().ids).toEqual([3])
		key({ key: "Tab", code: "Tab" })
		expect(selection.getSnapshot().ids).toEqual([4])
		key({ key: "a", code: "KeyA", ...MOD })
		expect(selection.getSnapshot().ids).toEqual([3, 4])
	})

	it("an arrow nudges a member in the group's child space", async () => {
		mount()
		click(450, 150)
		click(450, 150)
		key({ key: "ArrowRight", code: "ArrowRight" })
		await settle()
		// 1 px on the slide is half a px in a group scaled 2× along x.
		expect(ops).toEqual([
			{ family: "shape", kind: "setXfrm", target: { slide: ref, id: 4 }, xfrm: box(150, 0, 100, 100, { x: Math.round(150.5 * EMU) }) }
		])
	})

	it("Ctrl+D copies a member into its group, the offset taken into the group's space", async () => {
		mount()
		click(450, 150)
		click(450, 150)
		key({ key: "d", code: "KeyD", ...MOD })
		await settle()
		expect(ops).toEqual([{ family: "shape", kind: "duplicate", slide: ref, shapes: [4], dx: 5 * EMU, dy: 10 * EMU }])
	})
})

describe("the selection store with members", () => {
	it("resolves members in their group's order and keeps them while the render has them", () => {
		const render = renderOf()

		selection.show(ref)
		selection.set([4, 3])

		expect(selectedShapes(render, selection.getSnapshot()).map(shape => [shape.id, shape.parent])).toEqual([
			[3, 2],
			[4, 2]
		])

		selection.reconcile(render)
		expect(selection.getSnapshot().ids).toEqual([4, 3])
	})

	it("selects the outermost shapes a command made at any level", () => {
		const before = renderOf()

		selection.show(ref)
		selection.set([3, 4])
		selection.selectNew(ref, { placements: placements(before) })

		// Members 3 and 4 grouped inside the group as 7.
		const after = renderOf()
		const group = after.layers[1]?.box as NonNullable<SlideLayer["box"]>
		const inner: GroupMember = {
			id: 7,
			role: "group",
			own: box(0, 0, 250, 100),
			xfrm: shownThrough([GROUP], box(0, 0, 250, 100)),
			members: group.members ?? []
		}

		Object.assign(group, { members: [inner] })
		selection.reconcile(after)

		expect(selection.getSnapshot().ids).toEqual([7])
	})
})
