import { describe, expect, it } from "vitest"
import type { TimeNode, TimingTree } from "../core/anim/model"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import { slideRef, type Deck, type SlideNode } from "../core/presentation/model"
import { readTiming } from "../core/pptx/read/timing"
import { partReader } from "../core/pptx/read/xml"
import type { PartsApi } from "../core/pptx/write/types"
import { emitPptxTiming } from "../core/pptx/write/emit/timing"
import { sameModel, type EmitContext } from "../core/pptx/write/emit/shape"
import { assemble } from "../core/pptx/write/splice"
import { decodeUtf8, encodeUtf8, parseXml, type XmlDocument } from "../core/xml/index"
import { TIMING_XML } from "./animFixtures"
import { NS } from "./pptxFixtures"

// p:timing through the reader and the timing emit: what the model holds, untouched timing as its source span, an edit
// rewriting only the edited node (unmodelled attributes and children kept), and the model alone written back.

const PART = "/ppt/slides/slide1.xml"

function slideXml(timing: string): string {
	return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree/></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${timing}</p:sld>`
}

function read(document: XmlDocument): TimingTree {
	const tree = readTiming(
		{ reader: partReader(document), part: PART, epoch: 0, budgets: DEFAULT_PRESENTATION_BUDGETS.timing },
		document.documentElement()
	)

	if (tree === undefined) throw new Error("no timing")

	return tree
}

function node(slide: TimingTree, id: number): TimeNode {
	const visit = (n: TimeNode): TimeNode | undefined =>
		n.ctn.id === id ? n : n.ctn.children.map(visit).find(found => found !== undefined)
	const found = visit(slide.root)

	if (found === undefined) throw new Error(`no node ${String(id)}`)

	return found
}

function slideOf(timing: TimingTree | undefined): SlideNode {
	return {
		ref: slideRef(1),
		kind: "slide",
		part: PART,
		showMasterShapes: true,
		hidden: false,
		shapes: [],
		...(timing === undefined ? {} : { timing }),
		comments: [],
		revision: 0
	}
}

function context(document: XmlDocument | undefined, pristine: TimingTree | undefined): EmitContext {
	return {
		deck: {} as Deck,
		document,
		parts: { owner: PART } as PartsApi,
		...(document === undefined
			? { mode: "model" as const }
			: {
					mode: "splice" as const,
					pristine: { part: PART, epoch: 0, slide: slideOf(pristine), shapes: new Map(), paragraphs: new Map() }
				})
	}
}

function emit(timing: TimingTree | undefined, ctx: EmitContext): string {
	const result = emitPptxTiming.emit(
		{ slide: slideOf(timing), touch: { kind: "slide", slide: slideRef(1), dirt: { kind: "slidePart", part: "timing" } } },
		ctx
	)

	if (result.kind !== "markup") throw new Error(result.kind)

	return decodeUtf8(assemble(ctx.document, result.pieces))
}

function reread(markup: string): TimingTree {
	return read(parseXml(encodeUtf8(slideXml(markup))))
}

describe("pptx timing", () => {
	const document = parseXml(encodeUtf8(slideXml(TIMING_XML)))

	it("reads the time node tree, its conditions, behaviours, targets and builds", () => {
		const tree = read(document)
		const main = node(tree, 2)

		expect(tree.root.ctn.nodeType).toBe("tmRoot")
		expect(main.kind).toBe("seq")
		expect(main.ctn).toMatchObject({ nodeType: "mainSeq", concurrent: true, nextAc: "seek" })
		expect(main.ctn.nextCondLst).toEqual([{ evt: "onNext", delay: 0, tgtEl: { kind: "slide" } }])
		expect(node(tree, 3).ctn.stCondLst).toEqual([{ delay: "indefinite" }])
		expect(node(tree, 5).ctn).toMatchObject({
			presetID: 2,
			presetClass: "entr",
			presetSubtype: 4,
			nodeType: "clickEffect",
			fill: "hold"
		})
		expect(node(tree, 8)).toMatchObject({
			kind: "behavior",
			behavior: {
				type: "anim",
				calcmode: "lin",
				valueType: "num",
				common: { target: { kind: "shape", shape: 4 }, attrNames: ["ppt_y"], additive: "base" },
				tavLst: [
					{ tm: 0, val: "1+#ppt_h/2" },
					{ tm: 100000, val: "#ppt_y" }
				]
			},
			ctn: { dur: 500 }
		})
		expect(node(tree, 11)).toMatchObject({ behavior: { type: "animRot", by: 21600000 } })
		expect(node(tree, 16)).toMatchObject({
			behavior: {
				type: "animEffect",
				transition: "in",
				filter: "fade",
				common: { target: { kind: "text", shape: 3, unit: "para", start: 0, end: 0 } }
			}
		})
		expect(tree.builds).toEqual([{ kind: "bldP", src: expect.objectContaining({ format: "pptx" }), shape: 3, grpId: 0, build: "p" }])
	})

	it("writes untouched timing as its source span", () => {
		const out = emit(read(document), context(document, read(document)))

		expect(out).toBe(TIMING_XML)
	})

	it("rewrites only the edited node, keeping the attributes and children the model does not hold", () => {
		const pristine = read(document)
		const edited = read(document)
		const spin = node(edited, 10)

		spin.ctn.presetSubtype = 3
		;(node(edited, 11).ctn as { dur?: number }).dur = 3000

		const out = emit(edited, context(document, pristine))

		// The p14 attribute and p:subTnLst of the edited effect travel with it.
		expect(out).toContain('p14:presetBounceEnd="40000"')
		expect(out).toContain('<p:subTnLst><p:set><p:cBhvr override="childStyle"><p:cTn dur="1"/>')
		// The untouched click group is its source bytes.
		const second = TIMING_XML.slice(
			TIMING_XML.indexOf('<p:par><p:cTn id="12"'),
			TIMING_XML.indexOf("</p:childTnLst></p:cTn><p:prevCondLst>")
		)

		expect(out).toContain(second)
		expect(out).not.toBe(TIMING_XML)
		expect(sameModel(reread(out), edited)).toBe(true)
	})

	it("writes the model alone when there is no source, reading back the same tree", () => {
		const tree = read(document)
		const out = emit(tree, context(undefined, undefined))

		expect(sameModel(reread(out), tree)).toBe(true)
	})

	it("writes no timing when the slide lost it", () => {
		expect(emit(undefined, context(document, read(document)))).toBe("")
	})

	it("refuses a hostile tree past the node budget", () => {
		expect(() =>
			readTiming(
				{
					reader: partReader(document),
					part: PART,
					epoch: 0,
					budgets: { ...DEFAULT_PRESENTATION_BUDGETS.timing, nodesPerSlide: 4 }
				},
				document.documentElement()
			)
		).toThrow(/time nodes/u)
	})
})
