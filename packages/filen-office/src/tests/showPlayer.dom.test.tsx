// @vitest-environment happy-dom
import { act, createRef, type ReactNode } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CompiledTimegraph, TimeNode, TimingTree, Transition } from "../core/anim/model"
import { compileSource } from "../core/anim/timegraph"
import { DrawingList } from "../core/drawingml/index"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { slideRef, type Action, type ShowSettings, type SlideRef } from "../core/presentation/model"
import { drawingData } from "../core/presentation/render/slide"
import type { BitmapLike, LayerPlan, PresentationSessionApi, ShowLayer, SlideLayer, SlideRender } from "../dom/presentation/protocol"
import { layerParents, showLayerIndex } from "../dom/presentation/engine/show"
import type { PresentationActionPolicy } from "../react/presentation/links"
import type { ShowController, ShowEvent } from "../react/presentation/show/controller"
import { layerTree } from "../react/presentation/show/layers"
import { DEFAULT_SHOW_BINDINGS, type ShowKeyBindings } from "../react/presentation/presenter/keys"
import { SlideShow } from "../react/presentation/show/player"
import { POINTER_IDLE_MS } from "../react/presentation/show/pointer"
import { buildStageSlide, type ShowMediaMount } from "../react/presentation/show/stage"
import { SlideView, type SlidePainter } from "../react/presentation/SlideView"
import { TimingBuilder } from "./animFixtures"
import { budget, cpuMs } from "./timing"
import { codeOf } from "./showKeyFixtures"

// Every timeline sample the player takes.
const sampling = vi.hoisted(() => ({ count: 0 }))

vi.mock(import("../core/anim/timegraph"), async importOriginal => {
	const actual = await importOriginal()

	return {
		...actual,
		instantiate: graph => {
			const instance = actual.instantiate(graph)
			const sample = instance.sample.bind(instance)

			Reflect.set(instance, "sample", (t: number) => {
				sampling.count++

				return sample(t)
			})

			return instance
		}
	}
})

// The player over a stand-in session: slides prepared from their timegraph source and layer bitmaps, the first state
// shown before anything moves (entrance shapes hidden), clicks stepping the main sequence and then the slides,
// triggers, actions judged by the policy inside the show (jumps navigate the show, refused ones give a notice, hover
// does nothing), transitions on the two slide boxes, timed advance and kiosks, and the SVG paint for a slide whose
// layers cannot be drawn. Time is faked (performance, animation frames and timers).

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const SIZE = { cx: 12_192_000, cy: 6_858_000 }
const EMU = 9525

class Bitmap implements BitmapLike {
	readonly width: number
	readonly height: number
	closed = false

	constructor(width: number, height: number) {
		this.width = width
		this.height = height
	}

	close(): void {
		this.closed = true
	}
}

function drawing(width: number, height: number): ReturnType<typeof drawingData> {
	const list = new DrawingList()

	list.width = width
	list.height = height

	return drawingData(list)
}

function layer(ref: SlideRef, id: number, x: number, actions?: { click: Action }): SlideLayer {
	return {
		shape: { slide: ref, id },
		drawing: drawing(100, 50),
		matrix: [1, 0, 0, 1, x, 100],
		role: "shape",
		box: { id, xfrm: { x: x * EMU, y: 100 * EMU, cx: 100 * EMU, cy: 50 * EMU, rot: 0, flipH: false, flipV: false } },
		...(actions === undefined ? {} : { actions })
	}
}

interface SlideSpec {
	readonly timing?: TimingTree
	readonly transition?: Transition
	readonly actions?: Readonly<Record<number, Action>>
	readonly broken?: true
}

const slides = [0, 1, 2, 3].map(n => ({ ref: slideRef(300 + n), hidden: n === 2 }))

function renderOf(ref: SlideRef, spec: SlideSpec | undefined): SlideRender {
	return {
		ref,
		index: Number(ref) - 300,
		revision: 0,
		hidden: false,
		background: drawing(1280, 720),
		layers: [2, 3, 4].map(id => {
			const click = spec?.actions?.[id]

			return layer(ref, id, id * 150, click === undefined ? undefined : { click })
		}),
		notesText: "",
		animated: spec?.timing !== undefined
	}
}

function session(
	specs: ReadonlyMap<SlideRef, SlideSpec>,
	background: readonly [number, number] = [640, 360]
): { readonly api: PresentationSessionApi; readonly plans: LayerPlan[] } {
	const plans: LayerPlan[] = []
	const api = {
		timegraph: (ref: SlideRef): Promise<CompiledTimegraph> => {
			const spec = specs.get(ref)
			const layers = showLayerIndex(spec?.timing)
			const geometry = Float64Array.from([2, 3, 4].flatMap(id => [id, id * 150 * EMU, 100 * EMU, 100 * EMU, 50 * EMU]))
			const source = {
				timing: spec?.timing,
				layers,
				parents: layerParents(layers, []),
				slideSize: SIZE,
				geometry,
				colors: [],
				...(spec?.transition === undefined ? {} : { transition: spec.transition })
			}
			const graph = compileSource(ref, source, DEFAULT_PRESENTATION_BUDGETS.timing)

			return Promise.resolve({ slide: ref, mainSteps: graph.mainSteps, interactive: graph.interactive, tracks: graph.tracks, source })
		},
		layers: (ref: SlideRef, _width: number, plan: LayerPlan): Promise<readonly ShowLayer[]> => {
			plans.push(plan)

			if (specs.get(ref)?.broken === true) return Promise.reject(new Error("no canvas"))

			const out: ShowLayer[] = [{ shape: -1, bitmap: new Bitmap(background[0], background[1]), x: 0, y: 0, width: 1280, height: 720 }]

			for (const id of [2, 3, 4]) {
				const animated = plan.shapes.includes(id)

				if (animated) out.push({ shape: id, bitmap: new Bitmap(50, 25), x: id * 150, y: 100, width: 100, height: 50 })
			}

			return Promise.resolve(out)
		}
	}

	return { api: api as unknown as PresentationSessionApi, plans }
}

