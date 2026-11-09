import {
	PathCommand,
	type DashPreset,
	type Paint,
	type PatternPreset,
	type Rgba,
	type Stroke,
	type TextRun
} from "../drawingml/displayList"
import { Bytes } from "./bytes"
import {
	ClipCombine,
	ClipGeometry,
	combineClips,
	emptyClip,
	geometryClip,
	intersectClips,
	offsetClip,
	rectClip,
	type ClipNode
} from "./clip"
import { encodePng, passThrough, type PixelBudget } from "./dib"
import { appendConversion } from "./embed"
import type { Gdi } from "./gdi"
import {
	MAX_CONTINUED_OBJECT,
	MAX_DECODE_PIXELS,
	MAX_PATH_POINTS,
	MAX_REGION_DEPTH,
	MAX_REGION_NODES,
	MAX_SAVE_DEPTH,
	MAX_TEXT_CHARS,
	MetafileLimit
} from "./limits"
import { PathBuilder, finiteMatrix, mul, scaleOf, transformX, transformY, type EmbeddedImage, type Matrix, type Output } from "./output"
import { displayFace, drawnCodePoint, metafileFont, type MetafileFont } from "./text"
import type { MetafileConversion } from "./types"

// EMF+ ([MS-EMFPLUS]) records carried in EMF comments: the GDI+ drawing Office writes for charts, SmartArt
// and pictures. Records that change nothing drawn here are skipped; drawing records this player cannot draw
// are counted in `unsupported`, which makes a dual picture fall back to its EMF records.

type NestedConverter = (bytes: Uint8Array) => MetafileConversion

const IDENTITY = [1, 0, 0, 1, 0, 0]

// HatchStyle (2.1.1.13) in order; DrawingML's preset patterns are GDI+'s hatches.
const HATCHES: readonly PatternPreset[] = [
	"horz",
	"vert",
	"dnDiag",
	"upDiag",
	"cross",
	"diagCross",
	"pct5",
	"pct10",
	"pct20",
	"pct25",
	"pct30",
	"pct40",
	"pct50",
	"pct60",
	"pct70",
	"pct75",
	"pct80",
	"pct90",
	"ltDnDiag",
	"ltUpDiag",
	"dkDnDiag",
	"dkUpDiag",
	"wdDnDiag",
	"wdUpDiag",
	"ltVert",
	"ltHorz",
	"narVert",
	"narHorz",
	"dkVert",
	"dkHorz",
	"dashDnDiag",
	"dashUpDiag",
	"dashHorz",
	"dashVert",
	"smConfetti",
	"lgConfetti",
	"zigZag",
	"wave",
	"diagBrick",
	"horzBrick",
	"weave",
	"plaid",
	"divot",
	"dotGrid",
	"dotDmnd",
	"shingle",
	"trellis",
	"sphere",
	"smGrid",
	"smCheck",
	"lgCheck",
	"openDmnd",
	"solidDmnd"
]

// ARGB (stored B, G, R, A) to RGBA.
function argb(value: number): Rgba {
	return (((value >>> 16) & 255) * 0x1000000 + ((value >>> 8) & 255) * 0x10000 + (value & 255) * 0x100 + ((value >>> 24) & 255)) >>> 0
}

// Colours at positions 0..1 (ascending).
interface Ramp {
	readonly offsets: Float32Array
	readonly colors: Uint32Array
}

// Blend factors: the share of the second colour at each position.
interface Blend {
	readonly positions: Float32Array
	readonly factors: Float32Array
}

type BrushObject =
	| { readonly kind: "solid"; readonly color: Rgba }
	| { readonly kind: "hatch"; readonly pattern: PatternPreset; readonly foreground: Rgba; readonly background: Rgba }
	// Along the rectangle's width (x, y, width, height) through the brush transform.
	| {
			readonly kind: "linear"
			readonly rect: readonly [number, number, number, number]
			readonly transform: readonly number[]
			readonly ramp: Ramp
			readonly wrap: number
	  }
	// From the centre colour at the centre point out to the boundary's colours. Positions of `ramp` and
	// `blend` run from the boundary (0) to the centre (1).
	| {
			readonly kind: "pathGradient"
			readonly center: Rgba
			readonly centerPoint: readonly [number, number]
			readonly surround: readonly Rgba[]
			readonly boundary: Float64Array
			readonly ellipse: readonly [number, number, number, number] | null
			readonly transform: readonly number[]
			readonly ramp: Ramp | null
			readonly blend: Blend | null
			readonly focus: number
	  }
	| { readonly kind: "texture"; readonly image: ImageObject; readonly transform: readonly number[]; readonly wrap: number }

// A custom line cap in cap space (x across the line, y along it, outward positive), in pen widths.
interface CapShape {
	readonly fill: PathObject | null
	readonly line: PathObject | null
	readonly widthScale: number
}

interface PenObject {
	readonly kind: "pen"
	readonly width: number
	readonly unit: number
	readonly transformScale: number
	readonly style: number
	readonly dashes: Float32Array | null
	// LineCap values (2.1.1.18) of each end, and of dash ends.
	readonly startCap: number
	readonly endCap: number
	readonly dashCap: number
	readonly customStart: CapShape | null
	readonly customEnd: CapShape | null
	readonly join: Stroke["join"]
	readonly miterLimit: number
	readonly inset: boolean
	readonly brush: BrushObject
}

// A path in world units.
interface PathObject {
	readonly kind: "path"
	readonly points: Float64Array
	readonly types: Uint8Array
}

type RegionNode =
	| { readonly kind: "rect"; readonly x: number; readonly y: number; readonly w: number; readonly h: number }
	| { readonly kind: "path"; readonly path: PathObject }
	| { readonly kind: "empty" }
	| { readonly kind: "infinite" }
	| { readonly kind: "combine"; readonly mode: number; readonly left: RegionNode; readonly right: RegionNode }

interface ImageObject {
	readonly kind: "image"
	readonly width: number
	readonly height: number
	// Encoded once on first draw: the list's image index (-1 when it cannot be shown).
	encoded: number | undefined
	readonly encode: (budget: PixelBudget) => EmbeddedImage | undefined
	readonly metafile: Uint8Array | undefined
	conversion: MetafileConversion | undefined
}

interface FontObject {
	readonly kind: "font"
	readonly size: number
	readonly unit: number
	readonly font: MetafileFont
}

interface FormatObject {
	readonly kind: "format"
	// StringFormatFlags, StringAlignment of lines and of the line block, StringTrimming.
	readonly flags: number
	readonly align: number
	readonly lineAlign: number
	readonly trimming: number
	// Space before and after each line, in ems.
	readonly leadingMargin: number
	readonly trailingMargin: number
}

type PlusObject =
	| BrushObject
	| PenObject
	| PathObject
	| { readonly kind: "region"; readonly node: RegionNode }
	| ImageObject
	| FontObject
	| FormatObject
	// EmfPlusImageAttributes: how DrawImage fills where its source rectangle leaves the image.
	| { readonly kind: "attributes"; readonly wrap: number; readonly clamp: Rgba }
	| { readonly kind: "other" }

interface PlusState {
	readonly world: number[]
	readonly base: number[]
	readonly clip: ClipNode | null
	readonly pageUnit: number
	readonly pageScale: number
}

export class EmfPlus {
	// Drawing records or objects this player could not draw.
	unsupported = 0
	// The picture is "EMF+ Dual": its EMF records draw it too.
	dual = false
	// The last EMF+ record was GetDC: the EMF records that follow are drawn.
	getDc = false
	private readonly gdi: Gdi
	private readonly out: Output
	private readonly bytes: Bytes
	private readonly nested: NestedConverter
	private readonly objects = new Map<number, PlusObject>()
	private continued: { id: number; type: number; total: number; parts: Uint8Array[]; received: number } | null = null
	// Bytes copied to join continued objects; at most the input's size over the whole conversion.
	private joinedBytes = 0
	// The container's transform (world units of the outer container), the world transform inside it.
	private base = IDENTITY.slice()
	private world = IDENTITY.slice()
	private pageUnit = 1
	private pageScale = 1
	private dpiX = 96
	private dpiY = 96
	private video = true
	private clip: ClipNode | null = null
	private readonly states = new Map<number, PlusState>()
	// Path-gradient paints per brush and the transform they were made under.
	private readonly gradients = new WeakMap<object, { key: string; paint: Paint }>()
	// Clip geometry built from path objects, per path and the transform it was built under.
	private readonly pathGeometries = new Map<PathObject, { key: string; geometry: ClipGeometry }>()
	private readonly scratch = new PathBuilder()
	private textChars = 0
	private cached: number[] | null = null

	constructor(gdi: Gdi, bytes: Bytes, nested: NestedConverter) {
		this.gdi = gdi
		this.out = gdi.out
		this.bytes = bytes
		this.nested = nested
	}

	// Device pixels per unit (UnitType, 2.1.1.33).
	private unitPx(unit: number, horizontal: boolean): number {
		const dpi = horizontal ? this.dpiX : this.dpiY

		switch (unit) {
			case 1:
				return this.video ? 1 : dpi / 100
			case 3:
				return dpi / 72
			case 4:
				return dpi
			case 5:
				return dpi / 300
			case 6:
				return dpi / 25.4
			default:
				return 1
		}
	}

	// World units to output space.
	private matrix(): number[] {
		if (this.cached === null) {
			const page = [this.pageScale * this.unitPx(this.pageUnit, true), 0, 0, this.pageScale * this.unitPx(this.pageUnit, false), 0, 0]
			const m = mul(this.gdi.deviceToOutput, mul(page, mul(this.base, this.world)))

			this.cached = finiteMatrix(m) ? m : [0, 0, 0, 0, 0, 0]
		}

		return this.cached
	}

	private setWorld(world: number[]): void {
		if (!finiteMatrix(world)) return

		this.world = world
		this.cached = null
	}

