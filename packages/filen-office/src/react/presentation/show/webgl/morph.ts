import { DRAWING_RUN } from "../../../../core/anim/runs"
import {
	matchPlanned,
	matchTokens,
	morphEase,
	morphOption,
	morphPlacement,
	morphRank,
	morphTokens,
	ATLAS_PAGE_PX,
	packAtlas,
	planMorph,
	type MorphBox,
	type MorphPlan,
	type MorphShape,
	type MorphToken,
	type MorphVector
} from "../../../../core/anim/morph"
import type { TimegraphSource, Transition } from "../../../../core/anim/model"
import type { SlideRef } from "../../../../core/presentation/model"
import type { LayerPlan, ShowLayer } from "../../../../dom/presentation/protocol"
import { hasWebgl2, invert, mat3, multiply, type Affine, type GlDevice, type GlTexture } from "./device"
import { pixels } from "./particles"
import { drawVectorAt, vectorBox, vectorPlan, type VectorPlan } from "./vector"
import type { ShowTransitionContext, ShowTransitionRequest, ShowTransitionRun } from "./types"

// Morph on the stage (core/anim/morph.ts matches and places): both slides' objects as their own layer bitmaps from
// the worker, drawn before the run (so a frame only draws), with words or characters split out for byWord and
// byChar. A frame draws the outgoing and incoming backgrounds mixed, then every element in its interpolated z order:
// a matched pair as one quad that mixes the outgoing object's texture and the incoming one's, each undone from its own
// box and placed in the interpolated one (so position, size, rotation and flips move, and colour and geometry blend
// exactly by the eased progress); unmatched objects fade out or in where they are. At 0 the frame is the outgoing
// slide, at 1 the incoming one.

// The longest upload slice before the next one waits for a macrotask.
const SLICE_MS = 6
// Texture bytes both slides' layers may take together: past it they are drawn at a lower pixel ratio.
export const MORPH_LAYER_BYTES = 64 * 1024 * 1024

// The pixel ratio both slides' layers are drawn at: the stage's, lowered so their bitmaps (each object's box with a
// margin for its effects, twice for one with text, and the slide's background, at the stage's scale) fit
// MORPH_LAYER_BYTES.
export function morphPixelRatio(
	sides: readonly (readonly MorphShape[])[],
	slide: { readonly w: number; readonly h: number },
	widthPx: number,
	dpr: number
): number {
	const scale = (widthPx * dpr) / Math.max(1, slide.w)
	let area = 0

	for (const shapes of sides) {
		area += slide.w * slide.h

		for (const shape of shapes) {
			const reach = Math.hypot(shape.w, shape.h)

			// Its words or characters, split out, cover its text again.
			area += (reach + 16) * (reach + 16) * (shape.text === undefined ? 1 : 2)
		}
	}

	const bytes = area * scale * scale * 4

	return bytes <= MORPH_LAYER_BYTES ? dpr : dpr * Math.sqrt(MORPH_LAYER_BYTES / bytes)
}

// One layer bitmap, at its bounds (slide px), and where it is in its atlas page (uv).
export interface Piece {
	readonly page: GlTexture
	readonly u0: number
	readonly v0: number
	readonly u1: number
	readonly v1: number
	readonly x: number
	readonly y: number
	readonly w: number
	readonly h: number
	// It draws its object's shape without text (what a redrawn outline replaces).
	readonly drawing?: boolean
}

export interface MorphSide {
	readonly ref: SlideRef
	// The atlas pages its pieces are in.
	readonly pages: GlTexture[]
	readonly source: TimegraphSource
	readonly shapes: readonly MorphShape[]
	// The layers of no object (the background with the layout's and master's shapes).
	readonly statics: Piece[]
	// Per object (index into shapes), its layers.
	readonly objects: Piece[][]
	readonly tokens: readonly MorphToken[]
	readonly tokenPieces: (Piece | undefined)[]
}

export interface MorphData {
	readonly from: MorphSide
	readonly to: MorphSide
	// How the two slides' objects match, all but what is on stage at the start (made here, off the click).
	readonly plan: MorphPlan
	// The elements when every object of both slides is on stage (the common start), made here too.
	readonly whole?: readonly MorphElement[]
	// The run's instance buffer and outline texture, made here so the first frame waits for no GPU check.
	readonly gpu?: {
		readonly buffers: MorphBuffers
		readonly outline: GlTexture | undefined
		// The whole start's outlines at the stage's pixel ratio, and their canvas, made here.
		readonly outlines?: {
			readonly scale: number
			readonly slots: OutlineSlots
			readonly canvas: HTMLCanvasElement
			readonly context: CanvasRenderingContext2D
		}
	}
	readonly bytes: number
}

export function drawsMorph(kind: string, namespace: Transition["namespace"]): boolean {
	return namespace === "morph" && kind === "morph" && hasWebgl2()
}

function planOf(shapes: readonly MorphShape[], tokens: readonly MorphToken[], dpr: number): LayerPlan {
	const ranges: { target: "char"; range: [number, number] }[][] = shapes.map(() => [])

	for (const token of tokens) {
		const list = ranges[token.shape]

		if (list === undefined) continue
		if (list.length === 0) list.push({ target: "char", range: [DRAWING_RUN, DRAWING_RUN] })

		list.push({ target: "char", range: [token.start, token.end] })
	}

	// A plain shape with text: its outline may be redrawn, so its text comes on a layer of its own.
	shapes.forEach((shape, k) => {
		const list = ranges[k]

		if (shape.vector !== undefined && shape.text !== undefined && list?.length === 0)
			list.push({ target: "char", range: [DRAWING_RUN, DRAWING_RUN] })
	})

	const split = ranges.some(list => list.length > 0)

	return {
		shapes: shapes.map(shape => shape.id),
		...(split ? { ranges: ranges.map(list => (list.length === 0 ? undefined : list)) } : {}),
		dpr,
		// Many small layers: shared pages, as each bitmap transferred and uploaded costs (WebKit transfers one in
		// about half a millisecond).
		atlas: ATLAS_PAGE_PX
	}
}

