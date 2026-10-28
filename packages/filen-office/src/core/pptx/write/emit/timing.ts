import { isMediaBehavior, type MediaBehavior } from "../../../anim/attributes"
import { heldMarkup, inScope, rootScope } from "../../../anim/prune"
import { CTN_MODELED, ctnAttributes, formatInteger, formatTime } from "../../../anim/pptx"
import type {
	AnimTarget,
	Behavior,
	BehaviorCommon,
	Build,
	CommonTimeNode,
	TimeAnimateValue,
	TimeCondition,
	TimeNode,
	TimingTree
} from "../../../anim/model"
import { colorXml } from "../../../presentation/render/markup"
import type { ColorModel, ShapeNode } from "../../../presentation/model"
import { escapeText } from "../../../xml/index"
import { G } from "../../read/xml"
import type { EmitPiece, EmitResult, PptxEmitFamily } from "../types"
import {
	Pieces,
	attr,
	mergeChildren,
	readerOf,
	sameModel,
	sourceNode,
	splicing,
	unmodeledAttributes,
	type EmitContext,
	type Slot
} from "./shape"

// The timing family's PresentationML: a slide's p:timing (ECMA-376 Part 1 §19.5) out of its TimingTree. A node the
// model holds as it was read is its source span; an edited node is written again with the attributes and children the
// model does not hold (tmFilter, p:progress, extLst…) copied from its source element, so only what
// changed is rewritten. The result is the whole p:timing element, or no pieces when the slide has no timing any more;
// the splice writer puts it in place of the source element (or at its schema place, after p:transition).

const ELEMENT_MODELED: Readonly<Record<string, ReadonlySet<string>>> = {
	par: new Set(),
	excl: new Set(),
	seq: new Set(["concurrent", "prevAc", "nextAc"]),
	anim: new Set(["calcmode", "valueType"]),
	animClr: new Set(["clrSpc", "dir"]),
	animEffect: new Set(["transition", "filter", "prLst"]),
	animMotion: new Set(["origin", "path", "pathEditMode", "rAng", "ptsTypes"]),
	animRot: new Set(["by", "from", "to"]),
	animScale: new Set(["zoomContents"]),
	cmd: new Set(["type", "cmd"]),
	set: new Set(),
	audio: new Set(["isNarration"]),
	video: new Set(["fullScrn"])
}

const BHVR_MODELED: ReadonlySet<string> = new Set(["additive", "accumulate", "xfrmType", "from", "to", "by", "rctx", "override"])
const MEDIA_MODELED: ReadonlySet<string> = new Set(["vol", "mute", "numSld", "showWhenStopped"])

function p(local: string): Slot["match"] {
	return (name, group) => group === G.P && name === local
}

function decimal(value: number): string {
	return Number.isInteger(value) ? String(value) : String(Math.round(value * 1e6) / 1e6)
}

function optionalDecimal(value: number | undefined): string | undefined {
	return value === undefined ? undefined : decimal(value)
}

function index(tree: TimingTree | undefined): Map<number, TimeNode> {
	const out = new Map<number, TimeNode>()
	const visit = (node: TimeNode): void => {
		if (node.ctn.src?.format === "pptx") out.set(node.ctn.src.node, node)

		for (const child of node.ctn.children) visit(child)
		for (const child of node.ctn.subTnLst ?? []) visit(child)
	}

	if (tree !== undefined) visit(tree.root)

	return out
}

class TimingWriter {
	private readonly context: EmitContext
	private readonly pristine: ReadonlyMap<number, TimeNode>
	// Without a pristine read (the fresh writer over its source part), a node that names a source element is that element.
	private readonly trusted: boolean

	// Shapes whose frame is a chart (for graphic builds).
	private readonly charts: ReadonlySet<number>

	constructor(context: EmitContext, pristine: TimingTree | undefined, shapes: readonly ShapeNode[]) {
		this.context = context

		const charts = new Set<number>()
		const visit = (list: readonly ShapeNode[]): void => {
			for (const shape of list) {
				if (shape.frame?.kind === "chart") charts.add(shape.id)
				if (shape.children !== undefined) visit(shape.children)
			}
		}

		visit(shapes)
		this.charts = charts
		this.pristine = index(pristine)
		this.trusted = !splicing(context)
	}

