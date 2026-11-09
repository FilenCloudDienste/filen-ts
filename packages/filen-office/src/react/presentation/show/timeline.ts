import type { Transition } from "../../../core/anim/model"
import type { CustomShow, ShowSettings, SlideRef } from "../../../core/presentation/model"
import { DEFAULT_CLR_MAP, resolveColor } from "../../../core/presentation/theme"

// Which slide the show is on and where next and previous go: the slides a show runs through (a custom show's in its
// order; else the deck's, hidden ones skipped, within the settings' slide range), a slide shown by a jump outside
// that run (its neighbours are then the deck's), a custom show entered by an action that returns to where it was
// left, and the end (or the first slide again when the show loops). DOM-free: the player drives it.

export interface ShowSlide {
	readonly ref: SlideRef
	readonly hidden: boolean
}

// The deck indices a show runs through: a custom show's slides in its order, else every visible slide (within
// `range`, 1-based inclusive slide numbers, when given).
export function showSequence(
	slides: readonly ShowSlide[],
	customShow: CustomShow | undefined,
	range?: { readonly start: number; readonly end: number }
): number[] {
	if (customShow !== undefined) {
		const indices = new Map(slides.map((slide, index) => [slide.ref, index]))

		return customShow.slides.flatMap(ref => {
			const index = indices.get(ref)

			return index === undefined ? [] : [index]
		})
	}

	const out: number[] = []

	slides.forEach((slide, index) => {
		if (slide.hidden) return
		if (range !== undefined && (index + 1 < range.start || index + 1 > range.end)) return

		out.push(index)
	})

	return out
}

// The deck index right after `index` when that slide is hidden (where PowerPoint's H goes), else undefined.
export function hiddenAfter(slides: readonly ShowSlide[], index: number): number | undefined {
	return slides[index + 1]?.hidden === true ? index + 1 : undefined
}

export interface ShowPosition {
	// Into the run; -1 for a slide shown by a jump outside it (`index` holds it).
	readonly step: number
	readonly index: number
}

export type ShowMove = { readonly kind: "slide"; readonly position: ShowPosition } | { readonly kind: "end" } | { readonly kind: "none" }

// The settings a show runs with (the deck's p:showPr, or what Set Up Slide Show chose).
export interface ShowOptions {
	readonly loop: boolean
	// Kiosk: loops, clicks do not advance (only actions, triggers and timings do).
	readonly kiosk: boolean
	// Slides advance by their timings (transition advance-after).
	readonly useTimings: boolean
	readonly range?: { readonly start: number; readonly end: number }
	readonly customShow?: number
	// Kiosk restart after this long without input (ms).
	readonly restartMs?: number
	// Show without animation (showAnimation="0"): every slide enters with its main sequence at its end state.
	readonly withoutAnimation?: boolean
	// The pen's colour (penClr), RGB hex; the ink's default without it.
	readonly penColor?: string
	// Browsed by an individual (p:browse; ODF presentation:full-screen="false"): the page runs it in a window with a
	// status bar instead of full screen.
	readonly browse?: boolean
}

export const DEFAULT_SHOW_OPTIONS: ShowOptions = { loop: false, kiosk: false, useTimings: true }

// The options of a deck's own show settings.
export function showOptionsOf(settings: ShowSettings | undefined): ShowOptions {
	if (settings === undefined) return DEFAULT_SHOW_OPTIONS

	const kiosk = settings.kind === "kiosk"
	// A theme slot has no RGB outside a slide: the pen keeps its default.
	const pen = settings.penColor === undefined ? undefined : resolveColor(settings.penColor, { theme: undefined, clrMap: DEFAULT_CLR_MAP })

	return {
		loop: settings.loop || kiosk,
		kiosk,
		useTimings: settings.useTimings || kiosk,
		...(settings.range.kind === "range" ? { range: { start: settings.range.start, end: settings.range.end } } : {}),
		...(settings.range.kind === "customShow" ? { customShow: settings.range.id } : {}),
		...(kiosk && settings.restartMs !== undefined ? { restartMs: settings.restartMs } : {}),
		...(settings.showAnimation ? {} : { withoutAnimation: true }),
		...(pen === undefined ? {} : { penColor: pen.hex }),
		...(settings.kind === "browse" ? { browse: true } : {})
	}
}