	// Plays the EMF+ records in [at, end).
	play(at: number, end: number): void {
		const bytes = this.bytes

		while (at + 12 <= end) {
			const type = bytes.u16(at)
			const flags = bytes.u16(at + 2)
			const size = bytes.u32(at + 4)
			const dataSize = bytes.u32(at + 8)

			if (size < 12 || at + size > end || dataSize > size - 12) return

			this.out.record()
			this.getDc = false
			this.record(type, flags, at + 12, dataSize)
			at += size
		}
	}

	private record(type: number, flags: number, d: number, size: number): void {
		const b = this.bytes

		switch (type) {
			case 0x4001:
				this.dual = (flags & 1) !== 0
				this.video = (b.u32(d + 4) & 1) !== 0
				this.dpiX = b.u32(d + 8) || 96
				this.dpiY = b.u32(d + 12) || 96
				this.cached = null
				break
			case 0x4004:
				this.getDc = true
				break
			case 0x4008:
				this.object(flags, d, size)
				break
			case 0x4009: {
				const builder = this.builder(IDENTITY)

				builder.setMatrix(IDENTITY)
				builder.rect(0, 0, this.out.list.width, this.out.list.height)
				this.out.path(builder, this.out.solid(argb(b.u32(d))), -1, false, this.clip)
				break
			}
			case 0x400a:
			case 0x400b: {
				const fill = type === 0x400a
				const count = b.u32(d + (fill ? 4 : 0))
				const first = d + (fill ? 8 : 4)
				const compressed = (flags & 0x4000) !== 0
				const builder = this.builder(this.matrix())

				for (let k = 0; k < count && k < MAX_PATH_POINTS; k++) {
					const r = this.rect(first + k * (compressed ? 8 : 16), compressed)

					if (r === undefined) break

					builder.rect(r[0], r[1], r[0] + r[2], r[1] + r[3])
				}

				if (fill) this.fill(builder, flags, b.u32(d), false)
				else this.strokeWith(builder, flags & 0xff)

				break
			}
			case 0x400c: {
				const count = b.u32(d + 4)
				const points = this.points(d + 8, count, flags, d + size)
				const builder = this.builder(this.matrix())

				this.polygon(builder, points, true)
				this.fill(builder, flags, b.u32(d), false)
				break
			}
			case 0x400d: {
				const points = this.points(d + 4, b.u32(d), flags, d + size)
				const builder = this.builder(this.matrix())

				this.polygon(builder, points, (flags & 0x2000) !== 0)
				this.strokeWith(builder, flags & 0xff)
				break
			}
			case 0x400e:
			case 0x400f: {
				const fill = type === 0x400e
				const r = this.rect(d + (fill ? 4 : 0), (flags & 0x4000) !== 0)

				if (r === undefined) break

				const builder = this.builder(this.matrix())

				builder.ellipse(r[0] + r[2] / 2, r[1] + r[3] / 2, r[2] / 2, r[3] / 2)

				if (fill) this.fill(builder, flags, b.u32(d), false)
				else this.strokeWith(builder, flags & 0xff)

				break
			}
			case 0x4010:
			case 0x4011:
			case 0x4012: {
				const fill = type === 0x4010
				const base = d + (fill ? 4 : 0)
				const start = (b.f32(base) * Math.PI) / 180
				const sweep = (b.f32(base + 4) * Math.PI) / 180
				const r = this.rect(base + 8, (flags & 0x4000) !== 0)

				if (r === undefined) break

				const builder = this.builder(this.matrix())
				const cx = r[0] + r[2] / 2
				const cy = r[1] + r[3] / 2

				if (type !== 0x4012) builder.moveTo(cx, cy)

				builder.arc(cx, cy, r[2] / 2, r[3] / 2, start, sweep, type !== 0x4012)

				if (type !== 0x4012) builder.close()

				if (fill) this.fill(builder, flags, b.u32(d), false)
				else this.strokeWith(builder, flags & 0xff)

				break
			}
			case 0x4013: {
				const region = this.objects.get(flags & 0xff)

				if (region?.kind === "region") {
					const node = intersectClips(this.clip, this.region(region.node, 0), this.out.env)
					const builder = this.builder(IDENTITY)

					const extent = this.extent()

					builder.rect(-extent, -extent, extent, extent)
					this.fill(builder, flags, b.u32(d), false, node)
				}

				break
			}
			case 0x4014:
			case 0x4015: {
				const path = this.objects.get(flags & 0xff)

				if (path?.kind !== "path") break

				const builder = this.builder(this.matrix())

				this.addPath(builder, path)

				if (type === 0x4014) this.fill(builder, flags, b.u32(d), false)
				else this.strokeWith(builder, b.u32(d))

				break
			}
			case 0x4016:
			case 0x4017:
			case 0x4018: {
				const fill = type === 0x4016
				const tension = b.f32(d + (fill ? 4 : 0))
				const countAt = d + (fill ? 8 : type === 0x4018 ? 12 : 4)
				const points = this.points(countAt + 4, b.u32(countAt), type === 0x4018 ? flags & 0x4000 : flags, d + size)
				const builder = this.builder(this.matrix())

				// DrawCurve strokes NumSegments segments from point Offset; the other points only shape tangents.
				if (type === 0x4018) curve(builder, points, tension, false, b.u32(d + 4), b.u32(d + 8))
				else curve(builder, points, tension, true)

				if (fill) this.fill(builder, flags, b.u32(d), (flags & 0x2000) === 0)
				else this.strokeWith(builder, flags & 0xff)

				break
			}
			case 0x4019: {
				const points = this.points(d + 4, b.u32(d), flags, d + size)
				const builder = this.builder(this.matrix())

				if (points.length >= 2) {
					builder.moveTo(points[0] ?? 0, points[1] ?? 0)

					for (let k = 2; k + 5 < points.length; k += 6) {
						builder.cubicTo(
							points[k] ?? 0,
							points[k + 1] ?? 0,
							points[k + 2] ?? 0,
							points[k + 3] ?? 0,
							points[k + 4] ?? 0,
							points[k + 5] ?? 0
						)
					}
				}

				this.strokeWith(builder, flags & 0xff)
				break
			}
			case 0x401a:
			case 0x401b:
				this.drawImage(type, flags, d, size)
				break
			case 0x401c:
				this.drawString(flags, d, size)
				break
			case 0x4025:
			case 0x4028:
				this.save(b.u32(d))
				break
			case 0x4026:
			case 0x4029:
				this.restore(b.u32(d))
				break
			case 0x4027: {
				const dest = this.rect(d, false)
				const src = this.rect(d + 16, false)

				this.save(b.u32(d + 32))

				if (dest !== undefined && src !== undefined && src[2] !== 0 && src[3] !== 0) {
					const unit = (flags >>> 8) & 0xff
					const scale = this.unitPx(unit, true) / this.unitPx(this.pageUnit, true) / this.pageScale
					const sx = (dest[2] / src[2]) * scale
					const sy = (dest[3] / src[3]) * scale

					this.base = mul(mul(this.base, this.world), [sx, 0, 0, sy, dest[0] - src[0] * sx, dest[1] - src[1] * sy])
					this.setWorld(IDENTITY.slice())
				}

				break
			}
			case 0x402a:
				this.setWorld(this.matrixAt(d))
				break
			case 0x402b:
				this.setWorld(IDENTITY.slice())
				break
			case 0x402c:
				this.transform(this.matrixAt(d), flags)
				break
			case 0x402d:
				this.transform([1, 0, 0, 1, b.f32(d), b.f32(d + 4)], flags)
				break
			case 0x402e:
				this.transform([b.f32(d), 0, 0, b.f32(d + 4), 0, 0], flags)
				break
			case 0x402f: {
				const angle = (b.f32(d) * Math.PI) / 180

				this.transform([Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0], flags)
				break
			}
			case 0x4030:
				this.pageUnit = flags & 0xff
				this.pageScale = b.f32(d) || 1
				this.cached = null
				break
			case 0x4031:
				this.clip = null
				break
			case 0x4032: {
				const r = this.rect(d, false)

				if (r !== undefined)
					this.combine(rectClip(r[0], r[1], r[0] + r[2], r[1] + r[3], this.matrix(), this.out.env), (flags >>> 8) & 0xf)

				break
			}
			case 0x4033: {
				const path = this.objects.get(flags & 0xff)

				if (path?.kind === "path") this.combine(this.pathRegion(path), (flags >>> 8) & 0xf)

				break
			}
			case 0x4034: {
				const region = this.objects.get(flags & 0xff)

				if (region?.kind === "region") this.combine(this.region(region.node, 0), (flags >>> 8) & 0xf)

				break
			}
			case 0x4035: {
				const m = this.matrix()
				const dx = b.f32(d)
				const dy = b.f32(d + 4)

				this.clip = offsetClip(this.clip, (m[0] ?? 1) * dx + (m[2] ?? 0) * dy, (m[1] ?? 0) * dx + (m[3] ?? 1) * dy, this.out.env)
				break
			}
			case 0x4036:
				this.drawDriverString(flags, d, size)
				break
			// Header end, comments, multi-format brackets, rendering hints, compositing settings, and the
			// effects / terminal-server records change nothing drawn here.
			case 0x4002:
			case 0x4003:
			case 0x4005:
			case 0x4006:
			case 0x4007:
			case 0x401d:
			case 0x401e:
			case 0x401f:
			case 0x4020:
			case 0x4021:
			case 0x4022:
			case 0x4023:
			case 0x4024:
			case 0x4038:
			case 0x4039:
			case 0x403a:
				break
			default:
				this.unsupported++
				break
		}
	}

	private builder(matrix: Matrix): PathBuilder {
		const builder = this.scratch

		builder.clear()
		builder.setMatrix(matrix)

		return builder
	}

