import type { Transition } from "../../../anim/model"
import { ecmaFallback, isEcmaTransition, SPEED_MS, speedOf, writtenOptions } from "../../../anim/presets/transitions/catalog"
import { insertedMediaContent, insertedMediaId, insertedMediaWritten } from "../../../presentation/edit/apply/media"
import { transitionRaw } from "../../../presentation/edit/apply/transition"
import { refused, type Refused } from "../../../presentation/model"
import { escapeAttribute, type XmlDocument, type XmlEditor } from "../../../xml/index"
import { transitionElement } from "../../read/transition"
import { G, partReader, type PartReader } from "../../read/xml"
import type { EmitPiece, EmitResult, PptxEmitFamily } from "../types"
import { attr, sameModel, URIS, type EmitContext } from "./shape"

// A slide's transition as PresentationML (ECMA-376 Part 1 §19.3.1.50 p:transition, §19.7 its kinds; MS-PPTX §2.2.1).
// An ECMA kind at one of the three spd durations is a bare p:transition; any other duration, and every p14, p15 and
// p159 kind, is an mc:AlternateContent the way PowerPoint writes it: a Choice requiring the kind's namespace with
// p14:dur, and a Fallback with the ECMA transition of core/anim/presets/transitions (for an ECMA kind the same one)
// at spd only. A sound inserted in the session is embedded (a stored medium, once per save). An undo back to the
// file's own element writes its bytes. Of the source element, its p:extLst and a
// sound the model could not read (a linked one) are kept by span. No pieces: the slide has none.

const AUDIO_RELATIONSHIP = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio"

// The Choice's Requires and the namespaces it declares, by the kind's namespace.
const REQUIRES: Readonly<Record<Transition["namespace"], { readonly requires: string; readonly declare: readonly string[] }>> = {
	p: { requires: "p14", declare: ["p14"] },
	p14: { requires: "p14", declare: ["p14"] },
	p15: { requires: "p15", declare: ["p14", "p15"] },
	morph: { requires: "p159", declare: ["p14", "p159"] }
}

function kindXml(kind: string, namespace: Transition["namespace"], options: readonly (readonly [string, string])[]): string {
	const attributes = options.map(([name, value]) => attr(name, value)).join("")

	switch (namespace) {
		case "p15":
			return `<p15:prstTrans${attr("prst", kind)}${attributes}/>`
		case "morph":
			// option is required (MS-PPTX §2.6.3.1).
			return `<p159:morph${attr("option", options.find(([name]) => name === "option")?.[1] ?? "byObject")}/>`
		default:
			return `<${namespace}:${kind}${attributes}/>`
	}
}

function isPieces(value: readonly EmitPiece[] | Refused): value is readonly EmitPiece[] {
	return Array.isArray(value)
}

// The source p:transition the slide's transition was read from (the branch read of an AlternateContent).
function sourceTransition(context: EmitContext): { readonly r: PartReader; readonly node: number } | undefined {
	const document = context.document

	if (document === undefined || context.pristine === undefined || context.copier !== undefined || context.documentPart !== undefined)
		return undefined

	const r = partReader(document)
	const element = transitionElement(r, document.documentElement())

	if (element < 0) return undefined
	if (r.is(element, G.P, "transition")) return { r, node: element }

	const branch = r.alternate(element)
	const node = branch < 0 ? -1 : r.child(branch, G.P, "transition")

	return node < 0 ? undefined : { r, node }
}

// The part a transition sound plays: the file's own; for one inserted in the session, the part a committed save wrote
// it to, else its bytes added once as a stored medium (checked against the CRC-32 taken at insert).
function soundPart(context: EmitContext, part: string): string | Refused {
	const id = insertedMediaId(part)

	if (id === undefined) return part

	const written = insertedMediaWritten(context.deck, id)

	if (written !== undefined) return written

	const content = insertedMediaContent(context.deck, id)

	if (content === undefined) return refused("stale", `The inserted sound ${String(id)} is not held`)

	return context.parts.addPart("media", content.bytes, content.contentType, { crc32: content.crc32, shared: content.bytes }).part
}

function soundPieces(
	context: EmitContext,
	transition: Transition,
	kept: { readonly r: PartReader; readonly node: number } | undefined
): readonly EmitPiece[] | Refused {
	const sound = transition.sound

	if (sound?.kind === "stop") return ["<p:sndAc><p:endSnd/></p:sndAc>"]

	if (sound?.kind === "embedded") {
		const part = soundPart(context, sound.part)

		if (typeof part !== "string") return part

		const rId = context.parts.relate(part, AUDIO_RELATIONSHIP)

		return [
			`<p:sndAc><p:stSnd${sound.loop ? ' loop="1"' : ""}><p:snd r:embed="${escapeAttribute(rId)}"${attr("name", sound.name ?? "")}/></p:stSnd></p:sndAc>`
		]
	}

	// A sound the model did not read stays as it was.
	if (kept !== undefined && context.pristine?.slide.transition?.sound === undefined) {
		const source = kept.r.child(kept.node, G.P, "sndAc")

		if (source >= 0) return [{ hole: source }]
	}

	return []
}

