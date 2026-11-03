import { readBookmarkTarget } from "../../anim/media"
import { eventOf, nodeTypeOf, oneOf, parsePercent, parseTime, presetClassOf } from "../../anim/pptx"
import type {
	AnimTarget,
	Behavior,
	BehaviorCommon,
	Build,
	CommonTimeNode,
	TimeAnimateValue,
	TimeCondition,
	TimeNode,
	TimingBudgets,
	TimingTree
} from "../../anim/model"
import type { ColorModel, SourceRef } from "../../presentation/model"
import { tooDeep, tooLarge } from "../../presentation/refusal"
import { colorIn } from "./drawing"
import { G, type PartReader } from "./xml"

// A slide's p:timing (ECMA-376 Part 1 §19.5) into the model's TimingTree: the time node tree and the
// build list (p:bldLst). Every node's `ctn.src` is its time node element (p:par, p:anim…), so the emit keeps an
// unedited node, and the children and attributes the model does not hold (p:progress, tmFilter,
// extLst…), by span. Targets address shapes by cNvPr id. Read eagerly with the slide: a slide's tree is small next
// to its shapes, and the budgets bound a hostile one before it is held.

export interface TimingReadInput {
	readonly reader: PartReader
	readonly part: string
	readonly epoch: number
	readonly budgets: TimingBudgets
}

const BEHAVIORS: ReadonlySet<string> = new Set([
	"anim",
	"animClr",
	"animEffect",
	"animMotion",
	"animRot",
	"animScale",
	"cmd",
	"set",
	"audio",
	"video"
])

// The p:timing element of a slide root (bare, or the branch of an mc:AlternateContent we read), or -1.
export function timingElement(r: PartReader, root: number): number {
	for (let child = r.first(root); child >= 0; child = r.next(child)) {
		if (r.is(child, G.P, "timing")) return child

		if (r.is(child, G.MC, "AlternateContent")) {
			const branch = r.alternate(child)
			const inner = r.child(branch, G.P, "timing")

			if (inner >= 0) return inner
		}
	}

	return -1
}

// The slide's timing, undefined without a p:timing or a time node list. Throws tooLarge/tooDeep past the budgets.
export function readTiming(input: TimingReadInput, root: number): TimingTree | undefined {
	const r = input.reader
	const timing = timingElement(r, root)

	if (timing < 0) return undefined

	const reader = new TimingReader(input)
	const tnLst = r.child(timing, G.P, "tnLst")
	let tree: TimeNode | undefined

	for (let child = r.first(tnLst); child >= 0 && tree === undefined; child = r.next(child)) tree = reader.node(child, 0)

	const builds = reader.builds(r.child(timing, G.P, "bldLst"))

	if (tree === undefined && builds.length === 0) return undefined

	const branch = r.document.parent(timing)
	const container = branch < 0 ? -1 : r.document.parent(branch)
	const alternate = container >= 0 && container !== root && r.is(container, G.MC, "AlternateContent") ? container : -1

	return {
		root: tree ?? { kind: "par", ctn: { id: 1, nodeType: "tmRoot", stCondLst: [], endCondLst: [], children: [] } },
		builds,
		src: reader.src(timing),
		...(alternate < 0 ? {} : { alternate: reader.src(alternate) })
	}
}

class TimingReader {
	private readonly r: PartReader
	private readonly input: TimingReadInput
	private nodes = 0

	constructor(input: TimingReadInput) {
		this.r = input.reader
		this.input = input
	}

	src(node: number): SourceRef {
		return { format: "pptx", part: this.input.part, node, epoch: this.input.epoch }
	}

