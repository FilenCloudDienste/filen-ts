import type { TimingBudgets } from "../anim/model"
import { children, i16, i32, u16, u32, utf16Text, type PptRecord, type RecordCounter } from "./records"
import type { PptSound } from "./transitions"
import { PresentationError } from "../presentation/model"
import { xmlText, type TextBlock } from "./text"

// A slide's animations as PresentationML p:timing (ECMA-376 Part 1 §19.5). PowerPoint 2002 and later keep the time
// tree in the slide's "___PPT10" programmable tag ([MS-PPT] §2.5.24, §2.8.15 ExtTimeNodeContainer and its build list
// §2.8.4): it is the tree p:timing was made from, so each node becomes its element with the same attributes, and the
// node ids are given in document order. Older files carry an Office 97 build per shape (§2.8.1 AnimationInfoAtom,
// ignored when the tree exists): those become the main sequence PowerPoint makes of them, one effect per shape or per
// paragraph of a built text, ordered by orderID, with the preset each effect names (the ECMA preset numbers;
// LibreOffice 7.5 reads the same files to the same presets) and the behaviours that play it. A tree over the
// presentation budgets is left out and reported.

export interface PptParagraphSpan {
	// Characters [start, end) of the shape's text, the paragraph mark left out.
	readonly start: number
	readonly end: number
	// Indent level, 0-based.
	readonly level: number
}

export interface PptAnimShape {
	readonly paragraphs: readonly PptParagraphSpan[]
}

// An Office 97 build on a shape: its AnimationInfoContainer (the record's data range). An inherited build is its master
// placeholder's, played on the slide's placeholder that has none of its own.
export interface PptLegacyBuild {
	readonly spid: number
	readonly start: number
	readonly end: number
	readonly inherited?: true
}

export interface PptAnimContext {
	readonly data: Uint8Array
	readonly counter: RecordCounter
	// The slide's shapes by spid (the converted shape keeps its spid as its id).
	readonly shapes: ReadonlyMap<number, PptAnimShape>
	// A sound of the deck's sound collection, as a relationship of the slide part.
	readonly sound: (soundIdRef: number) => PptSound | undefined
	// A sound embedded in an AnimationInfoContainer (§2.4.16.3 SoundContainer).
	readonly embeddedSound: (container: PptRecord) => PptSound | undefined
	// The slide's colour scheme (§2.4.17 order), for scheme colours of colour behaviours.
	readonly scheme: readonly number[]
	readonly budgets: Pick<TimingBudgets, "nodesPerSlide" | "depth">
}

export interface PptTiming {
	// The p:timing element, or "".
	readonly xml: string
	// The slide had animations the conversion left out or changed (over a budget, unreadable, or a number no
	// PresentationML attribute can hold).
	readonly lost: boolean
}

const RT = {
	cString: 0x0fba,
	progTags: 0x1388,
	progBinaryTag: 0x138a,
	binaryTagData: 0x138b,
	buildList: 0x2b02,
	buildAtom: 0x2b03,
	chartBuild: 0x2b04,
	chartBuildAtom: 0x2b05,
	diagramBuild: 0x2b06,
	diagramBuildAtom: 0x2b07,
	paraBuild: 0x2b08,
	paraBuildAtom: 0x2b09,
	levelInfo: 0x2b0a,
	visualShape: 0x2afb,
	visualPage: 0x2b01,
	animationInfoAtom: 0x0ff1,
	sound: 0x07e6,
	condition: 0xf125,
	timeNode: 0xf127,
	conditionAtom: 0xf128,
	modifier: 0xf129,
	behavior: 0xf12a,
	animate: 0xf12b,
	color: 0xf12c,
	effect: 0xf12d,
	motion: 0xf12e,
	rotation: 0xf12f,
	scale: 0xf130,
	set: 0xf131,
	command: 0xf132,
	behaviorAtom: 0xf133,
	animateAtom: 0xf134,
	colorAtom: 0xf135,
	effectAtom: 0xf136,
	motionAtom: 0xf137,
	rotationAtom: 0xf138,
	scaleAtom: 0xf139,
	setAtom: 0xf13a,
	commandAtom: 0xf13b,
	visualElement: 0xf13c,
	propertyList: 0xf13d,
	stringList: 0xf13e,
	valueList: 0xf13f,
	iterate: 0xf140,
	sequence: 0xf141,
	variant: 0xf142,
	animationValue: 0xf143,
	extTimeNode: 0xf144,
	subEffect: 0xf145
} as const

// §2.13.38 TimePropertyID4TimeNode.
const TPID = {
	display: 2,
	masterPos: 5,
	effectId: 9,
	effectDir: 10,
	effectType: 11,
	afterEffect: 13,
	slideCount: 15,
	timeFilter: 16,
	eventFilter: 17,
	hideWhenStopped: 18,
	groupId: 19,
	effectNodeType: 20,
	placeholderNode: 21,
	mediaVolume: 22,
	mediaMute: 23,
	zoomToFullScreen: 26
} as const

// §2.13.37 TimePropertyID4TimeBehavior.
const TBPID = {
	runtimeContext: 2,
	motionPathEditRelative: 3,
	colorModel: 4,
	colorDirection: 5,
	override: 6,
	pathEditRotationAngle: 7,
	pathEditRotationX: 8,
	pathEditRotationY: 9,
	pointsTypes: 10
} as const

const PRESET_CLASSES = ["", "entr", "exit", "emph", "path", "verb", "mediacall"]
const NODE_TYPES = [
	"",
	"clickEffect",
	"withEffect",
	"afterEffect",
	"mainSeq",
	"interactiveSeq",
	"clickPar",
	"withGroup",
	"afterGroup",
	"tmRoot"
]
// §2.8.76 triggerEvent.
const EVENTS = [
	"",
	"onBegin",
	"onEnd",
	"begin",
	"end",
	"onClick",
	"onDblClick",
	"onMouseOver",
	"onMouseOut",
	"onNext",
	"onPrev",
	"onStopAudio"
]
const PARA_BUILDS = ["allAtOnce", "p", "cust", "whole"]
const CHART_BUILDS = ["allAtOnce", "series", "category", "seriesEl", "categoryEl", "allAtOnce"]
const DIAGRAM_BUILDS = [
	"whole",
	"depthByNode",
	"depthByBranch",
	"breadthByNode",
	"breadthByLvl",
	"cw",
	"cwIn",
	"cwOut",
	"ccw",
	"ccwIn",
	"ccwOut",
	"inByRing",
	"outByRing",
	"up",
	"down",
	"allAtOnce",
	"cust"
]
// Float values at or beyond this are FLT_MAX: indefinite.
const FLOAT_INDEFINITE = 3.0e38
const FLOAT_MAX = 3.4028234663852886e38

class OverBudget extends Error {}

function f32(data: Uint8Array, at: number): number {
	if (at + 4 > data.length) return 0

	return new DataView(data.buffer, data.byteOffset + at, 4).getFloat32(0, true)
}

const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
const UINT32_MAX = 4294967295

// Numbers written that no attribute could hold (not finite, or past its range): each is clamped or left out, and the
// slide's timing is reported changed. Counted across the module, read as a difference around one slide's conversion.
let outOfRange = 0

// An integer attribute value in [min, max] (xsd:int by default), as plain digits: NaN becomes 0, the rest is clamped.
function int(value: number, min = INT32_MIN, max = INT32_MAX): string {
	const rounded = Math.round(value)

	if (Number.isNaN(rounded) || rounded < min || rounded > max) {
		outOfRange++

		return String(Number.isNaN(rounded) ? Math.max(min, Math.min(max, 0)) : rounded < min ? min : max)
	}

	return String(rounded)
}

// An optional attribute; a number that is not one (NaN) leaves it out.
function attr(name: string, value: string | number | undefined, min?: number, max?: number): string {
	if (value === undefined) return ""

	if (typeof value === "number" && Number.isNaN(value)) {
		outOfRange++

		return ""
	}

	return ` ${name}="${typeof value === "number" ? int(value, min, max) : xmlText(value)}"`
}

// An xsd:float as plain decimals (at most six places), finite: values past a float's range are clamped to it.
function float(value: number): string {
	if (!Number.isFinite(value) || Math.abs(value) > FLOAT_MAX) {
		outOfRange++

		return plain(Number.isNaN(value) ? 0 : value < 0 ? -FLOAT_MAX : FLOAT_MAX)
	}

	const rounded = Math.round(value * 1e6) / 1e6

	return Number.isFinite(rounded) ? plain(rounded) : plain(value)
}