const painter: SlidePainter = vi.fn((render: SlideRender, context) => {
	const root = context.document.createElement("div")

	root.dataset["foPainted"] = String(render.ref)

	return { root, release: vi.fn() }
})

let host: HTMLDivElement
let root: Root

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] })
	host = document.createElement("div")
	document.body.appendChild(host)
	root = createRoot(host)
})

afterEach(() => {
	act(() => root.unmount())
	host.remove()
	vi.useRealTimers()
})

async function settle(ms = 0): Promise<void> {
	await act(async () => {
		for (let k = 0; k < 10; k++) await Promise.resolve()

		await vi.advanceTimersByTimeAsync(ms)

		for (let k = 0; k < 10; k++) await Promise.resolve()
	})
}

interface Mounted {
	readonly controller: ShowController
	readonly events: ShowEvent[]
	readonly onSlide: ReturnType<typeof vi.fn>
	readonly onEnd: ReturnType<typeof vi.fn>
	readonly plans: LayerPlan[]
	readonly stage: HTMLElement
	key(key: string): void
	layerOf(slide: number, layer: number): HTMLElement | null
}

async function mount(
	specs: ReadonlyMap<SlideRef, SlideSpec>,
	extra: {
		settings?: ShowSettings
		policy?: PresentationActionPolicy
		noSession?: true
		overlay?: ReactNode
		background?: readonly [number, number]
		media?: ShowMediaMount
		// The pointer's idle timer off, for counting the player's own timers.
		keepPointer?: true
		bindings?: ShowKeyBindings
	} = {}
): Promise<Mounted> {
	const { api, plans } = session(specs, extra.background)
	const controller = createRef<ShowController>()
	const onSlide = vi.fn()
	const onEnd = vi.fn()
	const renders = new Map(slides.map(slide => [slide.ref, renderOf(slide.ref, specs.get(slide.ref))]))

	act(() =>
		root.render(
			<SlideShow
				slides={slides}
				customShows={[]}
				renders={renders}
				size={SIZE}
				painter={painter}
				{...(extra.noSession === true ? {} : { session: api })}
				{...(extra.settings === undefined ? {} : { settings: extra.settings })}
				{...(extra.policy === undefined ? {} : { policy: extra.policy })}
				{...(extra.overlay === undefined ? {} : { overlay: extra.overlay })}
				{...(extra.media === undefined ? {} : { media: extra.media })}
				{...(extra.keepPointer === true ? { autoHidePointer: false } : {})}
				{...(extra.bindings === undefined ? {} : { bindings: extra.bindings })}
				onSlide={onSlide}
				onEnd={onEnd}
				label="Slide show"
				slideLabel={(index, count) => `Slide ${String(index + 1)} of ${String(count)}`}
				ref={controller}
			/>
		)
	)

	const events: ShowEvent[] = []

	for (const type of ["slide", "step", "notice", "ended", "screen"] as const) controller.current?.on(type, event => events.push(event))

	await settle()

	const stage = host.querySelector<HTMLElement>("[data-fo-show-stage]")

	if (stage === null || controller.current === null) throw new Error("no stage")

	return {
		controller: controller.current,
		events,
		onSlide,
		onEnd,
		plans,
		stage,
		key: key => {
			act(() => {
				stage.dispatchEvent(new KeyboardEvent("keydown", { key, code: codeOf(key), bubbles: true }))
			})
		},
		layerOf: (slide, index) => {
			const boxes = [...host.querySelectorAll<HTMLElement>(".fo-show-slide-box")]

			return boxes[slide]?.querySelector<HTMLElement>(`[data-fo-show-layer="${String(index)}"]`) ?? null
		}
	}
}

const TIMED: ShowSettings = {
	kind: "present",
	loop: false,
	showNarration: true,
	showAnimation: true,
	useTimings: true,
	range: { kind: "all" }
}

// An after-previous fly-in that starts with the slide (PowerPoint: the first group begins on the main sequence's begin).
function withSlide(duration: number): TimingTree {
	const b = new TimingBuilder()
	const fly = b.flyIn(3, "afterEffect", duration)
	const probe = b.mainSeq([])
	const group = b.click([[0, [fly]]], [{ delay: "indefinite" }, { evt: "onBegin", delay: 0, tn: probe.ctn.id }])
	const sequence: TimeNode = { kind: "seq", ctn: { ...probe.ctn, children: [group] } }

	return b.root([sequence])
}

function flyIn(): TimingTree {
	const b = new TimingBuilder()

	return b.root([b.mainSeq([b.click([[0, [b.flyIn(3, "clickEffect", 500)]]])])])
}

