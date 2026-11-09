import type { Transition } from "../../model"
import { transitionToOdf, type OdfTransition, type TransitionOptions } from "../../transitions"

// Every slide transition a deck can be given: the 21 of ECMA-376 Part 1 §19.7 (p:blinds … p:zoom), the 19 of
// MS-PPTX §2.3.1 (p14:conveyor … p14:window), the 12 p15:prstTrans presets (§2.4.3.8) and p159:morph (§2.6.1.1).
// Each entry lists its effect options as the schema types them (MS-PPTX §5.1, ECMA-376 Part 1 §A.3 CT_*Transition)
// with the schema's defaults, our default duration, and the ECMA transition written as the mc:Fallback for
// applications that read no p14/p15/p159 (ours: the ECMA motion nearest to the effect; morph falls back to fade, as
// every morph in the corpus does). The ODF mapping is core/anim/transitions.ts's for ECMA kinds and, for the p14/p15
// kinds LibreOffice 7.5 draws, the SMIL names its own pptx import gives them (measured over UNO); the others have no
// ODF equivalent and are written to ODP as their fallback.

export type TransitionGroup = "subtle" | "exciting" | "dynamic"

export type TransitionOptionSpec =
	| { readonly name: string; readonly kind: "choice"; readonly values: readonly string[]; readonly default: string }
	| { readonly name: string; readonly kind: "boolean"; readonly default: boolean }

export interface TransitionPreset {
	// The model's kind: the element's local name, the prst of a p15:prstTrans, or "morph".
	readonly kind: string
	readonly namespace: Transition["namespace"]
	readonly group: TransitionGroup
	readonly options: readonly TransitionOptionSpec[]
	// Our default duration; 0 for cut (instant).
	readonly durationMs: number
}

const SIDE = ["l", "u", "r", "d"] as const
const CORNER = ["lu", "ru", "ld", "rd"] as const
const EIGHT = [...SIDE, ...CORNER] as const
const ORIENTATION = ["horz", "vert"] as const
const IN_OUT = ["in", "out"] as const
const LEFT_RIGHT = ["l", "r"] as const
const SPOKES = ["1", "2", "3", "4", "8"] as const

function choice(name: string, values: readonly string[], fallback: string): TransitionOptionSpec {
	return { name, kind: "choice", values, default: fallback }
}

function flag(name: string): TransitionOptionSpec {
	return { name, kind: "boolean", default: false }
}

function preset(
	kind: string,
	namespace: Transition["namespace"],
	group: TransitionGroup,
	durationMs: number,
	...options: TransitionOptionSpec[]
): TransitionPreset {
	return { kind, namespace, group, options, durationMs }
}

const PRST: readonly TransitionOptionSpec[] = [flag("invX"), flag("invY")]

