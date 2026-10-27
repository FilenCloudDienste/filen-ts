import type { Rgba } from "../drawingml/index"
import { PresentationError, type ColorModel, type ShapeNode, type SlideNode } from "../presentation/model"
import { tooDeep, tooLarge } from "../presentation/refusal"
import { decodeUtf8, encodeUtf8 } from "../xml/index"
import {
	VAR_H,
	VAR_VALUE,
	VAR_W,
	VAR_X,
	VAR_Y,
	attributeEntry,
	byHsl,
	compileFormula,
	isMediaBehavior,
	ease,
	lerpHsl,
	lerpRgb,
	type AttributeEntry,
	type Formula
} from "./attributes"
import type {
	AnimTarget,
	Behavior,
	CompiledTimegraph,
	LayerIndex,
	LayerState,
	TimeCondition,
	TimeEvent,
	TimegraphInstance,
	TimegraphSnapshot,
	TimeNode,
	TimingBudgets,
	Track
} from "./model"
import { parseMotionPath, pointAt, type MotionPath } from "./motion"

// The event-driven timegraph of one slide (ECMA-376 Part 1 §19.5, the SMIL timing model PresentationML profiles).
// compile() flattens the slide's TimingTree into typed arrays in document order (parents before children); an
// instance keeps the log of events fired at it and the schedule the log resolves: per time node its begin and end in
// slide milliseconds, NaN while unresolved. Resolution is eager: a node that begins schedules every child whose begin
// is a delay, a node whose end resolves starts the next child of its sequence and ends a container waiting for it, so
// after-effects and their whole chains are known as soon as their click is. Events (next, shape clicks, hovers, media
// bookmarks) begin, advance or end the nodes whose condition lists name them. sample(t) is a pure function of that
// schedule: it walks the behaviours once and folds their values into per-layer states by the attribute matrix.
//
// Choices where §19.5 leaves one (as PowerPoint plays them):
// - "next" while the current main-sequence step still runs, with nextAc="seek": the step jumps to its end state and
//   the click is spent; nextAc="none" ends the step (keeping it running when concurrent) and begins the next.
// - A container without dur ends when all of its begun children have ended (endsync "last" over timed children);
//   children waiting on an event do not hold it open. A repeating container (an "until next click" emphasis) repeats
//   that span.
// - fill defaults as SMIL's "auto": remove when the node has a dur, a repeat or an end condition, freeze otherwise.
//   A frozen value stays while every ancestor is active or frozen.
// - A shape whose first visibility behaviour sets it visible is hidden before that behaviour begins.
// - prev drops the event that began the current main-sequence step and everything after it, and replays the log, so
//   the state equals the snapshot taken at that step boundary (fill="remove" effects of earlier steps included).
// - spd scales a behaviour's own time only.
// - snapshot().step counts the main-sequence steps begun; it is mainSteps + 1 once a "next" found no step left (the
//   player then advances the slide). sample() returns the layers some behaviour targets, in layer order.

const PX_PER_EMU = 1 / 9525
const DEFAULT_SLIDE = { cx: 9144000, cy: 6858000 }

const KIND_PAR = 0
const KIND_SEQ = 1
const KIND_EXCL = 2
const KIND_BEHAVIOR = 3

const RESTART_ALWAYS = 0
const RESTART_WHEN_NOT_ACTIVE = 1
const RESTART_NEVER = 2

interface Condition {
	// An event key ("next", "click:4", "bmk:4:name"…) or undefined for a delay or node condition.
	readonly key: string | undefined
	// A node condition: the node index whose begin (true) or end (false) it waits for, -1 for none.
	readonly node: number
	readonly onBegin: boolean
	// Milliseconds; Infinity is "indefinite".
	readonly delay: number
}

export interface CompileOptions {
	// The slide's size in EMU (ppt_x/ppt_y/ppt_w/ppt_h and motion paths are fractions of it); the 4:3 default otherwise.
	readonly slideSize?: { readonly cx: number; readonly cy: number }
	// A shape's box in EMU as rendered (inherited placeholder geometry included); its own xfrm otherwise.
	readonly geometry?: (shape: number) => { readonly x: number; readonly y: number; readonly cx: number; readonly cy: number } | undefined
	// Theme colours of animClr/set values; sRGB values resolve without it.
	readonly color?: (color: ColorModel) => Rgba | undefined
}

interface CompiledBehavior {
	readonly node: number
	readonly kind: Track["kind"]
	readonly behavior: Behavior
	readonly attribute: string
	readonly entry: AttributeEntry | undefined
	readonly layers: Int32Array
	// anim: keyframe times (0..1), numeric values (NaN for formulas), formulas per value and per keyframe.
	readonly times?: Float64Array
	readonly values?: Float64Array
	readonly valueFormulas?: readonly (Formula | undefined)[]
	readonly fmlas?: readonly (Formula | undefined)[]
	readonly strings?: readonly (string | undefined)[]
	readonly colors?: readonly (Rgba | undefined)[]
	readonly from?: Rgba
	readonly to?: Rgba
	readonly path?: MotionPath
}

type GraphFields = Omit<Graph, "activeDuration">

class Graph implements CompiledTimegraph {
	readonly slide: CompiledTimegraph["slide"]
	readonly mainSteps: number
	readonly interactive: CompiledTimegraph["interactive"]
	readonly tracks: readonly Track[]
	// Per node, in document order.
	readonly count: number
	readonly kind: Uint8Array
	readonly parent: Int32Array
	readonly children: readonly Int32Array[]
	readonly dur: Float64Array
	readonly repeat: Float64Array
	readonly repeatDur: Float64Array
	readonly autoRev: Uint8Array
	readonly speed: Float64Array
	readonly accel: Float64Array
	readonly decel: Float64Array
	readonly frozen: Uint8Array
	readonly restart: Uint8Array
	readonly seek: Uint8Array
	readonly concurrent: Uint8Array
	readonly behavior: Int32Array
	readonly begins: readonly (readonly Condition[])[]
	readonly ends: readonly (readonly Condition[])[]
	readonly nexts: readonly (readonly Condition[])[]
	readonly mainSeq: number
	// Nodes per event key, for begin, next and end conditions.
	readonly beginOn: ReadonlyMap<string, readonly number[]>
	readonly nextOn: ReadonlyMap<string, readonly number[]>
	readonly endOn: ReadonlyMap<string, readonly number[]>
	// Node conditions: listeners of a node's begin and end.
	readonly onBegin: ReadonlyMap<number, readonly number[]>
	readonly onEnd: ReadonlyMap<number, readonly number[]>
	readonly behaviors: readonly CompiledBehavior[]
	readonly layerCount: number
	readonly initiallyHidden: Uint8Array
	// Per layer: base centre and size in slide px.
	readonly base: Float64Array
	readonly slidePx: { readonly w: number; readonly h: number }
	readonly budgets: TimingBudgets