	private matrixAt(at: number): number[] {
		const b = this.bytes

		return [b.f32(at), b.f32(at + 4), b.f32(at + 8), b.f32(at + 12), b.f32(at + 16), b.f32(at + 20)]
	}

	// Prepends (the default, applied first) or appends (flag A) a transform to the world transform.
	private transform(m: number[], flags: number): void {
		this.setWorld((flags & 0x2000) !== 0 ? mul(m, this.world) : mul(this.world, m))
	}

	private save(index: number): void {
		if (this.states.size >= MAX_SAVE_DEPTH && !this.states.has(index)) throw new MetafileLimit("saved states")

		this.states.set(index, { world: this.world, base: this.base, clip: this.clip, pageUnit: this.pageUnit, pageScale: this.pageScale })
	}

	private restore(index: number): void {
		const state = this.states.get(index)

		if (state === undefined) return

		this.states.delete(index)
		this.world = state.world
		this.base = state.base
		this.clip = state.clip
		this.pageUnit = state.pageUnit
		this.pageScale = state.pageScale
		this.cached = null
	}

	private extent(): number {
		return this.out.env.extent
	}

	// CombineMode (2.1.1.4): Replace, Intersect, Union, XOR, Exclude, Complement.
	private combine(region: ClipNode | null, mode: number): void {
		const modes = [ClipCombine.COPY, ClipCombine.AND, ClipCombine.OR, ClipCombine.XOR, ClipCombine.DIFF, ClipCombine.COMPLEMENT]

		this.clip = combineClips(this.clip, region, modes[mode] ?? ClipCombine.COPY, this.out.env)
	}

	// A path object's region under the current transform; the geometry is built once per path and transform.
	private pathRegion(path: PathObject): ClipNode {
		const m = this.matrix()
		const key = m.join(",")
		const cached = this.pathGeometries.get(path)

		if (cached !== undefined && cached.key === key) return geometryClip(cached.geometry, true)

		const builder = this.builder(m)

		this.addPath(builder, path)

		if (builder.empty) return emptyClip()

		this.out.charge(builder.coords.length)

		const geometry = new ClipGeometry(builder.commands.slice(), builder.coords.slice())

		this.pathGeometries.set(path, { key, geometry })

		return geometryClip(geometry, true)
	}

	// A region tree as a clip (null is the whole plane).
	private region(node: RegionNode, depth: number): ClipNode | null {
		if (depth > MAX_REGION_DEPTH) throw new MetafileLimit("region depth")

		switch (node.kind) {
			case "rect":
				return rectClip(node.x, node.y, node.x + node.w, node.y + node.h, this.matrix(), this.out.env)
			case "path":
				return this.pathRegion(node.path)
			case "empty":
				return emptyClip()
			case "infinite":
				return null
			case "combine": {
				const modes = [0, ClipCombine.AND, ClipCombine.OR, ClipCombine.XOR, ClipCombine.DIFF, ClipCombine.COMPLEMENT]

				return combineClips(
					this.region(node.left, depth + 1),
					this.region(node.right, depth + 1),
					modes[node.mode] ?? ClipCombine.AND,
					this.out.env
				)
			}
		}
	}

	// --- Geometry ---

	// A rectangle (x, y, width, height): RectF, or 16-bit Rect when compressed.
	private rect(at: number, compressed: boolean): [number, number, number, number] | undefined {
		const b = this.bytes

		if (!b.has(at, compressed ? 8 : 16)) return undefined

		return compressed
			? [b.i16(at), b.i16(at + 2), b.i16(at + 4), b.i16(at + 6)]
			: [b.f32(at), b.f32(at + 4), b.f32(at + 8), b.f32(at + 12)]
	}

	// Points as x, y pairs: PointF, 16-bit Point (C), or relative 7/15-bit offsets (P).
	private points(at: number, count: number, flags: number, end: number): Float64Array {
		const b = this.bytes
		const relative = (flags & 0x0800) !== 0
		const compressed = (flags & 0x4000) !== 0
		const n = Math.max(0, Math.min(count, MAX_PATH_POINTS, Math.floor((end - at) / (relative ? 2 : compressed ? 4 : 8))))
		const out = new Float64Array(n * 2)

		if (relative) {
			let p = at
			let x = 0
			let y = 0
			const integer = (): number => {
				const first = b.u8(p)

				if ((first & 0x80) === 0) {
					p += 1

					return first & 0x40 ? first - 0x80 : first
				}

				const value = ((first & 0x7f) << 8) | b.u8(p + 1)

				p += 2

				return value & 0x4000 ? value - 0x8000 : value
			}

			for (let k = 0; k < n && p < end; k++) {
				x += integer()
				y += integer()
				out[k * 2] = x
				out[k * 2 + 1] = y
			}

			return out
		}

		for (let k = 0; k < n; k++) {
			out[k * 2] = compressed ? b.i16(at + k * 4) : b.f32(at + k * 8)
			out[k * 2 + 1] = compressed ? b.i16(at + k * 4 + 2) : b.f32(at + k * 8 + 4)
		}

		return out
	}

	private polygon(builder: PathBuilder, points: Float64Array, close: boolean): void {
		if (points.length < 2) return

		builder.moveTo(points[0] ?? 0, points[1] ?? 0)

		for (let k = 2; k + 1 < points.length; k += 2) builder.lineTo(points[k] ?? 0, points[k + 1] ?? 0)

		if (close) builder.close()
	}

	private addPath(builder: PathBuilder, path: PathObject): void {
		const { points, types } = path
		const count = Math.min(types.length, points.length / 2)

		for (let k = 0; k < count; k++) {
			const type = types[k] ?? 0
			const x = points[k * 2] ?? 0
			const y = points[k * 2 + 1] ?? 0

			switch (type & 7) {
				case 0:
					builder.moveTo(x, y)
					break
				case 3:
					if (k + 2 < count) {
						builder.cubicTo(
							x,
							y,
							points[k * 2 + 2] ?? 0,
							points[k * 2 + 3] ?? 0,
							points[k * 2 + 4] ?? 0,
							points[k * 2 + 5] ?? 0
						)
						k += 2
					}

					break
				default:
					builder.lineTo(x, y)
					break
			}

			if (((types[k] ?? 0) & 0x80) !== 0) builder.close()
		}
	}

	// --- Paint ---

	// A brush (an object, or an ARGB colour with flag S) as a paint index, or -1.
	private brushPaint(flags: number, value: number): number {
		if ((flags & 0x8000) !== 0) return this.out.solid(argb(value))

		const brush = this.objects.get(value)

		return brush === undefined ? -1 : this.paintOf(brush)
	}

	private paintOf(object: PlusObject): number {
		const paint = this.paintObject(object)

		return paint === undefined ? -1 : this.out.paint(paint)
	}

	// A brush's paint in output space under the current transform.
	private paintObject(object: PlusObject): Paint | undefined {
		switch (object.kind) {
			case "solid":
				return { kind: "solid", color: object.color }
			case "hatch":
				return { kind: "pattern", pattern: object.pattern, foreground: object.foreground, background: object.background }
			case "linear": {
				const [x, y, w, h] = object.rect

				return {
					kind: "gradient",
					type: "linear",
					stops: object.ramp,
					matrix: mul(this.matrix(), mul(object.transform, [w, 0, 0, h, x, y])),
					spread: spreadOf(object.wrap)
				}
			}
			case "pathGradient":
				return this.pathGradient(object)
			case "texture":
				return this.texture(object)
			default:
				return undefined
		}
	}

	// An elliptical path gradient as a radial gradient focused on its centre point; any other boundary (or
	// a colour per boundary point) shaded into a tile.
	// A path gradient's paint, made once per brush and transform (a shaded tile is costly).
	private pathGradient(brush: Extract<BrushObject, { kind: "pathGradient" }>): Paint {
		const m = mul(this.matrix(), brush.transform)
		const key = m.join(",")
		const cached = this.gradients.get(brush)

		if (cached !== undefined && cached.key === key) return cached.paint

		const paint = this.makePathGradient(brush, m)

		this.gradients.set(brush, { key, paint })

		return paint
	}

	private makePathGradient(brush: Extract<BrushObject, { kind: "pathGradient" }>, m: readonly number[]): Paint {
		const surround = brush.surround[0] ?? brush.center
		const uniform = brush.surround.every(color => color === surround)
		const colorAt = (position: number, edge: Rgba): Rgba => {
			if (brush.ramp !== null) return rampColor(brush.ramp, position)
			if (brush.blend !== null) return mix(edge, brush.center, rampFactor(brush.blend, position))

			return mix(edge, brush.center, position)
		}
		if (brush.ellipse !== null && uniform) {
			const [cx, cy, rx, ry] = brush.ellipse
			const [px, py] = brush.centerPoint
			const samples =
				brush.ramp !== null ? Array.from(brush.ramp.offsets) : brush.blend !== null ? Array.from(brush.blend.positions) : [0, 1]
			const offsets: number[] = []
			const colors: number[] = []

			// SVG offsets run from the focus (0) to the edge (1): the reverse of GDI+ positions.
			for (const sample of [...new Set(samples)].sort((a, b) => b - a)) {
				const t = Math.min(1, Math.max(0, sample))
				const offset = 1 - t

				offsets.push(brush.focus > 0 && brush.focus < 1 ? brush.focus + offset * (1 - brush.focus) : offset)
				colors.push(colorAt(t, surround))
			}

			if (brush.focus > 0 && brush.focus < 1) {
				offsets.unshift(0)
				colors.unshift(colors[0] ?? brush.center)
			}

			return {
				kind: "gradient",
				type: "radial",
				stops: { offsets: Float32Array.from(offsets), colors: Uint32Array.from(colors) },
				matrix: mul(m, [rx, 0, 0, ry, cx, cy]),
				spread: "pad",
				focus: [rx === 0 ? 0 : (px - cx) / rx, ry === 0 ? 0 : (py - cy) / ry]
			}
		}

		const ring = brush.boundary
		const count = Math.floor(ring.length / 2)

		if (count < 3) return { kind: "solid", color: brush.center }

		// A fan from the centre point to each boundary edge, shaded by the renderer at its resolution.
		const points = new Float32Array(count * 6)
		const colors = new Uint32Array(count * 3)
		const cx = transformX(m, brush.centerPoint[0], brush.centerPoint[1])
		const cy = transformY(m, brush.centerPoint[0], brush.centerPoint[1])

		for (let k = 0; k < count; k++) {
			const next = (k + 1) % count

			for (const [slot, index] of [
				[1, k],
				[2, next]
			] as const) {
				const x = ring[index * 2] ?? 0
				const y = ring[index * 2 + 1] ?? 0

				points[k * 6 + slot * 2] = transformX(m, x, y)
				points[k * 6 + slot * 2 + 1] = transformY(m, x, y)
				colors[k * 3 + slot] = brush.surround[Math.min(index, brush.surround.length - 1)] ?? surround
			}

			points[k * 6] = cx
			points[k * 6 + 1] = cy
			colors[k * 3] = brush.center
		}

		return {
			kind: "shaded",
			points,
			colors,
			ramp: {
				center: brush.center,
				offsets: brush.ramp?.offsets ?? null,
				colors: brush.ramp?.colors ?? null,
				positions: brush.blend?.positions ?? null,
				factors: brush.blend?.factors ?? null,
				focus: brush.focus
			}
		}
	}