// A finite number without an exponent (String gives one from 1e21 and below 1e-6).
function plain(value: number): string {
	const text = String(value)

	if (!text.includes("e")) return text

	return Math.abs(value) < 1 ? value.toFixed(6).replace(/\.?0+$/u, "") : BigInt(Math.round(value)).toString()
}

function hex(rgb: number): string {
	return (rgb & 0xffffff).toString(16).toUpperCase().padStart(6, "0")
}

// --- Time variants (§2.8.78–§2.8.82) ---

type Variant =
	| { readonly type: "bool"; readonly value: boolean }
	| { readonly type: "int" | "float"; readonly value: number }
	| { readonly type: "string"; readonly value: string }

function variant(data: Uint8Array, record: PptRecord): Variant | undefined {
	if (record.end - record.start < 1) return undefined

	switch (data[record.start]) {
		case 0:
			return { type: "bool", value: (data[record.start + 1] ?? 0) !== 0 }
		case 1:
			return { type: "int", value: i32(data, record.start + 1) }
		case 2: {
			const value = f32(data, record.start + 1)

			if (Number.isFinite(value)) return { type: "float", value }

			outOfRange++

			return undefined
		}
		case 3:
			return { type: "string", value: utf16Text(data, record.start + 1, record.end) }
		default:
			return undefined
	}
}

function numberOf(value: Variant | undefined): number | undefined {
	return value?.type === "int" || value?.type === "float" ? value.value : undefined
}

function stringOf(value: Variant | undefined): string | undefined {
	return value?.type === "string" ? value.value : undefined
}

function boolOf(value: Variant | undefined): boolean | undefined {
	if (value?.type === "bool") return value.value
	if (value?.type === "int") return value.value !== 0

	return undefined
}

function variantXml(value: Variant): string {
	switch (value.type) {
		case "bool":
			return `<p:boolVal val="${value.value ? "1" : "0"}"/>`
		case "int":
			return `<p:intVal val="${String(value.value)}"/>`
		case "float":
			return `<p:fltVal val="${float(value.value)}"/>`
		case "string":
			return `<p:strVal val="${xmlText(value.value)}"/>`
	}
}

function delayText(delay: number): string {
	return delay < 0 ? "indefinite" : String(delay)
}

// --- The PowerPoint 2002 tree ---

interface Kids {
	readonly list: readonly PptRecord[]
	first(type: number, instance?: number): PptRecord | undefined
	all(type: number, instance?: number): PptRecord[]
}

class TreeWriter {
	private id = 0
	private nodes = 0
	// The shapes the tree animates.
	readonly targets = new Set<number>()
	// Per shape, the first paragraph starting and the first ending at each character offset (textTarget).
	private readonly paragraphIndex = new Map<number, { readonly starts: Map<number, number>; readonly ends: Map<number, number> }>()

	private readonly context: PptAnimContext

	constructor(context: PptAnimContext) {
		this.context = context
	}

	private kids(record: PptRecord): Kids {
		const list = children(this.context.data, record.start, record.end, this.context.counter)

		return {
			list,
			first: (type, instance) => list.find(child => child.type === type && (instance === undefined || child.instance === instance)),
			all: (type, instance) => list.filter(child => child.type === type && (instance === undefined || child.instance === instance))
		}
	}

	private count(depth: number): number {
		if (++this.nodes > this.context.budgets.nodesPerSlide || depth > this.context.budgets.depth) throw new OverBudget()

		return ++this.id
	}

	private properties(list: PptRecord | undefined): Map<number, Variant> {
		const out = new Map<number, Variant>()

		if (list === undefined) return out

		for (const record of this.kids(list).list) {
			if (record.type !== RT.variant) continue

			const value = variant(this.context.data, record)

			if (value !== undefined && !out.has(record.instance)) out.set(record.instance, value)
		}

		return out
	}

	// §2.8.44: the target of a behaviour, a condition or a media node.
	target(container: PptRecord | undefined): string | undefined {
		if (container === undefined) return undefined

		const data = this.context.data
		const atom = this.kids(container).list[0]

		if (atom === undefined) return undefined
		if (atom.type === RT.visualPage) return "<p:sldTgt/>"
		if (atom.type !== RT.visualShape || atom.end - atom.start < 20) return undefined

		const type = u32(data, atom.start)
		const refType = u32(data, atom.start + 4)
		const id = u32(data, atom.start + 8)

		if (refType === 2) {
			const sound = this.context.sound(id)

			return sound === undefined ? undefined : `<p:sndTgt r:embed="${sound.rId}" name="${xmlText(sound.name)}"/>`
		}

		const spid = ` spid="${String(id)}"`

		this.targets.add(id)

		switch (type) {
			case 2:
				return this.textTarget(id, i32(data, atom.start + 12), i32(data, atom.start + 16))
			case 6:
				return `<p:spTgt${spid}><p:bg/></p:spTgt>`
			case 8: {
				const count = this.context.shapes.get(id)?.paragraphs.length ?? 0

				return count === 0
					? `<p:spTgt${spid}/>`
					: `<p:spTgt${spid}><p:txEl><p:pRg st="0" end="${String(count - 1)}"/></p:txEl></p:spTgt>`
			}
			default:
				return `<p:spTgt${spid}/>`
		}
	}

	// A character range of a shape's text: the paragraphs it covers when it covers them whole, else the characters.
	textTarget(spid: number, start: number, end: number): string {
		const index = this.paragraphsOf(spid)
		const first = index.starts.get(start) ?? -1
		// The paragraph ending there, its mark included or not.
		const at = index.ends.get(end)
		const before = index.ends.get(end - 1)
		const last = at === undefined ? (before ?? -1) : before === undefined ? at : Math.min(at, before)

		if (first >= 0 && last >= first) {
			return `<p:spTgt spid="${String(spid)}"><p:txEl><p:pRg st="${String(first)}" end="${String(last)}"/></p:txEl></p:spTgt>`
		}

		return `<p:spTgt spid="${String(spid)}"><p:txEl><p:charRg st="${String(Math.max(0, start))}" end="${String(Math.max(0, end))}"/></p:txEl></p:spTgt>`
	}

	private paragraphsOf(spid: number): { readonly starts: Map<number, number>; readonly ends: Map<number, number> } {
		let index = this.paragraphIndex.get(spid)

		if (index === undefined) {
			const starts = new Map<number, number>()
			const ends = new Map<number, number>()

			;(this.context.shapes.get(spid)?.paragraphs ?? []).forEach((span, at) => {
				if (!starts.has(span.start)) starts.set(span.start, at)
				if (!ends.has(span.end)) ends.set(span.end, at)
			})
			index = { starts, ends }
			this.paragraphIndex.set(spid, index)
		}

		return index
	}

	private condition(record: PptRecord, local: string): string {
		const data = this.context.data
		const kids = this.kids(record)
		const atom = kids.first(RT.conditionAtom)

		if (atom === undefined || atom.end - atom.start < 16) return ""

		const object = u32(data, atom.start)
		const event = EVENTS[u32(data, atom.start + 4)]
		const id = u32(data, atom.start + 8)
		const delay = i32(data, atom.start + 12)
		let inner = ""

		if (object === 1) inner = this.target(kids.first(RT.visualElement)) ?? ""
		else if (object === 2) inner = `<p:tn val="${String(id)}"/>`
		else if (object === 3) inner = '<p:rtn val="all"/>'

		const evt = event === undefined || event === "" ? "" : ` evt="${event}"`
		const body = object === 1 && inner !== "" ? `<p:tgtEl>${inner}</p:tgtEl>` : inner

		return `<p:${local}${evt} delay="${delayText(delay)}"${body === "" ? "/>" : `>${body}</p:${local}>`}`
	}

	private conditions(kids: Kids, instance: number, list: string, item: string): string {
		const items = kids
			.all(RT.condition, instance)
			.map(record => this.condition(record, item))
			.join("")

		return items === "" ? "" : `<p:${list}>${items}</p:${list}>`
	}