	constructor(fields: GraphFields) {
		this.slide = fields.slide
		this.mainSteps = fields.mainSteps
		this.interactive = fields.interactive
		this.tracks = fields.tracks
		this.count = fields.count
		this.kind = fields.kind
		this.parent = fields.parent
		this.children = fields.children
		this.dur = fields.dur
		this.repeat = fields.repeat
		this.repeatDur = fields.repeatDur
		this.autoRev = fields.autoRev
		this.speed = fields.speed
		this.accel = fields.accel
		this.decel = fields.decel
		this.frozen = fields.frozen
		this.restart = fields.restart
		this.seek = fields.seek
		this.concurrent = fields.concurrent
		this.behavior = fields.behavior
		this.begins = fields.begins
		this.ends = fields.ends
		this.nexts = fields.nexts
		this.mainSeq = fields.mainSeq
		this.beginOn = fields.beginOn
		this.nextOn = fields.nextOn
		this.endOn = fields.endOn
		this.onBegin = fields.onBegin
		this.onEnd = fields.onEnd
		this.behaviors = fields.behaviors
		this.layerCount = fields.layerCount
		this.initiallyHidden = fields.initiallyHidden
		this.base = fields.base
		this.slidePx = fields.slidePx
		this.budgets = fields.budgets
	}

	// The active duration of a node with a known simple duration (repeats, auto-reverse, repeatDur, speed and the
	// schedule cap applied); NaN for a container that ends with its children, Infinity for indefinite.
	activeDuration(n: number): number {
		const dur = this.dur[n] ?? Number.NaN

		if (Number.isNaN(dur)) return Number.NaN

		const once = dur * ((this.autoRev[n] ?? 0) === 1 ? 2 : 1)
		let active = once * (this.repeat[n] ?? 1)
		const repeatDur = this.repeatDur[n] ?? Number.NaN

		if (!Number.isNaN(repeatDur)) active = Math.min(active, repeatDur)

		active /= this.speed[n] ?? 1

		return Number.isFinite(active) ? Math.min(active, this.budgets.scheduleMs) : active
	}
}

function findShape(shapes: readonly ShapeNode[], id: number): ShapeNode | undefined {
	for (const shape of shapes) {
		if (shape.id === id) return shape

		const inner = shape.children === undefined ? undefined : findShape(shape.children, id)

		if (inner !== undefined) return inner
	}

	return undefined
}

function targetShape(target: AnimTarget): number {
	return target.kind === "slide" || target.kind === "sound" ? -1 : target.shape
}

function hexRgba(hex: string): Rgba | undefined {
	return /^[0-9A-Fa-f]{6}$/u.test(hex) ? (Number.parseInt(hex, 16) * 256 + 255) >>> 0 : undefined
}

function colorOf(value: unknown, options: CompileOptions): Rgba | undefined {
	if (typeof value !== "object" || value === null || !("kind" in value)) return undefined

	const color = value as ColorModel

	return options.color?.(color) ?? (color.kind === "srgb" && (color.mods ?? []).length === 0 ? hexRgba(color.rgb) : undefined)
}

function trackKind(behavior: Behavior): Track["kind"] {
	switch (behavior.type) {
		case "anim":
			return behavior.valueType === "clr" ? "color" : "value"
		case "animClr":
			return "color"
		case "animMotion":
			return "motion"
		case "animRot":
			return "rotation"
		case "animScale":
			return "scale"
		case "set":
			return "set"
		case "animEffect":
			return "filter"
		case "cmd":
			return "command"
		default:
			return "media"
	}
}

// Scheduling steps one event may take: every node begun, ended and notified a bounded number of times over. A graph
// that needs more (restarts fanning out along node conditions) is refused rather than run on.
function propagationLimit(count: number): number {
	return 64 * count + 65_536
}

// A node condition that closed a cycle: waits for an event nothing fires, so it never resolves.
const CYCLE: Condition = { key: "\u0000cycle", node: -1, onBegin: true, delay: 0 }

// Cycles among the node conditions (tn begin/end references, SMIL syncbases) broken as SMIL 3.0 §5.4.5 "Detecting
// Cycles" does: a change notice that reaches an element already on its propagation path is ignored. The paths are the
// notices a begin or end of each node sends to the nodes whose conditions name it, walked depth-first in document
// order; the condition a notice would reach its path again through never resolves ("Cyclic dependencies in the
// timegraph": the times of a closed cycle stay unresolved). Every propagation an instance runs is then finite.
function breakCycles(count: number, begins: Condition[][], ends: Condition[][]): void {
	const dependents: number[][] = Array.from({ length: count }, () => [])

	for (let n = 0; n < count; n++) {
		for (const list of [begins[n] ?? [], ends[n] ?? []]) {
			for (const c of list) {
				if (c.node < 0) continue

				const at = dependents[c.node] as number[]

				if (at[at.length - 1] !== n) at.push(n)
			}
		}
	}

	// 0 unvisited, 1 on the current path, 2 done.
	const state = new Uint8Array(count)
	const nodes = new Int32Array(count)
	const edges = new Int32Array(count)

	for (let root = 0; root < count; root++) {
		if (state[root] !== 0 || (dependents[root] as number[]).length === 0) continue

		let depth = 0

		nodes[0] = root
		edges[0] = 0
		state[root] = 1

		while (depth >= 0) {
			const from = nodes[depth] as number
			const list = dependents[from] as number[]
			const k = edges[depth] as number

			if (k >= list.length) {
				state[from] = 2
				depth--

				continue
			}

			edges[depth] = k + 1

			const to = list[k] as number

			if (state[to] === 1) {
				for (const conditions of [begins[to] ?? [], ends[to] ?? []])
					for (let c = 0; c < conditions.length; c++) if (conditions[c]?.node === from) conditions[c] = CYCLE
			} else if (state[to] === 0) {
				state[to] = 1
				depth++
				nodes[depth] = to
				edges[depth] = 0
			}
		}
	}
}

