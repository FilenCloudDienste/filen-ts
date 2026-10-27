import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AnimTarget, CommonTimeNode, TimeNode, TimingTree } from "../core/anim/model"
import { RUN_INTS } from "../core/anim/runs"
import { compileSource, instantiate } from "../core/anim/timegraph"
import { bytesSource } from "../core/opc/index"
import { DEFAULT_PRESENTATION_BUDGETS } from "../core/presentation/budget"
import type { ShapeNode, TextBody } from "../core/presentation/model"
import { SERVICES, type CallContext, type EngineSession } from "../dom/presentation/engine"
import { openPptxCapability } from "../dom/presentation/engine/open/pptx"
import { MAX_RUN_LAYERS, layerParents, planRuns, showCapability, showLayerIndex } from "../dom/presentation/engine/show"
import { presentationTextServices } from "../dom/presentation/engine/view"
import { installPresentationRealm, type RasterCanvas, type RasterImage } from "../dom/presentation/services"
import { TimingBuilder } from "./animFixtures"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"
import { body, buildPptx, para, sp, xfrm } from "./pptxFixtures"
import { RecordingCanvas } from "./presentationCanvasRecorder"

// The worker's side of by-letter and by-word builds: the runs a build's paragraphs are split into (grouped past
// MAX_RUN_LAYERS), the layer index the timegraph offsets them by, how they nest, and over a real pptx the source's
// run boxes and the bitmaps each run is cut from.

const BUDGETS = DEFAULT_PRESENTATION_BUDGETS.timing

function textShape(id: number, paragraphs: readonly string[]): ShapeNode {
	const text: TextBody = {
		bodyPr: {},
		paragraphs: paragraphs.map(value => ({ pPr: {}, runs: value === "" ? [] : [{ kind: "r", text: value, rPr: {} }] }))
	}

	return {
		id,
		name: `s${String(id)}`,
		hidden: false,
		kind: "sp",
		xfrm: { x: 0, y: 0, cx: 1905000, cy: 952500, rot: 0, flipH: false, flipV: false },
		text
	}
}

function fade(b: TimingBuilder, target: CommonTimeNode["iterate"], shapeTarget: AnimTarget): TimeNode {
	return b.effect(0, { presetID: 10, presetClass: "entr", nodeType: "clickEffect", ...(target ? { iterate: target } : {}) }, 0, [
		b.behavior({ type: "animEffect", common: { target: shapeTarget, attrNames: [] }, transition: "in", filter: "fade" }, { dur: 500 })
	])
}

function timingOf(effects: (b: TimingBuilder) => TimeNode[]): TimingTree {
	const b = new TimingBuilder()

	return b.root([b.mainSeq([b.click([[0, effects(b)]])])])
}

const LT: CommonTimeNode["iterate"] = { type: "lt", interval: { pct: 10000 }, backwards: false }
const WD: CommonTimeNode["iterate"] = { type: "wd", interval: { ms: 100 }, backwards: false }

describe("planRuns", () => {
	it("splits a whole-shape by-letter build into one run per letter of every paragraph, with the drawing", () => {
		const shapes = [textShape(2, ["Hi yo", "", "ab"])]
		const runs = planRuns(
			timingOf(b => [fade(b, LT, { kind: "shape", shape: 2 })]),
			shapes
		)

		expect(runs).toHaveLength(1)
		expect(runs[0]?.drawing).toBe(true)
		// charRg offsets: "Hi yo" 0..4, its end 5, "" 6, "ab" 7..8.
		expect(runs[0]?.runs.map(run => [run.paragraph, run.start, run.end, run.letter, run.letters, run.word, run.words])).toEqual([
			[0, 0, 0, 0, 1, 0, 1],
			[0, 1, 1, 1, 1, 0, 0],
			[0, 2, 2, 2, 1, 0, 0],
			[0, 3, 3, 3, 1, 1, 1],
			[0, 4, 4, 4, 1, 1, 0],
			[2, 7, 7, 0, 1, 0, 1],
			[2, 8, 8, 1, 1, 0, 0]
		])
	})

	it("splits a by-paragraph by-word build into the targeted paragraph's words, spaces with the word before", () => {
		const runs = planRuns(
			timingOf(b => [fade(b, WD, { kind: "text", shape: 2, unit: "para", start: 1, end: 1 })]),
			[textShape(2, ["one", "two  words  "])]
		)

		expect(runs[0]?.drawing).toBe(false)
		expect(runs[0]?.runs.map(run => [run.paragraph, run.start, run.end, run.words])).toEqual([
			[1, 4, 8, 1],
			[1, 9, 15, 1]
		])
	})

	it(`groups neighbouring letters once a slide passes ${String(MAX_RUN_LAYERS)} runs, keeping every letter`, () => {
		const long = "x".repeat(700)
		const runs = planRuns(
			timingOf(b => [fade(b, LT, { kind: "shape", shape: 2 })]),
			[textShape(2, [long, long])]
		)
		const list = runs[0]?.runs ?? []

		expect(list.length).toBeLessThanOrEqual(MAX_RUN_LAYERS)
		expect(list.reduce((sum, run) => sum + run.letters, 0)).toBe(1400)
		// Runs never cross a paragraph, and follow each other without gaps.
		expect(list.every(run => run.end - run.start + 1 === run.letters)).toBe(true)
	})
})

