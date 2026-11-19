import {
	DrawingList,
	IDENTITY,
	ITEM_FLOATS,
	ItemFlag,
	ItemFloat,
	ItemInt,
	ItemKind,
	PathCommand,
	multiply,
	type DrawingImage,
	type DrawingText,
	type ImageFormat,
	type Inset,
	type Paint,
	type Rgba,
	type Stroke
} from "../drawingml/displayList"
import { writeClip, type ClipEnv, type ClipNode } from "./clip"
import {
	MAX_COORDS,
	MAX_IMAGE_BYTES,
	MAX_INFLATED_BYTES,
	MAX_ITEMS,
	MAX_PATH_POINTS,
	MAX_RECORDS,
	MAX_TOTAL_DECODE_PIXELS,
	MAX_WORK,
	MetafileLimit
} from "./limits"

// What GDI and GDI+ playback write into: the output list with its limits, paths in output space, clip
// regions and embedded images.

export type Matrix = readonly number[]

export function transformX(m: Matrix, x: number, y: number): number {
	return (m[0] ?? 1) * x + (m[2] ?? 0) * y + (m[4] ?? 0)
}

export function transformY(m: Matrix, x: number, y: number): number {
	return (m[1] ?? 0) * x + (m[3] ?? 1) * y + (m[5] ?? 0)
}

// m1 * m2 (m2 applied first), by the name the players use.
export { multiply as mul }

// The inverse, or undefined for a singular matrix.
export function invert(m: Matrix): number[] | undefined {
	const a = m[0] ?? 1
	const b = m[1] ?? 0
	const c = m[2] ?? 0
	const d = m[3] ?? 1
	const e = m[4] ?? 0
	const f = m[5] ?? 0
	const det = a * d - b * c

	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined

	return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

// The mean scale of a matrix (the square root of its area factor).
export function scaleOf(m: Matrix): number {
	const det = Math.abs((m[0] ?? 1) * (m[3] ?? 1) - (m[1] ?? 0) * (m[2] ?? 0))

	return Number.isFinite(det) ? Math.sqrt(det) : 1
}

export function finiteMatrix(m: Matrix): boolean {
	for (let k = 0; k < 6; k++) if (!Number.isFinite(m[k] ?? 0)) return false

	return true
}

// A path in output space. Points arrive in the coordinate space of `matrix` and are transformed on entry.
export class PathBuilder {
	commands: number[] = []
	coords: number[] = []
	private a = 1
	private b = 0
	private c = 0
	private d = 1
	private e = 0
	private f = 0
	// Whether a figure is open (lineTo continues it), and the current point in output space.
	open = false
	lastX = 0
	lastY = 0

	setMatrix(m: Matrix): void {
		this.a = m[0] ?? 1
		this.b = m[1] ?? 0
		this.c = m[2] ?? 0
		this.d = m[3] ?? 1
		this.e = m[4] ?? 0
		this.f = m[5] ?? 0
	}

	clear(): void {
		this.commands.length = 0
		this.coords.length = 0
		this.open = false
	}

	get empty(): boolean {
		return this.commands.length === 0
	}

	private point(x: number, y: number): void {
		if (this.coords.length >= MAX_PATH_POINTS * 2) throw new MetafileLimit("path points")

		const ox = this.a * x + this.c * y + this.e
		const oy = this.b * x + this.d * y + this.f

		this.coords.push(ox, oy)
		this.lastX = ox
		this.lastY = oy
	}

	moveTo(x: number, y: number): void {
		this.commands.push(PathCommand.MOVE)
		this.point(x, y)
		this.open = true
	}

	lineTo(x: number, y: number): void {
		if (!this.open) {
			this.moveTo(x, y)

			return
		}

		this.commands.push(PathCommand.LINE)
		this.point(x, y)
	}

	cubicTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
		if (!this.open) this.moveTo(x1, y1)

		this.commands.push(PathCommand.CUBIC)
		this.point(x1, y1)
		this.point(x2, y2)
		this.point(x, y)
	}

	close(): void {
		if (!this.open) return

		this.commands.push(PathCommand.CLOSE)
		this.open = false
	}

	rect(x0: number, y0: number, x1: number, y1: number): void {
		this.moveTo(x0, y0)
		this.lineTo(x1, y0)
		this.lineTo(x1, y1)
		this.lineTo(x0, y1)
		this.close()
	}

	// An elliptic arc of the ellipse centred at (cx, cy) with radii rx, ry, from parametric angle `start` by
	// `sweep` radians (positive is towards +y), as cubic Béziers of at most 90°. `join` continues the open
	// figure with a line to the arc's start instead of moving there.
	arc(cx: number, cy: number, rx: number, ry: number, start: number, sweep: number, join: boolean): void {
		const x0 = cx + rx * Math.cos(start)
		const y0 = cy + ry * Math.sin(start)

		if (join && this.open) this.lineTo(x0, y0)
		else this.moveTo(x0, y0)

		if (!Number.isFinite(sweep) || sweep === 0) return

		const segments = Math.min(64, Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9)))
		const step = sweep / segments
		const k = (4 / 3) * Math.tan(step / 4)
		let t = start

		for (let s = 0; s < segments; s++) {
			const cos0 = Math.cos(t)
			const sin0 = Math.sin(t)
			const t1 = t + step
			const cos1 = Math.cos(t1)
			const sin1 = Math.sin(t1)

			this.cubicTo(
				cx + rx * (cos0 - k * sin0),
				cy + ry * (sin0 + k * cos0),
				cx + rx * (cos1 + k * sin1),
				cy + ry * (sin1 - k * cos1),
				cx + rx * cos1,
				cy + ry * sin1
			)
			t = t1
		}
	}

	ellipse(cx: number, cy: number, rx: number, ry: number): void {
		this.arc(cx, cy, rx, ry, 0, Math.PI * 2, false)
		this.close()
	}
}

