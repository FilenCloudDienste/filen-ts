import type { CompiledTimegraph, LayerState, TimeEvent, TimegraphInstance, TimegraphSource, Transition } from "../../../core/anim/model"
import { attributeEntry } from "../../../core/anim/attributes"
import { compileSource, instantiate } from "../../../core/anim/timegraph"
import type { DocxLinkTarget } from "../../../core/docx/layout/pageData"
import { EMU_PER_PX } from "../../../core/drawingml/index"
import { DEFAULT_PRESENTATION_BUDGETS } from "../../../core/presentation/budget"
import { PresentationError, type Action, type CustomShow, type SlideRef } from "../../../core/presentation/model"
import type { PresentationNotice, PresentationSessionApi, ShowLayer, SlideLayer, SlideRender } from "../../../dom/presentation/protocol"
import {
	presentationActions,
	type ActionTrigger,
	type PresentationActionActivator,
	type PresentationActionPolicy,
	type PresentationJump
} from "../links"
import type { PaintedSlide, SlidePainter } from "../SlideView"
import type { ShowController, ShowEvent, ShowEventType, ShowFrom, ShowScreen, ShowStart } from "./controller"
import { layerBoxes, layerIndices, layerPlanOf, layerTree } from "./layers"
import { buildStageSlide, type ShowMediaHandle, type ShowMediaMount, type StageSlide } from "./stage"
import { advanceAt, ShowNavigator, type ShowOptions, type ShowPosition, type ShowSlide } from "./timeline"
import { transitionDurationMs, transitionStyles } from "./transitions"

// The slide show player: a ShowController over the slides' timegraphs and the worker's layer bitmaps. Each slide is
// prepared before it is shown (its timing compiled here from the worker's source, its layers drawn by the worker at the
// stage's size) while the one before plays; the slide after the current one is prepared ahead. A frame samples the
// current slide's timegraph and writes compositor properties only; the frame loop runs while something moves and
// stops when nothing will (no CPU while a slide waits for a click), waking for the next timed begin. Transitions play
// on the two slide boxes. A slide whose layers cannot be drawn is painted by the SVG compositor, without animation.

export interface PlayerProps {
	readonly slides: readonly ShowSlide[]
	readonly customShows: readonly CustomShow[]
	readonly renders: ReadonlyMap<SlideRef, SlideRender>
	// EMU.
	readonly size: { readonly cx: number; readonly cy: number }
	readonly painter: SlidePainter
	readonly session: PresentationSessionApi | undefined
	readonly options: ShowOptions
	readonly policy: PresentationActionPolicy | undefined
	readonly actions: PresentationActionActivator | undefined
	readonly media: ShowMediaMount | undefined
	readonly onSlide: ((index: number) => void) | undefined
	readonly onEnd: () => void
	readonly labels: {
		readonly action: (action: Action, layer: SlideLayer) => string
		readonly trigger: (layer: SlideLayer) => string
		readonly link: (link: DocxLinkTarget) => string
	}
}

// What the player tells its React shell.
export interface PlayerView {
	slide(index: number): void
	screen(screen: ShowScreen): void
}

interface Prepared {
	readonly index: number
	readonly ref: SlideRef
	// The stage width (CSS px) the layers were drawn for.
	readonly width: number
	readonly stage: StageSlide
	readonly graph: CompiledTimegraph | undefined
	readonly source: TimegraphSource | undefined
	readonly boxes: Float64Array
	readonly transition: Transition | undefined
	readonly triggers: ReadonlySet<number>
	// Whole-shape layer by shape id.
	readonly layerOf: ReadonlyMap<number, number>
	// Layers whose colours or text style animate (painted again as DOM for those frames).
	readonly domLayers: ReadonlySet<number>
	// The render its click targets (or its fallback paint) came from.
	render: SlideRender | undefined
	painted: PaintedSlide | undefined
	// Shown without layers (the SVG compositor).
	readonly fallback: boolean
}

interface Playing {
	readonly prepared: Prepared
	readonly instance: TimegraphInstance | undefined
	// performance time of the slide's t = 0.
	clock: number
	readonly shownAt: number
	step: number
	readonly steps: number
	// The media commands sent, by shape.
	readonly media: Map<number, string>
	// While no probe found the slide settled again.
	busyUntil: number
	// Shapes whose font-size effect was reported.
	readonly scaled: Set<number>
	// The slide's timeline began (its transition is over): its timed advance may be armed.
	began: boolean
}

interface TransitionRun {
	readonly from: Prepared | undefined
	readonly to: Prepared
	readonly transition: Transition
	readonly start: number
	readonly duration: number
}