function freeSide(device: GlDevice, side: Pick<MorphSide, "pages"> | undefined): void {
	if (side === undefined) return

	for (const page of side.pages) device.free(page)

	side.pages.length = 0
}

// Uploads the worker's atlas pages (each drawn into a 2D canvas first: a canvas uploads premultiplied in every
// engine, an ImageBitmap as its engine decides), one texture a page, and sorts the layers' places in them to the
// slide's objects and words.
async function sideOf(
	device: GlDevice,
	scratch: HTMLCanvasElement,
	ref: SlideRef,
	source: TimegraphSource,
	shapes: readonly MorphShape[],
	tokens: readonly MorphToken[],
	layers: readonly ShowLayer[],
	signal: { readonly aborted: boolean }
): Promise<MorphSide | undefined> {
	const index = new Map(shapes.map((shape, k) => [shape.id, k]))
	const tokenAt = new Map(tokens.map((token, k) => [`${String(token.shape)}:${String(token.start)}`, k]))
	const side: MorphSide = {
		ref,
		source,
		pages: [],
		shapes,
		statics: [],
		objects: shapes.map(() => []),
		tokens,
		tokenPieces: tokens.map(() => undefined)
	}
	// The distinct bitmaps (a page is shared by its layers), with their sizes read before they are closed.
	const bitmaps = [...new Set(layers.map(layer => layer.bitmap as unknown as ImageBitmap))]
	const sizes = new Map(bitmaps.map(bitmap => [bitmap, { w: bitmap.width, h: bitmap.height }]))
	const textures = new Map<ImageBitmap, GlTexture>()
	const context = scratch.getContext("2d")
	let failed = context === null
	let slice = performance.now()

	for (const bitmap of bitmaps) {
		// Uploads run in slices, so the slide on stage keeps animating while the next one is prepared.
		if (performance.now() - slice > SLICE_MS) {
			await new Promise<void>(resolve => setTimeout(resolve, 0))
			slice = performance.now()
		}

		failed ||= signal.aborted || device.lost

		const size = sizes.get(bitmap) ?? { w: 0, h: 0 }

		if (!failed && context !== null && size.w > 0 && size.h > 0) {
			scratch.width = size.w
			scratch.height = size.h
			context.clearRect(0, 0, size.w, size.h)
			context.drawImage(bitmap, 0, 0)

			const texture = device.upload(scratch, size.w, size.h)

			if (texture === undefined) failed = true
			else {
				side.pages.push(texture)
				textures.set(bitmap, texture)
			}
		}

		bitmap.close()
	}

	scratch.width = 0
	scratch.height = 0

	if (failed) {
		freeSide(device, side)

		return undefined
	}

	// In layer order, so a slide's statics stack as it does.
	for (const layer of layers) {
		const bitmap = layer.bitmap as unknown as ImageBitmap
		const page = textures.get(bitmap)
		const size = sizes.get(bitmap)

		if (page === undefined || size === undefined) continue

		const place = layer.atlas ?? { x: 0, y: 0, width: size.w, height: size.h }
		const shape = index.get(layer.shape)
		const range = layer.range
		const drawing = shape !== undefined && ((range !== undefined && range.range[0] < 0) || shapes[shape]?.text === undefined)
		const piece: Piece = {
			page,
			u0: place.x / size.w,
			v0: place.y / size.h,
			u1: (place.x + place.width) / size.w,
			v1: (place.y + place.height) / size.h,
			x: layer.x,
			y: layer.y,
			w: layer.width,
			h: layer.height,
			...(drawing ? { drawing } : {})
		}

		if (shape === undefined) side.statics.push(piece)
		else if (range !== undefined && range.range[0] >= 0) {
			const token = tokenAt.get(`${String(shape)}:${String(range.range[0])}`)

			if (token !== undefined) side.tokenPieces[token] = piece
		} else side.objects[shape]?.push(piece)
	}

	return side
}

function sideBytes(side: MorphSide): number {
	return side.pages.reduce((bytes, page) => bytes + page.width * page.height * 4, 0)
}