export const TRANSITION_PRESETS: readonly TransitionPreset[] = [
	preset("morph", "morph", "subtle", 2000, choice("option", ["byObject", "byWord", "byChar"], "byObject")),
	preset("fade", "p", "subtle", 700, flag("thruBlk")),
	preset("push", "p", "subtle", 1000, choice("dir", SIDE, "l")),
	preset("wipe", "p", "subtle", 1000, choice("dir", SIDE, "l")),
	preset("split", "p", "subtle", 1000, choice("orient", ORIENTATION, "horz"), choice("dir", IN_OUT, "out")),
	preset("reveal", "p14", "subtle", 1600, choice("dir", LEFT_RIGHT, "l"), flag("thruBlk")),
	preset("cut", "p", "subtle", 0, flag("thruBlk")),
	preset("randomBar", "p", "subtle", 1000, choice("dir", ORIENTATION, "horz")),
	preset("circle", "p", "subtle", 1000),
	preset("diamond", "p", "subtle", 1000),
	preset("plus", "p", "subtle", 1000),
	preset("zoom", "p", "subtle", 1000, choice("dir", IN_OUT, "out")),
	preset("pull", "p", "subtle", 1000, choice("dir", EIGHT, "l")),
	preset("cover", "p", "subtle", 1000, choice("dir", EIGHT, "l")),
	preset("flash", "p14", "subtle", 800),
	preset("strips", "p", "subtle", 1000, choice("dir", CORNER, "lu")),
	preset("wedge", "p", "subtle", 1000),
	preset("fallOver", "p15", "exciting", 2000, ...PRST),
	preset("drape", "p15", "exciting", 2000, ...PRST),
	preset("curtains", "p15", "exciting", 2000, ...PRST),
	preset("wind", "p15", "exciting", 2000, ...PRST),
	preset("prestige", "p15", "exciting", 2000, ...PRST),
	preset("fracture", "p15", "exciting", 2000, ...PRST),
	preset("crush", "p15", "exciting", 2000, ...PRST),
	preset("peelOff", "p15", "exciting", 2000, ...PRST),
	preset("pageCurlDouble", "p15", "exciting", 2000, ...PRST),
	preset("pageCurlSingle", "p15", "exciting", 2000, ...PRST),
	preset("airplane", "p15", "exciting", 2000, ...PRST),
	preset("origami", "p15", "exciting", 2000, ...PRST),
	preset("dissolve", "p", "exciting", 1000),
	preset("checker", "p", "exciting", 1000, choice("dir", ORIENTATION, "horz")),
	preset("blinds", "p", "exciting", 1000, choice("dir", ORIENTATION, "horz")),
	preset("wheel", "p", "exciting", 1000, choice("spokes", SPOKES, "4")),
	preset("wheelReverse", "p14", "exciting", 1000, choice("spokes", SPOKES, "4")),
	preset("ripple", "p14", "exciting", 1400, choice("dir", ["center", ...CORNER], "center")),
	preset("honeycomb", "p14", "exciting", 3000),
	preset("glitter", "p14", "exciting", 2000, choice("dir", SIDE, "l"), choice("pattern", ["diamond", "hexagon"], "diamond")),
	preset("vortex", "p14", "exciting", 3000, choice("dir", SIDE, "l")),
	preset("shred", "p14", "exciting", 2000, choice("pattern", ["strip", "rectangle"], "strip"), choice("dir", IN_OUT, "in")),
	preset("switch", "p14", "exciting", 1250, choice("dir", LEFT_RIGHT, "r")),
	preset("flip", "p14", "exciting", 1250, choice("dir", LEFT_RIGHT, "r")),
	preset("gallery", "p14", "exciting", 1600, choice("dir", LEFT_RIGHT, "l")),
	preset("prism", "p14", "exciting", 1250, choice("dir", SIDE, "l"), flag("isContent"), flag("isInverted")),
	preset("doors", "p14", "exciting", 1400, choice("dir", ORIENTATION, "horz")),
	preset("comb", "p", "exciting", 1000, choice("dir", ORIENTATION, "horz")),
	preset("warp", "p14", "exciting", 1000, choice("dir", IN_OUT, "in")),
	preset("newsflash", "p", "exciting", 1000),
	preset("random", "p", "exciting", 1000),
	// p:CT_SideDirectionTransition (MS-PPTX §2.3.1.21): dir defaults to "l" (ECMA-376 Part 1 PresentationML schema).
	preset("pan", "p14", "dynamic", 1000, choice("dir", SIDE, "l")),
	preset("ferris", "p14", "dynamic", 2000, choice("dir", LEFT_RIGHT, "l")),
	preset("conveyor", "p14", "dynamic", 2000, choice("dir", LEFT_RIGHT, "l")),
	// p14:doors and p14:window are p:CT_OrientationTransition (MS-PPTX §2.3.1.7, §2.3.1.33), whose dir defaults to
	// "horz" (ECMA-376 Part 1 PresentationML schema).
	preset("window", "p14", "dynamic", 1400, choice("dir", ORIENTATION, "horz")),
	preset("flythrough", "p14", "dynamic", 1000, choice("dir", IN_OUT, "in"), flag("hasBounce"))
]

const BY_KIND = new Map<string, TransitionPreset>(TRANSITION_PRESETS.map(entry => [`${entry.namespace}:${entry.kind}`, entry]))

export function transitionPreset(kind: string, namespace: Transition["namespace"]): TransitionPreset | undefined {
	return BY_KIND.get(`${namespace}:${kind}`)
}

// The kinds written in the PresentationML namespace (the 21 ECMA transitions).
export function isEcmaTransition(kind: string, namespace: Transition["namespace"]): boolean {
	return namespace === "p" && BY_KIND.has(`p:${kind}`)
}

// A preset as a new transition: its default options (left out, the schema supplies them), our duration, advance on
// click.
export function presetTransition(entry: TransitionPreset): Transition {
	return {
		kind: entry.kind,
		namespace: entry.namespace,
		options: {},
		...(entry.durationMs > 0 ? { durationMs: entry.durationMs } : {}),
		advance: { onClick: true }
	}
}

// An option's value as the transition has it, else the schema default.
export function transitionOption(
	transition: Pick<Transition, "kind" | "namespace" | "options">,
	name: string
): string | boolean | undefined {
	const spec = transitionPreset(transition.kind, transition.namespace)?.options.find(option => option.name === name)
	const value = transition.options[name]

	if (spec === undefined) return typeof value === "number" ? String(value) : value
	if (spec.kind === "boolean") return value === true || value === "1" || value === "true"
	if (typeof value === "string" && spec.values.includes(value)) return value
	if (typeof value === "number" && spec.values.includes(String(value))) return String(value)

	return spec.default
}

