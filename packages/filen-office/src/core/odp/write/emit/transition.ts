import type { Transition } from "../../../anim/model"
import { odpTimingRoot } from "../../../anim/odf"
import { durationOf, odfPageTransition, speedOf } from "../../../anim/presets/transitions/catalog"
import { isPageTransitionPar } from "../../../anim/presets/transitions/odf"
import type { EmitPiece } from "../../../pptx/write/types"
import { insertedMediaId } from "../../../presentation/edit/apply/media"
import { refused, type Refused } from "../../../presentation/model"
import { decodeUtf8, encodeUtf8, escapeAttribute, type XmlEditor } from "../../../xml/index"
import type { Fragment } from "../../read/context"
import type { OdpEmitContext, OdpEmitFamily } from "../emit"
import { setChild, setProperty, type StyleChanges } from "../styles"
import { readTransition } from "../../read/transitions"
import { insertedMediumEntry } from "./media"

// A page's transition as ODF writes it (ODF 1.3 Part 3 §17.25 style:drawing-page-properties: smil:type,
// smil:subtype, smil:direction, smil:fadeColor, presentation:transition-speed, presentation:transition-type,
// presentation:duration), and, for its exact duration, the transition par LibreOffice 7.5 writes first in the page's
// timing root (§19.391 anim:transitionFilter with smil:dur, begun by "<page id>.begin": LibreOffice reads the
// filter only so, measured over UNO, and then it wins over the style). The SMIL names are
// core/anim/presets/transitions' odfPageTransition (the ECMA table, LibreOffice's names for the p14/p15 kinds it
// draws, else the fallback). A cut without black has no SMIL transition: only its advance is written. A sound is the
// style's presentation:sound (§10.8.2, in style:drawing-page-properties) and the par's anim:audio, the one
// LibreOffice plays (it resolves the style's relative IRI next to the file, measured over UNO); looping is the
// audio's smil:repeatCount, stop-previous-sound the par's anim:command "stop-audio". An inserted sound is a stored
// Media/ entry, added once per save (emit/media.ts).

const PROPERTIES = [
	"smil:type",
	"smil:subtype",
	"smil:direction",
	"smil:fadeColor",
	"presentation:transition-speed",
	"presentation:transition-type",
	"presentation:duration"
] as const

// xsd:duration seconds (presentation:duration) and a SMIL clock value (smil:dur).
function seconds(ms: number): string {
	return String(Math.round(ms) / 1000)
}

