import { describe, expect, it } from "vitest"
import type { CommonTimeNode, LayerIndex, LayerState, TimeNode, TimegraphInstance } from "../core/anim/model"
import { odpTimingMarkup, readOdpTiming } from "../core/anim/odf"
import { DRAWING_RUN, RUN_INTS, paragraphElements } from "../core/anim/runs"
import { compile, instantiate } from "../core/anim/timegraph"
import { Fragment } from "../core/odp/read/context"
import { sameModel } from "../core/pptx/write/emit/shape"
import type { ShapeNode } from "../core/presentation/model"
import { Namespaces, decodeUtf8, encodeUtf8, parseXml } from "../core/xml/index"
import { BUDGETS, TimingBuilder, animatedSlide, shape } from "./animFixtures"
import { ODP_NS } from "./odpFixtures"

// By-letter and by-word builds (ECMA-376 Part 1 §19.5.49 p:iterate, ODF anim:iterate) in the timegraph: each run
// layer plays the effect from its first element's ordinal times the interval (tmAbs, or tmPct of the effect's
// duration), backwards from the last; the drawing run plays as the first element; a run's own box drives its formulas;
// the build lasts until its last element ends.

const EMU = 9525
// Slide 4:3 default: 960 x 720 px.
const SLIDE_H = 6858000
// "Hi yo": letters H i ␠ y o; words "Hi␠" and "yo".
const TEXT = "Hi yo"
const LETTER_EMU = 100000

function runIndex(): LayerIndex {
	const elements = paragraphElements(TEXT)
	const shapes = [2, 2]
	const ranges: LayerIndex["ranges"] = [undefined, { unit: "char", start: DRAWING_RUN, end: DRAWING_RUN }]
	const runs = [-1, -1, -1, -1, -1, DRAWING_RUN, 0, 0, 0, 0]
	const boxes = [Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN]
	let word = -1

	for (let letter = 0; letter < TEXT.length; letter++) {
		const opens = elements.wordStart[letter] === 1

		if (opens) word++

		shapes.push(2)
		;(ranges as unknown[]).push({ unit: "char", start: letter, end: letter })
		runs.push(0, letter, 1, word, opens ? 1 : 0)
		boxes.push(letter * LETTER_EMU, 0, LETTER_EMU, 2 * LETTER_EMU)
	}

	return { shapes: Int32Array.from(shapes), ranges, runs: Int32Array.from(runs), boxes: Float64Array.from(boxes) }
}

// Layer of letter k.
const LETTER = (k: number): number => 2 + k

function fadeIn(b: TimingBuilder, iterate: CommonTimeNode["iterate"], dur = 500): TimeNode {
	return b.effect(
		2,
		{ presetID: 10, presetClass: "entr", presetSubtype: 0, nodeType: "clickEffect", ...(iterate ? { iterate } : {}) },
		0,
		[
			b.set(2, "style.visibility", "visible", { stCondLst: [{ delay: 0 }] }),
			b.behavior(
				{ type: "animEffect", common: { target: { kind: "shape", shape: 2 }, attrNames: [] }, transition: "in", filter: "fade" },
				{ dur }
			)
		]
	)
}

function play(effect: (b: TimingBuilder) => TimeNode, layers: LayerIndex = runIndex()): TimegraphInstance {
	const b = new TimingBuilder()
	const timing = b.root([b.mainSeq([b.click([[0, [effect(b)]]]), b.click([[0, [b.spin(3, "clickEffect")]]])])])
	const instance = instantiate(compile(animatedSlide(timing, [shape(2), shape(3)]), layers, BUDGETS))

	instance.fire({ kind: "slideBegin" }, 0)

	return instance
}

function state(states: readonly LayerState[], layer: number): LayerState | undefined {
	return states.find(entry => entry.layer === layer)
}

// ECMA: element k of n begins k × interval after the effect (backwards: (n − 1 − k) ×), and plays the effect's own
// duration from there.
function expectedProgress(t: number, begin: number, k: number, interval: number, dur: number): number {
	return Math.min(1, Math.max(0, (t - begin - k * interval) / dur))
}