// Options with a value the schema allows, the defaults left out (what the writer puts on the element).
export function writtenOptions(transition: Pick<Transition, "kind" | "namespace" | "options">): readonly (readonly [string, string])[] {
	const entry = transitionPreset(transition.kind, transition.namespace)

	if (entry === undefined) return []

	const out: [string, string][] = []

	for (const spec of entry.options) {
		if (!(spec.name in transition.options)) continue

		const value = transitionOption(transition, spec.name)

		if (value === spec.default || value === undefined) continue

		out.push([spec.name, typeof value === "boolean" ? (value ? "1" : "0") : value])
	}

	return out
}

// --- the ECMA fallback (mc:Fallback of a p14/p15/p159 transition) ---

export interface EcmaTransition {
	readonly kind: string
	readonly options: TransitionOptions
}

function sideOf(transition: Transition, invert: boolean): string {
	const dir = transitionOption(transition, "dir")

	if (typeof dir === "string" && dir !== "center") return dir

	// p15 presets move left unless their X is inverted.
	return invert ? "r" : "l"
}

// The ECMA transition written as the Fallback of `transition` (itself for an ECMA one).
export function ecmaFallback(transition: Transition): EcmaTransition {
	if (isEcmaTransition(transition.kind, transition.namespace)) return { kind: transition.kind, options: transition.options }

	const invX = transitionOption(transition, "invX") === true
	const option = (name: string): string => {
		const value = transitionOption(transition, name)

		return typeof value === "string" ? value : ""
	}

	switch (transition.kind) {
		case "switch":
		case "flip":
		case "ferris":
		case "gallery":
		case "conveyor":
		case "pan":
		case "prism":
		case "wind":
			return { kind: "push", options: { dir: sideOf(transition, invX) } }
		case "ripple":
			return { kind: "circle", options: {} }
		case "honeycomb":
		case "glitter":
		case "shred":
		case "fracture":
			return { kind: "dissolve", options: {} }
		case "doors":
		case "window":
			return { kind: "split", options: { orient: option("dir") === "vert" ? "vert" : "horz", dir: "out" } }
		case "curtains":
			return { kind: "split", options: { orient: "vert", dir: "out" } }
		case "warp":
		case "flythrough":
			return { kind: "zoom", options: { dir: option("dir") === "out" ? "out" : "in" } }
		case "crush":
			return { kind: "zoom", options: { dir: "in" } }
		case "reveal":
			return { kind: "fade", options: transitionOption(transition, "thruBlk") === true ? { thruBlk: true } : {} }
		case "wheelReverse":
			return { kind: "wheel", options: { spokes: option("spokes") } }
		case "peelOff":
		case "pageCurlDouble":
		case "pageCurlSingle":
		case "airplane":
			return { kind: "pull", options: { dir: invX ? "r" : "l" } }
		default:
			return { kind: "fade", options: {} }
	}
}

// --- ODF (smil:type / smil:subtype / smil:direction, smil:fadeColor) ---

export interface OdfPageTransition extends OdfTransition {
	readonly fadeColor?: string
}

// The p14/p15 kinds LibreOffice 7.5 draws, as the SMIL names its pptx import gives them.
const LIBREOFFICE: Readonly<Record<string, (transition: Transition) => OdfPageTransition>> = {
	vortex: () => ({ type: "miscShapeWipe", subtype: "vertical", reverse: false }),
	ripple: () => ({ type: "miscShapeWipe", subtype: "horizontal", reverse: false }),
	honeycomb: () => ({ type: "miscShapeWipe", subtype: "heart", reverse: false }),
	glitter: () => ({ type: "miscShapeWipe", subtype: "diamond", reverse: false }),
	prism: transition => ({
		type: "miscShapeWipe",
		subtype: transitionOption(transition, "isInverted") === true ? "cornersIn" : "cornersOut",
		reverse: false
	}),
	flash: () => ({ type: "fade", subtype: "fadeOverColor", reverse: false, fadeColor: "#ffffff" }),
	fallOver: () => ({ type: "miscShapeWipe", subtype: "leftToRight", reverse: false })
}

