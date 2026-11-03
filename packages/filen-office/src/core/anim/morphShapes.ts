import { ITEM_FLOATS, ITEM_INTS, ItemFlag, ItemFloat, ItemInt, ItemKind, PATH_COMMAND_COORDS, type Rgba } from "../drawingml/displayList"
import type { DrawingData } from "../drawingml/data"
import { PRESET_GEOMETRY } from "../drawingml/geometry/presets.generated"
import type { SlideLayer, SlideRender } from "../presentation/output"
import type { FrameRef, Geometry, ShapeNode, SlideNode, SlideRef } from "../presentation/model"
import { MORPH_MAX_SHAPES, MORPH_MAX_TEXT, WEBGL_TRANSITION_KINDS, type MorphGeometry, type MorphShape, type MorphVector } from "./morph"
import { paragraphText } from "./runs"
import type { PptxParts } from "../pptx/package"
import { G, partReader } from "../pptx/read/xml"
import { readGeometry } from "../pptx/write/verify"
import { SliceClock, type Slicing } from "../slicing"
import type { XmlDocument } from "../xml/index"

// What morph (morph.ts) knows of a slide's objects, built in the worker where the model and the render are: each
// visible top-level object's name, type, box, outline signature and text, and for a plain shape the geometry and
// paint the page redraws its outline from while it morphs. Kept apart from morph.ts, which the page loads: the
// preset table stays in the worker.

function frameType(frame: FrameRef | undefined): string {
	return frame?.kind ?? "frame"
}

function typeOf(shape: ShapeNode): string {
	switch (shape.kind) {
		case "frame":
			return frameType(shape.frame)
		case "pic":
			return shape.media === undefined ? "pic" : "media"
		case "opaque":
			return "ole"
		default:
			return shape.kind
	}
}

// FNV-1a over the path commands of a drawing's visible path items, their coordinates in fractions of the drawing's
// frame on a 1/64 grid: equal for the same outline at any size.
function outlineOf(drawings: readonly DrawingData[]): string {
	let hash = 0x811c9dc5
	let paths = 0
	const mix = (value: number): void => {
		hash = Math.imul(hash ^ (value & 0xffff), 0x01000193) >>> 0
		hash = Math.imul(hash ^ (value >>> 16), 0x01000193) >>> 0
	}

	for (const drawing of drawings) {
		const sx = drawing.width > 0 ? 64 / drawing.width : 0
		const sy = drawing.height > 0 ? 64 / drawing.height : 0

		for (let item = 0; item < drawing.itemCount; item++) {
			const i = item * ITEM_INTS
			const f = item * ITEM_FLOATS
			const flags = drawing.itemInts[i + ItemInt.FLAGS] ?? 0

			if ((drawing.itemInts[i + ItemInt.KIND] ?? -1) !== ItemKind.PATH || (flags & (ItemFlag.HIDDEN | ItemFlag.DECORATION)) !== 0)
				continue

			const a = drawing.itemFloats[f + ItemFloat.A] ?? 1
			const b = drawing.itemFloats[f + ItemFloat.B] ?? 0
			const c = drawing.itemFloats[f + ItemFloat.C] ?? 0
			const d = drawing.itemFloats[f + ItemFloat.D] ?? 1
			const e = drawing.itemFloats[f + ItemFloat.E] ?? 0
			const ff = drawing.itemFloats[f + ItemFloat.F] ?? 0
			const first = drawing.itemInts[i + ItemInt.FIRST_COMMAND] ?? 0
			const count = drawing.itemInts[i + ItemInt.COMMAND_COUNT] ?? 0
			let coord = drawing.itemInts[i + ItemInt.FIRST_COORD] ?? 0

			paths++

			for (let k = first; k < first + count; k++) {
				const command = drawing.commands[k] ?? 0

				mix(command)

				for (let n = 0; n < (PATH_COMMAND_COORDS[command] ?? 0); n += 2) {
					const x = drawing.coords[coord + n] ?? 0
					const y = drawing.coords[coord + n + 1] ?? 0

					mix(Math.round((a * x + c * y + e) * sx) + 0x8000)
					mix(Math.round((b * x + d * y + ff) * sy) + 0x8000)
				}

				coord += PATH_COMMAND_COORDS[command] ?? 0
			}
		}
	}

	return paths === 0 ? "" : hash.toString(16)
}