describe("SlideShow", () => {
	it("shows a slide's first state, steps its animation on a click, then moves on with the next slide's transition", async () => {
		const fade: Transition = { kind: "fade", namespace: "p", options: {}, durationMs: 500, advance: { onClick: true } }
		const show = await mount(
			new Map([
				[slides[0]!.ref, { timing: flyIn() }],
				[slides[1]!.ref, { transition: fade }]
			])
		)

		expect(show.plans[0]).toEqual({ shapes: [3], dpr: 1 })
		expect(show.onSlide).toHaveBeenLastCalledWith(0)
		// Before the click the fly-in shape is hidden.
		expect(show.layerOf(0, 0)?.style.visibility).toBe("hidden")
		expect(show.events.find(event => event.type === "slide")).toMatchObject({ index: 0, step: 0, steps: 1 })

		show.key("ArrowRight")
		await settle(250)

		const moving = show.layerOf(0, 0)

		expect(moving?.style.visibility).toBe("")
		expect(moving?.style.transform).toMatch(/^matrix\(1,0,0,1,0,\d/u)
		expect(show.events.filter(event => event.type === "step")).toEqual([{ type: "step", index: 0, step: 1 }])

		await settle(1000)
		expect(show.layerOf(0, 0)?.style.transform).toBe("")

		// Slide 2 fades in over slide 1 (both boxes on stage), then slide 1 leaves.
		show.key(" ")
		await settle(100)
		expect(show.onSlide).toHaveBeenLastCalledWith(1)
		expect(host.querySelectorAll(".fo-show-slide-box")).toHaveLength(2)
		await settle(600)
		expect(host.querySelectorAll(".fo-show-slide-box")).toHaveLength(1)

		// The hidden slide 3 is skipped.
		show.key("n")
		await settle(1000)
		expect(show.onSlide).toHaveBeenLastCalledWith(3)
		// PowerPoint's "End with black slide": the end screen first, then the next advance ends the show.
		show.key("n")
		await settle()
		expect(show.onEnd).not.toHaveBeenCalled()
		expect(show.stage.dataset["foScreen"]).toBe("end")
		show.key("n")
		await settle()
		expect(show.onEnd).toHaveBeenCalledTimes(1)
		expect(show.events.at(-1)).toEqual({ type: "ended" })
	})

	it("speaks only the page's words: the stage is a region named by its label, announcing each slide politely", async () => {
		const show = await mount(new Map())
		const stage = host.querySelector<HTMLElement>(".fo-show-stage")
		const live = stage?.querySelector<HTMLElement>("[aria-live]")

		expect(stage?.getAttribute("role")).toBe("region")
		expect(stage?.getAttribute("aria-label")).toBe("Slide show")
		expect(stage?.hasAttribute("aria-roledescription")).toBe(false)
		expect(live?.getAttribute("aria-live")).toBe("polite")
		expect(live?.textContent).toBe(`Slide 1 of ${String(slides.length)}`)

		show.key("ArrowRight")
		await settle(100)
		expect(live?.textContent).toBe(`Slide 2 of ${String(slides.length)}`)
	})

	it("plays a slide's transition sound as it enters, looping until the next sound or a stop, and stops it at the end", async () => {
		const chime: Transition = {
			kind: "fade",
			namespace: "p",
			options: {},
			durationMs: 500,
			advance: { onClick: true },
			sound: { kind: "embedded", part: "/ppt/media/audio1.wav", name: "chime.wav", loop: true }
		}
		const stop: Transition = { ...chime, sound: { kind: "stop" } }
		const sounds: { part: string; loop: boolean; stopped: boolean }[] = []
		const media: ShowMediaMount = {
			mount: () => ({ command: () => undefined, click: () => undefined, release: () => undefined }),
			sound: (_session, sound) => {
				const entry = { ...sound, stopped: false }

				sounds.push(entry)

				return {
					stop: () => {
						entry.stopped = true
					}
				}
			}
		}
		const show = await mount(
			new Map([
				[slides[1]!.ref, { transition: chime }],
				[slides[3]!.ref, { transition: stop }]
			]),
			{ media }
		)

		expect(sounds).toEqual([])
		show.key(" ")
		await settle(100)
		expect(sounds).toEqual([{ part: "/ppt/media/audio1.wav", loop: true, stopped: false }])
		await settle(600)

		// The next slide's "stop previous sound" ends it.
		show.key("n")
		await settle(1000)
		expect(show.onSlide).toHaveBeenLastCalledWith(3)
		expect(sounds.map(sound => sound.stopped)).toEqual([true])

		// Back on the sounding slide by a jump, then the end of the show stops it.
		act(() => show.controller.goto(1))
		await settle(1000)
		expect(sounds).toHaveLength(2)
		act(() => show.controller.end())
		expect(sounds.map(sound => sound.stopped)).toEqual([true, true])
	})

	it("asks for no frame while a slide waits, and wakes for an effect that begins later", async () => {
		const b = new TimingBuilder()
		const timing = b.root([
			b.mainSeq([
				b.click([
					[0, [b.flyIn(3, "clickEffect", 400)]],
					[3000, [b.flyIn(4, "afterEffect", 400)]]
				])
			])
		])
		const show = await mount(new Map([[slides[0]!.ref, { timing }]]), { keepPointer: true })

		show.key("ArrowRight")
		await settle(1000)
		expect(show.layerOf(0, 0)?.style.visibility).toBe("")
		expect(show.layerOf(0, 1)?.style.visibility).toBe("hidden")
		// Between the two: a timer for the later begin, no animation frames.
		expect(vi.getTimerCount()).toBe(1)
		await settle(3000)
		expect(show.layerOf(0, 1)?.style.visibility).toBe("")
		await settle(1000)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("hides a still mouse pointer, and keeps it where the page asks", async () => {
		const show = await mount(new Map())

		await settle(POINTER_IDLE_MS)
		expect(show.stage.getAttribute("data-fo-pointer")).toBe("hidden")
		act(() => {
			show.stage.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse", bubbles: true }))
		})
		expect(show.stage.hasAttribute("data-fo-pointer")).toBe(false)

		act(() => root.render(null))

		const kept = await mount(new Map(), { keepPointer: true })

		await settle(POINTER_IDLE_MS)
		expect(kept.stage.hasAttribute("data-fo-pointer")).toBe(false)
	})

	it("goes back a step, then to the previous slide at its end state", async () => {
		const show = await mount(new Map([[slides[0]!.ref, { timing: flyIn() }]]))

		show.key("ArrowRight")
		await settle(1000)
		show.key("ArrowRight")
		await settle(1000)
		expect(show.onSlide).toHaveBeenLastCalledWith(1)
		show.key("ArrowLeft")
		await settle(100)
		expect(show.onSlide).toHaveBeenLastCalledWith(0)
		// At its end: the fly-in shape shown where it lands.
		expect(show.layerOf(0, 0)?.style.visibility).toBe("")
		expect(show.layerOf(0, 0)?.style.transform).toBe("")
		show.key("ArrowLeft")
		await settle(100)
		expect(show.layerOf(0, 0)?.style.visibility).toBe("hidden")
	})

	it("shows every build at its end state without animation, a click and a back key moving whole slides", async () => {
		const show = await mount(new Map([[slides[0]!.ref, { timing: flyIn() }]]), {
			settings: { kind: "present", loop: false, showNarration: true, showAnimation: false, useTimings: true, range: { kind: "all" } }
		})

		expect(show.layerOf(0, 0)?.style.visibility).toBe("")
		expect(show.layerOf(0, 0)?.style.transform).toBe("")
		expect(show.events.find(event => event.type === "slide")).toMatchObject({ index: 0, step: 1, steps: 1 })
		show.key("ArrowRight")
		await settle(100)
		expect(show.onSlide).toHaveBeenLastCalledWith(1)
		expect(show.events.some(event => event.type === "step")).toBe(false)
		show.key("ArrowLeft")
		await settle(100)
		expect(show.onSlide).toHaveBeenLastCalledWith(0)
		expect(show.layerOf(0, 0)?.style.visibility).toBe("")
		show.key("ArrowLeft")
		await settle(100)
		expect(show.layerOf(0, 0)?.style.visibility).toBe("")
		expect(show.events.some(event => event.type === "step")).toBe(false)
	})

	it("keeps a slide's end state through its transition in a show without animation", async () => {
		const fade: Transition = { kind: "fade", namespace: "p", options: {}, durationMs: 500, advance: { onClick: true } }
		const show = await mount(new Map([[slides[1]!.ref, { timing: flyIn(), transition: fade }]]), {
			settings: { kind: "present", loop: false, showNarration: true, showAnimation: false, useTimings: true, range: { kind: "all" } }
		})

		show.key("ArrowRight")
		await settle(100)
		expect(show.onSlide).toHaveBeenLastCalledWith(1)
		expect(host.querySelectorAll(".fo-show-slide-box")).toHaveLength(2)
		expect(show.layerOf(1, 0)?.style.visibility).toBe("")
		await settle(1000)
		// The outgoing slide has left: the incoming one is the only box.
		expect(show.layerOf(0, 0)?.style.visibility).toBe("")
		expect(show.layerOf(0, 0)?.style.transform).toBe("")
	})

	it("plays an interactive sequence when its trigger shape is clicked, without advancing", async () => {
		const b = new TimingBuilder()
		const timing = b.root([b.mainSeq([]), b.interactive(2, [b.flyIn(3, "clickEffect", 400)])])
		const show = await mount(new Map([[slides[0]!.ref, { timing }]]))
		const trigger = host.querySelector<HTMLButtonElement>('[data-fo-trigger="2"]')

		expect(trigger).not.toBeNull()
		expect(show.layerOf(0, 0)?.style.visibility).toBe("hidden")
		act(() => trigger?.click())
		await settle(1000)
		expect(show.layerOf(0, 0)?.style.visibility).toBe("")
		expect(show.onSlide).toHaveBeenLastCalledWith(0)
	})

	it("follows actions inside the show, reports refused ones, and never acts on hover", async () => {
		const policy: PresentationActionPolicy = { link: { allow: () => true, open: vi.fn() }, refused: vi.fn() }
		const show = await mount(
			new Map([
				[
					slides[0]!.ref,
					{
						actions: {
							2: { kind: "slide", slide: slides[3]!.ref },
							4: { kind: "refused", what: "program", raw: "ppaction://program" }
						}
					}
				]
			]),
			{ policy }
		)
		const jump = host.querySelector<HTMLButtonElement>('[data-fo-action="slide"]')
		const refusedButton = host.querySelector<HTMLButtonElement>('[data-fo-action="refused"]')

		act(() => jump?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })))
		await settle()
		expect(show.onSlide).toHaveBeenLastCalledWith(0)

		act(() => refusedButton?.click())
		await settle()
		expect(policy.refused).toHaveBeenCalledWith({ kind: "refusedAction", shape: { slide: slides[0]!.ref, id: 4 }, what: "program" })
		expect(show.events.some(event => event.type === "notice")).toBe(true)
		expect(show.onSlide).toHaveBeenLastCalledWith(0)

		act(() => jump?.click())
		await settle(1000)
		expect(show.onSlide).toHaveBeenLastCalledWith(3)
	})

	it("keeps the stage focused when a hotspot is pressed, so Space goes on with the show", async () => {
		const b = new TimingBuilder()
		const timing = b.root([b.mainSeq([]), b.interactive(2, [b.flyIn(3, "clickEffect", 400)])])
		const show = await mount(new Map([[slides[0]!.ref, { timing }]]))
		const trigger = host.querySelector<HTMLButtonElement>('[data-fo-trigger="2"]')
		const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true })

		expect(document.activeElement).toBe(show.stage)
		act(() => trigger?.dispatchEvent(press))
		// The default of a press on a button focuses it (Chromium, Firefox on Windows): the hotspot never takes it.
		expect(press.defaultPrevented).toBe(true)
		act(() => trigger?.click())
		await settle(1000)
		show.key(" ")
		await settle(1000)
		expect(show.onSlide).toHaveBeenLastCalledWith(1)
	})

	it("gives the keyboard back to the stage when the focused hotspot leaves with its slide", async () => {
		const policy: PresentationActionPolicy = { link: { allow: () => true, open: vi.fn() }, refused: vi.fn() }
		const show = await mount(new Map([[slides[0]!.ref, { actions: { 2: { kind: "slide", slide: slides[1]!.ref } } }]]), { policy })
		const jump = host.querySelector<HTMLButtonElement>('[data-fo-action="slide"]')

		// Reached with Tab and pressed with Enter (the browser's activation of a focused button is its click).
		act(() => jump?.focus())
		expect(document.activeElement).toBe(jump)
		act(() => jump?.click())
		await settle(1000)
		expect(show.onSlide).toHaveBeenLastCalledWith(1)
		expect(jump?.isConnected).toBe(false)
		expect(document.activeElement).toBe(show.stage)
		act(() => {
			document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "n", code: "KeyN", bubbles: true }))
		})
		await settle(1000)
		expect(show.onSlide).toHaveBeenLastCalledWith(3)
	})

	it("advances by timing once a slide is idle, and a kiosk ignores clicks", async () => {
		const timed: Transition = { kind: "cut", namespace: "p", options: {}, durationMs: 0, advance: { onClick: true, afterMs: 2000 } }
		const show = await mount(new Map([[slides[0]!.ref, { transition: timed }]]), {
			settings: { kind: "kiosk", loop: false, showNarration: true, showAnimation: true, useTimings: true, range: { kind: "all" } }
		})

		act(() => show.stage.click())
		await settle(500)
		expect(show.onSlide).toHaveBeenLastCalledWith(0)
		await settle(2000)
		expect(show.onSlide).toHaveBeenLastCalledWith(1)
	})

	it("loops back to the first slide when the show loops", async () => {
		const show = await mount(new Map(), {
			settings: { kind: "present", loop: true, showNarration: true, showAnimation: true, useTimings: false, range: { kind: "all" } }
		})

		show.controller.goto(3)
		await settle()
		show.key("ArrowRight")
		await settle()
		expect(show.onSlide).toHaveBeenLastCalledWith(0)
		expect(show.onEnd).not.toHaveBeenCalled()
	})

	it("paints a slide whose layers cannot be drawn with the SVG compositor, and keeps going", async () => {
		const show = await mount(new Map([[slides[0]!.ref, { broken: true, timing: flyIn() }]]))

		expect(host.querySelector(`[data-fo-painted="${String(slides[0]!.ref)}"]`)).not.toBeNull()
		show.key("ArrowRight")
		await settle()
		expect(show.onSlide).toHaveBeenLastCalledWith(1)
	})

	it("toggles black and white screens, and a click returns to the slide", async () => {
		const show = await mount(new Map())

		show.key("b")
		expect(show.stage.dataset["foScreen"]).toBe("black")
		show.key("w")
		expect(show.stage.dataset["foScreen"]).toBe("white")
		act(() => show.stage.click())
		expect(show.stage.dataset["foScreen"]).toBe("slide")
		expect(show.onSlide).toHaveBeenLastCalledWith(0)
	})
})

