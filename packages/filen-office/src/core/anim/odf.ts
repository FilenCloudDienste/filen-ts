import { appendAll } from "../arrays"
import type { Fragment } from "../odp/read/context"
import type { EmitPiece } from "../pptx/write/types"
import type { ColorModel, ShapeNode, SourceRef } from "../presentation/model"
import { tooDeep, tooLarge } from "../presentation/refusal"
import { OdfNs, canonicalName } from "../odf/index"
import { decodeCharacterData, decodeUtf8, encodeUtf8, escapeAttribute } from "../xml/index"
import { attributeEntry, attributeFromOdf, attributeToOdf, isMediaBehavior } from "./attributes"
import { svgMotionPath } from "./motionEdit"
import { heldMarkup, inScope } from "./prune"
import { isPageTransitionPar } from "./presets/transitions/odf"
import type {
	AnimTarget,
	Behavior,
	BehaviorCommon,
	CommonTimeNode,
	PresetClass,
	TimeCondition,
	TimeNode,
	TimeNodeType,
	TimeValue,
	TimingBudgets,
	TimingTree
} from "./model"

// ODF SMIL animations (ODF 1.3 Part 3 anim:* elements with smil:, presentation: and anim: attributes, the
// timing root of a draw:page) mapped onto the ECMA-376 §19.5 timing model, both ways. The tree is the same shape in
// both formats (timing root → main sequence → click groups → effect groups → effects → behaviours), so the mapping is
// node for node:
//   anim:par/seq → par/seq; anim:iterate → par with `iterate`; anim:set/animate/animateColor/animateMotion/
//   animateTransform/transitionFilter/command/audio → set/anim/animClr/animMotion/animRot|animScale/animEffect/cmd/audio;
//   smil:begin/end lists → conditions ("next" and "indefinite" wait for the next click, "id.click" is a shape trigger,
//   "id.begin+1s" a node condition); presentation:node-type/preset-class/preset-id/preset-sub-type → nodeType and the
//   preset numbers through the table LibreOffice 7.5 uses (measured over UNO on every ECMA preset id of each class).
// A page's transition (an anim:par holding only anim:transitionFilter) is not part of the tree; the writer keeps it.
// Writing keeps every node the model holds as read by span and rebuilds an edited one with the attributes and
// children it does not model copied from its source.

// --- Presets: LibreOffice's names for the ECMA preset ids (measured with LibreOffice 7.5.0.3) ---

const CLASS_PREFIX: Readonly<Record<string, string>> = {
	entr: "ooo-entrance-",
	exit: "ooo-exit-",
	emph: "ooo-emphasis-",
	path: "ooo-motionpath-",
	mediacall: "ppt_"
}

const PRESET_NAMES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
	// PowerPoint's media Play, as LibreOffice 7.5 names it.
	mediacall: { 1: "mediacall_1" },
	entr: {
		1: "appear",
		2: "fly-in",
		3: "venetian-blinds",
		4: "box",
		5: "checkerboard",
		6: "circle",
		7: "fly-in-slow",
		8: "diamond",
		9: "dissolve-in",
		10: "fade-in",
		11: "flash-once",
		12: "peek-in",
		13: "plus",
		14: "random-bars",
		15: "spiral-in",
		16: "split",
		17: "stretchy",
		18: "diagonal-squares",
		19: "swivel",
		20: "wedge",
		21: "wheel",
		22: "wipe",
		23: "zoom",
		24: "random",
		25: "boomerang",
		26: "bounce",
		27: "colored-lettering",
		28: "movie-credits",
		29: "ease-in",
		30: "float",
		31: "turn-and-grow",
		34: "breaks",
		35: "pinwheel",
		37: "rise-up",
		38: "falling-in",
		39: "thread",
		40: "unfold",
		41: "whip",
		42: "ascend",
		43: "center-revolve",
		45: "fade-in-and-swivel",
		47: "descend",
		48: "sling",
		49: "spin-in",
		50: "compress",
		51: "magnify",
		52: "curve-up",
		53: "fade-in-and-zoom",
		54: "glide",
		55: "expand",
		56: "flip",
		58: "fold"
	},
	exit: {
		1: "disappear",
		2: "fly-out",
		3: "venetian-blinds",
		4: "box",
		5: "checkerboard",
		6: "circle",
		7: "crawl-out",
		8: "diamond",
		9: "dissolve",
		10: "fade-out",
		11: "flash-once",
		12: "peek-out",
		13: "plus",
		14: "random-bars",
		15: "spiral-out",
		16: "split",
		17: "collapse",
		18: "diagonal-squares",
		19: "swivel",
		20: "wedge",
		21: "wheel",
		22: "wipe",
		23: "zoom",
		24: "random",
		25: "boomerang",
		26: "bounce",
		27: "colored-lettering",
		28: "movie-credits",
		29: "ease-out",
		30: "float",
		31: "turn-and-grow",
		34: "breaks",
		35: "pinwheel",
		37: "sink-down",
		38: "swish",
		39: "thread",
		40: "unfold",
		41: "whip",
		42: "descend",
		43: "center-revolve",
		45: "fade-out-and-swivel",
		47: "ascend",
		48: "sling",
		49: "spin-out",
		50: "stretchy",
		51: "magnify",
		52: "curve-down",
		53: "fade-out-and-zoom",
		54: "glide",
		55: "contract",
		56: "flip",
		58: "fold"
	},
	emph: {
		1: "fill-color",
		2: "font",
		3: "font-color",
		4: "font-size",
		5: "font-style",
		6: "grow-and-shrink",
		7: "line-color",
		8: "spin",
		9: "transparency",
		10: "bold-flash",
		14: "blast",
		15: "bold-reveal",
		16: "color-over-by-word",
		18: "reveal-underline",
		19: "color-blend",
		20: "color-over-by-letter",
		21: "complementary-color",
		22: "complementary-color-2",
		23: "contrasting-color",
		24: "darken",
		25: "desaturate",
		26: "flash-bulb",
		27: "flicker",
		28: "grow-with-color",
		30: "lighten",
		31: "style-emphasis",
		32: "teeter",
		33: "vertical-highlight",
		34: "wave",
		35: "blink",
		36: "shimmer"
	},
	path: {
		1: "circle",
		2: "right-triangle",
		3: "diamond",
		4: "hexagon",
		5: "5-point-star",
		6: "crescent-moon",
		7: "square",
		8: "trapezoid",
		9: "heart",
		10: "octagon",
		11: "6-point-star",
		12: "oval",
		13: "equal-triangle",
		14: "parallelogram",
		15: "pentagon",
		16: "4-point-star",
		17: "8-point-star",
		18: "teardrop",
		19: "pointy-star",
		20: "curved-square",
		21: "curved-x",
		22: "vertical-figure-8",
		23: "curvy-star",
		24: "loop-de-loop",
		25: "buzz-saw",
		26: "horizontal-figure-8",
		27: "peanut",
		28: "figure-8-four",
		29: "neutron",
		30: "swoosh",
		31: "bean",
		32: "clover",
		33: "inverted-triangle",
		34: "inverted-square",
		35: "left",
		36: "turn-down-right",
		37: "arc-down",
		38: "zigzag",
		39: "s-curve-2",
		40: "sine-wave",
		41: "bounce-left",
		42: "down",
		43: "turn-up",
		44: "arc-up",
		45: "heartbeat",
		46: "spiral-right",
		47: "wave",
		48: "curvy-left",
		49: "diagonal-down-right",
		50: "turn-down",
		51: "arc-left",
		52: "funnel",
		53: "spring",
		54: "bounce-right",
		55: "spiral-left",
		56: "diagonal-up-right",
		57: "turn-up-right",
		58: "arc-right",
		59: "s-curve-1",
		60: "decaying-wave",
		61: "curvy-right",
		62: "stairs-down",
		63: "right",
		64: "up"
	}
}

// Entrance and exit subtypes are directions (the ECMA bit pattern of top 1, right 2, bottom 4, left 8, in 16, out 32,
// slightly 256, screen centre 512; measured on every value 0–1099); emphasis, motion paths and the wheel keep the number.
const DIRECTIONS: Readonly<Record<number, string>> = {
	1: "from-top",
	2: "from-right",
	3: "from-top-right",
	4: "from-bottom",
	5: "horizontal",
	6: "from-bottom-right",
	8: "from-left",
	9: "from-top-left",
	10: "vertical",
	12: "from-bottom-left",
	16: "in",
	21: "vertical-in",
	26: "horizontal-in",
	32: "out",
	36: "out-from-screen-center",
	37: "vertical-out",
	42: "horizontal-out",
	272: "in-slightly",
	288: "out-slightly",
	528: "in-from-screen-center"
}

const DIRECTION_OVERRIDES: Readonly<Record<number, Readonly<Record<number, string>>>> = {
	5: { 5: "downward", 10: "across" },
	17: { 10: "across" },
	18: { 3: "right-to-top", 6: "right-to-bottom", 9: "left-to-top", 12: "left-to-bottom" }
}

const ODF_CLASSES: Readonly<Record<string, PresetClass | "custom">> = {
	entrance: "entr",
	exit: "exit",
	emphasis: "emph",
	"motion-path": "path",
	"ole-action": "verb",
	"media-call": "mediacall",
	custom: "custom"
}

const CLASS_TO_ODF: Readonly<Record<PresetClass, string>> = {
	entr: "entrance",
	exit: "exit",
	emph: "emphasis",
	path: "motion-path",
	verb: "ole-action",
	mediacall: "media-call"
}

const NODE_TYPES: Readonly<Record<string, TimeNodeType>> = {
	"timing-root": "tmRoot",
	"main-sequence": "mainSeq",
	"interactive-sequence": "interactiveSeq",
	"on-click": "clickEffect",
	"with-previous": "withEffect",
	"after-previous": "afterEffect"
}

