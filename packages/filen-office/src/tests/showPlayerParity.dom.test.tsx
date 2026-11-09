// @vitest-environment happy-dom
import { act, createRef } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CompiledTimegraph, TimingTree, Transition } from "../core/anim/model"
import { compileSource } from "../core/anim/timegraph"
import { DrawingList } from "../core/drawingml/index"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { slideRef, type ShowSettings, type SlideRef } from "../core/presentation/model"
import { drawingData } from "../core/presentation/render/slide"
import type { BitmapLike, LayerPlan, PresentationSessionApi, ShowLayer, SlideLayer, SlideRender } from "../dom/presentation/protocol"
import { layerParents, showLayerIndex } from "../dom/presentation/engine/show"
import type { ShowController, ShowEvent } from "../react/presentation/show/controller"
import { SlideShow } from "../react/presentation/show/player"
import type { ShowMediaControl, ShowMediaMount } from "../react/presentation/show/stage"
import { TimingBuilder } from "./animFixtures"

// The player against PowerPoint's slide show: the black end screen after the last slide, a slide whose "On Mouse
// Click" is off, media that play across slides, the media keys, and a kiosk that restarts untouched.

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

const SIZE = { cx: 12_192_000, cy: 6_858_000 }
const EMU = 9525

class Bitmap implements BitmapLike {
	readonly width: number
	readonly height: number

	constructor(width: number, height: number) {
		this.width = width
		this.height = height
	}

	close(): void {}
}

function drawing(width: number, height: number): ReturnType<typeof drawingData> {
	const list = new DrawingList()

	list.width = width
	list.height = height

	return drawingData(list)
}

interface SlideSpec {
	readonly timing?: TimingTree
	readonly transition?: Transition
	// Shape 4 is a medium.
	readonly media?: true
}

const slides = [0, 1, 2].map(n => ({ ref: slideRef(500 + n), hidden: false }))

function renderOf(ref: SlideRef, spec: SlideSpec | undefined): SlideRender {
	return {
		ref,
		index: Number(ref) - 500,
		revision: 0,
		hidden: false,
		background: drawing(1280, 720),
		layers: [2, 3, 4].map((id): SlideLayer => ({
			shape: { slide: ref, id },
			drawing: drawing(100, 50),
			matrix: [1, 0, 0, 1, id * 150, 100],
			role: "shape",
			box: { id, xfrm: { x: id * 150 * EMU, y: 100 * EMU, cx: 100 * EMU, cy: 50 * EMU, rot: 0, flipH: false, flipV: false } },
			...(id === 4 && spec?.media === true
				? { media: { kind: "audio", part: `/ppt/media/m${String(ref)}.mp3`, contentType: "audio/mpeg" } }
				: {})
		})),
		notesText: "",
		animated: spec?.timing !== undefined
	}
}

function session(specs: ReadonlyMap<SlideRef, SlideSpec>): PresentationSessionApi {
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
		layers: (_ref: SlideRef, _width: number, plan: LayerPlan): Promise<readonly ShowLayer[]> => {
			const out: ShowLayer[] = [{ shape: -1, bitmap: new Bitmap(64, 36), x: 0, y: 0, width: 1280, height: 720 }]

			for (const id of plan.shapes) out.push({ shape: id, bitmap: new Bitmap(10, 5), x: id * 150, y: 100, width: 100, height: 50 })

			return Promise.resolve(out)
		}
	}

	return api as unknown as PresentationSessionApi
}

// A stand-in medium per mounted media layer: what it was told, and whether it plays.
interface FakeMedium {
	readonly part: string
	readonly box: HTMLElement
	readonly log: string[]
	playing: boolean
	released: boolean
}

