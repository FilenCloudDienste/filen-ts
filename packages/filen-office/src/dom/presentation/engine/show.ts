import type {
	AnimTarget,
	Behavior,
	CompiledTimegraph,
	LayerIndex,
	TimeNode,
	TimegraphSource,
	TimingTree,
	Transition
} from "../../../core/anim/model"
import { isMediaBehavior } from "../../../core/anim/attributes"
import {
	DRAWING_RUN,
	RUN_INTS,
	RunInt,
	forEachIterated,
	paragraphElements,
	paragraphStarts,
	paragraphText,
	type IterateUnit,
	type ParagraphElements
} from "../../../core/anim/runs"
import { compileSource } from "../../../core/anim/timegraph"
import { paintTextPageCanvas } from "../../../core/drawingml/canvas"
import {
	DrawingList,
	EMU_PER_PX,
	ITEM_FLOATS,
	ITEM_INTS,
	ItemFloat,
	ItemInt,
	ItemKind,
	measurePath,
	multiply,
	type DrawingData,
	type Rgba
} from "../../../core/drawingml/index"
import { PresentationError, type ColorModel, type ShapeNode, type SlideNode, type SlideRef } from "../../../core/presentation/model"
import type { RenderEffects, SlideLayer, SlideRender, TextPage } from "../../../core/presentation/output"
import { drawingData } from "../../../core/presentation/render/slide"
import { G, PartReader } from "../../../core/pptx/read/xml"
import { fileFallback } from "../../../core/pptx/read/transition"
import { playableTransition } from "../../../core/anim/presets/transitions/catalog"
import { pptxParts } from "./open/pptx"
import { effectiveClrMap, resolveColor, themeOf, toRgba } from "../../../core/presentation/theme"
import { sliceClock } from "../../../core/slicing"
import {
	FRAGMENT_FLOATS,
	FRAGMENT_INTS,
	FRAGMENT_LEVEL_SHIFT,
	FragmentFloat,
	FragmentInt,
	LINE_FLOATS,
	LINE_INTS,
	LineFlag,
	LineFloat,
	LineInt
} from "../../../core/text/displayList"
import type { XmlDocument } from "../../../core/xml/index"
import type { CallContext, EngineSession, ShowCapability } from "../engine"
import type { LayerPlan, ShowLayer } from "../protocol"
import { MAX_CANVAS_SIDE, presentationRealm, type RasterCanvas } from "../services"
import { decodeSlidePictures, paintSlideCanvas } from "../thumbs"
import { sessionPictures } from "./thumbs"
import { readPart, renderSlideFor, viewParts } from "./view"

// The slide show's side of the worker. timegraph(): the slide's timing compiled once against its layers (the budgets
// refuse a hostile tree here, before the page plays it) and answered with the source the page compiles its own
// instance from (compile() output holds closures and never crosses a realm): the timing, the layer index, the
// shapes' boxes as rendered and the theme colours of its colour values. layers(): the slide drawn as bitmaps the stage
// composites: each animated shape (and each paragraph range built on its own) on a canvas cropped to its bounds plus
// effect extents, the static drawing between them as runs (shape -1; the first run carries the background), all in
// z-order. A shape inside an animated group is its own layer when the timing names it; the page composes it with the
// group's state, as it composes a paragraph layer with its shape's.

// The shape id of a static run in layers().
export const STATIC_LAYER = -1
// Bitmap bytes of one slide's layers (the page holds the slide on stage and the next one).
export const SHOW_LAYER_BYTES = 128 * 1024 * 1024
// Stage widths served (px, before the device pixel ratio).
const MIN_STAGE_WIDTH = 16
const MAX_STAGE_WIDTH = 8192
// How far past the slide a layer is kept (a fly-in starts off the slide): one slide size on each side.
const REACH = 1
// Text paints a little outside its lines (overhangs, accents): this share of the line height around them.
const TEXT_BLEED = 0.25
// Bands of a paragraph range reach this far sideways and past the first and last line (text px).
const BAND_REACH = 1_000_000

type Range = { readonly target: "para" | "char"; readonly range: readonly [number, number] }
type Box = [number, number, number, number]

// --- Layer index (the timing's targets) ---

function targetOf(behavior: Behavior): AnimTarget {
	return isMediaBehavior(behavior) ? behavior.target : behavior.common.target
}

// Every behaviour of the timing, its p:subTnLst members included; `iterated` when it plays in a by-letter or by-word
// build (those play on the runs, not on a paragraph layer).
function forEachBehavior(timing: TimingTree | undefined, visit: (behavior: Behavior, iterated: boolean) => void): void {
	if (timing === undefined) return

	const stack: { node: TimeNode; iterated: boolean }[] = [{ node: timing.root, iterated: false }]

	for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
		const node = item.node
		const type = node.ctn.iterate?.type
		const iterated = item.iterated || type === "lt" || type === "wd"

		if (node.kind === "behavior") visit(node.behavior, iterated)

		for (const child of node.ctn.children) stack.push({ node: child, iterated })
		for (const child of node.ctn.subTnLst ?? []) stack.push({ node: child, iterated })
	}
}