	// The p:cTn of a node: its atom, properties, modifiers and iteration, conditions and children.
	private commonNode(kids: Kids, depth: number, inner: string): string {
		const data = this.context.data
		const id = this.count(depth)
		const atom = kids.first(RT.timeNode)
		const properties = this.properties(kids.first(RT.propertyList))
		let attributes = attr("id", id)

		if (atom !== undefined && atom.end - atom.start >= 32) {
			const flags = u32(data, atom.start + 28)
			const restart = u32(data, atom.start + 4)
			const fill = u32(data, atom.start + 12)
			const duration = i32(data, atom.start + 24)

			if ((flags & 0x2) !== 0) attributes += attr("restart", restart === 1 ? "always" : restart === 2 ? "whenNotActive" : "never")
			if ((flags & 0x1) !== 0) attributes += attr("fill", fill === 1 || fill === 4 ? "remove" : fill === 2 ? "transition" : "hold")
			if ((flags & 0x10) !== 0) attributes += attr("dur", duration < 0 ? "indefinite" : String(duration))
		}

		const presetClass = PRESET_CLASSES[numberOf(properties.get(TPID.effectType)) ?? 0]
		const effectId = numberOf(properties.get(TPID.effectId))

		if (effectId !== undefined) attributes += attr("presetID", effectId)
		if (presetClass !== undefined && presetClass !== "") attributes += attr("presetClass", presetClass)
		if (effectId !== undefined) attributes += attr("presetSubtype", numberOf(properties.get(TPID.effectDir)) ?? 0)

		for (const modifier of kids.all(RT.modifier)) {
			if (modifier.end - modifier.start < 8) continue

			const value = f32(data, modifier.start + 4)

			switch (u32(data, modifier.start)) {
				case 0:
					attributes += value >= FLOAT_INDEFINITE ? ' repeatCount="indefinite"' : attr("repeatCount", value * 1000, 0, UINT32_MAX)
					break
				case 1:
					attributes += value >= FLOAT_INDEFINITE ? ' repeatDur="indefinite"' : attr("repeatDur", value, 0, UINT32_MAX)
					break
				case 2:
					attributes += attr("spd", value * 100000)
					break
				case 3:
					attributes += attr("accel", value * 100000, 0, 100000)
					break
				case 4:
					attributes += attr("decel", value * 100000, 0, 100000)
					break
				case 5:
					if (value !== 0) attributes += ' autoRev="1"'
					break
				default:
					break
			}
		}

		const timeFilter = stringOf(properties.get(TPID.timeFilter))
		const eventFilter = stringOf(properties.get(TPID.eventFilter))
		const masterPos = numberOf(properties.get(TPID.masterPos))
		const groupId = numberOf(properties.get(TPID.groupId))
		const nodeType = NODE_TYPES[numberOf(properties.get(TPID.effectNodeType)) ?? 0]

		if (timeFilter !== undefined) attributes += attr("tmFilter", timeFilter)
		if (eventFilter !== undefined) attributes += attr("evtFilter", eventFilter)
		if (numberOf(properties.get(TPID.display)) === 1) attributes += ' display="0"'
		// §2.8.21 masterRel in ST_TLTimeNodeMasterRelation's order (LibreOffice 7.5 plays 2 at the next click).
		if (masterPos !== undefined)
			attributes += attr("masterRel", masterPos === 2 ? "nextClick" : masterPos === 1 ? "lastClick" : "sameClick")
		if (groupId !== undefined) attributes += attr("grpId", groupId, 0, UINT32_MAX)
		if (boolOf(properties.get(TPID.afterEffect)) === true) attributes += ' afterEffect="1"'
		if (nodeType !== undefined && nodeType !== "") attributes += attr("nodeType", nodeType)
		if (boolOf(properties.get(TPID.placeholderNode)) === true) attributes += ' nodePh="1"'

		const iterate = kids.first(RT.iterate)
		let iterateXml = ""

		if (iterate !== undefined && iterate.end - iterate.start >= 20) {
			const flags = u32(data, iterate.start + 16)
			const interval = (flags & 0x4) !== 0 ? u32(data, iterate.start) : 0
			const type = (flags & 0x2) !== 0 ? u32(data, iterate.start + 4) : 0
			const forwards = (flags & 0x1) !== 0 ? u32(data, iterate.start + 8) !== 0 : true
			const percent = (flags & 0x8) !== 0 && u32(data, iterate.start + 12) === 1

			iterateXml = `<p:iterate${type === 1 ? ' type="wd"' : type === 2 ? ' type="lt"' : ""}${forwards ? "" : ' backwards="1"'}>${
				percent ? `<p:tmPct val="${int(interval * 100, 0)}"/>` : `<p:tmAbs val="${String(interval)}"/>`
			}</p:iterate>`
		}

		const endSync = kids.first(RT.condition, 5)
		const childNodes = kids
			.all(RT.extTimeNode)
			.map(child => this.node(child, depth + 1))
			.join("")
		const subNodes = kids
			.all(RT.subEffect)
			.map(child => this.subEffect(child, depth + 1))
			.join("")

		return (
			`<p:cTn${attributes}>` +
			this.conditions(kids, 1, "stCondLst", "cond") +
			this.conditions(kids, 2, "endCondLst", "cond") +
			(endSync === undefined ? "" : this.condition(endSync, "endSync")) +
			iterateXml +
			(childNodes === "" ? "" : `<p:childTnLst>${childNodes}</p:childTnLst>`) +
			(subNodes === "" ? "" : `<p:subTnLst>${subNodes}</p:subTnLst>`) +
			inner +
			"</p:cTn>"
		)
	}

	// §2.8.15: a container (par, seq), a behaviour or a media node.
	node(record: PptRecord, depth: number): string {
		const data = this.context.data
		const kids = this.kids(record)
		const atom = kids.first(RT.timeNode)
		const flags = atom !== undefined && atom.end - atom.start >= 32 ? u32(data, atom.start + 28) : 0
		const type = atom !== undefined && (flags & 0x8) !== 0 ? u32(data, atom.start + 8) : 0

		if (type === 3) return this.behaviorNode(kids, depth)
		if (type === 4) return this.mediaNode(kids, depth)

		if (type === 1) {
			const sequence = kids.first(RT.sequence)
			let attributes = ""

			if (sequence !== undefined && sequence.end - sequence.start >= 20) {
				const used = u32(data, sequence.start + 16)

				if ((used & 0x1) !== 0) attributes += ` concurrent="${u32(data, sequence.start) === 1 ? "1" : "0"}"`
				if ((used & 0x4) !== 0) attributes += ` prevAc="${u32(data, sequence.start + 8) === 1 ? "skipTimed" : "none"}"`
				if ((used & 0x2) !== 0) attributes += ` nextAc="${u32(data, sequence.start + 4) === 1 ? "seek" : "none"}"`
			}

			const common = this.commonNode(kids, depth, "")

			return `<p:seq${attributes}>${common}${this.conditions(kids, 4, "prevCondLst", "cond")}${this.conditions(kids, 3, "nextCondLst", "cond")}</p:seq>`
		}

		return `<p:par>${this.commonNode(kids, depth, "")}</p:par>`
	}

	// §2.8.16: a node played relative to its master (a p:subTnLst member).
	private subEffect(record: PptRecord, depth: number): string {
		const data = this.context.data
		const kids = this.kids(record)
		const atom = kids.first(RT.timeNode)
		const type = atom !== undefined && atom.end - atom.start >= 32 ? u32(data, atom.start + 8) : 3

		return type === 4 ? this.mediaNode(kids, depth) : this.behaviorNode(kids, depth)
	}

	private mediaNode(kids: Kids, depth: number): string {
		const target = this.target(kids.first(RT.visualElement))
		const properties = this.properties(kids.first(RT.propertyList))
		const common = this.commonNode(kids, depth, "")

		if (target === undefined) return ""

		const volume = numberOf(properties.get(TPID.mediaVolume))
		const mute = boolOf(properties.get(TPID.mediaMute))
		const slides = numberOf(properties.get(TPID.slideCount))
		const media =
			(volume === undefined ? "" : attr("vol", volume, 0, 100000)) +
			(mute === undefined ? "" : ` mute="${mute ? "1" : "0"}"`) +
			(slides === undefined ? "" : attr("numSld", slides, 0, UINT32_MAX)) +
			(boolOf(properties.get(TPID.hideWhenStopped)) === true ? ' showWhenStopped="0"' : "")
		const node = `<p:cMediaNode${media}>${common}<p:tgtEl>${target}</p:tgtEl></p:cMediaNode>`

		if (target.startsWith("<p:sndTgt") || !this.isVideo(kids)) return `<p:audio>${node}</p:audio>`

		return `<p:video${boolOf(properties.get(TPID.zoomToFullScreen)) === true ? ' fullScrn="1"' : ""}>${node}</p:video>`
	}

	private isVideo(kids: Kids): boolean {
		const container = kids.first(RT.visualElement)
		const atom = container === undefined ? undefined : this.kids(container).first(RT.visualShape)

		return atom !== undefined && atom.end - atom.start >= 4 && u32(this.context.data, atom.start) === 4
	}