describe("showLayerIndex with runs", () => {
	it("adds the drawing run and the letters after the shape's layers; a by-letter paragraph target gets no paragraph layer", () => {
		const shapes = [textShape(2, ["ab", "cd"])]
		const timing = timingOf(b => [
			fade(b, LT, { kind: "text", shape: 2, unit: "para", start: 0, end: 0 }),
			fade(b, undefined, { kind: "text", shape: 2, unit: "para", start: 1, end: 1 }),
			fade(b, LT, { kind: "shape", shape: 2 })
		])
		const index = showLayerIndex(timing, planRuns(timing, shapes))

		expect([...index.shapes]).toEqual([2, 2, 2, 2, 2, 2, 2])
		expect(index.ranges).toEqual([
			undefined,
			{ unit: "para", start: 1, end: 1 },
			{ unit: "char", start: -1, end: -1 },
			{ unit: "char", start: 0, end: 0 },
			{ unit: "char", start: 1, end: 1 },
			{ unit: "char", start: 3, end: 3 },
			{ unit: "char", start: 4, end: 4 }
		])
		expect([...(index.runs ?? [])].slice(2 * RUN_INTS, 3 * RUN_INTS)).toEqual([-1, 0, 0, 0, 0])
		// Runs move with the paragraph layer that holds them, else with the shape.
		expect([...layerParents(index, shapes)]).toEqual([-1, 0, 0, 0, 0, 1, 1])
	})
})

// --- Over a real pptx ---

class Bitmap implements RasterImage {
	readonly width: number
	readonly height: number

	constructor(width: number, height: number) {
		this.width = width
		this.height = height
	}

	close(): void {}
}

class Canvas extends RecordingCanvas implements RasterCanvas {
	getContext(): RecordingCanvas {
		return this
	}

	transferToImageBitmap(): RasterImage {
		return new Bitmap(this.width, this.height)
	}

	close(): void {}
}

const BY_LETTER =
	'<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>' +
	'<p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>' +
	'<p:par><p:cTn id="5" presetID="10" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:iterate type="lt"><p:tmPct val="10000"/></p:iterate><p:childTnLst>' +
	'<p:set><p:cBhvr><p:cTn id="6" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="3"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>' +
	'<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="7" dur="500"/><p:tgtEl><p:spTgt spid="3"/></p:tgtEl></p:cBhvr></p:animEffect>' +
	"</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>" +
	'</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst><p:bldLst><p:bldP spid="3" grpId="0" animBg="1"/></p:bldLst></p:timing>'

async function harness(): Promise<{ readonly context: CallContext; readonly ref: number; close(): void }> {
	const box = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="2563EB"/></a:solidFill>'
	const bytes = buildPptx({
		slides: [
			{ shapes: sp(3, "Built", undefined, `${xfrm(914400, 914400, 4572000, 914400)}${box}`, body(para("Hi yo"))), after: BY_LETTER }
		]
	})
	const outcome = await openPptxCapability.open({
		source: bytesSource(bytes),
		sourceKind: "bytes",
		options: { format: "pptx", fileName: "runs.pptx" }
	})

	if (outcome.kind !== "opened") throw new Error(outcome.kind)

	const closers: (() => void)[] = []
	const session: EngineSession = {
		s: 1,
		deck: outcome.deck,
		package: outcome.package,
		options: { format: "pptx", fileName: "runs.pptx" },
		services: { ...SERVICES, text: presentationTextServices },
		rangeSource: undefined,
		schedule: () => undefined,
		emit: () => undefined,
		onClose: listener => closers.push(listener)
	}
	const ref = outcome.deck.slides[0]

	if (ref === undefined) throw new Error("no slide")

	return {
		context: {
			session,
			signal: { aborted: false, onAbort: () => undefined },
			lane: "background",
			slicing: { pause: () => Promise.resolve(), sliceMs: 8, now: () => Date.now() }
		},
		ref,
		close: () => {
			for (const closer of closers) closer()
		}
	}
}