// The layers a slide's timing animates: per shape it names, the whole shape, then each paragraph range targeted on its
// own split at every range boundary (so a target covers whole layers), keeping only the pieces some target covers,
// then the runs of its by-letter and by-word builds (`runs`, from planRuns). Other character targets play on the
// whole shape.
export function showLayerIndex(timing: TimingTree | undefined, runs: readonly ShapeRuns[] = []): LayerIndex {
	const shapes = new Set<number>()
	const ranges = new Map<number, [number, number][]>()

	forEachBehavior(timing, (behavior, iterated) => {
		const target = targetOf(behavior)

		if (target.kind === "sound" || target.kind === "slide") return

		shapes.add(target.shape)

		if (iterated || target.kind !== "text" || target.unit !== "para" || target.end < target.start) return

		const list = ranges.get(target.shape)

		if (list === undefined) ranges.set(target.shape, [[target.start, target.end]])
		else list.push([target.start, target.end])
	})

	const runsOf = new Map(runs.map(entry => [entry.shape, entry]))
	const outShapes: number[] = []
	const outRanges: ({ readonly unit: "para" | "char"; readonly start: number; readonly end: number } | undefined)[] = []
	const outRuns: number[] = []
	const plain = (): void => {
		outRuns.push(-1, -1, -1, -1, -1)
	}

	for (const shape of [...shapes].sort((a, b) => a - b)) {
		outShapes.push(shape)
		outRanges.push(undefined)
		plain()

		const targeted = ranges.get(shape)
		const cuts = [...new Set((targeted ?? []).flatMap(([start, end]) => [start, end + 1]))].sort((a, b) => a - b)

		for (let k = 0; k + 1 < cuts.length; k++) {
			const start = cuts[k] ?? 0
			const end = (cuts[k + 1] ?? 0) - 1

			if (!(targeted ?? []).some(([from, to]) => from <= start && end <= to)) continue

			outShapes.push(shape)
			outRanges.push({ unit: "para", start, end })
			plain()
		}

		const built = runsOf.get(shape)

		if (built === undefined) continue

		if (built.drawing) {
			outShapes.push(shape)
			outRanges.push({ unit: "char", start: DRAWING_RUN, end: DRAWING_RUN })
			outRuns.push(DRAWING_RUN, 0, 0, 0, 0)
		}

		for (const run of built.runs) {
			outShapes.push(shape)
			outRanges.push({ unit: "char", start: run.start, end: run.end })
			outRuns.push(run.paragraph, run.letter, run.letters, run.word, run.words)
		}
	}

	if (!outRanges.some(range => range !== undefined)) return { shapes: Int32Array.from(outShapes) }

	return outRanges.some(range => range?.unit === "char")
		? { shapes: Int32Array.from(outShapes), ranges: outRanges, runs: Int32Array.from(outRuns) }
		: { shapes: Int32Array.from(outShapes), ranges: outRanges }
}

// --- Runs (by-letter and by-word builds) ---

// Run layers a slide holds at most: a longer build groups neighbouring letters or words into one run, so a dense
// body costs at most this many small bitmaps (their area stays about the text's).
export const MAX_RUN_LAYERS = 256

// One run of a built body: charRg offsets (inclusive) and its RunInt fields.
export interface PlannedRun {
	readonly paragraph: number
	readonly start: number
	readonly end: number
	readonly letter: number
	readonly letters: number
	readonly word: number
	readonly words: number
}

export interface ShapeRuns {
	readonly shape: number
	// A whole-shape build plays the drawing without its text as its first element.
	readonly drawing: boolean
	readonly runs: readonly PlannedRun[]
}

function findShape(shapes: readonly ShapeNode[], id: number): ShapeNode | undefined {
	const stack = [...shapes]

	for (let shape = stack.pop(); shape !== undefined; shape = stack.pop()) {
		if (shape.id === id) return shape

		for (const child of shape.children ?? []) stack.push(child)
	}

	return undefined
}

// The runs of a slide's by-letter and by-word builds: per shape, every paragraph a build targets split into letters
// (any by-letter build there) or words, grouped evenly once the slide passes MAX_RUN_LAYERS.
export function planRuns(timing: TimingTree | undefined, shapes: readonly ShapeNode[]): ShapeRuns[] {
	const wanted = new Map<number, { drawing: boolean; units: Map<number, IterateUnit> }>()

	forEachIterated(timing, (target, unit) => {
		if (target.kind !== "shape" && target.kind !== "text") return

		const body = findShape(shapes, target.shape)?.text

		if (body === undefined || body.paragraphs.length === 0) return

		const entry = wanted.get(target.shape) ?? { drawing: false, units: new Map<number, IterateUnit>() }
		const starts = paragraphStarts(body)
		let from = 0
		let to = body.paragraphs.length - 1

		wanted.set(target.shape, entry)

		if (target.kind === "shape") entry.drawing = true
		else if (target.unit === "para") {
			from = Math.max(0, target.start)
			to = Math.min(to, target.end)
		} else {
			while (from < to && (starts[from + 1] ?? 0) <= target.start) from++
			while (to > from && (starts[to] ?? 0) > target.end) to--
		}

		for (let p = from; p <= to; p++) if (entry.units.get(p) !== "lt") entry.units.set(p, unit)
	})

	// Per shape and paragraph its units: [first letter, letters, first word, words].
	const units: { shape: number; paragraph: number; start: number; elements: ParagraphElements; list: number[] }[] = []
	let total = 0

	for (const [shape, entry] of [...wanted].sort((a, b) => a[0] - b[0])) {
		const body = findShape(shapes, shape)?.text

		if (body === undefined) continue

		const starts = paragraphStarts(body)

		for (const [paragraph, unit] of [...entry.units].sort((a, b) => a[0] - b[0])) {
			const p = body.paragraphs[paragraph]

			if (p === undefined) continue

			const elements = paragraphElements(paragraphText(p))
			const letterCount = elements.letters.length - 1
			const list: number[] = []
			let word = -1

			for (let letter = 0; letter < letterCount; letter++) {
				const opens = elements.wordStart[letter] === 1

				if (opens) word++
				if (unit === "lt" || opens) list.push(letter, 1, word, opens ? 1 : 0)
				else {
					list[list.length - 3] = (list[list.length - 3] ?? 0) + 1
				}
			}

			total += list.length / 4
			units.push({ shape, paragraph, start: starts[paragraph] ?? 0, elements, list })
		}
	}

	const group = Math.max(1, Math.ceil(total / MAX_RUN_LAYERS))
	const out = new Map<number, ShapeRuns>()

	for (const [shape, entry] of wanted) if (entry.units.size > 0) out.set(shape, { shape, drawing: entry.drawing, runs: [] })

	for (const { shape, paragraph, start, elements, list } of units) {
		const runs = out.get(shape)?.runs as PlannedRun[] | undefined

		if (runs === undefined) continue

		for (let k = 0; k < list.length; k += 4 * group) {
			const last = Math.min(list.length, k + 4 * group)
			const letter = list[k] ?? 0
			let letters = 0
			let words = 0

			for (let at = k; at < last; at += 4) {
				letters += list[at + 1] ?? 0
				words += list[at + 3] ?? 0
			}

			runs.push({
				paragraph,
				start: start + (elements.letters[letter] ?? 0),
				end: start + (elements.letters[letter + letters] ?? 0) - 1,
				letter,
				letters,
				word: list[k + 2] ?? 0,
				words
			})
		}
	}

	return [...out.values()]
}

// A text's width in a CSS font (px); absent, runs split fragments in proportion to their characters.
export type TextMeasure = (font: string, text: string) => number