	// §2.8.34 TimeBehaviorContainer as p:cBhvr, with the node's p:cTn inside.
	private behavior(record: PptRecord | undefined, common: string, defaults?: readonly string[]): string {
		if (record === undefined) return `<p:cBhvr>${common}</p:cBhvr>`

		const data = this.context.data
		const kids = this.kids(record)
		const atom = kids.first(RT.behaviorAtom)
		const flags = atom !== undefined && atom.end - atom.start >= 16 ? u32(data, atom.start) : 0
		const properties = this.properties(kids.first(RT.propertyList))
		const list = kids.first(RT.stringList)
		const names =
			list !== undefined && (flags & 0x4) !== 0
				? this.kids(list)
						.list.filter(child => child.type === RT.variant)
						.map(child => stringOf(variant(data, child)))
						.filter((name): name is string => name !== undefined && name !== "")
				: []
		const attributeNames = names.length > 0 ? names : (defaults ?? [])
		const additive = (flags & 0x1) !== 0 && atom !== undefined ? (u32(data, atom.start + 4) === 1 ? "sum" : "repl") : undefined
		const context = stringOf(properties.get(TBPID.runtimeContext))
		const target = this.target(kids.first(RT.visualElement))

		return (
			`<p:cBhvr${attr("additive", additive)}${attr("rctx", context)}${properties.has(TBPID.override) ? ' override="childStyle"' : ""}>` +
			common +
			(target === undefined ? "" : `<p:tgtEl>${target}</p:tgtEl>`) +
			(attributeNames.length === 0
				? ""
				: `<p:attrNameLst>${attributeNames.map(name => `<p:attrName>${xmlText(name)}</p:attrName>`).join("")}</p:attrNameLst>`) +
			"</p:cBhvr>"
		)
	}

	private behaviorProperties(record: PptRecord | undefined): Map<number, Variant> {
		if (record === undefined) return new Map()

		return this.properties(this.kids(record).first(RT.propertyList))
	}

	private behaviorNode(kids: Kids, depth: number): string {
		const common = this.commonNode(kids, depth, "")
		const data = this.context.data
		const animate = kids.first(RT.animate)
		const color = kids.first(RT.color)
		const effect = kids.first(RT.effect)
		const motion = kids.first(RT.motion)
		const rotation = kids.first(RT.rotation)
		const scale = kids.first(RT.scale)
		const set = kids.first(RT.set)
		const command = kids.first(RT.command)

		if (animate !== undefined) {
			const inner = this.kids(animate)
			const atom = inner.first(RT.animateAtom)
			const calc = atom !== undefined && atom.end - atom.start >= 12 ? u32(data, atom.start) : 1
			const flags = atom !== undefined && atom.end - atom.start >= 12 ? u32(data, atom.start + 4) : 0
			const valueType = atom !== undefined && atom.end - atom.start >= 12 ? u32(data, atom.start + 8) : 1
			const by = (flags & 0x1) !== 0 ? stringOf(this.variantOf(inner.first(RT.variant, 1))) : undefined
			const from = (flags & 0x2) !== 0 ? stringOf(this.variantOf(inner.first(RT.variant, 2))) : undefined
			const to = (flags & 0x4) !== 0 ? stringOf(this.variantOf(inner.first(RT.variant, 3))) : undefined
			const list = (flags & 0x10) !== 0 ? inner.first(RT.valueList) : undefined

			return (
				`<p:anim${attr("by", by)}${attr("from", from)}${attr("to", to)}` +
				`${(flags & 0x8) !== 0 ? attr("calcmode", calc === 0 ? "discrete" : calc === 2 ? "fmla" : "lin") : ""}` +
				`${(flags & 0x20) !== 0 ? attr("valueType", valueType === 0 ? "str" : valueType === 2 ? "clr" : "num") : ""}>` +
				this.behavior(inner.first(RT.behavior), common) +
				(list === undefined ? "" : this.valueList(list)) +
				"</p:anim>"
			)
		}

		if (color !== undefined) {
			const inner = this.kids(color)
			const atom = inner.first(RT.colorAtom)
			const behavior = inner.first(RT.behavior)
			const properties = this.behaviorProperties(behavior)
			const model = numberOf(properties.get(TBPID.colorModel))
			const direction = numberOf(properties.get(TBPID.colorDirection))
			let parts = ""

			if (atom !== undefined && atom.end - atom.start >= 52) {
				const flags = u32(data, atom.start)

				if ((flags & 0x1) !== 0) parts += this.colorBy(atom.start + 4)
				if ((flags & 0x2) !== 0) parts += this.colorValue("from", atom.start + 20)
				if ((flags & 0x4) !== 0) parts += this.colorValue("to", atom.start + 36)
			}

			return `<p:animClr clrSpc="${model === 1 ? "hsl" : "rgb"}"${direction === undefined ? "" : ` dir="${direction === 1 ? "ccw" : "cw"}"`}>${this.behavior(behavior, common)}${parts}</p:animClr>`
		}

		if (effect !== undefined) {
			const inner = this.kids(effect)
			const atom = inner.first(RT.effectAtom)
			const flags = atom !== undefined && atom.end - atom.start >= 8 ? u32(data, atom.start) : 0
			const transition = (flags & 0x1) !== 0 && atom !== undefined ? (u32(data, atom.start + 4) === 1 ? "out" : "in") : undefined
			const filter = (flags & 0x2) !== 0 ? stringOf(this.variantOf(inner.first(RT.variant, 1))) : undefined
			const progress = (flags & 0x4) !== 0 ? this.variantOf(inner.first(RT.variant, 2)) : undefined

			return (
				`<p:animEffect${attr("transition", transition)}${attr("filter", filter)}>` +
				this.behavior(inner.first(RT.behavior), common) +
				(progress === undefined ? "" : `<p:progress>${variantXml(progress)}</p:progress>`) +
				"</p:animEffect>"
			)
		}

		if (motion !== undefined) {
			const inner = this.kids(motion)
			const atom = inner.first(RT.motionAtom)
			const behavior = inner.first(RT.behavior)
			const properties = this.behaviorProperties(behavior)
			const flags = atom !== undefined && atom.end - atom.start >= 32 ? u32(data, atom.start) : 0
			const at = atom?.start ?? 0
			const point = (local: string, x: number, y: number): string =>
				`<p:${local} x="${int(f32(data, x) * 100000)}" y="${int(f32(data, y) * 100000)}"/>`
			const path = (flags & 0x10) !== 0 ? stringOf(this.variantOf(inner.first(RT.variant, 1))) : undefined
			const relative = boolOf(properties.get(TBPID.motionPathEditRelative))
			const angle = numberOf(properties.get(TBPID.pathEditRotationAngle))
			const centerX = numberOf(properties.get(TBPID.pathEditRotationX))
			const centerY = numberOf(properties.get(TBPID.pathEditRotationY))
			const points = stringOf(properties.get(TBPID.pointsTypes))
			const origin = (flags & 0x8) !== 0 ? (u32(data, at + 28) === 2 ? "layout" : "parent") : undefined

			return (
				`<p:animMotion${attr("origin", origin)}${attr("path", path)}${relative === undefined ? "" : ` pathEditMode="${relative ? "relative" : "fixed"}"`}` +
				`${angle === undefined ? "" : attr("rAng", angle * 60000)}${attr("ptsTypes", points)}>` +
				this.behavior(behavior, common, ["ppt_x", "ppt_y"]) +
				((flags & 0x1) !== 0 && (flags & 0x4) === 0 ? point("by", at + 4, at + 8) : "") +
				((flags & 0x2) !== 0 ? point("from", at + 12, at + 16) : "") +
				((flags & 0x4) !== 0 ? point("to", at + 20, at + 24) : "") +
				(centerX === undefined && centerY === undefined
					? ""
					: `<p:rCtr x="${int((centerX ?? 0) * 100000)}" y="${int((centerY ?? 0) * 100000)}"/>`) +
				"</p:animMotion>"
			)
		}

		if (rotation !== undefined) {
			const inner = this.kids(rotation)
			const atom = inner.first(RT.rotationAtom)
			let attributes = ""

			if (atom !== undefined && atom.end - atom.start >= 20) {
				const flags = u32(data, atom.start)
				const sign = (flags & 0x8) !== 0 && u32(data, atom.start + 16) === 1 ? -1 : 1

				if ((flags & 0x1) !== 0 && (flags & 0x4) === 0) attributes += attr("by", sign * f32(data, atom.start + 4) * 60000)
				if ((flags & 0x2) !== 0) attributes += attr("from", f32(data, atom.start + 8) * 60000)
				if ((flags & 0x4) !== 0) attributes += attr("to", f32(data, atom.start + 12) * 60000)
			}

			return `<p:animRot${attributes}>${this.behavior(inner.first(RT.behavior), common, ["r"])}</p:animRot>`
		}

		if (scale !== undefined) {
			const inner = this.kids(scale)
			const atom = inner.first(RT.scaleAtom)
			let attributes = ""
			let parts = ""

			if (atom !== undefined && atom.end - atom.start >= 32) {
				const at = atom.start
				const flags = u32(data, at)
				const point = (local: string, x: number, y: number): string =>
					`<p:${local} x="${int(f32(data, x) * 1000)}" y="${int(f32(data, y) * 1000)}"/>`

				if ((flags & 0x8) !== 0) attributes += ` zoomContents="${(data[at + 28] ?? 1) !== 0 ? "1" : "0"}"`
				if ((flags & 0x1) !== 0 && (flags & 0x4) === 0) parts += point("by", at + 4, at + 8)
				if ((flags & 0x2) !== 0) parts += point("from", at + 12, at + 16)
				if ((flags & 0x4) !== 0) parts += point("to", at + 20, at + 24)
			}

			return `<p:animScale${attributes}>${this.behavior(inner.first(RT.behavior), common)}${parts}</p:animScale>`
		}

		if (set !== undefined) {
			const inner = this.kids(set)
			const atom = inner.first(RT.setAtom)
			const flags = atom !== undefined && atom.end - atom.start >= 8 ? u32(data, atom.start) : 0
			const to = (flags & 0x1) !== 0 ? this.variantOf(inner.first(RT.variant, 1)) : undefined

			return `<p:set>${this.behavior(inner.first(RT.behavior), common)}${to === undefined ? "" : `<p:to>${variantXml(to)}</p:to>`}</p:set>`
		}

		if (command !== undefined) {
			const inner = this.kids(command)
			const atom = inner.first(RT.commandAtom)
			const flags = atom !== undefined && atom.end - atom.start >= 8 ? u32(data, atom.start) : 0
			const type = (flags & 0x1) !== 0 && atom !== undefined ? u32(data, atom.start + 4) : 1
			const text = (flags & 0x2) !== 0 ? (stringOf(this.variantOf(inner.first(RT.variant, 1))) ?? "") : ""

			return `<p:cmd type="${type === 0 ? "evt" : type === 2 ? "verb" : "call"}" cmd="${xmlText(text)}">${this.behavior(inner.first(RT.behavior), common)}</p:cmd>`
		}

		// A behaviour node without a behaviour (a file that broke §2.8.15): kept as an empty group so its timing holds.
		return `<p:par>${common}</p:par>`
	}