// Draws the layers both slides need, before the run.
export async function prepareMorph(request: ShowTransitionRequest, device: GlDevice, document: Document): Promise<MorphData | undefined> {
	const session = request.session
	const fromSource = request.outgoingSource
	const toSource = request.incomingSource
	const fromShapes = fromSource?.morph
	const toShapes = toSource?.morph

	if (session === undefined || request.outgoing === undefined || fromSource === undefined || toSource === undefined) return undefined
	if (fromShapes === undefined || toShapes === undefined) return undefined

	const option = morphOption(request.transition)
	const split = (shapes: readonly MorphShape[]): readonly MorphToken[] =>
		option === "byObject" ? [] : (morphTokens(shapes, option) ?? [])
	const fromTokens = split(fromShapes)
	const toTokens = split(toShapes)
	const size = toSource.slideSize
	const dpr = morphPixelRatio([fromShapes, toShapes], { w: size.cx / 9525, h: size.cy / 9525 }, request.widthPx, request.dpr)
	// The worker answers an atlas plan with ShowLayer (protocol.ts ShowLayer.atlas).
	let fromLayers: readonly ShowLayer[] = []
	let toLayers: readonly ShowLayer[] = []

	try {
		;[fromLayers, toLayers] = await Promise.all([
			session.layers(request.outgoing, request.widthPx, planOf(fromShapes, fromTokens, dpr)),
			session.layers(request.incoming, request.widthPx, planOf(toShapes, toTokens, dpr))
		])
	} catch {
		return undefined
	}

	if (request.signal.aborted || device.lost) {
		for (const layer of [...fromLayers, ...toLayers]) layer.bitmap.close()

		return undefined
	}

	const scratch = document.createElement("canvas")
	const from = await sideOf(device, scratch, request.outgoing, fromSource, fromShapes, fromTokens, fromLayers, request.signal)
	const to = await sideOf(device, scratch, request.incoming, toSource, toShapes, toTokens, toLayers, {
		get aborted() {
			return request.signal.aborted || from === undefined
		}
	})

	if (from === undefined || to === undefined) {
		freeSide(device, from)
		freeSide(device, to)

		return undefined
	}

	const plan = planMorph(fromShapes, toShapes, { w: size.cx / 9525, h: size.cy / 9525 })
	const prepared: MorphData = { from, to, plan, bytes: sideBytes(from) + sideBytes(to) }

	await warmPages(device, [...from.pages, ...to.pages], request.signal)

	if (request.signal.aborted || device.lost) {
		releaseMorph(device, prepared)

		return undefined
	}

	const whole = {
		...prepared,
		whole: morphElements(
			prepared,
			fromShapes.map(() => true),
			toShapes.map(() => true)
		)
	}
	const buffers = morphBuffers(device, instanceCapacity(prepared))
	// The outlines a run at the stage's pixel ratio redraws when every object is on stage.
	const scale = (request.widthPx * request.dpr) / Math.max(1, size.cx / 9525)
	const slots = outlineSlots(capVectors(whole.whole, scale), scale, device.maxSide)
	const bound = slots.size
	const outline = bound === undefined || buffers === undefined ? undefined : device.target(bound.w, bound.h)
	const canvas = document.createElement("canvas")
	const context = outline === undefined || bound === undefined ? null : canvas.getContext("2d")

	if (buffers === undefined) return whole

	if (context === null || bound === undefined || outline === undefined) return { ...whole, gpu: { buffers, outline } }

	canvas.width = bound.w
	canvas.height = bound.h

	const gpu = { buffers, outline, outlines: { scale, slots, canvas, context } }

	warmFrame(
		device,
		{ ...whole, gpu },
		slots.elements,
		{ w: size.cx / 9525, h: size.cy / 9525 },
		{ canvas, context, texture: outline, scale, slots: slots.slots }
	)

	return { ...whole, gpu }
}

// The most instances a frame of a run between these sides writes: each piece at most twice (a redrawn shape's also
// as its outline's fallback), plus one outline per object or word.
function instanceCapacity(data: Pick<MorphData, "from" | "to">): number {
	let total = 0

	for (const side of [data.from, data.to]) {
		total += side.statics.length + side.shapes.length + side.tokens.length

		for (const list of side.objects) total += 2 * list.length

		for (const piece of side.tokenPieces) if (piece !== undefined) total += 2
	}

	return total
}

export function releaseMorph(device: GlDevice, data: MorphData): void {
	freeSide(device, data.from)
	freeSide(device, data.to)

	if (data.gpu !== undefined) {
		releaseBuffers(device, data.gpu.buffers)
		device.free(data.gpu.outline)

		if (data.gpu.outlines !== undefined) {
			data.gpu.outlines.canvas.width = 0
			data.gpu.outlines.canvas.height = 0
		}
	}
}

// --- Which objects are on stage now ---

// Per object of a side, whether it shows on the stage box (the outgoing slide's end state, the incoming one's first
// state); undefined when an object shows only in part (a paragraph or word build half done), which morph cannot draw.
export function shownObjects(box: HTMLElement, side: Pick<MorphSide, "source" | "shapes">): boolean[] | undefined {
	const layers = side.source.layers
	const shown = side.shapes.map(() => true)
	const index = new Map(side.shapes.map((shape, k) => [shape.id, k]))
	const whole = new Map<number, boolean>()
	const parts = new Map<number, boolean[]>()
	const visible = (element: Element | null): boolean => {
		for (let at = element; at !== null && at !== box; at = at.parentElement) {
			if (!(at instanceof HTMLElement)) continue
			if (at.style.visibility === "hidden" || at.style.display === "none" || at.style.opacity === "0") return false
		}

		return true
	}

	// Each layer's element, the first in document order, from one walk of the box.
	const elements = new Map<string, Element>()

	for (const element of box.querySelectorAll("[data-fo-show-layer]")) {
		const key = element.getAttribute("data-fo-show-layer") ?? ""

		if (!elements.has(key)) elements.set(key, element)
	}

	for (let k = 0; k < layers.shapes.length; k++) {
		const shape = index.get(layers.shapes[k] ?? -1)

		if (shape === undefined) continue

		const seen = visible(elements.get(String(k)) ?? null)

		if (layers.ranges?.[k] === undefined) whole.set(shape, seen)
		else parts.set(shape, [...(parts.get(shape) ?? []), seen])
	}

	for (const [shape, seen] of whole) shown[shape] = seen

	for (const [shape, seen] of parts) {
		if ((whole.get(shape) ?? true) && seen.some(part => !part)) return undefined
	}

	return shown
}