	// A texture brush: its image tiled (mirrored or clamped per wrap mode) through the brush transform, one
	// image pixel per device pixel at the logical resolution.
	private texture(brush: Extract<BrushObject, { kind: "texture" }>): Paint | undefined {
		const image = brush.image

		if (image.metafile !== undefined || image.width <= 0 || image.height <= 0) {
			this.unsupported++

			return undefined
		}

		const index = this.imageIndex(image)

		if (index < 0) return undefined

		const page = this.pageScale * this.unitPx(this.pageUnit, true)
		const scale = page === 0 ? 1 : 1 / page
		const wrap = brush.wrap

		return {
			kind: "image",
			image: index,
			stretch: undefined,
			tile: {
				tx: 0,
				ty: 0,
				sx: 1,
				sy: 1,
				flip: wrap === 1 ? "x" : wrap === 2 ? "y" : wrap === 3 ? "xy" : "none",
				align: "tl",
				width: image.width,
				height: image.height,
				matrix: mul(this.matrix(), mul(brush.transform, [scale, 0, 0, scale, 0, 0])),
				clamp: wrap === 4
			}
		}
	}

	// A brush's representative colour (text drawn with a gradient or texture also gets the paint itself).
	private brushColor(flags: number, value: number): Rgba | undefined {
		if ((flags & 0x8000) !== 0) return argb(value)

		const brush = this.objects.get(value)

		switch (brush?.kind) {
			case "solid":
				return brush.color
			case "hatch":
				return brush.foreground
			case "linear":
				return brush.ramp.colors[0]
			case "pathGradient":
				return brush.center
			case "texture":
				return 0x808080ff
			default:
				return undefined
		}
	}

	private fill(builder: PathBuilder, flags: number, brush: number, evenOdd: boolean, clip: ClipNode | null = this.clip): void {
		const paint = this.brushPaint(flags, brush)

		if (paint >= 0) this.out.path(builder, paint, -1, evenOdd, clip)
	}

	private strokeWith(builder: PathBuilder, penId: number): void {
		const pen = this.objects.get(penId)

		if (pen?.kind !== "pen") return

		const paint = this.paintOf(pen.brush)

		if (paint < 0) return

		const devicePx = this.gdi.devicePx
		const width =
			pen.width <= 0
				? devicePx
				: Math.max(
						devicePx,
						pen.width *
							pen.transformScale *
							(pen.unit === 0 || pen.unit === 1 ? scaleOf(this.matrix()) : this.unitPx(pen.unit, true) * devicePx)
					)
		const presets: readonly DashPreset[] = ["solid", "sysDash", "sysDot", "sysDashDot", "sysDashDotDot"]
		const dashed = pen.style !== 0
		const simple = (cap: number): Stroke["cap"] | undefined =>
			cap === 0 || cap === 0x10 ? "flat" : cap === 1 ? "square" : cap === 2 ? "round" : undefined
		const start = simple(pen.startCap)
		// Ends of one simple kind are the stroke's own caps; anything else is drawn as geometry.
		const strokeCaps = start !== undefined && start === simple(pen.endCap)
		const cap: Stroke["cap"] = strokeCaps && !dashed ? (start ?? "flat") : dashed ? (pen.dashCap === 2 ? "round" : "flat") : "flat"
		const stroke: Stroke = {
			width,
			paint,
			dash: pen.style === 5 ? "solid" : (presets[pen.style] ?? "solid"),
			customDash: pen.style === 5 ? pen.dashes : null,
			cap,
			join: pen.join,
			miterLimit: pen.miterLimit,
			compound: "sng",
			inset: pen.inset
		}

		this.out.path(builder, -1, this.out.stroke(stroke), false, this.clip)

		if (strokeCaps && !dashed) return

		const fills = new PathBuilder()
		const lines = new PathBuilder()

		forEachEnd(builder, (x, y, ux, uy, atStart) => {
			const kind = atStart ? pen.startCap : pen.endCap
			const custom = atStart ? pen.customStart : pen.customEnd

			capGeometry(kind, custom, x, y, ux, uy, width, fills, lines)
		})

		this.out.path(fills, paint, -1, false, this.clip)

		if (!lines.empty)
			this.out.path(lines, -1, this.out.stroke({ ...stroke, dash: "solid", customDash: null, cap: "flat" }), false, this.clip)
	}

	// --- Objects ---

	private object(flags: number, d: number, size: number): void {
		const id = flags & 0xff
		const type = (flags >>> 8) & 0x7f
		const b = this.bytes

		if (id >= 64) return

		let data: Bytes = b
		let at = d
		let length = size
		const pending = this.continued

		if ((flags & 0x8000) !== 0) {
			// Continued: TotalObjectSize, then this record's part. Parts are kept as views of the input and
			// joined once complete, so a declared size allocates nothing by itself.
			const total = b.u32(d)
			const part = b.sub(d + 4, size - 4)

			if (pending === null || pending.id !== id || pending.type !== type) {
				if (total === 0 || total > MAX_CONTINUED_OBJECT || total > b.length) return

				this.continued = { id, type, total, parts: [part], received: part.length }
			} else {
				pending.parts.push(part)
				pending.received += part.length
			}

			const current = this.continued

			if (current === null || current.received < current.total) return

			this.continued = null
			data = this.joined(current.parts, current.total)
			at = 0
			length = data.length
		} else if (pending !== null && pending.id === id && pending.type === type) {
			// The final part of a continued object carries no continuation flag.
			pending.parts.push(b.sub(d, size))
			this.continued = null
			data = this.joined(pending.parts, Math.min(pending.total, pending.received + size))
			at = 0
			length = data.length
		}

		const object = parseObject(data, at, length, type, this)

		if (object === undefined) this.objects.delete(id)
		else this.objects.set(id, object)
	}

	private joined(parts: readonly Uint8Array[], total: number): Bytes {
		if (this.joinedBytes + total > this.bytes.length) throw new MetafileLimit("continued objects")

		this.joinedBytes += total

		const out = new Uint8Array(total)
		let at = 0

		for (const part of parts) {
			if (at >= total) break

			const take = Math.min(part.length, total - at)

			out.set(part.subarray(0, take), at)
			at += take
		}

		return new Bytes(out)
	}

	// --- Images ---

	private imageIndex(image: ImageObject): number {
		if (image.encoded === undefined) {
			const encoded = image.encode(this.out)

			image.encoded = encoded === undefined ? -1 : this.out.embed(encoded)

			if (encoded === undefined) this.unsupported++
		}

		return image.encoded
	}

	private drawImage(type: number, flags: number, d: number, size: number): void {
		const image = this.objects.get(flags & 0xff)

		if (image?.kind !== "image") return

		const b = this.bytes
		const src = this.rect(d + 8, false)
		let destination: number[]

		if (type === 0x401a) {
			const r = this.rect(d + 24, (flags & 0x4000) !== 0)

			if (r === undefined) return

			destination = [r[2], 0, 0, r[3], r[0], r[1]]
		} else {
			const points = this.points(d + 28, Math.min(3, b.u32(d + 24)), flags, d + size)

			if (points.length < 6) return

			const [x0 = 0, y0 = 0, x1 = 0, y1 = 0, x2 = 0, y2 = 0] = points

			destination = [x1 - x0, y1 - y0, x2 - x0, y2 - y0, x0, y0]
		}

		// The unit box onto the destination, in output space.
		const placement = mul(this.matrix(), destination)

		if (image.metafile !== undefined) {
			image.conversion ??= this.nested(image.metafile)

			const conversion = image.conversion

			if (!conversion.ok) {
				this.unsupported++

				return
			}

			const [fx, fy, fw, fh] = conversion.frame

			if (fw > 0 && fh > 0)
				appendConversion(this.out, conversion, mul(placement, [1 / fw, 0, 0, 1 / fh, -fx / fw, -fy / fh]), this.clip)

			return
		}

		const index = this.imageIndex(image)

		if (index < 0) return

		const valid = src !== undefined && image.width > 0 && image.height > 0 && src[2] > 0 && src[3] > 0
		const crop = valid
			? {
					left: src[0] / image.width,
					top: src[1] / image.height,
					right: 1 - (src[0] + src[2]) / image.width,
					bottom: 1 - (src[1] + src[3]) / image.height
				}
			: { left: 0, top: 0, right: 0, bottom: 0 }
		const attributes = this.objects.get(b.u32(d))
		const outside = crop.left < 0 || crop.top < 0 || crop.right < 0 || crop.bottom < 0

		if (valid && outside && attributes?.kind === "attributes") {
			const unit = this.builder(placement)

			unit.rect(0, 0, 1, 1)

			if (attributes.wrap <= 3) {
				// Tiled (or mirrored) beyond the image: the source rectangle's pixels onto the destination.
				const wrap = attributes.wrap
				const paint = this.out.paint({
					kind: "image",
					image: index,
					stretch: undefined,
					tile: {
						tx: 0,
						ty: 0,
						sx: 1,
						sy: 1,
						flip: wrap === 1 ? "x" : wrap === 2 ? "y" : wrap === 3 ? "xy" : "none",
						align: "tl",
						width: image.width,
						height: image.height,
						matrix: mul(placement, [1 / src[2], 0, 0, 1 / src[3], -src[0] / src[2], -src[1] / src[3]])
					}
				})

				this.out.path(unit, paint, -1, false, this.clip)

				return
			}

			// Clamped: the clamp colour where the source leaves the image, then the image.
			if ((attributes.clamp & 255) !== 0) this.out.path(unit, this.out.solid(attributes.clamp), -1, false, this.clip)
		}

		this.out.image(this.out.recrop(index, crop, 1), placement, 1, 1, this.clip)
	}