// The SMIL transition an ODP page is written with: the ECMA table's, LibreOffice's for the p14/p15 kinds it draws,
// else the fallback's (`exact` false: ODF has no equivalent). Undefined for cut without black (no transition in
// ODF).
export function odfPageTransition(transition: Transition): { readonly odf: OdfPageTransition; readonly exact: boolean } | undefined {
	const own = transition.options["smilType"]
	const color = transition.options["smilFadeColor"]
	const withColor = (odf: OdfTransition): OdfPageTransition =>
		typeof color === "string" ? { ...odf, fadeColor: color } : odf.subtype === "fadeOverColor" ? { ...odf, fadeColor: "#000000" } : odf

	// Read from ODF: the names as written.
	if (typeof own === "string") {
		const odf = transitionToOdf(transition.kind, transition.options)

		return odf === undefined ? undefined : { odf: withColor(odf), exact: true }
	}

	if (transition.namespace === "p") {
		if (transition.kind === "cut" && transitionOption(transition, "thruBlk") !== true) return undefined

		const odf = transitionToOdf(transition.kind, transition.options)

		return odf === undefined ? undefined : { odf: withColor(odf), exact: true }
	}

	const libreOffice = LIBREOFFICE[transition.kind]

	if (libreOffice !== undefined) return { odf: libreOffice(transition), exact: true }

	const fallback = ecmaFallback(transition)
	const odf = transitionToOdf(fallback.kind, fallback.options)

	return odf === undefined ? undefined : { odf: withColor(odf), exact: false }
}

// The p14/p15 kind a LibreOffice SMIL transition stands for (the inverse of the table above), or undefined.
export function kindFromOdf(
	type: string,
	subtype: string,
	fadeColor: string | undefined
): { readonly kind: string; readonly namespace: Transition["namespace"]; readonly options: TransitionOptions } | undefined {
	if (type === "fade" && subtype === "fadeOverColor" && fadeColor?.toLowerCase() === "#ffffff")
		return { kind: "flash", namespace: "p14", options: {} }
	if (type !== "miscShapeWipe") return undefined

	switch (subtype) {
		case "vertical":
			return { kind: "vortex", namespace: "p14", options: {} }
		case "horizontal":
			return { kind: "ripple", namespace: "p14", options: {} }
		case "heart":
			return { kind: "honeycomb", namespace: "p14", options: {} }
		case "diamond":
			return { kind: "glitter", namespace: "p14", options: {} }
		case "cornersOut":
			return { kind: "prism", namespace: "p14", options: {} }
		case "cornersIn":
			return { kind: "prism", namespace: "p14", options: { isInverted: true } }
		case "leftToRight":
			return { kind: "fallOver", namespace: "p15", options: {} }
		default:
			return undefined
	}
}

// --- speed and duration ---

// p:transition spd's durations (PowerPoint's, as the player and the ODP reader use them).
export const SPEED_MS: Readonly<Record<"slow" | "med" | "fast", number>> = { slow: 1000, med: 750, fast: 500 }

// The spd written beside a duration: the nearest of the three.
export function speedOf(durationMs: number | undefined): "slow" | "med" | "fast" {
	if (durationMs === undefined) return "fast"
	if (durationMs <= 625) return "fast"
	if (durationMs <= 875) return "med"

	return "slow"
}

// A cut not through black (and an effectless p:transition, read as one): the new slide replaces the old at once
// (ECMA-376 Part 1, p:cut), so it takes no time whatever its spd.
export function isInstantCut(transition: Pick<Transition, "kind" | "namespace" | "options">): boolean {
	return transition.kind === "cut" && transition.namespace === "p" && transitionOption(transition, "thruBlk") !== true
}

// The duration a p:transition without p14:dur has: none for an instant cut, else its spd's (fast by default).
export function defaultDurationMs(transition: Pick<Transition, "kind" | "namespace" | "options">, speed: string | undefined): number {
	if (isInstantCut(transition)) return 0

	return SPEED_MS[speed === "slow" || speed === "med" ? speed : "fast"]
}

// The transition's duration in ms: its own, else the one a reader gives it (none for an instant cut, else its speed's).
export function durationOf(transition: Pick<Transition, "durationMs" | "speed" | "kind" | "namespace" | "options">): number {
	if (transition.durationMs !== undefined && Number.isFinite(transition.durationMs)) return Math.max(0, transition.durationMs)

	return defaultDurationMs(transition, transition.speed)
}

// --- what a player draws ---

// The transition a player draws for `transition`: itself when `drawable` says it draws its kind, else its fallback
// (`fallback`, the file's mc:Fallback as read, when the file has one; else ours) with the transition's own duration,
// advance and sound.
export function playableTransition(
	transition: Transition,
	drawable: (kind: string, namespace: Transition["namespace"]) => boolean,
	fallback?: Transition
): Transition {
	if (drawable(transition.kind, transition.namespace)) return transition
	if (fallback !== undefined) return fallback

	const ecma = ecmaFallback(transition)

	return { ...transition, kind: ecma.kind, namespace: "p", options: ecma.options }
}