// --- The run ---

export interface MorphElement {
	readonly a: readonly Piece[]
	readonly b: readonly Piece[]
	// Boxes the pieces move between (equal for one that fades in place).
	readonly fromBox: MorphBox
	readonly toBox: MorphBox
	readonly fromRank: number
	readonly toRank: number
	readonly fromCount: number
	readonly toCount: number
	// Order among elements of equal rank (a word above its object).
	readonly tie: number
	// Plain shapes whose outline is redrawn between the ends.
	readonly vector?: { readonly plan: VectorPlan; readonly from: MorphVector; readonly to: MorphVector }
	// Plain shapes on both ends whose outline capVectors may choose to redraw.
	readonly outline?: { readonly from: MorphVector; readonly to: MorphVector }
}

function boxOf(shape: MorphShape): MorphBox {
	return { x: shape.x, y: shape.y, w: shape.w, h: shape.h, rot: shape.rot, flipH: shape.flipH, flipV: shape.flipV }
}

function pieceBox(piece: Piece): MorphBox {
	return { x: piece.x, y: piece.y, w: piece.w, h: piece.h, rot: 0, flipH: false, flipV: false }
}

// The elements a run draws: matched objects, the others, then the words or characters of the objects on stage.
export function morphElements(data: MorphData, shownFrom: readonly boolean[], shownTo: readonly boolean[]): MorphElement[] {
	const { from, to } = data
	const objects = matchPlanned(data.plan, shownFrom, shownTo)
	const out: MorphElement[] = []
	const fc = from.shapes.length
	const tc = to.shapes.length

	for (const [fk, tk] of objects.pairs) {
		const a = from.shapes[fk]?.vector
		const b = to.shapes[tk]?.vector

		out.push({
			...(a === undefined || b === undefined ? {} : { outline: { from: a, to: b } }),
			a: from.objects[fk] ?? [],
			b: to.objects[tk] ?? [],
			fromBox: boxOf(from.shapes[fk] as MorphShape),
			toBox: boxOf(to.shapes[tk] as MorphShape),
			fromRank: fk,
			toRank: tk,
			fromCount: fc,
			toCount: tc,
			tie: 0
		})
	}

	for (const fk of objects.exits) {
		const box = boxOf(from.shapes[fk] as MorphShape)

		out.push({
			a: from.objects[fk] ?? [],
			b: [],
			fromBox: box,
			toBox: box,
			fromRank: fk,
			toRank: -1,
			fromCount: fc,
			toCount: tc,
			tie: 0
		})
	}

	for (const tk of objects.entries) {
		const box = boxOf(to.shapes[tk] as MorphShape)

		out.push({ a: [], b: to.objects[tk] ?? [], fromBox: box, toBox: box, fromRank: -1, toRank: tk, fromCount: fc, toCount: tc, tie: 0 })
	}

	// Words and characters of the objects on stage, above their objects.
	const fromTokens = from.tokens.flatMap((token, k) => (shownFrom[token.shape] === true && from.tokenPieces[k] !== undefined ? [k] : []))
	const toTokens = to.tokens.flatMap((token, k) => (shownTo[token.shape] === true && to.tokenPieces[k] !== undefined ? [k] : []))
	const pick = (tokens: readonly MorphToken[], list: readonly number[]): MorphToken[] => list.map(k => tokens[k] as MorphToken)
	const words = matchTokens(pick(from.tokens, fromTokens), pick(to.tokens, toTokens), objects)
	const tokenElement = (fk: number | undefined, tk: number | undefined, order: number): MorphElement => {
		const a = fk === undefined ? undefined : from.tokenPieces[fk]
		const b = tk === undefined ? undefined : to.tokenPieces[tk]
		const fromBox = a === undefined ? pieceBox(b as Piece) : pieceBox(a)
		const toBox = b === undefined ? fromBox : pieceBox(b)

		return {
			a: a === undefined ? [] : [a],
			b: b === undefined ? [] : [b],
			fromBox,
			toBox,
			fromRank: fk === undefined ? -1 : (from.tokens[fk]?.shape ?? -1),
			toRank: tk === undefined ? -1 : (to.tokens[tk]?.shape ?? -1),
			fromCount: fc,
			toCount: tc,
			tie: 1 + order
		}
	}

	words.pairs.forEach(([f, t], n) => out.push(tokenElement(fromTokens[f], toTokens[t], n)))
	words.exits.forEach((f, n) => out.push(tokenElement(fromTokens[f], undefined, n)))
	words.entries.forEach((t, n) => out.push(tokenElement(undefined, toTokens[t], n)))

	return out
}

// Bytes the drawing buffer takes per device px (front and back).
const BUFFER_BYTES_PER_PX = 8
const MIN_RESOLUTION = 0.35