	// --- Text ---

	private fontSize(font: FontObject): number {
		// World and display units scale with the world transform; the others are fixed device sizes.
		if (font.unit === 0 || font.unit === 1) return font.size

		const page = this.pageScale * this.unitPx(this.pageUnit, false)

		return (font.size * this.unitPx(font.unit, false)) / (page === 0 ? 1 : page)
	}

	private countText(count: number): void {
		this.textChars += count

		if (this.textChars > MAX_TEXT_CHARS) throw new MetafileLimit("text")
	}

	private run(font: FontObject, color: Rgba, text: string, size: number): TextRun {
		const metafile = font.font

		return {
			text,
			size: size * 0.75,
			bold: metafile.weight >= 600,
			italic: metafile.italic,
			underline: metafile.underline ? "sng" : "none",
			strike: metafile.strike ? "sngStrike" : "noStrike",
			color,
			font: displayFace(metafile),
			baseline: 0,
			caps: "none",
			spacing: 0,
			lineBreak: false
		}
	}

	// A text's brush: its colour, and its paint when it is more than a colour.
	private textBrush(flags: number, value: number): { color: Rgba; fill: Paint | undefined } | undefined {
		const color = this.brushColor(flags, value)

		if (color === undefined) return undefined

		const brush = (flags & 0x8000) !== 0 ? undefined : this.objects.get(value)
		const fill = brush === undefined || brush.kind === "solid" ? undefined : this.paintObject(brush)

		return { color, fill }
	}

	private glyphs(
		font: FontObject,
		brush: { color: Rgba; fill: Paint | undefined },
		codes: readonly number[],
		positions: Float32Array | null,
		anchor: "start" | "middle" | "end",
		placement: Matrix
	): void {
		if (codes.length === 0) return

		this.countText(codes.length)

		const size = this.fontSize(font)
		const metafile = font.font
		let text = ""

		for (let start = 0; start < codes.length; start += 4096) text += String.fromCodePoint(...codes.slice(start, start + 4096))

		const first = positions?.[0] ?? 0
		const width = positions === null ? codes.length * size * 0.55 : (positions[positions.length - 1] ?? 0) - first + size
		const boxX = positions !== null ? first - size / 2 : anchor === "middle" ? -width / 2 : anchor === "end" ? -width : 0

		this.out.text(
			{ kind: "glyphs", run: this.run(font, brush.color, text, size), positions, anchor },
			placement,
			boxX,
			-metafile.ascent * size,
			width,
			(metafile.ascent + metafile.descent) * size,
			this.clip,
			brush.fill
		)
	}

	// DrawString: text the renderer lays out in the layout rectangle per the string format (alignment,
	// wrapping, line limit, trimming, clipping).
	private drawString(flags: number, d: number, size: number): void {
		const font = this.objects.get(flags & 0xff)

		if (font?.kind !== "font") return

		const b = this.bytes
		const brush = this.textBrush(flags, b.u32(d))
		const format = this.objects.get(b.u32(d + 4))
		const length = Math.min(b.u32(d + 8), Math.floor((size - 28) / 2))
		const layout = this.rect(d + 12, false)

		if (brush === undefined || layout === undefined || length <= 0) return

		const formatFlags = format?.kind === "format" ? format.flags : 0
		const align = format?.kind === "format" ? format.align : 0
		const lineAlign = format?.kind === "format" ? format.lineAlign : 0
		// Without a format GDI+ trims by character.
		const trimming = format?.kind === "format" ? format.trimming : 1
		const codes: number[] = []

		for (const char of b.utf16(d + 28, length, false).replace(/\r\n|\r/g, "\n")) {
			const code = char.codePointAt(0) ?? 0
			const drawn = code === 0x0a ? code : drawnCodePoint(font.font, code)

			if (drawn !== 0) codes.push(drawn)
		}

		if (codes.length === 0) return

		this.countText(codes.length)

		let text = ""

		for (let start = 0; start < codes.length; start += 4096) text += String.fromCodePoint(...codes.slice(start, start + 4096))

		const em = this.fontSize(font)
		const [x, y, w, h] = layout
		const position = (value: number): "start" | "middle" | "end" => (value === 1 ? "middle" : value === 2 ? "end" : "start")
		const trims = ["none", "character", "word", "ellipsisCharacter", "ellipsisWord", "ellipsisPath"] as const
		const rtl = (formatFlags & 0x1) !== 0
		// DirectionVertical: lines run down the rectangle and advance right to left, so the block is laid out
		// with the sides swapped and turned a quarter clockwise about the rectangle's top-right corner.
		const vertical = (formatFlags & 0x2) !== 0
		const width = Math.max(0, vertical ? h : w)
		const height = Math.max(0, vertical ? w : h)
		// GDI+ pads each line by the format's margins, 1/6 em each without a format (GenericDefault).
		const lead = (format?.kind === "format" ? format.leadingMargin : 1 / 6) * em
		const trail = (format?.kind === "format" ? format.trailingMargin : 1 / 6) * em
		const before = rtl ? trail : lead
		const after = rtl ? lead : trail
		const padded = width <= 0 || width > before + after
		const inner = padded && width > 0 ? width - before - after : width
		const blockAlign = position(align)
		// An unbounded line is placed at the origin per its alignment, with the margins outside its text.
		const shift = !padded ? 0 : width > 0 || blockAlign === "start" ? before : blockAlign === "end" ? -after : (before - after) / 2
		const clip = (formatFlags & 0x4000) === 0 && width > 0 && height > 0
		// The clip stays the whole layout rectangle when the block is narrower than it.
		const outer = clip && inner < width
		const placement: Matrix = vertical ? [0, 1, -1, 0, x + w, y + shift] : [1, 0, 0, 1, x + shift, y]
		const m = this.matrix()

		this.out.text(
			{
				kind: "block",
				run: this.run(font, brush.color, text, em),
				width: inner,
				height,
				align: blockAlign,
				lineAlign: position(lineAlign),
				wrap: (formatFlags & 0x1000) === 0 && width > 0,
				clip: clip && !outer,
				lineLimit: (formatFlags & 0x2000) !== 0,
				trimming: trims[trimming] ?? "none",
				lineHeight: em * (font.font.ascent + font.font.descent),
				ascent: font.font.ascent,
				rtl
			},
			mul(m, placement),
			0,
			0,
			inner,
			height,
			outer ? intersectClips(this.clip, rectClip(x, y, x + w, y + h, m, this.out.env), this.out.env) : this.clip,
			brush.fill
		)
	}

	private drawDriverString(flags: number, d: number, size: number): void {
		const font = this.objects.get(flags & 0xff)

		if (font?.kind !== "font") return

		const b = this.bytes
		const brush = this.textBrush(flags, b.u32(d))
		const options = b.u32(d + 4)
		const matrixPresent = b.u32(d + 8) !== 0
		const count = Math.min(b.u32(d + 12), Math.floor((size - 16) / 2))

		if (brush === undefined || count <= 0) return

		// Without CmapLookup the values are glyph ids of the font, which name no characters here.
		if ((options & 1) === 0) {
			this.unsupported++

			return
		}

		const glyphsAt = d + 16
		const positionsAt = glyphsAt + count * 2
		const realized = (options & 4) !== 0
		const positionCount = realized ? 1 : count
		const matrixAt = positionsAt + positionCount * 8

		if (matrixAt > d + size) return

		const local = matrixPresent && matrixAt + 24 <= d + size ? this.matrixAt(matrixAt) : IDENTITY
		const m = mul(this.matrix(), local)
		let start = 0

		// Glyphs on one baseline become one run; a change of baseline starts another. Each glyph is centred in
		// the cell up to the next glyph, so a substitute face of other widths stays where the original drew.
		const em = this.fontSize(font)
		const xAt = (k: number): number => b.f32(positionsAt + k * 8)

		while (start < count) {
			const x0 = realized ? b.f32(positionsAt) : xAt(start)
			const y0 = b.f32(positionsAt + (realized ? 4 : start * 8 + 4))
			let end = start + 1

			while (!realized && end < count && Math.abs(b.f32(positionsAt + end * 8 + 4) - y0) <= 1e-3 * Math.max(1, em)) end++

			if (realized) end = count

			const codes: number[] = []
			const offsets: number[] = []
			let step = em * 0.5

			for (let k = start; k < end; k++) {
				if (!realized && k + 1 < end) step = xAt(k + 1) - xAt(k)

				const drawn = drawnCodePoint(font.font, b.u16(glyphsAt + k * 2))

				if (drawn === 0 || drawn === 0x20) continue

				codes.push(drawn)
				offsets.push(realized ? 0 : xAt(k) - x0 + step / 2)
			}

			this.glyphs(
				font,
				brush,
				codes,
				realized ? null : Float32Array.from(offsets),
				realized ? "start" : "middle",
				mul(m, [1, 0, 0, 1, x0, y0])
			)
			start = end
		}
	}
}

