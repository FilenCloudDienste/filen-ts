import type { LayerState, TimegraphSource } from "../../../core/anim/model"
import { EMU_PER_PX, type DrawingData } from "../../../core/drawingml/index"
import type { LayerPlan, ShowLayer } from "../../../dom/presentation/protocol"
import { clipPathCss, filterFrame } from "./filters"

// The stage's layers as the timegraph addresses them: what the page asks the worker to draw (one bitmap per animated
// shape and paragraph range, static runs between), how those bitmaps nest (a paragraph range inside its shape, a shape
// inside its animated group, so CSS composes their transforms, opacities, visibilities and clips the way the slide
// does) and the CSS of a sampled LayerState. Everything is in slide px: every layer element sits at the slide's origin.

// A drawing with nothing in it (the background of a layer painted on its own).
export const EMPTY_DRAWING: DrawingData = {
	width: 0,
	height: 0,
	commands: new Uint8Array(0),
	coords: new Float32Array(0),
	itemCount: 0,
	itemFloats: new Float32Array(0),
	itemInts: new Int32Array(0),
	paints: [],
	strokes: [],
	images: [],
	texts: [],
	shadows: []
}

// The shape id of a static run (dom/presentation/engine/show.ts STATIC_LAYER).
export const STATIC_SHAPE = -1

type Range = { readonly target: "para" | "char"; readonly range: readonly [number, number] }

// A paragraph range and a by-letter run can share their numbers: the unit is part of the key.
function key(shape: number, range: { readonly unit: "para" | "char"; readonly start: number; readonly end: number } | undefined): string {
	return range === undefined ? String(shape) : `${String(shape)}:${range.unit}:${String(range.start)}-${String(range.end)}`
}

// The worker's plan for a source: each shape once, with the paragraph ranges laid out on their own.
export function layerPlanOf(source: TimegraphSource, dpr: number): LayerPlan {
	const shapes: number[] = []
	const ranges: Range[][] = []
	const at = new Map<number, number>()

	source.layers.shapes.forEach((shape, k) => {
		let index = at.get(shape)

		if (index === undefined) {
			index = shapes.length
			at.set(shape, index)
			shapes.push(shape)
			ranges.push([])
		}

		const range = source.layers.ranges?.[k]

		if (range !== undefined) ranges[index]?.push({ target: range.unit, range: [range.start, range.end] })
	})

	return ranges.some(list => list.length > 0)
		? { shapes, ranges: ranges.map(list => (list.length === 0 ? undefined : list)), dpr }
		: { shapes, dpr }
}

// The layer index (in source.layers) of each drawn layer, -1 for a static run.
export function layerIndices(source: TimegraphSource | undefined, layers: readonly ShowLayer[]): Int32Array {
	const byKey = new Map<string, number>()

	source?.layers.shapes.forEach((shape, k) => {
		byKey.set(key(shape, source.layers.ranges?.[k]), k)
	})

	return Int32Array.from(layers, layer =>
		layer.shape === STATIC_SHAPE
			? -1
			: (byKey.get(
					key(
						layer.shape,
						layer.range === undefined
							? undefined
							: { unit: layer.range.target, start: layer.range.range[0], end: layer.range.range[1] }
					)
				) ?? -1)
	)
}

// How the drawn layers nest: a node per layer element (a timegraph layer may have several where its drawing is split
// around others), its drawn layers and child nodes in z-order.
export interface LayerNode {
	// Layer index, -1 for the stage root.
	readonly layer: number
	// Drawn-layer indices (into the ShowLayer list) and child nodes, in z-order.
	readonly children: (number | LayerNode)[]
}

