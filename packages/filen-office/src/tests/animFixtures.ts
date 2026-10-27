import type { Behavior, CommonTimeNode, TimeCondition, TimeNode, TimingTree } from "../core/anim/model"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { slideRef, type ShapeNode, type SlideNode } from "../core/presentation/model"

// Timing trees shaped the way PowerPoint writes them (tmRoot → mainSeq → click groups → with/after groups → effects
// → behaviours), built in code for the timegraph tests, and the same trees' markup for the reader and writer tests.

export const BUDGETS = DEFAULT_PRESENTATION_BUDGETS.timing

export class TimingBuilder {
	private id = 1

	ctn(fields: Partial<CommonTimeNode> = {}): CommonTimeNode {
		return { id: this.id++, stCondLst: [], endCondLst: [], children: [], ...fields }
	}

	behavior(behavior: Behavior, fields: Partial<CommonTimeNode> = {}): TimeNode {
		return { kind: "behavior", behavior, ctn: this.ctn({ fill: "hold", ...fields }) }
	}

	set(shape: number, attribute: string, to: string, fields: Partial<CommonTimeNode> = {}): TimeNode {
		return this.behavior(
			{ type: "set", common: { target: { kind: "shape", shape }, attrNames: [attribute] }, to },
			{ dur: 1, ...fields }
		)
	}

	anim(
		shape: number,
		attribute: string,
		values: readonly (readonly [number, string | number])[],
		dur: number,
		fields: Partial<CommonTimeNode> = {}
	): TimeNode {
		return this.behavior(
			{
				type: "anim",
				common: { target: { kind: "shape", shape }, attrNames: [attribute], additive: "base" },
				calcmode: "lin",
				valueType: "num",
				tavLst: values.map(([tm, val]) => ({ tm, val }))
			},
			{ dur, ...fields }
		)
	}

	// Fly In from the bottom (presetID 2, subtype 4).
	flyIn(shape: number, nodeType: "clickEffect" | "withEffect" | "afterEffect", dur = 500, delay = 0): TimeNode {
		return this.effect(shape, { presetID: 2, presetClass: "entr", presetSubtype: 4, nodeType }, delay, [
			this.set(shape, "style.visibility", "visible", { stCondLst: [{ delay: 0 }] }),
			this.anim(
				shape,
				"ppt_y",
				[
					[0, "1+#ppt_h/2"],
					[100000, "#ppt_y"]
				],
				dur
			)
		])
	}

	// Fade Out (exit 10): the filter, then hidden at its end.
	fadeOut(shape: number, nodeType: "clickEffect" | "withEffect" | "afterEffect", dur = 500, delay = 0): TimeNode {
		return this.effect(shape, { presetID: 10, presetClass: "exit", presetSubtype: 0, nodeType }, delay, [
			this.behavior(
				{ type: "animEffect", common: { target: { kind: "shape", shape }, attrNames: [] }, transition: "out", filter: "fade" },
				{ dur }
			),
			this.set(shape, "style.visibility", "hidden", { stCondLst: [{ delay: dur - 1 }] })
		])
	}

	// Spin (emphasis 8): one full turn.
	spin(shape: number, nodeType: "clickEffect" | "withEffect" | "afterEffect", dur = 2000, extra: Partial<CommonTimeNode> = {}): TimeNode {
		return this.effect(shape, { presetID: 8, presetClass: "emph", presetSubtype: 0, nodeType, ...extra }, 0, [
			this.behavior({ type: "animRot", common: { target: { kind: "shape", shape }, attrNames: ["r"] }, by: 21600000 }, { dur })
		])
	}

	effect(shape: number, fields: Partial<CommonTimeNode>, delay: number, behaviors: TimeNode[]): TimeNode {
		void shape

		return { kind: "par", ctn: this.ctn({ fill: "hold", grpId: 0, stCondLst: [{ delay }], ...fields, children: behaviors }) }
	}

	// A click group: with/after groups at their offsets (PowerPoint precomputes them).
	click(
		groups: readonly (readonly [number, readonly TimeNode[]])[],
		conditions: readonly TimeCondition[] = [{ delay: "indefinite" }]
	): TimeNode {
		return {
			kind: "par",
			ctn: this.ctn({
				fill: "hold",
				stCondLst: [...conditions],
				children: groups.map(([delay, effects]) => ({
					kind: "par",
					ctn: this.ctn({ fill: "hold", stCondLst: [{ delay }], children: [...effects] })
				}))
			})
		}
	}

	mainSeq(groups: readonly TimeNode[]): TimeNode {
		return {
			kind: "seq",
			ctn: this.ctn({
				dur: "indefinite",
				nodeType: "mainSeq",
				concurrent: true,
				nextAc: "seek",
				children: [...groups],
				prevCondLst: [{ evt: "onPrev", delay: 0, tgtEl: { kind: "slide" } }],
				nextCondLst: [{ evt: "onNext", delay: 0, tgtEl: { kind: "slide" } }]
			})
		}
	}