// A region object's node tree from `at`; the node and the bytes it used.
function parseRegionNode(b: Bytes, at: number, end: number, depth: number, budget: { nodes: number }): [RegionNode, number] | undefined {
	if (depth > MAX_REGION_DEPTH || --budget.nodes < 0 || at + 4 > end) return undefined

	const type = b.u32(at)

	switch (type) {
		case 0x10000000:
			return at + 20 <= end
				? [{ kind: "rect", x: b.f32(at + 4), y: b.f32(at + 8), w: b.f32(at + 12), h: b.f32(at + 16) }, 20]
				: undefined
		case 0x10000001: {
			const length = b.u32(at + 4)
			const path = at + 8 + length <= end ? parsePath(b, at + 8, length) : undefined

			return path === undefined ? undefined : [{ kind: "path", path }, 8 + length]
		}
		case 0x10000002:
			return [{ kind: "empty" }, 4]
		case 0x10000003:
			return [{ kind: "infinite" }, 4]
		default: {
			if (type < 1 || type > 5) return undefined

			const left = parseRegionNode(b, at + 4, end, depth + 1, budget)

			if (left === undefined) return undefined

			const right = parseRegionNode(b, at + 4 + left[1], end, depth + 1, budget)

			return right === undefined
				? undefined
				: [{ kind: "combine", mode: type, left: left[0], right: right[0] }, 4 + left[1] + right[1]]
		}
	}
}

// EmfPlusPath: points (float, 16-bit or relative) and their types (bytes, or run-length encoded).
function parsePath(b: Bytes, at: number, size: number): PathObject | undefined {
	const end = Math.min(b.length, at + size)
	const flags = b.u32(at + 8)
	const relative = (flags & 0x0800) !== 0
	const compressed = (flags & 0x4000) !== 0
	const rle = (flags & 0x1000) !== 0
	// The least each point takes (two 7-bit offsets, two 16-bit or two float coordinates, plus its type byte
	// unless run-length encoded) bounds the count before anything is allocated.
	const least = (relative ? 2 : compressed ? 4 : 8) + (rle ? 0 : 1)
	const count = Math.min(b.u32(at + 4), MAX_PATH_POINTS, Math.max(0, Math.floor((end - at - 12) / least)))
	const points = new Float64Array(count * 2)
	let p = at + 12

	if (relative) {
		let x = 0
		let y = 0
		const integer = (): number => {
			const first = b.u8(p)

			if ((first & 0x80) === 0) {
				p += 1

				return first & 0x40 ? first - 0x80 : first
			}

			const value = ((first & 0x7f) << 8) | b.u8(p + 1)

			p += 2

			return value & 0x4000 ? value - 0x8000 : value
		}

		for (let k = 0; k < count && p < end; k++) {
			x += integer()
			y += integer()
			points[k * 2] = x
			points[k * 2 + 1] = y
		}
	} else {
		const stride = compressed ? 4 : 8

		if (p + count * stride > end) return undefined

		for (let k = 0; k < count; k++) {
			points[k * 2] = compressed ? b.i16(p + k * 4) : b.f32(p + k * 8)
			points[k * 2 + 1] = compressed ? b.i16(p + k * 4 + 2) : b.f32(p + k * 8 + 4)
		}

		p += count * stride
	}

	const types = new Uint8Array(count)

	if (rle) {
		let k = 0

		while (k < count && p + 2 <= end) {
			const run = b.u8(p) & 0x3f
			const type = b.u8(p + 1)

			for (let r = 0; r < run && k < count; r++) types[k++] = type

			p += 2
		}
	} else {
		types.set(b.sub(p, count))
	}

	return { kind: "path", points, types }
}

// WrapMode as an SVG spread: tiling repeats, flipped tiling reflects, clamping pads.
function spreadOf(wrap: number): "pad" | "reflect" | "repeat" {
	return wrap === 0 ? "repeat" : wrap >= 1 && wrap <= 3 ? "reflect" : "pad"
}

function rampColor(ramp: Ramp, position: number): Rgba {
	const { offsets, colors } = ramp

	if (offsets.length === 0) return 0
	if (position <= (offsets[0] ?? 0)) return colors[0] ?? 0

	for (let k = 1; k < offsets.length; k++) {
		const end = offsets[k] ?? 1

		if (position <= end) {
			const start = offsets[k - 1] ?? 0

			return mix(colors[k - 1] ?? 0, colors[k] ?? 0, end > start ? (position - start) / (end - start) : 1)
		}
	}

	return colors[colors.length - 1] ?? 0
}

function rampFactor(blend: Blend, position: number): number {
	const { positions, factors } = blend

	if (positions.length === 0) return position
	if (position <= (positions[0] ?? 0)) return factors[0] ?? 0

	for (let k = 1; k < positions.length; k++) {
		const end = positions[k] ?? 1

		if (position <= end) {
			const start = positions[k - 1] ?? 0
			const t = end > start ? (position - start) / (end - start) : 1

			return (factors[k - 1] ?? 0) * (1 - t) + (factors[k] ?? 0) * t
		}
	}

	return factors[factors.length - 1] ?? 1
}

// PositionCount, then positions and the second array (colours or factors): the bytes it took.
function readRamp(b: Bytes, at: number, end: number, colors: boolean): [Float32Array, Float32Array | Uint32Array, number] {
	const count = Math.min(b.u32(at), 256, Math.max(0, Math.floor((end - at - 4) / 8)))
	const positions = new Float32Array(count)
	const values = colors ? new Uint32Array(count) : new Float32Array(count)

	for (let k = 0; k < count; k++) {
		positions[k] = Math.min(1, Math.max(0, b.f32(at + 4 + k * 4)))
		values[k] = colors ? argb(b.u32(at + 4 + count * 4 + k * 4)) : Math.min(1, Math.max(0, b.f32(at + 4 + count * 4 + k * 4)))
	}

	return [positions, values, 4 + Math.max(0, Math.min(b.u32(at), 0x7fffffff)) * 8]
}

function matrixIn(b: Bytes, at: number): number[] {
	return [b.f32(at), b.f32(at + 4), b.f32(at + 8), b.f32(at + 12), b.f32(at + 16), b.f32(at + 20)]
}

// A path's points with its curves flattened (for a polygon boundary), and its ellipse when it is one: four
// Béziers meeting the middle of each side of their bounds.
function boundaryOf(path: PathObject): { points: Float64Array; ellipse: [number, number, number, number] | null } {
	const { points, types } = path
	const count = Math.min(types.length, points.length / 2)
	const out: number[] = []
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity
	let curves = 0

	for (let k = 0; k < count; k++) {
		const x = points[k * 2] ?? 0
		const y = points[k * 2 + 1] ?? 0

		minX = Math.min(minX, x)
		minY = Math.min(minY, y)
		maxX = Math.max(maxX, x)
		maxY = Math.max(maxY, y)

		if (((types[k] ?? 0) & 7) === 3 && k + 2 < count && out.length >= 2) {
			const x0 = out[out.length - 2] ?? 0
			const y0 = out[out.length - 1] ?? 0
			const x1 = x
			const y1 = y
			const x2 = points[k * 2 + 2] ?? 0
			const y2 = points[k * 2 + 3] ?? 0
			const x3 = points[k * 2 + 4] ?? 0
			const y3 = points[k * 2 + 5] ?? 0

			for (let s = 1; s <= 8; s++) {
				const t = s / 8
				const u = 1 - t

				out.push(
					u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
					u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3
				)
			}

			minX = Math.min(minX, x2, x3)
			minY = Math.min(minY, y2, y3)
			maxX = Math.max(maxX, x2, x3)
			maxY = Math.max(maxY, y2, y3)
			curves++
			k += 2
			continue
		}

		out.push(x, y)
	}

	let ellipse: [number, number, number, number] | null = null

	if (curves === 4 && count === 13 && maxX > minX && maxY > minY) {
		const cx = (minX + maxX) / 2
		const cy = (minY + maxY) / 2
		const tolerance = Math.max(maxX - minX, maxY - minY) * 1e-3
		const near = (x: number, y: number): boolean =>
			[
				[maxX, cy],
				[cx, maxY],
				[minX, cy],
				[cx, minY]
			].some(([ex = 0, ey = 0]) => Math.abs(x - ex) <= tolerance && Math.abs(y - ey) <= tolerance)
		let onAxes = true

		for (let k = 0; k <= 12; k += 3) if (!near(points[k * 2] ?? 0, points[k * 2 + 1] ?? 0)) onAxes = false

		if (onAxes) ellipse = [cx, cy, (maxX - minX) / 2, (maxY - minY) / 2]
	}

	return { points: Float64Array.from(out), ellipse }
}