// Compiles the slide's timing against its layers. Throws tooLarge/tooDeep past the budgets.
export function compile(slide: SlideNode, layers: LayerIndex, budgets: TimingBudgets, options: CompileOptions = {}): CompiledTimegraph {
	const size = options.slideSize ?? DEFAULT_SLIDE
	const slidePx = { w: size.cx * PX_PER_EMU, h: size.cy * PX_PER_EMU }
	const nodes: TimeNode[] = []
	const parents: number[] = []
	const depths: number[] = []
	const root = slide.timing?.root

	if (root !== undefined) {
		const stack: { node: TimeNode; parent: number; depth: number }[] = [{ node: root, parent: -1, depth: 0 }]

		while (stack.length > 0) {
			const item = stack.pop()

			if (item === undefined) break
			if (item.depth >= budgets.depth) tooDeep("time nodes", budgets.depth)
			if (nodes.length >= budgets.nodesPerSlide) tooLarge("time nodes on a slide", budgets.nodesPerSlide)

			const index = nodes.length

			nodes.push(item.node)
			parents.push(item.parent)
			depths.push(item.depth)

			const children = item.node.ctn.children

			for (let k = children.length - 1; k >= 0; k--) {
				const child = children[k]

				if (child !== undefined) stack.push({ node: child, parent: index, depth: item.depth + 1 })
			}
		}
	}

	const count = nodes.length
	const kind = new Uint8Array(count)
	const parent = Int32Array.from(parents)
	const childLists: number[][] = nodes.map(() => [])
	const dur = new Float64Array(count)
	const repeat = new Float64Array(count)
	const repeatDur = new Float64Array(count)
	const autoRev = new Uint8Array(count)
	const speed = new Float64Array(count)
	const accel = new Float64Array(count)
	const decel = new Float64Array(count)
	const frozen = new Uint8Array(count)
	const restart = new Uint8Array(count)
	const seek = new Uint8Array(count)
	const concurrent = new Uint8Array(count)
	const behaviorIndex = new Int32Array(count).fill(-1)
	const byId = new Map<number, number>()
	let mainSeq = -1

	for (let n = 0; n < count; n++) {
		const node = nodes[n] as TimeNode

		if (!byId.has(node.ctn.id)) byId.set(node.ctn.id, n)

		const p = parent[n] ?? -1

		if (p >= 0) childLists[p]?.push(n)
	}

	const condition = (c: TimeCondition, implicitShape: number): Condition => {
		const delay = c.delay === "indefinite" ? Number.POSITIVE_INFINITY : c.delay
		const shape = c.tgtEl === undefined ? implicitShape : targetShape(c.tgtEl)

		if (
			c.tn !== undefined &&
			(c.evt === undefined || c.evt === "onBegin" || c.evt === "begin" || c.evt === "onEnd" || c.evt === "end")
		) {
			return { key: undefined, node: byId.get(c.tn) ?? -1, onBegin: c.evt !== "onEnd" && c.evt !== "end", delay }
		}

		let key: string | undefined

		switch (c.evt) {
			case "onClick":
				key = shape < 0 ? "next" : `click:${String(shape)}`
				break
			case "onDblClick":
				key = `dbl:${String(shape)}`
				break
			case "onMouseOver":
				key = `over:${String(shape)}`
				break
			case "onMouseOut":
				key = `out:${String(shape)}`
				break
			case "onNext":
				key = "next"
				break
			case "onPrev":
				key = "prev"
				break
			case "onMediaBookmark":
				key = `bmk:${String(shape)}:${c.bookmark ?? ""}`
				break
			case "onStopAudio":
				key = "stopAudio"
				break
			case "onEnd":
			case "end":
				key = shape < 0 ? undefined : `mediaEnd:${String(shape)}`
				break
			default:
				key = undefined
		}

		return { key, node: -1, onBegin: true, delay }
	}

	const begins: Condition[][] = []
	const ends: Condition[][] = []
	const nexts: Condition[][] = []

	for (let n = 0; n < count; n++) {
		const node = nodes[n] as TimeNode
		const ctn = node.ctn

		kind[n] = node.kind === "par" ? KIND_PAR : node.kind === "seq" ? KIND_SEQ : node.kind === "excl" ? KIND_EXCL : KIND_BEHAVIOR
		dur[n] = ctn.dur === undefined ? Number.NaN : ctn.dur === "indefinite" ? Number.POSITIVE_INFINITY : Math.max(0, ctn.dur)
		repeat[n] =
			ctn.repeatCount === undefined
				? 1
				: ctn.repeatCount === "indefinite"
					? Number.POSITIVE_INFINITY
					: Math.max(0, ctn.repeatCount) / 1000
		repeatDur[n] = ctn.repeatDur === undefined ? Number.NaN : ctn.repeatDur === "indefinite" ? Number.POSITIVE_INFINITY : ctn.repeatDur
		autoRev[n] = ctn.autoRev === true ? 1 : 0
		speed[n] = ctn.spd === undefined || ctn.spd <= 0 ? 1 : ctn.spd / 100000
		accel[n] = Math.min(1, Math.max(0, (ctn.accel ?? 0) / 100000))
		decel[n] = Math.min(1, Math.max(0, (ctn.decel ?? 0) / 100000))
		restart[n] = ctn.restart === "never" ? RESTART_NEVER : ctn.restart === "whenNotActive" ? RESTART_WHEN_NOT_ACTIVE : RESTART_ALWAYS
		seek[n] = ctn.nextAc === "seek" ? 1 : 0
		concurrent[n] = ctn.concurrent === true ? 1 : 0

		const timed = ctn.dur !== undefined || ctn.repeatCount !== undefined || ctn.repeatDur !== undefined || ctn.endCondLst.length > 0

		frozen[n] = ctn.fill === undefined ? (timed ? 0 : 1) : ctn.fill === "remove" ? 0 : 1

		if (ctn.nodeType === "mainSeq" && mainSeq < 0) mainSeq = n

		begins.push(ctn.stCondLst.map(c => condition(c, -1)))
		ends.push(ctn.endCondLst.map(c => condition(c, -1)))

		const next = (ctn.nextCondLst ?? []).map(c => condition(c, -1))

		// A main sequence advances on "next" even when the file names no condition for it.
		if (ctn.nodeType === "mainSeq" && !next.some(c => c.key === "next")) next.push({ key: "next", node: -1, onBegin: true, delay: 0 })

		nexts.push(next)
	}

	breakCycles(count, begins, ends)

	const index = (lists: readonly (readonly Condition[])[]): Map<string, number[]> => {
		const out = new Map<string, number[]>()

		lists.forEach((list, n) => {
			for (const c of list) {
				if (c.key === undefined) continue

				const at = out.get(c.key)

				if (at === undefined) out.set(c.key, [n])
				else if (at[at.length - 1] !== n) at.push(n)
			}
		})

		return out
	}
	const listeners = (wantBegin: boolean): Map<number, number[]> => {
		const out = new Map<number, number[]>()

		for (const list of [begins, ends]) {
			list.forEach((conditions, n) => {
				for (const c of conditions) {
					if (c.node < 0 || c.onBegin !== wantBegin) continue

					const at = out.get(c.node)

					if (at === undefined) out.set(c.node, [n])
					else if (!at.includes(n)) at.push(n)
				}
			})
		}

		return out
	}

	// Layers by shape, and the layer's text range.
	const layersOf = new Map<number, number[]>()
	const layerCount = layers.shapes.length

	for (let layer = 0; layer < layerCount; layer++) {
		const shape = layers.shapes[layer] ?? -1
		const at = layersOf.get(shape)

		if (at === undefined) layersOf.set(shape, [layer])
		else at.push(layer)
	}

	const layersFor = (target: AnimTarget): Int32Array => {
		const shape = targetShape(target)
		const candidates = layersOf.get(shape) ?? []

		if (target.kind === "text") {
			const ranged = candidates.filter(layer => {
				const range = layers.ranges?.[layer]

				return range !== undefined && range.unit === target.unit && range.start >= target.start && range.end <= target.end
			})

			if (ranged.length > 0) return Int32Array.from(ranged)
		}

		const whole = candidates.filter(layer => layers.ranges?.[layer] === undefined)

		return Int32Array.from(whole.length > 0 ? whole : candidates)
	}

	const behaviors: CompiledBehavior[] = []
	const tracks: Track[] = []
	const firstVisibility = new Int8Array(layerCount).fill(-1)
	const aspect = slidePx.h > 0 ? slidePx.w / slidePx.h : 1
	const formulas = new Map<string, Formula | undefined>()
	const formula = (text: string): Formula | undefined => {
		if (!formulas.has(text)) formulas.set(text, compileFormula(text))

		return formulas.get(text)
	}

	for (let n = 0; n < count; n++) {
		const node = nodes[n] as TimeNode

		if (node.kind !== "behavior") continue

		const behavior = node.behavior
		const target = isMediaBehavior(behavior) ? behavior.target : behavior.common.target
		const attribute = isMediaBehavior(behavior) ? "" : (behavior.common.attrNames[0] ?? "")
		const entry = attributeEntry(attribute)
		const targets = layersFor(target)
		let extra: Partial<CompiledBehavior> = {}

		switch (behavior.type) {
			case "anim": {
				const times = new Float64Array(behavior.tavLst.length)
				const values = new Float64Array(behavior.tavLst.length)
				const valueFormulas: (Formula | undefined)[] = []
				const fmlas: (Formula | undefined)[] = []
				const strings: (string | undefined)[] = []
				const colors: (Rgba | undefined)[] = []

				behavior.tavLst.forEach((tav, k) => {
					times[k] = tav.tm === "indefinite" ? Number.NaN : tav.tm / 100000
					fmlas.push(tav.fmla === undefined ? undefined : formula(tav.fmla))

					const val = tav.val

					values[k] = Number.NaN
					valueFormulas.push(undefined)
					strings.push(undefined)
					colors.push(colorOf(val, options))

					if (typeof val === "number") values[k] = val
					else if (typeof val === "boolean") values[k] = val ? 1 : 0
					else if (typeof val === "string") {
						const number = Number(val)

						if (val.trim() !== "" && Number.isFinite(number)) values[k] = number
						else {
							valueFormulas[k] = formula(val)
							strings[k] = val
						}
					}
				})

				// tm absent on every value spreads them evenly (SMIL keyTimes default).
				if (times.length > 0 && times.every(Number.isNaN))
					for (let k = 0; k < times.length; k++) times[k] = times.length === 1 ? 0 : k / (times.length - 1)

				extra = { times, values, valueFormulas, fmlas, strings, colors }

				break
			}
			case "animClr": {
				const from = colorOf(behavior.from, options)
				const to = colorOf(behavior.to, options)

				extra = { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }

				break
			}
			case "set": {
				const to = behavior.to

				extra =
					typeof to === "string"
						? { strings: [to] }
						: typeof to === "number"
							? { values: Float64Array.of(to) }
							: { colors: [colorOf(to, options)] }

				if (attribute === "style.visibility" && typeof to === "string") {
					for (const layer of targets) if (firstVisibility[layer] === -1) firstVisibility[layer] = to === "visible" ? 1 : 0
				}

				break
			}
			case "animMotion":
				if (behavior.path !== undefined) extra = { path: parseMotionPath(behavior.path, aspect, budgets.motionSegments) }
				break
			default:
				break
		}

		behaviorIndex[n] = behaviors.length

		const kindOfTrack = trackKind(behavior)

		behaviors.push({ node: n, kind: kindOfTrack, behavior, attribute, entry, layers: targets, ...extra })

		for (const layer of targets) {
			const range =
				layers.ranges?.[layer] ?? (target.kind === "text" ? { unit: target.unit, start: target.start, end: target.end } : undefined)

			tracks.push({ layer, node: node.ctn.id, attribute, kind: kindOfTrack, ...(range === undefined ? {} : { range }) })
		}
	}

	const initiallyHidden = new Uint8Array(layerCount)

	for (let layer = 0; layer < layerCount; layer++) initiallyHidden[layer] = firstVisibility[layer] === 1 ? 1 : 0

	const base = new Float64Array(layerCount * 4)

	for (let layer = 0; layer < layerCount; layer++) {
		const shapeId = layers.shapes[layer] ?? -1
		const box = options.geometry?.(shapeId) ?? findShape(slide.shapes, shapeId)?.xfrm ?? { x: 0, y: 0, cx: size.cx, cy: size.cy }

		base[layer * 4] = (box.x + box.cx / 2) * PX_PER_EMU
		base[layer * 4 + 1] = (box.y + box.cy / 2) * PX_PER_EMU
		base[layer * 4 + 2] = box.cx * PX_PER_EMU
		base[layer * 4 + 3] = box.cy * PX_PER_EMU
	}

	// Main sequence steps: the children a "next" begins (an indefinite delay among their conditions and no other way in).
	let mainSteps = 0

	for (const child of mainSeq < 0 ? [] : (childLists[mainSeq] ?? [])) {
		const conditions = begins[child] ?? []

		const waits = conditions.some(c => c.key === "next" || (c.key === undefined && c.node < 0 && c.delay === Number.POSITIVE_INFINITY))

		if (waits && !conditions.some(c => c.node >= 0)) mainSteps++
	}

	const interactive: { trigger: { slide: typeof slide.ref; id: number }; seq: number }[] = []

	for (let n = 0; n < count; n++) {
		if ((nodes[n] as TimeNode).ctn.nodeType !== "interactiveSeq") continue

		// On the sequence (PowerPoint) or on its first child (LibreOffice).
		const own = nodes[n] as TimeNode
		const click = [...own.ctn.stCondLst, ...(own.ctn.children[0]?.ctn.stCondLst ?? [])].find(
			c => c.evt === "onClick" && c.tgtEl !== undefined
		)
		const shape = click?.tgtEl === undefined ? -1 : targetShape(click.tgtEl)

		if (shape >= 0) interactive.push({ trigger: { slide: slide.ref, id: shape }, seq: interactive.length })
	}

	return new Graph({
		slide: slide.ref,
		mainSteps,
		interactive,
		tracks,
		count,
		kind,
		parent,
		children: childLists.map(list => Int32Array.from(list)),
		dur,
		repeat,
		repeatDur,
		autoRev,
		speed,
		accel,
		decel,
		frozen,
		restart,
		seek,
		concurrent,
		behavior: behaviorIndex,
		begins,
		ends,
		nexts,
		mainSeq,
		beginOn: index(begins),
		nextOn: index(nexts),
		endOn: index(ends),
		onBegin: listeners(true),
		onEnd: listeners(false),
		behaviors,
		layerCount,
		initiallyHidden,
		base,
		slidePx,
		budgets
	})
}