	private same(a: unknown, b: unknown): boolean {
		return this.trusted || sameModel(a, b)
	}

	timing(tree: TimingTree, pristine: TimingTree | undefined): readonly EmitPiece[] {
		const context = this.context
		const source = sourceNode(context, tree.src)
		const out = new Pieces()

		if (source >= 0 && this.same(tree, pristine)) return out.hole(source).out

		out.text("<p:timing>")
		mergeChildren(
			context,
			source,
			[
				{ match: p("tnLst"), write: child => this.tnLst(tree, child) },
				{
					match: p("bldLst"),
					write: child =>
						child >= 0 && this.same(tree.builds, pristine?.builds)
							? "keep"
							: tree.builds.length === 0
								? ""
								: new Pieces()
										.text("<p:bldLst>")
										.append(this.builds(tree.builds, pristine?.builds ?? []))
										.text("</p:bldLst>").out
				}
			],
			out
		)

		return out.text("</p:timing>").out
	}

	// Each build entry on its own: one as it was read is its source span, one held by an inverse its held bytes, an
	// edited or new one written from the model with what the model does not hold (uiExpand, advAuto, p:tmplLst…)
	// copied from its source element.
	private builds(builds: readonly Build[], pristine: readonly Build[]): readonly EmitPiece[] {
		const context = this.context
		const before = new Map<number, Build>()
		const out = new Pieces()

		for (const build of pristine) {
			const node = sourceNode(context, build.src)

			if (node >= 0) before.set(node, build)
		}

		for (const build of builds) {
			const source = sourceNode(context, build.src)
			const prior = source >= 0 ? before.get(source) : undefined

			if (source >= 0 && (this.trusted || (prior !== undefined && sameModel(build, prior)))) {
				out.hole(source)

				continue
			}

			if (source < 0 && build.raw !== undefined && build.raw.length > 0) {
				out.append([context.document === undefined ? build.raw : inScope(build.raw, rootScope(context.document))])

				continue
			}

			const r = readerOf(context)
			const base = source >= 0 && r !== undefined && r.group(source) === G.P && r.local(source) === build.kind ? source : -1

			out.append(buildPieces(context, build, this.charts, base))
		}

		return out.out
	}

	private tnLst(tree: TimingTree, source: number): readonly EmitPiece[] {
		const out = new Pieces()
		const r = readerOf(this.context)
		let written = false

		out.text("<p:tnLst>")

		// The one root time node; anything else the source list holds stays where it was.
		if (source >= 0 && r !== undefined) {
			for (let child = r.first(source); child >= 0; child = r.next(child)) {
				if (!written && r.group(child) === G.P && ELEMENT_MODELED[r.local(child)] !== undefined) {
					out.append(this.node(tree.root))
					written = true
				} else {
					out.hole(child)
				}
			}
		}

		if (!written) out.append(this.node(tree.root))

		return out.text("</p:tnLst>").out
	}

	private unmodeled(source: number, modeled: ReadonlySet<string>): string {
		return source < 0 ? "" : unmodeledAttributes(this.context, source, modeled)
	}

	node(node: TimeNode): readonly EmitPiece[] {
		const context = this.context
		const source = sourceNode(context, node.ctn.src)
		const before = source >= 0 ? this.pristine.get(source) : undefined
		const out = new Pieces()
		const held = source < 0 ? heldMarkup(node.ctn) : undefined

		// A node whose source a save took out, put back by an undo: written as its source was.
		if (held !== undefined) return [context.document === undefined ? held : inScope(held, rootScope(context.document))]

		if (source >= 0 && (this.trusted || (before !== undefined && sameModel(node, before)))) return out.hole(source).out

		const r = readerOf(context)
		const local = node.kind === "behavior" ? node.behavior.type : node.kind
		const base = source >= 0 && r !== undefined && r.group(source) === G.P && r.local(source) === local ? source : -1
		const slots: Slot[] = []

		out.text(`<p:${local}${elementAttributes(node)}${this.unmodeled(base, ELEMENT_MODELED[local] ?? new Set())}>`)

		if (node.kind === "behavior") {
			const behavior = node.behavior
			const prior = before?.kind === "behavior" && before.behavior.type === behavior.type ? before.behavior : undefined

			if (isMediaBehavior(behavior)) {
				slots.push({ match: p("cMediaNode"), write: child => this.mediaNode(node.ctn, behavior, child, before?.ctn, prior) })
			} else {
				const priorCommon = prior === undefined || isMediaBehavior(prior) ? undefined : prior.common
				const common = behavior.common

				slots.push(
					{ match: p("cBhvr"), write: child => this.cBhvr(node.ctn, common, child, before?.ctn, priorCommon) },
					...this.behaviorSlots(behavior, prior)
				)
			}
		} else {
			slots.push({ match: p("cTn"), write: child => this.ctn(node.ctn, child, before?.ctn) })

			if (node.kind === "seq") {
				slots.push(
					{
						match: p("prevCondLst"),
						write: child => this.conditionList("prevCondLst", node.ctn.prevCondLst, child, before?.ctn.prevCondLst)
					},
					{
						match: p("nextCondLst"),
						write: child => this.conditionList("nextCondLst", node.ctn.nextCondLst, child, before?.ctn.nextCondLst)
					}
				)
			}
		}

		mergeChildren(context, base, slots, out)

		return out.text(`</p:${local}>`).out
	}