const BUDGETS = DEFAULT_PRESENTATION_BUDGETS.timing
// Main-sequence steps are fired this far apart when a slide is shown at its end (previous from the next slide).
const STEP_SPACING_MS = 10 * 60 * 1000
// A slide is settled when samples this far ahead equal the current one (an indefinitely repeating effect differs).
const PROBES_MS = [333, 777] as const
// Until a frame wakes the loop for a timed begin that is further away than this, the loop sleeps on a timer.
const AWAKE_MS = 48
// Stage widths are drawn again once the stage grew past this ratio of what the layers were drawn for.
const REDRAW_RATIO = 1.25
// Layer bitmap bytes held over all prepared slides (each slide's own are capped by the worker at half of it): the
// slide on stage is pinned, the one before it goes first.
export const SHOW_HELD_BYTES = 256 * 1024 * 1024
// A transition also ends on a timer this long after its duration: animation frames never run in a hidden tab.
const TRANSITION_GRACE_MS = 100
const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", "PageDown", " ", "Enter", "n", "N"])
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p", "P"])

type Listeners = { [T in ShowEventType]?: Set<(event: Extract<ShowEvent, { type: T }>) => void> }

function modifierOf(event: { readonly metaKey: boolean; readonly ctrlKey: boolean }): boolean {
	const platform: unknown = Reflect.get(Reflect.get(globalThis, "navigator") ?? {}, "platform")
	const apple = typeof platform === "string" && /Mac|iPhone|iPad/u.test(platform)

	return apple ? event.metaKey : event.ctrlKey
}

function stepOf(instance: TimegraphInstance): number {
	return instance.snapshot().step
}

export class ShowPlayer implements ShowController {
	private props: PlayerProps
	private readonly view: PlayerView
	private readonly host: HTMLDivElement
	private readonly document: Document
	private readonly window: Window
	private nav: ShowNavigator
	private readonly cache = new Map<number, { readonly width: number; readonly promise: Promise<Prepared | undefined> }>()
	private readonly ready = new Map<number, Prepared>()
	private playing: Playing | undefined
	private run: TransitionRun | undefined
	private screenState: ShowScreen = "slide"
	private ended = false
	private disposed = false
	private readonly listeners: Listeners = {}
	private raf = 0
	private wake: ReturnType<typeof setTimeout> | undefined
	private advance: ReturnType<typeof setTimeout> | undefined
	private wakeAt = Number.NaN
	private transitionEnd: ReturnType<typeof setTimeout> | undefined
	private restart: ReturnType<typeof setTimeout> | undefined
	// Bumped by every navigation: an older navigation's preparation does not show its slide.
	private generation = 0
	private stageWidth = 0
	private dpr = 1
	private readonly blackout: HTMLDivElement
	private activator: PresentationActionActivator | undefined

	constructor(host: HTMLDivElement, props: PlayerProps, view: PlayerView) {
		this.host = host
		this.props = props
		this.view = view
		this.document = host.ownerDocument
		this.window = this.document.defaultView ?? (globalThis as unknown as Window)
		this.nav = new ShowNavigator(props.slides, props.customShows, props.options)
		this.blackout = this.document.createElement("div")
		this.blackout.className = "fo-show-black"
		this.blackout.style.cssText = "position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;z-index:2"
		this.host.appendChild(this.blackout)
		this.activator = this.activatorOf(props)
	}

	// --- Props and size ---

	update(props: PlayerProps): void {
		const rendersChanged = props.renders !== this.props.renders

		this.props = props
		this.activator = this.activatorOf(props)

		if (!rendersChanged) return

		for (const prepared of this.ready.values()) this.place(prepared)
	}

	// The stage's slide width on screen (CSS px) and the device pixel ratio.
	resize(width: number, dpr: number): void {
		const grew = this.stageWidth > 0 && width > this.stageWidth * REDRAW_RATIO

		this.stageWidth = width
		this.dpr = dpr

		if (!grew) return

		// Drawn again at the new size from the next preparation on; the slide on stage is swapped once redrawn.
		for (const [index, entry] of this.cache) {
			if (entry.width * REDRAW_RATIO < width && index !== this.playing?.prepared.index) this.evict(index)
		}

		const current = this.playing

		if (current === undefined || current.prepared.fallback) return

		const generation = this.generation

		void this.prepare(current.prepared.index, true).then(prepared => {
			if (prepared === undefined || generation !== this.generation || this.playing !== current) return

			this.swap(current, prepared)
		})
	}

	private activatorOf(props: PlayerProps): PresentationActionActivator | undefined {
		if (props.policy === undefined) return props.actions

		const policy = props.policy

		return presentationActions({
			...policy,
			navigate: jump => {
				this.jump(jump)
			},
			refused: notice => {
				policy.refused?.(notice)
				this.emit({ type: "notice", notice })
			},
			media: request => {
				this.playing?.prepared.stage.media.get(request.shape.id)?.click()
				policy.media?.(request)
			}
		})
	}