export function startMorph(context: ShowTransitionContext, device: GlDevice, data: MorphData): ShowTransitionRun | undefined {
	const outgoing = context.outgoing
	const program = device.program("morph")

	if (outgoing === undefined || program === undefined || device.lost) return undefined
	if (context.outgoingSlide !== data.from.ref || context.incomingSlide !== data.to.ref) return undefined

	const shownFrom = shownObjects(outgoing, data.from)
	const shownTo = shownObjects(context.incoming, data.to)

	if (shownFrom === undefined || shownTo === undefined) return undefined

	const area = context.slide.w * context.slide.h
	let scale = Math.min(context.pixelRatio, device.maxSide / Math.max(context.slide.w, context.slide.h, 1))

	if (area * scale * scale * BUFFER_BYTES_PER_PX > context.budgetBytes)
		scale = Math.sqrt(context.budgetBytes / (area * BUFFER_BYTES_PER_PX))
	if (!(scale >= context.pixelRatio * MIN_RESOLUTION)) return undefined

	const whole = data.whole !== undefined && shownFrom.every(Boolean) && shownTo.every(Boolean) ? data.whole : undefined
	const width = Math.max(1, pixels(context.slide.w * scale))
	const height = Math.max(1, pixels(context.slide.h * scale))
	const vectorScale = width / context.slide.w
	const ready = data.gpu?.outlines
	// The prepared outlines when every object is on stage and their slots hold this run's pixel ratio.
	const reuse = whole !== undefined && ready !== undefined && vectorScale <= ready.scale && vectorScale >= ready.scale * 0.9
	const outlines = reuse
		? ready.slots
		: outlineSlots(capVectors(whole ?? morphElements(data, shownFrom, shownTo), scale), vectorScale, device.maxSide)
	const elements = outlines.elements
	const canvas = device.canvas
	const held = data.gpu?.outline
	const vectorSize = outlines.size
	// The prepared outline texture when this run's outlines fit it, else one of their own.
	const own =
		vectorSize === undefined || (held !== undefined && held.width >= vectorSize.w && held.height >= vectorSize.h)
			? undefined
			: device.target(vectorSize.w, vectorSize.h)
	const texture = vectorSize === undefined ? undefined : (own ?? held)
	const ownCanvas = reuse ? undefined : context.document.createElement("canvas")
	const vectorCanvas = ready !== undefined && reuse ? ready.canvas : ownCanvas
	const vectorContext =
		texture === undefined || vectorSize === undefined || vectorCanvas === undefined
			? null
			: reuse && ready !== undefined
				? ready.context
				: vectorCanvas.getContext("2d")

	if (ownCanvas !== undefined && vectorContext !== null && vectorSize !== undefined) {
		ownCanvas.width = vectorSize.w
		ownCanvas.height = vectorSize.h
	}

	const vectors: VectorTarget | undefined =
		texture === undefined || vectorContext === null || vectorCanvas === undefined
			? undefined
			: {
					canvas: vectorCanvas,
					context: vectorContext,
					texture,
					scale: reuse && ready !== undefined ? ready.scale : vectorScale,
					slots: outlines.slots
				}
	const made = data.gpu === undefined ? morphBuffers(device, instanceCapacity(data)) : undefined
	const batches = data.gpu?.buffers ?? made

	if (batches === undefined) {
		device.free(own)

		return undefined
	}

	device.resize(width, height)
	canvas.style.cssText = `position:absolute;left:0;top:0;width:${String(context.slide.w)}px;height:${String(context.slide.h)}px;z-index:4;pointer-events:none`
	context.host.appendChild(canvas)

	let done = false

	return {
		frame(progress) {
			if (done || device.lost) return false

			drawMorph(device, data, elements, context.slide, Math.min(1, Math.max(0, progress)), batches, vectors)

			return !device.lost
		},
		finish() {
			if (done) return

			done = true

			if (made !== undefined) releaseBuffers(device, made)

			device.free(own)

			if (ownCanvas !== undefined) {
				ownCanvas.width = 0
				ownCanvas.height = 0
			}

			device.resize(1, 1)
			canvas.remove()
		}
	}
}

// Device px of redrawn outlines a frame may draw, and how many: each is drawn again on the 2D canvas every frame (the
// canvas is uploaded once a frame), so past either the smaller shapes mix their bitmaps instead.
const VECTOR_FRAME_PX = 4_000_000
export const VECTOR_FRAME_SHAPES = 12

export function capVectors(elements: readonly MorphElement[], scale: number): MorphElement[] {
	const area = (element: MorphElement): number =>
		Math.max(element.fromBox.w * element.fromBox.h, element.toBox.w * element.toBox.h) * scale * scale
	// The largest outlines are redrawn first; a pair's plan is made only for those considered.
	const order = elements
		.flatMap((element, k) => (element.outline === undefined ? [] : [{ k, size: area(element) }]))
		.sort((x, y) => y.size - x.size || x.k - y.k)
	const plans = new Map<number, VectorPlan>()
	let total = 0

	for (const { k, size } of order) {
		const outline = elements[k]?.outline

		if (plans.size >= VECTOR_FRAME_SHAPES) break
		if (outline === undefined || total + size > VECTOR_FRAME_PX) continue

		const plan = vectorPlan(outline.from, outline.to)

		if (plan === undefined) continue

		total += size
		plans.set(k, plan)
	}

	return elements.map((element, k) => {
		const { outline, ...rest } = element
		const plan = plans.get(k)

		return plan === undefined || outline === undefined ? rest : { ...rest, vector: { plan, from: outline.from, to: outline.to } }
	})
}

// Where each redrawn outline of a run is drawn in the outline canvas: its largest canvas (its box at the larger
// end, with the margin for the wider line; vector.ts drawVectorAt) packed into one page of at most `side` px. Outlines
// that do not fit the page mix their bitmaps instead.
export interface OutlineSlots {
	readonly elements: MorphElement[]
	readonly slots: ReadonlyMap<MorphElement, { readonly x: number; readonly y: number; readonly w: number; readonly h: number }>
	readonly size: { readonly w: number; readonly h: number } | undefined
}