describe("by-letter and by-word builds", () => {
	it("plays a by-letter fade per letter, tmPct of the effect's duration apart, the drawing with the first", () => {
		const t = play(b => fadeIn(b, { type: "lt", interval: { pct: 10000 }, backwards: false }))

		// Before the click every letter and the drawing are hidden.
		for (const layer of [1, ...[0, 1, 2, 3, 4].map(LETTER)]) expect(state(t.sample(0), layer)?.visible).toBe(false)

		t.fire({ kind: "next" }, 1000)

		// 10% of 500 ms: 50 ms between letters.
		for (const time of [1000, 1030, 1100, 1260, 1499, 1555, 1699]) {
			const frame = t.sample(time)

			for (let k = 0; k < TEXT.length; k++) {
				const letter = state(frame, LETTER(k))
				const shown = time >= 1000 + k * 50

				expect(letter?.visible).toBe(shown)

				if (shown) expect(letter?.filter?.progress ?? 1).toBeCloseTo(expectedProgress(time, 1000, k, 50, 500), 6)
			}

			expect(state(frame, 1)?.filter?.progress ?? 1).toBeCloseTo(expectedProgress(time, 1000, 0, 50, 500), 6)
		}

		// The build ends with its last letter: 1000 + 4 × 50 + 500.
		expect(t.nextActivation(1500)).toBe(1700)
		for (let k = 0; k < TEXT.length; k++) expect(state(t.sample(1700), LETTER(k))?.filter?.progress ?? 1).toBe(1)
	})

	it("plays a by-word build per word, tmAbs apart, every letter of a word together", () => {
		const t = play(b => fadeIn(b, { type: "wd", interval: { ms: 100 }, backwards: false }))

		t.fire({ kind: "next" }, 1000)

		const frame = t.sample(1150)
		// "Hi␠" is word 0, "yo" word 1.
		const words = [0, 0, 0, 1, 1]

		words.forEach((word, k) => {
			expect(state(frame, LETTER(k))?.filter?.progress).toBeCloseTo(expectedProgress(1150, 1000, word, 100, 500), 6)
		})
		expect(t.nextActivation(1500)).toBe(1600)
	})

	it("plays a backwards build from the last letter", () => {
		const t = play(b => fadeIn(b, { type: "lt", interval: { ms: 50 }, backwards: true }))

		t.fire({ kind: "next" }, 1000)

		const frame = t.sample(1120)

		for (let k = 0; k < TEXT.length; k++) {
			const reversed = TEXT.length - 1 - k

			expect(state(frame, LETTER(k))?.visible).toBe(1120 >= 1000 + reversed * 50)
			if (1120 >= 1000 + reversed * 50)
				expect(state(frame, LETTER(k))?.filter?.progress).toBeCloseTo(expectedProgress(1120, 1000, reversed, 50, 500), 6)
		}
	})

	it("evaluates a by-letter fly-in's formulas against each letter's own box", () => {
		const t = play(b =>
			b.effect(
				2,
				{
					presetID: 2,
					presetClass: "entr",
					presetSubtype: 4,
					nodeType: "clickEffect",
					iterate: { type: "lt", interval: { ms: 50 }, backwards: false }
				},
				0,
				[
					b.set(2, "style.visibility", "visible", { stCondLst: [{ delay: 0 }] }),
					b.anim(
						2,
						"ppt_y",
						[
							[0, "1+#ppt_h/2"],
							[100000, "#ppt_y"]
						],
						500
					)
				]
			)
		)

		t.fire({ kind: "next" }, 1000)

		const slideH = SLIDE_H / EMU
		const h = (2 * LETTER_EMU) / SLIDE_H
		// The letter's centre (slide fraction).
		const y = LETTER_EMU / SLIDE_H

		for (const time of [1100, 1250, 1400]) {
			for (let k = 0; k < TEXT.length; k++) {
				const u = expectedProgress(time, 1000, k, 50, 500)

				if (u <= 0) continue

				const value = (1 + h / 2) * (1 - u) + y * u

				expect(state(t.sample(time), LETTER(k))?.matrix[5]).toBeCloseTo(value * slideH - y * slideH, 4)
			}
		}
	})

	it("keeps a by-letter build running until its last letter: a click seeks every letter to its end", () => {
		const t = play(b => fadeIn(b, { type: "lt", interval: { pct: 10000 }, backwards: false }))

		t.fire({ kind: "next" }, 1000)
		// After the effect's own 500 ms but before the last letter's end.
		t.fire({ kind: "next" }, 1600)

		const frame = t.sample(1600)

		for (let k = 0; k < TEXT.length; k++) {
			expect(state(frame, LETTER(k))?.visible).toBe(true)
			expect(state(frame, LETTER(k))?.filter?.progress ?? 1).toBe(1)
		}

		// The spin of the second click begins only with the next click.
		t.fire({ kind: "next" }, 2000)
		expect(t.snapshot().step).toBe(2)
	})

	it("offsets a run of several letters by its first letter", () => {
		const layers: LayerIndex = {
			shapes: Int32Array.of(2, 2, 2),
			ranges: [undefined, { unit: "char", start: 0, end: 2 }, { unit: "char", start: 3, end: 4 }],
			runs: Int32Array.of(-1, -1, -1, -1, -1, 0, 0, 3, 0, 1, 0, 3, 2, 1, 1)
		}
		const t = play(b => fadeIn(b, { type: "lt", interval: { ms: 50 }, backwards: false }), layers)

		t.fire({ kind: "next" }, 1000)
		expect(state(t.sample(1100), 1)?.filter?.progress).toBeCloseTo(0.2, 6)
		expect(state(t.sample(1100), 2)?.visible).toBe(false)
		expect(state(t.sample(1250), 2)?.filter?.progress).toBeCloseTo(0.2, 6)
		// The build lasts until its last run ends: 1000 + 150 + 500.
		expect(t.nextActivation(1500)).toBe(1650)
	})

	it("plays a by-paragraph target's letters only, counted from the paragraph's first", () => {
		const layers: LayerIndex = {
			shapes: Int32Array.of(2, 2, 2, 2, 2),
			ranges: [
				undefined,
				{ unit: "char", start: 0, end: 0 },
				{ unit: "char", start: 1, end: 1 },
				{ unit: "char", start: 3, end: 3 },
				{ unit: "char", start: 4, end: 4 }
			],
			// Paragraphs "ab" and "cd".
			runs: Int32Array.of(-1, -1, -1, -1, -1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0)
		}
		const t = play(
			b =>
				b.effect(
					2,
					{
						presetID: 10,
						presetClass: "entr",
						nodeType: "clickEffect",
						iterate: { type: "lt", interval: { ms: 100 }, backwards: false }
					},
					0,
					[
						b.behavior(
							{
								type: "animEffect",
								common: { target: { kind: "text", shape: 2, unit: "para", start: 1, end: 1 }, attrNames: [] },
								transition: "in",
								filter: "fade"
							},
							{ dur: 500 }
						)
					]
				),
			layers
		)

		t.fire({ kind: "next" }, 1000)

		const frame = t.sample(1150)

		expect(state(frame, 1)).toBeUndefined()
		expect(state(frame, 3)?.filter?.progress).toBeCloseTo(0.3, 6)
		expect(state(frame, 4)?.filter?.progress).toBeCloseTo(0.1, 6)
	})

	it("plays an effect on the whole shape when the build's target has no runs", () => {
		const t = play(b => fadeIn(b, { type: "lt", interval: { ms: 50 }, backwards: false }), { shapes: Int32Array.of(2) })

		t.fire({ kind: "next" }, 1000)
		expect(state(t.sample(1250), 0)?.filter?.progress).toBeCloseTo(0.5, 6)
	})

	it("splits text into letters and words: spaces join the word before them", () => {
		const elements = paragraphElements("  ab cd  e")

		expect([...elements.letters]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
		expect([...elements.wordStart]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 1])
		expect(RUN_INTS).toBe(5)
	})
})