export interface EmbeddedImage {
	readonly format: ImageFormat
	readonly bytes: Uint8Array
}

const NO_CROP: Inset = { left: 0, top: 0, right: 0, bottom: 0 }

export class Output {
	readonly list: DrawingList
	// Records or objects not drawn (unsupported kinds, glyph-index text, unknown formats).
	unsupported = 0
	private records = 0
	private imageBytes = 0
	private pixels = MAX_TOTAL_DECODE_PIXELS
	private work = MAX_WORK
	private inflated = MAX_INFLATED_BYTES
	// What clip regions combine with: the work budget and the extent standing for the whole plane.
	readonly env: ClipEnv
	private readonly solids = new Map<number, number>()

	constructor(width: number, height: number) {
		this.list = new DrawingList()
		this.list.width = width
		this.list.height = height
		this.env = { charge: units => this.charge(units), extent: Math.max(width, height, 1) * 64 }
	}

	// A raster operation composites with the picture's surface, which GDI draws on white (the page under
	// the picture).
	private surface(flags: number): void {
		if ((flags & ItemFlag.BLEND_MASK) !== 0) this.list.background ??= 0xffffffff
	}

	// Spends work units; beyond the budget playback ends.
	charge(units: number): void {
		this.work -= units

		if (!(this.work >= 0)) throw new MetafileLimit("work")
	}

	record(): void {
		if (++this.records > MAX_RECORDS) throw new MetafileLimit("records")
	}

	// Spends inflated bitmap bytes before they are allocated; beyond the budget playback ends.
	inflate(bytes: number): void {
		this.inflated -= bytes

		if (!(this.inflated >= 0)) throw new MetafileLimit("inflated bytes")
	}

	// Decoding budget (PixelBudget).
	spend(pixels: number): boolean {
		if (!(pixels >= 0) || pixels > this.pixels) return false

		this.pixels -= pixels

		return true
	}

	solid(color: Rgba): number {
		let index = this.solids.get(color)

		if (index === undefined) {
			index = this.list.paint({ kind: "solid", color })
			this.solids.set(color, index)
		}

		return index
	}

	paint(paint: Paint): number {
		return paint.kind === "solid" ? this.solid(paint.color) : this.list.paint(paint)
	}

	stroke(stroke: Stroke): number {
		return this.list.stroke(stroke)
	}

	private reserveCoords(coords: number): void {
		if (this.list.coordCount + coords > MAX_COORDS) throw new MetafileLimit("coordinates")
	}