function parseBrush(b: Bytes, at: number, end: number): BrushObject | undefined {
	const type = b.u32(at + 4)
	const d = at + 8

	switch (type) {
		case 0:
			return { kind: "solid", color: argb(b.u32(d)) }
		case 1:
			return { kind: "hatch", pattern: HATCHES[b.u32(d)] ?? "pct50", foreground: argb(b.u32(d + 4)), background: argb(b.u32(d + 8)) }
		case 2: {
			const flags = b.u32(d)
			const transform = (flags & 0x02) !== 0 ? matrixIn(b, d + 8) : IDENTITY
			const image = parseImage(b, d + 8 + ((flags & 0x02) !== 0 ? 24 : 0), end)

			return image === undefined ? undefined : { kind: "texture", image, transform, wrap: b.u32(d + 4) }
		}
		case 3: {
			const flags = b.u32(d)
			const center = argb(b.u32(d + 8))
			const count = Math.min(b.u32(d + 20), 4096, Math.max(0, Math.floor((end - d - 24) / 4)))
			const surround: Rgba[] = []

			for (let k = 0; k < count; k++) surround.push(argb(b.u32(d + 24 + k * 4)))

			let p = d + 24 + count * 4
			let boundary: Float64Array
			let ellipse: [number, number, number, number] | null = null

			if ((flags & 0x01) !== 0) {
				const size = b.u32(p)
				const path = parsePath(b, p + 4, Math.min(size, end - p - 4))

				if (path === undefined) return undefined

				const shape = boundaryOf(path)

				boundary = shape.points
				ellipse = shape.ellipse
				p += 4 + size
			} else {
				const points = Math.min(b.u32(p), 65_536, Math.max(0, Math.floor((end - p - 4) / 8)))

				boundary = new Float64Array(points * 2)

				for (let k = 0; k < points * 2; k++) boundary[k] = b.f32(p + 4 + k * 4)

				p += 4 + points * 8
			}

			let transform: readonly number[] = IDENTITY
			let ramp: Ramp | null = null
			let blend: Blend | null = null
			let focus = 0

			if ((flags & 0x02) !== 0) {
				transform = matrixIn(b, p)
				p += 24
			}

			if ((flags & 0x04) !== 0) {
				const [positions, colors, used] = readRamp(b, p, end, true)

				if (positions.length >= 2 && colors instanceof Uint32Array) ramp = { offsets: positions, colors }

				p += used
			} else if ((flags & 0x08) !== 0) {
				const [positions, factors, used] = readRamp(b, p, end, false)

				if (positions.length >= 2 && factors instanceof Float32Array) blend = { positions, factors }

				p += used
			}

			if ((flags & 0x40) !== 0 && b.u32(p) >= 2) focus = Math.min(1, Math.max(0, (b.f32(p + 4) + b.f32(p + 8)) / 2))

			return {
				kind: "pathGradient",
				center,
				centerPoint: [b.f32(d + 12), b.f32(d + 16)],
				surround: surround.length === 0 ? [center] : surround,
				boundary,
				ellipse,
				transform,
				ramp,
				blend,
				focus
			}
		}
		case 4: {
			const flags = b.u32(d)
			const start = argb(b.u32(d + 24))
			const endColor = argb(b.u32(d + 28))
			let p = d + 40
			let transform: readonly number[] = IDENTITY
			let ramp: Ramp = { offsets: Float32Array.of(0, 1), colors: Uint32Array.of(start, endColor) }

			if ((flags & 0x02) !== 0) {
				transform = matrixIn(b, p)
				p += 24
			}

			if ((flags & 0x04) !== 0) {
				const [positions, colors] = readRamp(b, p, end, true)

				if (positions.length >= 2 && colors instanceof Uint32Array) ramp = { offsets: positions, colors }
			} else if ((flags & 0x18) !== 0) {
				// Blend factors (horizontal, or vertical when that is all there is) along the gradient.
				const [positions, factors] = readRamp(b, p, end, false)

				if (positions.length >= 2 && factors instanceof Float32Array) {
					ramp = { offsets: positions, colors: Uint32Array.from(factors, factor => mix(start, endColor, factor)) }
				}
			}

			return {
				kind: "linear",
				rect: [b.f32(d + 8), b.f32(d + 12), b.f32(d + 16), b.f32(d + 20)],
				transform,
				ramp,
				wrap: b.u32(d + 4)
			}
		}
		default:
			return undefined
	}
}

function mix(c1: Rgba, c2: Rgba, t: number): Rgba {
	const channel = (shift: number): number => Math.round(((c1 >>> shift) & 255) * (1 - t) + ((c2 >>> shift) & 255) * t)

	return ((channel(24) << 24) | (channel(16) << 16) | (channel(8) << 8) | channel(0)) >>> 0
}

// EmfPlusCustomLineCap: the default kind's fill and line paths, or an adjustable arrow as its outline.
function parseCap(b: Bytes, at: number, end: number): CapShape | null {
	const type = b.u32(at + 4)
	const d = at + 8

	if (type === 1) {
		// Width and height in pen widths; the arrow's tip on the line's end, its base behind it.
		const width = b.f32(d)
		const height = b.f32(d + 4)
		const inset = b.f32(d + 8)
		const filled = b.u32(d + 12) !== 0
		const points = Float64Array.of(0, 0, -width / 2, -height, 0, -height + inset, width / 2, -height)
		const path: PathObject = { kind: "path", points, types: Uint8Array.of(0, 1, 1, 0x81) }

		return { fill: filled ? path : null, line: filled ? null : path, widthScale: b.f32(d + 32) || 1 }
	}

	if (type !== 0) return null

	const flags = b.u32(d)
	let p = d + 48
	let fill: PathObject | null = null
	let line: PathObject | null = null

	if ((flags & 1) !== 0) {
		const length = b.u32(p)

		fill = parsePath(b, p + 4, Math.min(length, end - p - 4)) ?? null
		p += 4 + length
	}

	if ((flags & 2) !== 0) {
		const length = b.u32(p)

		line = parsePath(b, p + 4, Math.min(length, end - p - 4)) ?? null
	}

	return { fill, line, widthScale: b.f32(d + 28) || 1 }
}

function parsePen(b: Bytes, at: number, end: number): PenObject | undefined {
	const flags = b.u32(at + 8)
	const unit = b.u32(at + 12)
	const width = b.f32(at + 16)
	let p = at + 20
	let transformScale = 1
	let startCap = 0
	let endCap = 0
	let dashCap = 0
	let join: Stroke["join"] = "miter"
	let miterLimit = 10
	let style = 0
	let dashes: Float32Array | null = null
	let inset = false
	let customStart: CapShape | null = null
	let customEnd: CapShape | null = null

	if (flags & 0x01) {
		transformScale = scaleOf([b.f32(p), b.f32(p + 4), b.f32(p + 8), b.f32(p + 12), 0, 0]) || 1
		p += 24
	}

	if (flags & 0x02) {
		startCap = b.u32(p)
		p += 4
	}

	if (flags & 0x04) {
		endCap = b.u32(p)
		p += 4
	}

	if (flags & 0x08) {
		const value = b.u32(p)

		join = value === 1 ? "bevel" : value === 2 ? "round" : "miter"
		p += 4
	}

	if (flags & 0x10) {
		miterLimit = Math.max(1, b.f32(p))
		p += 4
	}

	if (flags & 0x20) {
		style = b.u32(p)
		p += 4
	}

	if (flags & 0x40) {
		dashCap = b.u32(p)
		p += 4
	}

	if (flags & 0x80) p += 4

	if (flags & 0x100) {
		const count = Math.min(b.u32(p), 32, Math.max(0, Math.floor((end - p - 4) / 4)))

		dashes = new Float32Array(count)

		for (let k = 0; k < count; k++) dashes[k] = Math.max(0, b.f32(p + 4 + k * 4))

		p += 4 + Math.min(b.u32(p), 0x10000000) * 4
	}

	if (flags & 0x200) {
		inset = b.u32(p) === 1
		p += 4
	}

	if (flags & 0x400) p += 4 + Math.min(b.u32(p), 0x10000000) * 4

	if (flags & 0x800) {
		const size = b.u32(p)

		customStart = parseCap(b, p + 4, Math.min(end, p + 4 + size))
		p += 4 + size
	}

	if (flags & 0x1000) {
		const size = b.u32(p)

		customEnd = parseCap(b, p + 4, Math.min(end, p + 4 + size))
		p += 4 + size
	}

	const brush = p < end ? parseBrush(b, p, end) : undefined

	if (brush === undefined) return undefined

	return {
		kind: "pen",
		width,
		unit,
		transformScale,
		style: style > 5 ? 0 : style,
		dashes,
		startCap,
		endCap,
		dashCap,
		customStart,
		customEnd,
		join,
		miterLimit,
		inset,
		brush
	}
}

// Pixel formats (2.1.1.25) this player decodes.
function pixelBits(format: number): number {
	return (format >>> 8) & 0xff
}

function parseImage(b: Bytes, at: number, end: number): ImageObject | undefined {
	const type = b.u32(at + 4)

	if (type === 2) {
		const length = Math.min(b.u32(at + 12), end - at - 16)

		if (length <= 0) return undefined

		const metafile = b.sub(at + 16, length).slice()

		return { kind: "image", width: 0, height: 0, encoded: undefined, encode: () => undefined, metafile, conversion: undefined }
	}

	if (type !== 1) return undefined

	const width = b.i32(at + 8)
	const height = b.i32(at + 12)
	const stride = b.i32(at + 16)
	const format = b.u32(at + 20)
	const compressed = b.u32(at + 24) === 1
	const data = at + 28

	if (compressed) {
		const bytes = b.sub(data, end - data).slice()

		return {
			kind: "image",
			width,
			height,
			encoded: undefined,
			encode: budget => passThrough(bytes, budget),
			metafile: undefined,
			conversion: undefined
		}
	}

	if (width <= 0 || height <= 0 || width * height > MAX_DECODE_PIXELS || stride <= 0) return undefined

	return {
		kind: "image",
		width,
		height,
		encoded: undefined,
		encode: budget => {
			const rgba = budget.spend(width * height) ? decodePixels(b, data, end, width, height, stride, format) : undefined

			return rgba === undefined ? undefined : { format: "png", bytes: encodePng(rgba, width, height) }
		},
		metafile: undefined,
		conversion: undefined
	}
}

