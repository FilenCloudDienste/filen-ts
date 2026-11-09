import type { Transition } from "../../anim/model"
import { defaultDurationMs, transitionPreset } from "../../anim/presets/transitions/catalog"
import type { XmlDocument } from "../../xml/index"
import { relPart, sourceRef, type ReadContext } from "./drawing"
import { G, partReader, type PartReader } from "./xml"

// A slide's p:transition (ECMA-376 Part 1 §19.3.1.50), directly under p:sld or inside an mc:AlternateContent whose
// Choice holds a p14, p15 or p159 transition (MS-PPTX §2.2.1): the branch we read (the Choice when its namespaces are
// understood, else the Fallback), its kind and effect options (§19.7, MS-PPTX §2.3.1/§2.4.1.5/§2.6.1.1), spd, its
// duration (p14:dur, else the spd's), advClick, advTm and the embedded sound (§19.3.1.48 sndAc). `src` names the
// element under p:sld (the AlternateContent when there is one), `fallback` the Fallback's p:transition. Anything else
// (extLst, a linked sound) stays in the source and is written back by span.

const KIND_GROUPS: ReadonlySet<number> = new Set([G.P, G.P14, G.P15, G.P159])

// The element under p:sld holding the slide's transition (p:transition, or an mc:AlternateContent with one in a
// branch), or -1.
export function transitionElement(r: PartReader, root: number): number {
	for (let child = r.first(root); child >= 0; child = r.next(child)) {
		if (r.is(child, G.P, "transition")) return child
		if (r.is(child, G.MC, "AlternateContent") && branchTransitions(r, child).length > 0) return child
	}

	return -1
}

function branchTransitions(r: PartReader, alternate: number): number[] {
	const out: number[] = []

	for (let branch = r.first(alternate); branch >= 0; branch = r.next(branch)) {
		const transition = r.child(branch, G.P, "transition")

		if (transition >= 0) out.push(transition)
	}

	return out
}

function readElement(r: PartReader, transition: number, context: ReadContext | undefined): Transition {
	let kind = "cut"
	let namespace: Transition["namespace"] = "p"
	let found = false
	const options: Record<string, string | number | boolean> = {}
	let sound: Transition["sound"]

	for (let child = r.first(transition); child >= 0; child = r.next(child)) {
		const group = r.group(child)
		const local = r.local(child)

		if (group === G.P && local === "sndAc") {
			sound = readSound(r, child, context)

			continue
		}

		if (found || !KIND_GROUPS.has(group) || local === "extLst") continue

		found = true
		namespace = group === G.P14 ? "p14" : group === G.P15 ? "p15" : group === G.P159 ? "morph" : "p"
		kind = group === G.P15 && local === "prstTrans" ? (r.attr(child, "prst") ?? "fallOver") : local

		const specs = transitionPreset(kind, namespace)?.options ?? []

		for (const attribute of r.document.attributes(child)) {
			if (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:")) continue

			const colon = attribute.name.indexOf(":")
			const name = colon < 0 ? attribute.name : attribute.name.slice(colon + 1)

			if (name === "prst" && namespace === "p15") continue

			const spec = specs.find(entry => entry.name === name)
			const value = attribute.value.trim()

			options[name] = spec?.kind === "boolean" ? value === "1" || value === "true" : value
		}
	}

	const speed = r.attr(transition, "spd")
	const duration = Number(r.attrNs(transition, G.P14, "dur") ?? Number.NaN)
	const after = Number(r.attr(transition, "advTm") ?? Number.NaN)
	const click = r.attr(transition, "advClick")

	return {
		kind,
		namespace,
		options,
		// p14:dur, else the spd's (fast by default); none for an instant cut.
		durationMs: Number.isFinite(duration) && duration >= 0 ? duration : defaultDurationMs({ kind, namespace, options }, speed),
		...(speed === "slow" || speed === "med" || speed === "fast" ? { speed } : {}),
		advance: { onClick: click !== "false" && click !== "0", ...(Number.isFinite(after) && after >= 0 ? { afterMs: after } : {}) },
		...(sound === undefined ? {} : { sound })
	}
}

function readSound(r: PartReader, sndAc: number, context: ReadContext | undefined): Transition["sound"] {
	if (r.child(sndAc, G.P, "endSnd") >= 0) return { kind: "stop" }

	const start = r.child(sndAc, G.P, "stSnd")
	const snd = r.child(start, G.P, "snd")
	const part = context === undefined ? undefined : relPart(context, r.rel(snd, "embed"))

	// A linked sound stays in the source.
	if (part === undefined) return undefined

	const name = r.attr(snd, "name")

	return { kind: "embedded", part, ...(name === undefined ? {} : { name }), loop: r.bool(start, "loop") === true }
}

// The slide's transition as the model holds it, or undefined without one.
export function readTransition(context: ReadContext, root: number): Transition | undefined {
	const r = context.reader
	const element = transitionElement(r, root)

	if (element < 0) return undefined
	if (r.is(element, G.P, "transition")) return { ...readElement(r, element, context), src: sourceRef(context, element) }

	const branch = r.alternate(element)
	const chosen = branch < 0 ? -1 : r.child(branch, G.P, "transition")
	let fallback = -1

	for (let child = r.first(element); child >= 0; child = r.next(child)) {
		if (r.is(child, G.MC, "Fallback")) fallback = r.child(child, G.P, "transition")
	}

	const read = chosen >= 0 ? chosen : fallback

	if (read < 0) return undefined

	return {
		...readElement(r, read, context),
		...(fallback >= 0 && fallback !== read ? { fallback: sourceRef(context, fallback) } : {}),
		src: sourceRef(context, element)
	}
}

// The p:transition element at `node` of a part (a Fallback a player draws), as the model reads it; its sound is
// left out (the player reads none from it).
export function transitionAt(document: XmlDocument, node: number): Transition | undefined {
	const r = partReader(document)

	return r.is(node, G.P, "transition") ? readElement(r, node, undefined) : undefined
}

// The mc:Fallback transition of a slide's transition as the file holds it (what an application without the Choice
// draws), read from the slide's current document at `epoch`; undefined when the transition is not an
// AlternateContent of that document (one authored in the session, or one with a bare p:transition).
export function fileFallback(transition: Transition, document: XmlDocument, epoch: number): Transition | undefined {
	const src = transition.src

	if (src?.format !== "pptx" || src.epoch !== epoch) return undefined

	const r = partReader(document)

	if (!r.is(src.node, G.MC, "AlternateContent")) return undefined

	for (let child = r.first(src.node); child >= 0; child = r.next(child)) {
		if (r.is(child, G.MC, "Fallback")) return transitionAt(document, r.child(child, G.P, "transition"))
	}

	return undefined
}