export function layerTree(indices: Int32Array, parents: Int32Array | undefined): LayerNode {
	const root: LayerNode = { layer: -1, children: [] }
	const chainOf = (layer: number): number[] => {
		const chain: number[] = []
		const seen = new Set<number>()

		for (let at = layer; at >= 0 && !seen.has(at); at = parents?.[at] ?? -1) {
			seen.add(at)
			chain.unshift(at)
		}

		return chain
	}
	// The open nodes, root first.
	const stack: LayerNode[] = [root]

	indices.forEach((layer, drawn) => {
		const chain = layer < 0 ? [] : chainOf(layer)
		let depth = 1

		// Keep the open nodes that are a prefix of the chain.
		while (depth < stack.length && stack[depth]?.layer === chain[depth - 1]) depth++

		stack.length = depth

		for (let k = depth - 1; k < chain.length; k++) {
			const node: LayerNode = { layer: chain[k] ?? -1, children: [] }

			stack[stack.length - 1]?.children.push(node)
			stack.push(node)
		}

		stack[stack.length - 1]?.children.push(drawn)
	})

	return root
}

// Per layer of a source, its shape's box (slide px: x, y, w, h), the frame filters reveal over.
export function layerBoxes(source: TimegraphSource): Float64Array {
	const boxes = new Map<number, readonly [number, number, number, number]>()
	const g = source.geometry
	const fallback = [0, 0, source.slideSize.cx / EMU_PER_PX, source.slideSize.cy / EMU_PER_PX] as const

	for (let k = 0; k + 4 < g.length; k += 5)
		boxes.set(g[k] ?? 0, [
			(g[k + 1] ?? 0) / EMU_PER_PX,
			(g[k + 2] ?? 0) / EMU_PER_PX,
			(g[k + 3] ?? 0) / EMU_PER_PX,
			(g[k + 4] ?? 0) / EMU_PER_PX
		])

	const out = new Float64Array(source.layers.shapes.length * 4)
	const own = source.layers.boxes

	source.layers.shapes.forEach((shape, k) => {
		const x = own?.[k * 4] ?? Number.NaN

		// A by-letter or by-word run reveals over its own glyphs' box.
		if (own !== undefined && Number.isFinite(x)) {
			out.set(
				[
					x / EMU_PER_PX,
					(own[k * 4 + 1] ?? 0) / EMU_PER_PX,
					(own[k * 4 + 2] ?? 0) / EMU_PER_PX,
					(own[k * 4 + 3] ?? 0) / EMU_PER_PX
				],
				k * 4
			)

			return
		}

		out.set(boxes.get(shape) ?? fallback, k * 4)
	})

	return out
}

export interface LayerCss {
	readonly transform: string
	readonly opacity: string
	readonly visibility: "visible" | "hidden"
	readonly clipPath: string
}

const IDENTITY_CSS: LayerCss = { transform: "", opacity: "", visibility: "visible", clipPath: "" }

function number(value: number): string {
	return String(Math.round(value * 10000) / 10000)
}

// A sampled state as the CSS of its layer element (the matrix about the slide origin, opacity, visibility and the
// filter's clip over the shape box); undefined state: as drawn.
export function layerCss(
	state: LayerState | undefined,
	box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
): LayerCss {
	if (state === undefined) return IDENTITY_CSS

	const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = state.matrix
	let opacity = state.opacity
	let clipPath = ""
	let offset = ""

	if (state.filter !== undefined) {
		const frame = filterFrame(state.filter.name, state.filter.progress, state.filter.reverse)
		const dx = frame.dx * box.w
		const dy = frame.dy * box.h

		opacity *= frame.opacity

		if (frame.clip !== undefined) clipPath = clipPathCss(frame.clip, box, dx, dy)
		if (dx !== 0 || dy !== 0) offset = ` translate(${number(dx)}px,${number(dy)}px)`
	}

	const identity = a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0

	return {
		transform:
			identity && offset === ""
				? ""
				: `matrix(${number(a)},${number(b)},${number(c)},${number(d)},${number(e)},${number(f)})${offset}`,
		opacity: opacity >= 1 ? "" : number(Math.max(0, opacity)),
		visibility: state.visible ? "visible" : "hidden",
		clipPath
	}
}