	// A trigger: clicking `trigger` plays `effects` (an interactive sequence, as PowerPoint writes one).
	interactive(trigger: number, effects: readonly TimeNode[], restart: CommonTimeNode["restart"] = "whenNotActive"): TimeNode {
		const click: TimeCondition = { evt: "onClick", delay: 0, tgtEl: { kind: "shape", shape: trigger } }

		return {
			kind: "seq",
			ctn: this.ctn({
				restart,
				fill: "hold",
				nodeType: "interactiveSeq",
				concurrent: true,
				nextAc: "seek",
				stCondLst: [click],
				endSync: { evt: "end", delay: 0, rtn: "all" },
				children: [{ kind: "par", ctn: this.ctn({ fill: "hold", stCondLst: [{ delay: 0 }], children: [...effects] }) }],
				nextCondLst: [click]
			})
		}
	}

	root(children: readonly TimeNode[]): TimingTree {
		return {
			root: { kind: "par", ctn: this.ctn({ dur: "indefinite", restart: "never", nodeType: "tmRoot", children: [...children] }) },
			builds: []
		}
	}
}

export function shape(id: number, x = 0, y = 0, cx = 1905000, cy = 952500): ShapeNode {
	return { id, name: `s${String(id)}`, hidden: false, kind: "sp", xfrm: { x, y, cx, cy, rot: 0, flipH: false, flipV: false } }
}

export function animatedSlide(timing: TimingTree, shapes: readonly ShapeNode[]): SlideNode {
	return {
		ref: slideRef(1),
		kind: "slide",
		part: "/ppt/slides/slide1.xml",
		showMasterShapes: true,
		hidden: false,
		shapes: [...shapes],
		timing,
		comments: [],
		revision: 0
	}
}

// One layer per shape id.
export function layersOf(ids: readonly number[]): { shapes: Int32Array } {
	return { shapes: Int32Array.from(ids) }
}

export const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main"

// A p:timing as PowerPoint writes it: a fly-in on click, an after-previous spin with a p14 attribute and an unknown
// cTn child, a by-paragraph fade with a build list.
export const TIMING_XML =
	'<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>' +
	'<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>' +
	'<p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>' +
	'<p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>' +
	'<p:par><p:cTn id="5" presetID="2" presetClass="entr" presetSubtype="4" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>' +
	'<p:set><p:cBhvr><p:cTn id="6" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="4"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>' +
	'<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="7" dur="500" fill="hold"/><p:tgtEl><p:spTgt spid="4"/></p:tgtEl><p:attrNameLst><p:attrName>ppt_x</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="#ppt_x"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#ppt_x"/></p:val></p:tav></p:tavLst></p:anim>' +
	'<p:anim calcmode="lin" valueType="num"><p:cBhvr additive="base"><p:cTn id="8" dur="500" fill="hold"/><p:tgtEl><p:spTgt spid="4"/></p:tgtEl><p:attrNameLst><p:attrName>ppt_y</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="1+#ppt_h/2"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#ppt_y"/></p:val></p:tav></p:tavLst></p:anim>' +
	"</p:childTnLst></p:cTn></p:par>" +
	"</p:childTnLst></p:cTn></p:par>" +
	'<p:par><p:cTn id="9" fill="hold"><p:stCondLst><p:cond delay="500"/></p:stCondLst><p:childTnLst>' +
	`<p:par><p:cTn xmlns:p14="${P14}" id="10" presetID="8" presetClass="emph" presetSubtype="0" fill="hold" nodeType="afterEffect" p14:presetBounceEnd="40000"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
	'<p:animRot by="21600000"><p:cBhvr><p:cTn id="11" dur="2000" fill="hold"/><p:tgtEl><p:spTgt spid="2"/></p:tgtEl><p:attrNameLst><p:attrName>r</p:attrName></p:attrNameLst></p:cBhvr></p:animRot>' +
	'</p:childTnLst><p:subTnLst><p:set><p:cBhvr override="childStyle"><p:cTn dur="1"/><p:tgtEl><p:spTgt spid="2"/></p:tgtEl><p:attrNameLst><p:attrName>style.color</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:clrVal><a:srgbClr val="FF0000"/></p:clrVal></p:to></p:set></p:subTnLst></p:cTn></p:par>' +
	"</p:childTnLst></p:cTn></p:par>" +
	"</p:childTnLst></p:cTn></p:par>" +
	'<p:par><p:cTn id="12" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst>' +
	'<p:par><p:cTn id="13" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>' +
	'<p:par><p:cTn id="14" presetID="10" presetClass="entr" presetSubtype="0" grpId="0" fill="hold" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>' +
	'<p:set><p:cBhvr><p:cTn id="15" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="3"><p:txEl><p:pRg st="0" end="0"/></p:txEl></p:spTgt></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>' +
	'<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="16" dur="500"/><p:tgtEl><p:spTgt spid="3"><p:txEl><p:pRg st="0" end="0"/></p:txEl></p:spTgt></p:tgtEl></p:cBhvr></p:animEffect>' +
	"</p:childTnLst></p:cTn></p:par>" +
	"</p:childTnLst></p:cTn></p:par>" +
	"</p:childTnLst></p:cTn></p:par>" +
	"</p:childTnLst></p:cTn>" +
	'<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>' +
	'<p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>' +
	"</p:childTnLst></p:cTn></p:par></p:tnLst>" +
	'<p:bldLst><p:bldP spid="3" grpId="0" build="p"/></p:bldLst></p:timing>'