	private variantOf(record: PptRecord | undefined): Variant | undefined {
		return record === undefined ? undefined : variant(this.context.data, record)
	}

	// §2.8.31: key points; a time of -1000 spreads them evenly over the duration.
	private valueList(record: PptRecord): string {
		const data = this.context.data
		const entries: { time: number; value?: Variant | undefined; formula?: string }[] = []

		for (const child of this.kids(record).list) {
			if (child.type === RT.animationValue && child.end - child.start >= 4) entries.push({ time: i32(data, child.start) })
			else if (child.type === RT.variant) {
				const entry = entries[entries.length - 1]

				if (entry === undefined) continue
				if (child.instance === 1) entry.formula = stringOf(variant(data, child)) ?? ""
				else entry.value = variant(data, child)
			}
		}

		if (entries.length === 0) return ""

		const even = entries.some(entry => entry.time === -1000)
		const items = entries.map((entry, index) => {
			const tm = even
				? entries.length === 1
					? 0
					: Math.round((index * 100000) / (entries.length - 1))
				: Math.max(0, entry.time) * 100

			return `<p:tav tm="${int(tm, 0, 100000)}"${attr("fmla", entry.formula === "" ? undefined : entry.formula)}>${entry.value === undefined ? "" : `<p:val>${variantXml(entry.value)}</p:val>`}</p:tav>`
		})

		return `<p:tavLst>${items.join("")}</p:tavLst>`
	}

	// §2.8.55–§2.8.57.
	private colorBy(at: number): string {
		const data = this.context.data
		const model = u32(data, at)
		const a = i32(data, at + 4)
		const b = i32(data, at + 8)
		const c = i32(data, at + 12)
		const percent = (value: number): string => int((value * 100000) / 255)

		if (model === 1) return `<p:by><p:hsl h="${int(((a * 360) / 255) * 60000)}" s="${percent(b)}" l="${percent(c)}"/></p:by>`
		if (model === 0) return `<p:by><p:rgb r="${percent(a)}" g="${percent(b)}" b="${percent(c)}"/></p:by>`

		return ""
	}

	// §2.8.58–§2.8.60: an RGB colour, or a scheme colour as the slide's scheme gives it.
	private colorValue(local: string, at: number): string {
		const data = this.context.data
		const model = u32(data, at)
		let rgb: number | undefined

		if (model === 0) rgb = ((u32(data, at + 4) & 0xff) << 16) | ((u32(data, at + 8) & 0xff) << 8) | (u32(data, at + 12) & 0xff)
		else if (model === 2) rgb = this.context.scheme[u32(data, at + 4)]

		return rgb === undefined ? "" : `<p:${local}><a:srgbClr val="${hex(rgb)}"/></p:${local}>`
	}

	// §2.8.4: the slide's build list.
	builds(record: PptRecord): string {
		const data = this.context.data
		const out: string[] = []

		for (const build of this.kids(record).list) {
			const kids = this.kids(build)
			const atom = kids.first(RT.buildAtom)

			if (atom === undefined || atom.end - atom.start < 16) continue

			const groupId = u32(data, atom.start + 4)
			const spid = u32(data, atom.start + 8)

			if (!this.context.shapes.has(spid)) continue

			const head = ` spid="${String(spid)}" grpId="${String(groupId)}"`

			if (build.type === RT.paraBuild) {
				const para = kids.first(RT.paraBuildAtom)

				if (para === undefined || para.end - para.start < 16) continue

				const type = u32(data, para.start)
				const level = u32(data, para.start + 4)
				const automatic = (data[para.start + 11] ?? 0) !== 0
				const templates: string[] = []
				let pending: number | undefined

				for (const child of kids.list) {
					if (child.type === RT.levelInfo && child.end - child.start >= 4) pending = u32(data, child.start)
					else if (child.type === RT.extTimeNode && pending !== undefined) {
						templates.push(`<p:tmpl lvl="${String(Math.min(9, pending))}"><p:tnLst>${this.node(child, 1)}</p:tnLst></p:tmpl>`)
						pending = undefined
					}
				}

				out.push(
					`<p:bldP${head}${(data[atom.start + 13] ?? 0) !== 0 ? ' uiExpand="1"' : ""}` +
						`${type === 3 ? "" : ` build="${PARA_BUILDS[type] ?? "whole"}"`}${type === 1 ? attr("bldLvl", Math.min(9, level)) : ""}` +
						`${(data[para.start + 8] ?? 0) !== 0 ? ' animBg="1"' : ""}${(data[para.start + 9] ?? 0) !== 0 ? ' rev="1"' : ""}` +
						`${(data[para.start + 10] ?? 0) !== 0 ? ' autoUpdateAnimBg="0"' : ""}${automatic ? attr("advAuto", u32(data, para.start + 12), 0, UINT32_MAX) : ""}` +
						(templates.length === 0 ? "/>" : `><p:tmplLst>${templates.join("")}</p:tmplLst></p:bldP>`)
				)
			} else if (build.type === RT.chartBuild) {
				const chart = kids.first(RT.chartBuildAtom)
				const type = chart === undefined ? 0 : u32(data, chart.start)
				const background = chart !== undefined && type !== 0 && (data[chart.start + 4] ?? 0) !== 0

				out.push(`<p:bldOleChart${head} bld="${CHART_BUILDS[type] ?? "allAtOnce"}"${background ? "" : ' animBg="0"'}/>`)
			} else if (build.type === RT.diagramBuild) {
				const diagram = kids.first(RT.diagramBuildAtom)
				const type = diagram === undefined ? 0 : u32(data, diagram.start)

				out.push(`<p:bldDgm${head} bld="${DIAGRAM_BUILDS[type] ?? "whole"}"/>`)
			}
		}

		return out.length === 0 ? "" : `<p:bldLst>${out.join("")}</p:bldLst>`
	}
}