function fakeMedia(): { readonly mount: ShowMediaMount; readonly media: FakeMedium[] } {
	const media: FakeMedium[] = []
	const mount: ShowMediaMount = {
		mount: (box, layer) => {
			const medium: FakeMedium = { part: layer.media?.part ?? "", box, log: [], playing: false, released: false }

			media.push(medium)

			return {
				command: command => {
					medium.log.push(command.command)

					if (command.command === "play" || command.command === "resume") medium.playing = true
					else if (command.command === "toggle") medium.playing = !medium.playing
					else if (command.command === "pause" || command.command === "stop") medium.playing = false
				},
				click: () => {
					medium.playing = !medium.playing
				},
				playing: () => medium.playing,
				control: (control: ShowMediaControl) => {
					medium.log.push(control.kind === "seekBy" ? `seekBy ${String(control.ms)}` : control.kind)
				},
				release: () => {
					medium.released = true
				}
			}
		}
	}

	return { mount, media }
}

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
	readonly stage: HTMLElement
	key(key: string, init?: KeyboardEventInit): void
	// The layer element of a shape on the slide on stage.
	layer(shape: number): HTMLElement | null
}

async function mount(
	specs: ReadonlyMap<SlideRef, SlideSpec>,
	extra: { settings?: ShowSettings; media?: ShowMediaMount } = {}
): Promise<Mounted> {
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
				painter={(_render, context) => ({ root: context.document.createElement("div"), release: () => undefined })}
				session={session(specs)}
				{...(extra.settings === undefined ? {} : { settings: extra.settings })}
				{...(extra.media === undefined ? {} : { media: extra.media })}
				onSlide={onSlide}
				onEnd={onEnd}
				label="Slide show"
				endLabel="End of slide show, click to exit."
				slideLabel={(index, count) => `Slide ${String(index + 1)} of ${String(count)}`}
				ref={controller}
			/>
		)
	)

	const events: ShowEvent[] = []

	for (const type of ["slide", "ended", "screen"] as const) controller.current?.on(type, event => events.push(event))

	await settle()

	const stage = host.querySelector<HTMLElement>("[data-fo-show-stage]")

	if (stage === null || controller.current === null) throw new Error("no stage")

	return {
		controller: controller.current,
		events,
		onSlide,
		onEnd,
		stage,
		layer: shape =>
			host
				.querySelector<HTMLElement>(`.fo-show-host > .fo-show-slide-box [data-fo-show-shape="${String(shape)}"]`)
				?.closest<HTMLElement>(".fo-show-layer") ?? null,
		key: (key, init = {}) => {
			act(() => {
				stage.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }))
			})
		}
	}
}

const PRESENT: ShowSettings = {
	kind: "present",
	loop: false,
	showNarration: true,
	showAnimation: true,
	useTimings: true,
	range: { kind: "all" }
}

describe("end of the slide show", () => {
	it("shows a black end screen after the last slide; the next advance ends the show, back returns to the last slide", async () => {
		const show = await mount(new Map())

		show.controller.goto(2)
		await settle()
		show.key("ArrowRight")
		await settle()
		expect(show.onEnd).not.toHaveBeenCalled()
		expect(show.stage.dataset["foScreen"]).toBe("end")
		expect(show.stage.querySelector(".fo-show-end")?.textContent).toBe("End of slide show, click to exit.")
		expect(show.events.at(-1)).toEqual({ type: "screen", screen: "end" })

		// B on the end screen leaves it black; PageUp goes back to the last slide.
		show.key("b")
		expect(show.stage.dataset["foScreen"]).toBe("end")
		show.key("PageUp")
		expect(show.stage.dataset["foScreen"]).toBe("slide")
		expect(show.onSlide).toHaveBeenLastCalledWith(2)

		show.key(" ")
		await settle()
		expect(show.onEnd).not.toHaveBeenCalled()
		act(() => show.stage.click())
		expect(show.onEnd).toHaveBeenCalledTimes(1)
	})

	it("reaches the end screen by the last slide's timing, and waits there", async () => {
		const timed: Transition = { kind: "cut", namespace: "p", options: {}, durationMs: 0, advance: { onClick: true, afterMs: 1000 } }
		const show = await mount(new Map([[slides[2]!.ref, { transition: timed }]]), { settings: PRESENT })

		show.controller.goto(2)
		await settle(1500)
		expect(show.stage.dataset["foScreen"]).toBe("end")
		await settle(10_000)
		expect(show.onEnd).not.toHaveBeenCalled()
		show.key("Escape")
		expect(show.onEnd).toHaveBeenCalledTimes(1)
	})
})