	// A time node element (the choice of CT_TimeNodeList), or undefined for an element that is none.
	node(element: number, depth: number): TimeNode | undefined {
		const r = this.r

		if (r.group(element) !== G.P) return undefined

		const local = r.local(element)

		if (local !== "par" && local !== "seq" && local !== "excl" && !BEHAVIORS.has(local)) return undefined

		const budgets = this.input.budgets

		if (depth >= budgets.depth) tooDeep("time nodes", budgets.depth)
		if (++this.nodes > budgets.nodesPerSlide) tooLarge("time nodes on a slide", budgets.nodesPerSlide)

		if (local === "par" || local === "seq" || local === "excl") {
			const ctn = this.ctn(r.child(element, G.P, "cTn"), element, depth)

			if (local === "seq") {
				const nextAc = oneOf(r.attr(element, "nextAc"), ["none", "seek"] as const)
				const prevAc = oneOf(r.attr(element, "prevAc"), ["none", "skipTimed"] as const)
				const concurrent = r.bool(element, "concurrent")
				const prev = this.conditions(r.child(element, G.P, "prevCondLst"))
				const next = this.conditions(r.child(element, G.P, "nextCondLst"))

				if (nextAc !== undefined) ctn.nextAc = nextAc
				if (prevAc !== undefined) ctn.prevAc = prevAc
				if (concurrent !== undefined) ctn.concurrent = concurrent
				if (prev !== undefined) ctn.prevCondLst = prev
				if (next !== undefined) ctn.nextCondLst = next
			}

			return { kind: local, ctn }
		}

		if (local === "audio" || local === "video") {
			const media = r.child(element, G.P, "cMediaNode")
			const ctn = this.ctn(r.child(media, G.P, "cTn"), element, depth)
			const vol = parsePercent(r.attr(media, "vol"))
			const mute = r.bool(media, "mute")
			const numSld = r.int(media, "numSld")
			const showWhenStopped = r.bool(media, "showWhenStopped")
			const special = local === "audio" ? r.bool(element, "isNarration") : r.bool(element, "fullScrn")
			const behavior: Behavior = {
				type: local,
				target: this.target(r.child(media, G.P, "tgtEl")),
				...(vol === undefined ? {} : { vol }),
				...(mute === undefined ? {} : { mute }),
				...(numSld === undefined ? {} : { numSld }),
				...(showWhenStopped === undefined ? {} : { showWhenStopped }),
				...(special === undefined ? {} : local === "audio" ? { isNarration: special } : { fullScrn: special })
			}

			return { kind: "behavior", behavior, ctn }
		}

		const cBhvr = r.child(element, G.P, "cBhvr")
		const ctn = this.ctn(r.child(cBhvr, G.P, "cTn"), element, depth)

		return { kind: "behavior", behavior: this.behavior(element, local, this.common(cBhvr)), ctn }
	}

	private ctn(node: number, element: number, depth: number): CommonTimeNode {
		const r = this.r
		const ctn: CommonTimeNode = {
			id: r.int(node, "id") ?? 0,
			stCondLst: this.conditions(r.child(node, G.P, "stCondLst")) ?? [],
			endCondLst: this.conditions(r.child(node, G.P, "endCondLst")) ?? [],
			children: [],
			src: this.src(element)
		}
		const set = <K extends keyof CommonTimeNode>(key: K, value: CommonTimeNode[K] | undefined): void => {
			if (value !== undefined) ctn[key] = value
		}

		set("presetID", r.int(node, "presetID"))
		set("presetClass", presetClassOf(r.attr(node, "presetClass")))
		set("presetSubtype", r.int(node, "presetSubtype"))
		set("nodeType", nodeTypeOf(r.attr(node, "nodeType")))
		set("grpId", r.int(node, "grpId"))
		set("fill", oneOf(r.attr(node, "fill"), ["remove", "freeze", "hold", "transition"] as const))
		set("restart", oneOf(r.attr(node, "restart"), ["always", "whenNotActive", "never"] as const))
		set("dur", parseTime(r.attr(node, "dur")))
		set("repeatCount", parseTime(r.attr(node, "repeatCount")))
		set("repeatDur", parseTime(r.attr(node, "repeatDur")))
		set("spd", parsePercent(r.attr(node, "spd")))
		set("accel", parsePercent(r.attr(node, "accel")))
		set("decel", parsePercent(r.attr(node, "decel")))
		set("autoRev", r.bool(node, "autoRev"))
		set("syncBehavior", oneOf(r.attr(node, "syncBehavior"), ["canSlip", "locked"] as const))
		set("masterRel", oneOf(r.attr(node, "masterRel"), ["sameClick", "lastClick", "nextClick"] as const))

		for (const key of ["evtFilter", "tmFilter", "display", "nodePh", "afterEffect", "bldLvl"] as const) set(key, r.attr(node, key))

		const endSync = r.child(node, G.P, "endSync")

		if (endSync >= 0) set("endSync", this.condition(endSync))

		const iterate = r.child(node, G.P, "iterate")

		if (iterate >= 0) {
			const abs = r.child(iterate, G.P, "tmAbs")
			const pct = r.child(iterate, G.P, "tmPct")
			const ms = parseTime(r.attr(abs, "val"))

			ctn.iterate = {
				type: oneOf(r.attr(iterate, "type"), ["el", "wd", "lt"] as const) ?? "el",
				interval: pct >= 0 ? { pct: parsePercent(r.attr(pct, "val")) ?? 0 } : { ms: typeof ms === "number" ? ms : 0 },
				backwards: r.bool(iterate, "backwards") ?? false
			}
		}

		const list = r.child(node, G.P, "childTnLst")

		for (let child = r.first(list); child >= 0; child = r.next(child)) {
			const time = this.node(child, depth + 1)

			if (time !== undefined) ctn.children.push(time)
		}

		const subs = r.child(node, G.P, "subTnLst")

		for (let child = r.first(subs); child >= 0; child = r.next(child)) {
			const time = this.node(child, depth + 1)

			if (time !== undefined) (ctn.subTnLst ??= []).push(time)
		}

		return ctn
	}