// --- Instance ---

type LoggedEvent = readonly [TimeEvent, number]

interface SampleState {
	filter?: LayerState["filter"]
	dom?: Record<string, number | string | boolean>
	fontSize?: number
	media?: LayerState["media"]
}

function eventKey(event: TimeEvent): string | undefined {
	switch (event.kind) {
		case "next":
			return "next"
		case "prev":
			return "prev"
		case "click":
			return `click:${String(event.shape)}`
		case "dblClick":
			return `dbl:${String(event.shape)}`
		case "hover":
			return `${event.entered ? "over" : "out"}:${String(event.shape)}`
		case "mediaBookmark":
			return `bmk:${String(event.shape)}:${event.bookmark}`
		case "mediaEnd":
			return `mediaEnd:${String(event.shape)}`
		case "slideBegin":
			return undefined
	}
}

class Instance implements TimegraphInstance {
	private readonly graph: Graph
	private log: LoggedEvent[] = []
	// Per node: begin and end in slide ms (NaN unresolved), the index of a sequence's current child, whether it ever began.
	private begin: Float64Array
	private end: Float64Array
	private current: Int32Array
	private began: Uint8Array
	// A repeating container's simple duration once its children resolve it (NaN otherwise).
	private simple: Float64Array
	private readonly local: Float64Array
	private now = 0
	private step = 0
	// The log index of the event that began each main-sequence step.
	private stepEvents: number[] = []
	// Nodes whose end resolved, read from `head` on (an index, never a shift).
	private readonly queue: number[] = []
	private head = 0
	// Begin notices to node listeners (listener, source, time), sent in order: a chain of node conditions is walked
	// iteratively, never by recursion.
	private readonly notices: number[] = []
	private noticeHead = 0
	// Containers without their own duration whose children's ends changed: measured once each when the ends settle.
	private readonly dirty: number[] = []
	private readonly dirtyFlag: Uint8Array
	// Scheduling steps left in one event's propagation (a hostile graph refuses tooLarge instead of running on).
	private work = 0
	private readonly vars = new Float64Array(5)
	private readonly point = new Float64Array(2)

