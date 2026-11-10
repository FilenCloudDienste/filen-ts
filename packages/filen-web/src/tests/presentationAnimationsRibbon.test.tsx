// @vitest-environment happy-dom

import "@/tests/support/officeKeys"
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import i18n from "i18next"
import { addEffectsOp, EFFECT_PRESETS, slideRef, type DeckOp } from "@filen/office/core/presentation"
import type { CommandResult, OpenInfo, PresentationSessionApi, SlideLayer, SlideRender } from "@filen/office/dom/presentation"
import { createShapeSelection } from "@filen/office/react/presentation"
import { OfficeRibbon } from "@/features/office/components/ribbon/officeRibbon"
import { AnimationPane } from "@/features/presentation/components/animationPane"
import {
	animationPane,
	animationsGroups,
	parseSeconds,
	presetLabel,
	subtypeLabel
} from "@/features/presentation/components/ribbon/animations"
import type { PresentationRibbonContext, PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"
import { transitionsGroups } from "@/features/presentation/components/ribbon/transitions"
import "@/lib/i18n"

// The Animations tab and the Animation Pane against a fake editor: a gallery pick is one timing op on the selected
// shapes, the pane lists the slide's effects as the worker answers them, and every preset and subtype has its name.

vi.mock("@/lib/useElementSize", () => ({ useElementSize: () => ({ width: 2400, height: 40 }) }))
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const EMU = 9525
const ref = slideRef(256)
let revision = 1

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

// A main sequence of one click par per effect (the fake worker's answer for `effects`).
function clicksTiming(effects: readonly unknown[]): unknown {
	let id = 1000

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
							children: effects.map(effect => ({
								kind: "par",
								ctn: {
									id: ++id,
									stCondLst: [{ delay: "indefinite" }],
									endCondLst: [],
									children: [
										{
											kind: "par",
											ctn: { id: ++id, fill: "hold", stCondLst: [{ delay: 0 }], endCondLst: [], children: [effect] }
										}
									]
								}
							}))
						}
					}
				]
			}
		},
		builds: []
	}
}

// One effect of `preset` on shape 2, its node id `id`.
function effectOf(presetClass: "entr" | "exit", presetId: number, id: number): unknown {
	const preset = EFFECT_PRESETS.find(p => p.presetClass === presetClass && p.id === presetId)
	const op = preset === undefined ? undefined : addEffectsOp(ref, [], [{ id: 2 }], { preset, aspect: 16 / 9 })

	if (op?.family !== "timing" || op.kind !== "addEffect") throw new Error("op")

	return { ...op.effect, ctn: { ...op.effect.ctn, id } }
}

let answer: (() => unknown) | undefined

