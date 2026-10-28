import type { Transition } from "../../../anim/model"
import { transitionPreset } from "../../../anim/presets/transitions/catalog"
import { refused, type Deck, type SlideNode } from "../../model"
import { odpWrittenTransition } from "../../../odp/write/emit/transition"
import { insertedMediaContent, insertedMediaId, insertedMediaWritten } from "./media"
import { onHeldPage, pageMarkup, sourceReading } from "./heldPage"
import type { ApplyFamily, Touch } from "../apply"
import type { DeckOp, TransitionOp } from "../ops"

// The transition of one or more slides set (undefined removes it). The inverse sets each slide's transition back,
// with the source element's bytes when it was the file's own, so an undo writes those bytes again (emit/transition.ts
// reads them through `transitionRaw`). Kinds are the catalog's (core/anim/presets/transitions); a transition coming
// back through an inverse is taken as it was. A new sound is a WAV (PowerPoint plays transition sounds as WAV only)
// the worker registered for insert ("inserted:<id>", core/presentation/edit/apply/media.ts): embedded when saved,
// stored once, never linked.
//
// An ODP transition is the page's: its style properties and, for its exact duration, a par first in the page's timing
// root, both given the page (a style, an xml:id) by the save. So on an ODP deck the inverse holds the page's source
// markup instead: an undo after a save puts the page back on that markup (as a deleted page's restore does), and the
// next save writes the page as it was, edits since then aside.

// PowerPoint's limits on a transition's duration and its advance-after time.
const MAX_DURATION_MS = 59_990
const MAX_AFTER_MS = 86_399_000

const RAWS = new WeakMap<Transition, Uint8Array>()

// The source bytes a transition was restored from (an undo back to the file's own element), if any.
export function transitionRaw(transition: Transition): Uint8Array | undefined {
	return RAWS.get(transition)
}

function finite(value: number | undefined, max: number): boolean {
	return value === undefined || (Number.isFinite(value) && value >= 0 && value <= max)
}

const WAV: ReadonlySet<string> = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"])

function invalid(transition: Transition, deck: Deck, media: TransitionOp["media"]): string | undefined {
	if (transitionPreset(transition.kind, transition.namespace) === undefined)
		return `transition ${transition.namespace}:${transition.kind}`
	if (!finite(transition.durationMs, MAX_DURATION_MS)) return "transition duration"
	if (!finite(transition.advance.afterMs, MAX_AFTER_MS)) return "transition advance time"

	const sound = transition.sound

	if (sound?.kind !== "embedded") return undefined

	const id = insertedMediaId(sound.part)

	if (id === undefined) return sound.part.startsWith("/") ? undefined : "transition sound part"
	if (media !== undefined && (media.id !== id || media.kind !== "audio")) return "transition sound medium"

	const content = insertedMediaContent(deck, id)

	if (content === undefined && insertedMediaWritten(deck, id) === undefined) return "transition sound medium not held"
	// The bytes decide: an MP3 named .wav is no WAV PowerPoint plays.
	if (content !== undefined && (!WAV.has(content.contentType) || (content.container !== undefined && content.container !== "wav")))
		return "a transition sound that is not WAV"

	return undefined
}

// A slide's copy of an authored transition: the source refs of the element it replaces are not its own.
function authored(transition: Transition): Transition {
	const { src: _src, fallback: _fallback, ...own } = transition

	return { ...own, options: { ...transition.options }, advance: { ...transition.advance } }
}

export const applyTransition: ApplyFamily<TransitionOp> = {
	apply(deck, op, context) {
		const raws = op.raws

		if (raws === undefined && op.transition !== undefined) {
			const reason = invalid(op.transition, deck, op.media)

			if (reason !== undefined) return refused("unsupported", reason)
		}

		const nodes: SlideNode[] = []

		for (const ref of op.slides) {
			const node = deck.nodes.get(ref)

			if (node === undefined) return refused("notFound", "slide")
			if (node.kind !== "slide") return refused("unsupported", "a transition on a node that is not a slide")

			nodes.push(node)
		}

		const inverse: DeckOp[] = []
		let bytes = 0

		const odp = deck.format === "odp"
		const reading = sourceReading(context)

		for (const node of nodes) {
			const prior = node.transition
			let raw = odp ? pageMarkup(node, reading) : prior === undefined ? undefined : RAWS.get(prior)

			if (!odp && raw === undefined && prior?.src !== undefined) {
				const source = context.sourceBytes(prior.src)

				if (!(source instanceof Uint8Array)) return source

				raw = source
			}

			inverse.push({
				family: "transition",
				kind: "set",
				slides: [node.ref],
				transition: prior,
				...(raw === undefined ? {} : { raws: [raw] })
			})
			bytes += 64 + (raw?.length ?? 0)
		}

		// An ODP inverse's held pages first: nothing changes before every one reads.
		if (odp && raws !== undefined && reading !== undefined) {
			for (const [index, node] of nodes.entries()) {
				const raw = raws[index]
				const failed = raw === undefined ? undefined : onHeldPage(deck, node, raw, reading)

				if (failed !== undefined) return refused("stale", failed)
			}
		}

		nodes.forEach((node, index) => {
			const given = op.transition
			const raw = odp ? undefined : raws?.[index]

			if (given === undefined) {
				delete node.transition
			} else if (raw !== undefined) {
				node.transition = given
				RAWS.set(given, raw)
			} else {
				const own = raws === undefined ? authored(given) : given

				// An ODP page holds it as the file will once saved (emit/transition.ts).
				node.transition = deck.format === "odp" ? odpWrittenTransition(own) : own
			}

			node.revision++
		})

		return { kind: "applied", inverse: { ops: inverse, bytes }, op }
	},
	touches(op) {
		return op.slides.map((slide): Touch => ({ kind: "slide", slide, dirt: { kind: "slidePart", part: "transition" } }))
	}
}