export function outlineSlots(elements: readonly MorphElement[], scale: number, side: number): OutlineSlots {
	const sizes = elements.map(element => {
		const vector = element.vector

		if (vector === undefined) return { w: 0, h: 0 }

		const margin = Math.max(vector.from.line?.width ?? 0, vector.to.line?.width ?? 0) / 2 + 2

		return {
			w: Math.ceil((Math.max(element.fromBox.w, element.toBox.w) + 2 * margin) * scale) + 1,
			h: Math.ceil((Math.max(element.fromBox.h, element.toBox.h) + 2 * margin) * scale) + 1
		}
	})
	const packed = packAtlas(sizes, Math.min(side, ATLAS_PAGE_PX * 2))
	const slots = new Map<MorphElement, { x: number; y: number; w: number; h: number }>()
	const kept = elements.map((element, k) => {
		const slot = packed.slots[k]
		const size = sizes[k]

		if (element.vector === undefined) return element

		if (slot === undefined || slot.page !== 0 || size === undefined) {
			const { vector: _vector, ...rest } = element

			return rest
		}

		slots.set(element, { x: slot.x, y: slot.y, w: size.w, h: size.h })

		return element
	})
	const page = packed.pages[0]

	return { elements: kept, slots, size: slots.size === 0 || page === undefined ? undefined : page }
}

// Where a frame draws redrawn outlines: a 2D canvas, each outline at its slot, uploaded once a frame into a texture
// at least its size.
interface VectorTarget {
	readonly canvas: HTMLCanvasElement
	readonly context: CanvasRenderingContext2D
	readonly texture: GlTexture
	readonly scale: number
	readonly slots: ReadonlyMap<MorphElement, { readonly x: number; readonly y: number; readonly w: number; readonly h: number }>
}

// --- Batched drawing ---

// Floats per instance (the morph vertex shader's per-instance attributes, in order): quad x0 y0 x1 y1, the outgoing
// piece's uv map (two rows of three), the incoming one's, their uv rectangles, the two weights.
const FLOATS = 26
const STRIDE = FLOATS * 4
// Attribute location, size and offset (floats) of each per-instance attribute.
const ATTRIBUTES: readonly (readonly [number, number, number])[] = [
	[1, 4, 0],
	[2, 3, 4],
	[3, 3, 7],
	[4, 3, 10],
	[5, 3, 13],
	[6, 4, 16],
	[7, 4, 20],
	[8, 2, 24]
]

// A run's instance buffer: every element of a frame written into one array and uploaded once, then drawn in as few
// instanced calls as the pages they sample allow (z order kept).
export interface MorphBuffers {
	readonly vao: WebGLVertexArrayObject
	readonly corners: WebGLBuffer
	readonly instances: WebGLBuffer
	readonly data: Float32Array
}

export function morphBuffers(device: GlDevice, capacity: number): MorphBuffers | undefined {
	const gl = device.gl
	const vao = gl.createVertexArray()
	const corners = gl.createBuffer()
	const instances = gl.createBuffer()

	gl.bindVertexArray(vao)
	gl.bindBuffer(gl.ARRAY_BUFFER, corners)
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
	gl.enableVertexAttribArray(0)
	gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
	gl.bindBuffer(gl.ARRAY_BUFFER, instances)

	const data = new Float32Array(Math.max(1, capacity) * FLOATS)

	gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.STREAM_DRAW)

	for (const [location] of ATTRIBUTES) {
		gl.enableVertexAttribArray(location)
		gl.vertexAttribDivisor(location, 1)
	}

	gl.bindVertexArray(null)
	gl.bindBuffer(gl.ARRAY_BUFFER, null)

	if (gl.getError() !== gl.NO_ERROR) {
		releaseBuffers(device, { vao, corners, instances, data })

		return undefined
	}

	return { vao, corners, instances, data }
}

function releaseBuffers(device: GlDevice, buffers: MorphBuffers): void {
	device.gl.deleteVertexArray(buffers.vao)
	device.gl.deleteBuffer(buffers.corners)
	device.gl.deleteBuffer(buffers.instances)
}

// A piece's unit square → slide px of its own slide.
function pieceAffine(piece: Pick<Piece, "x" | "y" | "w" | "h">): Affine {
	return [piece.w, 0, 0, piece.h, piece.x, piece.y]
}

