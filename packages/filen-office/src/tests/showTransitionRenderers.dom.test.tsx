// @vitest-environment happy-dom
import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CompiledTimegraph, Transition } from "../core/anim/model"
import { compileSource } from "../core/anim/timegraph"
import { DrawingList } from "../core/drawingml/index"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { slideRef, type SlideRef } from "../core/presentation/model"
import { drawingData } from "../core/presentation/render/slide"
import type { BitmapLike, PresentationSessionApi, ShowLayer, SlideRender } from "../dom/presentation/protocol"
import { layerParents, showLayerIndex } from "../dom/presentation/engine/show"
import type { ShowController } from "../react/presentation/show/controller"
import { SlideShow } from "../react/presentation/show/player"
import { DEFAULT_SHOW_BINDINGS } from "../react/presentation/presenter/keys"
import type { SlidePainter } from "../react/presentation/SlideView"

// The player hands a slide's own transition (the worker's `authored`, beside the fallback it draws in 2D) to the
// renderer that draws its kind: the 3D renderer on the live slide boxes, a renderer prepared while the slide is
// prepared (again for another outgoing slide), and the fallback from where a renderer stops drawing.

const fake = vi.hoisted(() => ({
	prepares: [] as { outgoing: unknown; incoming: unknown }[],
	released: 0,
	frames: 0,
	finished: 0,
	lose: false,
	warms: [] as (readonly string[])[],
	warmReleased: 0
}))

vi.mock(import("../react/presentation/show/webgl/index"), () => ({
	webglTransitions: {
		draws: (kind: string, namespace: string) => kind === "vortex" && namespace === "p14",
		warm: (_document: Document, kinds: readonly string[]) => {
			fake.warms.push(kinds)

			return {
				release: () => {
					fake.warmReleased++
				}
			}
		},
		prepare: (request: { outgoing: unknown; incoming: unknown }) => {
			fake.prepares.push({ outgoing: request.outgoing, incoming: request.incoming })

			return Promise.resolve({
				outgoing: request.outgoing as SlideRef | undefined,
				bytes: 1000,
				release: () => {
					fake.released++
				}
			})
		},
		start: () => ({
			frame: () => {
				fake.frames++

				return !(fake.lose && fake.frames > 1)
			},
			finish: () => {
				fake.finished++
			}
		})
	}
}))

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const SIZE = { cx: 12_192_000, cy: 6_858_000 }

class Bitmap implements BitmapLike {
	readonly width: number
	readonly height: number

	constructor(width: number, height: number) {
		this.width = width
		this.height = height
	}

	close(): void {}
}

const slides = [0, 1, 2].map(n => ({ ref: slideRef(500 + n), hidden: false }))

function background(): ReturnType<typeof drawingData> {
	const list = new DrawingList()

	list.width = 1280
	list.height = 720

	return drawingData(list)
}

function session(
	transitions: ReadonlyMap<SlideRef, { transition: Transition; authored: Transition }>,
	kinds?: readonly string[]
): PresentationSessionApi {
	return {
		timegraph: (ref: SlideRef): Promise<CompiledTimegraph> => {
			const layers = showLayerIndex(undefined)
			const own = transitions.get(ref)
			const source = {
				timing: undefined,
				layers,
				parents: layerParents(layers, []),
				slideSize: SIZE,
				geometry: new Float64Array(0),
				colors: [],
				...(own === undefined ? {} : { transition: own.transition, authored: own.authored }),
				...(kinds === undefined ? {} : { transitionKinds: kinds })
			}
			const graph = compileSource(ref, source, DEFAULT_PRESENTATION_BUDGETS.timing)

			return Promise.resolve({ slide: ref, mainSteps: graph.mainSteps, interactive: graph.interactive, tracks: graph.tracks, source })
		},
		layers: (): Promise<readonly ShowLayer[]> =>
			Promise.resolve([{ shape: -1, bitmap: new Bitmap(640, 360), x: 0, y: 0, width: 1280, height: 720 }])
	} as unknown as PresentationSessionApi
}

const painter: SlidePainter = vi.fn(() => ({ root: document.createElement("div"), release: vi.fn() }))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] })
	vi.stubGlobal("CSS", { supports: (property: string, value: string) => property === "transform" && value.startsWith("matrix3d(") })
	Object.assign(fake, { prepares: [], released: 0, frames: 0, finished: 0, lose: false, warms: [], warmReleased: 0 })
	host = document.createElement("div")
	document.body.appendChild(host)
	root = createRoot(host)
})