	// --- Controller ---

	start(from?: ShowFrom): Promise<ShowStart> {
		if (this.disposed) return Promise.resolve({ kind: "refused", reason: "closed" })

		this.ended = false

		if (from !== undefined && "customShow" in from) {
			if (!this.nav.enterCustom(from.customShow, false)) return Promise.resolve({ kind: "refused", reason: "notFound" })

			return this.show(this.nav.position, { transition: true }).then(() => ({ kind: "started" }) as const)
		}

		const index =
			from === undefined ? undefined : "index" in from ? from.index : this.props.slides.findIndex(slide => slide.ref === from.slide)

		if (index === undefined && this.nav.length === 0) return Promise.resolve({ kind: "refused", reason: "notFound" })
		if (index !== undefined && (index < 0 || index >= this.props.slides.length))
			return Promise.resolve({ kind: "refused", reason: "notFound" })

		return this.show(index === undefined ? this.nav.first() : this.nav.at(index), { transition: true }).then(
			() => ({ kind: "started" }) as const
		)
	}

	next(): void {
		this.input()

		if (this.ended) return
		if (this.screenState !== "slide") {
			this.setScreen("slide")

			return
		}

		// A click during a transition completes it.
		if (this.run !== undefined) {
			this.finishTransition(this.now())

			return
		}

		const playing = this.playing
		const instance = playing?.instance

		if (playing !== undefined && instance !== undefined && playing.step < playing.steps) {
			instance.fire({ kind: "next" }, this.now() - playing.clock)

			const step = stepOf(instance)

			if (step <= playing.steps) {
				playing.step = step
				this.emit({ type: "step", index: playing.prepared.index, step })
				this.kick()

				return
			}
		}

		this.forward()
	}

	prev(): void {
		this.input()

		if (this.ended) return
		if (this.screenState !== "slide") {
			this.setScreen("slide")

			return
		}

		const playing = this.playing

		if (this.run !== undefined) this.finishTransition(this.now())

		if (playing?.instance !== undefined && playing.step > 0) {
			playing.instance.fire({ kind: "prev" }, this.now() - playing.clock)
			playing.step = stepOf(playing.instance)
			this.emit({ type: "step", index: playing.prepared.index, step: playing.step })
			this.kick()

			return
		}

		const move = this.nav.following(-1)

		if (move.kind === "slide") void this.show(move.position, { transition: false, atEnd: true })
	}

	goto(index: number): void {
		this.input()

		if (this.ended || index < 0 || index >= this.props.slides.length) return

		void this.show(this.nav.at(index), { transition: true })
	}

	// The first and last slide of the running show (custom show, range, hidden slides skipped).
	first(): void {
		this.input()
		this.jump({ kind: "internal", jump: "first" })
	}

	last(): void {
		this.input()
		this.jump({ kind: "internal", jump: "last" })
	}

	black(): void {
		this.input()
		this.setScreen(this.screenState === "black" ? "slide" : "black")
	}

	white(): void {
		this.input()
		this.setScreen(this.screenState === "white" ? "slide" : "white")
	}

	end(): void {
		if (this.ended) return

		this.ended = true
		this.stop()
		this.emit({ type: "ended" })
		this.props.onEnd()
	}

	on<T extends ShowEventType>(type: T, listener: (event: Extract<ShowEvent, { type: T }>) => void): () => void {
		const store = this.listeners as Record<string, Set<unknown>>
		const set = (store[type] ??= new Set())

		set.add(listener)

		return () => {
			set.delete(listener)
		}
	}

	// --- Input from the stage ---

	key(event: { readonly key: string; readonly typed: string }): "handled" | "typed" | "ignored" {
		const key = event.key

		if (key === "Escape") this.end()
		else if (/^[0-9]$/u.test(key)) return "typed"
		else if (key === "Enter" && event.typed !== "") this.goto(Number(event.typed) - 1)
		else if (NEXT_KEYS.has(key)) this.next()
		else if (PREV_KEYS.has(key)) this.prev()
		else if (key === "Home") this.first()
		else if (key === "End") this.last()
		else if (key === "b" || key === "B" || key === ".") this.black()
		else if (key === "w" || key === "W" || key === ",") this.white()
		else return "ignored"

		return "handled"
	}

	// A plain click on the stage (not on a target): the next step, except in a kiosk.
	click(): void {
		this.input()

		if (!this.props.options.kiosk) this.next()
	}

	// --- Navigation ---

	private forward(): void {
		const move = this.nav.following(1)

		if (move.kind === "end") this.end()
		else if (move.kind === "slide") void this.show(move.position, { transition: true })
	}