interface CustomRun {
	readonly show: CustomShow
	// Where an action entered it from, to return to after its last slide; undefined: the show ends with it.
	readonly returnTo: ShowPosition | undefined
}

export class ShowNavigator {
	private readonly slides: readonly ShowSlide[]
	private readonly customShows: readonly CustomShow[]
	private readonly options: ShowOptions
	private custom: CustomRun | undefined
	private sequence: number[]
	position: ShowPosition
	// The slide shown before the current one ("last viewed" jumps).
	lastViewed: number | undefined

	constructor(slides: readonly ShowSlide[], customShows: readonly CustomShow[], options: ShowOptions) {
		this.slides = slides
		this.customShows = customShows
		this.options = options

		const show = customShows.find(candidate => candidate.id === options.customShow)

		this.custom = show === undefined ? undefined : { show, returnTo: undefined }
		this.sequence = this.run()
		this.position = { step: 0, index: this.sequence[0] ?? 0 }
	}

	private run(): number[] {
		return showSequence(this.slides, this.custom?.show, this.custom === undefined ? this.options.range : undefined)
	}

	get length(): number {
		return this.sequence.length
	}

	get indices(): readonly number[] {
		return this.sequence
	}

	// The position of deck slide `index` (in the run, or outside it).
	at(index: number): ShowPosition {
		const step = this.sequence.indexOf(index)

		return { step, index }
	}

	first(): ShowPosition {
		return { step: 0, index: this.sequence[0] ?? 0 }
	}

	last(): ShowPosition {
		return { step: this.sequence.length - 1, index: this.sequence[this.sequence.length - 1] ?? 0 }
	}

	// Where one slide forward (1) or back (-1) goes from the current position.
	following(delta: 1 | -1): ShowMove {
		const position = this.position

		if (this.sequence.length === 0) return delta === 1 ? { kind: "end" } : { kind: "none" }

		// From a slide outside the run (a jump), the next one is the run's first after it in the deck.
		const after = position.step === -1 ? this.sequence.findIndex(index => index > position.index) : -1
		const following = after === -1 ? this.sequence.length : after
		const step = position.step === -1 ? (delta === 1 ? following : following - 1) : position.step + delta

		if (step >= this.sequence.length) {
			if (this.custom?.returnTo !== undefined) return { kind: "slide", position: this.custom.returnTo }
			if (this.options.loop || this.options.kiosk) return { kind: "slide", position: this.first() }

			return { kind: "end" }
		}

		if (step < 0) return { kind: "none" }

		return { kind: "slide", position: { step, index: this.sequence[step] ?? 0 } }
	}

	// Moves to `position` (as following() or at() gave it); leaving a custom show past its end returns from it.
	go(position: ShowPosition): void {
		if (this.custom?.returnTo !== undefined && position === this.custom.returnTo) {
			this.custom = undefined
			this.sequence = this.run()
		}

		if (position.index !== this.position.index) this.lastViewed = this.position.index

		this.position = position
	}

	// Enters custom show `id` at its first slide; false when it has none.
	enterCustom(id: number, returnAfter: boolean): boolean {
		const show = this.customShows.find(candidate => candidate.id === id)

		if (show === undefined || showSequence(this.slides, show).length === 0) return false

		this.custom = { show, returnTo: returnAfter ? this.position : undefined }
		this.sequence = this.run()
		this.go(this.first())

		return true
	}

	// The deck index the run shows after the current slide (the presenter's and the prefetch's "next"), or undefined
	// at the end.
	peek(): number | undefined {
		const move = this.following(1)

		return move.kind === "slide" ? move.position.index : undefined
	}
}

// When a slide shown since `shownAt` advances by its timing: its transition's advance-after once nothing is left to
// play on it (`idleAt`), undefined when it waits for a click.
export function advanceAt(
	transition: Transition | undefined,
	options: ShowOptions,
	shownAt: number,
	idleAt: number | undefined
): number | undefined {
	const after = transition?.advance.afterMs

	if (!options.useTimings || after === undefined || idleAt === undefined) return undefined

	return Math.max(shownAt + after, idleAt)
}
