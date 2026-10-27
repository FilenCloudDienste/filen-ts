import { refused, type ColorModel, type Deck, type Refused, type ShowSettings } from "../../model"
import type { ApplyFamily, ApplyResult, Touch } from "../apply"
import { cloneModel } from "../changes"
import type { DeckOp, PresentationOp } from "../ops"

// Set Up Slide Show: deck.show replaced whole; its inverse sets the settings it replaced.

const SHOW_TOUCHES: readonly Touch[] = [{ kind: "presentation", what: "show" }]
// p:kiosk@restart is an xsd:unsignedInt (ECMA-376 Part 1 §19.2.1.18).
const MAX_RESTART_MS = 4_294_967_295
const KINDS: ReadonlySet<string> = new Set(["present", "browse", "kiosk"])

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1
}

function isColor(value: unknown): value is ColorModel {
	return typeof value === "object" && value !== null && typeof (value as { kind?: unknown }).kind === "string"
}

// The settings, or why the deck cannot hold them.
export function checkShow(deck: Deck, show: ShowSettings): Refused | undefined {
	if (!KINDS.has(show.kind)) return refused("malformed", `show kind ${String(show.kind)}`)

	for (const flag of [show.loop, show.showNarration, show.showAnimation, show.useTimings])
		if (typeof flag !== "boolean") return refused("malformed", "show flag")

	const range = show.range

	switch (range.kind) {
		case "all":
			break
		case "range":
			if (!isCount(range.start) || !isCount(range.end) || range.start > range.end)
				return refused("malformed", `show range ${String(range.start)}–${String(range.end)}`)
			if (range.end > deck.slides.length) return refused("notFound", `show range ends after slide ${String(deck.slides.length)}`)
			break
		case "customShow":
			if (!deck.customShows.some(custom => custom.id === range.id)) return refused("notFound", `custom show ${String(range.id)}`)
			break
		default:
			return refused("malformed", "show range")
	}

	if (show.penColor !== undefined && !isColor(show.penColor)) return refused("malformed", "pen colour")

	const restart = show.restartMs

	if (restart !== undefined && (!Number.isInteger(restart) || restart < 0 || restart > MAX_RESTART_MS))
		return refused("malformed", `restart ${String(restart)} ms`)

	return deck.format === "odp"
		? checkOdpShow(deck, show)
		: restart !== undefined && show.kind !== "kiosk"
			? refused("unsupported", "a restart outside kiosk mode")
			: undefined
}

// ODF presentation:settings (§9.6) has no kiosk mode, narration, pen colour or range end: a range runs from its start
// page to the last page, and a pause is the one between loops.
export function checkOdpShow(deck: Deck, show: ShowSettings): Refused | undefined {
	if (show.kind === "kiosk") return refused("unsupported", "kiosk mode in ODF")
	if (show.showNarration) return refused("unsupported", "narration in ODF")
	if (show.penColor !== undefined) return refused("unsupported", "a pen colour in ODF")
	if (show.range.kind === "range" && show.range.end !== deck.slides.length)
		return refused("unsupported", "a slide range ending before the last slide in ODF")
	if (show.restartMs !== undefined && !show.loop) return refused("unsupported", "a pause without looping in ODF")

	return undefined
}

export const applyPresentation: ApplyFamily<PresentationOp> = {
	apply(deck, op) {
		const failure = checkShow(deck, op.show)

		if (failure !== undefined) return failure

		const prior = deck.show

		deck.show = cloneModel(op.show)
		deck.revision++

		return { kind: "applied", inverse: { ops: [{ family: "presentation", kind: "setShow", show: prior }], bytes: 0 }, op }
	},
	touches: () => SHOW_TOUCHES
}

// A slide op that changes the slide list keeps the show's slide range inside the deck: a range never ends past the
// last slide (p:sldRg holds slide numbers), and an ODF range runs from its start page to the last slide. A range left
// with no slide plays them all. The range it replaced comes back with the op's inverse.
export const SLIDE_LIST_SHOW_TOUCH: Touch = { kind: "presentation", what: "show" }

export function fittedShowRange(deck: Deck): ShowSettings["range"] {
	const range = deck.show.range
	const count = deck.slides.length

	if (range.kind !== "range") return range
	if (count === 0 || range.start > count) return { kind: "all" }

	const end = deck.format === "odp" ? count : Math.min(range.end, count)

	return end === range.end ? range : { kind: "range", start: range.start, end }
}

export function withFittedShowRange<O extends DeckOp>(deck: Deck, result: ApplyResult<O>): ApplyResult<O> {
	if (result.kind !== "applied") return result

	const prior = deck.show
	const range = fittedShowRange(deck)

	if (range === prior.range) return result

	deck.show = { ...cloneModel(prior), range }
	deck.revision++

	return {
		...result,
		inverse: { ops: [...result.inverse.ops, { family: "presentation", kind: "setShow", show: prior }], bytes: result.inverse.bytes }
	}
}