// The realm's canvas text measure.
function canvasMeasure(): TextMeasure {
	let ctx: ReturnType<RasterCanvas["getContext"]> | undefined

	return (font, text) => {
		// Made at the first measure (a slide without runs makes none); 0 without a canvas: runs split in proportion.
		ctx ??= presentationRealm()?.canvas.canvas(1, 1)?.getContext("2d") ?? null

		if (ctx === null) return 0
		if (ctx.font !== font) ctx.font = font

		return ctx.measureText(text).width
	}
}

// One line of a run: the line's index on its text page and the run's extent across it (text px, x0 < x1).
export type RunClip = readonly [line: number, x0: number, x1: number]

// The text layer a shape's runs are cut from.
function textLayerOf(render: SlideRender, shape: number): SlideLayer | undefined {
	return render.layers.find(layer => layer.shape.slide === render.ref && layer.shape.id === shape && layer.text !== undefined)
}

// x (text px) of text offset `offset` on line `line`: inside a fragment, its measured prefix scaled to the fragment's
// laid-out width (letter spacing, justification and scaling are spread as the measured widths are).
function lineOffsetX(page: TextPage, line: number, offset: number, measure: TextMeasure | undefined): number {
	const data = page.page
	const first = data.lineInts[line * LINE_INTS + LineInt.FIRST_FRAGMENT] ?? 0
	const count = data.lineInts[line * LINE_INTS + LineInt.FRAGMENT_COUNT] ?? 0
	const text = data.sourceTexts[data.lineInts[line * LINE_INTS + LineInt.SOURCE] ?? -1] ?? ""
	let x = data.lineFloats[line * LINE_FLOATS + LineFloat.X] ?? 0

	for (let k = first; k < first + count; k++) {
		const start = data.fragmentInts[k * FRAGMENT_INTS + FragmentInt.TEXT_START] ?? 0
		const end = data.fragmentInts[k * FRAGMENT_INTS + FragmentInt.TEXT_END] ?? 0
		const left = data.fragmentFloats[k * FRAGMENT_FLOATS + FragmentFloat.X] ?? 0
		const width = data.fragmentFloats[k * FRAGMENT_FLOATS + FragmentFloat.WIDTH] ?? 0
		const rtl = ((data.fragmentInts[k * FRAGMENT_INTS + FragmentInt.INFO] ?? 0) >> FRAGMENT_LEVEL_SHIFT) % 2 === 1

		if (offset <= start) return rtl ? left + width : left

		x = rtl ? left : left + width

		if (offset >= end) continue

		const font = page.styles[data.fragmentInts[k * FRAGMENT_INTS + FragmentInt.STYLE] ?? -1]?.font
		const whole = measure === undefined || font === undefined ? 0 : measure(font, text.slice(start, end))
		const share =
			whole > 0 && measure !== undefined && font !== undefined
				? measure(font, text.slice(start, offset)) / whole
				: (offset - start) / Math.max(1, end - start)
		const along = width * Math.min(1, Math.max(0, share))

		return rtl ? left + width - along : left + along
	}

	return x
}

// The lines of a run (charRg offsets, inclusive) on its shape's text page: per line its extent; a run that reaches a
// line's start or end extends BAND_REACH past it, so neighbouring runs share every glyph exactly once. A paragraph's
// generated marker (bullet or number) belongs to its first letter.
export function runClips(
	layer: SlideLayer,
	starts: Int32Array,
	range: readonly [number, number],
	measure: TextMeasure | undefined
): RunClip[] {
	const page = layer.text

	if (page === undefined) return []

	const data = page.page
	let paragraph = 0

	while (paragraph + 2 < starts.length && (starts[paragraph + 1] ?? 0) <= range[0]) paragraph++

	const begin = starts[paragraph] ?? 0
	const length = (starts[paragraph + 1] ?? begin + 1) - begin - 1
	const text = data.sourceTexts[paragraph] ?? ""
	const marker = Math.max(0, text.length - length)
	const from = range[0] - begin <= 0 ? 0 : marker + range[0] - begin
	const to = range[1] - begin + 1 >= length ? Number.POSITIVE_INFINITY : marker + range[1] - begin + 1
	const out: RunClip[] = []

	for (let line = 0; line < data.lineCount; line++) {
		const li = line * LINE_INTS

		if ((data.lineInts[li + LineInt.SOURCE] ?? -1) !== paragraph) continue

		const start = data.lineInts[li + LineInt.TEXT_START] ?? 0
		const end = data.lineInts[li + LineInt.TEXT_END] ?? 0

		if (to <= start || (from >= end && end > start)) continue

		const rtl = ((data.lineInts[li + LineInt.FLAGS] ?? 0) & LineFlag.RTL) !== 0
		const a = from <= start ? (rtl ? BAND_REACH : -BAND_REACH) : lineOffsetX(page, line, from, measure)
		const b = to >= end ? (rtl ? -BAND_REACH : BAND_REACH) : lineOffsetX(page, line, to, measure)

		out.push([line, Math.min(a, b), Math.max(a, b)])
	}

	return out
}

// What a run paints (slide px), its lines widened by `reach` of their height; without bleed, the glyph box.
function clipBounds(layer: SlideLayer, clips: readonly RunClip[], bleed: boolean): Box | undefined {
	const data = layer.text?.page

	if (data === undefined) return undefined

	let effects = 0

	if (bleed) for (const list of layer.text?.textEffects ?? []) effects = Math.max(effects, effectReach(list))

	let box: Box | undefined

	for (const [line, x0, x1] of clips) {
		const lf = line * LINE_FLOATS
		const top = data.lineFloats[lf + LineFloat.TOP] ?? 0
		const height = data.lineFloats[lf + LineFloat.HEIGHT] ?? 0
		const left = data.lineFloats[lf + LineFloat.X] ?? 0
		const width = data.lineFloats[lf + LineFloat.WIDTH] ?? 0
		const reach = bleed ? Math.max(height * TEXT_BLEED, effects) : 0
		const a = Math.max(x0, left - reach)
		const b = Math.min(x1, left + width + reach)

		if (b <= a) continue

		box = union(box, transformRect(layer.textMatrix ?? layer.matrix, a, top - reach, b, top + height + reach))
	}

	return box
}