	private jump(target: PresentationJump): void {
		switch (target.kind) {
			case "internal":
				switch (target.jump) {
					case "next":
						this.forward()
						return
					case "previous": {
						const move = this.nav.following(-1)

						if (move.kind === "slide") void this.show(move.position, { transition: true })
						return
					}
					case "first":
						void this.show(this.nav.first(), { transition: true })
						return
					case "last":
						void this.show(this.nav.last(), { transition: true })
						return
					case "end":
						this.end()
						return
					case "lastViewed":
						if (this.nav.lastViewed !== undefined) this.goto(this.nav.lastViewed)
				}

				return
			case "slide": {
				const index = this.props.slides.findIndex(slide => slide.ref === target.slide)

				if (index >= 0) this.goto(index)

				return
			}
			case "customShow":
				if (this.nav.enterCustom(target.id, target.returnAfter)) void this.show(this.nav.position, { transition: true })
		}
	}

	private setScreen(screen: ShowScreen): void {
		if (this.screenState === screen) return

		this.screenState = screen
		this.host.style.visibility = screen === "slide" ? "" : "hidden"
		this.view.screen(screen)
		this.emit({ type: "screen", screen })

		const playing = this.playing

		if (screen === "slide" && playing?.began === true) this.armAdvance(playing)
	}

	private async show(position: ShowPosition, how: { readonly transition: boolean; readonly atEnd?: boolean }): Promise<void> {
		const generation = ++this.generation

		// The slide on stage advances no more by its timing (a navigation is under way).
		if (this.advance !== undefined) clearTimeout(this.advance)

		this.advance = undefined

		const prepared = await this.prepare(position.index)

		if (generation !== this.generation || this.disposed || this.ended) return

		this.nav.go(position)
		this.setScreen("slide")

		if (prepared === undefined) {
			// Nothing could be drawn for it: the show goes on past it.
			this.forward()

			return
		}

		const from = this.playing
		const now = this.now()

		if (this.run !== undefined) this.finishTransition(now)
		if (from !== undefined && from.prepared !== prepared) this.leave(from)

		const instance = prepared.graph === undefined ? undefined : instantiate(prepared.graph)
		const playing: Playing = {
			prepared,
			instance,
			clock: now,
			shownAt: now,
			step: 0,
			steps: prepared.graph?.mainSteps ?? 0,
			media: new Map(),
			busyUntil: 0,
			scaled: new Set(),
			began: false
		}

		this.playing = playing

		if (prepared.stage.element.parentElement !== this.host) this.host.insertBefore(prepared.stage.element, this.blackout)

		prepared.stage.element.style.zIndex = "1"

		const transition = how.transition && from !== undefined ? prepared.transition : undefined

		if (instance !== undefined && how.atEnd === true) {
			instance.fire({ kind: "slideBegin" }, 0)

			for (let step = 1; step <= playing.steps; step++) instance.fire({ kind: "next" }, step * STEP_SPACING_MS)

			playing.step = Math.min(stepOf(instance), playing.steps)
			playing.clock = now - (playing.steps + 1) * STEP_SPACING_MS
		}

		// The incoming slide shows its first state (entrance shapes hidden) before anything of it is seen.
		this.applyAt(playing, now)
		// Only the slides on stage stay while a transition plays; the next one is prepared once the timeline begins.
		this.trim(new Set([prepared.index, ...(from === undefined ? [] : [from.prepared.index])]))

		if (transition !== undefined && transitionDurationMs(transition) > 0) {
			const run: TransitionRun = {
				from: from?.prepared,
				to: prepared,
				transition,
				start: now,
				duration: transitionDurationMs(transition)
			}

			this.run = run
			this.transitionFrame(now)
			this.clearTransitionEnd()
			this.transitionEnd = setTimeout(() => {
				this.transitionEnd = undefined

				if (this.run === run) this.finishTransition(this.now())
			}, run.duration + TRANSITION_GRACE_MS)
		} else {
			this.detach(from?.prepared, prepared)
			this.begin(playing, now, how.atEnd === true)
		}

		this.view.slide(prepared.index)
		this.props.onSlide?.(prepared.index)
		// With the slide the show goes to after this one (the presenter's next preview), null at the end.
		const slideEvent = {
			type: "slide" as const,
			index: prepared.index,
			slide: prepared.ref,
			step: playing.step,
			steps: playing.steps,
			next: this.nav.peek() ?? null
		}

		this.emit(slideEvent)
		this.kick()
	}

	// The slide's timeline begins (after its transition): its timed advance is armed, the next slide prepared.
	private begin(playing: Playing, now: number, atEnd: boolean): void {
		if (!atEnd) {
			playing.clock = now
			playing.instance?.fire({ kind: "slideBegin" }, 0)
		}

		playing.began = true
		this.kick()
		this.prefetch()
	}