describe("SlideView in the editor", () => {
	it("follows a Mod+click on a link or action under its selection layer, and a plain click never", () => {
		const ref = slides[0]!.ref
		const base = renderOf(ref, { actions: { 4: { kind: "url", href: "https://filen.io" } } })
		const render: SlideRender = base
		const link = vi.fn(() => "opened" as const)
		const action = vi.fn(() => "opened" as const)
		const paint: SlidePainter = (_render, context) => {
			const root = context.document.createElement("div")
			const layerElement = context.document.createElement("div")
			const span = context.document.createElement("span")

			layerElement.dataset["foLayer"] = "1"
			span.dataset["foLink"] = "0"
			layerElement.appendChild(span)
			root.appendChild(layerElement)

			return { root, release: () => undefined }
		}
		const withLink: SlideRender = {
			...render,
			layers: render.layers.map((entry, k) =>
				k === 1
					? {
							...entry,
							text: {
								page: {} as never,
								styles: [],
								paints: [],
								strokes: [],
								textEffects: [],
								decorations: [],
								links: [{ kind: "external", href: "https://filen.io/a", tooltip: undefined }]
							}
						}
					: entry
			)
		}

		act(() =>
			root.render(
				<SlideView
					render={withLink}
					size={SIZE}
					painter={paint}
					label="Slide"
					mode="edit"
					actions={{ link, action }}
					overlay={<div data-overlay="" />}
				/>
			)
		)

		const overlay = host.querySelector<HTMLElement>("[data-overlay]")
		const span = host.querySelector<HTMLElement>("[data-fo-link]")
		const hotspot = host.querySelector<HTMLElement>('[data-fo-hotspot="2"]')
		const click = (modifier: boolean): void => {
			act(() => {
				overlay?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, ctrlKey: modifier, metaKey: modifier }))
			})
		}

		expect(span).not.toBeNull()
		expect(hotspot).not.toBeNull()
		Reflect.set(document, "elementsFromPoint", () => [overlay, span])
		click(false)
		expect(link).not.toHaveBeenCalled()
		click(true)
		expect(link).toHaveBeenCalledWith(
			{ kind: "external", href: "https://filen.io/a", tooltip: undefined },
			expect.objectContaining({ mode: "edit", modifier: true })
		)

		Reflect.set(document, "elementsFromPoint", () => [overlay, hotspot])
		click(true)
		expect(action).toHaveBeenCalledWith(
			{ kind: "url", href: "https://filen.io" },
			expect.objectContaining({ mode: "edit", modifier: true, shape: { slide: ref, id: 4 } })
		)
		Reflect.deleteProperty(document, "elementsFromPoint")
	})

	it("lets clicks through its overlay to the slide's targets, and keeps the overlay's own controls", async () => {
		const policy: PresentationActionPolicy = { link: { allow: () => true, open: vi.fn() }, refused: vi.fn() }
		const tool = vi.fn()
		const show = await mount(
			new Map([[slides[0]!.ref, { actions: { 4: { kind: "refused", what: "program", raw: "ppaction://program" } } }]]),
			{
				policy,
				overlay: (
					<button
						type="button"
						data-tool=""
						style={{ pointerEvents: "auto" }}
						onClick={event => {
							event.stopPropagation()
							tool()
						}}
					/>
				)
			}
		)
		const overlay = host.querySelector<HTMLElement>(".fo-show-overlay")

		expect(overlay?.style.pointerEvents).toBe("none")
		act(() => host.querySelector<HTMLButtonElement>('[data-fo-action="refused"]')?.click())
		await settle()
		expect(policy.refused).toHaveBeenCalled()
		expect(show.onSlide).toHaveBeenLastCalledWith(0)

		const button = host.querySelector<HTMLButtonElement>("[data-tool]")

		act(() => button?.click())
		// Enter on the focused control presses it; the show does not take it as next.
		act(() => button?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })))
		await settle()
		expect(tool).toHaveBeenCalledTimes(1)
		expect(show.onSlide).toHaveBeenLastCalledWith(0)
	})

	// A user's rebind moves the command: the old key no longer runs it, on the stage as in the presenter view.
	it("runs the show's commands on the keys bound to them, and no longer on a key moved off", async () => {
		const show = await mount(new Map(), { bindings: { ...DEFAULT_SHOW_BINDINGS, next: "arrowright", end: "q" } })

		show.key("n")
		await settle()
		expect(show.onSlide).toHaveBeenLastCalledWith(0)

		show.key("Escape")
		await settle()
		expect(show.onEnd).not.toHaveBeenCalled()

		show.key("ArrowRight")
		await settle(1000)
		expect(show.onSlide).toHaveBeenLastCalledWith(1)

		show.key("q")
		await settle()
		expect(show.onEnd).toHaveBeenCalledTimes(1)
	})

	it("keeps every key inside the stage, also those the show does not use", async () => {
		const show = await mount(new Map())
		const outside = vi.fn()

		document.body.addEventListener("keydown", outside)

		for (const key of ["m", "d", "z", "F6", "Escape"]) show.key(key)

		document.body.removeEventListener("keydown", outside)
		expect(outside).not.toHaveBeenCalled()
		expect(show.onEnd).toHaveBeenCalledTimes(1)
	})

	it("plays a timed slide's transition through before it advances", async () => {
		const fade: Transition = { kind: "fade", namespace: "p", options: {}, durationMs: 1000, advance: { onClick: true, afterMs: 0 } }
		const show = await mount(new Map([[slides[1]!.ref, { transition: fade }]]), { settings: TIMED })

		show.controller.next()
		await settle(300)
		expect(show.onSlide).toHaveBeenLastCalledWith(1)
		// Mid-transition: both slide boxes on stage.
		expect(host.querySelectorAll(".fo-show-slide-box")).toHaveLength(2)
		await settle(1500)
		expect(show.onSlide).toHaveBeenLastCalledWith(3)
	})

	it("waits for a slide's automatic animations before its advance-after time passes", async () => {
		const cut: Transition = { kind: "cut", namespace: "p", options: {}, durationMs: 0, advance: { onClick: true, afterMs: 1000 } }
		const show = await mount(new Map([[slides[0]!.ref, { timing: withSlide(3000), transition: cut }]]), { settings: TIMED })

		await settle(1500)
		expect(show.onSlide).toHaveBeenLastCalledWith(0)
		await settle(3000)
		expect(show.onSlide).toHaveBeenLastCalledWith(1)
	})

	it("advances by timing in a hidden tab, where no animation frame runs", async () => {
		const fade: Transition = { kind: "fade", namespace: "p", options: {}, durationMs: 500, advance: { onClick: true, afterMs: 1000 } }
		const show = await mount(
			new Map([
				[slides[0]!.ref, { timing: withSlide(1500), transition: { ...fade, kind: "cut", durationMs: 0 } }],
				[slides[1]!.ref, { transition: fade }]
			]),
			{ settings: TIMED }
		)
		const frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1)

		await settle(2500)
		expect(show.onSlide).toHaveBeenLastCalledWith(1)
		await settle(2500)
		expect(show.onSlide).toHaveBeenLastCalledWith(3)
		frames.mockRestore()
	})

	it("samples a slide once per frame while an effect plays and a later one waits to begin", async () => {
		const b = new TimingBuilder()
		const timing = b.root([
			b.mainSeq([
				b.click([
					[0, [b.spin(3, "clickEffect", 2000)]],
					[3000, [b.flyIn(4, "afterEffect", 400)]]
				])
			])
		])
		const show = await mount(new Map([[slides[0]!.ref, { timing }]]))

		show.key("ArrowRight")
		await settle(100)

		const frames = vi.spyOn(window, "requestAnimationFrame")
		const before = sampling.count

		await settle(1000)

		const samples = sampling.count - before
		const asked = frames.mock.calls.length

		frames.mockRestore()
		expect(asked).toBeGreaterThan(30)
		// One per frame, and two per probe at most every 777 ms.
		expect(samples).toBeLessThanOrEqual(asked + 6)
	})

	it("holds at most 256 MiB of layer bitmaps over the slides it keeps", async () => {
		// Each slide at the worker's 128 MiB cap.
		const show = await mount(new Map(), { background: [8192, 4096] })

		show.controller.next()
		await settle(100)

		const bytes = Number(host.querySelector<HTMLElement>(".fo-show-host")?.dataset["foShowBytes"] ?? 0)

		expect(bytes).toBeLessThanOrEqual(256 * 1024 * 1024)
		expect(bytes).toBeGreaterThan(0)
	})
})