// Per layer of an index, its run's glyph box (EMU) where it is a run of text; NaN otherwise.
export function runBoxes(layers: LayerIndex, render: SlideRender, shapes: readonly ShapeNode[], measure?: TextMeasure): Float64Array {
	const out = new Float64Array(layers.shapes.length * 4).fill(Number.NaN)
	const starts = new Map<number, Int32Array | undefined>()

	layers.shapes.forEach((shape, k) => {
		const range = layers.ranges?.[k]

		if (range?.unit !== "char" || range.start < 0) return

		if (!starts.has(shape)) {
			const body = findShape(shapes, shape)?.text

			starts.set(shape, body === undefined ? undefined : paragraphStarts(body))
		}

		const layer = textLayerOf(render, shape)
		const offsets = starts.get(shape)

		if (layer === undefined || offsets === undefined) return

		const box = clipBounds(layer, runClips(layer, offsets, [range.start, range.end], measure), false)

		if (box !== undefined)
			out.set([box[0] * EMU_PER_PX, box[1] * EMU_PER_PX, (box[2] - box[0]) * EMU_PER_PX, (box[3] - box[1]) * EMU_PER_PX], k * 4)
	})

	return out
}

// --- Geometry and colours ---

// The axis-aligned bounds of the rect (x0, y0)–(x1, y1) under `matrix`.
function transformRect(matrix: readonly number[], x0: number, y0: number, x1: number, y1: number): Box {
	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = matrix
	let minX = Number.POSITIVE_INFINITY
	let minY = Number.POSITIVE_INFINITY
	let maxX = Number.NEGATIVE_INFINITY
	let maxY = Number.NEGATIVE_INFINITY

	for (const [x, y] of [
		[x0, y0],
		[x1, y0],
		[x0, y1],
		[x1, y1]
	] as const) {
		const px = a * x + c * y + e
		const py = b * x + d * y + f

		minX = Math.min(minX, px)
		minY = Math.min(minY, py)
		maxX = Math.max(maxX, px)
		maxY = Math.max(maxY, py)
	}

	return [minX, minY, maxX, maxY]
}

function union(a: Box | undefined, b: Box): Box {
	return a === undefined ? b : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

// The boxes (EMU) of the shapes `ids` as the slide renders them: a top-level shape's resolved box, a group child's
// drawn extent; flat id, x, y, cx, cy quintuples.
export function shapeGeometry(render: SlideRender, ids: Iterable<number>): Float64Array {
	const out: number[] = []

	for (const id of ids) {
		const own = render.layers.find(layer => layer.shape.slide === render.ref && layer.box?.id === id)

		if (own?.box !== undefined) {
			out.push(id, own.box.xfrm.x, own.box.xfrm.y, own.box.xfrm.cx, own.box.xfrm.cy)

			continue
		}

		let box: Box | undefined

		for (const layer of render.layers) {
			if (layer.shape.slide === render.ref && layer.shape.id === id)
				box = union(box, transformRect(layer.matrix, 0, 0, layer.drawing.width, layer.drawing.height))
		}

		if (box !== undefined)
			out.push(id, box[0] * EMU_PER_PX, box[1] * EMU_PER_PX, (box[2] - box[0]) * EMU_PER_PX, (box[3] - box[1]) * EMU_PER_PX)
	}

	return Float64Array.from(out)
}

function isColor(value: unknown): value is ColorModel {
	return typeof value === "object" && value !== null && "kind" in value && typeof value.kind === "string"
}

// Every colour value of the timing (animClr from/to/by, set to, anim values).
function timingColors(timing: TimingTree | undefined): ColorModel[] {
	const out: ColorModel[] = []

	forEachBehavior(timing, behavior => {
		switch (behavior.type) {
			case "animClr":
				for (const value of [behavior.from, behavior.to, behavior.by]) if (isColor(value)) out.push(value)
				break
			case "set":
				if (isColor(behavior.to)) out.push(behavior.to)
				break
			case "anim":
				for (const tav of behavior.tavLst) if (isColor(tav.val)) out.push(tav.val)
				break
			default:
				break
		}
	})

	return out
}

// Per layer, the layer it moves with: a paragraph range its shape's whole layer, a shape the whole layer of its nearest
// ancestor the timing animates; -1 for none.
export function layerParents(layers: LayerIndex, shapes: readonly ShapeNode[]): Int32Array {
	const chains = ancestry(shapes)
	const whole = new Map<number, number>()
	const out = new Int32Array(layers.shapes.length).fill(-1)

	layers.shapes.forEach((shape, k) => {
		if (layers.ranges?.[k] === undefined && !whole.has(shape)) whole.set(shape, k)
	})
	layers.shapes.forEach((shape, k) => {
		const range = layers.ranges?.[k]

		if (range !== undefined) {
			out[k] = whole.get(shape) ?? -1

			// A run moves with the paragraph layer that holds it.
			const paragraph = layers.runs?.[k * RUN_INTS + RunInt.PARAGRAPH] ?? -1

			if (range.unit === "char" && paragraph >= 0) {
				layers.shapes.forEach((other, j) => {
					const held = layers.ranges?.[j]

					if (other === shape && held?.unit === "para" && held.start <= paragraph && paragraph <= held.end) out[k] = j
				})
			}

			return
		}

		const chain = chains.get(shape) ?? []

		for (let at = chain.length - 2; at >= 0; at--) {
			const parent = whole.get(chain[at] ?? -1)

			if (parent !== undefined) {
				out[k] = parent

				return
			}
		}
	})

	return out
}

// --- Transitions of pptx slides (the model reads them with the slide; this reads a part's element directly) ---

// The 21 ECMA-376 Part 1 §19.7 transitions the stage draws; any other (p14, p15) plays the file's mc:Fallback.
const ECMA_TRANSITIONS: ReadonlySet<string> = new Set([
	"blinds",
	"checker",
	"circle",
	"comb",
	"cover",
	"cut",
	"diamond",
	"dissolve",
	"fade",
	"newsflash",
	"plus",
	"pull",
	"push",
	"random",
	"randomBar",
	"split",
	"strips",
	"wedge",
	"wheel",
	"wipe",
	"zoom"
])
// Whether the stage draws a transition kind itself (others play their fallback).
function stageDraws(kind: string, namespace: Transition["namespace"]): boolean {
	return namespace === "p" && ECMA_TRANSITIONS.has(kind)
}

// p:transition spd (PowerPoint's durations, as the ODP reader's presentation:transition-speed).
const SPEED_MS: Readonly<Record<string, number>> = { slow: 1000, med: 750, fast: 500 }
const OPTIONS = ["dir", "orient", "spokes", "thruBlk", "pattern", "invX", "invY"] as const

function readTransitionElement(r: PartReader, transition: number): Transition | undefined {
	let kind: string | undefined
	let namespace: Transition["namespace"] = "p"
	const options: Record<string, string | number | boolean> = {}

	for (let child = r.first(transition); child >= 0; child = r.next(child)) {
		const group = r.group(child)
		const local = r.local(child)

		if ((group !== G.P && group !== G.P14 && group !== G.P15) || local === "sndAc" || local === "extLst") continue

		kind = group === G.P15 && local === "prstTrans" ? (r.attr(child, "prst") ?? "prstTrans") : local
		namespace = group === G.P14 ? "p14" : group === G.P15 ? "p15" : "p"

		for (const name of OPTIONS) {
			const value = r.attr(child, name)

			if (value === undefined) continue

			options[name] = value === "true" || value === "1" ? true : value === "false" || value === "0" ? false : value
		}

		break
	}

	const speed = r.attr(transition, "spd")
	const duration = Number(r.attrNs(transition, G.P14, "dur") ?? Number.NaN)
	const after = Number(r.attr(transition, "advTm") ?? Number.NaN)
	const click = r.attr(transition, "advClick")

	return {
		kind: kind ?? "cut",
		namespace,
		options,
		durationMs: Number.isFinite(duration) && duration >= 0 ? duration : (SPEED_MS[speed ?? "fast"] ?? 500),
		...(speed === "slow" || speed === "med" || speed === "fast" ? { speed } : {}),
		advance: { onClick: click !== "false" && click !== "0", ...(Number.isFinite(after) && after >= 0 ? { afterMs: after } : {}) }
	}
}

// A pptx slide's p:transition (ECMA-376 Part 1 §19.3.1.50), directly under p:sld or in an mc:AlternateContent: the
// Choice's when the stage draws its kind, else the Fallback's (as an application without the Choice plays it);
// undefined without one.
export function pptxTransition(document: XmlDocument): Transition | undefined {
	const r = new PartReader(document)
	const root = document.documentElement()

	for (let child = r.first(root); child >= 0; child = r.next(child)) {
		if (r.is(child, G.P, "transition")) return readTransitionElement(r, child)
		if (!r.is(child, G.MC, "AlternateContent")) continue

		let choice: Transition | undefined
		let fallback: Transition | undefined

		for (let branch = r.first(child); branch >= 0; branch = r.next(branch)) {
			const transition = r.child(branch, G.P, "transition")

			if (transition < 0) continue
			if (r.is(branch, G.MC, "Choice")) choice ??= readTransitionElement(r, transition)
			else if (r.is(branch, G.MC, "Fallback")) fallback = readTransitionElement(r, transition)
		}

		if (choice !== undefined && (ECMA_TRANSITIONS.has(choice.kind) || fallback === undefined)) return choice
		if (fallback !== undefined) return fallback
	}

	return undefined
}

// --- Renders, kept for the timegraph and layers calls of a slide the page is about to show ---

interface HeldRender {
	readonly ref: SlideRef
	readonly key: string
	readonly render: SlideRender
}

// Renders kept per session (never sent: a sent render's arrays are transferred).
const KEPT_RENDERS = 2
const renders = new WeakMap<EngineSession, HeldRender[]>()

async function slideRender(context: CallContext, ref: SlideRef): Promise<{ readonly node: SlideNode; readonly render: SlideRender }> {
	const session = context.session
	const parts = viewParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "show")
	if (!session.deck.slides.includes(ref)) throw new PresentationError("notFound", "slide")

	const parsed = await parts.slide(ref, context.slicing)
	const held = renders.get(session)
	const key = (node: SlideNode): string => `${String(session.deck.revision)}:${String(node.revision)}`
	const found = held?.find(entry => entry.ref === ref && entry.key === key(parsed))

	if (found !== undefined) return { node: parsed, render: found.render }

	const render = await renderSlideFor(context, ref)
	const node = session.deck.nodes.get(ref) ?? parsed

	if (held === undefined) session.onClose(() => renders.delete(session))

	renders.set(session, [{ ref, key: key(node), render }, ...(held ?? []).filter(entry => entry.ref !== ref)].slice(0, KEPT_RENDERS))

	return { node, render }
}