function bodyText(shape: ShapeNode): string | undefined {
	const body = shape.text

	if (body === undefined) return undefined

	let text = ""

	for (const paragraph of body.paragraphs) text += `${paragraphText(paragraph)}\n`

	return text.trim() === "" ? undefined : text
}

// A plain shape's look for morphing its outline: every path filled with one solid colour or none and stroked with
// one solid line or none, nothing else drawn (no picture, shadow, effect, arrowhead, clip or fill shade).
function plainLook(layer: SlideLayer): { fill?: Rgba; line?: { color: Rgba; width: number }; paths: number[] } | undefined {
	const drawing = layer.drawing

	if (layer.effects !== undefined && layer.effects.length > 0) return undefined
	if (drawing.itemClips !== undefined && drawing.itemClips.some(clip => clip >= 0)) return undefined

	let fill: Rgba | undefined
	let line: { color: Rgba; width: number } | undefined
	const paths: number[] = []

	for (let item = 0; item < drawing.itemCount; item++) {
		const i = item * ITEM_INTS
		const kind = drawing.itemInts[i + ItemInt.KIND] ?? -1
		const flags = drawing.itemInts[i + ItemInt.FLAGS] ?? 0

		if (kind === ItemKind.TEXT || (flags & ItemFlag.HIDDEN) !== 0) continue
		if (kind !== ItemKind.PATH || (flags & ~ItemFlag.EVEN_ODD) !== 0 || (drawing.itemInts[i + ItemInt.SHADOW] ?? -1) >= 0)
			return undefined

		const paintAt = drawing.itemInts[i + ItemInt.FILL] ?? -1
		const strokeAt = drawing.itemInts[i + ItemInt.STROKE] ?? -1

		if (paintAt >= 0) {
			const paint = drawing.paints[paintAt]

			if (paint?.kind !== "solid" || (fill !== undefined && fill !== paint.color)) return undefined

			fill = paint.color
		}

		if (strokeAt >= 0) {
			const stroke = drawing.strokes[strokeAt]
			const paint = stroke === undefined ? undefined : drawing.paints[stroke.paint]

			if (
				stroke === undefined ||
				paint?.kind !== "solid" ||
				stroke.dash !== "solid" ||
				stroke.customDash !== null ||
				stroke.compound !== "sng"
			)
				return undefined
			if (line !== undefined && (line.color !== paint.color || line.width !== stroke.width)) return undefined

			line = { color: paint.color, width: stroke.width }
		}

		paths.push(item)
	}

	return paths.length === 0 ? undefined : { ...(fill === undefined ? {} : { fill }), ...(line === undefined ? {} : { line }), paths }
}

const VAL = /^val\s+(-?\d+(?:\.\d+)?)$/u

function presetGeometry(geometry: Geometry | undefined): MorphGeometry | undefined {
	if (geometry?.kind !== "preset" || !Object.hasOwn(PRESET_GEOMETRY, geometry.preset)) return undefined

	const adjust: [string, number][] = []

	for (const guide of geometry.guides) {
		const value = VAL.exec(guide.formula.trim())?.[1]

		// A formula over other guides is not interpolated.
		if (value === undefined) return undefined

		adjust.push([guide.name, Number(value)])
	}

	return { kind: "preset", program: PRESET_GEOMETRY[geometry.preset] ?? "", adjust }
}

// The paths a drawing draws, in fractions of its frame.
function drawnGeometry(drawing: DrawingData, items: readonly number[]): MorphGeometry {
	const sx = drawing.width > 0 ? 1 / drawing.width : 0
	const sy = drawing.height > 0 ? 1 / drawing.height : 0

	return {
		kind: "custom",
		paths: items.map(item => {
			const i = item * ITEM_INTS
			const f = item * ITEM_FLOATS
			const [a = 1, b = 0, c = 0, d = 1, e = 0, ff = 0] = drawing.itemFloats.subarray(f, f + 6)
			const first = drawing.itemInts[i + ItemInt.FIRST_COMMAND] ?? 0
			const count = drawing.itemInts[i + ItemInt.COMMAND_COUNT] ?? 0
			const commands = drawing.commands.slice(first, first + count)
			let coord = drawing.itemInts[i + ItemInt.FIRST_COORD] ?? 0
			const coords: number[] = []

			for (const command of commands) {
				for (let n = 0; n < (PATH_COMMAND_COORDS[command] ?? 0); n += 2) {
					const x = drawing.coords[coord + n] ?? 0
					const y = drawing.coords[coord + n + 1] ?? 0

					coords.push((a * x + c * y + e) * sx, (b * x + d * y + ff) * sy)
				}

				coord += PATH_COMMAND_COORDS[command] ?? 0
			}

			return {
				commands,
				coords: Float32Array.from(coords),
				fill: (drawing.itemInts[i + ItemInt.FILL] ?? -1) >= 0,
				stroke: (drawing.itemInts[i + ItemInt.STROKE] ?? -1) >= 0
			}
		})
	}
}