	private conditions(list: number): TimeCondition[] | undefined {
		if (list < 0) return undefined

		return this.r.children(list, G.P, "cond").map(cond => this.condition(cond))
	}

	private condition(node: number): TimeCondition {
		const r = this.r
		const evt = eventOf(r.attr(node, "evt"))
		const tgtEl = r.child(node, G.P, "tgtEl")
		const tn = r.int(r.child(node, G.P, "tn"), "val")
		const rtn = oneOf(r.attr(r.child(node, G.P, "rtn"), "val"), ["first", "last", "all"] as const)
		// A media bookmark (MS-PPTX p14:bmkTgt): the medium's shape and the bookmark's name.
		const bookmark = readBookmarkTarget(r, tgtEl)

		if (bookmark !== undefined)
			return {
				...(evt === undefined ? {} : { evt }),
				delay: parseTime(r.attr(node, "delay")) ?? 0,
				tgtEl: { kind: "shape", shape: bookmark.shape },
				bookmark: bookmark.bookmark
			}

		return {
			...(evt === undefined ? {} : { evt }),
			delay: parseTime(r.attr(node, "delay")) ?? 0,
			...(tgtEl < 0 ? {} : { tgtEl: this.target(tgtEl) }),
			...(tn === undefined ? {} : { tn }),
			...(rtn === undefined ? {} : { rtn })
		}
	}

	target(node: number): AnimTarget {
		const r = this.r

		for (let child = r.first(node); child >= 0; child = r.next(child)) {
			if (r.group(child) !== G.P) continue

			switch (r.local(child)) {
				case "sldTgt":
					return { kind: "slide" }
				case "sndTgt": {
					const embed = r.rel(child, "embed")
					const name = r.attr(child, "name")

					return { kind: "sound", ...(embed === undefined ? {} : { embed }), ...(name === undefined ? {} : { name }) }
				}
				case "inkTgt":
					return { kind: "ink", shape: r.int(child, "spid") ?? 0 }
				case "spTgt":
					return this.shapeTarget(child)
			}
		}

		return { kind: "slide" }
	}

	private shapeTarget(node: number): AnimTarget {
		const r = this.r
		const shape = r.int(node, "spid") ?? 0

		for (let child = r.first(node); child >= 0; child = r.next(child)) {
			if (r.group(child) !== G.P) continue

			switch (r.local(child)) {
				case "bg":
					return { kind: "bg", shape }
				case "subSp":
					return { kind: "subShape", shape, subShape: r.attr(child, "spid") ?? "" }
				case "txEl": {
					const range = r.first(child)
					const unit = r.is(range, G.P, "charRg") ? "char" : "para"

					return { kind: "text", shape, unit, start: r.int(range, "st") ?? 0, end: r.int(range, "end") ?? 0 }
				}
				case "graphicEl": {
					const dgm = r.child(child, G.A, "dgm")
					const chart = r.child(child, G.A, "chart")
					const bldStep = r.attr(dgm >= 0 ? dgm : chart, "bldStep")

					return dgm >= 0
						? {
								kind: "graphic",
								shape,
								part: "dgm",
								id: r.attr(dgm, "id") ?? "",
								...(bldStep === undefined ? {} : { bldStep })
							}
						: {
								kind: "graphic",
								shape,
								part: "chart",
								id: `${r.attr(chart, "seriesIdx") ?? "-1"},${r.attr(chart, "categoryIdx") ?? "-1"}`,
								...(bldStep === undefined ? {} : { bldStep })
							}
				}
			}
		}

		return { kind: "shape", shape }
	}