// --- timegraph ---

async function timegraph(context: CallContext, ref: SlideRef): Promise<CompiledTimegraph> {
	const session = context.session
	const parts = viewParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "show")

	const { node, render } = await slideRender(context, ref)
	const timing = node.timing
	const runs = planRuns(timing, node.shapes)
	const index = showLayerIndex(timing, runs)
	// A run's own box: by-letter formulas (#ppt_x, #ppt_w) and scale or spin centres are the letter's.
	const layers = runs.length === 0 ? index : { ...index, boxes: runBoxes(index, render, node.shapes, canvasMeasure()) }
	const theme = themeOf(session.deck.nodes, node)
	const colorContext = {
		theme: theme === undefined ? undefined : parts.theme(theme.part),
		clrMap: effectiveClrMap(session.deck.nodes, node)
	}
	const colors = new Map<string, Rgba>()

	for (const color of timingColors(timing)) {
		const key = JSON.stringify(color)

		if (colors.has(key)) continue

		const resolved = resolveColor(color, colorContext)

		if (resolved !== undefined) colors.set(key, toRgba(resolved))
	}

	const authored = node.transition
	const pptx = pptxParts(session.deck)
	const document = pptx === undefined ? undefined : parts.document(node.part)
	const fallback =
		authored === undefined || document === undefined || pptx === undefined ? undefined : fileFallback(authored, document, pptx.epoch)
	const transition = authored === undefined ? undefined : playableTransition(authored, stageDraws, fallback)
	const source: TimegraphSource = {
		timing,
		layers,
		parents: layerParents(layers, node.shapes),
		slideSize: { cx: session.deck.size.cx, cy: session.deck.size.cy },
		geometry: shapeGeometry(render, new Set(layers.shapes)),
		colors: [...colors],
		...(transition === undefined ? {} : { transition }),
		...(authored === undefined || authored === transition ? {} : { authored })
	}
	// Compiled here once so a hostile tree is refused before the page plays it.
	const graph = compileSource(ref, source, parts.budgets.timing)

	return { slide: graph.slide, mainSteps: graph.mainSteps, interactive: graph.interactive, tracks: graph.tracks, source }
}