const NODE_TYPES_TO_ODF: Readonly<Partial<Record<TimeNodeType, string>>> = {
	tmRoot: "timing-root",
	mainSeq: "main-sequence",
	interactiveSeq: "interactive-sequence",
	clickEffect: "on-click",
	withEffect: "with-previous",
	afterEffect: "after-previous"
}

function directional(presetClass: PresetClass | undefined, id: number | undefined): boolean {
	return (presetClass === "entr" || presetClass === "exit") && id !== 21
}

// LibreOffice's preset id and subtype for an ECMA preset, undefined when it has no name for it.
export function presetToOdf(
	presetClass: PresetClass | undefined,
	id: number | undefined,
	subtype: number | undefined
): { readonly id?: string; readonly subtype?: string } {
	const names = presetClass === undefined ? undefined : PRESET_NAMES[presetClass]
	const name = id === undefined ? undefined : names?.[id]
	const prefix = presetClass === undefined ? "" : (CLASS_PREFIX[presetClass] ?? "")
	let sub: string | undefined

	if (subtype !== undefined && subtype !== 0) {
		sub = directional(presetClass, id)
			? (DIRECTION_OVERRIDES[id ?? 0]?.[subtype] ?? DIRECTIONS[subtype] ?? String(subtype))
			: String(subtype)
	}

	return { ...(name === undefined ? {} : { id: prefix + name }), ...(sub === undefined ? {} : { subtype: sub }) }
}

const NAME_INDEX = new Map<string, { readonly presetClass: PresetClass; readonly id: number }>()

for (const [presetClass, names] of Object.entries(PRESET_NAMES)) {
	for (const [id, name] of Object.entries(names)) {
		NAME_INDEX.set(`${CLASS_PREFIX[presetClass] ?? ""}${name}`, { presetClass: presetClass as PresetClass, id: Number(id) })
	}
}

// The ECMA preset of a LibreOffice preset id and subtype.
export function presetFromOdf(
	name: string | undefined,
	subtype: string | undefined
): { readonly presetClass?: PresetClass; readonly id?: number; readonly subtype?: number } {
	// Some writers put the ECMA number itself in presentation:preset-id.
	if (name !== undefined && /^\d+$/u.test(name.trim())) {
		const number = Number(subtype)

		return { id: Number(name), ...(subtype !== undefined && /^\d+$/u.test(subtype.trim()) && number !== 0 ? { subtype: number } : {}) }
	}

	const preset = name === undefined ? undefined : NAME_INDEX.get(name)

	if (preset === undefined) return {}

	let sub: number | undefined

	if (subtype !== undefined) {
		const number = Number(subtype)

		if (subtype.trim() !== "" && Number.isFinite(number)) sub = number
		else {
			const overrides = DIRECTION_OVERRIDES[preset.id] ?? {}
			const match =
				Object.entries(overrides).find(([, value]) => value === subtype) ??
				Object.entries(DIRECTIONS).find(([, value]) => value === subtype)

			if (match !== undefined) sub = Number(match[0])
		}
	}

	return { presetClass: preset.presetClass, id: preset.id, ...(sub === undefined ? {} : { subtype: sub }) }
}

// --- animEffect filters ↔ anim:transitionFilter (SMIL type/subtype, direction reverse) ---

const FILTERS: readonly (readonly [string, string, string, boolean])[] = [
	["fade", "fade", "crossfade", false],
	["dissolve", "dissolve", "", false],
	["blinds(horizontal)", "blindsWipe", "horizontal", false],
	["blinds(vertical)", "blindsWipe", "vertical", false],
	["box(in)", "irisWipe", "rectangle", true],
	["box(out)", "irisWipe", "rectangle", false],
	["checkerboard(across)", "checkerBoardWipe", "across", false],
	["checkerboard(down)", "checkerBoardWipe", "down", false],
	["circle(in)", "ellipseWipe", "circle", true],
	["circle(out)", "ellipseWipe", "circle", false],
	["diamond(in)", "irisWipe", "diamond", true],
	["diamond(out)", "irisWipe", "diamond", false],
	["plus(in)", "fourBoxWipe", "cornersIn", false],
	["plus(out)", "fourBoxWipe", "cornersOut", false],
	["barn(inVertical)", "barnDoorWipe", "vertical", true],
	["barn(outVertical)", "barnDoorWipe", "vertical", false],
	["barn(inHorizontal)", "barnDoorWipe", "horizontal", true],
	["barn(outHorizontal)", "barnDoorWipe", "horizontal", false],
	["randombar(horizontal)", "randomBarWipe", "horizontal", false],
	["randombar(vertical)", "randomBarWipe", "vertical", false],
	["strips(downLeft)", "waterfallWipe", "horizontalLeft", false],
	["strips(upLeft)", "waterfallWipe", "horizontalLeft", true],
	["strips(downRight)", "waterfallWipe", "horizontalRight", false],
	["strips(upRight)", "waterfallWipe", "horizontalRight", true],
	["wedge", "fanWipe", "centerTop", false],
	["wheel(1)", "pinWheelWipe", "oneBlade", false],
	["wheel(2)", "pinWheelWipe", "twoBladeVertical", false],
	["wheel(3)", "pinWheelWipe", "threeBlade", false],
	["wheel(4)", "pinWheelWipe", "fourBlade", false],
	["wheel(8)", "pinWheelWipe", "eightBlade", false],
	["wipe(right)", "barWipe", "leftToRight", false],
	["wipe(left)", "barWipe", "leftToRight", true],
	["wipe(down)", "barWipe", "topToBottom", false],
	["wipe(up)", "barWipe", "topToBottom", true],
	["slide(fromTop)", "slideWipe", "fromTop", false],
	["slide(fromBottom)", "slideWipe", "fromBottom", false],
	["slide(fromLeft)", "slideWipe", "fromLeft", false],
	["slide(fromRight)", "slideWipe", "fromRight", false]
]