	private common(cBhvr: number): BehaviorCommon {
		const r = this.r
		const attrNames: string[] = []

		for (const name of r.children(r.child(cBhvr, G.P, "attrNameLst"), G.P, "attrName")) {
			attrNames.push(r.document.textContent(name).trim())
		}

		const optional = <T extends string>(local: string, values: readonly T[]): T | undefined => oneOf(r.attr(cBhvr, local), values)
		const additive = optional("additive", ["base", "sum", "repl", "mult", "none"] as const)
		const accumulate = optional("accumulate", ["none", "always"] as const)
		const override = optional("override", ["normal", "childStyle"] as const)
		const xfrmType = optional("xfrmType", ["pt", "img"] as const)
		const text = (local: "from" | "to" | "by" | "rctx"): { [key: string]: string } => {
			const value = r.attr(cBhvr, local)

			return value === undefined ? {} : { [local]: value }
		}

		return {
			target: this.target(r.child(cBhvr, G.P, "tgtEl")),
			attrNames,
			...(additive === undefined ? {} : { additive }),
			...(accumulate === undefined ? {} : { accumulate }),
			...(override === undefined ? {} : { override }),
			...(xfrmType === undefined ? {} : { xfrmType }),
			...text("from"),
			...text("to"),
			...text("by"),
			...text("rctx")
		}
	}

	private behavior(element: number, local: string, common: BehaviorCommon): Behavior {
		const r = this.r

		switch (local) {
			case "anim": {
				const calcmode = oneOf(r.attr(element, "calcmode"), ["discrete", "lin", "fmla"] as const)
				const valueType = oneOf(r.attr(element, "valueType"), ["str", "num", "clr"] as const)
				const tavLst: TimeAnimateValue[] = []

				for (const tav of r.children(r.child(element, G.P, "tavLst"), G.P, "tav")) {
					const fmla = r.attr(tav, "fmla")
					const val = this.value(r.child(tav, G.P, "val"))

					tavLst.push({
						tm: parseTime(r.attr(tav, "tm")) ?? 0,
						...(fmla === undefined ? {} : { fmla }),
						...(val === undefined ? {} : { val })
					})
				}

				// p:anim's own by/from/to are not modelled: they stay on its start tag.
				return {
					type: "anim",
					common,
					tavLst,
					...(calcmode === undefined ? {} : { calcmode }),
					...(valueType === undefined ? {} : { valueType })
				}
			}
			case "animClr": {
				const dir = oneOf(r.attr(element, "dir"), ["cw", "ccw"] as const)
				const by = r.child(element, G.P, "by")
				const hsl = r.child(by, G.P, "hsl")
				const byColor =
					hsl >= 0
						? { h: r.number(hsl, "h") ?? 0, s: parsePercent(r.attr(hsl, "s")) ?? 0, l: parsePercent(r.attr(hsl, "l")) ?? 0 }
						: colorIn(r, by)
				const from = colorIn(r, r.child(element, G.P, "from"))
				const to = colorIn(r, r.child(element, G.P, "to"))

				return {
					type: "animClr",
					common,
					clrSpc: r.attr(element, "clrSpc") === "hsl" ? "hsl" : "rgb",
					...(dir === undefined ? {} : { dir }),
					...(byColor === undefined ? {} : { by: byColor }),
					...(from === undefined ? {} : { from }),
					...(to === undefined ? {} : { to })
				}
			}
			case "animEffect": {
				const transition = oneOf(r.attr(element, "transition"), ["in", "out", "none"] as const)
				const filter = r.attr(element, "filter")
				const prLst = r.attr(element, "prLst")

				return {
					type: "animEffect",
					common,
					...(transition === undefined ? {} : { transition }),
					...(filter === undefined ? {} : { filter }),
					...(prLst === undefined ? {} : { prLst })
				}
			}
			case "animMotion": {
				const path = r.attr(element, "path")
				const origin = oneOf(r.attr(element, "origin"), ["parent", "layout"] as const)
				const pathEditMode = oneOf(r.attr(element, "pathEditMode"), ["relative", "fixed"] as const)
				const rAng = r.number(element, "rAng")
				const ptsTypes = r.attr(element, "ptsTypes")
				const center = r.child(element, G.P, "rCtr")

				return {
					type: "animMotion",
					common,
					...(path === undefined ? {} : { path }),
					...(origin === undefined ? {} : { origin }),
					...(pathEditMode === undefined ? {} : { pathEditMode }),
					...(rAng === undefined ? {} : { rAng }),
					...(center < 0
						? {}
						: { rCtr: { x: parsePercent(r.attr(center, "x")) ?? 0, y: parsePercent(r.attr(center, "y")) ?? 0 } }),
					...(ptsTypes === undefined ? {} : { ptsTypes })
				}
			}
			case "animRot": {
				const by = r.number(element, "by")
				const from = r.number(element, "from")
				const to = r.number(element, "to")

				return {
					type: "animRot",
					common,
					...(by === undefined ? {} : { by }),
					...(from === undefined ? {} : { from }),
					...(to === undefined ? {} : { to })
				}
			}
			case "animScale": {
				const point = (local: string): { x: number; y: number } | undefined => {
					const node = r.child(element, G.P, local)

					return node < 0 ? undefined : { x: parsePercent(r.attr(node, "x")) ?? 0, y: parsePercent(r.attr(node, "y")) ?? 0 }
				}
				const zoomContents = r.bool(element, "zoomContents")
				const by = point("by")
				const from = point("from")
				const to = point("to")

				return {
					type: "animScale",
					common,
					...(zoomContents === undefined ? {} : { zoomContents }),
					...(by === undefined ? {} : { by }),
					...(from === undefined ? {} : { from }),
					...(to === undefined ? {} : { to })
				}
			}
			case "cmd":
				return {
					type: "cmd",
					common,
					cmdType: oneOf(r.attr(element, "type"), ["evt", "call", "verb"] as const) ?? "call",
					cmd: r.attr(element, "cmd") ?? ""
				}
			default: {
				const to = this.value(r.child(element, G.P, "to"))

				return { type: "set", common, ...(to === undefined ? {} : { to }) }
			}
		}
	}

