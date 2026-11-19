// @vitest-environment happy-dom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { movePoint, writeEditablePath, type EditablePath } from "../core/anim/motionEdit"
import { MotionPathLayer, type MotionPathLayerProps, type MotionPathView } from "../react/presentation/edit/motionPath/MotionPathLayer"
import { editableData, placementOf } from "../react/presentation/edit/motionPath/geometry"

// Arrow keys held on a motion path point faster than the worker answers: each press builds on the last one sent, the
// point never steps back while answers and the slide's timing are on their way, and no step is lost. Scale 1 on a
// 960 × 540 px slide: one press is 1/960 of the slide across.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const EMU = 9525
const SIZE = { cx: 960 * EMU, cy: 540 * EMU }
const CENTER = { x: 480 * EMU, y: 270 * EMU }
const VIEW: MotionPathView = { node: 7, effect: 6, shape: 3, path: "M 0 0 L 0.1 0 L 0.2 0.1 E", center: CENTER }
const STEP = 1 / 960

let host: HTMLElement
let root: Root
let edits: { path: EditablePath; answer: (ok: boolean) => void }[]

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
				editing={7}
				point={1}
				labels={{ drawing: "Drawing", editing: "Editing points", point: (index, count) => `${index} of ${count}` }}
				onSelect={() => undefined}
				onDrawn={() => undefined}
				onEdit={(_node, path) =>
					new Promise<{ ok: boolean }>(resolve => {
						edits.push({ path, answer: ok => resolve({ ok }) })
					})
				}
				onPoint={() => undefined}
				onEditEnd={() => undefined}
				{...props}
			/>
		)
	})
}

const layer = (): HTMLElement => host.querySelector<HTMLElement>("[data-fo-motion-paths]") as HTMLElement
const shownPath = (): string => host.querySelector("svg g path")?.getAttribute("d") ?? ""
const drawn = (path: EditablePath): string => editableData(placementOf(CENTER, SIZE, 1), path)

function right(): void {
	act(() => {
		layer().dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }))
	})
}

async function answer(index: number, ok = true): Promise<void> {
	await act(async () => {
		edits[index]?.answer(ok)
		await Promise.resolve()
	})
}

// The slide's timing back with an edit's path, as the worker writes it.
function deliver(path: EditablePath): void {
	render({ paths: [{ ...VIEW, path: writeEditablePath(path).path }] })
}

const sent = (index: number): EditablePath => edits[index]?.path as EditablePath

beforeEach(() => {
	host = document.createElement("div")
	document.body.append(host)
	root = createRoot(host)
	edits = []
})

afterEach(() => {
	act(() => {
		root.unmount()
	})
	host.remove()
})

describe("motion path points from held arrow keys", () => {
	it("builds each press on the last one sent and never steps back while answers are on their way", async () => {
		render()
		right()
		right()
		right()

		expect(edits.map(edit => edit.path.xs[1])).toEqual([
			expect.closeTo(0.1 + STEP, 12),
			expect.closeTo(0.1 + 2 * STEP, 12),
			expect.closeTo(0.1 + 3 * STEP, 12)
		])

		// The first answer and its path arrive: the point stays where the third press put it.
		await answer(0)
		deliver(sent(0))
		expect(shownPath()).toBe(drawn(sent(2)))

		// A press now builds on the third edit, not on the slide's path.
		right()
		expect(edits[3]?.path.xs[1]).toBeCloseTo(0.1 + 4 * STEP, 12)

		await answer(1)
		await answer(2)
		await answer(3)
		// Every edit answered; the second's path is still on its way: kept.
		deliver(sent(1))
		expect(shownPath()).toBe(drawn(sent(3)))

		deliver(sent(3))
		expect(shownPath()).toBe(drawn(sent(3)))

		// The layer shows the slide's own path again: a change from elsewhere is shown.
		const other = movePoint(sent(3), 1, 0.5, 0.25)

		deliver(other)
		expect(shownPath()).toBe(drawn(other))
	})

	it("shows the slide's path once the last edit is refused", async () => {
		render()
		right()
		right()
		await answer(0)
		await answer(1, false)

		const original = movePoint(sent(0), 1, 0.1, 0)

		expect(shownPath()).toBe(drawn(original))
	})

	it("shows the slide's path at once when the slide comes back with a path no edit wrote", async () => {
		render()
		right()

		const other = movePoint(sent(0), 1, 0.4, 0.2)

		deliver(other)
		expect(shownPath()).toBe(drawn(other))
		await answer(0)
	})
})