describe("stage colour paint", () => {
	it("hides the bitmaps of a layer's nested runs while its text shows in a colour", () => {
		const ref = slides[0]!.ref
		const drawn = (shape: number, range?: { target: "para" | "char"; range: [number, number] }): ShowLayer => ({
			shape,
			...(range === undefined ? {} : { range }),
			bitmap: new Bitmap(10, 10),
			x: 0,
			y: 0,
			width: 10,
			height: 10
		})
		// Shape 3's drawing (layer 0) with a by-letter run (layer 1) inside it.
		const stage = buildStageSlide(
			document,
			{ w: 1280, h: 720 },
			[drawn(3), drawn(3, { target: "char", range: [0, 0] })],
			layerTree(Int32Array.of(0, 1), Int32Array.of(-1, 0)),
			2
		)
		const canvases = [...stage.element.querySelectorAll<HTMLCanvasElement>("canvas.fo-show-bitmap")]

		stage.paintDom(renderOf(ref, undefined), layer => (layer.shape.id === 3 ? 0 : -1), new Set([0]), painter, undefined)
		stage.apply(
			[{ layer: 0, visible: true, opacity: 1, matrix: [1, 0, 0, 1, 0, 0], dom: { textColor: 0xff0000ff } }],
			new Float64Array(8)
		)
		expect(canvases.map(canvas => canvas.style.visibility)).toEqual(["hidden", "hidden"])
		stage.apply([{ layer: 0, visible: true, opacity: 1, matrix: [1, 0, 0, 1, 0, 0] }], new Float64Array(8))
		expect(canvases.map(canvas => canvas.style.visibility)).toEqual(["", ""])
	})

	it("tints a by-letter run's glyphs for a colour change (a dim after the build), and shows them as drawn after", () => {
		const drawn = (range?: { target: "para" | "char"; range: [number, number] }): ShowLayer => ({
			shape: 3,
			...(range === undefined ? {} : { range }),
			bitmap: new Bitmap(10, 10),
			x: 5,
			y: 6,
			width: 10,
			height: 10
		})
		const stage = buildStageSlide(
			document,
			{ w: 1280, h: 720 },
			[drawn(), drawn({ target: "char", range: [0, 0] })],
			layerTree(Int32Array.of(0, 1), Int32Array.of(-1, 0)),
			2
		)
		const run = stage.element.querySelector<HTMLElement>('[data-fo-show-layer="1"]')
		const glyphs = run?.querySelector<HTMLCanvasElement>(":scope > canvas.fo-show-bitmap")
		const still = { visible: true, opacity: 1, matrix: [1, 0, 0, 1, 0, 0] }

		stage.apply([{ layer: 1, ...still, dom: { textColor: 0xa0a0a0ff } }], new Float64Array(8))

		const tint = run?.querySelector<HTMLCanvasElement>(":scope > canvas.fo-show-tint")

		expect(glyphs?.style.visibility).toBe("hidden")
		expect(tint?.style.display).toBe("")
		expect([tint?.style.left, tint?.style.width]).toEqual(["5px", "10px"])
		stage.apply([{ layer: 1, ...still }], new Float64Array(8))
		expect(glyphs?.style.visibility).toBe("")
		expect(tint?.style.display).toBe("none")
	})

	it("applies a frame of many tinted by-letter runs in time linear in its layers", () => {
		const count = 4000
		// Shape 3's drawing (layer 0) holding `count - 1` by-letter runs (layers 1..), each drawn once.
		const drawn = Array.from({ length: count }, (_, k): ShowLayer => ({
			shape: 3,
			...(k === 0 ? {} : { range: { target: "char", range: [k - 1, k - 1] } }),
			bitmap: new Bitmap(1, 1),
			x: 0,
			y: 0,
			width: 1,
			height: 1
		}))
		const order = Int32Array.from({ length: count }, (_, k) => k)
		const parents = Int32Array.from({ length: count }, (_, k) => (k === 0 ? -1 : 0))
		const stage = buildStageSlide(document, { w: 1280, h: 720 }, drawn, layerTree(order, parents), count)
		const boxes = new Float64Array(count * 4)
		const still = { visible: true, opacity: 1, matrix: [1, 0, 0, 1, 0, 0] }
		const dimmed = Array.from({ length: count }, (_, layer) => ({ layer, ...still, dom: { textColor: 0xa0a0a0ff } }))
		const plain = Array.from({ length: count }, (_, layer) => ({ layer, ...still }))

		// Every run tinted once (its tint then held for the slide), then frames with none tinted.
		stage.apply(dimmed, boxes)
		stage.apply(plain, boxes)

		const frames = 20
		const start = cpuMs()

		for (let frame = 0; frame < frames; frame++) stage.apply(plain, boxes)

		const perFrame = (cpuMs() - start) / frames

		expect(stage.element.querySelectorAll<HTMLCanvasElement>("canvas.fo-show-tint")).toHaveLength(count)
		expect(perFrame).toBeLessThan(budget(8))
		stage.release()
	})

	it("paints a layer's colour text in a box of the slide's size, see-through", () => {
		const paint = vi.fn(painter)
		const stage = buildStageSlide(document, { w: 1280, h: 720 }, [], layerTree(Int32Array.of(0), Int32Array.of(-1)), 1)

		stage.paintDom(renderOf(slides[0]!.ref, undefined), layer => (layer.shape.id === 3 ? 0 : -1), new Set([0]), paint, undefined)

		const background = paint.mock.calls[0]?.[0].background

		expect([background?.width, background?.height]).toEqual([1280, 720])
		expect(background?.itemCount).toBe(0)
		expect(stage.element.querySelector<HTMLElement>(".fo-show-dom > *")?.style.background).toBe("transparent")
	})
})