	private ctn(ctn: CommonTimeNode, source: number, before: CommonTimeNode | undefined): readonly EmitPiece[] {
		const out = new Pieces()
		const attributes = ctnAttributes(ctn)
			.map(([name, value]) => attr(name, value))
			.join("")

		const start = `<p:cTn${attributes}${this.unmodeled(source, CTN_MODELED)}`

		out.text(`${start}>`)
		mergeChildren(
			this.context,
			source,
			[
				{ match: p("stCondLst"), write: child => this.conditionList("stCondLst", ctn.stCondLst, child, before?.stCondLst) },
				{ match: p("endCondLst"), write: child => this.conditionList("endCondLst", ctn.endCondLst, child, before?.endCondLst) },
				{
					match: p("endSync"),
					write: child =>
						child >= 0 && this.same(ctn.endSync, before?.endSync)
							? "keep"
							: ctn.endSync === undefined
								? ""
								: conditionXml("endSync", ctn.endSync)
				},
				{ match: p("iterate"), write: child => (child >= 0 && this.same(ctn.iterate, before?.iterate) ? "keep" : iterateXml(ctn)) },
				{ match: p("childTnLst"), write: child => this.children(ctn.children, child) },
				{
					match: p("subTnLst"),
					write: child =>
						child >= 0 && this.same(ctn.subTnLst, before?.subTnLst)
							? "keep"
							: this.children(ctn.subTnLst ?? [], child, "subTnLst")
				}
			],
			out
		)

		// Without children the element closes itself, as PowerPoint writes it.
		if (out.out.length === 1 && out.out[0] === `${start}>`) return [`${start}/>`]

		return out.text("</p:cTn>").out
	}

	private children(children: readonly TimeNode[], source: number, local = "childTnLst"): readonly EmitPiece[] | string {
		const r = readerOf(this.context)
		const out = new Pieces()
		// Elements of the source list that are no time node (an mc:AlternateContent we did not read) stay, after ours.
		const kept: number[] = []

		if (source >= 0 && r !== undefined) {
			for (let child = r.first(source); child >= 0; child = r.next(child)) {
				if (r.group(child) !== G.P || ELEMENT_MODELED[r.local(child)] === undefined) kept.push(child)
			}
		}

		if (children.length === 0 && kept.length === 0) return ""

		out.text(`<p:${local}>`)

		for (const child of children) out.append(this.node(child))
		for (const child of kept) out.hole(child)

		return out.text(`</p:${local}>`).out
	}

	private conditionList(
		local: string,
		conditions: readonly TimeCondition[] | undefined,
		source: number,
		before: readonly TimeCondition[] | undefined
	): string {
		if (source >= 0 && this.same(conditions, before)) return "keep"
		if (conditions === undefined || conditions.length === 0) return ""

		return `<p:${local}>${conditions.map(condition => conditionXml("cond", condition)).join("")}</p:${local}>`
	}