// Writes one instance at `at` (instances): `a` placed by placeA at weight wa mixed with `b`; false when it draws
// nothing.
function writeInstance(
	out: Float32Array,
	at: number,
	a: Piece | undefined,
	placeA: Affine,
	wa: number,
	b: Piece | undefined,
	placeB: Affine,
	wb: number
): boolean {
	const o = at * FLOATS
	let x0 = Number.POSITIVE_INFINITY
	let y0 = Number.POSITIVE_INFINITY
	let x1 = Number.NEGATIVE_INFINITY
	let y1 = Number.NEGATIVE_INFINITY
	const side = (piece: Piece | undefined, place: Affine, weight: number, row: number, rect: number): number => {
		const map = piece === undefined ? undefined : multiply(place, pieceAffine(piece))
		const back = map === undefined ? undefined : invert(map)

		if (piece === undefined || map === undefined || back === undefined || !(weight > 0)) {
			out.fill(0, o + row, o + row + 6)
			out.fill(0, o + rect, o + rect + 4)

			return 0
		}

		for (const [u, v] of UNIT) {
			const x = map[0] * u + map[2] * v + map[4]
			const y = map[1] * u + map[3] * v + map[5]

			x0 = Math.min(x0, x)
			y0 = Math.min(y0, y)
			x1 = Math.max(x1, x)
			y1 = Math.max(y1, y)
		}

		// Slide px → the piece's unit square → its place in the page.
		const du = piece.u1 - piece.u0
		const dv = piece.v1 - piece.v0

		out[o + row] = du * back[0]
		out[o + row + 1] = du * back[2]
		out[o + row + 2] = du * back[4] + piece.u0
		out[o + row + 3] = dv * back[1]
		out[o + row + 4] = dv * back[3]
		out[o + row + 5] = dv * back[5] + piece.v0
		out[o + rect] = piece.u0
		out[o + rect + 1] = piece.v0
		out[o + rect + 2] = piece.u1
		out[o + rect + 3] = piece.v1

		return weight
	}
	const weightA = side(a, placeA, wa, 4, 16)
	const weightB = side(b, placeB, wb, 10, 20)

	if (weightA === 0 && weightB === 0) return false

	out[o] = x0
	out[o + 1] = y0
	out[o + 2] = x1
	out[o + 3] = y1
	out[o + 24] = weightA
	out[o + 25] = weightB

	return true
}

const UNIT: readonly (readonly [number, number])[] = [
	[0, 0],
	[1, 0],
	[0, 1],
	[1, 1]
]

// A run of instances drawn by one call: the pages its two samplers read (null: none of its instances reads that
// side).
interface Batch {
	start: number
	count: number
	a: GlTexture | null
	b: GlTexture | null
}

// Draws one frame: every instance written (outlines drawn into the outline canvas on the way), the outline canvas and
// the instances uploaded once each, then drawn batch by batch.
export function drawMorph(
	device: GlDevice,
	data: MorphData,
	elements: readonly MorphElement[],
	slide: { readonly w: number; readonly h: number },
	p: number,
	buffers: MorphBuffers,
	vectors?: VectorTarget,
	// Off screen (a frame drawn ahead to warm the engine), else the device's canvas.
	into?: { readonly framebuffer: WebGLFramebuffer; readonly width: number; readonly height: number }
): void {
	const gl = device.gl
	const program = device.program("morph")

	if (program === undefined) return

	const t = morphEase(p)
	const out = buffers.data
	const capacity = out.length / FLOATS
	const batches: Batch[] = []
	let count = 0
	let outlines = 0
	const draw = (a: Piece | undefined, placeA: Affine, wa: number, b: Piece | undefined, placeB: Affine, wb: number): void => {
		if (count >= capacity || !writeInstance(out, count, a, placeA, wa, b, placeB, wb)) return

		const ta = wa > 0 && a !== undefined ? a.page : null
		const tb = wb > 0 && b !== undefined ? b.page : null
		const last = batches[batches.length - 1]

		if (last !== undefined && (ta === null || last.a === null || last.a === ta) && (tb === null || last.b === null || last.b === tb)) {
			last.a ??= ta
			last.b ??= tb
			last.count++
		} else batches.push({ start: count, count: 1, a: ta, b: tb })

		count++
	}
	const identity: Affine = [1, 0, 0, 1, 0, 0]

	// The backgrounds mixed where both slides have one, else each faded.
	const fromStatics = data.from.statics
	const toStatics = data.to.statics

	if (fromStatics.length === 1 && toStatics.length === 1) draw(fromStatics[0], identity, 1 - t, toStatics[0], identity, t)
	else {
		for (const piece of fromStatics) draw(piece, identity, 1 - t, undefined, identity, 0)
		for (const piece of toStatics) draw(undefined, identity, 0, piece, identity, t)
	}

	const order = elements
		.map((element, k) => ({ element, k, rank: morphRank(element.fromRank, element.fromCount, element.toRank, element.toCount, t) }))
		.sort((x, y) => x.rank - y.rank || x.element.tie - y.element.tie || x.k - y.k)

	for (const { element } of order) {
		const placeA = morphPlacement(element.fromBox, element.toBox, t, "from")
		const placeB = morphPlacement(element.fromBox, element.toBox, t, "to")
		// Between the ends a plain shape's outline is drawn again; its text (its own pieces) mixes over it.
		const outline = t > 0 && t < 1 ? outlinePiece(element, t, vectors) : undefined

		if (outline !== undefined) {
			draw(outline.piece, outline.place, 1, undefined, identity, 0)
			outlines++
		}

		const own = (pieces: readonly Piece[]): readonly Piece[] =>
			outline !== undefined ? pieces.filter(piece => piece.drawing !== true) : pieces
		const pa = own(element.a)
		const pb = own(element.b)
		const [a] = pa
		const [b] = pb

		if (pa.length === 1 && pb.length === 1) {
			draw(a, placeA, 1 - t, b, placeB, t)

			continue
		}

		for (const piece of pa) draw(piece, placeA, 1 - t, undefined, identity, 0)
		for (const piece of pb) draw(undefined, identity, 0, piece, placeB, t)
	}

	if (outlines > 0 && vectors !== undefined)
		device.uploadInto(vectors.texture, vectors.canvas, vectors.canvas.width, vectors.canvas.height)

	gl.bindFramebuffer(gl.FRAMEBUFFER, into?.framebuffer ?? null)
	gl.viewport(0, 0, into?.width ?? device.canvas.width, into?.height ?? device.canvas.height)
	gl.clearColor(1, 1, 1, 1)
	gl.clear(gl.COLOR_BUFFER_BIT)
	gl.enable(gl.BLEND)
	gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
	gl.useProgram(program.program)
	gl.uniform1i(program.uniform("uA"), 0)
	gl.uniform1i(program.uniform("uB"), 1)
	// Slide px → clip space of the canvas (top is +1).
	gl.uniformMatrix3fv(program.uniform("uClip"), false, mat3([2 / slide.w, 0, 0, -2 / slide.h, -1, 1]))
	gl.bindVertexArray(buffers.vao)
	gl.bindBuffer(gl.ARRAY_BUFFER, buffers.instances)
	gl.bufferSubData(gl.ARRAY_BUFFER, 0, out, 0, count * FLOATS)

	for (const batch of batches) run(gl, batch)

	gl.bindVertexArray(null)
	gl.bindBuffer(gl.ARRAY_BUFFER, null)
	gl.disable(gl.BLEND)

	if (into !== undefined) gl.bindFramebuffer(gl.FRAMEBUFFER, null)
}