// --- layers ---

// One thing painted into an output layer: a render layer whole, or its text clipped to bands (text px, top..bottom).
export interface LayerPiece {
	readonly layer: SlideLayer
	readonly bands?: readonly (readonly [number, number])[]
	// A run's lines, each painted alone and clipped to the run's extent across it.
	readonly clips?: readonly RunClip[]
}

export interface PlannedLayer {
	readonly shape: number
	readonly range?: Range
	// Paints the slide's background first (the first static run).
	readonly background: boolean
	readonly pieces: LayerPiece[]
	// Slide px: x0, y0, x1, y1.
	bounds: Box
}

// Per shape id, its ancestors' ids then its own (outermost first).
function ancestry(shapes: readonly ShapeNode[]): Map<number, number[]> {
	const out = new Map<number, number[]>()
	const stack: { shape: ShapeNode; chain: readonly number[] }[] = shapes.map(shape => ({ shape, chain: [] }))

	for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
		const chain = [...item.chain, item.shape.id]

		out.set(item.shape.id, chain)

		for (const child of item.shape.children ?? []) stack.push({ shape: child, chain })
	}

	return out
}

// Per paragraph of a layer's text page, the top of its first line (text px), in paragraph order.
export function paragraphTops(layer: SlideLayer): Map<number, number> {
	const page = layer.text?.page
	const tops = new Map<number, number>()

	if (page === undefined) return tops

	for (let line = 0; line < page.lineCount; line++) {
		const source = page.lineInts[line * 7 + 5] ?? 0
		const top = page.lineFloats[line * 5] ?? 0
		const held = tops.get(source)

		if (held === undefined || top < held) tops.set(source, top)
	}

	return new Map([...tops].sort((a, b) => a[0] - b[0]))
}

// The bands of the paragraphs `wanted`: each from its first line's top to the next laid-out paragraph's (the first
// from far above, the last to far below), touching bands merged.
export function paragraphBands(tops: ReadonlyMap<number, number>, wanted: (paragraph: number) => boolean): [number, number][] {
	const entries = [...tops]
	const out: [number, number][] = []

	entries.forEach(([paragraph, top], k) => {
		if (!wanted(paragraph)) return

		const from = k === 0 ? -BAND_REACH : top
		const to = k + 1 < entries.length ? (entries[k + 1]?.[1] ?? BAND_REACH) : BAND_REACH
		const last = out[out.length - 1]

		if (last !== undefined && last[1] === from) last[1] = to
		else out.push([from, to])
	})

	return out
}

function effectReach(effects: RenderEffects | undefined): number {
	let reach = 0

	for (const effect of effects ?? []) {
		if (effect.kind === "outerShadow") reach = Math.max(reach, Math.abs(effect.dx) + Math.abs(effect.dy) + 2 * effect.blur)
		else if (effect.kind === "glow" || effect.kind === "blur") reach = Math.max(reach, 2 * effect.radius)
	}

	return reach
}

function textBounds(layer: SlideLayer, bands: readonly (readonly [number, number])[] | undefined): Box | undefined {
	const text = layer.text

	if (text === undefined) return undefined

	const page = text.page
	let x0 = 0
	let y0 = 0
	let x1 = page.width
	let y1 = page.height
	let lineHeight = 0

	for (let line = 0; line < page.lineCount; line++) {
		const top = page.lineFloats[line * 5] ?? 0
		const height = page.lineFloats[line * 5 + 1] ?? 0
		const x = page.lineFloats[line * 5 + 3] ?? 0
		const width = page.lineFloats[line * 5 + 4] ?? 0

		x0 = Math.min(x0, x)
		x1 = Math.max(x1, x + width)
		y0 = Math.min(y0, top)
		y1 = Math.max(y1, top + height)
		lineHeight = Math.max(lineHeight, height)
	}

	let reach = lineHeight * TEXT_BLEED

	for (const effects of text.textEffects) reach = Math.max(reach, effectReach(effects))

	if (bands !== undefined && bands.length > 0) {
		y0 = Math.max(y0, bands[0]?.[0] ?? y0)
		y1 = Math.min(y1, bands[bands.length - 1]?.[1] ?? y1)
	}

	return transformRect(layer.textMatrix ?? layer.matrix, x0 - reach, y0 - reach, x1 + reach, y1 + reach)
}

// What a drawing paints (drawing px): its frame, and every item's extent past it (a callout's pointer, a line's
// arrowhead): a path's extrema widened by half its stroke, an image's or text's local box, each under its matrix.
export function drawingExtent(drawing: DrawingData): Box {
	let box: Box = [0, 0, drawing.width, drawing.height]
	const count = Math.min(drawing.itemCount, Math.floor(drawing.itemInts.length / ITEM_INTS))

	for (let item = 0; item < count; item++) {
		const f = item * ITEM_FLOATS
		const i = item * ITEM_INTS
		const m = drawing.itemFloats.subarray(f, f + 6)
		const [a = 1, b = 0, c = 0, d = 1, e = 0, ff = 0] = m
		let x0 = Number.POSITIVE_INFINITY
		let y0 = Number.POSITIVE_INFINITY
		let x1 = Number.NEGATIVE_INFINITY
		let y1 = Number.NEGATIVE_INFINITY
		const add = (x: number, y: number): void => {
			const tx = a * x + c * y + e
			const ty = b * x + d * y + ff

			x0 = Math.min(x0, tx)
			y0 = Math.min(y0, ty)
			x1 = Math.max(x1, tx)
			y1 = Math.max(y1, ty)
		}
		const commands = drawing.itemInts[i + ItemInt.COMMAND_COUNT] ?? 0

		if ((drawing.itemInts[i + ItemInt.KIND] ?? 0) === ItemKind.PATH && commands > 0) {
			measurePath(
				drawing.commands,
				drawing.coords,
				drawing.itemInts[i + ItemInt.FIRST_COMMAND] ?? 0,
				commands,
				drawing.itemInts[i + ItemInt.FIRST_COORD] ?? 0,
				add
			)
		} else {
			const x = drawing.itemFloats[f + ItemFloat.X] ?? 0
			const y = drawing.itemFloats[f + ItemFloat.Y] ?? 0
			const w = drawing.itemFloats[f + ItemFloat.WIDTH] ?? 0
			const h = drawing.itemFloats[f + ItemFloat.HEIGHT] ?? 0

			add(x, y)
			add(x + w, y + h)
			add(x + w, y)
			add(x, y + h)
		}

		if (x0 > x1) continue

		const stroke = drawing.strokes[drawing.itemInts[i + ItemInt.STROKE] ?? -1]
		const half = stroke === undefined ? 0 : (stroke.width / 2) * Math.max(Math.hypot(a, b), Math.hypot(c, d))

		box = union(box, [x0 - half, y0 - half, x1 + half, y1 + half])
	}

	return box
}