describe("On Mouse Click off", () => {
	it("plays the slide's click builds on a click but never leaves the slide; keys still advance", async () => {
		const b = new TimingBuilder()
		const timing = b.root([b.mainSeq([b.click([[0, [b.flyIn(3, "clickEffect", 400)]]])])])
		const noClick: Transition = { kind: "cut", namespace: "p", options: {}, durationMs: 0, advance: { onClick: false } }
		const show = await mount(new Map([[slides[0]!.ref, { timing, transition: noClick }]]))

		act(() => show.stage.click())
		await settle(1000)
		expect(show.layer(3)?.style.visibility).toBe("")

		act(() => show.stage.click())
		await settle(1000)
		expect(show.onSlide).toHaveBeenLastCalledWith(0)

		show.key("ArrowRight")
		await settle()
		expect(show.onSlide).toHaveBeenLastCalledWith(1)
	})
})

function background(b: TimingBuilder, numSld: number): TimingTree {
	return b.root([
		b.mainSeq([]),
		b.behavior({ type: "audio", target: { kind: "shape", shape: 4 }, numSld }, { stCondLst: [{ delay: "indefinite" }] })
	])
}

describe("Play Across Slides", () => {
	it("plays a medium over its numSld slides, then stops and releases it; an ordinary one stops with its slide", async () => {
		const { mount: media, media: mounted } = fakeMedia()
		const show = await mount(
			new Map([
				[slides[0]!.ref, { timing: background(new TimingBuilder(), 2), media: true }],
				[slides[1]!.ref, { media: true }]
			]),
			{ media }
		)
		const first = mounted[0]

		expect(first?.part).toBe(`/ppt/media/m${String(slides[0]!.ref)}.mp3`)
		act(() => first?.box.click())
		expect(first?.playing).toBe(true)

		show.key("ArrowRight")
		await settle()
		expect(show.onSlide).toHaveBeenLastCalledWith(1)
		// Still playing, in the document (an element taken out of it is paused).
		expect(first?.log).not.toContain("stop")
		expect(first?.released).toBe(false)
		expect(first?.box.isConnected).toBe(true)

		const second = mounted.find(medium => medium.part.endsWith(`m${String(slides[1]!.ref)}.mp3`))

		act(() => second?.box.click())
		show.key("ArrowRight")
		await settle()
		expect(show.onSlide).toHaveBeenLastCalledWith(2)
		// numSld 2: its own slide and one more.
		expect(first?.log).toContain("stop")
		expect(first?.released).toBe(true)
		expect(first?.box.isConnected).toBe(false)
		expect(second?.log).toContain("stop")
	})

	it("stops a carried medium when its slide is shown again, which mounts it anew; the end stops every carried one", async () => {
		const { mount: media, media: mounted } = fakeMedia()
		const show = await mount(new Map([[slides[0]!.ref, { timing: background(new TimingBuilder(), 999), media: true }]]), { media })
		const first = mounted[0]

		act(() => first?.box.click())
		show.key("ArrowRight")
		await settle()
		expect(first?.released).toBe(false)

		show.controller.goto(0)
		await settle()
		expect(first?.released).toBe(true)
		expect(mounted).toHaveLength(2)

		const again = mounted[1]

		expect(again?.box.isConnected).toBe(true)
		act(() => again?.box.click())
		show.key("ArrowRight")
		await settle()
		expect(again?.released).toBe(false)
		act(() => show.controller.end())
		expect(again?.released).toBe(true)
	})
})