	constructor(graph: Graph) {
		this.graph = graph
		this.begin = new Float64Array(graph.count).fill(Number.NaN)
		this.end = new Float64Array(graph.count).fill(Number.NaN)
		this.current = new Int32Array(graph.count).fill(-1)
		this.began = new Uint8Array(graph.count)
		this.simple = new Float64Array(graph.count).fill(Number.NaN)
		this.local = new Float64Array(graph.count)
		this.dirtyFlag = new Uint8Array(graph.count)
	}

	// One scheduling step of the current event's propagation.
	private spend(): void {
		if (--this.work < 0) tooLarge("timing propagation steps", propagationLimit(this.graph.count))
	}

	private reset(): void {
		this.begin.fill(Number.NaN)
		this.end.fill(Number.NaN)
		this.current.fill(-1)
		this.began.fill(0)
		this.simple.fill(Number.NaN)
		this.now = 0
		this.step = 0
		this.stepEvents = []
		this.queue.length = 0
		this.head = 0
		this.notices.length = 0
		this.noticeHead = 0
		for (const n of this.dirty) this.dirtyFlag[n] = 0
		this.dirty.length = 0
	}

	private active(n: number, t: number): boolean {
		const begin = this.begin[n] ?? Number.NaN
		const end = this.end[n] ?? Number.NaN

		return begin <= t && !(end <= t)
	}

	private parentActive(n: number, t: number): boolean {
		const p = this.graph.parent[n] ?? -1

		return p < 0 || this.active(p, t)
	}

	// --- Scheduling ---

	private clear(n: number): void {
		this.begin[n] = Number.NaN
		this.end[n] = Number.NaN
		this.simple[n] = Number.NaN
		this.current[n] = -1

		for (const child of this.graph.children[n] ?? []) if (!Number.isNaN(this.begin[child] ?? Number.NaN)) this.clear(child)
	}

	// The earliest begin `n`'s delay conditions give relative to `origin`, or NaN when none is a plain delay.
	private timedBegin(n: number, origin: number): number {
		let best = Number.NaN

		for (const c of this.graph.begins[n] ?? []) {
			if (c.key !== undefined || c.node >= 0 || !Number.isFinite(c.delay)) continue

			const at = origin + c.delay

			if (!(at >= best)) best = at
		}

		// A node with no conditions at all begins with its parent (or after its predecessor in a sequence).
		if ((this.graph.begins[n] ?? []).length === 0) best = origin

		return best
	}

	private start(n: number, at: number): void {
		const g = this.graph

		this.spend()
		this.clear(n)
		this.begin[n] = at
		this.began[n] = 1

		const p = g.parent[n] ?? -1

		// An exclusive container plays one child at a time.
		if (p >= 0 && g.kind[p] === KIND_EXCL) {
			for (const sibling of g.children[p] ?? []) if (sibling !== n && this.active(sibling, at)) this.finish(sibling, at)
		}

		const active = g.activeDuration(n)

		if (!Number.isNaN(active)) {
			this.end[n] = at + active

			if (Number.isFinite(active)) this.queue.push(n)
		}

		const children = g.children[n] ?? []

		if (g.kind[n] === KIND_SEQ) {
			const first = children[0]

			if (first !== undefined) {
				this.current[n] = 0

				const when = this.timedBegin(first, at)

				if (!Number.isNaN(when)) this.start(first, when)
			}
		} else if (g.kind[n] !== KIND_BEHAVIOR) {
			for (const child of children) {
				const when = this.timedBegin(child, at)

				if (!Number.isNaN(when)) this.start(child, when)
			}
		}

		if (Number.isNaN(active) && g.kind[n] !== KIND_BEHAVIOR) this.containerChanged(n)

		for (const listener of g.onBegin.get(n) ?? []) this.notices.push(listener, n, at)
	}

	// A listener of `source`'s begin or end at `time`.
	private nodeEvent(listener: number, source: number, onBegin: boolean, time: number): void {
		const g = this.graph

		this.spend()

		if (!Number.isFinite(time)) return

		for (const c of g.begins[listener] ?? []) {
			if (c.node === source && c.onBegin === onBegin && Number.isFinite(c.delay) && this.parentActive(listener, time)) {
				if (!this.active(listener, time + c.delay) || g.restart[listener] === RESTART_ALWAYS) this.start(listener, time + c.delay)

				return
			}
		}

		for (const c of g.ends[listener] ?? []) {
			if (c.node === source && c.onBegin === onBegin && Number.isFinite(c.delay) && this.active(listener, time + c.delay)) {
				this.finish(listener, time + c.delay)

				return
			}
		}
	}

	// Ends `n` at `at`: children still playing end with it, children not begun by then are unscheduled.
	private finish(n: number, at: number): void {
		const g = this.graph
		const begin = this.begin[n] ?? Number.NaN

		if (Number.isNaN(begin)) return

		this.spend()
		this.end[n] = Math.max(begin, at)

		for (const child of g.children[n] ?? []) {
			const childBegin = this.begin[child] ?? Number.NaN

			if (Number.isNaN(childBegin)) continue

			const childEnd = this.end[child] ?? Number.NaN

			if (childBegin >= at) this.clear(child)
			else if (!(childEnd <= at)) this.finish(child, at)
		}

		this.queue.push(n)
	}

	// A container without its own duration ends when every begun child has ended.
	private containerChanged(n: number): void {
		const g = this.graph

		if (g.kind[n] === KIND_BEHAVIOR || !Number.isNaN(g.activeDuration(n)) || Number.isNaN(this.begin[n] ?? Number.NaN)) return

		let last = this.begin[n] ?? 0

		if (g.kind[n] === KIND_SEQ) {
			const children = g.children[n] ?? []
			const index = this.current[n] ?? -1

			// A sequence ends after its last child.
			if (children.length > 0 && index < children.length - 1) return

			const child = children[children.length - 1]

			if (child !== undefined) {
				const end = this.end[child] ?? Number.NaN

				if (Number.isNaN(end) || Number.isNaN(this.begin[child] ?? Number.NaN)) return

				last = end
			}
		} else {
			for (const child of g.children[n] ?? []) {
				const childBegin = this.begin[child] ?? Number.NaN

				if (Number.isNaN(childBegin)) {
					// A child that will begin by its delay holds the container open.
					if (!Number.isNaN(this.timedBegin(child, this.begin[n] ?? 0))) return

					continue
				}

				const end = this.end[child] ?? Number.NaN

				if (Number.isNaN(end) || end === Number.POSITIVE_INFINITY) return

				last = Math.max(last, end)
			}
		}

		const begin = this.begin[n] ?? 0
		let end = last

		// A repeating container repeats what its children play (its simple duration).
		if ((g.repeat[n] ?? 1) !== 1 || (g.autoRev[n] ?? 0) === 1 || !Number.isNaN(g.repeatDur[n] ?? Number.NaN)) {
			const simple = last - begin
			let active = simple * ((g.autoRev[n] ?? 0) === 1 ? 2 : 1) * (g.repeat[n] ?? 1)
			const repeatDur = g.repeatDur[n] ?? Number.NaN

			if (!Number.isNaN(repeatDur)) active = Math.min(active, repeatDur)
			if (Number.isFinite(active)) active = Math.min(active, g.budgets.scheduleMs)

			this.simple[n] = simple
			end = simple > 0 ? begin + active : last
		}

		if (this.end[n] === end) return

		this.end[n] = end

		if (Number.isFinite(end)) this.queue.push(n)
	}