	private leave(playing: Playing): void {
		for (const handle of playing.prepared.stage.media.values()) handle.command({ command: "stop" })
	}

	// Takes the outgoing slide off the stage (kept prepared for a return).
	private detach(from: Prepared | undefined, to: Prepared): void {
		if (from === undefined || from === to) return

		from.stage.element.remove()
		from.stage.element.style.cssText += ";transform:;opacity:;clip-path:"
	}

	// The slide shown again with layers drawn at a new stage size; its timeline goes on.
	private swap(playing: Playing, prepared: Prepared): void {
		const old = playing.prepared

		this.host.replaceChild(prepared.stage.element, old.stage.element)
		;(playing as { prepared: Prepared }).prepared = prepared
		this.ready.delete(old.index)
		this.ready.set(prepared.index, prepared)
		this.releasePrepared(old)
		this.countBytes()
		this.applyAt(playing, this.now())
	}

	// --- Preparation ---

	private now(): number {
		return this.window.performance.now()
	}

	private width(): number {
		return Math.max(16, Math.min(8192, Math.round(this.stageWidth > 0 ? this.stageWidth : this.window.innerWidth || 1280)))
	}

	private prepare(index: number, force = false): Promise<Prepared | undefined> {
		const held = this.cache.get(index)

		if (held !== undefined && !force) return held.promise

		const width = this.width()
		const promise = this.build(index, width).then(prepared => {
			if (prepared === undefined) return undefined

			if (this.disposed) {
				this.releasePrepared(prepared)

				return undefined
			}

			const previous = this.ready.get(index)

			if (previous !== undefined && previous !== prepared && this.playing?.prepared !== previous && this.run?.from !== previous)
				this.releasePrepared(previous)

			// Held until a prefetch drops it, also when it was dropped while it was drawn (a navigation may wait for it).
			this.ready.set(index, prepared)
			this.fitBudget()

			return prepared
		})

		this.cache.set(index, { width, promise })

		return promise
	}

	private async build(index: number, width: number): Promise<Prepared | undefined> {
		const slide = this.props.slides[index]

		if (slide === undefined) return undefined

		const session = this.props.session
		const size = { w: this.props.size.cx / EMU_PER_PX, h: this.props.size.cy / EMU_PER_PX }
		let graph: CompiledTimegraph | undefined
		let source: TimegraphSource | undefined

		if (session !== undefined) {
			try {
				const compiled = await session.timegraph(slide.ref)

				if (compiled.source !== undefined) {
					graph = compileSource(slide.ref, compiled.source, BUDGETS)
					source = compiled.source
				}
			} catch (error) {
				// A timing over its budgets plays without animation; anything else (no timing support) silently so.
				if (error instanceof PresentationError && (error.reason === "tooLarge" || error.reason === "tooDeep"))
					this.notice({ kind: "budget", what: "timing" })
			}
		}

		let layers: readonly ShowLayer[] | undefined

		if (session !== undefined) {
			try {
				layers = await session.layers(
					slide.ref,
					width,
					source === undefined ? { shapes: [], dpr: this.dpr } : layerPlanOf(source, this.dpr)
				)
			} catch {
				layers = undefined
			}
		}

		if (this.disposed) {
			for (const layer of layers ?? []) layer.bitmap.close()

			return undefined
		}

		const layerCount = source?.layers.shapes.length ?? 0
		const fallback = layers === undefined
		const stage =
			layers === undefined
				? buildStageSlide(this.document, size, [], { layer: -1, children: [] }, 0)
				: buildStageSlide(this.document, size, layers, layerTree(layerIndices(source, layers), source?.parents), layerCount)
		const layerOf = new Map<number, number>()

		source?.layers.shapes.forEach((shape, k) => {
			if (source.layers.ranges?.[k] === undefined && !layerOf.has(shape)) layerOf.set(shape, k)
		})

		const prepared: Prepared = {
			index,
			ref: slide.ref,
			width,
			stage,
			graph: fallback ? undefined : graph,
			source: fallback ? undefined : source,
			boxes: source === undefined ? new Float64Array(0) : layerBoxes(source),
			transition: source?.transition,
			triggers: new Set(graph?.interactive.map(trigger => trigger.trigger.id) ?? []),
			layerOf,
			domLayers: new Set(
				(fallback ? [] : (graph?.tracks ?? []))
					.filter(
						track =>
							track.kind === "color" ||
							attributeEntry(track.attribute)?.route === "dom" ||
							attributeEntry(track.attribute)?.route === "fontSize"
					)
					.map(track => track.layer)
			),
			render: undefined,
			painted: undefined,
			fallback
		}

		this.place(prepared)

		return prepared
	}