afterEach(() => {
	act(() => root.unmount())
	host.remove()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

async function settle(ms = 0): Promise<void> {
	await act(async () => {
		for (let k = 0; k < 10; k++) await Promise.resolve()

		await vi.advanceTimersByTimeAsync(ms)

		for (let k = 0; k < 10; k++) await Promise.resolve()
	})
}

async function mount(
	transitions: ReadonlyMap<SlideRef, { transition: Transition; authored: Transition }>,
	kinds?: readonly string[]
): Promise<ShowController> {
	const controller = createRef<ShowController>()
	const renders = new Map(
		slides.map(slide => [
			slide.ref,
			{
				ref: slide.ref,
				index: Number(slide.ref) - 500,
				revision: 0,
				hidden: false,
				background: background(),
				layers: [],
				notesText: "",
				animated: false
			} as SlideRender
		])
	)

	act(() =>
		root.render(
			<SlideShow
				slides={slides}
				customShows={[]}
				bindings={DEFAULT_SHOW_BINDINGS}
				renders={renders}
				size={SIZE}
				painter={painter}
				session={session(transitions, kinds)}
				onSlide={vi.fn()}
				onEnd={vi.fn()}
				label="Slide show"
				slideLabel={(index, count) => `Slide ${String(index + 1)} of ${String(count)}`}
				ref={controller}
			/>
		)
	)
	await settle()

	if (controller.current === null) throw new Error("no controller")

	return controller.current
}

const push: Transition = { kind: "push", namespace: "p", options: { dir: "l" }, durationMs: 1000, advance: { onClick: true } }

function boxes(): HTMLElement[] {
	return [...host.querySelectorAll<HTMLElement>(".fo-show-slide-box")]
}

describe("SlideShow transition renderers", () => {
	it("plays a p14 flip in 3D on the two slide boxes", async () => {
		const flip: Transition = { kind: "flip", namespace: "p14", options: {}, durationMs: 1000, advance: { onClick: true } }
		const show = await mount(new Map([[slides[1]!.ref, { transition: push, authored: flip }]]))

		show.next()
		await settle(200)
		expect(boxes().some(box => box.style.transform.startsWith("matrix3d("))).toBe(true)
		await settle(1200)
		expect(boxes().map(box => box.style.transform)).toEqual([""])
	})

	it("plays the fallback of a p14 flip without CSS 3D", async () => {
		vi.stubGlobal("CSS", { supports: () => false })

		const flip: Transition = { kind: "flip", namespace: "p14", options: {}, durationMs: 1000, advance: { onClick: true } }
		const show = await mount(new Map([[slides[1]!.ref, { transition: push, authored: flip }]]))

		show.next()
		await settle(200)
		expect(boxes().some(box => box.style.transform.startsWith("translate("))).toBe(true)
		expect(boxes().some(box => box.style.transform.startsWith("matrix3d("))).toBe(false)
	})

	it("prepares a renderer's transition with the slide and again for another outgoing slide, and releases it", async () => {
		const vortex: Transition = { kind: "vortex", namespace: "p14", options: {}, durationMs: 1000, advance: { onClick: true } }
		const show = await mount(new Map([[slides[1]!.ref, { transition: push, authored: vortex }]]))

		// Prefetched as the next slide: prepared against the first.
		await settle(10)
		expect(fake.prepares).toEqual([{ outgoing: slides[0]!.ref, incoming: slides[1]!.ref }])

		// Entered from the third slide instead: prepared again for that pair, the first preparation released.
		show.goto(2)
		await settle(1500)
		show.goto(1)
		await settle(100)
		expect(fake.prepares.at(-1)).toEqual({ outgoing: slides[2]!.ref, incoming: slides[1]!.ref })
		expect(fake.released).toBeGreaterThanOrEqual(1)
		expect(fake.frames).toBeGreaterThan(0)
		await settle(1500)
		expect(fake.finished).toBe(1)

		act(() => root.unmount())
		root = createRoot(host)
		expect(fake.released).toBe(fake.prepares.length)
	})

	it("warms the renderers once with the deck's transition kinds at show entry, and releases them when the show ends", async () => {
		const show = await mount(new Map(), ["vortex"])

		await settle(10)
		expect(fake.warms).toEqual([["vortex"]])

		show.next()
		await settle(1500)
		expect(fake.warms).toHaveLength(1)
		expect(fake.warmReleased).toBe(0)

		act(() => root.unmount())
		root = createRoot(host)
		expect(fake.warmReleased).toBe(1)
	})

	it("warms nothing for a deck whose source names no transition kinds", async () => {
		await mount(new Map())
		await settle(10)
		expect(fake.warms).toEqual([])
	})

	it("plays the fallback from where a renderer stops drawing", async () => {
		const vortex: Transition = { kind: "vortex", namespace: "p14", options: {}, durationMs: 1000, advance: { onClick: true } }
		const show = await mount(new Map([[slides[1]!.ref, { transition: push, authored: vortex }]]))

		fake.lose = true
		show.next()
		await settle(100)
		await settle(100)
		expect(fake.finished).toBe(1)
		expect(boxes().some(box => box.style.transform.startsWith("translate("))).toBe(true)
		await settle(1200)
		expect(boxes()).toHaveLength(1)
	})
})