// A plain shape's vector look: its preset with adjust values where the model knows them (`geometry`), else its
// paths as drawn.
export function morphVector(shape: ShapeNode, layer: SlideLayer, geometry: Geometry | undefined): MorphVector | undefined {
	if (shape.kind !== "sp" || layer.shape.id !== shape.id) return undefined

	const look = plainLook(layer)

	if (look === undefined) return undefined

	return {
		geometry: presetGeometry(geometry) ?? drawnGeometry(layer.drawing, look.paths),
		...(look.fill === undefined ? {} : { fill: look.fill }),
		...(look.line === undefined ? {} : { line: look.line })
	}
}

// The slide's visible top-level objects in z-order, as rendered; undefined past MORPH_MAX_SHAPES. `geometry` reads a
// shape's own geometry (an edit's, else the source's).
export function morphShapes(
	shapes: readonly ShapeNode[],
	render: SlideRender,
	geometry?: (shape: ShapeNode) => Geometry | undefined
): MorphShape[] | undefined {
	if (shapes.length > MORPH_MAX_SHAPES) return undefined

	const boxes = new Map<number, NonNullable<(typeof render.layers)[number]["box"]>>()
	const drawings = new Map<number, DrawingData[]>()
	// Per object, its layers (a plain shape has exactly one).
	const own = new Map<number, SlideLayer[]>()

	for (const layer of render.layers) {
		if (layer.shape.slide !== render.ref || layer.box === undefined) continue
		if (!boxes.has(layer.box.id)) boxes.set(layer.box.id, layer.box)

		// The object's own drawing (a group's children draw theirs on their own layers).
		const list = drawings.get(layer.box.id) ?? []

		if (layer.shape.id === layer.box.id || list.length === 0) list.push(layer.drawing)

		drawings.set(layer.box.id, list)
		own.set(layer.box.id, [...(own.get(layer.box.id) ?? []), layer])
	}

	const out: MorphShape[] = []
	let chars = 0

	for (const shape of shapes) {
		const box = boxes.get(shape.id)

		if (shape.hidden || box === undefined) continue

		const text = bodyText(shape)

		chars += text?.length ?? 0

		const xfrm = box.xfrm
		const layers = own.get(shape.id) ?? []
		const vector =
			layers.length === 1 && layers[0] !== undefined
				? morphVector(shape, layers[0], shape.props?.geometry ?? geometry?.(shape))
				: undefined

		out.push({
			id: shape.id,
			name: shape.name,
			type: typeOf(shape),
			x: xfrm.x / 9525,
			y: xfrm.y / 9525,
			w: xfrm.cx / 9525,
			h: xfrm.cy / 9525,
			rot: xfrm.rot / 60000,
			flipH: xfrm.flipH,
			flipV: xfrm.flipV,
			outline: outlineOf(drawings.get(shape.id) ?? []),
			...(text === undefined ? {} : { text }),
			...(vector === undefined ? {} : { vector })
		})
	}

	// Past the text budget no object carries its text: words and characters then move with their objects.
	return chars > MORPH_MAX_TEXT ? out.map(({ text: _text, ...rest }) => rest) : out
}

// A pptx shape's own geometry (its p:spPr prstGeom or custGeom), read from the slide document it was read from at
// `epoch`; undefined for a shape without one (a placeholder inheriting its layout's) or from another epoch.
export function pptxGeometry(document: XmlDocument, epoch: number): (shape: ShapeNode) => Geometry | undefined {
	const r = partReader(document)

	return shape => {
		const src = shape.src

		if (src?.format !== "pptx" || src.epoch !== epoch || !r.is(src.node, G.P, "sp")) return undefined

		const spPr = r.child(src.node, G.P, "spPr")

		return spPr < 0 ? undefined : readGeometry(r, spPr)
	}
}