	private reserve(coords: number): void {
		if (this.list.itemCount >= MAX_ITEMS) throw new MetafileLimit("items")
		if (this.list.coordCount + coords > MAX_COORDS) throw new MetafileLimit("coordinates")
	}

	private writePath(commands: readonly number[], coords: readonly number[]): void {
		const list = this.list
		let at = 0

		for (const command of commands) {
			switch (command) {
				case PathCommand.MOVE:
					list.moveTo(coords[at] ?? 0, coords[at + 1] ?? 0)
					at += 2
					break
				case PathCommand.LINE:
					list.lineTo(coords[at] ?? 0, coords[at + 1] ?? 0)
					at += 2
					break
				case PathCommand.CUBIC:
					list.cubicTo(
						coords[at] ?? 0,
						coords[at + 1] ?? 0,
						coords[at + 2] ?? 0,
						coords[at + 3] ?? 0,
						coords[at + 4] ?? 0,
						coords[at + 5] ?? 0
					)
					at += 6
					break
				case PathCommand.QUAD:
					list.quadTo(coords[at] ?? 0, coords[at + 1] ?? 0, coords[at + 2] ?? 0, coords[at + 3] ?? 0)
					at += 4
					break
				default:
					list.close()
					break
			}
		}
	}

	// The list's clip for a node (written on first use), or -1.
	clip(node: ClipNode | null): number {
		return node === null ? -1 : writeClip(this.list, node, coords => this.reserveCoords(coords))
	}

	// A path item in output space; nothing when it has neither fill nor stroke, or is clipped away.
	path(path: PathBuilder, fill: number, stroke: number, evenOdd: boolean, clip: ClipNode | null, flags: number = 0): void {
		if ((fill < 0 && stroke < 0) || path.empty || clip?.hidesAll === true) return

		this.reserve(path.coords.length)

		const clipIndex = this.clip(clip)
		const list = this.list
		const firstCommand = list.commandCount
		const firstCoord = list.coordCount

		this.writePath(path.commands, path.coords)

		const item = list.addItem(
			ItemKind.PATH,
			IDENTITY,
			0,
			0,
			0,
			0,
			firstCommand,
			firstCoord,
			fill,
			stroke,
			-1,
			-1,
			(evenOdd ? ItemFlag.EVEN_ODD : 0) | flags,
			0
		)

		this.surface(flags)

		this.box(item)

		if (clipIndex >= 0) list.setItemClip(item, clipIndex)
	}

	// A path item placed by `matrix` (for paints laid over a local box, such as text backgrounds).
	placedPath(path: PathBuilder, matrix: Matrix, fill: number, clip: ClipNode | null): void {
		if (fill < 0 || path.empty || clip?.hidesAll === true) return

		this.reserve(path.coords.length)

		const clipIndex = this.clip(clip)
		const list = this.list
		const firstCommand = list.commandCount
		const firstCoord = list.coordCount

		this.writePath(path.commands, path.coords)

		const item = list.addItem(ItemKind.PATH, matrix, 0, 0, 0, 0, firstCommand, firstCoord, fill, -1, -1, -1, 0, 0)

		if (clipIndex >= 0) list.setItemClip(item, clipIndex)
	}

	// Sets a path item's local box to its path's bounds, so gradients and patterns span the shape.
	private box(item: number): void {
		const list = this.list
		const at = item * 4
		const bounds = list.itemBounds
		const strokeIndex = list.itemInt(item, ItemInt.STROKE)
		const half = strokeIndex >= 0 ? (list.strokes[strokeIndex]?.width ?? 0) / 2 : 0
		const x = (bounds[at] ?? 0) + half
		const y = (bounds[at + 1] ?? 0) + half
		const floats = list.itemFloats
		const f = item * ITEM_FLOATS

		floats[f + ItemFloat.X] = x
		floats[f + ItemFloat.Y] = y
		floats[f + ItemFloat.WIDTH] = Math.max(0, (bounds[at + 2] ?? 0) - half - x)
		floats[f + ItemFloat.HEIGHT] = Math.max(0, (bounds[at + 3] ?? 0) - half - y)
	}