// The "___PPT10" tag's records (§2.5.21–§2.5.24) of a slide, or undefined.
export function pp10Records(data: Uint8Array, slide: PptRecord, counter: RecordCounter): readonly PptRecord[] | undefined {
	for (const tags of children(data, slide.start, slide.end, counter)) {
		if (tags.type !== RT.progTags) continue

		for (const tag of children(data, tags.start, tags.end, counter)) {
			if (tag.type !== RT.progBinaryTag) continue

			const parts = children(data, tag.start, tag.end, counter)
			const name = parts.find(part => part.type === RT.cString)
			const blob = parts.find(part => part.type === RT.binaryTagData)

			if (name === undefined || blob === undefined || utf16Text(data, name.start, name.end) !== "___PPT10") continue

			return children(data, blob.start, blob.end, counter)
		}
	}

	return undefined
}

// --- Office 97 builds ---

interface LegacyEffect {
	readonly presetID: number
	readonly presetSubtype: number
	readonly durationMs: number
	// The behaviours, with the target and the id allocator.
	readonly behaviors: (target: string, next: () => number) => string
}

const FLY_SUBTYPES = [8, 1, 2, 4, 9, 3, 12, 6]
const CROSS = [8, 4, 2, 1]
const WIPE_FILTERS: Readonly<Record<number, string>> = { 1: "wipe(down)", 2: "wipe(left)", 4: "wipe(up)", 8: "wipe(right)" }
const PEEK_FILTERS: Readonly<Record<number, string>> = {
	1: "slide(fromTop)",
	2: "slide(fromRight)",
	4: "slide(fromBottom)",
	8: "slide(fromLeft)"
}
const STRIPS: Readonly<Record<number, readonly [number, string]>> = {
	4: [9, "strips(upLeft)"],
	5: [3, "strips(upRight)"],
	6: [12, "strips(downLeft)"],
	7: [6, "strips(downRight)"]
}
const SPLITS = [
	[42, "barn(outHorizontal)"],
	[26, "barn(inHorizontal)"],
	[37, "barn(outVertical)"],
	[21, "barn(inVertical)"]
] as const

function visible(target: string, id: number, delay = 0, duration = 1, fill = true): string {
	return `<p:set><p:cBhvr><p:cTn id="${String(id)}" dur="${String(duration)}"${fill ? ' fill="hold"' : ""}><p:stCondLst><p:cond delay="${String(delay)}"/></p:stCondLst></p:cTn><p:tgtEl>${target}</p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`
}

function filtered(filter: string, duration: number): LegacyEffect["behaviors"] {
	return (target, next) =>
		visible(target, next()) +
		`<p:animEffect transition="in" filter="${filter}"><p:cBhvr><p:cTn id="${String(next())}" dur="${String(duration)}"/><p:tgtEl>${target}</p:tgtEl></p:cBhvr></p:animEffect>`
}

// Property animations (ppt_x, ppt_y, ppt_w, ppt_h) from a value to the shape's own, after the shape is shown.
function moved(duration: number, from: Readonly<Record<string, string>>): LegacyEffect["behaviors"] {
	const own: Readonly<Record<string, string>> = { ppt_x: "#ppt_x", ppt_y: "#ppt_y", ppt_w: "#ppt_w", ppt_h: "#ppt_h" }

	return (target, next) =>
		visible(target, next()) +
		Object.entries(from)
			.map(
				([name, value]) =>
					`<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="${String(next())}" dur="${String(duration)}" fill="hold"/><p:tgtEl>${target}</p:tgtEl><p:attrNameLst><p:attrName>${name}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="${value}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="${own[name] ?? ""}"/></p:val></p:tav></p:tavLst></p:anim>`
			)
			.join("")
}

function flyFrom(subtype: number): Readonly<Record<string, string>> {
	const from: Record<string, string> = {}

	if ((subtype & 8) !== 0) from["ppt_x"] = "0-#ppt_w/2"
	if ((subtype & 2) !== 0) from["ppt_x"] = "1+#ppt_w/2"
	if ((subtype & 1) !== 0) from["ppt_y"] = "0-#ppt_h/2"
	if ((subtype & 4) !== 0) from["ppt_y"] = "1+#ppt_h/2"

	return from
}

const APPEAR: LegacyEffect = { presetID: 1, presetSubtype: 0, durationMs: 1, behaviors: (target, next) => visible(target, next()) }

// §2.8.2 animEffect and animEffectDirection → the ECMA entrance preset and its behaviours.
function legacyEffect(effect: number, direction: number): LegacyEffect {
	const shaped = (presetID: number, presetSubtype: number, filter: string): LegacyEffect => ({
		presetID,
		presetSubtype,
		durationMs: 500,
		behaviors: filtered(filter, 500)
	})

	switch (effect) {
		case 1:
			return shaped(24, 0, "fade")
		case 2:
			return direction === 1 ? shaped(3, 10, "blinds(horizontal)") : shaped(3, 5, "blinds(vertical)")
		case 3:
			return direction === 1 ? shaped(5, 5, "checkerboard(down)") : shaped(5, 10, "checkerboard(across)")
		case 4: {
			// Cover: the shape comes in from the side it moves away from.
			const subtype = [2, 4, 8, 1, 6, 12, 3, 9][direction] ?? 2

			return PEEK_FILTERS[subtype] !== undefined
				? shaped(12, subtype, PEEK_FILTERS[subtype])
				: { presetID: 2, presetSubtype: subtype, durationMs: 500, behaviors: moved(500, flyFrom(subtype)) }
		}
		case 5:
			return shaped(9, 0, "dissolve")
		case 6:
			return shaped(10, 0, "fade")
		case 7: {
			const subtype = [2, 4, 8, 1][direction] ?? 2

			return shaped(22, subtype, WIPE_FILTERS[subtype] ?? "wipe(left)")
		}
		case 8:
			return direction === 1 ? shaped(14, 5, "randombar(vertical)") : shaped(14, 10, "randombar(horizontal)")
		case 9: {
			const [subtype, filter] = STRIPS[direction] ?? [9, "strips(upLeft)"]

			return shaped(18, subtype, filter)
		}
		case 10: {
			const subtype = [2, 4, 8, 1][direction] ?? 2

			return shaped(22, subtype, WIPE_FILTERS[subtype] ?? "wipe(left)")
		}
		case 11:
			return direction === 1 ? shaped(4, 16, "box(in)") : shaped(4, 32, "box(out)")
		case 12:
			return flyEffect(direction)
		case 13: {
			const [subtype, filter] = SPLITS[direction] ?? SPLITS[0]

			return shaped(16, subtype, filter)
		}
		case 14: {
			const duration = [500, 1000, 2000][direction] ?? 1000

			return {
				presetID: 11,
				presetSubtype: 0,
				durationMs: duration,
				behaviors: (target, next) => visible(target, next(), 0, duration, false)
			}
		}
		case 17:
			return shaped(8, 32, "diamond(out)")
		case 18:
			return shaped(13, 32, "plus(out)")
		case 19:
			return shaped(20, 0, "wedge")
		case 26:
			return shaped(
				21,
				[1, 2, 3, 4, 8].includes(direction) ? direction : 1,
				`wheel(${String([1, 2, 3, 4, 8].includes(direction) ? direction : 1)})`
			)
		case 27:
			return shaped(6, 32, "circle(out)")
		default:
			return APPEAR
	}
}