// --- ODF anim:iterate ---

const ITERATE =
	'<anim:par smil:dur="indefinite" smil:restart="never" presentation:node-type="timing-root"><anim:seq smil:dur="indefinite" presentation:node-type="main-sequence">' +
	'<anim:par smil:begin="next" smil:fill="hold"><anim:par smil:begin="0s" smil:fill="hold">' +
	'<anim:iterate smil:begin="0s" smil:fill="hold" presentation:node-type="on-click" presentation:preset-class="entrance" presentation:preset-id="ooo-entrance-fade-in" smil:targetElement="id1" anim:iterate-type="by-letter" anim:iterate-interval="PT00H00M00.1S">' +
	'<anim:set smil:begin="0s" smil:dur="0.001s" smil:fill="hold" smil:attributeName="visibility" smil:to="visible"/>' +
	'<anim:transitionFilter smil:dur="0.5s" smil:type="fade" smil:subtype="crossfade"/>' +
	"</anim:iterate></anim:par></anim:par></anim:seq></anim:par>"

function odpPage(timing: string): { fragment: Fragment; page: number; shapes: ShapeNode[]; raw: (node: number) => Uint8Array } {
	const document = parseXml(
		encodeUtf8(
			`<office:fragment ${ODP_NS}><draw:page draw:name="p1"><draw:frame draw:id="id1" xml:id="id1" svg:x="1cm" svg:y="1cm" svg:width="5cm" svg:height="2cm"><draw:text-box/></draw:frame>${timing}</draw:page></office:fragment>`
		)
	)
	const fragment = new Fragment(document, new Namespaces(document, { lenient: true }), "content.xml", 100, "content", 0)
	const page = document.firstChildElement(document.documentElement())
	const frame = document.firstChildElement(page)

	return {
		fragment,
		page,
		shapes: [{ id: 1, name: "", hidden: false, kind: "sp", src: fragment.src(frame) }],
		raw: node => document.raw(node)
	}
}

