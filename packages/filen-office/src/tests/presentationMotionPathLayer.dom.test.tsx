// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { TimeNode, TimingTree } from "../core/anim/model"
import { readEditablePath, type EditablePath } from "../core/anim/motionEdit"
import type { Refused, Xfrm } from "../core/presentation/model"
import { MotionPathLayer, type MotionPathLayerProps, type MotionPathView } from "../react/presentation/edit/motionPath/MotionPathLayer"
import { editableData, placementOf } from "../react/presentation/edit/motionPath/geometry"
import { motionPathViews } from "../react/presentation/edit/motionPath/views"

// The motion path layer from the keyboard, the only non-pointer way to draw or edit a path: Space places a point at
// the keyboard cursor (arrows move it 1 px, 10 with Shift), Escape leaves the tool; in Edit Points Tab goes round the
// anchors, Delete and arrows edit the selected one; focus goes back where it was when the tool ends. Scale 1 (1
// screen px = 1 slide px) on a 960 × 540 px slide.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const EMU = 9525
const SIZE = { cx: 960 * EMU, cy: 540 * EMU }
const CENTER = { x: 480 * EMU, y: 270 * EMU }
const PATH = "M 0 0 L 0.1 0 L 0.2 0.1 E"
const VIEW: MotionPathView = { node: 7, effect: 6, shape: 3, path: PATH, center: CENTER }

let host: HTMLElement
let root: Root
let drawn: (EditablePath | undefined)[]
let edits: { node: number; path: EditablePath }[]
let points: (number | undefined)[]
let ended: number

function ok(path: EditablePath | Refused): EditablePath {
	if ("reason" in path) throw new Error(path.reason)

	return path
}

function render(props: Partial<MotionPathLayerProps> = {}): void {
	act(() => {
		root.render(
			<MotionPathLayer
				size={SIZE}
				scale={1}
				paths={[VIEW]}
				selected={[]}
				editable
				pickable={false}
				labels={{ drawing: "Drawing a motion path", editing: "Editing points", point: (index, count) => `${index} of ${count}` }}
				onSelect={() => undefined}
				onDrawn={path => {
					drawn.push(path)
				}}
				onEdit={(node, path) => {
					edits.push({ node, path })
				}}
				onPoint={index => {
					points.push(index)
				}}
				onEditEnd={() => {
					ended++
				}}
				{...props}
			/>
		)
	})
}

const layer = (): HTMLElement => host.querySelector<HTMLElement>("[data-fo-motion-paths]") as HTMLElement
// The edited path's stroke (the first path of its group).
const shownPath = (): string => host.querySelector("svg g path")?.getAttribute("d") ?? ""

function key(key: string, init: KeyboardEventInit = {}): void {
	act(() => {
		layer().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, ...init }))
	})
}

beforeEach(() => {
	host = document.createElement("div")
	document.body.append(host)
	root = createRoot(host)
	drawn = []
	edits = []
	points = []
	ended = 0
})

afterEach(() => {
	act(() => {
		root.unmount()
	})
	host.remove()
})

describe("drawing a Line from the keyboard", () => {
	it("Space places the start at the shape's centre, Shift+arrows move the cursor 10 px, Space places the end", () => {
		render({ tool: "line", origin: CENTER })
		key(" ")

		for (let i = 0; i < 5; i++) key("ArrowRight", { shiftKey: true })

		key("ArrowDown")
		expect(drawn).toEqual([])
		key(" ")

		expect(drawn).toHaveLength(1)

		const path = drawn[0] as EditablePath

		expect(Array.from(path.xs)).toEqual([0, expect.closeTo(50 / 960, 12)])
		expect(Array.from(path.ys)).toEqual([0, expect.closeTo(1 / 540, 12)])
		expect(path.closed).toBe(false)
	})

	it("Escape leaves the tool without a path", () => {
		render({ tool: "line", origin: CENTER })
		key(" ")
		key("Escape")

		expect(drawn).toEqual([undefined])
	})

	it("takes the focus for the tool and hands it back to what had it when the tool ends", () => {
		const button = document.createElement("button")

		document.body.append(button)
		button.focus()
		render({ tool: "line", origin: CENTER })

		expect(document.activeElement).toBe(layer())

		render({})

		expect(document.activeElement).toBe(button)
		button.remove()
	})
})