export function filterToOdf(filter: string): { readonly type: string; readonly subtype?: string; readonly reverse: boolean } | undefined {
	const entry = FILTERS.find(([name]) => name === filter) ?? FILTERS.find(([name]) => name === filter.replace(/\(.*$/u, ""))

	return entry === undefined ? undefined : { type: entry[1], ...(entry[2] === "" ? {} : { subtype: entry[2] }), reverse: entry[3] }
}

export function filterFromOdf(type: string, subtype: string | undefined, reverse: boolean): string {
	const exact = FILTERS.find(([, t, s, r]) => t === type && (s === "" || s === subtype) && r === reverse)
	const loose = exact ?? FILTERS.find(([, t, s]) => t === type && (s === "" || s === subtype)) ?? FILTERS.find(([, t]) => t === type)

	return loose?.[0] ?? `${type}${subtype === undefined ? "" : `(${subtype})`}`
}

// --- Values ---

// A SMIL clock value (smil:dur, smil:begin offsets): "0.5s", "500ms", "2", "00:00:01.5", "indefinite".
export function parseClock(text: string | undefined): TimeValue | undefined {
	if (text === undefined) return undefined

	const value = text.trim()

	if (value === "indefinite") return "indefinite"

	const unit = /^(-?\d+(?:\.\d*)?|-?\.\d+)(h|min|s|ms)?$/u.exec(value)

	if (unit !== null) {
		const number = Number(unit[1])
		const scale = unit[2] === "h" ? 3_600_000 : unit[2] === "min" ? 60_000 : unit[2] === "ms" ? 1 : 1000

		return Number.isFinite(number) ? Math.round(number * scale * 1000) / 1000 : undefined
	}

	const clock = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/u.exec(value)

	if (clock !== null) return ((Number(clock[1] ?? 0) * 60 + Number(clock[2])) * 60 + Number(clock[3])) * 1000

	return undefined
}

// How long a node's content plays once from its begin: its own duration, else its children's by their delays.
function naturalSpan(node: TimeNode): number {
	const dur = node.ctn.dur

	if (typeof dur === "number") return dur
	if (dur === "indefinite") return 0

	let span = 0

	for (const child of node.ctn.children) {
		const delay = child.ctn.stCondLst.find(c => c.evt === undefined && c.tn === undefined && typeof c.delay === "number")?.delay
		const at = (typeof delay === "number" ? delay : 0) + naturalSpan(child)

		span = node.kind === "seq" ? span + at : Math.max(span, at)
	}

	return span
}

// The smil:attributeName written on an anim:animateMotion whose model names no attribute.
const MOTION_ATTRIBUTE = "translate"

// anim:iterate-interval is an xsd:duration (LibreOffice writes "PT00H00M00.1S"); a SMIL clock value is read too.
export function parseDuration(text: string | undefined): number | undefined {
	const match = text === undefined ? null : /^\s*PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?\s*$/u.exec(text)

	if (match === null) {
		const clock = parseClock(text)

		return typeof clock === "number" ? clock : undefined
	}

	const ms = ((Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 1000

	return Number.isFinite(ms) ? Math.round(ms * 1000) / 1000 : undefined
}

export function formatDuration(ms: number): string {
	return `PT${(Math.round(ms * 1000) / 1e6).toFixed(6).replace(/\.?0+$/u, "")}S`
}

export function formatClock(value: TimeValue): string {
	if (value === "indefinite") return "indefinite"

	// Microsecond precision, as fixed-point (SMIL clock values have no exponent).
	return `${(Math.round(value * 1000) / 1e6).toFixed(6).replace(/\.?0+$/u, "")}s`
}

// ECMA time-animate formulas use #ppt_x… ; LibreOffice's SMIL values use x, y, width, height.
const TO_ODF_VARIABLES: Readonly<Record<string, string>> = { ppt_x: "x", ppt_y: "y", ppt_w: "width", ppt_h: "height" }
const FROM_ODF_VARIABLES: Readonly<Record<string, string>> = { x: "#ppt_x", y: "#ppt_y", width: "#ppt_w", height: "#ppt_h" }

export function formulaToOdf(text: string): string {
	return text.replace(/#?(ppt_[xywh])\b/gu, (_, name: string) => TO_ODF_VARIABLES[name] ?? name)
}

export function formulaFromOdf(text: string): string {
	return text.replace(/(?<![A-Za-z_#.])(x|y|width|height)(?![A-Za-z_(])/gu, (_, name: string) => FROM_ODF_VARIABLES[name] ?? name)
}

function colorFromOdf(text: string | undefined): ColorModel | undefined {
	const match = text === undefined ? null : /^#([0-9A-Fa-f]{6})$/u.exec(text.trim())

	return match === null ? undefined : { kind: "srgb", rgb: (match[1] ?? "").toUpperCase() }
}

function colorToOdf(color: ColorModel | undefined): string | undefined {
	return color?.kind === "srgb" ? `#${color.rgb.toLowerCase()}` : undefined
}

function fraction(text: string | undefined): number | undefined {
	if (text === undefined) return undefined

	const value = Number(text.trim())

	return text.trim() !== "" && Number.isFinite(value) ? value : undefined
}

function decimal(value: number): string {
	return String(Math.round(value * 1e6) / 1e6)
}

// --- Reading ---

const CONTAINERS: ReadonlySet<string> = new Set(["anim:par", "anim:seq", "anim:iterate"])
const BEHAVIORS: ReadonlySet<string> = new Set([
	"anim:set",
	"anim:animate",
	"anim:animateColor",
	"anim:animateMotion",
	"anim:animateTransform",
	"anim:transitionFilter",
	"anim:command",
	"anim:audio"
])

// The page's timing root (anim:par presentation:node-type="timing-root", or the page's one anim:par), or -1.
export function odpTimingRoot(fragment: Fragment, page: number): number {
	const document = fragment.document

	for (let child = page < 0 ? -1 : document.firstChildElement(page); child >= 0; child = document.nextSiblingElement(child)) {
		if (fragment.name(child) === "anim:par") return child
	}

	return -1
}

// The page transition par (an untargeted transition filter, with only the transition's sound beside it), not an
// effect.
function isTransitionPar(fragment: Fragment, node: number): boolean {
	return isPageTransitionPar(fragment, node)
}

// The paragraphs a target may name: each text:p of a shape by its xml:id, else its text:id.
function paragraphIds(
	fragment: Fragment,
	shapes: readonly ShapeNode[]
): Map<string, { readonly shape: number; readonly paragraph: number }> {
	const out = new Map<string, { readonly shape: number; readonly paragraph: number }>()
	const visit = (list: readonly ShapeNode[]): void => {
		for (const shape of list) {
			for (const [index, paragraph] of (shape.text?.paragraphs ?? []).entries()) {
				const src = paragraph.src

				if (src?.format !== "odp" || src.fragment !== fragment.offset) continue

				const attributes = fragment.attributes(src.node)

				for (const name of ["xml:id", "text:id"]) {
					const id = attributes.get(name)

					if (id !== undefined && !out.has(id)) out.set(id, { shape: shape.id, paragraph: index })
				}
			}

			if (shape.children !== undefined) visit(shape.children)
		}
	}

	visit(shapes)

	return out
}

// The id a shape is targeted by: its xml:id, else its draw:id.
function shapeIds(fragment: Fragment, shapes: readonly ShapeNode[]): Map<string, number> {
	const out = new Map<string, number>()
	const visit = (list: readonly ShapeNode[]): void => {
		for (const shape of list) {
			if (shape.src?.format === "odp" && shape.src.fragment === fragment.offset) {
				const attributes = fragment.attributes(shape.src.node)

				for (const name of ["xml:id", "draw:id"]) {
					const id = attributes.get(name)

					if (id !== undefined && !out.has(id)) out.set(id, shape.id)
				}
			}

			if (shape.children !== undefined) visit(shape.children)
		}
	}

	visit(shapes)

	return out
}

class OdfTimingReader {
	private readonly fragment: Fragment
	private readonly budgets: TimingBudgets
	private readonly shapes: Map<string, number>
	private readonly paragraphs: Map<string, { readonly shape: number; readonly paragraph: number }>
	// The smil:targetElement of the anim:iterate being read: its children animate what it iterates.
	private iterated: string | undefined
	// Anim node xml:ids to the ctn ids given in document order.
	private readonly nodeIds = new Map<string, number>()
	// Nodes naming a presentation:master-element: after-effects (LibreOffice's dim and hide), put under their master.
	private readonly afterEffects: { readonly time: TimeNode; readonly element: number; readonly master: string }[] = []
	private readonly order = new Map<number, number>()
	private count = 0

	constructor(fragment: Fragment, budgets: TimingBudgets, shapes: readonly ShapeNode[]) {
		this.fragment = fragment
		this.budgets = budgets
		this.shapes = shapeIds(fragment, shapes)
		this.paragraphs = paragraphIds(fragment, shapes)
	}

	// First pass: ids for every anim element, so begin lists may name later nodes.
	number(node: number, depth: number): void {
		const fragment = this.fragment
		const document = fragment.document

		if (depth >= this.budgets.depth) tooDeep("time nodes", this.budgets.depth)
		if (this.count >= this.budgets.nodesPerSlide) tooLarge("time nodes on a slide", this.budgets.nodesPerSlide)

		const id = ++this.count
		const attributes = fragment.attributes(node)
		const xmlId = attributes.get("xml:id") ?? attributes.get("anim:id")

		this.order.set(node, id)

		if (xmlId !== undefined && !this.nodeIds.has(xmlId)) this.nodeIds.set(xmlId, id)

		if (!CONTAINERS.has(fragment.name(node))) return

		for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
			const name = fragment.name(child)

			if ((CONTAINERS.has(name) || BEHAVIORS.has(name)) && !isTransitionPar(fragment, child)) this.number(child, depth + 1)
		}
	}

	private src(node: number): SourceRef {
		return this.fragment.src(node)
	}

	private target(id: string | undefined, subItem: string | undefined): AnimTarget {
		if (id === undefined) return { kind: "slide" }

		const paragraph = this.paragraphs.get(id)

		if (paragraph !== undefined)
			return { kind: "text", shape: paragraph.shape, unit: "para", start: paragraph.paragraph, end: paragraph.paragraph }

		const shape = this.shapes.get(id)

		if (shape === undefined) return { kind: "slide" }

		// anim:sub-item (the text only, or the shape without it) has no ECMA target form: it stays on the element.
		void subItem

		return { kind: "shape", shape }
	}

	// A begin or end list: "0s; id3.click; id7.end+0.5s; next; indefinite".
	conditions(text: string | undefined): TimeCondition[] {
		if (text === undefined) return []

		const out: TimeCondition[] = []

		for (const raw of text.split(";")) {
			const value = raw.trim()

			if (value === "") continue
			if (value === "next" || value === "indefinite") {
				out.push(value === "next" ? { evt: "onNext", delay: 0 } : { delay: "indefinite" })

				continue
			}

			const plain = parseClock(value)

			if (plain !== undefined) {
				out.push({ delay: plain })

				continue
			}

			const match = /^([^.+\-\s]+)\.(click|begin|end|dblclick|mouseover|mouseout|beginEvent|endEvent)\s*(?:([+-])\s*(.+))?$/u.exec(
				value
			)

			if (match === null) continue

			const offset = match[4] === undefined ? 0 : parseClock(match[4])
			const delay = offset === undefined || offset === "indefinite" ? 0 : match[3] === "-" ? -offset : offset
			const ref = match[1] ?? ""
			const event = match[2] ?? ""

			if (event === "begin" || event === "end" || event === "beginEvent" || event === "endEvent") {
				const tn = this.nodeIds.get(ref)
				const shape = this.shapes.get(ref)

				if (tn !== undefined) out.push({ evt: event.startsWith("begin") ? "onBegin" : "onEnd", delay, tn })
				else if (shape !== undefined)
					out.push({ evt: event.startsWith("begin") ? "onBegin" : "onEnd", delay, tgtEl: { kind: "shape", shape } })

				continue
			}

			const shape = this.shapes.get(ref)

			if (shape === undefined) continue

			const evt =
				event === "click" ? "onClick" : event === "dblclick" ? "onDblClick" : event === "mouseover" ? "onMouseOver" : "onMouseOut"

			out.push({ evt, delay, tgtEl: { kind: "shape", shape } })
		}

		return out
	}

	node(node: number): TimeNode | undefined {
		const time = this.read(node)
		const master = time === undefined ? undefined : this.fragment.attributes(node).get("presentation:master-element")

		if (time !== undefined && master !== undefined) this.afterEffects.push({ time, element: node, master })

		return time
	}

	// An after-effect (a node with presentation:master-element, ODF 1.3 §19.402) as the p:subTnLst member PresentationML
	// holds it in: one inside its master (or beside a master that is a behaviour) plays from the master's begin by its
	// delay (masterRel sameClick), one elsewhere (LibreOffice puts "dim / hide on next click" in the next click's group)
	// at the next click, as one inside its master that waits indefinitely (written so when the slide has no next click).
	afterEffectsOf(root: TimeNode): void {
		if (this.afterEffects.length === 0) return

		const document = this.fragment.document
		const byId = new Map<number, TimeNode>()
		const parents = new Map<TimeNode, TimeNode>()
		const stack: TimeNode[] = [root]

		for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
			byId.set(node.ctn.id, node)

			for (const child of node.ctn.children) {
				parents.set(child, node)
				stack.push(child)
			}
		}

		const within = (inner: number, outer: number): boolean =>
			document.start(inner) >= document.start(outer) && document.end(inner) <= document.end(outer)

		for (const { time, element, master } of this.afterEffects) {
			const id = this.nodeIds.get(master)
			const owner = id === undefined ? undefined : byId.get(id)
			const parent = parents.get(time)
			const ownerElement = owner?.ctn.src?.format === "odp" ? owner.ctn.src.node : -1

			if (owner === undefined || parent === undefined || ownerElement < 0 || within(ownerElement, element)) continue

			const beside = owner.kind === "behavior" && document.parent(element) === document.parent(ownerElement)
			const inside = within(element, ownerElement) || beside
			const waits = time.ctn.stCondLst.length > 0 && time.ctn.stCondLst.every(c => c.delay === "indefinite" && c.evt === undefined)

			parent.ctn.children.splice(parent.ctn.children.indexOf(time), 1)
			time.ctn.masterRel = inside && !waits ? "sameClick" : "nextClick"

			if (waits) time.ctn.stCondLst = [{ delay: 0 }]
			;(owner.ctn.subTnLst ??= []).push(time)
		}
	}

	private read(node: number): TimeNode | undefined {
		const fragment = this.fragment
		const document = fragment.document
		const name = fragment.name(node)
		const a = fragment.attributes(node)
		const id = this.order.get(node)

		if (id === undefined) return undefined

		const ctn: CommonTimeNode = {
			id,
			stCondLst: this.conditions(a.get("smil:begin")),
			endCondLst: this.conditions(a.get("smil:end")),
			children: [],
			src: this.src(node)
		}
		const set = <K extends keyof CommonTimeNode>(key: K, value: CommonTimeNode[K] | undefined): void => {
			if (value !== undefined) ctn[key] = value
		}
		const dur = parseClock(a.get("smil:dur"))
		const repeat = a.get("smil:repeatCount")
		const repeatNumber = fraction(repeat)
		const fill = a.get("smil:fill")
		const restart = a.get("smil:restart")
		const accel = fraction(a.get("smil:accelerate"))
		const decel = fraction(a.get("smil:decelerate"))
		const preset = presetFromOdf(a.get("presentation:preset-id"), a.get("presentation:preset-sub-type"))
		const odfClass = a.get("presentation:preset-class")
		const presetClass = odfClass === undefined ? undefined : ODF_CLASSES[odfClass]
		const group = fraction(a.get("presentation:group-id"))

		set("dur", dur)
		set(
			"repeatCount",
			repeat === "indefinite" ? "indefinite" : repeatNumber === undefined ? undefined : Math.round(repeatNumber * 1000)
		)
		set("repeatDur", parseClock(a.get("smil:repeatDur")))
		set("fill", fill === "remove" || fill === "freeze" || fill === "hold" || fill === "transition" ? fill : undefined)
		set("restart", restart === "always" || restart === "whenNotActive" || restart === "never" ? restart : undefined)
		set("accel", accel === undefined ? undefined : Math.round(accel * 100000))
		set("decel", decel === undefined ? undefined : Math.round(decel * 100000))
		set("autoRev", a.has("smil:autoReverse") ? a.get("smil:autoReverse") === "true" : undefined)
		set("nodeType", NODE_TYPES[a.get("presentation:node-type") ?? ""])
		set("presetClass", presetClass === "custom" ? undefined : (presetClass ?? preset.presetClass))
		set("presetID", preset.id)
		set("presetSubtype", preset.subtype)

		// Another application's names (no ECMA number for them) are kept as written.
		if (preset.id === undefined) set("presetName", a.get("presentation:preset-id"))
		const subtypeText = a.get("presentation:preset-sub-type")

		// A number is presetSubtype's (0 being none); only a name the table does not know is kept as written.
		if (preset.subtype === undefined && subtypeText !== undefined && !/^\s*\d+\s*$/u.test(subtypeText))
			set("presetSubtypeName", subtypeText)
		set("grpId", group === undefined ? undefined : Math.trunc(group))

		if (CONTAINERS.has(name)) {
			if (name === "anim:iterate") {
				const type = a.get("anim:iterate-type")
				const interval = a.get("anim:iterate-interval")
				const ms = parseDuration(interval)

				ctn.iterate = {
					type: type === "by-word" ? "wd" : type === "by-letter" ? "lt" : "el",
					interval: { ms: typeof ms === "number" ? ms : 0 },
					backwards: false
				}
			}

			const outer = this.iterated

			if (name === "anim:iterate") this.iterated = a.get("smil:targetElement") ?? outer

			try {
				for (let child = document.firstChildElement(node); child >= 0; child = document.nextSiblingElement(child)) {
					const time = this.node(child)

					if (time !== undefined) ctn.children.push(time)
				}
			} finally {
				this.iterated = outer
			}

			return { kind: name === "anim:seq" ? "seq" : "par", ctn }
		}

		const behavior = this.behavior(name, a)

		return behavior === undefined ? undefined : { kind: "behavior", behavior, ctn }
	}

	private behavior(name: string, a: ReadonlyMap<string, string>): Behavior | undefined {
		const target = this.target(a.get("smil:targetElement") ?? this.iterated, a.get("anim:sub-item"))
		const named = a.get("smil:attributeName")
		const odfAttribute = name === "anim:animateMotion" && named === MOTION_ATTRIBUTE ? undefined : named
		const attribute = odfAttribute === undefined ? undefined : (attributeFromOdf(odfAttribute) ?? odfAttribute)
		const additive = a.get("smil:additive")
		const accumulate = a.get("smil:accumulate")
		const common: BehaviorCommon = {
			target,
			attrNames: attribute === undefined ? [] : [attribute],
			...(additive === "sum" ? { additive: "sum" as const } : additive === "replace" ? { additive: "repl" as const } : {}),
			...(accumulate === "sum" ? { accumulate: "always" as const } : {})
		}

		switch (name) {
			case "anim:set": {
				const to = a.get("smil:to")
				// A colour attribute's value (LibreOffice's "dim" after-effect sets color) is a colour, as p:clrVal.
				const dom = attribute === undefined ? undefined : attributeEntry(attribute)?.dom
				const color = dom === "fill" || dom === "stroke" || dom === "textColor" ? colorFromOdf(to) : undefined

				return { type: "set", common, ...(color !== undefined ? { to: color } : to === undefined ? {} : { to }) }
			}
			case "anim:animate": {
				const values = (a.get("smil:values") ?? "").split(";").filter(value => value.trim() !== "")
				const times = (a.get("smil:keyTimes") ?? "").split(";").map(value => Number(value))
				const from = a.get("smil:from")
				const to = a.get("smil:to")
				const list = values.length > 0 ? values : [from, to].filter((value): value is string => value !== undefined)
				const formula = a.get("anim:formula")
				const calc = a.get("smil:calcMode")

				return {
					type: "anim",
					common,
					calcmode: calc === "discrete" ? "discrete" : formula !== undefined ? "fmla" : "lin",
					valueType: "num",
					tavLst: list.map((value, k) => {
						const time = times[k]
						const tm =
							time !== undefined && Number.isFinite(time)
								? Math.round(time * 100000)
								: list.length === 1
									? 0
									: Math.round((k / (list.length - 1)) * 100000)
						const number = Number(value)

						return {
							tm,
							...(formula === undefined ? {} : { fmla: formulaFromOdf(formula) }),
							val: value.trim() !== "" && Number.isFinite(number) ? number : formulaFromOdf(value.trim())
						}
					})
				}
			}
			case "anim:animateColor": {
				const from = colorFromOdf(a.get("smil:from"))
				const to = colorFromOdf(a.get("smil:to"))

				return {
					type: "animClr",
					common,
					clrSpc: a.get("anim:color-interpolation") === "hsl" ? "hsl" : "rgb",
					...(a.has("anim:color-interpolation-direction")
						? { dir: a.get("anim:color-interpolation-direction") === "counter-clockwise" ? ("ccw" as const) : ("cw" as const) }
						: {}),
					...(from === undefined ? {} : { from }),
					...(to === undefined ? {} : { to })
				}
			}
			case "anim:animateMotion": {
				const path = a.get("svg:path")

				return { type: "animMotion", common, ...(path === undefined ? {} : { path }) }
			}
			case "anim:animateTransform": {
				const type = a.get("svg:type")

				if (type === "rotate") {
					const angle = (text: string | undefined): number | undefined => {
						const value = fraction(text)

						return value === undefined ? undefined : Math.round(value * 60000)
					}
					const by = angle(a.get("smil:by"))
					const from = angle(a.get("smil:from"))
					const to = angle(a.get("smil:to"))

					return {
						type: "animRot",
						common: { ...common, attrNames: ["r"] },
						...(by === undefined ? {} : { by }),
						...(from === undefined ? {} : { from }),
						...(to === undefined ? {} : { to })
					}
				}

				const point = (text: string | undefined): { x: number; y: number } | undefined => {
					if (text === undefined) return undefined

					const [x, y] = text.split(/[\s,]+/u).map(Number)

					return x === undefined || !Number.isFinite(x)
						? undefined
						: { x: Math.round(x * 100000), y: Math.round((y !== undefined && Number.isFinite(y) ? y : x) * 100000) }
				}
				const by = point(a.get("smil:by"))
				const from = point(a.get("smil:from"))
				const to = point(a.get("smil:to"))

				return {
					type: "animScale",
					common,
					...(by === undefined ? {} : { by }),
					...(from === undefined ? {} : { from }),
					...(to === undefined ? {} : { to })
				}
			}
			case "anim:transitionFilter": {
				const type = a.get("smil:type") ?? "fade"

				return {
					type: "animEffect",
					common,
					transition: a.get("smil:mode") === "out" ? "out" : "in",
					filter: filterFromOdf(type, a.get("smil:subtype"), a.get("smil:direction") === "reverse")
				}
			}
			case "anim:command": {
				const command = a.get("anim:command") ?? "custom"

				return {
					type: "cmd",
					common,
					cmdType: command === "verb" ? "verb" : "call",
					cmd: command === "toggle-pause" ? "togglePause" : command === "play" ? "playFrom(0.0)" : command
				}
			}
			case "anim:audio": {
				const href = a.get("xlink:href")

				return { type: "audio", target: { kind: "sound", ...(href === undefined ? {} : { name: href }) } }
			}
			default:
				return undefined
		}
	}
}

// The page's timing as the model holds it, undefined without one. `shapes` are the page's shapes as read (their source
// elements carry the ids smil:targetElement names). Throws tooLarge/tooDeep past the budgets.
export function readOdpTiming(
	fragment: Fragment,
	page: number,
	shapes: readonly ShapeNode[],
	budgets: TimingBudgets
): TimingTree | undefined {
	const root = odpTimingRoot(fragment, page)
	const media = pluginPlayback(fragment, shapes)

	if (root < 0) return media.length === 0 ? undefined : { root: mediaRoot(media), builds: [] }

	const reader = new OdfTimingReader(fragment, budgets, shapes)

	reader.number(root, 0)

	const tree = reader.node(root)

	if (tree !== undefined) reader.afterEffectsOf(tree)
	if (tree === undefined || (tree.ctn.children.length === 0 && media.length === 0)) return undefined

	return { root: media.length === 0 ? tree : withMedia(tree, media), builds: [], src: fragment.src(root) }
}

// A medium's playback options the frame's draw:plugin gives (ODF 1.3 §10.4.7 draw:param, the names LibreOffice
// writes: Loop, Mute, VolumeDB), as the media node PresentationML holds them in (p:video/p:audio of the shape, a
// child of the timing root started by an event): only where they differ from the defaults. Never written back as
// timing (OdfTimingWriter skips them); the plugin keeps them (core/odp/write/emit/media.ts).
type MediaNodeOptions = { readonly shape: ShapeNode; readonly loop: boolean; readonly mute: boolean; readonly vol: number | undefined }

function pluginPlayback(fragment: Fragment, shapes: readonly ShapeNode[]): MediaNodeOptions[] {
	const out: MediaNodeOptions[] = []
	const document = fragment.document
	const visit = (list: readonly ShapeNode[], depth: number): void => {
		if (depth > 64) return

		for (const shape of list) {
			if (shape.children !== undefined) visit(shape.children, depth + 1)

			const src = shape.src

			if (shape.frame?.kind !== "media" || src?.format !== "odp" || src.fragment !== fragment.offset) continue

			let loop = false
			let mute = false
			let vol: number | undefined

			for (let child = document.firstChildElement(src.node); child >= 0; child = document.nextSiblingElement(child)) {
				if (fragment.name(child) !== "draw:plugin") continue

				for (let param = document.firstChildElement(child); param >= 0; param = document.nextSiblingElement(param)) {
					if (fragment.name(param) !== "draw:param") continue

					const attributes = fragment.attributes(param)
					const value = attributes.get("draw:value")?.trim().toLowerCase()

					switch (attributes.get("draw:name")) {
						case "Loop":
							loop = value === "true"
							break
						case "Mute":
							mute = value === "true"
							break
						case "VolumeDB": {
							const db = Number(value)

							vol =
								Number.isFinite(db) && db < 0
									? Math.max(0, Math.min(100_000, Math.round(100_000 * 10 ** (db / 20))))
									: undefined
							break
						}
					}
				}

				break
			}

			if (loop || mute || vol !== undefined) out.push({ shape, loop, mute, vol })
		}
	}

	visit(shapes, 0)

	return out
}

function mediaNode(options: MediaNodeOptions, id: number): TimeNode {
	const media = options.shape.media ?? (options.shape.frame?.kind === "media" ? options.shape.frame.media : undefined)

	return {
		kind: "behavior",
		behavior: {
			type: media?.kind ?? "video",
			target: { kind: "shape", shape: options.shape.id },
			...(options.vol === undefined ? {} : { vol: options.vol }),
			...(options.mute ? { mute: true } : {})
		},
		ctn: {
			id,
			fill: "hold",
			stCondLst: [{ delay: "indefinite" }],
			endCondLst: [],
			children: [],
			...(options.loop ? { repeatCount: "indefinite" as const } : {})
		}
	}
}

function largestId(node: TimeNode): number {
	let max = node.ctn.id

	for (const child of node.ctn.children) max = Math.max(max, largestId(child))

	return max
}

function mediaRoot(media: readonly MediaNodeOptions[]): TimeNode {
	return {
		kind: "par",
		ctn: {
			id: 1,
			nodeType: "tmRoot",
			dur: "indefinite",
			restart: "never",
			stCondLst: [],
			endCondLst: [],
			children: media.map((options, k) => mediaNode(options, k + 2))
		}
	}
}

function withMedia(tree: TimeNode, media: readonly MediaNodeOptions[]): TimeNode {
	const first = largestId(tree) + 1

	return { ...tree, ctn: { ...tree.ctn, children: [...tree.ctn.children, ...media.map((options, k) => mediaNode(options, first + k))] } }
}

// --- Writing ---

// The xml:id (else anim:id) on the start tag of markup an undo held for a node.
function heldId(node: TimeNode): string | undefined {
	const held = heldMarkup(node.ctn)

	if (held === undefined) return undefined

	const end = held.indexOf(0x3e)
	const head = decodeUtf8(held, 0, end < 0 ? held.length : end)

	return /\s(?:xml:id|anim:id)\s*=\s*(?:"([^"]*)"|'([^']*)')/u
		.exec(head)
		?.slice(1)
		.find(id => id !== undefined)
}

// Numbering a source tree already read within the deck's budgets.
const NUMBERING_BUDGETS: TimingBudgets = {
	nodesPerSlide: Number.MAX_SAFE_INTEGER,
	depth: Number.MAX_SAFE_INTEGER,
	motionSegments: 0,
	scheduleMs: 0,
	eventsPerShow: 0
}

const WRITTEN_PREFIXES = ["anim", "smil", "presentation", "svg", "xlink"] as const

const ELEMENT: Readonly<Record<string, string>> = {
	set: "anim:set",
	anim: "anim:animate",
	animClr: "anim:animateColor",
	animMotion: "anim:animateMotion",
	animRot: "anim:animateTransform",
	animScale: "anim:animateTransform",
	animEffect: "anim:transitionFilter",
	cmd: "anim:command",
	audio: "anim:audio",
	video: "anim:audio"
}

// Canonical attribute names the writer models; anything else on a rebuilt element is copied from its source.
const MODELED: ReadonlySet<string> = new Set([
	"smil:begin",
	"smil:end",
	"smil:dur",
	"smil:repeatCount",
	"smil:repeatDur",
	"smil:fill",
	"smil:restart",
	"smil:accelerate",
	"smil:decelerate",
	"smil:autoReverse",
	"presentation:node-type",
	"presentation:preset-class",
	"presentation:preset-id",
	"presentation:preset-sub-type",
	"presentation:group-id",
	"presentation:master-element",
	"smil:targetElement",
	"smil:attributeName",
	"smil:to",
	"smil:from",
	"smil:by",
	"smil:values",
	"smil:keyTimes",
	"smil:calcMode",
	"anim:formula",
	"smil:additive",
	"smil:accumulate",
	"anim:color-interpolation",
	"anim:color-interpolation-direction",
	"svg:path",
	"svg:type",
	"smil:type",
	"smil:subtype",
	"smil:direction",
	"smil:mode",
	"anim:command",
	"anim:iterate-type",
	"anim:iterate-interval",
	"xlink:href"
])

export interface OdpTimingContext {
	// The page fragment the timing is spliced into (undefined for a fresh page).
	readonly fragment: Fragment | undefined
	// The page's shapes, for target ids.
	readonly shapes: readonly ShapeNode[]
	// Ids the writer gave shapes that had none (document-unique), by model id.
	readonly ids?: ReadonlyMap<number, string>
	// Ids the writer gave the paragraphs a by-paragraph effect targets that had none, by odpParagraphKey.
	readonly paragraphIds?: ReadonlyMap<string, string>
	// What the ids this page's timing makes start with: xml:id is unique in the whole document (ODF 1.3 Part 1
	// §19.914), model shape and time node ids only on their slide, so a writer of several new pages names each apart.
	readonly idPrefix?: string
}

// The id the writer names a target shape by: its source xml:id (else draw:id), or `prefix` + "id" + its model id.
export function odpTargetId(shape: ShapeNode, fragment?: Fragment, prefix = ""): string {
	if (fragment !== undefined && shape.src?.format === "odp" && shape.src.fragment === fragment.offset) {
		const attributes = fragment.attributes(shape.src.node)
		const id = attributes.get("xml:id") ?? attributes.get("draw:id")

		if (id !== undefined) return id
	}

	return `${prefix}id${String(shape.id)}`
}

// A paragraph target (ECMA p:pRg) is named in ODF as LibreOffice names it: smil:targetElement is the text:p's own
// xml:id (anim:sub-item="text" on the behaviours that animate the text). Keyed by shape id and paragraph index.
export function odpParagraphKey(shape: number, paragraph: number): string {
	return `${String(shape)}:${String(paragraph)}`
}

// The id the writer names paragraph `index` of `shape` by: its source xml:id (else text:id), or `prefix` + "id" + the
// shape's model id + "p" + the index.
export function odpParagraphId(shape: ShapeNode, index: number, fragment?: Fragment, prefix = ""): string {
	const src = odpOwnParagraphSource(shape, index)

	if (fragment !== undefined && src?.format === "odp" && src.fragment === fragment.offset) {
		const attributes = fragment.attributes(src.node)
		const id = attributes.get("xml:id") ?? attributes.get("text:id")

		if (id !== undefined) return id
	}

	return `${prefix}id${String(shape.id)}p${String(index)}`
}

// A paragraph's source when it is the first of its body to name it (the text writer gives a source's ids to that one
// only; a later paragraph naming the same source is written as new).
export function odpOwnParagraphSource(shape: ShapeNode, index: number): SourceRef | undefined {
	const paragraphs = shape.text?.paragraphs ?? []
	const src = paragraphs[index]?.src

	if (src === undefined) return undefined

	for (let k = 0; k < index; k++) {
		const other = paragraphs[k]?.src

		if (
			other !== undefined &&
			other.format === src.format &&
			other.part === src.part &&
			other.node === src.node &&
			other.epoch === src.epoch &&
			(other.format !== "odp" || src.format !== "odp" || other.fragment === src.fragment)
		)
			return undefined
	}

	return src
}

// The paragraphs a slide's timing targets one by one (their written text:p elements need the ids odpParagraphId gives).
export function odpParagraphTargets(tree: TimingTree | undefined): readonly { readonly shape: number; readonly paragraph: number }[] {
	const out = new Map<string, { readonly shape: number; readonly paragraph: number }>()
	const stack = tree === undefined ? [] : [tree.root]

	for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
		if (node.kind === "behavior" && !isMediaBehavior(node.behavior)) {
			const target = node.behavior.common.target

			if (target.kind === "text" && target.unit === "para" && target.start === target.end)
				out.set(odpParagraphKey(target.shape, target.start), { shape: target.shape, paragraph: target.start })
		}

		appendAll(stack, node.ctn.children)
		appendAll(stack, node.ctn.subTnLst ?? [])
	}

	return [...out.values()]
}

// The shapes a slide's timing targets (their written elements need the ids odpTargetId gives).
export function odpTargetIds(tree: TimingTree | undefined): ReadonlySet<number> {
	const out = new Set<number>()
	const add = (target: AnimTarget | undefined): void => {
		if (target !== undefined && target.kind !== "slide" && target.kind !== "sound") out.add(target.shape)
	}
	const visit = (node: TimeNode): void => {
		for (const c of [...node.ctn.stCondLst, ...node.ctn.endCondLst]) add(c.tgtEl)

		if (node.kind === "behavior") add(isMediaBehavior(node.behavior) ? node.behavior.target : node.behavior.common.target)

		for (const child of node.ctn.children) visit(child)
		for (const child of node.ctn.subTnLst ?? []) visit(child)
	}

	if (tree !== undefined) visit(tree.root)

	return out
}

function attribute(name: string, value: string | undefined): string {
	return value === undefined ? "" : ` ${name}="${escapeAttribute(value)}"`
}

function sameModel(a: unknown, b: unknown): boolean {
	if (a === b) return true
	if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b)
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false

		return a.every((value, k) => sameModel(value, b[k]))
	}

	const left = a as Record<string, unknown>
	const right = b as Record<string, unknown>

	for (const key of Object.keys(left)) if (key !== "src" && !sameModel(left[key], right[key])) return false
	for (const key of Object.keys(right)) if (key !== "src" && left[key] === undefined && right[key] !== undefined) return false

	return true
}

class OdfTimingWriter {
	private readonly fragment: Fragment | undefined
	private readonly pristine: ReadonlyMap<number, TimeNode>
	private readonly targetIds: ReadonlyMap<number, string>
	private readonly shapeNodes = new Map<number, ShapeNode>()
	private readonly paragraphIds: ReadonlyMap<string, string> | undefined
	private readonly prefix: string
	// ctn ids named by a node condition, and the xml:id each is written with.
	private readonly referenced = new Map<number, string>()

	// The source's id maps, for reading its begin and end lists again.
	private readonly reader: OdfTimingReader | undefined
	// After-effects (p:subTnLst members) and the xml:id of their master; the next-click ones per the node they are
	// written in (the next click's first group), and those with no next click (written in the master, waiting).
	private readonly masters = new Map<TimeNode, number>()
	private readonly placed = new Map<TimeNode, TimeNode[]>()
	private readonly waiting = new Set<TimeNode>()

	constructor(context: OdpTimingContext, tree: TimingTree, pristine: TimingTree | undefined) {
		this.fragment = context.fragment
		this.prefix = context.idPrefix ?? ""
		this.paragraphIds = context.paragraphIds

		const root = this.fragment === undefined ? -1 : this.sourceOf(tree.root)

		if (this.fragment !== undefined && root >= 0) {
			this.reader = new OdfTimingReader(this.fragment, NUMBERING_BUDGETS, context.shapes)
			this.reader.number(root, 0)
		}

		const index = new Map<number, TimeNode>()
		const visitPristine = (node: TimeNode): void => {
			if (node.ctn.src !== undefined) index.set(node.ctn.src.node, node)

			for (const child of node.ctn.children) visitPristine(child)
			for (const child of node.ctn.subTnLst ?? []) visitPristine(child)
		}

		if (pristine !== undefined) visitPristine(pristine.root)

		this.pristine = index

		const ids = new Map<number, string>()
		const visitShapes = (shapes: readonly ShapeNode[]): void => {
			for (const shape of shapes) {
				ids.set(shape.id, context.ids?.get(shape.id) ?? odpTargetId(shape, this.fragment, this.prefix))
				this.shapeNodes.set(shape.id, shape)

				if (shape.children !== undefined) visitShapes(shape.children)
			}
		}

		visitShapes(context.shapes)
		this.targetIds = ids

		const byId = new Map<number, TimeNode>()
		const collect = (node: TimeNode): void => {
			byId.set(node.ctn.id, node)

			for (const c of [...node.ctn.stCondLst, ...node.ctn.endCondLst]) if (c.tn !== undefined) this.referenced.set(c.tn, "")

			for (const child of node.ctn.children) collect(child)

			for (const sub of node.ctn.subTnLst ?? []) {
				// An after-effect names its master by the master's xml:id.
				this.referenced.set(node.ctn.id, "")
				this.masters.set(sub, node.ctn.id)
				collect(sub)
			}
		}

		collect(tree.root)
		this.placeAfterEffects(tree.root)

		for (const id of this.referenced.keys()) {
			const node = byId.get(id)
			const source = node === undefined ? -1 : this.sourceOf(node)
			const own =
				source < 0 || this.fragment === undefined
					? node === undefined
						? undefined
						: heldId(node)
					: this.fragment.attributes(source).get("xml:id")

			this.referenced.set(id, own ?? `${this.prefix}anim${String(id)}`)
		}
	}

	// "On next click" after-effects go to the first group of the main sequence's next click (where LibreOffice plays
	// them); without one they wait in their master.
	private placeAfterEffects(root: TimeNode): void {
		const nexts: TimeNode[] = []
		const stack: TimeNode[] = [root]

		for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
			for (const sub of node.ctn.subTnLst ?? []) if (sub.ctn.masterRel === "nextClick") nexts.push(sub)

			appendAll(stack, node.ctn.children)
		}

		if (nexts.length === 0) return

		const find = (node: TimeNode): TimeNode | undefined =>
			node.ctn.nodeType === "mainSeq" ? node : node.ctn.children.map(find).find(found => found !== undefined)
		const clicks = find(root)?.ctn.children ?? []
		const clickOf = new Map<number, number>()

		clicks.forEach((click, k) => {
			const inner: TimeNode[] = [click]

			for (let node = inner.pop(); node !== undefined; node = inner.pop()) {
				clickOf.set(node.ctn.id, k)
				appendAll(inner, node.ctn.children)
			}
		})

		for (const sub of nexts) {
			const click = clickOf.get(this.masters.get(sub) ?? -1)
			const next = click === undefined ? undefined : clicks[click + 1]
			const target = next === undefined ? undefined : (next.ctn.children[0] ?? next)

			if (target === undefined) {
				this.waiting.add(sub)
				continue
			}

			const list = this.placed.get(target)

			if (list === undefined) this.placed.set(target, [sub])
			else list.push(sub)
		}
	}

	// Whether the source element of `node` already holds the after-effects written in it.
	private holds(node: TimeNode, source: number): boolean {
		const document = this.fragment?.document

		for (const sub of this.placed.get(node) ?? []) {
			const own = this.sourceOf(sub)

			if (
				document === undefined ||
				own < 0 ||
				document.start(own) < document.start(source) ||
				document.end(own) > document.end(source)
			)
				return false
		}

		return true
	}

	private sourceOf(node: TimeNode): number {
		const src = node.ctn.src
		const fragment = this.fragment

		return fragment !== undefined && src?.format === "odp" && src.fragment === fragment.offset && src.epoch === fragment.epoch
			? src.node
			: -1
	}

	// The element an iterated container's first behaviour animates.
	private iteratedName(node: TimeNode): string | undefined {
		const stack: TimeNode[] = [node]

		for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
			if (at.kind === "behavior")
				return this.targetName(isMediaBehavior(at.behavior) ? at.behavior.target : at.behavior.common.target)

			for (let k = at.ctn.children.length - 1; k >= 0; k--) {
				const child = at.ctn.children[k]

				if (child !== undefined) stack.push(child)
			}
		}

		return undefined
	}

	private targetName(target: AnimTarget): string | undefined {
		if (target.kind === "slide" || target.kind === "sound") return undefined

		if (target.kind === "text" && target.unit === "para" && target.start === target.end) {
			const shape = this.shapeNodes.get(target.shape)
			const given = this.paragraphIds?.get(odpParagraphKey(target.shape, target.start))

			if (given !== undefined) return given
			if (shape !== undefined) return odpParagraphId(shape, target.start, this.fragment, this.prefix)
		}

		return this.targetIds.get(target.shape) ?? `${this.prefix}id${String(target.shape)}`
	}

	private conditionList(conditions: readonly TimeCondition[]): string | undefined {
		const out: string[] = []

		for (const c of conditions) {
			const delay = c.delay === "indefinite" ? undefined : c.delay
			const offset = delay === undefined || delay === 0 ? "" : `${delay < 0 ? "-" : "+"}${formatClock(Math.abs(delay))}`

			if (c.tn !== undefined) {
				out.push(
					`${this.referenced.get(c.tn) ?? `anim${String(c.tn)}`}.${c.evt === "onEnd" || c.evt === "end" ? "end" : "begin"}${offset}`
				)
			} else if (c.evt === "onNext") {
				out.push("next")
			} else if (c.evt === "onMediaBookmark") {
				// ODF has no media bookmarks: started on a click of the clip instead, as PowerPoint's Fallback for readers
				// without p14 starts it (a conversion reports it); a clip not written waits.
				const name = c.tgtEl === undefined ? undefined : this.targetName(c.tgtEl)

				out.push(name === undefined ? "indefinite" : `${name}.click${offset}`)
			} else if (c.evt !== undefined && c.tgtEl !== undefined && this.targetName(c.tgtEl) !== undefined) {
				const event =
					c.evt === "onClick"
						? "click"
						: c.evt === "onDblClick"
							? "dblclick"
							: c.evt === "onMouseOver"
								? "mouseover"
								: c.evt === "onMouseOut"
									? "mouseout"
									: c.evt === "onBegin" || c.evt === "begin"
										? "begin"
										: "end"

				out.push(`${this.targetName(c.tgtEl) ?? ""}.${event}${offset}`)
			} else if (c.evt === undefined) {
				out.push(c.delay === "indefinite" ? "indefinite" : formatClock(c.delay))
			}
		}

		return out.length === 0 ? undefined : out.join(";")
	}

	// A begin or end list as the source wrote it when it reads as the model holds it (tokens the model cannot hold, such as a
	// page's id, stay), else written from the model.
	private conditionText(node: TimeNode, name: "smil:begin" | "smil:end", conditions: readonly TimeCondition[]): string | undefined {
		const source = this.sourceOf(node)
		const own = source < 0 || this.fragment === undefined ? undefined : this.fragment.attributes(source).get(name)

		if (own !== undefined && this.reader !== undefined && sameModel(this.reader.conditions(own), conditions)) return own

		return this.conditionList(conditions)
	}

	private ctnAttributes(node: TimeNode): string {
		const ctn = node.ctn
		const preset = presetToOdf(ctn.presetClass, ctn.presetID, ctn.presetSubtype)
		const xmlId = this.referenced.get(ctn.id)
		// anim:command takes no timing of its own beyond its begin and end (ODF 1.3 Part 3 §15.6.1, its schema: no
		// smil:dur, smil:fill, repeats, restart, acceleration or reverse).
		const timed = !(node.kind === "behavior" && node.behavior.type === "cmd")

		return (
			attribute(
				"smil:begin",
				this.waiting.has(node) && node.kind !== "behavior" ? "indefinite" : this.conditionText(node, "smil:begin", ctn.stCondLst)
			) +
			attribute("smil:end", this.conditionText(node, "smil:end", ctn.endCondLst)) +
			(timed ? this.timingAttributes(ctn) : "") +
			attribute("presentation:node-type", ctn.nodeType === undefined ? undefined : NODE_TYPES_TO_ODF[ctn.nodeType]) +
			attribute("presentation:preset-class", ctn.presetClass === undefined ? undefined : CLASS_TO_ODF[ctn.presetClass]) +
			attribute("presentation:preset-id", preset.id ?? ctn.presetName) +
			attribute("presentation:preset-sub-type", preset.subtype ?? ctn.presetSubtypeName) +
			attribute("presentation:group-id", ctn.grpId === undefined ? undefined : String(ctn.grpId)) +
			(xmlId === undefined || this.hasOwnXmlId(node) ? "" : attribute("xml:id", xmlId)) +
			// ODF 1.3 allows it on containers (common-anim-attlist): a behaviour's goes on the par afterEffect() wraps it in.
			attribute(
				"presentation:master-element",
				node.kind === "behavior" ? undefined : this.referenced.get(this.masters.get(node) ?? -1)
			)
		)
	}

	private timingAttributes(ctn: CommonTimeNode): string {
		return (
			attribute("smil:dur", ctn.dur === undefined ? undefined : formatClock(ctn.dur)) +
			attribute(
				"smil:repeatCount",
				ctn.repeatCount === undefined
					? undefined
					: ctn.repeatCount === "indefinite"
						? "indefinite"
						: decimal(ctn.repeatCount / 1000)
			) +
			attribute("smil:repeatDur", ctn.repeatDur === undefined ? undefined : formatClock(ctn.repeatDur)) +
			attribute("smil:fill", ctn.fill) +
			attribute("smil:restart", ctn.restart) +
			attribute("smil:accelerate", ctn.accel === undefined ? undefined : decimal(ctn.accel / 100000)) +
			attribute("smil:decelerate", ctn.decel === undefined ? undefined : decimal(ctn.decel / 100000)) +
			attribute("smil:autoReverse", ctn.autoRev === undefined ? undefined : String(ctn.autoRev))
		)
	}

	private hasOwnXmlId(node: TimeNode): boolean {
		const source = this.sourceOf(node)

		return source >= 0 && this.fragment !== undefined && this.fragment.attributes(source).has("xml:id")
	}

	// The source element's start tag up to its ">" or "/>", when its attributes are exactly the ones `head` writes.
	private sourceHead(source: number, head: string): Uint8Array | undefined {
		const fragment = this.fragment

		if (fragment === undefined) return undefined

		const document = fragment.document
		const written = [...head.matchAll(/\s([^\s=]+)="([^"]*)"/gu)].map(match => {
			const value = encodeUtf8(match[2] ?? "")

			return `${match[1] ?? ""}\u0000${decodeCharacterData(value, 0, value.length, true)}`
		})
		const own = document.attributes(source).map(attribute => `${attribute.name}\u0000${attribute.value}`)

		if (written.length !== own.length) return undefined

		written.sort()
		own.sort()

		if (written.some((entry, k) => entry !== own[k])) return undefined

		const tag = document.bytes.subarray(document.start(source), document.openEnd(source))
		let end = tag.length - 1

		if (document.isSelfClosing(source)) {
			end--

			while (end > 0 && (tag[end - 1] === 0x20 || tag[end - 1] === 0x09 || tag[end - 1] === 0x0a || tag[end - 1] === 0x0d)) end--
		}

		return tag.subarray(0, end)
	}

	// The source element's attributes the writer does not model, as written (a preset id the table has no number for
	// included, and anim:sub-item unless the writer wrote one).
	private unmodeled(source: number, wroteSubItem: boolean): string {
		const fragment = this.fragment

		if (fragment === undefined || source < 0) return ""

		let out = ""

		for (const written of fragment.document.attributes(source)) {
			const colon = written.name.indexOf(":")
			const prefix = colon < 0 ? "" : written.name.slice(0, colon)

			// The element's own namespace declarations travel with it.
			if (written.name === "xmlns" || prefix === "xmlns") {
				out += attribute(written.name, written.value)

				continue
			}

			const local = colon < 0 ? written.name : written.name.slice(colon + 1)
			const name =
				prefix === "" ? local : prefix === "xml" ? `xml:${local}` : canonicalName(fragment.namespaces.uri(source, prefix), local)

			if (name === "anim:sub-item" && wroteSubItem) continue
			// Preset ids and subtypes are the model's too (presetName/presetSubtypeName hold names without a number).
			if (MODELED.has(name)) continue

			out += attribute(written.name, written.value)
		}

		return out
	}

	private behaviorAttributes(behavior: Behavior): string {
		if (isMediaBehavior(behavior)) {
			return attribute("xlink:href", behavior.target.kind === "sound" ? behavior.target.name : undefined)
		}

		const common = behavior.common
		const target = this.targetName(common.target)
		const first = common.attrNames[0]
		const name = first === undefined ? undefined : (attributeToOdf(first) ?? first)
		const head =
			attribute("smil:targetElement", target) +
			(common.target.kind === "text" ? attribute("anim:sub-item", "text") : "") +
			attribute("smil:additive", common.additive === "sum" ? "sum" : common.additive === "repl" ? "replace" : undefined) +
			attribute("smil:accumulate", common.accumulate === "always" ? "sum" : undefined)

		switch (behavior.type) {
			case "set":
				return (
					head +
					attribute("smil:attributeName", name) +
					attribute(
						"smil:to",
						behavior.to === undefined
							? undefined
							: typeof behavior.to === "object"
								? colorToOdf(behavior.to)
								: String(behavior.to)
					)
				)
			case "anim": {
				const values = behavior.tavLst.map(tav =>
					tav.val === undefined ? "" : typeof tav.val === "object" ? (colorToOdf(tav.val) ?? "") : formulaToOdf(String(tav.val))
				)
				const times = behavior.tavLst.map(tav => (tav.tm === "indefinite" ? "0" : decimal(tav.tm / 100000)))
				const fmla = behavior.tavLst.find(tav => tav.fmla !== undefined)?.fmla

				return (
					head +
					attribute("smil:attributeName", name) +
					attribute("smil:values", values.join(";")) +
					attribute("smil:keyTimes", times.join(";")) +
					attribute("anim:formula", fmla === undefined ? undefined : formulaToOdf(fmla)) +
					attribute("smil:calcMode", behavior.calcmode === "discrete" ? "discrete" : undefined)
				)
			}
			case "animClr":
				return (
					head +
					attribute("smil:attributeName", name) +
					attribute("smil:from", colorToOdf(behavior.from)) +
					attribute("smil:to", colorToOdf(behavior.to)) +
					attribute("anim:color-interpolation", behavior.clrSpc) +
					attribute(
						"anim:color-interpolation-direction",
						behavior.dir === undefined ? undefined : behavior.dir === "ccw" ? "counter-clockwise" : "clockwise"
					)
				)
			case "animMotion":
				// ODF 1.3 requires smil:attributeName on anim:animateMotion (common-anim-named-target-attlist); a motion that
				// names none is written "translate", which reads back as naming none. svg:path is SVG path data, which has
				// no §19.5.4 E end mark.
				return (
					head +
					attribute("smil:attributeName", name ?? MOTION_ATTRIBUTE) +
					attribute("svg:path", behavior.path === undefined ? undefined : svgMotionPath(behavior.path))
				)
			case "animRot": {
				const angle = (value: number | undefined): string | undefined => (value === undefined ? undefined : decimal(value / 60000))

				return (
					head +
					attribute("smil:attributeName", "transform") +
					attribute("svg:type", "rotate") +
					attribute("smil:by", angle(behavior.by)) +
					attribute("smil:from", angle(behavior.from)) +
					attribute("smil:to", angle(behavior.to))
				)
			}
			case "animScale": {
				const point = (value: { readonly x: number; readonly y: number } | undefined): string | undefined =>
					value === undefined ? undefined : `${decimal(value.x / 100000)},${decimal(value.y / 100000)}`

				return (
					head +
					attribute("smil:attributeName", "transform") +
					attribute("svg:type", "scale") +
					attribute("smil:by", point(behavior.by)) +
					attribute("smil:from", point(behavior.from)) +
					attribute("smil:to", point(behavior.to))
				)
			}
			case "animEffect": {
				const filter = filterToOdf(behavior.filter ?? "fade") ?? { type: "fade", subtype: "crossfade", reverse: false }

				return (
					head +
					attribute("smil:type", filter.type) +
					attribute("smil:subtype", filter.subtype) +
					attribute("smil:direction", filter.reverse ? "reverse" : undefined) +
					attribute("smil:mode", behavior.transition === "out" ? "out" : undefined)
				)
			}
			case "cmd": {
				const command = behavior.cmd.startsWith("playFrom")
					? "play"
					: behavior.cmd === "togglePause"
						? "toggle-pause"
						: behavior.cmd === "stop"
							? "stop"
							: behavior.cmd

				return head + attribute("anim:command", behavior.cmdType === "verb" ? "verb" : command)
			}
		}
	}

	// Declarations for the prefixes the writer uses that the page does not bind as such (a file that declares the
	// animation namespace on its timing root only); the source root's own declarations are copied with it.
	declarations(source: number, written: string): string {
		const fragment = this.fragment

		if (fragment === undefined) return ""

		const document = fragment.document
		const scope = source >= 0 ? document.parent(source) : document.firstChildElement(document.documentElement())
		const own = source >= 0 ? new Set(document.attributes(source).map(entry => entry.name)) : new Set<string>()
		let out = ""

		for (const prefix of WRITTEN_PREFIXES) {
			const uri = OdfNs[prefix]

			if (!written.includes(`${prefix}:`)) continue
			if (scope >= 0 && fragment.namespaces.prefixFor(scope, uri) === prefix) continue
			if (own.has(`xmlns:${prefix}`)) continue

			out += attribute(`xmlns:${prefix}`, uri)
		}

		return out
	}

	// The source element of the tree's root, when it is the element written for it.
	rootSource(tree: TimingTree): number {
		const source = this.sourceOf(tree.root)

		return source >= 0 && this.fragment?.name(source) === "anim:par" ? source : -1
	}

	// `around`: the source element of the nearest written ancestor that has one (whose namespace scope this node is in).
	node(node: TimeNode, out: EmitPiece[], around = -1): void {
		// A medium's own playback node: ODF keeps those options in its frame's draw:plugin (pluginPlayback), and
		// anim:audio plays a sound, never a shape.
		if (node.kind === "behavior" && isMediaBehavior(node.behavior) && node.behavior.target.kind === "shape") return

		const source = this.sourceOf(node)
		const before = source >= 0 ? this.pristine.get(source) : undefined
		const held = source < 0 ? heldMarkup(node.ctn) : undefined

		// A node whose source a save took out, put back by an undo: written as its source was.
		if (held !== undefined) {
			out.push(
				this.fragment === undefined
					? held
					: inScope(held, this.fragment.namespaces.inScope(around < 0 ? this.fragment.document.documentElement() : around))
			)

			return
		}

		if (source >= 0 && before !== undefined && sameModel(node, before) && this.holds(node, source)) {
			out.push({ hole: source })

			// A behaviour's after-effects stand beside it, outside its element.
			if (node.kind === "behavior")
				for (const sub of node.ctn.subTnLst ?? [])
					if (sub.ctn.masterRel !== "nextClick" || this.waiting.has(sub)) this.afterEffect(sub, out, around)

			return
		}

		const name =
			node.kind === "behavior"
				? (ELEMENT[node.behavior.type] ?? "anim:set")
				: node.kind === "seq"
					? "anim:seq"
					: node.ctn.iterate !== undefined
						? "anim:iterate"
						: "anim:par"
		const fragment = this.fragment
		const sameElement = source >= 0 && fragment !== undefined && fragment.name(source) === name
		let head = `<${name}${this.ctnAttributes(node)}`

		if (node.kind === "behavior") head += this.behaviorAttributes(node.behavior)

		if (node.ctn.iterate !== undefined && node.kind !== "behavior") {
			const iterate = node.ctn.iterate

			head +=
				// What it iterates (its children animate the same element).
				attribute("smil:targetElement", this.iteratedName(node)) +
				attribute("anim:iterate-type", iterate.type === "wd" ? "by-word" : iterate.type === "lt" ? "by-letter" : "by-paragraph") +
				// ODF has no share of the duration (tmPct): its time from the effect's duration.
				attribute(
					"anim:iterate-interval",
					formatDuration("ms" in iterate.interval ? iterate.interval.ms : (iterate.interval.pct / 100000) * naturalSpan(node))
				)
		}

		head += this.unmodeled(
			sameElement ? source : -1,
			node.kind === "behavior" && !isMediaBehavior(node.behavior) && node.behavior.common.target.kind === "text"
		)

		// After-effects: in their master, after its children (a behaviour's beside it), and those of the click before.
		const subs = (node.ctn.subTnLst ?? []).filter(sub => sub.ctn.masterRel !== "nextClick" || this.waiting.has(sub))
		const children = node.ctn.children
		const after = [...(node.kind === "behavior" ? [] : subs), ...(this.placed.get(node) ?? [])]
		// The source's own start tag when it says the same (its attribute order and quoting kept).
		const open = sameElement ? (this.sourceHead(source, head) ?? head) : head

		if (children.length === 0 && after.length === 0 && node.kind === "behavior") {
			out.push(typeof open === "string" ? `${open}/>` : concatBytes(open, encodeUtf8("/>")))

			for (const sub of subs) this.afterEffect(sub, out, around)

			return
		}

		out.push(typeof open === "string" ? `${open}>` : concatBytes(open, encodeUtf8(">")))

		// The page transition par stays first in the root, as LibreOffice reads it.
		if (sameElement && fragment !== undefined && node.ctn.nodeType === "tmRoot") {
			for (let child = fragment.document.firstChildElement(source); child >= 0; child = fragment.document.nextSiblingElement(child)) {
				if (isTransitionPar(fragment, child)) out.push({ hole: child })
			}
		}

		for (const child of children) this.node(child, out, sameElement ? source : around)
		for (const sub of after) this.afterEffect(sub, out, sameElement ? source : around)

		out.push(`</${name}>`)
	}

	// An after-effect: a container carries presentation:master-element itself; a behaviour (which may not) is wrapped in
	// a par that does, beginning with where it is written (or waiting, when the slide has no next click).
	private afterEffect(sub: TimeNode, out: EmitPiece[], around: number): void {
		if (sub.kind !== "behavior") {
			this.node(sub, out, around)

			return
		}

		out.push(
			`<anim:par${attribute("smil:begin", this.waiting.has(sub) ? "indefinite" : undefined)} smil:fill="hold"${attribute(
				"presentation:master-element",
				this.referenced.get(this.masters.get(sub) ?? -1)
			)}>`
		)
		this.node(sub, out, around)
		out.push("</anim:par>")
	}
}