	// Begin notices first, then ends that resolved (the next child of a sequence, end listeners), then the containers
	// those ends left to measure, until nothing changes.
	private drain(): void {
		const g = this.graph

		for (;;) {
			if (this.noticeHead < this.notices.length) {
				const listener = this.notices[this.noticeHead] as number
				const source = this.notices[this.noticeHead + 1] as number
				const time = this.notices[this.noticeHead + 2] as number

				this.noticeHead += 3

				if (this.noticeHead === this.notices.length) {
					this.notices.length = 0
					this.noticeHead = 0
				}

				this.nodeEvent(listener, source, true, time)

				continue
			}

			if (this.head >= this.queue.length) {
				this.queue.length = 0
				this.head = 0

				const container = this.dirty.pop()

				if (container === undefined) return

				this.dirtyFlag[container] = 0
				this.containerChanged(container)

				continue
			}

			const n = this.queue[this.head++] as number
			const p = g.parent[n] ?? -1
			const end = this.end[n] ?? Number.NaN

			if (p >= 0 && Number.isFinite(end)) {
				if (g.kind[p] === KIND_SEQ) {
					const children = g.children[p] ?? []
					const index = this.current[p] ?? -1

					if (children[index] === n && index + 1 < children.length) {
						const next = children[index + 1] as number
						const when = this.timedBegin(next, end)

						if (!Number.isNaN(when)) {
							this.current[p] = index + 1
							this.start(next, when)
						}
					}
				}

				if (g.kind[p] === KIND_SEQ) this.containerChanged(p)
				else if (this.dirtyFlag[p] === 0) {
					this.dirtyFlag[p] = 1
					this.dirty.push(p)
				}
			}

			for (const listener of g.onEnd.get(n) ?? []) this.nodeEvent(listener, n, false, this.end[n] ?? Number.NaN)
		}
	}

	// The subtree of `n` has something timed still to play after `t`.
	private running(n: number, t: number): boolean {
		const begin = this.begin[n] ?? Number.NaN

		if (Number.isNaN(begin)) return false
		if (begin > t) return true

		const end = this.end[n] ?? Number.NaN

		if (Number.isFinite(end) && end > t) return true

		for (const child of this.graph.children[n] ?? []) if (this.running(child, t)) return true

		return false
	}

	// Seeks the subtree of `n` to its end at `t` (nextAc="seek"): every scheduled time moves back by the same amount.
	private seekToEnd(n: number, t: number): void {
		let latest = t
		const visit = (node: number, f: (node: number) => void): void => {
			if (Number.isNaN(this.begin[node] ?? Number.NaN)) return

			f(node)

			for (const child of this.graph.children[node] ?? []) visit(child, f)
		}

		visit(n, node => {
			const begin = this.begin[node] ?? Number.NaN
			const end = this.end[node] ?? Number.NaN

			if (begin > latest) latest = begin
			if (Number.isFinite(end) && end > latest) latest = end
		})

		const shift = latest - t

		if (shift <= 0) return

		visit(n, node => {
			this.begin[node] = (this.begin[node] ?? 0) - shift

			const end = this.end[node] ?? Number.NaN

			if (Number.isFinite(end)) this.end[node] = end - shift
		})
		this.queue.push(n)
	}

	// "next" (or a shape click) on an active sequence.
	private advance(seq: number, t: number, logIndex: number): void {
		const g = this.graph
		const children = g.children[seq] ?? []
		const index = this.current[seq] ?? -1
		const child = children[index]
		const pending = child !== undefined && Number.isNaN(this.begin[child] ?? Number.NaN)

		if (child !== undefined && !pending && this.running(child, t)) {
			if (g.seek[seq] === 1) {
				this.seekToEnd(child, t)

				return
			}

			if (g.concurrent[seq] !== 1) this.finish(child, t)
		}

		// The current child waits for this event, or the one after it.
		const target = pending ? index : index + 1
		const next = children[target]

		if (next === undefined) {
			if (seq === g.mainSeq) {
				this.step = g.mainSteps + 1
				this.stepEvents.push(logIndex)
			}

			return
		}

		this.current[seq] = target
		this.start(next, t)

		if (seq === g.mainSeq) {
			this.step++
			this.stepEvents.push(logIndex)
		}
	}

	private apply(event: TimeEvent, t: number, logIndex: number): void {
		const g = this.graph

		this.now = Math.max(this.now, t)
		this.work = propagationLimit(g.count)

		if (event.kind === "slideBegin") {
			if (g.count > 0) this.start(0, t)
			this.drain()

			return
		}

		const key = eventKey(event)

		if (key === undefined) return

		// Ends first: "until next click" ends with the click that also begins the next step.
		for (const n of g.endOn.get(key) ?? []) {
			if (!this.active(n, t)) continue

			const c = (g.ends[n] ?? []).find(condition => condition.key === key)

			this.finish(n, t + (c !== undefined && Number.isFinite(c.delay) ? c.delay : 0))
		}

		this.drain()

		const advanced = new Set<number>()

		for (const seq of g.nextOn.get(key) ?? []) {
			if (!this.active(seq, t)) continue

			advanced.add(seq)
			this.advance(seq, t, logIndex)
		}

		this.drain()

		for (const n of g.beginOn.get(key) ?? []) {
			if (advanced.has(n) || !this.parentActive(n, t)) continue

			const p = g.parent[n] ?? -1

			// A sequence's child begins by its event only in its turn.
			if (p >= 0 && g.kind[p] === KIND_SEQ && (g.children[p] ?? [])[this.current[p] ?? -1] !== n) continue

			if (this.active(n, t)) {
				if (g.restart[n] !== RESTART_ALWAYS) continue
			} else if (g.restart[n] === RESTART_NEVER && this.began[n] === 1) {
				continue
			}

			const c = (g.begins[n] ?? []).find(condition => condition.key === key)

			this.start(n, t + (c !== undefined && Number.isFinite(c.delay) ? c.delay : 0))
		}

		this.drain()
	}

	private replay(log: readonly LoggedEvent[]): void {
		this.reset()
		this.log = []

		for (const [event, at] of log) {
			this.log.push([event, at])
			this.apply(event, at, this.log.length - 1)
		}
	}

	fire(event: TimeEvent, atMs: number): void {
		const g = this.graph

		if (event.kind === "prev") {
			const from = this.stepEvents[this.stepEvents.length - 1]

			if (from === undefined) return

			this.replay(this.log.slice(0, from))
			this.now = Math.max(this.now, atMs)

			return
		}

		const key = eventKey(event)

		// Events nothing listens for are not kept (hover over a shape without a trigger).
		if (key !== undefined && !g.beginOn.has(key) && !g.nextOn.has(key) && !g.endOn.has(key)) return
		if (this.log.length >= g.budgets.eventsPerShow) tooLarge("timing events", g.budgets.eventsPerShow)

		this.log.push([event, atMs])
		this.apply(event, atMs, this.log.length - 1)
	}

	// --- Sampling ---