function flyEffect(direction: number): LegacyEffect {
	if (direction <= 7) {
		const subtype = FLY_SUBTYPES[direction] ?? 8

		return { presetID: 2, presetSubtype: subtype, durationMs: 500, behaviors: moved(500, flyFrom(subtype)) }
	}

	if (direction <= 11) {
		const subtype = CROSS[direction - 8] ?? 8

		return {
			presetID: 12,
			presetSubtype: subtype,
			durationMs: 500,
			behaviors: filtered(PEEK_FILTERS[subtype] ?? "slide(fromLeft)", 500)
		}
	}

	if (direction <= 15) {
		const subtype = [8, 1, 2, 4][direction - 12] ?? 8

		return { presetID: 7, presetSubtype: subtype, durationMs: 5000, behaviors: moved(5000, flyFrom(subtype)) }
	}

	switch (direction) {
		case 0x10:
			return { presetID: 23, presetSubtype: 16, durationMs: 500, behaviors: moved(500, { ppt_w: "0", ppt_h: "0" }) }
		case 0x11:
			return { presetID: 23, presetSubtype: 272, durationMs: 500, behaviors: moved(500, { ppt_w: "#ppt_w/2", ppt_h: "#ppt_h/2" }) }
		case 0x12:
			return { presetID: 23, presetSubtype: 32, durationMs: 500, behaviors: moved(500, { ppt_w: "4*#ppt_w", ppt_h: "4*#ppt_h" }) }
		case 0x13:
			return {
				presetID: 23,
				presetSubtype: 288,
				durationMs: 500,
				behaviors: moved(500, { ppt_w: "1.5*#ppt_w", ppt_h: "1.5*#ppt_h" })
			}
		case 0x14:
			return {
				presetID: 23,
				presetSubtype: 528,
				durationMs: 500,
				behaviors: moved(500, { ppt_w: "0", ppt_h: "0", ppt_x: "0.5", ppt_y: "0.5" })
			}
		case 0x15:
			return {
				presetID: 23,
				presetSubtype: 36,
				durationMs: 500,
				behaviors: moved(500, { ppt_w: "4*#ppt_w", ppt_h: "4*#ppt_h", ppt_x: "0.5", ppt_y: "1+#ppt_h/2" })
			}
		case 0x16:
			return { presetID: 17, presetSubtype: 10, durationMs: 500, behaviors: moved(500, { ppt_w: "0" }) }
		case 0x17:
			return { presetID: 17, presetSubtype: 8, durationMs: 500, behaviors: moved(500, { ppt_x: "#ppt_x-#ppt_w/2", ppt_w: "0" }) }
		case 0x18:
			return { presetID: 17, presetSubtype: 1, durationMs: 500, behaviors: moved(500, { ppt_y: "#ppt_y-#ppt_h/2", ppt_h: "0" }) }
		case 0x19:
			return { presetID: 17, presetSubtype: 2, durationMs: 500, behaviors: moved(500, { ppt_x: "#ppt_x+#ppt_w/2", ppt_w: "0" }) }
		case 0x1a:
			return { presetID: 17, presetSubtype: 4, durationMs: 500, behaviors: moved(500, { ppt_y: "#ppt_y+#ppt_h/2", ppt_h: "0" }) }
		case 0x1b:
			return { presetID: 19, presetSubtype: 10, durationMs: 500, behaviors: moved(500, { ppt_w: "0" }) }
		case 0x1c:
			return {
				presetID: 15,
				presetSubtype: 0,
				durationMs: 1000,
				behaviors: moved(1000, { ppt_w: "0", ppt_h: "0", ppt_x: "1+#ppt_w/2", ppt_y: "1+#ppt_h/2" })
			}
		default:
			return flyEffect(0)
	}
}

interface LegacyAtom {
	readonly spid: number
	readonly order: number
	readonly automatic: boolean
	readonly reverse: boolean
	readonly sound: boolean
	readonly stopSound: boolean
	readonly animateBackground: boolean
	readonly soundIdRef: number
	readonly delay: number
	readonly build: number
	readonly effect: number
	readonly direction: number
	readonly after: number
	readonly textBuild: number
	readonly dimColor: number | undefined
	readonly soundContainer: PptRecord | undefined
	readonly index: number
}

// One effect of the main sequence: a shape whole, or one paragraph of it.
interface LegacyStep {
	readonly atom: LegacyAtom
	readonly trigger: "click" | "with" | "after"
	readonly paragraph: number | undefined
}

function readLegacyAtom(context: PptAnimContext, build: PptLegacyBuild, index: number): LegacyAtom | undefined {
	const data = context.data
	const kids = children(data, build.start, build.end, context.counter)
	const atom = kids.find(record => record.type === RT.animationInfoAtom)

	if (atom === undefined || atom.end - atom.start < 28) return undefined

	const at = atom.start
	const flags = u16(data, at + 4)
	const two = (shift: number): boolean => ((flags >> shift) & 0x3) === 1
	const dim =
		data[at + 3] === 0xfe
			? ((data[at] ?? 0) << 16) | ((data[at + 1] ?? 0) << 8) | (data[at + 2] ?? 0)
			: context.scheme[data[at + 3] ?? 0xff]

	return {
		spid: build.spid,
		order: i16(data, at + 16),
		reverse: two(0),
		automatic: two(2),
		sound: two(4),
		stopSound: two(6),
		animateBackground: two(14),
		soundIdRef: u32(data, at + 8),
		delay: Math.max(0, i32(data, at + 12)),
		build: data[at + 20] ?? 0,
		effect: data[at + 21] ?? 0,
		direction: data[at + 22] ?? 0,
		after: data[at + 23] ?? 0,
		textBuild: data[at + 24] ?? 0,
		dimColor: dim,
		soundContainer: kids.find(record => record.type === RT.sound),
		index
	}
}

// The deepest level, 1-based, built paragraph by paragraph (AnimBuildTypeEnum BT_Level1Build…BT_Level5Build); 0 when
// the shape builds whole.
function buildLevel(build: number): number {
	if (build >= 2 && build <= 6) return build - 1
	if (build === 0xfe) return 1

	return 0
}

class LegacyWriter {
	private id = 2
	private readonly context: PptAnimContext

	constructor(context: PptAnimContext) {
		this.context = context
	}

	private next = (): number => {
		if (this.id >= this.context.budgets.nodesPerSlide) throw new OverBudget()

		return ++this.id
	}

	private steps(atoms: readonly LegacyAtom[]): LegacyStep[] {
		const out: LegacyStep[] = []

		for (const atom of atoms) {
			const level = buildLevel(atom.build)
			const paragraphs = (this.context.shapes.get(atom.spid)?.paragraphs ?? []).map((span, index) => ({ span, index }))
			const built = level > 0 ? paragraphs.filter(entry => entry.span.end > entry.span.start) : []
			const first: "click" | "after" = atom.automatic ? "after" : "click"

			if (built.length === 0) {
				out.push({ atom, trigger: first, paragraph: undefined })

				continue
			}

			const ordered = atom.reverse ? [...built].reverse() : built

			ordered.forEach((entry, at) => {
				// A paragraph deeper than the build level plays with the one it belongs to.
				const own = at === 0 || entry.span.level < level

				out.push({ atom, trigger: own ? first : "with", paragraph: entry.index })
			})
		}

		return out
	}

	private target(step: LegacyStep): string {
		const spid = ` spid="${String(step.atom.spid)}"`

		return step.paragraph === undefined
			? `<p:spTgt${spid}/>`
			: `<p:spTgt${spid}><p:txEl><p:pRg st="${String(step.paragraph)}" end="${String(step.paragraph)}"/></p:txEl></p:spTgt>`
	}

	// After the effect: dim to a colour, or hide (§2.13.1).
	private afterEffect(step: LegacyStep, target: string, duration: number): string {
		const atom = step.atom
		const set = (attribute: string, to: string, rel: string, delay: number): string =>
			`<p:set><p:cBhvr override="childStyle"><p:cTn id="${String(this.next())}" dur="1" fill="hold" display="0" masterRel="${rel}" afterEffect="1"><p:stCondLst><p:cond delay="${String(delay)}"/></p:stCondLst></p:cTn><p:tgtEl>${target}</p:tgtEl><p:attrNameLst><p:attrName>${attribute}</p:attrName></p:attrNameLst></p:cBhvr><p:to>${to}</p:to></p:set>`

		switch (atom.after) {
			case 1:
				return atom.dimColor === undefined
					? ""
					: set("style.color", `<p:clrVal><a:srgbClr val="${hex(atom.dimColor)}"/></p:clrVal>`, "nextClick", 0)
			case 2:
				return set("style.visibility", '<p:strVal val="hidden"/>', "nextClick", 0)
			case 3:
				return set("style.visibility", '<p:strVal val="hidden"/>', "sameClick", duration)
			default:
				return ""
		}
	}

	private soundNode(atom: LegacyAtom): string {
		if (!atom.sound) return ""

		const sound =
			(atom.soundContainer === undefined ? undefined : this.context.embeddedSound(atom.soundContainer)) ??
			this.context.sound(atom.soundIdRef)

		if (sound === undefined) return ""

		return `<p:audio><p:cMediaNode><p:cTn id="${String(this.next())}" display="0" masterRel="sameClick"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:endCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:endCondLst></p:cTn><p:tgtEl><p:sndTgt r:embed="${sound.rId}" name="${xmlText(sound.name)}"/></p:tgtEl></p:cMediaNode></p:audio>`
	}