describe("ODF anim:iterate", () => {
	it("reads LibreOffice's by-letter iterate: its children animate the element it iterates, its interval in ms", () => {
		const page = odpPage(ITERATE)
		const tree = readOdpTiming(page.fragment, page.page, page.shapes, BUDGETS)

		if (tree === undefined) throw new Error("no timing")

		const stack: TimeNode[] = [tree.root]
		let iterated: TimeNode | undefined

		for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
			if (node.ctn.iterate !== undefined) iterated = node

			stack.push(...node.ctn.children)
		}

		expect(iterated?.ctn.iterate).toEqual({ type: "lt", interval: { ms: 100 }, backwards: false })

		for (const child of iterated?.ctn.children ?? [])
			expect(child.kind === "behavior" && "common" in child.behavior ? child.behavior.common.target : undefined).toEqual({
				kind: "shape",
				shape: 1
			})

		// Without its source the iterate names what it iterates (LibreOffice plays nothing otherwise).
		const fresh = odpTimingMarkup({ fragment: undefined, shapes: page.shapes }, tree, undefined)
			.map(piece => (typeof piece === "string" ? piece : piece instanceof Uint8Array ? decodeUtf8(piece) : ""))
			.join("")

		expect(fresh).toMatch(/<anim:iterate[^>]* smil:targetElement="id1"/u)

		const again = readOdpTiming(odpPage(fresh).fragment, odpPage(fresh).page, odpPage(fresh).shapes, BUDGETS)

		expect(again !== undefined && sameModel(again, tree)).toBe(true)

		// Played by letter: 100 ms apart.
		const layers: LayerIndex = {
			shapes: Int32Array.of(1, 1, 1),
			ranges: [undefined, { unit: "char", start: 0, end: 0 }, { unit: "char", start: 1, end: 1 }],
			runs: Int32Array.of(-1, -1, -1, -1, -1, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0)
		}
		const t = instantiate(compile(animatedSlide(tree, [shape(1)]), layers, BUDGETS))

		t.fire({ kind: "slideBegin" }, 0)
		t.fire({ kind: "next" }, 1000)
		expect(state(t.sample(1150), 1)?.filter?.progress).toBeCloseTo(0.3, 6)
		expect(state(t.sample(1150), 2)?.filter?.progress).toBeCloseTo(0.1, 6)
	})

	it("writes a share of the effect's duration (tmPct) as the time ODF holds", () => {
		const b = new TimingBuilder()
		const tree = b.root([b.mainSeq([b.click([[0, [fadeIn(b, { type: "lt", interval: { pct: 10000 }, backwards: false })]]])])])
		const out = odpTimingMarkup({ fragment: undefined, shapes: [shape(2)] }, tree, undefined)
			.map(piece => (typeof piece === "string" ? piece : piece instanceof Uint8Array ? decodeUtf8(piece) : ""))
			.join("")

		// 10% of the fade's 500 ms.
		expect(out).toMatch(/<anim:iterate[^>]* anim:iterate-type="by-letter" anim:iterate-interval="PT0\.05S"/u)
	})
})