	// The simple-time progress of behaviour node `n` at `t`, 0..1, or NaN when it has no effect at `t`.
	private progress(n: number, t: number, alive: Uint8Array): number {
		const g = this.graph
		const begin = this.begin[n] ?? Number.NaN

		if (Number.isNaN(begin) || begin > t || alive[n] !== 1) return Number.NaN

		const end = this.end[n] ?? Number.NaN
		const local = ((Number.isFinite(end) ? Math.min(t, end) : t) - begin) * (g.speed[n] ?? 1)
		const dur = g.dur[n] ?? Number.NaN

		// No simple duration (a set, or indefinite): the start value holds; a zero duration is at its end at once.
		if (dur === 0) return 1
		if (!(dur > 0) || !Number.isFinite(dur)) return 0

		const period = dur * ((g.autoRev[n] ?? 0) === 1 ? 2 : 1)
		let within = local % period

		// At the very end of the last repetition the value is the end of that repetition, not the start of the next.
		if (within === 0 && local > 0) within = period

		let u = within / dur

		if (u > 1) u = 2 - u

		return ease(Math.min(1, Math.max(0, u)), g.accel[n] ?? 0, g.decel[n] ?? 0)
	}

	sample(tMs: number): LayerState[] {
		const g = this.graph
		const t = tMs
		const alive = new Uint8Array(g.count)
		// Per node, the time its children see: its parent's, folded into the current repetition of a repeating container.
		const local = this.local

		// Active, or ended with fill and every ancestor active or frozen (document order puts parents first).
		for (let n = 0; n < g.count; n++) {
			const p = g.parent[n] ?? -1
			const x = p < 0 ? t : (local[p] ?? t)

			local[n] = x

			if (p >= 0 && alive[p] !== 1) continue

			const begin = this.begin[n] ?? Number.NaN

			if (Number.isNaN(begin) || begin > x) continue

			const end = this.end[n] ?? Number.NaN

			alive[n] = !(end <= x) || g.frozen[n] === 1 ? 1 : 0

			const simple = this.simple[n] ?? Number.NaN

			if (simple > 0 && Number.isFinite(simple)) {
				const elapsed = (Number.isFinite(end) ? Math.min(x, end) : x) - begin
				const period = simple * ((g.autoRev[n] ?? 0) === 1 ? 2 : 1)
				let within = elapsed % period

				if (within === 0 && elapsed > 0) within = period
				if (within > simple) within = 2 * simple - within

				local[n] = begin + within
			}
		}

		const layers = g.layerCount
		const used = new Uint8Array(layers)

		for (const track of g.tracks) used[track.layer] = 1

		// Per layer: dx, dy, sx, sy, rotation, xshear, yshear, opacity.
		const transform = new Float64Array(layers * 8)
		const visible = new Int8Array(layers)
		const visibleAt = new Float64Array(layers).fill(Number.NEGATIVE_INFINITY)
		const opacityAt = new Float64Array(layers).fill(Number.NEGATIVE_INFINITY)
		const states: SampleState[] = []

		for (let layer = 0; layer < layers; layer++) {
			transform[layer * 8 + 2] = 1
			transform[layer * 8 + 3] = 1
			transform[layer * 8 + 7] = 1
			visible[layer] = g.initiallyHidden[layer] === 1 ? 0 : 1
			states.push({})
		}

		for (const compiled of g.behaviors) {
			const n = compiled.node
			const p = g.parent[n] ?? -1
			const u = this.progress(n, p < 0 ? t : (local[p] ?? t), alive)

			if (Number.isNaN(u)) continue

			const begin = this.begin[n] ?? 0
			const behavior = compiled.behavior

			for (const layer of compiled.layers) {
				const o = layer * 8
				const state = states[layer] as SampleState

				switch (behavior.type) {
					case "set":
					case "anim": {
						const value = behavior.type === "set" ? this.setValue(compiled) : this.animValue(compiled, u, layer)

						this.assign(compiled, layer, value, begin, transform, visible, visibleAt, opacityAt, state)

						break
					}
					case "animClr": {
						const from = compiled.from

						if (from === undefined) break

						const color =
							compiled.to !== undefined
								? behavior.clrSpc === "hsl"
									? lerpHsl(from, compiled.to, u, behavior.dir ?? "cw")
									: lerpRgb(from, compiled.to, u)
								: behavior.by !== undefined && !("kind" in behavior.by)
									? byHsl(from, behavior.by, u)
									: from

						this.color(compiled, state, color)

						break
					}
					case "animMotion": {
						if (compiled.path === undefined) break

						pointAt(compiled.path, u, this.point)
						transform[o] = (transform[o] ?? 0) + (this.point[0] ?? 0) * g.slidePx.w
						transform[o + 1] = (transform[o + 1] ?? 0) + (this.point[1] ?? 0) * g.slidePx.h

						break
					}
					case "animRot": {
						const from = behavior.from ?? 0
						const delta = behavior.by ?? (behavior.to === undefined ? 0 : behavior.to - from)

						transform[o + 4] = (transform[o + 4] ?? 0) + (from + delta * u) / 60000

						break
					}
					case "animScale": {
						const scale = (axis: "x" | "y"): number => {
							if (behavior.by !== undefined) return 1 + (behavior.by[axis] / 100000 - 1) * u

							const from = behavior.from === undefined ? 1 : behavior.from[axis] / 100000
							const to = behavior.to === undefined ? 1 : behavior.to[axis] / 100000

							return from + (to - from) * u
						}

						transform[o + 2] = (transform[o + 2] ?? 1) * scale("x")
						transform[o + 3] = (transform[o + 3] ?? 1) * scale("y")

						break
					}
					case "animEffect": {
						if (behavior.filter === undefined) break

						state.filter = { name: behavior.filter, progress: u, reverse: behavior.transition === "out" }

						// An entrance filter shows the shape while it plays.
						if (behavior.transition === "in" && begin >= (visibleAt[layer] ?? 0)) {
							visible[layer] = 1
							visibleAt[layer] = begin
						}

						break
					}
					case "cmd": {
						const command = behavior.cmd.trim()
						const from = /^playFrom\(\s*([\d.]+)\s*\)$/u.exec(command)

						state.media = from
							? { command: "play", atMs: Number(from[1]) * 1000 }
							: command === "stop"
								? { command: "stop" }
								: command === "togglePause"
									? { command: "pause" }
									: command === "resume"
										? { command: "resume" }
										: { command: "play" }

						break
					}
					case "audio":
					case "video":
						state.media = { command: "play", atMs: Math.max(0, (p < 0 ? t : (local[p] ?? t)) - begin) }
						break
				}
			}
		}

		const out: LayerState[] = []

		for (let layer = 0; layer < layers; layer++) {
			if (used[layer] !== 1) continue

			const o = layer * 8
			const state = states[layer] as SampleState
			const dom = state.dom

			out.push({
				layer,
				visible: visible[layer] === 1,
				opacity: Math.min(1, Math.max(0, transform[o + 7] ?? 1)),
				matrix: this.matrix(layer, transform),
				...(state.filter === undefined ? {} : { filter: state.filter }),
				...(dom === undefined ? {} : { dom: dom as NonNullable<LayerState["dom"]> }),
				...(state.fontSize === undefined ? {} : { fontSize: state.fontSize }),
				...(state.media === undefined ? {} : { media: state.media })
			})
		}

		return out
	}

	private setValue(compiled: CompiledBehavior): number | string | Rgba | undefined {
		return compiled.strings?.[0] ?? compiled.values?.[0] ?? compiled.colors?.[0]
	}