describe("Edit Points from the keyboard", () => {
	it("Tab and Shift+Tab choose anchors, wrapping round both ends", () => {
		render({ editing: 7 })
		key("Tab")
		key("Tab", { shiftKey: true })
		render({ editing: 7, point: 2 })
		key("Tab")
		render({ editing: 7, point: 0 })
		key("Tab", { shiftKey: true })
		render({ editing: 7, point: 1 })
		key("Tab")

		expect(points).toEqual([0, 2, 0, 2, 2])
	})

	it("Delete removes the selected anchor as one edit", () => {
		render({ editing: 7, point: 1 })
		key("Delete")

		expect(points).toEqual([1])
		expect(edits).toHaveLength(1)
		expect(edits[0]?.node).toBe(7)
		expect(Array.from(edits[0]?.path.xs ?? [])).toEqual([0, 0.2])
		expect(Array.from(edits[0]?.path.ys ?? [])).toEqual([0, 0.1])
	})

	it("arrows move the selected anchor 1 px (10 with Shift), shown until the slide's timing comes back", () => {
		render({ editing: 7, point: 1 })
		key("ArrowRight")
		key("ArrowUp", { shiftKey: true })

		expect(edits).toHaveLength(2)
		expect(edits[0]?.path.xs[1]).toBeCloseTo(0.1 + 1 / 960, 12)
		expect(edits[0]?.path.ys[1]).toBeCloseTo(0, 12)

		// The second press starts from the first's edit, not from the path the file still has.
		const moved = edits[1]?.path as EditablePath

		expect(moved.xs[1]).toBeCloseTo(0.1 + 1 / 960, 12)
		expect(moved.ys[1]).toBeCloseTo(-10 / 540, 12)
		expect(shownPath()).toBe(editableData(placementOf(CENTER, SIZE, 1), moved))

		// The timing comes back with another path: the layer shows that one.
		const back = "M 0 0 L 0.3 0 L 0.2 0.1 E"

		render({ editing: 7, point: 1, paths: [{ ...VIEW, path: back }] })

		expect(shownPath()).toBe(editableData(placementOf(CENTER, SIZE, 1), ok(readEditablePath(back))))
	})

	it("Escape leaves Edit Points", () => {
		render({ editing: 7, point: 0 })
		key("Escape")

		expect(ended).toBe(1)
		expect(edits).toEqual([])
	})
})

describe("motionPathViews", () => {
	const node = (id: number, children: TimeNode[], presetClass?: "path"): TimeNode => ({
		kind: "par",
		ctn: { id, ...(presetClass === undefined ? {} : { presetClass }), stCondLst: [], endCondLst: [], children }
	})
	const motion = (id: number, shape: number): TimeNode => ({
		kind: "behavior",
		behavior: { type: "animMotion", common: { target: { kind: "shape", shape }, attrNames: [] }, path: PATH },
		ctn: { id, stCondLst: [], endCondLst: [], children: [] }
	})
	const xfrm = (x: number, y: number): Xfrm => ({ x, y, cx: 200, cy: 100, rot: 0, flipH: false, flipV: false })
	const timing: TimingTree = { root: node(1, [node(6, [motion(7, 3)], "path"), node(8, [motion(9, 4)], "path")]), builds: [] }
	// Shape 4 sits in a group: its box comes from the worker's geometry (id, x, y, cx, cy).
	const geometry = Float64Array.of(4, 1000, 2000, 400, 600)

	it("reuses the views while the same timing has the same boxes, and places paths at a moved box's new centre", () => {
		const first = motionPathViews(timing, geometry, [{ id: 3, xfrm: xfrm(0, 0) }])

		expect(first.map(view => [view.node, view.effect, view.shape, view.center])).toEqual([
			[7, 6, 3, { x: 100, y: 50 }],
			[9, 8, 4, { x: 1200, y: 2300 }]
		])
		expect(motionPathViews(timing, geometry, [{ id: 3, xfrm: xfrm(0, 0) }])).toBe(first)

		const moved = motionPathViews(timing, geometry, [{ id: 3, xfrm: xfrm(500, 0) }])

		expect(moved).not.toBe(first)
		expect(moved[0]?.center).toEqual({ x: 600, y: 50 })
		expect(motionPathViews(undefined, geometry, [])).toEqual([])
	})
})