function pieceBounds(piece: LayerPiece): Box | undefined {
	const layer = piece.layer
	let box: Box | undefined

	if (piece.clips !== undefined) return clipBounds(layer, piece.clips, true)

	if (piece.bands === undefined) {
		const reach = effectReach(layer.effects)
		const [dx0, dy0, dx1, dy1] = drawingExtent(layer.drawing)
		const [x0, y0, x1, y1] = transformRect(layer.matrix, dx0, dy0, dx1, dy1)
		const reflection = layer.effects?.find(effect => effect.kind === "reflection")
		// A reflection mirrors the drawing below its bottom edge.
		const below = reflection === undefined ? 0 : y1 - y0 + reflection.distance

		box = [x0 - reach, y0 - reach, x1 + reach, y1 + reach + below]
	}

	const text = textBounds(layer, piece.bands)

	return text === undefined ? box : union(box, text)
}

// The output layers of a render for a plan, in z-order: static runs (shape -1, the first with the background) and the
// planned shapes' layers, each with its bounds (slide px, kept within one slide size around the slide).
export function planShowLayers(
	render: SlideRender,
	node: SlideNode,
	plan: LayerPlan,
	slide: { readonly w: number; readonly h: number },
	measure?: TextMeasure
): PlannedLayer[] {
	const planned = new Set(plan.shapes)
	const rangesOf = new Map<number, readonly Range[]>()

	plan.shapes.forEach((shape, k) => {
		const ranges = plan.ranges?.[k]

		if (ranges !== undefined && ranges.length > 0) rangesOf.set(shape, ranges)
	})

	const chains = ancestry(node.shapes)
	const out: PlannedLayer[] = [{ shape: STATIC_LAYER, background: true, pieces: [], bounds: [0, 0, 0, 0] }]
	const output = (shape: number, range: Range | undefined): PlannedLayer => {
		const last = out[out.length - 1]

		if (
			last !== undefined &&
			last.shape === shape &&
			last.range?.target === range?.target &&
			last.range?.range[0] === range?.range[0] &&
			last.range?.range[1] === range?.range[1]
		)
			return last

		const made: PlannedLayer = { shape, ...(range === undefined ? {} : { range }), background: false, pieces: [], bounds: [0, 0, 0, 0] }

		out.push(made)

		return made
	}

	for (const layer of render.layers) {
		const chain =
			layer.shape.slide === render.ref ? (chains.get(layer.shape.id) ?? [layer.box?.id ?? layer.shape.id, layer.shape.id]) : []
		let owner = STATIC_LAYER

		// The innermost planned shape the layer is part of.
		for (const id of chain) if (planned.has(id)) owner = id

		const ranges = owner === layer.shape.id && layer.text !== undefined ? rangesOf.get(owner) : undefined

		if (ranges === undefined) {
			output(owner, undefined).pieces.push({ layer })

			continue
		}

		const tops = paragraphTops(layer)
		const paragraphs = ranges.filter(range => range.target === "para")
		const runs = ranges.filter(range => range.target === "char" && range.range[0] >= 0)
		const drawingRun = ranges.find(range => range.target === "char" && range.range[0] < 0)
		const body = runs.length === 0 ? undefined : findShape(node.shapes, owner)?.text
		const starts = body === undefined ? undefined : paragraphStarts(body)
		// Paragraphs laid out as runs: their text paints only in the runs.
		const split = new Set<number>()

		if (starts !== undefined) {
			for (const { range } of runs) {
				let paragraph = 0

				while (paragraph + 2 < starts.length && (starts[paragraph + 1] ?? 0) <= range[0]) paragraph++

				split.add(paragraph)
			}
		}

		const covered = (paragraph: number): boolean =>
			split.has(paragraph) || paragraphs.some(({ range }) => paragraph >= range[0] && paragraph <= range[1])
		const { text: _text, ...drawing } = layer

		// The drawing under every text layer of its shape.
		if (drawingRun !== undefined) output(owner, drawingRun).pieces.push({ layer: drawing })

		const whole = output(owner, undefined)
		const rest = paragraphBands(tops, paragraph => !covered(paragraph))

		if (drawingRun === undefined) whole.pieces.push({ layer: drawing })
		if (rest.length > 0) whole.pieces.push({ layer, bands: rest })

		for (const range of paragraphs) {
			const bands = paragraphBands(
				tops,
				paragraph => paragraph >= range.range[0] && paragraph <= range.range[1] && !split.has(paragraph)
			)

			if (bands.length > 0) output(owner, range).pieces.push({ layer, bands })
		}

		if (starts === undefined) continue

		for (const range of runs) {
			const clips = runClips(layer, starts, range.range, measure)

			if (clips.length > 0) output(owner, range).pieces.push({ layer, clips })
		}
	}

	const reachX = slide.w * REACH
	const reachY = slide.h * REACH

	for (const layer of out) {
		let box: Box | undefined = layer.background ? [0, 0, slide.w, slide.h] : undefined

		for (const piece of layer.pieces) {
			const bounds = pieceBounds(piece)

			if (bounds !== undefined) box = union(box, bounds)
		}

		const [x0, y0, x1, y1] = box ?? [0, 0, 0, 0]

		layer.bounds = [
			Math.floor(Math.max(-reachX, x0)),
			Math.floor(Math.max(-reachY, y0)),
			Math.ceil(Math.min(slide.w + reachX, x1)),
			Math.ceil(Math.min(slide.h + reachY, y1))
		]
	}

	return out
}

// The device px per slide px each layer is drawn at: `scale`, lowered for all when their bitmaps would pass the byte
// budget, and for one whose side would pass the canvas limit.
export function layerScales(layers: readonly PlannedLayer[], scale: number, budget: number = SHOW_LAYER_BYTES): number[] {
	let bytes = 0

	for (const layer of layers)
		bytes += Math.max(0, layer.bounds[2] - layer.bounds[0]) * Math.max(0, layer.bounds[3] - layer.bounds[1]) * scale * scale * 4

	const shared = bytes > budget ? scale * Math.sqrt(budget / bytes) : scale

	return layers.map(layer =>
		Math.min(shared, MAX_CANVAS_SIDE / Math.max(layer.bounds[2] - layer.bounds[0], layer.bounds[3] - layer.bounds[1], 1))
	)
}

