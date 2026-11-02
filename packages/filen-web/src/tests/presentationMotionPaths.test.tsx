// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "i18next"
import { addEffectsOp, slideRef, type DeckOp } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideLayer, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection, customPathPreset } from "@filen/office/react/presentation"
import { OfficeRibbon } from "@/features/office/components/ribbon/officeRibbon"
import { animationPane } from "@/features/presentation/components/ribbon/animations"
import {
	customPathLabel,
	motionPaths,
	motionPathsGroups,
	PresentationMotionPaths
} from "@/features/presentation/components/ribbon/motionPaths"
import type { PresentationRibbonContext, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import "@/lib/i18n"

// The Motion Paths group and the motion-path layer against a fake editor: a drawn path is one addEffect of a custom
// path, an Edit Points drag is one setPath, Lock is one setPath, and the store keeps the timing the paths come from.

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 2400, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const EMU = 9525
const ref = slideRef(256)
let revision = 1

// Shapes 2 and 3; shape 2's box is 200..290 × 0..50 slide px, its centre (245, 25).
function renderOf(animated: boolean): SlideRender {
	const layers = [2, 3].map(
		id =>
			({
				shape: { slide: ref, id },
				role: "shape",
				drawing: {},
				matrix: [1, 0, 0, 1, 0, 0],
				box: { id, xfrm: { x: id * 100 * EMU, y: 0, cx: 90 * EMU, cy: 50 * EMU, rot: 0, flipH: false, flipV: false } }
			}) as unknown as SlideLayer
	)

	return { ref, index: 0, revision: revision++, hidden: false, background: {}, layers, notesText: "", animated } as unknown as SlideRender
}

const INFO = {
	slides: [{ ref, hidden: false }],
	size: { cx: 960 * EMU, cy: 540 * EMU },
	customShows: [],
	editable: true
} as unknown as OpenInfo

let ops: DeckOp[]

// A main sequence with one custom path on shape 2 (effect par 10, its animMotion 11): right 0.1 of the slide.
function timing(path: string, pathEditMode?: "fixed"): unknown {
	const op = addEffectsOp(ref, [], [{ id: 2 }], { preset: customPathPreset({ path, ptsTypes: "AA" }), aspect: 16 / 9 })

	if (op?.family !== "timing" || op.kind !== "addEffect") throw new Error("op")

	const motion = op.effect.ctn.children[0]

	if (motion?.kind !== "behavior" || motion.behavior.type !== "animMotion") throw new Error("motion")

	const behavior = { ...motion.behavior, ...(pathEditMode === undefined ? {} : { pathEditMode }) }
	const effect = { ...op.effect, ctn: { ...op.effect.ctn, id: 10, children: [{ ...motion, behavior, ctn: { ...motion.ctn, id: 11 } }] } }

	return {
		root: {
			kind: "par",
			ctn: {
				id: 1,
				nodeType: "tmRoot",
				stCondLst: [],
				endCondLst: [],
				children: [
					{
						kind: "seq",
						ctn: {
							id: 2,
							nodeType: "mainSeq",
							stCondLst: [],
							endCondLst: [],
							children: [
								{
									kind: "par",
									ctn: {
										id: 3,
										stCondLst: [{ delay: "indefinite" }],
										endCondLst: [],
										children: [
											{
												kind: "par",
												ctn: { id: 4, fill: "hold", stCondLst: [{ delay: 0 }], endCondLst: [], children: [effect] }
											}
										]
									}
								}
							]
						}
					}
				]
			}
		},
		builds: []
	}
}

function mount(options: {
	readonly animated: boolean
	readonly selected: readonly number[]
	readonly locked?: boolean
	readonly path?: string
}): PresentationRibbonEditor {
	const selection = createShapeSelection()

	selection.show(ref)
	selection.set(options.selected)
	ops = []

	const source = {
		timing: options.animated ? timing(options.path ?? "M 0 0 L 0.1 0 E", options.locked === true ? "fixed" : undefined) : undefined,
		geometry: new Float64Array(0)
	}
	const editor: PresentationRibbonEditor = {
		info: INFO,
		render: renderOf(options.animated),
		selection,
		session: { timegraph: () => Promise.resolve({ source }) } as unknown as PresentationSessionApi,
		command: (op: DeckOp): Promise<CommandResult> => {
			ops.push(op)

			return Promise.resolve({ ok: true, revision: ops.length, dirty: true })
		}
	}
	const context: PresentationRibbonContext = { editable: true, phone: false, selection: new Set(), t: i18n.t.bind(i18n), editor }

	render(
		<>
			<OfficeRibbon
				label="Ribbon"
				commandsLabel="Commands"
				tabs={[{ id: "animations", label: "Animations" }]}
				tab="animations"
				onTab={() => undefined}
				file={null}
				groups={motionPathsGroups(context)}
			/>
			<div data-testid="canvas">
				<PresentationMotionPaths
					editor={editor}
					scale={1}
				/>
			</div>
		</>
	)

	return editor
}

afterEach(() => {
	cleanup()
	act(() => {
		motionPaths.reset()
		animationPane.select([])
	})
	vi.restoreAllMocks()
})

function commands(): HTMLElement {
	return screen.getByRole("toolbar", { name: "Commands" })
}

function layer(): HTMLElement {
	const element = document.querySelector<HTMLElement>("[data-fo-motion-paths]")

	if (element === null) throw new Error("no layer")

	return element
}

describe("presentation motion paths", () => {
	it("keeps the slide's resolved timing for the canvas, and draws the slide's path", async () => {
		mount({ animated: true, selected: [2] })

		await waitFor(() => {
			expect(animationPane.getSnapshot().source?.timing).toBeDefined()
		})
		await waitFor(() => {
			expect(layer().querySelectorAll("path[d^='M245.0 25.0L341.0 25.0']")).toHaveLength(1)
		})
	})

	it("offers the four tools for one selected object, and none for two", async () => {
		mount({ animated: false, selected: [2] })

		fireEvent.click(within(commands()).getByRole("button", { name: "Custom Path" }))

		expect((await screen.findAllByRole("menuitem")).map(item => item.textContent)).toEqual(["Line", "Curve", "Freeform", "Scribble"])
		cleanup()
		mount({ animated: false, selected: [2, 3] })
		expect(within(commands()).getByRole("button", { name: "Select one object to draw its path." })).toHaveProperty("disabled", true)
	})

	it("adds a drawn line as one custom path effect, relative to the object's centre", async () => {
		mount({ animated: false, selected: [2] })
		act(() => {
			motionPaths.draw("line", 2)
		})

		const target = layer()

		expect(target.getAttribute("role")).toBe("application")
		fireEvent.pointerDown(target, { clientX: 245, clientY: 25, pointerId: 1, button: 0 })
		fireEvent.pointerMove(target, { clientX: 300, clientY: 60, pointerId: 1 })
		fireEvent.pointerUp(target, { clientX: 341, clientY: 79, pointerId: 1 })

		await waitFor(() => {
			expect(ops).toHaveLength(1)
		})
		expect(ops[0]).toMatchObject({
			family: "timing",
			kind: "addEffect",
			slide: ref,
			effect: {
				ctn: {
					presetID: 0,
					presetClass: "path",
					children: [{ behavior: { type: "animMotion", path: "M 0 0 L 0.1 0.1 E", ptsTypes: "AA" } }]
				}
			}
		})
		expect(motionPaths.getSnapshot().tool).toBeUndefined()
	})

	it("Escape leaves a tool without adding anything", () => {
		mount({ animated: false, selected: [2] })
		act(() => {
			motionPaths.draw("curve", 2)
		})
		fireEvent.pointerDown(layer(), { clientX: 245, clientY: 25, pointerId: 1, button: 0 })
		fireEvent.pointerUp(layer(), { clientX: 245, clientY: 25, pointerId: 1 })
		fireEvent.keyDown(layer(), { key: "Escape" })

		expect(ops).toEqual([])
		expect(motionPaths.getSnapshot().tool).toBeUndefined()
	})

	it("an Edit Points drag is one setPath", async () => {
		mount({ animated: true, selected: [2] })
		await waitFor(() => {
			expect(within(commands()).getByRole("button", { name: "Edit Points" })).toHaveProperty("disabled", false)
		})
		fireEvent.click(within(commands()).getByRole("button", { name: "Edit Points" }))
		expect(motionPaths.getSnapshot().editing).toBe(11)

		// The path's end, at (341, 25), dragged to (341, 79).
		fireEvent.pointerDown(layer(), { clientX: 341, clientY: 25, pointerId: 1, button: 0 })
		fireEvent.pointerMove(layer(), { clientX: 341, clientY: 50, pointerId: 1 })
		fireEvent.pointerMove(layer(), { clientX: 341, clientY: 79, pointerId: 1 })
		fireEvent.pointerUp(layer(), { clientX: 341, clientY: 79, pointerId: 1 })

		expect(ops).toEqual([{ family: "motionPath", kind: "setPath", slide: ref, node: 11, path: "M 0 0 L 0.1 0.1 E", ptsTypes: "AA" }])
		expect(motionPaths.getSnapshot().point).toBe(1)
	})

	it("locks the chosen path in one setPath, keeping its path", async () => {
		mount({ animated: true, selected: [2] })
		await waitFor(() => {
			expect(within(commands()).getByRole("button", { name: "Path" })).toHaveProperty("disabled", false)
		})
		fireEvent.click(within(commands()).getByRole("button", { name: "Path" }))
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Locked" }))

		expect(ops).toEqual([
			{ family: "motionPath", kind: "setPath", slide: ref, node: 11, path: "M 0 0 L 0.1 0 E", ptsTypes: "AA", pathEditMode: "fixed" }
		])
	})

	it("closes the Path menu after a choice, giving focus back to its trigger", async () => {
		mount({ animated: true, selected: [2] })

		const trigger = within(commands()).getByRole("button", { name: "Path" })

		await waitFor(() => {
			expect(trigger).toHaveProperty("disabled", false)
		})
		fireEvent.click(trigger)
		fireEvent.click(await screen.findByRole("menuitemradio", { name: "Locked" }))

		await waitFor(() => {
			expect(screen.queryByRole("menuitemradio", { name: "Locked" })).toBeNull()
		})
		expect(trigger.getAttribute("aria-expanded")).not.toBe("true")
		await waitFor(() => {
			expect(document.activeElement).toBe(trigger)
		})
	})

	it("gives focus back to Edit Points when Escape ends editing", async () => {
		mount({ animated: true, selected: [2] })

		const button = within(commands()).getByRole("button", { name: "Edit Points" })

		await waitFor(() => {
			expect(button).toHaveProperty("disabled", false)
		})
		button.focus()
		fireEvent.click(button)
		expect(document.activeElement).toBe(layer())
		fireEvent.keyDown(layer(), { key: "Escape" })

		expect(motionPaths.getSnapshot().editing).toBeUndefined()
		expect(document.activeElement).toBe(button)
	})

	it("draws a line from the keyboard: arrows move the cursor from the object's centre, Space places each end", async () => {
		mount({ animated: false, selected: [2] })
		act(() => {
			motionPaths.draw("line", 2)
		})

		const target = layer()

		expect(document.activeElement).toBe(target)
		fireEvent.keyDown(target, { key: " " })

		for (let k = 0; k < 10; k++) fireEvent.keyDown(target, { key: "ArrowRight", shiftKey: true })

		fireEvent.keyDown(target, { key: " " })

		await waitFor(() => {
			expect(ops).toHaveLength(1)
		})
		// 100 screen px of a 960 px slide: 0.10417 of its width.
		expect(ops[0]).toMatchObject({
			family: "timing",
			kind: "addEffect",
			effect: { ctn: { presetID: 0, children: [{ behavior: { type: "animMotion", path: "M 0 0 L 0.10417 0 E" } }] } }
		})
		expect(motionPaths.getSnapshot().tool).toBeUndefined()
	})

	it("draws a curve from the keyboard and ends it with Enter", async () => {
		mount({ animated: false, selected: [2] })
		act(() => {
			motionPaths.draw("curve", 2)
		})

		const target = layer()
		const press = (key: string, times = 1): void => {
			for (let k = 0; k < times; k++) fireEvent.keyDown(target, { key, shiftKey: true })
		}

		press(" ")
		press("ArrowRight", 5)
		press("ArrowDown", 5)
		press(" ")
		press("ArrowRight", 5)
		press(" ")
		press("Enter")

		await waitFor(() => {
			expect(ops).toHaveLength(1)
		})
		expect(ops[0]).toMatchObject({ family: "timing", kind: "addEffect", effect: { ctn: { presetID: 0 } } })
	})

	it("moves the selected point one screen px an arrow press, ten with Shift", async () => {
		mount({ animated: true, selected: [2] })
		await waitFor(() => {
			expect(within(commands()).getByRole("button", { name: "Edit Points" })).toHaveProperty("disabled", false)
		})
		fireEvent.click(within(commands()).getByRole("button", { name: "Edit Points" }))
		act(() => {
			motionPaths.point(1)
		})
		fireEvent.keyDown(layer(), { key: "ArrowDown", shiftKey: true })

		// 10 px of a 540 px slide.
		expect(ops).toEqual([
			{ family: "motionPath", kind: "setPath", slide: ref, node: 11, path: "M 0 0 L 0.1 0.01852 E", ptsTypes: "AA" }
		])
	})

	it("says why a path of more points than an edit may write cannot be edited", async () => {
		const path = ["M 0 0", ...Array.from({ length: 10_001 }, (_, k) => `L ${String((k % 100) / 1000)} 0`), "E"].join(" ")

		mount({ animated: true, selected: [2], path })

		const button = await within(commands()).findByRole("button", { name: "This path has too many points to edit point by point." })

		expect(button).toHaveProperty("disabled", true)
	})

	it("names a custom path effect Custom Path", () => {
		const t = i18n.getFixedT(null, "preview")

		expect(customPathLabel(t, "path", 0)).toBe("Custom Path")
		expect(customPathLabel(t, "path", undefined)).toBe("Custom Path")
		expect(customPathLabel(t, "path", 63)).toBeUndefined()
	})
})