	private cBhvr(
		ctn: CommonTimeNode,
		common: BehaviorCommon,
		source: number,
		before: CommonTimeNode | undefined,
		prior: BehaviorCommon | undefined
	): readonly EmitPiece[] {
		const out = new Pieces()

		out.text(
			`<p:cBhvr${attr("additive", common.additive)}${attr("accumulate", common.accumulate)}${attr("xfrmType", common.xfrmType)}${attr("from", common.from)}${attr("to", common.to)}${attr("by", common.by)}${attr("rctx", common.rctx)}${attr("override", common.override)}${this.unmodeled(source, BHVR_MODELED)}>`
		)
		mergeChildren(
			this.context,
			source,
			[
				{ match: p("cTn"), write: child => this.ctn(ctn, child, before) },
				{
					match: p("tgtEl"),
					write: child => (child >= 0 && this.same(common.target, prior?.target) ? "keep" : targetXml(common.target))
				},
				{
					match: p("attrNameLst"),
					write: child =>
						child >= 0 && this.same(common.attrNames, prior?.attrNames)
							? "keep"
							: common.attrNames.length === 0
								? ""
								: `<p:attrNameLst>${common.attrNames.map(name => `<p:attrName>${escapeText(name)}</p:attrName>`).join("")}</p:attrNameLst>`
				}
			],
			out
		)

		return out.text("</p:cBhvr>").out
	}

	private mediaNode(
		ctn: CommonTimeNode,
		media: MediaBehavior,
		source: number,
		before: CommonTimeNode | undefined,
		prior: Behavior | undefined
	): readonly EmitPiece[] {
		const out = new Pieces()
		const priorTarget = prior !== undefined && isMediaBehavior(prior) ? prior.target : undefined

		out.text(
			`<p:cMediaNode${attr("vol", media.vol)}${attr("mute", media.mute)}${attr("numSld", media.numSld)}${attr("showWhenStopped", media.showWhenStopped)}${this.unmodeled(source, MEDIA_MODELED)}>`
		)
		mergeChildren(
			this.context,
			source,
			[
				{ match: p("cTn"), write: child => this.ctn(ctn, child, before) },
				{
					match: p("tgtEl"),
					write: child => (child >= 0 && this.same(media.target, priorTarget) ? "keep" : targetXml(media.target))
				}
			],
			out
		)

		return out.text("</p:cMediaNode>").out
	}

	private behaviorSlots(behavior: Behavior, prior: Behavior | undefined): Slot[] {
		const own = <T>(local: string, value: T, priorValue: T | undefined, write: () => string): Slot => ({
			match: p(local),
			write: child => (child >= 0 && (this.trusted || (prior !== undefined && sameModel(value, priorValue))) ? "keep" : write())
		})

		switch (behavior.type) {
			case "anim": {
				const before = prior?.type === "anim" ? prior.tavLst : undefined

				return [
					own("tavLst", behavior.tavLst, before, () =>
						behavior.tavLst.length === 0 ? "" : `<p:tavLst>${behavior.tavLst.map(tavXml).join("")}</p:tavLst>`
					)
				]
			}
			case "animClr": {
				const before = prior?.type === "animClr" ? prior : undefined
				const by = behavior.by

				return [
					own("by", by, before?.by, () =>
						by === undefined
							? ""
							: "kind" in by
								? `<p:by>${colorXml(by)}</p:by>`
								: `<p:by><p:hsl${attr("h", by.h)}${attr("s", by.s)}${attr("l", by.l)}/></p:by>`
					),
					own("from", behavior.from, before?.from, () =>
						behavior.from === undefined ? "" : `<p:from>${colorXml(behavior.from)}</p:from>`
					),
					own("to", behavior.to, before?.to, () => (behavior.to === undefined ? "" : `<p:to>${colorXml(behavior.to)}</p:to>`))
				]
			}
			case "animMotion": {
				const before = prior?.type === "animMotion" ? prior.rCtr : undefined
				const center = behavior.rCtr

				return [
					own("rCtr", center, before, () => (center === undefined ? "" : `<p:rCtr${attr("x", center.x)}${attr("y", center.y)}/>`))
				]
			}
			case "animScale": {
				const before = prior?.type === "animScale" ? prior : undefined
				const point = (local: "by" | "from" | "to"): Slot => {
					const value = behavior[local]

					return own(local, value, before?.[local], () =>
						value === undefined ? "" : `<p:${local}${attr("x", value.x)}${attr("y", value.y)}/>`
					)
				}

				return [point("by"), point("from"), point("to")]
			}
			case "set": {
				const before = prior?.type === "set" ? prior.to : undefined
				const to = behavior.to

				return [own("to", to, before, () => (to === undefined ? "" : `<p:to>${valueXml(to)}</p:to>`))]
			}
			default:
				return []
		}
	}
}