	// Click targets (and, without layers, the SVG paint) from the slide's render once the page has it.
	private place(prepared: Prepared): void {
		const render = this.props.renders.get(prepared.ref)

		if (render === undefined || render === prepared.render) return

		prepared.render = render

		if (prepared.fallback) {
			prepared.painted?.release()

			const painted = this.props.painter(render, { document: this.document, session: this.props.session, signal: { aborted: false } })

			prepared.painted = painted
			prepared.stage.element.replaceChildren(painted.root)
		}

		const owner = (layer: SlideLayer): number =>
			layer.shape.slide !== render.ref
				? -1
				: (prepared.layerOf.get(layer.shape.id) ?? prepared.layerOf.get(layer.box?.id ?? -1) ?? -1)

		if (prepared.domLayers.size > 0) prepared.stage.paintDom(render, owner, prepared.domLayers, this.props.painter, this.props.session)

		prepared.stage.targets(render, owner, prepared.triggers, {
			session: this.props.session,
			...(this.props.media === undefined ? {} : { media: this.props.media }),
			labels: this.props.labels,
			action: (action, layer, event) => {
				this.input()

				const handled = this.activator?.action(action, this.trigger(layer, event)) ?? "ignored"

				if (handled === "ignored" || handled === "inert") this.click()
			},
			trigger: shape => {
				this.input()
				this.fire(prepared, { kind: "click", shape })
			},
			link: (link, layer, event) => {
				this.input()

				const handled = this.activator?.link(link, this.trigger(layer, event)) ?? "ignored"

				if (handled === "ignored" || handled === "inert") this.click()
			},
			mediaEvents: shape => ({
				ended: () => {
					this.fire(prepared, { kind: "mediaEnd", shape })
				},
				bookmark: name => {
					this.fire(prepared, { kind: "mediaBookmark", shape, bookmark: name })
				}
			})
		})
	}

	private trigger(layer: SlideLayer, event: MouseEvent): ActionTrigger {
		return { via: "click", mode: "show", modifier: modifierOf(event), shape: layer.shape }
	}

	private fire(prepared: Prepared, event: TimeEvent): void {
		const playing = this.playing

		if (playing?.prepared !== prepared || playing.instance === undefined) return

		playing.instance.fire(event, this.now() - playing.clock)
		this.kick()
	}

	// The slide after the current one, prepared while this one plays; slides beyond the neighbours are dropped.
	private prefetch(): void {
		const current = this.playing?.prepared.index
		const next = this.nav.peek()
		const previous = this.nav.following(-1)
		const keep = new Set<number>()

		if (current !== undefined) keep.add(current)
		if (next !== undefined) keep.add(next)
		if (previous.kind === "slide") keep.add(previous.position.index)

		this.trim(keep)

		if (next !== undefined) void this.prepare(next)
	}

	// Drops every slide held but `keep`.
	private trim(keep: ReadonlySet<number>): void {
		for (const index of new Set([...this.cache.keys(), ...this.ready.keys()])) if (!keep.has(index)) this.evict(index)
	}

	// While the slides held pass SHOW_HELD_BYTES, the ones kept for a return go (the worker caps each slide at half of
	// it, so the slide on stage and the next one fit; a navigation may be waiting for the next one).
	private fitBudget(): void {
		let bytes = this.countBytes()

		if (bytes <= SHOW_HELD_BYTES) return

		const next = this.nav.peek()
		const pinned = new Set<Prepared | undefined>([this.playing?.prepared, this.run?.from, this.run?.to])

		for (const [index, prepared] of [...this.ready]) {
			if (bytes <= SHOW_HELD_BYTES) break
			if (index === next || pinned.has(prepared)) continue

			this.evict(index)
			bytes = this.countBytes()
		}
	}

	private evict(index: number): void {
		const prepared = this.ready.get(index)

		this.cache.delete(index)
		this.ready.delete(index)
		this.countBytes()

		if (prepared !== undefined && this.playing?.prepared !== prepared && this.run?.from !== prepared) this.releasePrepared(prepared)
	}

	private releasePrepared(prepared: Prepared): void {
		prepared.painted?.release()
		prepared.stage.release()
	}

	// Bitmap bytes of the slides held (the stage's GPU-resident layers at most; an outgoing slide still on stage
	// counts), on the host as data-fo-show-bytes.
	private countBytes(): number {
		let bytes = 0

		for (const prepared of this.ready.values()) bytes += prepared.stage.bytes

		const outgoing = this.run?.from

		if (outgoing !== undefined && this.ready.get(outgoing.index) !== outgoing) bytes += outgoing.stage.bytes

		this.host.dataset["foShowBytes"] = String(bytes)

		return bytes
	}

	// --- Frames ---