describe("presenter mirror", () => {
	const copyLayer = (target: HTMLElement, slide: number, index: number): HTMLElement | null =>
		[...target.querySelectorAll<HTMLElement>(".fo-show-slide-box")][slide]?.querySelector<HTMLElement>(
			`[data-fo-show-layer="${String(index)}"]`
		) ?? null

	it("copies the audience frame (build state, transition, screens) as the player writes it, sampling nothing more", async () => {
		const fade: Transition = { kind: "fade", namespace: "p", options: {}, durationMs: 500, advance: { onClick: true } }
		const show = await mount(
			new Map([
				[slides[0]!.ref, { timing: flyIn() }],
				[slides[1]!.ref, { timing: flyIn(), transition: fade }]
			])
		)

		// Slide 1's build without a copy: the samples it takes.
		let before = sampling.count

		show.key("ArrowRight")
		await settle(1500)

		const alone = sampling.count - before
		const target = document.createElement("div")

		document.body.appendChild(target)

		const mirror = show.controller.mirror?.(target, 1)

		expect(mirror).toBeDefined()
		expect(target.querySelectorAll(".fo-show-slide-box")).toHaveLength(1)
		// Click targets and the stage's own scale are not copied; the bitmaps are.
		expect(target.querySelector("button")).toBeNull()
		expect(target.querySelectorAll("canvas").length).toBe(host.querySelectorAll(".fo-show-slide-box canvas").length)

		// Slide 2 fades in: both boxes in the copy, the incoming one at the audience's opacity in the same frame.
		show.key(" ")
		await settle(100)

		const boxes = (root: ParentNode): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".fo-show-slide-box")]

		expect(boxes(target)).toHaveLength(2)
		expect(boxes(target).map(box => box.style.opacity)).toEqual(boxes(host).map(box => box.style.opacity))
		await settle(600)
		expect(boxes(target)).toHaveLength(1)
		// Before its click the fly-in shape is hidden in both.
		expect(copyLayer(target, 0, 0)?.style.visibility).toBe("hidden")

		// The same build with the copy attached: the same samples, and the copy moves with the stage.
		before = sampling.count
		show.key("ArrowRight")
		await settle(250)

		const audience = show.layerOf(0, 0)

		expect(audience?.style.transform).toMatch(/^matrix\(/u)
		expect(copyLayer(target, 0, 0)?.style.transform).toBe(audience?.style.transform)
		expect(copyLayer(target, 0, 0)?.style.visibility).toBe("")
		await settle(1250)
		expect(sampling.count - before).toBe(alone)

		// Black screen: the slide hidden in the copy as on stage.
		show.key("b")
		await settle()
		expect(target.style.visibility).toBe("hidden")
		show.key("b")
		await settle()
		expect(target.style.visibility).toBe("")

		mirror?.release()
		expect(target.childNodes).toHaveLength(0)
		target.remove()
	})

	it("drops its copy when the show goes away", async () => {
		const show = await mount(new Map())
		const target = document.createElement("div")

		show.controller.mirror?.(target, 1)
		expect(target.querySelectorAll(".fo-show-slide-box")).toHaveLength(1)
		act(() => root.render(null))
		expect(target.childNodes).toHaveLength(0)
	})
})