	image(image: number, matrix: Matrix, width: number, height: number, clip: ClipNode | null, flags: number = 0): void {
		if (image < 0 || !(width > 0 && height > 0) || clip?.hidesAll === true || !finiteMatrix(matrix)) return

		this.reserve(0)

		const clipIndex = this.clip(clip)
		const list = this.list
		const item = list.addItem(
			ItemKind.IMAGE,
			matrix,
			0,
			0,
			width,
			height,
			list.commandCount,
			list.coordCount,
			-1,
			-1,
			image,
			-1,
			flags,
			0
		)

		this.surface(flags)

		if (clipIndex >= 0) list.setItemClip(item, clipIndex)
	}

	// A text item. Positioned text is rescaled so its local units are output units: a renderer may clamp a
	// tiny font size that a large transform would otherwise scale up.
	text(
		text: DrawingText,
		matrix: Matrix,
		x: number,
		y: number,
		width: number,
		height: number,
		clip: ClipNode | null,
		fill?: Paint
	): void {
		if (clip?.hidesAll === true || !finiteMatrix(matrix)) return

		const scale = scaleOf(matrix)

		if ((text.kind === "glyphs" || text.kind === "block") && scale > 0 && Math.abs(scale - 1) > 1e-6) {
			const run = { ...text.run, size: text.run.size * scale }

			text =
				text.kind === "glyphs"
					? {
							...text,
							run,
							positions: text.positions === null ? null : Float32Array.from(text.positions, value => value * scale)
						}
					: { ...text, run, width: text.width * scale, height: text.height * scale, lineHeight: text.lineHeight * scale }
			matrix = multiply(matrix, [1 / scale, 0, 0, 1 / scale, 0, 0])
			x *= scale
			y *= scale
			width *= scale
			height *= scale
		}

		// A gradient or tile paint, given in output space, moves into the text's local space.
		const inverse = fill === undefined || fill.kind === "solid" ? undefined : invert(matrix)

		if (fill !== undefined && inverse !== undefined && (text.kind === "glyphs" || text.kind === "block")) {
			const local: Paint | undefined =
				fill.kind === "gradient"
					? { ...fill, matrix: multiply(inverse, fill.matrix) }
					: fill.kind === "image" && fill.tile?.matrix !== undefined
						? { ...fill, tile: { ...fill.tile, matrix: multiply(inverse, fill.tile.matrix) } }
						: fill.kind === "pattern"
							? fill
							: undefined

			if (local !== undefined) text = { ...text, fill: this.paint(local) }
		}

		this.reserve(0)

		const clipIndex = this.clip(clip)
		const list = this.list
		const item = list.addItem(
			ItemKind.TEXT,
			matrix,
			x,
			y,
			width,
			height,
			list.commandCount,
			list.coordCount,
			-1,
			-1,
			list.text(text),
			-1,
			0,
			0
		)

		if (clipIndex >= 0) list.setItemClip(item, clipIndex)
	}

	// An image the metafile carries, as an entry of the list's image table; -1 beyond the byte budget.
	embed(image: EmbeddedImage, crop: Inset = NO_CROP, alpha: number = 1): number {
		if (this.imageBytes + image.bytes.length > MAX_IMAGE_BYTES) return -1

		this.imageBytes += image.bytes.length

		const entry: DrawingImage = {
			partName: undefined,
			format: image.format,
			handling: "native",
			svgPartName: undefined,
			crop,
			alpha,
			grayscale: false,
			biLevel: -1,
			duotone: null,
			brightness: 0,
			contrast: 0,
			colorChange: null,
			bytes: image.bytes
		}

		return this.list.image(entry)
	}

	// The image entry again with another crop (the same bytes, drawn from a different source rectangle).
	recrop(image: number, crop: Inset, alpha: number): number {
		const entry = this.list.images[image]

		if (entry === undefined) return -1

		const same =
			entry.crop.left === crop.left &&
			entry.crop.top === crop.top &&
			entry.crop.right === crop.right &&
			entry.crop.bottom === crop.bottom &&
			entry.alpha === alpha

		return same ? image : this.list.image({ ...entry, crop, alpha })
	}
}