	private kick(): void {
		const playing = this.playing

		if (playing?.began === true) this.armAdvance(playing)

		if (this.raf !== 0 || this.disposed) return

		if (this.wake !== undefined) {
			clearTimeout(this.wake)
			this.wake = undefined
			this.wakeAt = Number.NaN
		}

		this.raf = this.window.requestAnimationFrame(this.tick)
	}

	private readonly tick = (now: number): void => {
		this.raf = 0

		if (this.disposed) return

		let more = false

		if (this.run !== undefined) more = this.transitionFrame(now)

		const playing = this.playing

		if (playing !== undefined && this.run === undefined) more = this.frameOf(playing, now) || more

		if (more) this.raf = this.window.requestAnimationFrame(this.tick)
	}

	// The slide's state at `now`, applied to the stage (one sample).
	private applyAt(playing: Playing, now: number): { readonly t: number; readonly states: readonly LayerState[] } | undefined {
		const instance = playing.instance

		if (instance === undefined) return undefined

		const t = now - playing.clock
		const states = instance.sample(t)

		playing.prepared.stage.apply(states, playing.prepared.boxes)
		this.mediaCommands(playing, states)
		this.fontScales(playing, states)

		return { t, states }
	}

	// Samples and applies the slide's state at `now`; whether the next frame is needed (a timed begin further away
	// sets a timer instead). Probing whether the slide still moves samples twice more, at most once per probe span.
	private frameOf(playing: Playing, now: number): boolean {
		const instance = playing.instance
		const at = this.applyAt(playing, now)

		if (instance === undefined || at === undefined) return false

		// Before the slide's timeline begins (under its transition), nothing moves.
		if (this.run?.to === playing.prepared) return false

		const next = instance.nextActivation(at.t)

		if (next !== undefined && Number.isFinite(next)) {
			if (next - at.t <= AWAKE_MS) return true

			this.sleep(playing.clock + next - AWAKE_MS / 2)
		}

		return this.busy(playing, instance, now, at.t, at.states)
	}

	// Whether the slide still moves at `now` (an effect playing); a probe that finds it moving holds for PROBES_MS[1].
	private busy(playing: Playing, instance: TimegraphInstance, now: number, t: number, states: readonly LayerState[]): boolean {
		if (now < playing.busyUntil) return true
		if (this.settled(instance, t, states)) return false

		playing.busyUntil = now + PROBES_MS[1]

		return true
	}

	private settled(instance: TimegraphInstance, t: number, states: readonly LayerState[]): boolean {
		const now = JSON.stringify(states)

		return PROBES_MS.every(ahead => JSON.stringify(instance.sample(t + ahead)) === now)
	}

	private sleep(at: number): void {
		// The same wake again (every frame of a slide waiting for a later begin asks for it).
		if (this.wake !== undefined && Math.abs(at - this.wakeAt) < 1) return
		if (this.wake !== undefined) clearTimeout(this.wake)

		this.wakeAt = at
		this.wake = setTimeout(
			() => {
				this.wake = undefined
				this.wakeAt = Number.NaN
				this.kick()
			},
			Math.max(0, at - this.now())
		)
	}

	// The slide's timed advance, on timers only (they run in a hidden tab, animation frames do not): at its advance
	// time, once nothing on it moves or waits to begin; probed again until then.
	private armAdvance(playing: Playing, after = 0): void {
		if (this.advance !== undefined) return

		const now = this.now()
		const at = advanceAt(playing.prepared.transition, this.props.options, playing.shownAt, now)

		if (at === undefined) return

		this.advance = setTimeout(
			() => {
				this.advance = undefined

				if (this.playing !== playing || this.screenState !== "slide" || this.ended || this.disposed) return

				if (this.idle(playing)) this.next()
				else this.armAdvance(playing, PROBES_MS[0])
			},
			Math.max(after, at - now)
		)
	}

	// Nothing on the slide moves or waits for a timed begin (sampled here, so a hidden tab's timeline goes on too).
	private idle(playing: Playing): boolean {
		const instance = playing.instance
		const now = this.now()
		const at = this.applyAt(playing, now)

		if (instance === undefined || at === undefined) return true

		const next = instance.nextActivation(at.t)

		if (next !== undefined && Number.isFinite(next)) return false

		playing.busyUntil = 0

		return !this.busy(playing, instance, now, at.t, at.states)
	}

	// A font-size effect plays as each run scaled about its baseline start, not laid out again: said once per shape.
	private fontScales(playing: Playing, states: readonly LayerState[]): void {
		for (const state of states) {
			if (state.fontSize === undefined) continue

			const shape = playing.prepared.source?.layers.shapes[state.layer] ?? -1

			if (shape < 0 || playing.scaled.has(shape)) continue

			playing.scaled.add(shape)
			this.notice({ kind: "fontScale", shape: { slide: playing.prepared.ref, id: shape } })
		}
	}