function elementAttributes(node: TimeNode): string {
	if (node.kind === "seq") {
		const ctn = node.ctn

		return `${attr("concurrent", ctn.concurrent)}${attr("prevAc", ctn.prevAc)}${attr("nextAc", ctn.nextAc)}`
	}

	if (node.kind !== "behavior") return ""

	const b = node.behavior

	switch (b.type) {
		case "anim":
			return `${attr("calcmode", b.calcmode)}${attr("valueType", b.valueType)}`
		case "animClr":
			return `${attr("clrSpc", b.clrSpc)}${attr("dir", b.dir)}`
		case "animEffect":
			return `${attr("transition", b.transition)}${attr("filter", b.filter)}${attr("prLst", b.prLst)}`
		case "animMotion":
			return `${attr("origin", b.origin)}${attr("path", b.path)}${attr("pathEditMode", b.pathEditMode)}${attr("rAng", optionalDecimal(b.rAng))}${attr("ptsTypes", b.ptsTypes)}`
		case "animRot":
			return `${attr("by", optionalDecimal(b.by))}${attr("from", optionalDecimal(b.from))}${attr("to", optionalDecimal(b.to))}`
		case "animScale":
			return attr("zoomContents", b.zoomContents)
		case "cmd":
			return `${attr("type", b.cmdType)}${attr("cmd", b.cmd)}`
		case "audio":
			return attr("isNarration", b.isNarration)
		case "video":
			return attr("fullScrn", b.fullScrn)
		default:
			return ""
	}
}

function iterateXml(ctn: CommonTimeNode): string {
	const iterate = ctn.iterate

	if (iterate === undefined) return ""

	const interval =
		"pct" in iterate.interval
			? `<p:tmPct${attr("val", iterate.interval.pct)}/>`
			: `<p:tmAbs${attr("val", formatTime(iterate.interval.ms))}/>`

	return `<p:iterate${attr("type", iterate.type)}${iterate.backwards ? attr("backwards", true) : ""}>${interval}</p:iterate>`
}

function conditionXml(local: string, condition: TimeCondition): string {
	const inner =
		condition.tgtEl !== undefined
			? targetXml(condition.tgtEl)
			: condition.tn !== undefined
				? `<p:tn${attr("val", condition.tn)}/>`
				: condition.rtn !== undefined
					? `<p:rtn${attr("val", condition.rtn)}/>`
					: ""

	return `<p:${local}${attr("evt", condition.evt)}${attr("delay", formatTime(condition.delay))}${inner === "" ? "/>" : `>${inner}</p:${local}>`}`
}

function tavXml(tav: TimeAnimateValue): string {
	const head = `<p:tav${attr("tm", tav.tm === "indefinite" ? "indefinite" : formatInteger(tav.tm))}${attr("fmla", tav.fmla)}`

	return tav.val === undefined ? `${head}/>` : `${head}><p:val>${valueXml(tav.val)}</p:val></p:tav>`
}

function valueXml(value: string | number | boolean | ColorModel): string {
	if (typeof value === "boolean") return `<p:boolVal${attr("val", value)}/>`
	if (typeof value === "number")
		return Number.isInteger(value) ? `<p:intVal${attr("val", value)}/>` : `<p:fltVal${attr("val", decimal(value))}/>`
	if (typeof value === "string") return `<p:strVal${attr("val", value)}/>`

	return `<p:clrVal>${colorXml(value)}</p:clrVal>`
}