beforeAll(() => {
	installPresentationRealm({
		text: {
			fontHost: nodeFontHost,
			replayFonts: true,
			fontAssets: nodeFontAssets,
			measurer: new HmtxMeasurer(),
			yield: () => Promise.resolve()
		},
		canvas: {
			canvas: (width, height) => new Canvas(Math.ceil(width), Math.ceil(height), "runs"),
			decode: () => Promise.resolve(undefined),
			copy: image => Promise.resolve(new Bitmap(image.width, image.height)),
			fontsReady: () => Promise.resolve()
		}
	})
})

afterAll(() => {
	installPresentationRealm(undefined)
})

describe("showCapability with a by-letter build", () => {
	it("answers run layers with their glyph boxes, played a tenth of the effect apart, and cuts each run's bitmap", async () => {
		const { context, ref, close } = await harness()

		try {
			const graph = await showCapability.timegraph(context, ref as Parameters<typeof showCapability.timegraph>[1])
			const source = graph.source

			if (source === undefined) throw new Error("no source")

			const layers = source.layers

			// The shape, its drawing, then H i ␠ y o.
			expect([...layers.shapes]).toEqual([3, 3, 3, 3, 3, 3, 3])
			expect(layers.ranges?.map(range => range?.start)).toEqual([undefined, -1, 0, 1, 2, 3, 4])

			const boxes = layers.boxes ?? new Float64Array()
			const lefts = [3, 4, 5, 6].map(k => boxes[k * 4] ?? Number.NaN)

			// Letters left to right, each inside the shape's box.
			expect(lefts.every(Number.isFinite)).toBe(true)
			expect([...lefts].sort((a, b) => a - b)).toEqual(lefts)
			expect(lefts[0]).toBeGreaterThanOrEqual(914400)
			expect(Number.isNaN(boxes[4] ?? 0)).toBe(true)

			const t = instantiate(compileSource(ref as Parameters<typeof compileSource>[0], structuredClone(source), BUDGETS))

			t.fire({ kind: "slideBegin" }, 0)
			t.fire({ kind: "next" }, 1000)

			const frame = t.sample(1100)

			// 50 ms apart: letter k at (100 − 50k) / 500.
			expect(frame.find(state => state.layer === 2)?.filter?.progress).toBeCloseTo(0.2, 6)
			expect(frame.find(state => state.layer === 3)?.filter?.progress).toBeCloseTo(0.1, 6)
			expect(frame.find(state => state.layer === 5)?.visible).toBe(false)

			const plan = {
				shapes: [3],
				ranges: [
					layers.ranges?.flatMap(range =>
						range === undefined ? [] : [{ target: range.unit, range: [range.start, range.end] as const }]
					)
				],
				dpr: 1
			}
			const drawn = await showCapability.layers(context, ref as Parameters<typeof showCapability.layers>[1], 960, plan)
			const runs = drawn.filter(layer => layer.shape === 3 && layer.range !== undefined)

			// The drawing first, then each letter's bitmap where the letter is.
			expect(runs.map(layer => layer.range?.range[0])).toEqual([-1, 0, 1, 2, 3, 4])
			expect(runs[0]?.width).toBeGreaterThan(runs[1]?.width ?? Number.POSITIVE_INFINITY)

			for (let k = 2; k < runs.length; k++) expect(runs[k]?.x ?? 0).toBeGreaterThanOrEqual(runs[k - 1]?.x ?? 0)

			// The shape's own layer has nothing left to paint: no bitmap.
			expect(drawn.some(layer => layer.shape === 3 && layer.range === undefined)).toBe(false)
		} finally {
			close()
		}
	})
})