	// The anim's value at progress `u`: keyframes interpolated (or held, calcmode discrete), each formula evaluated with
	// the layer's geometry, the keyframe's fmla applied with $ = the interpolated value.
	private animValue(compiled: CompiledBehavior, u: number, layer: number): number | string | undefined {
		const times = compiled.times
		const values = compiled.values

		if (times === undefined || values === undefined || times.length === 0) return undefined

		const behavior = compiled.behavior

		if (behavior.type !== "anim") return undefined

		const g = this.graph
		const vars = this.vars

		vars[VAR_X] = (g.base[layer * 4] ?? 0) / g.slidePx.w
		vars[VAR_Y] = (g.base[layer * 4 + 1] ?? 0) / g.slidePx.h
		vars[VAR_W] = (g.base[layer * 4 + 2] ?? 0) / g.slidePx.w
		vars[VAR_H] = (g.base[layer * 4 + 3] ?? 0) / g.slidePx.h

		let k = 0

		while (k + 1 < times.length && (times[k + 1] ?? 0) <= u) k++

		const valueAt = (index: number): number => {
			const number = values[index] ?? Number.NaN

			if (!Number.isNaN(number)) return number

			const formula = compiled.valueFormulas?.[index]

			vars[VAR_VALUE] = 0

			return formula === undefined ? Number.NaN : formula(vars)
		}

		if (behavior.valueType === "str" || (compiled.strings?.[k] !== undefined && compiled.valueFormulas?.[k] === undefined)) {
			return compiled.strings?.[k]
		}

		const a = valueAt(k)
		const next = k + 1 < times.length ? k + 1 : k
		const span = (times[next] ?? 1) - (times[k] ?? 0)
		const f = next === k || span <= 0 || behavior.calcmode === "discrete" ? 0 : (u - (times[k] ?? 0)) / span
		const value = next === k ? a : a + (valueAt(next) - a) * Math.min(1, Math.max(0, f))
		const fmla = compiled.fmlas?.[k]

		if (fmla === undefined) return value

		vars[VAR_VALUE] = value

		return fmla(vars)
	}

	private assign(
		compiled: CompiledBehavior,
		layer: number,
		value: number | string | Rgba | undefined,
		begin: number,
		transform: Float64Array,
		visible: Int8Array,
		visibleAt: Float64Array,
		opacityAt: Float64Array,
		state: SampleState
	): void {
		if (value === undefined) return

		const g = this.graph
		const entry = compiled.entry
		const o = layer * 8

		switch (entry?.route) {
			case "visibility":
				if (begin >= (visibleAt[layer] ?? 0)) {
					visible[layer] = value === "hidden" || value === 0 ? 0 : 1
					visibleAt[layer] = begin
				}
				break
			case "opacity": {
				const number = typeof value === "number" ? value : Number(value)

				if (Number.isFinite(number) && begin >= (opacityAt[layer] ?? 0)) {
					transform[o + 7] = number
					opacityAt[layer] = begin
				}

				break
			}
			case "transform": {
				const number = typeof value === "number" ? value : Number(value)

				if (!Number.isFinite(number)) break

				switch (entry.channel) {
					case "x":
						transform[o] = (transform[o] ?? 0) + number * g.slidePx.w - (g.base[layer * 4] ?? 0)
						break
					case "y":
						transform[o + 1] = (transform[o + 1] ?? 0) + number * g.slidePx.h - (g.base[layer * 4 + 1] ?? 0)
						break
					case "w": {
						const base = g.base[layer * 4 + 2] ?? 0

						if (base > 0) transform[o + 2] = (transform[o + 2] ?? 1) * ((number * g.slidePx.w) / base)

						break
					}
					case "h": {
						const base = g.base[layer * 4 + 3] ?? 0

						if (base > 0) transform[o + 3] = (transform[o + 3] ?? 1) * ((number * g.slidePx.h) / base)

						break
					}
					case "rotation":
						transform[o + 4] = (transform[o + 4] ?? 0) + number
						break
					case "xshear":
						transform[o + 5] = (transform[o + 5] ?? 0) + number
						break
					case "yshear":
						transform[o + 6] = (transform[o + 6] ?? 0) + number
						break
					default:
						break
				}

				break
			}
			case "fontSize": {
				const number = typeof value === "number" ? value : Number(value)

				if (Number.isFinite(number)) state.fontSize = number

				break
			}
			case "dom":
				this.domValue(entry, state, value)
				break
			default:
				break
		}
	}

	private domValue(entry: AttributeEntry, state: SampleState, value: number | string): void {
		const dom = (state.dom ??= {})

		switch (entry.dom) {
			case "fill":
			case "stroke":
			case "textColor":
				if (typeof value === "number") dom[entry.dom] = value
				break
			case "fontWeight":
				dom["fontWeight"] = value === "bold" ? 700 : value === "normal" ? 400 : typeof value === "number" ? value : 400
				break
			case "fontStyle":
				dom["fontStyle"] = value === "italic" ? "italic" : "normal"
				break
			case "underline":
				dom["underline"] = value === 1 || (typeof value === "string" && value !== "none" && value !== "false")
				break
			default:
				break
		}
	}

	private color(compiled: CompiledBehavior, state: SampleState, color: Rgba): void {
		const dom = compiled.entry?.dom

		if (dom !== "fill" && dom !== "stroke" && dom !== "textColor") return

		;(state.dom ??= {})[dom] = color
	}

	// T(centre + d) · R · K · S · T(−centre), as [a, b, c, d, e, f].
	private matrix(layer: number, transform: Float64Array): number[] {
		const g = this.graph
		const o = layer * 8
		const cx = g.base[layer * 4] ?? 0
		const cy = g.base[layer * 4 + 1] ?? 0
		const dx = transform[o] ?? 0
		const dy = transform[o + 1] ?? 0
		const sx = transform[o + 2] ?? 1
		const sy = transform[o + 3] ?? 1
		const angle = ((transform[o + 4] ?? 0) * Math.PI) / 180
		const kx = Math.tan(((transform[o + 5] ?? 0) * Math.PI) / 180)
		const ky = Math.tan(((transform[o + 6] ?? 0) * Math.PI) / 180)
		const cos = Math.cos(angle)
		const sin = Math.sin(angle)
		// R · K, with K = [1 kx; ky 1], then · S.
		const m00 = (cos - sin * ky) * sx
		const m01 = (cos * kx - sin) * sy
		const m10 = (sin + cos * ky) * sx
		const m11 = (sin * kx + cos) * sy

		return [m00, m10, m01, m11, cx + dx - (m00 * cx + m01 * cy), cy + dy - (m10 * cx + m11 * cy)]
	}

	snapshot(): TimegraphSnapshot {
		const json = JSON.stringify(this.log)

		return { step: this.step, state: encodeUtf8(json) }
	}

	restore(snapshot: TimegraphSnapshot): void {
		let log: LoggedEvent[]

		try {
			log = JSON.parse(decodeUtf8(snapshot.state, 0, snapshot.state.length)) as LoggedEvent[]
		} catch {
			throw new PresentationError("malformed", "timegraph snapshot")
		}

		const now = this.now

		this.replay(log)
		this.now = Math.max(this.now, now)
	}

	nextActivation(): number | undefined {
		let best = Number.POSITIVE_INFINITY
		const now = this.now

		for (let n = 0; n < this.graph.count; n++) {
			const begin = this.begin[n] ?? Number.NaN
			const end = this.end[n] ?? Number.NaN

			if (begin > now && begin < best) best = begin
			if (Number.isFinite(end) && end > now && end < best) best = end
		}

		return Number.isFinite(best) ? best : undefined
	}
}

export function instantiate(graph: CompiledTimegraph): TimegraphInstance {
	if (!(graph instanceof Graph)) throw new PresentationError("failed", "a timegraph compiled elsewhere")

	return new Instance(graph)
}
