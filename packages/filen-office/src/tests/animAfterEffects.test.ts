import { describe, expect, it } from "vitest"
import type { CommonTimeNode, LayerState, TimeNode, TimegraphInstance, TimingTree } from "../core/anim/model"
import { compile, instantiate } from "../core/anim/timegraph"
import { readTiming } from "../core/pptx/read/timing"
import type { ColorModel } from "../core/presentation/model"
import { PartReader } from "../core/pptx/read/xml"
import { encodeUtf8, parseXml } from "../core/xml/index"
import { BUDGETS, TimingBuilder, animatedSlide, layersOf, shape } from "./animFixtures"

// p:subTnLst after-effects (ECMA-376 Part 1 §19.5, masterRel): dim to a colour or hide on the next click, hide after
// the animation by its delay from the effect's begin, as PowerPoint writes them and as a .ppt converts (the subTnLst
// a legacy build's after-effect becomes). They begin no step and "previous" takes them back.

const RED = 0xff0000ff

function subSet(
	b: TimingBuilder,
	shapeId: number,
	attribute: string,
	to: string | ColorModel,
	rel: NonNullable<CommonTimeNode["masterRel"]>,
	delay: number
): TimeNode {
	return b.behavior(
		{ type: "set", common: { target: { kind: "shape", shape: shapeId }, attrNames: [attribute], override: "childStyle" }, to },
		{ dur: 1, fill: "hold", masterRel: rel, stCondLst: [{ delay }] }
	)
}

function appear(b: TimingBuilder, shapeId: number, sub: readonly TimeNode[]): TimeNode {
	const effect = b.effect(shapeId, { presetID: 1, presetClass: "entr", presetSubtype: 0, nodeType: "clickEffect" }, 0, [
		b.set(shapeId, "style.visibility", "visible", { stCondLst: [{ delay: 0 }] }),
		b.behavior(
			{ type: "animEffect", common: { target: { kind: "shape", shape: shapeId }, attrNames: [] }, transition: "in", filter: "fade" },
			{ dur: 500 }
		)
	])

	if (sub.length > 0) effect.ctn.subTnLst = [...sub]

	return effect
}

function play(timing: TimingTree): TimegraphInstance {
	const instance = instantiate(compile(animatedSlide(timing, [shape(2), shape(3)]), layersOf([2, 3]), BUDGETS))

	instance.fire({ kind: "slideBegin" }, 0)

	return instance
}

function state(states: readonly LayerState[], layer: number): LayerState | undefined {
	return states.find(entry => entry.layer === layer)
}

function twoClicks(sub: (b: TimingBuilder) => readonly TimeNode[]): TimegraphInstance {
	const b = new TimingBuilder()

	return play(b.root([b.mainSeq([b.click([[0, [appear(b, 2, sub(b))]]]), b.click([[0, [appear(b, 3, [])]]])])]))
}

describe("subTnLst after-effects", () => {
	it("dims to a colour at the next click, not before, and previous takes the dim back", () => {
		const t = twoClicks(b => [subSet(b, 2, "style.color", { kind: "srgb", rgb: "FF0000" }, "nextClick", 0)])

		t.fire({ kind: "next" }, 1000)
		expect(state(t.sample(1000), 0)?.dom?.textColor).toBeUndefined()
		expect(state(t.sample(4999), 0)?.dom?.textColor).toBeUndefined()

		t.fire({ kind: "next" }, 5000)
		expect(state(t.sample(5000), 0)?.dom?.textColor).toBe(RED)
		expect(state(t.sample(60_000), 0)?.dom?.textColor).toBe(RED)
		// The click that dims also plays the next step.
		expect(t.snapshot().step).toBe(2)
		expect(state(t.sample(5000), 1)?.visible).toBe(true)

		t.fire({ kind: "prev" }, 6000)
		expect(t.snapshot().step).toBe(1)
		expect(state(t.sample(6000), 0)?.dom?.textColor).toBeUndefined()
	})

	it("hides on the next click", () => {
		const t = twoClicks(b => [subSet(b, 2, "style.visibility", "hidden", "nextClick", 0)])

		t.fire({ kind: "next" }, 1000)
		expect(state(t.sample(3000), 0)?.visible).toBe(true)
		t.fire({ kind: "next" }, 5000)
		expect(state(t.sample(5000), 0)?.visible).toBe(false)
	})

	it("hides after the animation: its delay counts from the effect's begin", () => {
		const t = twoClicks(b => [subSet(b, 2, "style.visibility", "hidden", "sameClick", 500)])

		t.fire({ kind: "next" }, 1000)
		expect(state(t.sample(1499), 0)?.visible).toBe(true)
		expect(state(t.sample(1500), 0)?.visible).toBe(false)
		// No step of its own: the next click plays the second effect.
		t.fire({ kind: "next" }, 2000)
		expect(t.snapshot().step).toBe(2)
		expect(state(t.sample(2000), 0)?.visible).toBe(false)
	})

	it("hides at once when a click seeks the effect to its end", () => {
		const t = twoClicks(b => [subSet(b, 2, "style.visibility", "hidden", "sameClick", 500)])

		t.fire({ kind: "next" }, 1000)
		t.fire({ kind: "next" }, 1200)
		expect(state(t.sample(1200), 0)?.visible).toBe(false)
	})

	it("reads a pptx subTnLst (as PowerPoint and a converted .ppt write it) and plays it", () => {
		const effect = (id: number, spid: number, sub: string): string =>
			`<p:par><p:cTn id="${String(id)}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="${String(id + 1)}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
			`<p:par><p:cTn id="${String(id + 2)}" presetID="1" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>` +
			`<p:set><p:cBhvr><p:cTn id="${String(id + 3)}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="${String(spid)}"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>` +
			`</p:childTnLst>${sub}</p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`
		const dim =
			'<p:subTnLst><p:set><p:cBhvr override="childStyle"><p:cTn id="90" dur="1" fill="hold" display="0" masterRel="nextClick" afterEffect="1"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="2"/></p:tgtEl><p:attrNameLst><p:attrName>style.color</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:clrVal><a:srgbClr val="FF0000"/></p:clrVal></p:to></p:set></p:subTnLst>'
		const xml =
			'<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>' +
			'<p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>' +
			effect(10, 2, dim) +
			effect(20, 3, "") +
			'</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>' +
			"</p:childTnLst></p:cTn></p:par></p:tnLst></p:timing></p:sld>"
		const document = parseXml(encodeUtf8(xml))
		const reader = new PartReader(document)
		const timing = readTiming({ reader, part: "ppt/slides/slide1.xml", epoch: 0, budgets: BUDGETS }, document.documentElement())

		if (timing === undefined) throw new Error("no timing")

		const t = play(timing)

		t.fire({ kind: "next" }, 1000)
		expect(state(t.sample(2000), 0)?.dom?.textColor).toBeUndefined()
		t.fire({ kind: "next" }, 3000)
		expect(state(t.sample(3000), 0)?.dom?.textColor).toBe(RED)
		expect(t.snapshot().step).toBe(2)
	})
})