	private effectXml(step: LegacyStep, delay: number): { readonly xml: string; readonly duration: number } {
		const atom = step.atom
		const effect = atom.build === 0 ? APPEAR : legacyEffect(atom.effect, atom.direction)
		const target = this.target(step)
		const id = this.next()
		const stop = atom.stopSound
			? `<p:cmd type="evt" cmd="onstopaudio"><p:cBhvr><p:cTn id="${String(this.next())}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:sldTgt/></p:tgtEl></p:cBhvr></p:cmd>`
			: ""
		const behaviors = effect.behaviors(target, this.next)
		const iterate =
			step.paragraph !== undefined || atom.textBuild === 0 || atom.textBuild > 2
				? ""
				: `<p:iterate type="${atom.textBuild === 1 ? "wd" : "lt"}"><p:tmPct val="10000"/></p:iterate>`
		const sub = this.afterEffect(step, target, effect.durationMs) + this.soundNode(atom)
		const nodeType = step.trigger === "click" ? "clickEffect" : step.trigger === "with" ? "withEffect" : "afterEffect"

		return {
			duration: effect.durationMs,
			xml:
				`<p:par><p:cTn id="${String(id)}" presetID="${String(effect.presetID)}" presetClass="entr" presetSubtype="${String(effect.presetSubtype)}" fill="hold" grpId="0" nodeType="${nodeType}">` +
				`<p:stCondLst><p:cond delay="${String(delay)}"/></p:stCondLst>${iterate}<p:childTnLst>${stop}${behaviors}</p:childTnLst>` +
				(sub === "" ? "" : `<p:subTnLst>${sub}</p:subTnLst>`) +
				"</p:cTn></p:par>"
		}
	}

	timing(atoms: readonly LegacyAtom[]): string {
		const steps = this.steps(atoms)

		if (steps.length === 0) return ""

		const clicks: string[] = []
		let groups: string[] = []
		// The current with-group: its effects, its begin within the click, and when its longest effect ends.
		let group: { effects: string[]; begin: number; end: number } | undefined
		let clickStart: string | undefined
		const closeGroup = (): void => {
			if (group === undefined) return

			groups.push(
				`<p:par><p:cTn id="${String(this.next())}" fill="hold"><p:stCondLst><p:cond delay="${String(group.begin)}"/></p:stCondLst><p:childTnLst>${group.effects.join("")}</p:childTnLst></p:cTn></p:par>`
			)
		}
		const closeClick = (): void => {
			closeGroup()

			if (clickStart !== undefined && groups.length > 0)
				clicks.push(
					`<p:par><p:cTn id="${String(this.next())}" fill="hold"><p:stCondLst>${clickStart}</p:stCondLst><p:childTnLst>${groups.join("")}</p:childTnLst></p:cTn></p:par>`
				)

			groups = []
			group = undefined
		}

		for (const step of steps) {
			const delay = step.trigger === "after" ? step.atom.delay : 0

			if (step.trigger === "click" || clickStart === undefined) {
				closeClick()
				// The first effect may start with the slide: it waits for the main sequence's begin, not a click.
				clickStart =
					step.trigger === "click"
						? '<p:cond delay="indefinite"/>'
						: '<p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>'
				group = { effects: [], begin: 0, end: 0 }
			} else if (step.trigger === "after") {
				const end = group?.end ?? 0

				closeGroup()
				group = { effects: [], begin: end, end }
			}

			const current = group ?? { effects: [], begin: 0, end: 0 }
			const effect = this.effectXml(step, delay)

			current.effects.push(effect.xml)
			current.end = Math.max(current.end, current.begin + delay + effect.duration)
			group = current
		}

		closeClick()

		const builds = new Map<number, string>()

		for (const atom of atoms) {
			if (builds.has(atom.spid) || this.context.shapes.get(atom.spid) === undefined) continue

			const level = buildLevel(atom.build)
			const text = (this.context.shapes.get(atom.spid)?.paragraphs.length ?? 0) > 0

			if (!text) continue

			builds.set(
				atom.spid,
				`<p:bldP spid="${String(atom.spid)}" grpId="0"${level > 0 ? ` build="p"${level > 1 ? ` bldLvl="${String(level)}"` : ""}` : ""}${atom.animateBackground ? ' animBg="1"' : ""}${atom.reverse && level > 0 ? ' rev="1"' : ""}/>`
			)
		}

		return (
			'<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>' +
			`<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${clicks.join("")}</p:childTnLst></p:cTn>` +
			'<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>' +
			'<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>' +
			"</p:childTnLst></p:cTn></p:par></p:tnLst>" +
			(builds.size === 0 ? "" : `<p:bldLst>${[...builds.values()].join("")}</p:bldLst>`) +
			"</p:timing>"
		)
	}
}

// The paragraphs of a text body: character ranges and levels (paragraphs end at a carriage return, §2.9.20).
export function paragraphSpans(block: TextBlock | undefined): PptParagraphSpan[] {
	if (block === undefined) return []

	const out: PptParagraphSpan[] = []
	const text = block.text
	const runs = block.pfRuns
	// The paragraph run holding the next paragraph's first character (paragraphs and runs both go forward).
	let run = 0
	let runEnd = runs[0]?.count ?? 0
	const levelAt = (offset: number): number => {
		while (run < runs.length - 1 && offset >= runEnd) {
			run++
			runEnd += runs[run]?.count ?? 0
		}

		return Math.max(0, Math.min(8, runs[run]?.level ?? 0))
	}
	let start = 0

	for (let at = 0; at <= text.length; at++) {
		if (at === text.length || text.charCodeAt(at) === 0x0d) {
			if (at === text.length && at === start && out.length > 0) break

			out.push({ start, end: at, level: levelAt(start) })
			start = at + 1
		}
	}

	return out
}

// The slide's p:timing: its PowerPoint 2002 tree when it has one, else its shapes' Office 97 builds.
export function slideTiming(slide: PptRecord, builds: readonly PptLegacyBuild[], context: PptAnimContext): PptTiming {
	let tag: readonly PptRecord[] | undefined

	try {
		tag = pp10Records(context.data, slide, context.counter)
	} catch (error) {
		if (error instanceof PresentationError && error.reason === "malformed") return { xml: "", lost: true }

		throw error
	}

	return timingOf(tag, builds, context)
}

// The same from the slide's "___PPT10" tag records as pp10Records read them (undefined: it has none). A damaged
// record or a budget overrun loses the slide's timing (reported), never the deck. A slide whose tree is an empty root
// had its own effects removed: only its master's builds play. A tree leaves out the master's builds on shapes it does
// not animate (reported).
export function timingOf(tag: readonly PptRecord[] | undefined, builds: readonly PptLegacyBuild[], context: PptAnimContext): PptTiming {
	const data = context.data
	const clamped = outOfRange

	try {
		const root = tag?.find(record => record.type === RT.extTimeNode)

		// A root without children times nothing: the slide has no timing (PowerPoint writes such a root for a slide whose
		// effects were all removed).
		if (root !== undefined && children(data, root.start, root.end, context.counter).some(record => record.type === RT.extTimeNode)) {
			const writer = new TreeWriter(context)
			const tree = writer.node(root, 1)
			const list = tag?.find(record => record.type === RT.buildList)
			const buildXml = list === undefined ? "" : writer.builds(list)

			const dropped = builds.some(build => build.inherited === true && !writer.targets.has(build.spid))

			return { xml: `<p:timing><p:tnLst>${tree}</p:tnLst>${buildXml}</p:timing>`, lost: outOfRange !== clamped || dropped }
		}

		const playing = root === undefined ? builds : builds.filter(build => build.inherited === true)

		if (playing.length === 0) return { xml: "", lost: false }

		const atoms = playing
			.map((build, index) => readLegacyAtom(context, build, index))
			.filter((atom): atom is LegacyAtom => atom !== undefined && atom.build !== 0 && context.shapes.has(atom.spid))
			// orderID, then drawing order; -2 follows the master and plays last (it has no place of its own here).
			.sort((a, b) => (a.order < 0 ? 0x7fff : a.order) - (b.order < 0 ? 0x7fff : b.order) || a.index - b.index)

		if (atoms.length === 0) return { xml: "", lost: false }

		return { xml: new LegacyWriter(context).timing(atoms), lost: outOfRange !== clamped }
	} catch (error) {
		if (error instanceof OverBudget || (error instanceof PresentationError && error.reason === "malformed"))
			return { xml: "", lost: true }

		throw error
	}
}