export function targetXml(target: AnimTarget): string {
	switch (target.kind) {
		case "slide":
			return "<p:tgtEl><p:sldTgt/></p:tgtEl>"
		case "sound":
			return `<p:tgtEl><p:sndTgt${attr("r:embed", target.embed ?? "")}${attr("name", target.name)}/></p:tgtEl>`
		case "ink":
			return `<p:tgtEl><p:inkTgt${attr("spid", target.shape)}/></p:tgtEl>`
		case "shape":
			return `<p:tgtEl><p:spTgt${attr("spid", target.shape)}/></p:tgtEl>`
		case "bg":
			return `<p:tgtEl><p:spTgt${attr("spid", target.shape)}><p:bg/></p:spTgt></p:tgtEl>`
		case "subShape":
			return `<p:tgtEl><p:spTgt${attr("spid", target.shape)}><p:subSp${attr("spid", target.subShape)}/></p:spTgt></p:tgtEl>`
		case "text": {
			const local = target.unit === "char" ? "charRg" : "pRg"

			return `<p:tgtEl><p:spTgt${attr("spid", target.shape)}><p:txEl><p:${local}${attr("st", target.start)}${attr("end", target.end)}/></p:txEl></p:spTgt></p:tgtEl>`
		}
		case "graphic": {
			let element: string

			if (target.part === "dgm") {
				element = `<a:dgm${attr("id", target.id)}${attr("bldStep", target.bldStep)}/>`
			} else {
				const [series, category] = target.id.split(",")

				element = `<a:chart${attr("seriesIdx", series ?? "-1")}${attr("categoryIdx", category ?? "-1")}${attr("bldStep", target.bldStep ?? "allPts")}/>`
			}

			return `<p:tgtEl><p:spTgt${attr("spid", target.shape)}><p:graphicEl>${element}</p:graphicEl></p:spTgt></p:tgtEl>`
		}
	}
}

const BUILD_MODELED: Readonly<Record<Build["kind"], ReadonlySet<string>>> = {
	bldP: new Set(["spid", "grpId", "build", "bldLvl", "animBg", "rev", "autoUpdateAnimBg"]),
	bldDgm: new Set(["spid", "grpId", "bld"]),
	bldOleChart: new Set(["spid", "grpId", "bld", "animBg"]),
	bldGraphic: new Set(["spid", "grpId"])
}

// A build entry from the model; `base` (its source element, or -1) gives the attributes and children the model does not
// hold. A graphic build's sub-element follows the frame's kind: a:bldChart for a chart, a:bldDgm for a diagram.
function buildPieces(context: EmitContext, build: Build, charts: ReadonlySet<number>, base: number): readonly EmitPiece[] {
	const head = `${attr("spid", build.shape)}${attr("grpId", build.grpId)}`
	const extra = base < 0 ? "" : unmodeledAttributes(context, base, BUILD_MODELED[build.kind])
	let open: string

	switch (build.kind) {
		case "bldP":
			open = `<p:bldP${head}${attr("build", build.build)}${attr("bldLvl", build.bldLvl)}${attr("animBg", build.animBg)}${attr("rev", build.rev)}${attr("autoUpdateAnimBg", build.autoUpdateAnimBg)}${extra}`
			break
		case "bldDgm":
			open = `<p:bldDgm${head}${attr("bld", build.bld)}${extra}`
			break
		case "bldOleChart":
			open = `<p:bldOleChart${head}${attr("bld", build.bld)}${attr("animBg", build.animBg)}${extra}`
			break
		case "bldGraphic":
			return [
				build.whole
					? `<p:bldGraphic${head}${extra}><p:bldAsOne/></p:bldGraphic>`
					: `<p:bldGraphic${head}${extra}><p:bldSub><a:${charts.has(build.shape) ? "bldChart" : "bldDgm"}${attr("bld", build.bld)}/></p:bldSub></p:bldGraphic>`
			]
	}

	const document = context.document

	// p:tmplLst, p:extLst: the source's children, as they were.
	if (base < 0 || document === undefined || document.firstChild(base) < 0) return [`${open}/>`]

	const out = new Pieces().text(`${open}>`)

	for (let child = document.firstChild(base); child >= 0; child = document.nextSibling(child)) out.hole(child)

	return out.text(`</p:${build.kind}>`).out
}

// The slide's p:timing markup: the source span when nothing in it changed, no pieces when the slide lost its timing.
export function timingPieces(context: EmitContext, tree: TimingTree | undefined, shapes: readonly ShapeNode[] = []): readonly EmitPiece[] {
	if (tree === undefined) return []

	const pristine = splicing(context) ? context.pristine?.slide.timing : undefined

	return new TimingWriter(context, pristine, shapes).timing(tree, pristine)
}

export const emitPptxTiming: PptxEmitFamily = {
	emit: (request, context): EmitResult => ({ kind: "markup", pieces: timingPieces(context, request.slide.timing, request.slide.shapes) })
}