// The package path of a transition's embedded sound (no leading "/"), its entry added for a sound inserted in the
// session; undefined without one.
export function odpTransitionSound(transition: Transition | undefined, context: OdpEmitContext): string | Refused | undefined {
	const sound = transition?.sound

	if (sound?.kind !== "embedded") return undefined

	const id = insertedMediaId(sound.part)

	if (id === undefined) return sound.part.replace(/^\//u, "")

	return insertedMediumEntry(context, id)
}

function soundElement(path: string): string {
	return `<presentation:sound xlink:type="simple" xlink:href="${escapeAttribute(path)}" xlink:actuate="onRequest" xlink:show="new"/>`
}

// The page style changes for `transition` (undefined: every transition property removed); `sound` its embedded
// sound's path (odpTransitionSound).
export function odpTransitionStyle(changes: StyleChanges, transition: Transition | undefined, sound?: string): void {
	setChild(changes, "drawing-page", "presentation:sound", sound === undefined ? null : soundElement(sound))

	const set = (name: (typeof PROPERTIES)[number], value: string | undefined): void => {
		setProperty(changes, "drawing-page", name, value ?? null)
	}

	const properties = transition === undefined ? undefined : styleProperties(transition)

	for (const name of PROPERTIES) set(name, properties?.get(name))
}

// The drawing-page properties a transition is written with.
function styleProperties(transition: Transition): Map<(typeof PROPERTIES)[number], string> {
	const out = new Map<(typeof PROPERTIES)[number], string>()
	const put = (name: (typeof PROPERTIES)[number], value: string | undefined): void => {
		if (value !== undefined) out.set(name, value)
	}
	const mapped = odfPageTransition(transition)?.odf
	const speed = transition.speed ?? speedOf(durationOf(transition))
	const after = transition.advance.afterMs

	put("smil:type", mapped?.type)
	put("smil:subtype", mapped === undefined || mapped.subtype === "" ? undefined : mapped.subtype)
	put("smil:direction", mapped?.reverse === true ? "reverse" : undefined)
	put("smil:fadeColor", mapped?.fadeColor)
	put("presentation:transition-speed", mapped === undefined ? undefined : speed === "med" ? "medium" : speed)
	put("presentation:transition-type", after === undefined ? undefined : "automatic")
	put("presentation:duration", after === undefined ? undefined : `PT${seconds(after)}S`)

	return out
}

// An authored transition as an ODP file holds it once written and read back (the SMIL names it is written with join
// its options, its speed is the style's): the session's model is the file's, so a later save of the page finds it
// unchanged and keeps its style. A transition ODF holds only approximately (another kind's SMIL names) stays as
// authored.
export function odpWrittenTransition(transition: Transition): Transition {
	const written = odfPageTransition(transition)

	if (written === undefined || !written.exact) return transition

	const mapped = written.odf
	const filter = new Map<string, string>([
		["smil:dur", `${seconds(durationOf(transition))}s`],
		["smil:type", mapped.type]
	])

	if (mapped.subtype !== "") filter.set("smil:subtype", mapped.subtype)
	if (mapped.reverse) filter.set("smil:direction", "reverse")
	if (mapped.fadeColor !== undefined) filter.set("smil:fadeColor", mapped.fadeColor)

	const read = readTransition(styleProperties(transition), filter, transition.sound)

	return read === undefined ? transition : read
}

// The transition par of a page's timing root, or undefined when the page's transition has no SMIL one; `sound` as
// for odpTransitionStyle.
export function odpTransitionPar(transition: Transition | undefined, pageId: string, sound?: string): string | undefined {
	if (transition === undefined) return undefined

	const mapped = odfPageTransition(transition)?.odf

	if (mapped === undefined) return undefined

	const own = transition.sound
	const audio =
		own?.kind === "stop"
			? '<anim:command anim:command="stop-audio"/>'
			: own?.kind === "embedded" && sound !== undefined
				? `<anim:audio xlink:href="${escapeAttribute(sound)}"${own.loop ? ' smil:repeatCount="indefinite"' : ""}/>`
				: ""

	return (
		`<anim:par smil:begin="${escapeAttribute(`${pageId}.begin`)}"><anim:transitionFilter smil:dur="${seconds(durationOf(transition))}s"` +
		` smil:type="${escapeAttribute(mapped.type)}"` +
		(mapped.subtype === "" ? "" : ` smil:subtype="${escapeAttribute(mapped.subtype)}"`) +
		(mapped.reverse ? ' smil:direction="reverse"' : "") +
		(mapped.fadeColor === undefined ? "" : ` smil:fadeColor="${escapeAttribute(mapped.fadeColor)}"`) +
		`/>${audio}</anim:par>`
	)
}

// The id a page's transition par begins by: its xml:id, else its draw:id; undefined when it has neither.
export function pageIdOf(attributes: ReadonlyMap<string, string>): string | undefined {
	return attributes.get("xml:id") ?? attributes.get("draw:id")
}

// The page transition par among a timing root's children (an anim:par holding only an untargeted
// anim:transitionFilter), or -1.
export function transitionParOf(fragment: Fragment, root: number): number {
	const document = fragment.document

	for (let child = root < 0 ? -1 : document.firstChildElement(root); child >= 0; child = document.nextSiblingElement(child)) {
		if (isPageTransitionPar(fragment, child)) return child
	}

	return -1
}

// The page's transition par put in place in its source timing root (replaced, removed, or first in the root), or in a
// timing root of its own before presentation:notes when the page has none. `par` undefined: the page has no par.
export function placeTransitionPar(editor: XmlEditor, fragment: Fragment, page: number, par: string | undefined): void {
	const document = fragment.document
	const root = odpTimingRoot(fragment, page)
	const current = transitionParOf(fragment, root)

	if (current >= 0) {
		if (par === undefined) editor.remove(current)
		else editor.replace(current, encodeUtf8(par))

		return
	}

	if (par === undefined) return

	if (root >= 0) {
		if (document.isSelfClosing(root)) editor.replace(root, encodeUtf8(timingRootWith(par)))
		else editor.prepend(root, encodeUtf8(par))

		return
	}

	for (let child = document.firstChildElement(page); child >= 0; child = document.nextSiblingElement(child)) {
		if (fragment.name(child) === "presentation:notes") {
			editor.insertBefore(child, encodeUtf8(timingRootWith(par)))

			return
		}
	}

	editor.append(page, encodeUtf8(timingRootWith(par)))
}

// A timing root holding only a transition par (a page with a transition and no animation).
export function timingRootWith(par: string): string {
	return `<anim:par presentation:node-type="timing-root">${par}</anim:par>`
}

// The timing family's pieces of a page's root with its transition par as the page now has it: the source par's hole
// replaced (or dropped), or the par put first in the root; a root of its own when the timing has none. Undefined when
// the root is its source span whole (the timing did not change): the par is placed in the source then.
export function withTransitionPar(
	pieces: readonly EmitPiece[],
	fragment: Fragment | undefined,
	page: number,
	par: string | undefined
): EmitPiece[] | undefined {
	const root = fragment === undefined ? -1 : odpTimingRoot(fragment, page)
	const source = fragment === undefined ? -1 : transitionParOf(fragment, root)
	const first = pieces[0]

	if (root >= 0 && pieces.length === 1 && typeof first === "object" && !(first instanceof Uint8Array) && first.hole === root)
		return undefined

	let placed = false
	const out: EmitPiece[] = []

	for (const piece of pieces) {
		if (typeof piece === "object" && !(piece instanceof Uint8Array) && piece.hole === source && source >= 0) {
			if (par !== undefined) out.push(par)

			placed = true

			continue
		}

		out.push(piece)
	}

	if (placed || par === undefined) return out
	if (out.length === 0) return [timingRootWith(par)]

	// First in the root: after its start tag (the first piece, generated or the source's own).
	const head = out[0]

	if (typeof head === "object" && !(head instanceof Uint8Array)) return undefined

	const text = typeof head === "string" ? head : head instanceof Uint8Array ? decodeUtf8(head) : undefined
	const end = text === undefined ? -1 : text.indexOf(">")

	if (text === undefined || end <= 0) return undefined

	// A root written empty (<anim:par …/>) is opened round the par.
	if (text[end - 1] === "/") {
		const name = text.slice(1, text.search(/[\s/>]/u))

		return [`${text.slice(0, end - 1)}>${par}</${name}>${text.slice(end + 1)}`, ...out.slice(1)]
	}

	return [text.slice(0, end + 1) + par + text.slice(end + 1), ...out.slice(1)]
}

// The transition family's markup on its own: the page's transition par (its style properties go through the slide
// family's page style, odpTransitionStyle). The par needs the page's id: a page without one is the slide family's.
export const emitOdpTransition: OdpEmitFamily = {
	emit(request, context) {
		const slide = request.slide

		if (slide.kind !== "slide") return refused("unsupported", "a transition on a node that is not a slide")

		const src = slide.src
		const document = context.document

		if (src?.format !== "odp" || document === undefined) return refused("notFound", "the page of the transition")

		const page = src.node
		const id = document.attribute(page, "xml:id") ?? document.attribute(page, "draw:id")

		if (id === undefined) return refused("notFound", "the page's id")

		const sound = odpTransitionSound(slide.transition, context)

		if (typeof sound === "object") return sound

		const par = odpTransitionPar(slide.transition, id, sound)

		return { kind: "markup", pieces: par === undefined ? [] : [par] }
	}
}