	// CT_TLAnimVariant: one of boolVal, intVal, fltVal, strVal, clrVal.
	private value(node: number): string | number | boolean | ColorModel | undefined {
		const r = this.r

		for (let child = r.first(node); child >= 0; child = r.next(child)) {
			if (r.group(child) !== G.P) continue

			switch (r.local(child)) {
				case "boolVal":
					return r.bool(child, "val") ?? false
				case "intVal":
					return r.int(child, "val") ?? 0
				case "fltVal":
					return r.number(child, "val") ?? 0
				case "strVal":
					return r.attr(child, "val") ?? ""
				case "clrVal":
					return colorIn(r, child)
			}
		}

		return undefined
	}

	builds(list: number): Build[] {
		const r = this.r
		const out: Build[] = []

		for (let child = r.first(list); child >= 0; child = r.next(child)) {
			if (r.group(child) !== G.P) continue

			const shape = r.int(child, "spid") ?? 0
			const grpId = r.int(child, "grpId") ?? 0
			const bld = r.attr(child, "bld")
			const src = this.src(child)

			switch (r.local(child)) {
				case "bldP": {
					const build = oneOf(r.attr(child, "build"), ["whole", "p", "cust", "allAtOnce"] as const)
					const bldLvl = r.int(child, "bldLvl")
					const animBg = r.bool(child, "animBg")
					const rev = r.bool(child, "rev")
					const autoUpdateAnimBg = r.bool(child, "autoUpdateAnimBg")

					out.push({
						kind: "bldP",
						src,
						shape,
						grpId,
						...(build === undefined ? {} : { build }),
						...(bldLvl === undefined ? {} : { bldLvl }),
						...(animBg === undefined ? {} : { animBg }),
						...(rev === undefined ? {} : { rev }),
						...(autoUpdateAnimBg === undefined ? {} : { autoUpdateAnimBg })
					})

					break
				}
				case "bldDgm":
					out.push({ kind: "bldDgm", src, shape, grpId, ...(bld === undefined ? {} : { bld }) })
					break
				case "bldOleChart": {
					const animBg = r.bool(child, "animBg")

					out.push({
						kind: "bldOleChart",
						src,
						shape,
						grpId,
						...(bld === undefined ? {} : { bld }),
						...(animBg === undefined ? {} : { animBg })
					})

					break
				}
				case "bldGraphic": {
					const sub = r.first(child)
					const whole = r.is(sub, G.P, "bldAsOne")
					const kind = r.attr(r.child(sub, G.P, "bldChart"), "bld") ?? r.attr(r.child(sub, G.P, "bldDgm"), "bld")

					out.push({ kind: "bldGraphic", src, shape, grpId, whole, ...(kind === undefined ? {} : { bld: kind }) })

					break
				}
			}
		}

		return out
	}
}