// The timing the fake worker answers with: one Fly In on shape 2 and a Spin after it on shape 3.
function timing(): unknown {
	if (answer !== undefined) return answer()

	const fly = EFFECT_PRESETS.find(p => p.presetClass === "entr" && p.id === 2)
	const spin = EFFECT_PRESETS.find(p => p.presetClass === "emph" && p.id === 8)

	if (fly === undefined || spin === undefined) throw new Error("presets")

	const op = addEffectsOp(ref, [], [{ id: 2 }], { preset: fly, aspect: 16 / 9 })
	const second = addEffectsOp(ref, [], [{ id: 3 }], { preset: spin, aspect: 16 / 9 }, "after")

	if (op?.family !== "timing" || op.kind !== "addEffect" || second?.family !== "timing" || second.kind !== "addEffect")
		throw new Error("ops")

	const effect = (node: typeof op.effect, id: number) => ({ ...node, ctn: { ...node.ctn, id } })
	const group = (id: number, delay: number, children: unknown[]) => ({
		kind: "par",
		ctn: { id, fill: "hold", stCondLst: [{ delay }], endCondLst: [], children }
	})

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
										children: [group(4, 0, [effect(op.effect, 10)]), group(5, 500, [effect(second.effect, 20)])]
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

function mount(animated: boolean, selected: readonly number[], phone = false): PresentationRibbonEditor {
	const selection = createShapeSelection()

	selection.show(ref)
	selection.set(selected)
	ops = []

	const editor: PresentationRibbonEditor = {
		info: INFO,
		render: renderOf(animated),
		selection,
		session: { timegraph: () => Promise.resolve({ source: { timing: timing() } }) } as unknown as PresentationSessionApi,
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
				groups={animationsGroups(context)}
			/>
			<AnimationPane
				editor={editor}
				editable
				phone={phone}
			/>
		</>
	)

	return editor
}

afterEach(() => {
	answer = undefined
	cleanup()
	animationPane.setOpen(false)
	animationPane.select([])
	animationPane.stop()
	vi.restoreAllMocks()
})

function at(elements: readonly HTMLElement[], index: number): HTMLElement {
	const element = elements[index]

	if (element === undefined) throw new Error(`no element ${String(index)}`)

	return element
}

function commands(): HTMLElement {
	return screen.getByRole("toolbar", { name: "Commands" })
}

describe("presentation Animations tab", () => {
	it("shows its groups in order, and only Preview where the deck is viewed", () => {
		mount(false, [2])

		expect(
			within(commands())
				.getAllByRole("group")
				.map(group => group.getAttribute("aria-label"))
		).toEqual(["Preview", "Animation", "Advanced Animation", "Timing"])
		expect(animationsGroups({ editable: true, phone: false, selection: new Set(), t: i18n.t.bind(i18n) })).toEqual([])
	})

	it("adds a picked effect to the selected shape as one timing op", async () => {
		mount(false, [3])

		fireEvent.click(within(commands()).getByRole("button", { name: "Effects" }))
		// Wipe is an entrance and an exit: the first is the entrance.
		fireEvent.click(at(await screen.findAllByRole("menuitem", { name: "Wipe" }), 0))

		expect(ops).toHaveLength(1)
		expect(ops[0]).toMatchObject({
			family: "timing",
			kind: "addEffect",
			slide: ref,
			effect: { ctn: { presetID: 22, presetClass: "entr", nodeType: "clickEffect" } }
		})
	})

	it("lists the slide's effects in the pane and moves one with Alt+Down", async () => {
		mount(true, [])
		act(() => {
			animationPane.setOpen(true)
		})

		const rows = await screen.findAllByRole("option")

		expect(rows.map(row => row.getAttribute("aria-label"))).toEqual([
			"Entrance: Fly In: Object 2, On Click",
			"Emphasis: Spin: Object 3, After Previous"
		])

		fireEvent.click(at(rows, 0))
		fireEvent.keyDown(at(rows, 0), { key: "ArrowDown", altKey: true })
		await waitFor(() => {
			expect(ops).toEqual([{ family: "timing", kind: "moveEffect", slide: ref, node: 10, to: 1 }])
		})
	})

	it("lets the phone pane's list take its rows' height: layout and paint contained, never size", async () => {
		mount(true, [], true)
		act(() => {
			animationPane.setOpen(true)
		})

		const rows = await screen.findAllByRole("option")
		const list = at(rows, 0).closest<HTMLElement>(".overflow-y-auto")

		// The phone pane has only a maximum height, so size containment would make the list 0 px tall.
		expect(list?.className).toContain("[contain:content]")
		expect(list?.className).not.toMatch(/contain:(strict|size)/u)
	})

	it("tells an entrance and an exit of one name apart by their names", async () => {
		answer = () => clicksTiming([effectOf("entr", 10, 10), effectOf("exit", 10, 20)])
		mount(true, [])
		act(() => {
			animationPane.setOpen(true)
		})

		const rows = await screen.findAllByRole("option")

		expect(rows.map(row => row.getAttribute("aria-label"))).toEqual([
			"Entrance: Fade: Object 2, On Click",
			"Exit: Fade: Object 2, On Click"
		])
		expect(rows.map(row => row.textContent)).toEqual(["1Entrance: Fade: Object 2", "2Exit: Fade: Object 2"])
	})

	it("keeps the list's tab stop drawn when the focused effect is scrolled out of view", async () => {
		answer = () => clicksTiming(Array.from({ length: 80 }, (_, k) => effectOf("entr", 10, 10 + k)))
		mount(true, [])
		act(() => {
			animationPane.setOpen(true)
			animationPane.select([89])
		})

		await waitFor(() => {
			const stops = screen.getAllByRole("option").filter(row => row.tabIndex === 0)

			expect(stops.map(row => row.getAttribute("data-effect"))).toEqual(["89"])
		})
		// Only the rows in view are drawn besides it.
		expect(screen.getAllByRole("option").length).toBeLessThan(20)
	})

	it("times the chosen effect from the Timing group", async () => {
		mount(true, [])
		act(() => {
			animationPane.setOpen(true)
		})

		const rows = await screen.findAllByRole("option")

		fireEvent.click(at(rows, 1))

		const delay = within(commands()).getByLabelText("Delay")

		fireEvent.change(delay, { target: { value: "1.5" } })
		fireEvent.keyDown(delay, { key: "Enter" })
		expect(ops).toEqual([{ family: "timing", kind: "setEffectTiming", slide: ref, node: 20, timing: { delayMs: 1500 } }])
	})
})

describe("a ribbon seconds field's Escape", () => {
	it("cancels what was typed without sending it (the effect's Delay), the key taken so focus stays", async () => {
		mount(true, [])
		act(() => {
			animationPane.setOpen(true)
		})
		fireEvent.click(at(await screen.findAllByRole("option"), 1))

		const delay = within(commands()).getByLabelText<HTMLInputElement>("Delay")
		const shown = delay.value

		fireEvent.change(delay, { target: { value: "9" } })
		expect(fireEvent.keyDown(delay, { key: "Escape" })).toBe(false)
		expect(delay.value).toBe(shown)
		fireEvent.blur(delay)
		expect(ops).toEqual([])
		// Nothing typed: the Escape is not the field's.
		expect(fireEvent.keyDown(delay, { key: "Escape" })).toBe(true)
	})

	it("cancels what was typed without sending it (the transition's Duration)", async () => {
		const selection = createShapeSelection()

		selection.show(ref)
		ops = []

		const editor: PresentationRibbonEditor = {
			info: INFO,
			render: renderOf(false),
			selection,
			session: {
				timegraph: () => Promise.resolve({ source: { transition: { kind: "fade", durationMs: 700, advance: { onClick: true } } } })
			} as unknown as PresentationSessionApi,
			command: (op: DeckOp): Promise<CommandResult> => {
				ops.push(op)

				return Promise.resolve({ ok: true, revision: ops.length, dirty: true })
			}
		}

		render(
			<OfficeRibbon
				label="Ribbon"
				commandsLabel="Commands"
				tabs={[{ id: "transitions", label: "Transitions" }]}
				tab="transitions"
				onTab={() => undefined}
				file={null}
				groups={transitionsGroups({ editable: true, phone: false, selection: new Set(), t: i18n.t.bind(i18n), editor })}
			/>
		)

		const duration = within(commands()).getByLabelText<HTMLInputElement>("Duration (s)")

		await waitFor(() => {
			expect(duration.value).toBe("0.7")
		})
		fireEvent.change(duration, { target: { value: "9" } })
		expect(fireEvent.keyDown(duration, { key: "Escape" })).toBe(false)
		expect(duration.value).toBe("0.7")
		fireEvent.blur(duration)
		expect(ops).toEqual([])
	})
})

describe("animation names", () => {
	it("names every preset and every subtype it offers", () => {
		const t = i18n.getFixedT(null, "preview")

		for (const preset of EFFECT_PRESETS) {
			expect(i18n.exists(`preview:previewPptxAnimPreset${preset.name}`), preset.name).toBe(true)
			expect(presetLabel(t, preset)).not.toBe("Custom")

			for (const subtype of preset.subtypes)
				expect(subtypeLabel(t, preset, subtype), `${preset.name} ${String(subtype)}`).not.toMatch(/previewPptx/u)
		}
	})

	it("reads seconds as typed, and refuses what is out of range", () => {
		expect([
			parseSeconds("1.5"),
			parseSeconds("1,25"),
			parseSeconds("2 s"),
			parseSeconds(""),
			parseSeconds("-1"),
			parseSeconds("601")
		]).toEqual([1.5, 1.25, 2, undefined, undefined, undefined])
	})
})