function merge(pieces: readonly EmitPiece[]): EmitPiece[] {
	const out: EmitPiece[] = []

	for (const piece of pieces) {
		const last = out[out.length - 1]

		if (typeof piece === "string" && typeof last === "string") out[out.length - 1] = last + piece
		else out.push(piece)
	}

	return out
}

// The page's timing root markup: its source span when nothing in it changed, no pieces when the page lost its timing.
// `pristine` is the timing as read from the fragment (readOdpTiming), so only nodes that differ are written again.
export function odpTimingMarkup(
	context: OdpTimingContext,
	tree: TimingTree | undefined,
	pristine: TimingTree | undefined
): readonly EmitPiece[] {
	if (tree === undefined) return []

	const out: EmitPiece[] = []
	const writer = new OdfTimingWriter(context, tree, pristine)

	writer.node(tree.root, out)

	const pieces = merge(out)
	const head = pieces[0]

	// The root written anew declares the prefixes its markup uses that the page does not bind as such (a file that
	// declares the animation namespace on its timing root only).
	if (typeof head === "string") {
		const declarations = writer.declarations(writer.rootSource(tree), pieces.filter(piece => typeof piece === "string").join(""))
		const end = head.indexOf(">")

		if (declarations !== "" && end > 0) {
			const close = head[end - 1] === "/" ? end - 1 : end

			pieces[0] = head.slice(0, close) + declarations + head.slice(close)
		}
	}

	return pieces
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length)

	out.set(a, 0)
	out.set(b, a.length)

	return out
}