// A plain shape's outline at `t` drawn into its slot of the outline canvas, as a piece of the outline texture and its
// placement; undefined when it cannot be (its bitmaps mix instead).
function outlinePiece(element: MorphElement, t: number, vectors: VectorTarget | undefined): { piece: Piece; place: Affine } | undefined {
	const vector = element.vector
	const slot = vectors?.slots.get(element)

	if (vector === undefined || vectors === undefined || slot === undefined) return undefined

	const box = vectorBox(element.fromBox, element.toBox, t)
	const drawn = drawVectorAt(vectors.context, slot, vector.plan, vector.from, vector.to, box, t, vectors.scale)

	if (drawn === undefined) return undefined

	const texture = vectors.texture

	return {
		piece: {
			page: texture,
			u0: slot.x / texture.width,
			v0: slot.y / texture.height,
			u1: (slot.x + drawn.w) / texture.width,
			v1: (slot.y + drawn.h) / texture.height,
			...drawn.covers
		},
		place: box.place
	}
}

// Samples every page once into a 1 by 1 target off screen, a page a task: engines that upload a texture when it is
// first drawn from pay for it here, not on the transition's first frames.
async function warmPages(device: GlDevice, pages: readonly GlTexture[], signal: { readonly aborted: boolean }): Promise<void> {
	const program = device.program("morph")
	const target = pages.length === 0 || program === undefined ? undefined : device.target(1, 1)
	const buffers = target === undefined ? undefined : morphBuffers(device, 1)

	if (target === undefined || buffers === undefined || program === undefined) {
		device.free(target)

		return
	}

	const gl = device.gl
	const framebuffer = gl.createFramebuffer()
	const unit: Affine = [1, 0, 0, 1, 0, 0]

	for (const page of pages) {
		if (signal.aborted || device.lost) break

		writeInstance(buffers.data, 0, { page, u0: 0, v0: 0, u1: 1, v1: 1, x: 0, y: 0, w: 1, h: 1 }, unit, 1, undefined, unit, 0)
		gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0)
		gl.viewport(0, 0, 1, 1)
		gl.useProgram(program.program)
		gl.uniform1i(program.uniform("uA"), 0)
		gl.uniform1i(program.uniform("uB"), 1)
		gl.uniformMatrix3fv(program.uniform("uClip"), false, mat3([2, 0, 0, -2, -1, 1]))
		gl.bindVertexArray(buffers.vao)
		gl.bindBuffer(gl.ARRAY_BUFFER, buffers.instances)
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, buffers.data, 0, FLOATS)
		run(gl, { start: 0, count: 1, a: page, b: null })
		gl.bindVertexArray(null)
		gl.bindBuffer(gl.ARRAY_BUFFER, null)
		gl.bindFramebuffer(gl.FRAMEBUFFER, null)
		gl.flush()
		await new Promise<void>(resolve => setTimeout(resolve, 0))
	}

	gl.deleteFramebuffer(framebuffer)
	releaseBuffers(device, buffers)
	device.free(target)
}

// A frame halfway drawn into a 1 by 1 target off screen: the first frame on stage then runs code and a pipeline the
// engine has already compiled and set up (cold, it takes several times as long).
function warmFrame(
	device: GlDevice,
	data: MorphData,
	elements: readonly MorphElement[],
	slide: { readonly w: number; readonly h: number },
	vectors: VectorTarget
): void {
	const buffers = data.gpu?.buffers
	const target = buffers === undefined ? undefined : device.target(1, 1)

	if (buffers === undefined || target === undefined) return

	const gl = device.gl
	const framebuffer = gl.createFramebuffer()

	gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0)
	drawMorph(device, data, elements, slide, 0.5, buffers, vectors, { framebuffer, width: 1, height: 1 })
	gl.deleteFramebuffer(framebuffer)
	device.free(target)
}

// One instanced call over a batch's instances.
function run(gl: WebGL2RenderingContext, batch: Pick<Batch, "start" | "count" | "a" | "b">): void {
	if (batch.count === 0) return

	for (const [location, size, offset] of ATTRIBUTES)
		gl.vertexAttribPointer(location, size, gl.FLOAT, false, STRIDE, batch.start * STRIDE + offset * 4)

	gl.activeTexture(gl.TEXTURE0)
	gl.bindTexture(gl.TEXTURE_2D, (batch.a ?? batch.b)?.texture ?? null)
	gl.activeTexture(gl.TEXTURE1)
	gl.bindTexture(gl.TEXTURE_2D, (batch.b ?? batch.a)?.texture ?? null)
	gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count)
}