function decodePixels(
	b: Bytes,
	at: number,
	end: number,
	width: number,
	height: number,
	stride: number,
	format: number
): Uint8Array | undefined {
	const bits = pixelBits(format)
	let palette: Uint32Array | null = null
	let p = at

	if ((format & 0x00010000) !== 0) {
		// Indexed: EmfPlusPalette first.
		const count = Math.min(b.u32(p + 4), 256)

		palette = new Uint32Array(count)

		for (let k = 0; k < count; k++) palette[k] = argb(b.u32(p + 8 + k * 4))

		p += 8 + count * 4
	}

	if (p + stride * height > end) return undefined

	const out = new Uint8Array(width * height * 4)
	const src = b.bytes
	const premultiplied = format === 0x000e200b
	const alpha = format === 0x0026200a || premultiplied || format === 0x00061007

	for (let y = 0; y < height; y++) {
		const row = p + y * stride
		let o = y * width * 4

		for (let x = 0; x < width; x++) {
			let r = 0
			let g = 0
			let bl = 0
			let a = 255

			switch (bits) {
				case 1:
				case 4:
				case 8: {
					const perByte = 8 / bits
					const byte = src[row + Math.floor(x / perByte)] ?? 0
					const index = (byte >>> (8 - bits * ((x % perByte) + 1))) & ((1 << bits) - 1)
					const color = palette?.[index] ?? 0x000000ff

					r = color >>> 24
					g = (color >>> 16) & 255
					bl = (color >>> 8) & 255
					a = color & 255
					break
				}
				case 16: {
					const value = (src[row + x * 2] ?? 0) | ((src[row + x * 2 + 1] ?? 0) << 8)

					if (format === 0x00021006) {
						r = ((value >>> 11) & 31) * 8.226
						g = ((value >>> 5) & 63) * 4.048
						bl = (value & 31) * 8.226
					} else if (format === 0x00101004) {
						r = g = bl = value >>> 8
					} else {
						r = ((value >>> 10) & 31) * 8.226
						g = ((value >>> 5) & 31) * 8.226
						bl = (value & 31) * 8.226

						if (alpha) a = value & 0x8000 ? 255 : 0
					}

					break
				}
				case 24:
					bl = src[row + x * 3] ?? 0
					g = src[row + x * 3 + 1] ?? 0
					r = src[row + x * 3 + 2] ?? 0
					break
				case 32:
					bl = src[row + x * 4] ?? 0
					g = src[row + x * 4 + 1] ?? 0
					r = src[row + x * 4 + 2] ?? 0
					a = alpha ? (src[row + x * 4 + 3] ?? 0) : 255

					if (premultiplied && a > 0 && a < 255) {
						r = Math.min(255, (r * 255) / a)
						g = Math.min(255, (g * 255) / a)
						bl = Math.min(255, (bl * 255) / a)
					}

					break
				default:
					return undefined
			}

			out[o++] = Math.round(r)
			out[o++] = Math.round(g)
			out[o++] = Math.round(bl)
			out[o++] = a
		}
	}

	return out
}

function parseObject(b: Bytes, at: number, size: number, type: number, owner: { unsupported: number }): PlusObject | undefined {
	const end = Math.min(b.length, at + size)

	switch (type) {
		case 1:
			return parseBrush(b, at, end)
		case 2:
			return parsePen(b, at, end)
		case 3:
			return parsePath(b, at, end - at)
		case 4: {
			const node = parseRegionNode(b, at + 8, end, 0, { nodes: MAX_REGION_NODES })

			return node === undefined ? undefined : { kind: "region", node: node[0] }
		}
		case 5: {
			const image = parseImage(b, at, end)

			if (image === undefined) owner.unsupported++

			return image
		}
		case 6: {
			const length = Math.min(b.u32(at + 20), 32)
			const family = b.utf16(at + 24, length, true)
			const style = b.i32(at + 12)
			const font = metafileFont(0, 0, 0, style & 1 ? 700 : 400, (style & 2) !== 0, (style & 4) !== 0, (style & 8) !== 0, 0, family)

			return { kind: "font", size: Math.max(0, b.f32(at + 4)), unit: b.u32(at + 8), font }
		}
		case 7:
			return {
				kind: "format",
				flags: b.u32(at + 4),
				align: b.u32(at + 12),
				lineAlign: b.u32(at + 16),
				trimming: b.u32(at + 48),
				leadingMargin: margin(b.f32(at + 36)),
				trailingMargin: margin(b.f32(at + 40))
			}
		case 8:
			return { kind: "attributes", wrap: b.u32(at + 8), clamp: argb(b.u32(at + 12)) }
		default:
			return { kind: "other" }
	}
}

function margin(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0
}

// A cardinal spline through `points` (tension 0..1) as Béziers, closed or open; an open one only over
// `count` segments from point `offset` (both clamped), with tangents still taken from every point.
function curve(
	builder: PathBuilder,
	points: Float64Array,
	tension: number,
	closed: boolean,
	offset: number = 0,
	count: number = Infinity
): void {
	const n = points.length / 2

	if (n < 2) return

	const t = (Number.isFinite(tension) ? tension : 0.5) / 3
	const px = (k: number): number => points[((closed ? (k + n) % n : Math.min(n - 1, Math.max(0, k))) * 2) | 0] ?? 0
	const py = (k: number): number => points[((closed ? (k + n) % n : Math.min(n - 1, Math.max(0, k))) * 2 + 1) | 0] ?? 0
	const start = closed ? 0 : Math.min(n - 2, offset)
	const end = closed ? n : start + Math.min(n - 1 - start, count)

	if (end <= start) return

	builder.moveTo(px(start), py(start))

	for (let k = start; k < end; k++) {
		builder.cubicTo(
			px(k) + (px(k + 1) - px(k - 1)) * t,
			py(k) + (py(k + 1) - py(k - 1)) * t,
			px(k + 1) - (px(k + 2) - px(k)) * t,
			py(k + 1) - (py(k + 2) - py(k)) * t,
			px(k + 1),
			py(k + 1)
		)
	}

	if (closed) builder.close()
}

// Each open subpath's ends with their outward unit directions, in output space.
function forEachEnd(path: PathBuilder, visit: (x: number, y: number, ux: number, uy: number, atStart: boolean) => void): void {
	const { commands, coords } = path
	let at = 0
	let figure: number[] = []
	const flush = (closed: boolean): void => {
		if (!closed && figure.length >= 4) {
			const end = (from: number, step: number, atStart: boolean): void => {
				const x = figure[from] ?? 0
				const y = figure[from + 1] ?? 0

				for (let k = from + step; k >= 0 && k + 1 < figure.length; k += step) {
					const dx = x - (figure[k] ?? 0)
					const dy = y - (figure[k + 1] ?? 0)
					const length = Math.hypot(dx, dy)

					if (length > 1e-9) {
						visit(x, y, dx / length, dy / length, atStart)

						return
					}
				}
			}

			end(0, 2, true)
			end(figure.length - 2, -2, false)
		}

		figure = []
	}

	for (const command of commands) {
		const needed = command === PathCommand.CUBIC ? 6 : command === PathCommand.QUAD ? 4 : command === PathCommand.CLOSE ? 0 : 2

		if (command === PathCommand.MOVE) flush(false)

		for (let k = 0; k < needed; k++) figure.push(coords[at + k] ?? 0)

		if (command === PathCommand.CLOSE) flush(true)

		at += needed
	}

	flush(false)
}

// One line end's cap (LineCap 2.1.1.18) as geometry: `fills` takes filled shapes, `lines` outlines.
// Anchor caps are centred on the end, twice the pen's width across (the arrow anchor's sides 4/sqrt(3)).
function capGeometry(
	kind: number,
	custom: CapShape | null,
	x: number,
	y: number,
	ux: number,
	uy: number,
	width: number,
	fills: PathBuilder,
	lines: PathBuilder
): void {
	const half = width / 2
	// Cap space: x across the line (to the left of its direction), y outward along it.
	const place = (scale: number): number[] => [-uy * scale, ux * scale, ux * scale, uy * scale, x, y]

	switch (kind) {
		case 1:
			fills.setMatrix(place(half))
			fills.rect(-1, 0, 1, 1)
			break
		case 2:
			fills.setMatrix(place(half))
			fills.arc(0, 0, 1, 1, 0, Math.PI, false)
			fills.close()
			break
		case 3:
			fills.setMatrix(place(half))
			fills.moveTo(-1, 0)
			fills.lineTo(0, 1)
			fills.lineTo(1, 0)
			fills.close()
			break
		case 0x11:
			fills.setMatrix(place(width))
			fills.rect(-1, -1, 1, 1)
			break
		case 0x12:
			fills.setMatrix(place(width))
			fills.ellipse(0, 0, 1, 1)
			break
		case 0x13:
			fills.setMatrix(place(width))
			fills.moveTo(0, 1)
			fills.lineTo(1, 0)
			fills.lineTo(0, -1)
			fills.lineTo(-1, 0)
			fills.close()
			break
		case 0x14: {
			const side = (width * 4) / Math.sqrt(3)

			fills.setMatrix(place(1))
			fills.moveTo(0, 0)
			fills.lineTo(-side / 2, -width * 2)
			fills.lineTo(side / 2, -width * 2)
			fills.close()
			break
		}
		case 0xff:
			if (custom === null) break

			for (const [shape, target] of [
				[custom.fill, fills],
				[custom.line, lines]
			] as const) {
				if (shape === null) continue

				target.setMatrix(place(width * custom.widthScale))

				const { points, types } = shape
				const count = Math.min(types.length, points.length / 2)

				for (let k = 0; k < count; k++) {
					const type = types[k] ?? 0
					const px = points[k * 2] ?? 0
					const py = points[k * 2 + 1] ?? 0

					if ((type & 7) === 0) target.moveTo(px, py)
					else if ((type & 7) === 3 && k + 2 < count) {
						target.cubicTo(
							px,
							py,
							points[k * 2 + 2] ?? 0,
							points[k * 2 + 3] ?? 0,
							points[k * 2 + 4] ?? 0,
							points[k * 2 + 5] ?? 0
						)
						k += 2
					} else target.lineTo(px, py)

					if (((types[k] ?? 0) & 0x80) !== 0) target.close()
				}
			}

			break
		default:
			break
	}
}