// --- Which WebGL transitions a deck uses ---

const LT = 0x3c
const COLON = 0x3a
// XML name bytes the scanner walks over (ASCII letters, digits, "_", "-", ".").
const NAME_BYTE = new Uint8Array(256)

for (let byte = 0; byte < 256; byte++)
	NAME_BYTE[byte] =
		(byte >= 0x61 && byte <= 0x7a) ||
		(byte >= 0x41 && byte <= 0x5a) ||
		(byte >= 0x30 && byte <= 0x39) ||
		byte === 0x5f ||
		byte === 0x2d ||
		byte === 0x2e
			? 1
			: 0

// The kinds as bytes, compared in place: no string is made for the other elements' names.
const KIND_BYTES: readonly (readonly [string, Uint8Array])[] = [...WEBGL_TRANSITION_KINDS].map(kind => [
	kind,
	Uint8Array.from(kind, c => c.charCodeAt(0))
])
const LONGEST_KIND = Math.max(...KIND_BYTES.map(([kind]) => kind.length))

function kindAt(data: Uint8Array, start: number, end: number): string | undefined {
	const length = end - start

	for (const [kind, bytes] of KIND_BYTES) {
		if (bytes.length !== length) continue

		let k = 0

		while (k < length && bytes[k] === data[start + k]) k++

		if (k === length) return kind
	}

	return undefined
}

// Finds the prefixed elements named in WEBGL_TRANSITION_KINDS in a part's bytes (MS-PPTX §2.2.1 writes them as
// p14:vortex… and p159:morph inside the slide's mc:AlternateContent), chunk by chunk without decoding the part: a
// tag cut by a chunk boundary is carried into the next chunk.
export class TransitionKindScanner {
	readonly found = new Set<string>()
	private carry: Uint8Array = new Uint8Array(0)

	push(chunk: Uint8Array): void {
		const data = this.carry.length === 0 ? chunk : concat(this.carry, chunk)
		const size = data.length
		let keep = size

		for (let at = data.indexOf(LT); at >= 0; at = data.indexOf(LT, at + 1)) {
			let k = at + 1

			while (k < size && NAME_BYTE[data[k] as number] === 1) k++

			if (k >= size) {
				keep = at

				break
			}

			if (data[k] !== COLON || k === at + 1) continue

			const start = k + 1
			let end = start

			while (end < size && NAME_BYTE[data[end] as number] === 1) end++

			if (end >= size) {
				keep = at

				break
			}

			if (end - start > LONGEST_KIND) continue

			const kind = kindAt(data, start, end)

			if (kind !== undefined) this.found.add(kind)
		}

		this.carry = keep >= size ? new Uint8Array(0) : data.slice(keep)
	}

	// The part is over.
	end(): void {
		this.carry = new Uint8Array(0)
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length)

	out.set(a)
	out.set(b, a.length)

	return out
}

// The WebGL transitions the slides of a pptx deck use: a parsed slide's from its model (so a transition set in the
// session counts), any other's from its part's bytes (no slide is parsed), each part scanned once into `scanned`,
// sliced.
export async function deckWebglTransitions(
	parts: PptxParts,
	slides: readonly SlideRef[],
	slicing: Slicing,
	nodes: ReadonlyMap<SlideRef, Pick<SlideNode, "transition">> = new Map(),
	scanned: Map<SlideRef, readonly string[]> = new Map()
): Promise<string[]> {
	const found = new Set<string>()
	const clock = new SliceClock(slicing)

	for (const ref of slides) {
		if (found.size === WEBGL_TRANSITION_KINDS.size) break

		const node = nodes.get(ref)

		if (node !== undefined) {
			const transition = node.transition

			if (transition !== undefined && transition.namespace !== "p" && WEBGL_TRANSITION_KINDS.has(transition.kind))
				found.add(transition.kind)

			continue
		}

		let kinds = scanned.get(ref)

		if (kinds === undefined) {
			const part = parts.partOf(ref)

			if (part === undefined || !parts.opc.has(part)) continue

			const scanner = new TransitionKindScanner()

			scanner.push(await parts.opc.read(part, clock))
			scanner.end()
			kinds = [...scanner.found]
			scanned.set(ref, kinds)

			if (clock.due) await clock.pause()
		}

		for (const kind of kinds) found.add(kind)
	}

	return [...found]
}