const EMPTY = drawingData(new DrawingList())

function paintLayer(
	ctx: Parameters<typeof paintSlideCanvas>[0],
	render: SlideRender,
	layer: PlannedLayer,
	scale: number,
	images: Parameters<typeof paintSlideCanvas>[3]
): void {
	const origin = { x: layer.bounds[0], y: layer.bounds[1] }

	if (layer.background) paintSlideCanvas(ctx, { ...render, layers: [] }, scale, images, origin)

	for (const piece of layer.pieces) {
		const text = piece.layer.text

		if (piece.clips !== undefined && text !== undefined) {
			paintRun(
				ctx,
				text,
				multiply([scale, 0, 0, scale, -origin.x * scale, -origin.y * scale], piece.layer.textMatrix ?? piece.layer.matrix),
				piece.clips
			)

			continue
		}

		if (piece.bands === undefined || text === undefined) {
			paintSlideCanvas(ctx, { ...render, background: EMPTY, layers: [piece.layer] }, scale, images, origin)

			continue
		}

		const m = multiply([scale, 0, 0, scale, -origin.x * scale, -origin.y * scale], piece.layer.textMatrix ?? piece.layer.matrix)

		ctx.save()
		ctx.setTransform(m[0] ?? 1, m[1] ?? 0, m[2] ?? 0, m[3] ?? 1, m[4] ?? 0, m[5] ?? 0)
		ctx.beginPath()

		for (const [top, bottom] of piece.bands) ctx.rect(-BAND_REACH, top, 2 * BAND_REACH, bottom - top)

		ctx.clip()
		paintTextPageCanvas(ctx, text, m)
		ctx.restore()
	}
}

// A run: each of its lines painted alone (a page of that one line, its decorations only), clipped to the run's extent.
function paintRun(ctx: Parameters<typeof paintSlideCanvas>[0], text: TextPage, m: readonly number[], clips: readonly RunClip[]): void {
	const data = text.page

	for (const [line, x0, x1] of clips) {
		const lf = line * LINE_FLOATS
		const li = line * LINE_INTS
		const top = data.lineFloats[lf + LineFloat.TOP] ?? 0
		const height = data.lineFloats[lf + LineFloat.HEIGHT] ?? 0
		const next = line + 1 < data.lineCount ? (data.lineInts[li + LINE_INTS + LineInt.FIRST_DECORATION] ?? 0) : data.decorationCount
		const page: TextPage = {
			...text,
			page: {
				...data,
				lineCount: 1,
				lineFloats: data.lineFloats.subarray(lf, lf + LINE_FLOATS),
				lineInts: data.lineInts.subarray(li, li + LINE_INTS),
				decorationCount: next
			}
		}

		ctx.save()
		ctx.setTransform(m[0] ?? 1, m[1] ?? 0, m[2] ?? 0, m[3] ?? 1, m[4] ?? 0, m[5] ?? 0)
		ctx.beginPath()
		// Glyphs reach past their line box (accents, descenders): a line's height above and below.
		ctx.rect(x0, top - height, x1 - x0, 3 * height)
		ctx.clip()
		paintTextPageCanvas(ctx, page, m)
		ctx.restore()
	}
}

async function layers(context: CallContext, ref: SlideRef, widthPx: number, plan: LayerPlan): Promise<readonly ShowLayer[]> {
	const realm = presentationRealm()

	if (realm === undefined) throw new PresentationError("notImplemented", "show layers need a canvas realm")

	const session = context.session
	const parts = viewParts(session.deck)

	if (parts === undefined) throw new PresentationError("notImplemented", "show")
	if (
		!(widthPx >= MIN_STAGE_WIDTH && widthPx <= MAX_STAGE_WIDTH) ||
		!(plan.dpr > 0 && plan.dpr <= 4) ||
		plan.shapes.length > parts.budgets.shapesPerSlide
	)
		throw new PresentationError("tooLarge", "show layers")

	const { node, render } = await slideRender(context, ref)
	const slide = { w: session.deck.size.cx / EMU_PER_PX, h: session.deck.size.cy / EMU_PER_PX }
	const scale = Math.min((widthPx * plan.dpr) / slide.w, MAX_CANVAS_SIDE / slide.w)
	const planned = planShowLayers(render, node, plan, slide, canvasMeasure())
	const scales = layerScales(planned, scale)
	const pictures = await decodeSlidePictures(
		render,
		{
			canvas: realm.canvas,
			size: session.deck.size,
			widthPx: slide.w * scale,
			read: part => readPart(session, part),
			pictures: sessionPictures(session)
		},
		Math.min(4096, Math.ceil(slide.w * scale * 2))
	)
	const out: ShowLayer[] = []
	const clock = sliceClock(context.slicing)

	try {
		for (let k = 0; k < planned.length; k++) {
			if (context.signal.aborted) throw new PresentationError("aborted", "show layers")

			const layer = planned[k] as PlannedLayer
			const layerScale = scales[k] ?? scale
			const width = layer.bounds[2] - layer.bounds[0]
			const height = layer.bounds[3] - layer.bounds[1]

			if (width <= 0 || height <= 0) continue

			const canvas = realm.canvas.canvas(Math.max(1, Math.ceil(width * layerScale)), Math.max(1, Math.ceil(height * layerScale)))
			const ctx = canvas?.getContext("2d") ?? null

			if (canvas === undefined || ctx === null) throw new PresentationError("tooLarge", "show layer canvas")

			paintLayer(ctx, render, layer, layerScale, pictures.images)
			out.push({
				shape: layer.shape,
				...(layer.range === undefined ? {} : { range: layer.range }),
				bitmap: canvas.transferToImageBitmap(),
				x: layer.bounds[0],
				y: layer.bounds[1],
				width,
				height
			})

			if (clock.due) await clock.pause()
		}
	} catch (error) {
		for (const layer of out) layer.bitmap.close()

		throw error
	} finally {
		pictures.release()
	}

	return out
}

export const showCapability: ShowCapability = { timegraph, layers }