	private mediaCommands(playing: Playing, states: readonly LayerState[]): void {
		const media = playing.prepared.stage.media

		if (media.size === 0) return

		const shapes = playing.prepared.source?.layers.shapes

		for (const state of states) {
			if (state.media === undefined) continue

			const shape = shapes?.[state.layer] ?? -1
			const handle: ShowMediaHandle | undefined = media.get(shape)
			const key = JSON.stringify(state.media)

			if (handle === undefined || playing.media.get(shape) === key) continue

			playing.media.set(shape, key)
			handle.command(state.media)
		}
	}

	private transitionFrame(now: number): boolean {
		const run = this.run

		if (run === undefined) return false

		const p = run.duration <= 0 ? 1 : (now - run.start) / run.duration

		if (p >= 1) {
			this.finishTransition(now)

			return this.playing !== undefined
		}

		const size = { w: this.props.size.cx / EMU_PER_PX, h: this.props.size.cy / EMU_PER_PX }
		const styles = transitionStyles(run.transition, p, size)
		const incoming = run.to.stage.element.style
		const outgoing = run.from?.stage.element.style

		// Outgoing, black (thruBlk), incoming; pull and zoom in draw the outgoing slide on top.
		incoming.transform = styles.incoming.transform
		incoming.opacity = String(styles.incoming.opacity)
		incoming.clipPath = styles.incoming.clipPath
		incoming.zIndex = styles.outgoingOnTop ? "1" : "3"

		if (outgoing !== undefined) {
			outgoing.transform = styles.outgoing.transform
			outgoing.opacity = String(styles.outgoing.opacity)
			outgoing.zIndex = styles.outgoingOnTop ? "3" : "1"
		}

		this.blackout.style.opacity = String(styles.black)

		return true
	}

	private finishTransition(now: number): void {
		const run = this.run

		if (run === undefined) return

		this.run = undefined
		this.clearTransitionEnd()

		const style = run.to.stage.element.style

		style.transform = ""
		style.opacity = ""
		style.clipPath = ""
		style.zIndex = "1"
		this.blackout.style.opacity = "0"

		if (run.from !== undefined && run.from !== run.to) {
			const from = run.from.stage.element.style

			from.transform = ""
			from.opacity = ""
			from.zIndex = ""
			run.from.stage.element.remove()

			if (!this.ready.has(run.from.index) || this.ready.get(run.from.index) !== run.from) this.releasePrepared(run.from)
		}

		const playing = this.playing

		if (playing?.prepared === run.to) this.begin(playing, now, false)
	}

	private clearTransitionEnd(): void {
		if (this.transitionEnd !== undefined) clearTimeout(this.transitionEnd)

		this.transitionEnd = undefined
	}

	// --- Lifecycle ---

	// Input restarts a kiosk's inactivity timer; the slide's timed advance runs on (it counts from the slide's start).
	private input(): void {
		const restartMs = this.props.options.restartMs

		if (restartMs === undefined) return
		if (this.restart !== undefined) clearTimeout(this.restart)

		this.restart = setTimeout(() => {
			this.restart = undefined
			void this.show(this.nav.first(), { transition: true })
		}, restartMs)
	}

	private notice(notice: PresentationNotice): void {
		this.emit({ type: "notice", notice })
	}

	private emit(event: ShowEvent): void {
		const set = this.listeners[event.type] as Set<(event: ShowEvent) => void> | undefined

		if (set !== undefined) for (const listener of [...set]) listener(event)
	}

	private stop(): void {
		if (this.raf !== 0) this.window.cancelAnimationFrame(this.raf)

		this.raf = 0

		for (const timer of [this.wake, this.advance, this.restart, this.transitionEnd]) if (timer !== undefined) clearTimeout(timer)

		this.wake = undefined
		this.wakeAt = Number.NaN
		this.advance = undefined
		this.restart = undefined
		this.transitionEnd = undefined

		if (this.playing !== undefined) this.leave(this.playing)
	}

	dispose(): void {
		if (this.disposed) return

		this.stop()
		this.disposed = true
		this.generation++

		for (const prepared of this.ready.values()) this.releasePrepared(prepared)

		this.ready.clear()
		this.cache.clear()
		this.playing = undefined
		this.run = undefined
		this.blackout.remove()
	}

	// The slide on stage and its step (tests and the presenter's mirror).
	state(): { readonly index: number; readonly step: number; readonly steps: number; readonly screen: ShowScreen } | undefined {
		const playing = this.playing

		return playing === undefined
			? undefined
			: { index: playing.prepared.index, step: playing.step, steps: playing.steps, screen: this.screenState }
	}
}