function elementPieces(
	transition: Transition,
	kind: string,
	namespace: Transition["namespace"],
	options: readonly (readonly [string, string])[],
	speed: "slow" | "med" | "fast",
	duration: number | undefined,
	tail: readonly EmitPiece[]
): EmitPiece[] {
	const head =
		"<p:transition" +
		(speed === "fast" ? "" : attr("spd", speed)) +
		(transition.advance.onClick ? "" : ' advClick="0"') +
		attr("advTm", transition.advance.afterMs) +
		(duration === undefined ? "" : attr("p14:dur", duration)) +
		">"

	return [head + kindXml(kind, namespace, options), ...tail, "</p:transition>"]
}

// The markup of a slide's transition (none for undefined).
export function pptxTransitionPieces(transition: Transition | undefined, context: EmitContext): readonly EmitPiece[] | Refused {
	if (transition === undefined) return []

	const raw = transitionRaw(transition)

	if (raw !== undefined) return [raw]

	const kept = sourceTransition(context)
	const extLst = kept === undefined ? -1 : kept.r.child(kept.node, G.P, "extLst")
	const sound = soundPieces(context, transition, kept)

	if (!isPieces(sound)) return sound

	const tail: EmitPiece[] = [...sound, ...(extLst >= 0 ? [{ hole: extLst }] : [])]
	const duration = transition.durationMs === undefined ? undefined : Math.round(transition.durationMs)
	const speed = transition.speed ?? speedOf(duration)
	const options = writtenOptions(transition)

	// An instant cut and an ECMA kind at its spd's duration need no p14:dur.
	if (
		isEcmaTransition(transition.kind, transition.namespace) &&
		(duration === undefined || duration === SPEED_MS[speed] || (transition.kind === "cut" && duration === 0))
	)
		return elementPieces(transition, transition.kind, "p", options, speed, undefined, tail)

	const { requires, declare } = REQUIRES[transition.namespace]
	const fallback = ecmaFallback(transition)
	const declarations = declare.map(prefix => ` xmlns:${prefix}="${URIS[prefix] ?? ""}"`).join("")

	return [
		`<mc:AlternateContent xmlns:mc="${URIS["mc"] ?? ""}"><mc:Choice${declarations} Requires="${requires}">`,
		...elementPieces(transition, transition.kind, transition.namespace, options, speed, duration ?? SPEED_MS[speed], tail),
		"</mc:Choice><mc:Fallback>",
		...elementPieces(
			transition,
			fallback.kind,
			"p",
			writtenOptions({ kind: fallback.kind, namespace: "p", options: fallback.options }),
			speed,
			undefined,
			tail
		),
		"</mc:Fallback></mc:AlternateContent>"
	]
}

// Puts a slide's transition markup in place of its source element (p:transition or the mc:AlternateContent holding
// it), or after p:cSld and p:clrMapOvr when it has none (CT_Slide: before p:timing and p:extLst); empty bytes
// remove it.
export function placeTransition(editor: XmlEditor, document: XmlDocument, bytes: Uint8Array): void {
	const r = partReader(document)
	const root = document.documentElement()
	const current = transitionElement(r, root)

	if (current >= 0) {
		if (bytes.length === 0) editor.remove(current)
		else editor.replace(current, bytes)

		return
	}

	if (bytes.length === 0) return

	let anchor = -1

	for (let child = r.first(root); child >= 0; child = r.next(child)) {
		if (r.is(child, G.P, "cSld") || r.is(child, G.P, "clrMapOvr")) anchor = child
	}

	if (anchor >= 0) editor.insertAfter(anchor, bytes)
	else editor.prepend(root, bytes)
}

// Whether two transitions say the same, wherever they were read from (the source refs left out: a rebase moves `src`
// and leaves `fallback` behind).
export function sameTransition(a: Transition | undefined, b: Transition | undefined): boolean {
	if (a === undefined || b === undefined) return a === b

	const { src: _a, fallback: _fa, ...left } = a
	const { src: _b, fallback: _fb, ...right } = b

	return sameModel(left, right)
}

// Whether `node`, a child of p:sld, is the slide's transition element (p:transition, or the mc:AlternateContent
// holding one).
export function isTransitionElement(document: XmlDocument, node: number): boolean {
	return transitionElement(partReader(document), document.documentElement()) === node
}

export const emitPptxTransition: PptxEmitFamily = {
	emit(request, context): EmitResult {
		const slide = request.slide

		if (slide.kind !== "slide") return refused("unsupported", "a transition on a node that is not a slide")

		const pieces = pptxTransitionPieces(slide.transition, context)

		return isPieces(pieces) ? { kind: "markup", pieces } : pieces
	}
}