describe("Show without narration", () => {
	// Recorded narration as PowerPoint writes it: an after-previous playFrom(0.0) on the slide's audio shape starting with
	// the slide, and that shape's p:audio isNarration beside the main sequence.
	function narrated(b: TimingBuilder): TimingTree {
		const play = b.effect(4, { presetID: 1, presetClass: "mediacall", presetSubtype: 0, nodeType: "afterEffect" }, 0, [
			b.behavior(
				{ type: "cmd", common: { target: { kind: "shape", shape: 4 }, attrNames: [] }, cmdType: "call", cmd: "playFrom(0.0)" },
				{ dur: 1 }
			)
		])
		const probe = b.mainSeq([])
		const group = b.click([[0, [play]]], [{ delay: "indefinite" }, { evt: "onBegin", delay: 0, tn: probe.ctn.id }])

		return b.root([
			{ kind: "seq", ctn: { ...probe.ctn, children: [group] } },
			b.behavior({ type: "audio", target: { kind: "shape", shape: 4 }, isNarration: true }, { stCondLst: [{ delay: "indefinite" }] })
		])
	}

	const absent: ShowSettings = { kind: "present", loop: false, showAnimation: true, useTimings: true, range: { kind: "all" } }

	it.each([
		['showNarration="0"', { ...absent, showNarration: false }, false],
		['showNarration="1"', { ...absent, showNarration: true }, true],
		["no showNarration", absent, true]
	] as const)("plays or skips recorded narration as PowerPoint does with %s", async (_name, settings, plays) => {
		const { mount: media, media: mounted } = fakeMedia()

		await mount(new Map([[slides[0]!.ref, { timing: narrated(new TimingBuilder()), media: true }]]), { settings, media })
		await settle(500)
		expect(mounted).toHaveLength(1)
		expect(mounted[0]?.log.includes("play")).toBe(plays)
	})
})

describe("media keys", () => {
	it("plays, pauses, stops, seeks and mutes the slide's medium by PowerPoint's chords, and Alt never reaches the show's keys", async () => {
		const { mount: media, media: mounted } = fakeMedia()
		const show = await mount(new Map([[slides[0]!.ref, { media: true }]]), { media })
		const medium = mounted[0]

		show.key("π", { code: "KeyP", altKey: true })
		expect(medium?.playing).toBe(true)
		show.key(" ", { code: "Space", ctrlKey: true })
		expect(medium?.playing).toBe(false)
		show.key("PageDown", { code: "PageDown", altKey: true, shiftKey: true })
		show.key("ArrowLeft", { code: "ArrowLeft", altKey: true, shiftKey: true })
		show.key("u", { code: "KeyU", altKey: true })
		show.key("ArrowUp", { code: "ArrowUp", altKey: true })
		show.key("End", { code: "End", altKey: true })
		show.key("q", { code: "KeyQ", altKey: true })
		expect(medium?.log).toEqual(["toggle", "toggle", "seekBy 3000", "seekBy -250", "mute", "volumeBy", "bookmark", "stop"])

		// Alt+B is no black screen, Ctrl+ArrowRight no next slide.
		show.key("b", { code: "KeyB", altKey: true })
		expect(show.stage.dataset["foScreen"]).toBe("slide")
		show.key("ArrowRight", { code: "ArrowRight", ctrlKey: true })
		await settle()
		expect(show.onSlide).toHaveBeenLastCalledWith(0)
	})
})

describe("kiosk restart", () => {
	it("goes back to the first slide after the inactivity time with no input at all", async () => {
		const timed: Transition = { kind: "cut", namespace: "p", options: {}, durationMs: 0, advance: { onClick: true, afterMs: 1000 } }
		const kiosk: ShowSettings = { ...PRESENT, kind: "kiosk", loop: true, restartMs: 300_000 }
		const show = await mount(new Map([[slides[0]!.ref, { transition: timed }]]), { settings: kiosk })

		await settle(1500)
		expect(show.onSlide).toHaveBeenLastCalledWith(1)
		await settle(298_600)
		expect(show.onSlide).toHaveBeenLastCalledWith(0)
	})
})
