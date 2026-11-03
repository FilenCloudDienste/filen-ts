import { Unzlib } from "fflate"
import { Bytes } from "./bytes"
import { parseDib, type Dib, type DibTransparency } from "./dib"
import { Gdi, RegionMode, Rop, solidPen, type BrushObject } from "./gdi"
import { MAX_DECODE_PIXELS, MAX_NESTING, MAX_SAVE_DEPTH, MetafileLimit } from "./limits"
import { Output, PathBuilder } from "./output"
import { metafileFont, type MetafileFont } from "./text"
import type { MetafileFailure } from "./types"

// StarView Metafiles (LibreOffice's GDIMetaFile stream, "VCLMTF"): the pictures ODF packages keep as previews of
// embedded objects and as pictures. The header carries the picture's map mode and size; each action is a type, a
// version and a byte length (so unknown and newer fields are skipped), then the action's fields, little-endian.
// Coordinates are logical units of the current map mode; they are mapped to px here and drawn through the GDI
// playback EMF and WMF use, with its device in px.

const MAGIC = [0x56, 0x43, 0x4c, 0x4d, 0x54, 0x46]

export function isSvm(bytes: Bytes): boolean {
	return MAGIC.every((byte, k) => bytes.u8(k) === byte)
}

const PX_PER_UNIT: readonly number[] = [
	96 / 2540, // 1/100 mm
	96 / 254, // 1/10 mm
	96 / 25.4, // mm
	96 / 2.54, // cm
	96 / 1000, // 1/1000 in
	96 / 100, // 1/100 in
	96 / 10, // 1/10 in
	96, // in
	96 / 72, // pt
	96 / 1440, // twip
	1, // pixel
	1, // system font
	1 // application font
]
const MAP_RELATIVE = 13

interface Mapping {
	// px = (logical + origin) * scale.
	readonly ox: number
	readonly oy: number
	readonly sx: number
	readonly sy: number
	// The px per unit of the map mode's unit (relative modes keep their base's).
	readonly unit: number
}

interface MapModeValue {
	readonly unit: number
	readonly x: number
	readonly y: number
	readonly scaleX: number
	readonly scaleY: number
}

// VCL font weights (FontWeight) as CSS weights.
const WEIGHTS = [400, 100, 200, 300, 350, 400, 500, 600, 700, 800, 900]

interface State {
	mapping: Mapping
	lineColor: number | undefined
	fillColor: number | undefined
	textColor: number
	textFillColor: number | undefined
	textAlign: number
	font: SvmFont
	rasterOp: number
}

interface SvmFont {
	readonly name: string
	// Logical units.
	readonly height: number
	readonly width: number
	// Tenths of a degree.
	readonly orientation: number
	readonly weight: number
	readonly italic: boolean
	readonly underline: boolean
	readonly strike: boolean
}

const DEFAULT_SVM_FONT: SvmFont = {
	name: "",
	height: 0,
	width: 0,
	orientation: 0,
	weight: 400,
	italic: false,
	underline: false,
	strike: false
}

// PushFlags.
const PUSH_LINECOLOR = 0x1
const PUSH_FILLCOLOR = 0x2
const PUSH_FONT = 0x4
const PUSH_TEXTCOLOR = 0x8
const PUSH_MAPMODE = 0x10
const PUSH_CLIPREGION = 0x20
const PUSH_RASTEROP = 0x40
const PUSH_TEXTFILLCOLOR = 0x80
const PUSH_TEXTALIGN = 0x100

const ROP_OVERPAINT = 0

// Region stream entries (anything else, 2, ends the bands).
const BAND_HEADER = 0
const BAND_SEPARATION = 1

// Polygon point flags: a control point of a Bézier.
const POLY_CONTROL = 1

const BITMAP_MAGIC1 = 0x25091962
const BITMAP_MAGIC2 = 0xacb20201

// A cursor over one action's bytes; reads past its end return zeros and set `over`.
class Cursor {
	readonly bytes: Bytes
	at: number
	readonly end: number
	over = false

	constructor(bytes: Bytes, at: number, end: number) {
		this.bytes = bytes
		this.at = at
		this.end = end
	}

	private take(size: number): number {
		const at = this.at

		this.at += size

		if (this.at > this.end) this.over = true

		return at
	}

	left(): number {
		return this.end - this.at
	}

	u8(): number {
		return this.over ? 0 : this.bytes.u8(this.take(1))
	}

	u16(): number {
		const at = this.take(2)

		return this.over ? 0 : this.bytes.u16(at)
	}

	i16(): number {
		const at = this.take(2)

		return this.over ? 0 : this.bytes.i16(at)
	}

	u32(): number {
		const at = this.take(4)

		return this.over ? 0 : this.bytes.u32(at)
	}

	i32(): number {
		const at = this.take(4)

		return this.over ? 0 : this.bytes.i32(at)
	}

	// A VersionCompat block: its version and the end of its bytes.
	compat(): { readonly version: number; readonly end: number } {
		const version = this.u16()
		const length = this.u32()

		return { version, end: Math.min(this.end, this.at + length) }
	}

	// A string as a 16-bit length and 8-bit characters (Latin-1, the fonts' ASCII names).
	byteString(): string {
		const length = this.u16()

		if (length > this.left()) {
			this.over = true

			return ""
		}

		let out = ""

		for (let k = 0; k < length; k++) out += String.fromCharCode(this.bytes.u8(this.at + k))

		this.at += length

		return out
	}

	// UTF-16 text of `count` units.
	utf16(count: number): string {
		if (count * 2 > this.left()) {
			this.over = true

			return ""
		}

		const text = this.bytes.utf16(this.at, count, false)

		this.at += count * 2

		return text
	}
}

// The text of a text action: written as 8-bit text (16-bit length) or, when the stream's character set is Unicode,
// as UTF-16 (32-bit length); version 2 appends the Unicode text (16-bit length) after the action's fields, which is
// what is drawn. `fields` reads what lies between and returns how many fixed bytes it took (to tell the forms apart).
function textOf(cursor: Cursor, version: number, fields: (cursor: Cursor) => void): string {
	const start = cursor.at

	// The UTF-16 form first: it is right when the rest of the action then parses to its end.
	const wide = new Cursor(cursor.bytes, start, cursor.end)
	const count = wide.u32()
	let text = count * 2 <= wide.left() ? wide.utf16(count) : undefined

	if (text !== undefined) {
		fields(wide)

		if (version >= 2) {
			const unicode = wide.u16()

			if (unicode * 2 <= wide.left()) text = wide.utf16(unicode)
			else text = undefined
		}
	}

	if (text !== undefined && !wide.over && wide.at <= cursor.end) {
		cursor.at = wide.at

		return text
	}

	cursor.at = start

	let narrow = cursor.byteString()

	fields(cursor)

	if (version >= 2) {
		const unicode = cursor.u16()

		if (unicode * 2 <= cursor.left()) narrow = cursor.utf16(unicode)
	}

	return narrow
}

class Player {
	private readonly gdi: Gdi
	private readonly out: Output
	private state: State
	private readonly stack: { readonly flags: number; readonly state: State; readonly clip: Gdi["dc"]["clip"] }[] = []
	private readonly base: number
	private readonly nested: number

	constructor(gdi: Gdi, out: Output, mapping: Mapping, nested: number) {
		this.gdi = gdi
		this.out = out
		this.base = mapping.unit
		this.nested = nested
		this.state = {
			mapping,
			lineColor: 0x000000,
			fillColor: 0xffffff,
			textColor: 0x000000,
			textFillColor: undefined,
			textAlign: 0,
			font: DEFAULT_SVM_FONT,
			rasterOp: ROP_OVERPAINT
		}
	}

	private x(x: number): number {
		return (x + this.state.mapping.ox) * this.state.mapping.sx
	}

	private y(y: number): number {
		return (y + this.state.mapping.oy) * this.state.mapping.sy
	}

	private width(length: number): number {
		return Math.abs(length * this.state.mapping.sx)
	}

	private point(cursor: Cursor): [number, number] {
		const x = cursor.i32()
		const y = cursor.i32()

		return [this.x(x), this.y(y)]
	}

	private size(cursor: Cursor): [number, number] {
		return [cursor.i32() * this.state.mapping.sx, cursor.i32() * this.state.mapping.sy]
	}

	// A VCL rectangle (left, top, right, bottom) in px.
	private rect(cursor: Cursor): [number, number, number, number] {
		const left = cursor.i32()
		const top = cursor.i32()
		const right = cursor.i32()
		const bottom = cursor.i32()

		return [this.x(left), this.y(top), this.x(right), this.y(bottom)]
	}

	// A polygon: its points as px pairs.
	private polygon(cursor: Cursor): number[] {
		const count = cursor.u16()

		if (count * 8 > cursor.left()) {
			cursor.over = true

			return []
		}

		// Points cost work whether or not they are drawn (a raster operation may hide them).
		this.out.charge(count)

		const points: number[] = []

		for (let k = 0; k < count; k++) {
			const [x, y] = this.point(cursor)

			points.push(x, y)
		}

		return points
	}

	// A polygon with its optional point flags (Bézier control points).
	// A complex polygon (tools::Polygon's own stream): a VersionCompat block holding the points, then whether point flags
	// (Bézier control points) follow, and the flags. Read within the block, which also ends it.
	private flaggedPolygon(cursor: Cursor): { points: number[]; flags: Uint8Array | undefined } {
		const compat = cursor.compat()
		const inner = new Cursor(cursor.bytes, cursor.at, compat.end)
		const points = this.polygon(inner)
		const hasFlags = inner.u8()
		let flags: Uint8Array | undefined

		if (hasFlags !== 0) {
			const count = points.length / 2

			if (count > inner.left()) inner.over = true
			else flags = inner.bytes.sub(inner.at, count).slice()
		}

		if (inner.over) cursor.over = true

		cursor.at = compat.end

		return { points: inner.over ? [] : points, flags }
	}

	private polyPolygon(cursor: Cursor, version: number): { points: number[]; flags: (Uint8Array | undefined)[]; counts: number[] } {
		const polygons = cursor.u16()
		const all: number[][] = []
		const flags: (Uint8Array | undefined)[] = []

		for (let k = 0; k < polygons && !cursor.over; k++) {
			all.push(this.polygon(cursor))
			flags.push(undefined)
		}

		if (version >= 2) {
			const complex = cursor.u16()

			for (let k = 0; k < complex && !cursor.over; k++) {
				const index = cursor.u16()
				const polygon = this.flaggedPolygon(cursor)

				if (index < all.length) {
					all[index] = polygon.points
					flags[index] = polygon.flags
				}
			}
		}

		return { points: all.flat(), flags, counts: all.map(points => points.length / 2) }
	}

	private color(value: number): number {
		return value & 0xffffff
	}

	// The Rgba of 0xTTRRGGBB (T: transparency) at `alpha`.
	private rgba(value: number, alpha: number = 1): number {
		const opacity = (1 - ((value >>> 24) & 255) / 255) * alpha

		return ((((value >>> 16) & 255) << 24) | (((value >>> 8) & 255) << 16) | ((value & 255) << 8) | Math.round(opacity * 255)) >>> 0
	}

	private pen(width: number = 0, style: number = 1, alpha: number = 1): void {
		const color = this.state.lineColor

		this.gdi.selectObject(
			color === undefined || style === 0
				? solidPen(5, 0, 0)
				: solidPen(style === 2 ? 1 : 0, width, this.rgba(color, alpha), null, width <= 0)
		)
	}

	private brush(alpha: number = 1): void {
		const color = this.state.fillColor

		this.gdi.selectObject(
			color === undefined
				? this.gdi.brush(1, 0, 0)
				: ({ kind: "brush", style: 0, color: this.rgba(color, alpha), hatch: 0 } as BrushObject)
		)
	}

	// Whether drawing is suppressed by the raster operation (XOR and inversions are not drawn).
	private hidden(): boolean {
		if (this.state.rasterOp === ROP_OVERPAINT) return false

		this.out.unsupported++

		return true
	}

	// A line info (§ LineInfo): style, width in logical units.
	private lineInfo(cursor: Cursor): { style: number; width: number } {
		const compat = cursor.compat()
		const style = cursor.u16()
		const width = cursor.i32()

		cursor.at = compat.end

		return { style, width: this.width(width) }
	}

	private outline(points: number[], flags: Uint8Array | undefined, closed: boolean, fill: boolean, stroke: boolean): void {
		const gdi = this.gdi
		const count = points.length / 2

		if (count === 0) return

		if (flags === undefined || !flags.some(flag => flag === POLY_CONTROL)) {
			if (closed) {
				if (!fill) gdi.selectObject(gdi.brush(1, 0, 0))
				if (!stroke) gdi.selectObject(solidPen(5, 0, 0))

				gdi.polygon(points, count)
			} else {
				gdi.polyline(points, count)
			}

			return
		}

		const xs: number[] = []
		const types: number[] = []

		for (let k = 0; k < count; k++) {
			xs.push(points[k * 2] ?? 0, points[k * 2 + 1] ?? 0)

			if (k === 0) types.push(6)
			else if (flags[k] === POLY_CONTROL && k + 2 < count && flags[k + 1] === POLY_CONTROL) {
				types.push(4, 4, 4)
				xs.push(points[k * 2 + 2] ?? 0, points[k * 2 + 3] ?? 0, points[k * 2 + 4] ?? 0, points[k * 2 + 5] ?? 0)
				k += 2
			} else types.push(2)
		}

		if (closed) types[types.length - 1] = (types[types.length - 1] ?? 2) | 1

		gdi.beginPath()
		gdi.moveTo(xs[0] ?? 0, xs[1] ?? 0)
		gdi.polyDraw(xs, types, types.length)
		gdi.endPath()
		gdi.drawPath(closed && fill, stroke)
	}

	private polyPolygonOutline(shape: { points: number[]; flags: (Uint8Array | undefined)[]; counts: number[] }): void {
		const gdi = this.gdi

		if (shape.flags.every(flags => flags === undefined || !flags.some(flag => flag === POLY_CONTROL))) {
			gdi.polyPolygon(shape.points, shape.counts)

			return
		}

		let at = 0

		gdi.beginPath()

		shape.counts.forEach((count, k) => {
			const points = shape.points.slice(at * 2, (at + count) * 2)
			const flags = shape.flags[k]
			const xs: number[] = []
			const types: number[] = []

			for (let p = 0; p < count; p++) {
				xs.push(points[p * 2] ?? 0, points[p * 2 + 1] ?? 0)

				if (p === 0) types.push(6)
				else if (flags?.[p] === POLY_CONTROL && p + 2 < count && flags[p + 1] === POLY_CONTROL) {
					types.push(4, 4, 4)
					xs.push(points[p * 2 + 2] ?? 0, points[p * 2 + 3] ?? 0, points[p * 2 + 4] ?? 0, points[p * 2 + 5] ?? 0)
					p += 2
				} else types.push(2)
			}

			if (types.length > 0) {
				types[types.length - 1] = (types[types.length - 1] ?? 2) | 1
				gdi.moveTo(xs[0] ?? 0, xs[1] ?? 0)
				gdi.polyDraw(xs, types, types.length)
			}

			at += count
		})

		gdi.endPath()
		gdi.drawPath(true, true)
	}

	// The Region stream: bands of separations (rectangles) and, from version 2, a polygon form.
	private region(cursor: Cursor): {
		rects: number[]
		polygon: ReturnType<Player["polyPolygon"]> | undefined
		empty: boolean
		whole: boolean
	} {
		const compat = cursor.compat()

		cursor.u16()

		const type = cursor.u16()
		const rects: number[] = []
		let polygon: ReturnType<Player["polyPolygon"]> | undefined

		// Null (the whole plane) and empty regions carry no bands.
		if (type === 0) {
			cursor.at = compat.end

			return { rects, polygon, empty: false, whole: true }
		}

		if (type === 1) {
			cursor.at = compat.end

			return { rects, polygon, empty: true, whole: false }
		}

		let top = 0
		let bottom = 0

		for (let guard = 0; guard < 1_000_000 && cursor.at < compat.end && !cursor.over; guard++) {
			const entry = cursor.u16()

			if (entry === BAND_HEADER) {
				top = cursor.i32()
				bottom = cursor.i32()
			} else if (entry === BAND_SEPARATION) {
				const left = cursor.i32()
				const right = cursor.i32()

				rects.push(this.x(left), this.y(top), this.x(right + 1), this.y(bottom + 1))
			} else break
		}

		if (compat.version >= 2 && cursor.at < compat.end && cursor.u8() !== 0) polygon = this.polyPolygon(cursor, 1)

		cursor.at = compat.end

		return { rects, polygon, empty: rects.length === 0 && polygon === undefined, whole: false }
	}

	private clipTo(region: ReturnType<Player["region"]>, mode: number): void {
		const gdi = this.gdi

		if (region.whole) {
			if (mode === RegionMode.COPY) gdi.resetClip()

			return
		}

		if (region.polygon !== undefined && region.polygon.counts.length > 0) {
			gdi.beginPath()
			gdi.polyPolygon(region.polygon.points, region.polygon.counts)
			gdi.endPath()
			gdi.selectClipPath(mode)

			return
		}

		gdi.selectLogicalRects(region.rects.length > 0 ? region.rects : [0, 0, 0, 0], mode)
	}

	private mapMode(cursor: Cursor): MapModeValue {
		const compat = cursor.compat()
		const unit = cursor.u16()
		const x = cursor.i32()
		const y = cursor.i32()
		const numX = cursor.i32()
		const denX = cursor.i32()
		const numY = cursor.i32()
		const denY = cursor.i32()

		cursor.at = compat.end

		return { unit, x, y, scaleX: denX === 0 ? 1 : numX / denX, scaleY: denY === 0 ? 1 : numY / denY }
	}

	private setMapMode(mode: MapModeValue): void {
		const current = this.state.mapping

		if (mode.unit === MAP_RELATIVE) {
			// Relative to the current mode: the origin moves and the scale multiplies.
			this.state.mapping = {
				...current,
				ox: current.ox + mode.x,
				oy: current.oy + mode.y,
				sx: current.sx * mode.scaleX,
				sy: current.sy * mode.scaleY
			}

			return
		}

		const unit = PX_PER_UNIT[mode.unit] ?? this.base

		this.state.mapping = { ox: mode.x, oy: mode.y, sx: unit * mode.scaleX, sy: unit * mode.scaleY, unit }
	}

	private readFont(cursor: Cursor): SvmFont {
		const compat = cursor.compat()
		const name = cursor.byteString()

		cursor.byteString()

		const width = cursor.i32()
		const height = cursor.i32()

		cursor.u16()
		cursor.u16()
		cursor.u16()

		const weight = cursor.u16()
		const underline = cursor.u16()
		const strike = cursor.u16()
		const italic = cursor.u16()

		cursor.u16()
		cursor.u16()

		const orientation = cursor.i16()

		cursor.at = compat.end

		return {
			name: name.split(";")[0]?.trim() ?? "",
			height,
			width,
			orientation,
			weight: WEIGHTS[weight] ?? 400,
			italic: italic !== 0,
			underline: underline !== 0,
			strike: strike !== 0
		}
	}

	private selectFont(): void {
		const font = this.state.font
		const height = Math.abs(font.height * this.state.mapping.sy)
		const metafile: MetafileFont = metafileFont(
			-(height > 0 ? height : 12),
			Math.abs(font.width * this.state.mapping.sx),
			font.orientation,
			font.weight,
			font.italic,
			font.underline,
			font.strike,
			0,
			font.name
		)

		this.gdi.selectObject({ kind: "font", font: metafile })
		this.gdi.setTextColor(this.rgba(this.state.textColor))

		const fill = this.state.textFillColor

		this.gdi.setBkMode(fill === undefined ? 1 : 2)

		if (fill !== undefined) this.gdi.setBkColor(this.rgba(fill))

		// ALIGN_TOP 0, ALIGN_BASELINE 1, ALIGN_BOTTOM 2 as TA_TOP, TA_BASELINE, TA_BOTTOM.
		this.gdi.setTextAlign(this.state.textAlign === 1 ? 24 : this.state.textAlign === 2 ? 8 : 0)
	}

	// Text at a logical point; `positions` are the end of each character from its start (logical units).
	private text(x: number, y: number, text: string, positions: number[] | undefined): void {
		if (text === "" || this.hidden()) return

		this.selectFont()

		let dx: number[] | null = null

		if (positions !== undefined && positions.length >= text.length) {
			dx = []

			let previous = 0

			for (let k = 0; k < text.length; k++) {
				const end = positions[k] ?? previous

				dx.push((end - previous) * this.state.mapping.sx)
				previous = end
			}
		}

		this.gdi.text(x, y, text, dx, 1, 0, null)
	}

	// A DIB stream with its file header ("BM"); the bitmap and the offset after it.
	private dib(cursor: Cursor): Dib | undefined {
		const start = cursor.at

		if (cursor.bytes.u8(start) !== 0x42 || cursor.bytes.u8(start + 1) !== 0x4d) {
			cursor.over = true

			return undefined
		}

		const size = cursor.bytes.u32(start + 2)
		const offBits = cursor.bytes.u32(start + 10)
		const headerSize = cursor.bytes.u32(start + 14)

		if (headerSize >= 40 && offBits >= 14 + headerSize && cursor.bytes.u32(start + 30) === ZCODEC_COMPRESSION) {
			// The file size is the uncompressed one; the stream goes on after the coded bytes.
			const coded = 12 + cursor.bytes.u32(start + offBits)
			const end = start + offBits + coded

			if (end > cursor.end) {
				cursor.over = true

				return undefined
			}

			cursor.at = end

			return svmDib(cursor.bytes, start + 14, offBits - 14, start + offBits, coded)
		}

		if (size < 14 + headerSize || offBits < 14 + headerSize || start + size > cursor.end) {
			// A file size of 0 or one that overruns: the bitmap ends where the action does.
			const end = Math.min(cursor.end, size >= 14 + headerSize ? start + size : cursor.end)

			cursor.at = end

			return svmDib(cursor.bytes, start + 14, Math.max(0, offBits - 14), start + offBits, Math.max(0, end - start - offBits))
		}

		cursor.at = start + size

		return svmDib(cursor.bytes, start + 14, offBits - 14, start + offBits, size - offBits)
	}

	// A BitmapEx: the bitmap, then (behind two magic numbers) a mask bitmap or a transparent colour.
	private bitmapEx(cursor: Cursor): { dib: Dib | undefined; transparency: DibTransparency } {
		const dib = this.dib(cursor)
		let transparency: DibTransparency = { kind: "none" }

		if (cursor.left() >= 9 && cursor.bytes.u32(cursor.at) === BITMAP_MAGIC1 && cursor.bytes.u32(cursor.at + 4) === BITMAP_MAGIC2) {
			cursor.at += 8

			const type = cursor.u8()

			if (type === 2) {
				const mask = this.dib(cursor)

				if (mask !== undefined && mask.bitCount === 1) transparency = { kind: "mask", mask }
				else if (mask !== undefined) this.out.unsupported++
			} else if (type === 1) {
				transparency = { kind: "key", color: this.color(cursor.u32()) }
			}
		}

		return { dib, transparency }
	}

	private drawBitmap(
		dib: Dib | undefined,
		transparency: DibTransparency,
		x: number,
		y: number,
		w: number,
		h: number,
		part?: readonly number[]
	): void {
		if (dib === undefined) {
			this.out.unsupported++

			return
		}

		if (this.hidden()) return

		const sx = part?.[0] ?? 0
		const sy = part?.[1] ?? 0
		const sw = part?.[2] ?? dib.width
		const sh = part?.[3] ?? Math.abs(dib.height)

		this.gdi.bitmap(dib, `svm${String(inflatedFrom.get(dib) ?? dib.bitsOffset)}`, sx, sy, sw, sh, x, y, w, h, Rop.SRCCOPY, transparency)
	}

	// The gradient record: style, start and end colours (and intensities), angle (tenths of a degree), border.
	private gradient(cursor: Cursor): { style: number; from: number; to: number; angle: number; border: number; cx: number; cy: number } {
		const compat = cursor.compat()
		const style = cursor.u16()
		const startColor = cursor.u32()
		const endColor = cursor.u32()
		const angle = cursor.u16()
		const border = cursor.u16()
		const cx = cursor.u16()
		const cy = cursor.u16()
		const startIntensity = cursor.u16()
		const endIntensity = cursor.u16()

		cursor.at = compat.end

		const intensity = (color: number, percent: number): number => {
			const k = Math.min(100, percent) / 100

			return (
				(Math.round(((color >>> 16) & 255) * k) << 16) |
				(Math.round(((color >>> 8) & 255) * k) << 8) |
				Math.round((color & 255) * k)
			)
		}

		return { style, from: intensity(startColor, startIntensity), to: intensity(endColor, endIntensity), angle, border, cx, cy }
	}

	// A gradient over a polygon set: linear and axial along the angle, the others radial from their centre.
	private fillGradient(shape: { points: number[]; counts: number[] }, gradient: ReturnType<Player["gradient"]>): void {
		if (shape.points.length === 0 || this.hidden()) return

		let minX = Infinity
		let minY = Infinity
		let maxX = -Infinity
		let maxY = -Infinity

		for (let k = 0; k + 1 < shape.points.length; k += 2) {
			minX = Math.min(minX, shape.points[k] ?? 0)
			maxX = Math.max(maxX, shape.points[k] ?? 0)
			minY = Math.min(minY, shape.points[k + 1] ?? 0)
			maxY = Math.max(maxY, shape.points[k + 1] ?? 0)
		}

		const w = maxX - minX
		const h = maxY - minY
		const from = this.rgba(gradient.from)
		const to = this.rgba(gradient.to)
		const border = Math.min(0.99, gradient.border / 100)
		let paint: Parameters<Output["paint"]>[0]

		if (gradient.style === 0 || gradient.style === 1) {
			// The angle turns the gradient counter-clockwise from top-to-bottom.
			const radians = (gradient.angle / 10) * (Math.PI / 180)
			const dx = -Math.sin(radians)
			const dy = Math.cos(radians)
			const half = (Math.abs(dx * w) + Math.abs(dy * h)) / 2
			const cx = minX + w / 2
			const cy = minY + h / 2
			const ax = cx - dx * half
			const ay = cy - dy * half
			const axial = gradient.style === 1
			const stops = axial
				? {
						offsets: Float32Array.of(0, (1 - border) / 2, 0.5, 1 - (1 - border) / 2, 1),
						colors: Uint32Array.of(to, to, from, to, to)
					}
				: { offsets: Float32Array.of(0, border, 1), colors: Uint32Array.of(from, from, to) }

			paint = { kind: "gradient", type: "linear", stops, matrix: [dx * half * 2, dy * half * 2, -dy, dx, ax, ay], spread: "pad" }
		} else {
			const cx = minX + (w * gradient.cx) / 100
			const cy = minY + (h * gradient.cy) / 100
			const radius = Math.hypot(Math.max(cx - minX, maxX - cx), Math.max(cy - minY, maxY - cy))

			paint = {
				kind: "gradient",
				type: "radial",
				stops: { offsets: Float32Array.of(0, 1 - border, 1), colors: Uint32Array.of(to, from, from) },
				matrix: [radius, 0, 0, radius, cx, cy],
				spread: "pad"
			}
		}

		const builder = new PathBuilder()
		let at = 0

		for (const count of shape.counts) {
			if (count > 0) {
				builder.moveTo(shape.points[at * 2] ?? 0, shape.points[at * 2 + 1] ?? 0)

				for (let k = 1; k < count; k++) builder.lineTo(shape.points[(at + k) * 2] ?? 0, shape.points[(at + k) * 2 + 1] ?? 0)

				builder.close()
			}

			at += count
		}

		this.out.path(builder, this.out.paint(paint), -1, true, this.gdi.dc.clip)
	}

	private hatch(cursor: Cursor, shape: { points: number[]; counts: number[] }): void {
		const compat = cursor.compat()

		cursor.u16()

		const color = cursor.u32()
		const distance = this.width(cursor.i32())
		const angle = cursor.u16()

		cursor.at = compat.end

		if (shape.points.length === 0 || !(distance > 0.25) || this.hidden()) return

		let minX = Infinity
		let minY = Infinity
		let maxX = -Infinity
		let maxY = -Infinity

		for (let k = 0; k + 1 < shape.points.length; k += 2) {
			minX = Math.min(minX, shape.points[k] ?? 0)
			maxX = Math.max(maxX, shape.points[k] ?? 0)
			minY = Math.min(minY, shape.points[k + 1] ?? 0)
			maxY = Math.max(maxY, shape.points[k + 1] ?? 0)
		}

		const gdi = this.gdi
		const radians = (angle / 10) * (Math.PI / 180)
		const cos = Math.cos(radians)
		const sin = -Math.sin(radians)
		const cx = (minX + maxX) / 2
		const cy = (minY + maxY) / 2
		const reach = Math.hypot(maxX - minX, maxY - minY) / 2
		const lines = Math.min(10_000, Math.ceil((reach * 2) / distance))
		const points: number[] = []
		const counts: number[] = []

		for (let k = 0; k <= lines; k++) {
			const offset = -reach + k * distance

			points.push(
				cx - sin * offset - cos * reach,
				cy + cos * offset - sin * reach,
				cx - sin * offset + cos * reach,
				cy + cos * offset + sin * reach
			)
			counts.push(2)
		}

		gdi.saveDc()
		gdi.beginPath()
		gdi.polyPolygon(shape.points, shape.counts)
		gdi.endPath()
		gdi.selectClipPath(RegionMode.AND)
		gdi.selectObject(solidPen(0, 0, this.rgba(color), null, true))
		gdi.polyPolyline(points, counts)
		gdi.restoreDc(-1)
	}

	// Plays the actions from `at` up to `limit` (a nested picture's own action's end); false when they ended early (a
	// limit or truncation).
	play(bytes: Bytes, at: number, count: number, limit: number = bytes.length): boolean {
		let offset = at
		const bound = Math.min(limit, bytes.length)

		for (let k = 0; k < count; k++) {
			if (offset === bound) return true
			if (offset + 8 > bound) return false

			this.out.record()

			const type = bytes.u16(offset)
			const version = bytes.u16(offset + 2)
			const length = bytes.u32(offset + 4)
			const start = offset + 8
			const end = start + length

			if (end > bound) return false

			this.action(new Cursor(bytes, start, end), type, version)
			offset = end
		}

		return true
	}

	private action(cursor: Cursor, type: number, version: number): void {
		const gdi = this.gdi
		const state = this.state

		switch (type) {
			case 0:
				return
			case 100: {
				// Pixel: one pixel in its colour.
				const [x, y] = this.point(cursor)
				const color = cursor.u32()

				if (!this.hidden()) gdi.fillRect(x, y, x + 1, y + 1, this.rgba(color))

				return
			}
			case 101: {
				const [x, y] = this.point(cursor)
				const color = state.lineColor

				if (color !== undefined && !this.hidden()) gdi.fillRect(x, y, x + 1, y + 1, this.rgba(color))

				return
			}
			case 102: {
				const [x1, y1] = this.point(cursor)
				const [x2, y2] = this.point(cursor)
				const line = version >= 2 ? this.lineInfo(cursor) : { style: 1, width: 0 }

				if (this.hidden()) return

				this.pen(line.width, line.style)
				gdi.polyline([x1, y1, x2, y2], 2)

				return
			}
			case 103:
			case 104:
			case 105: {
				const [left, top, right, bottom] = this.rect(cursor)

				if (this.hidden()) return

				this.pen()
				this.brush()

				if (type === 103) gdi.rectangle(left, top, right, bottom)
				else if (type === 105) gdi.ellipse(left, top, right, bottom)
				else gdi.roundRect(left, top, right, bottom, this.width(cursor.u32()) * 2, Math.abs(cursor.u32() * state.mapping.sy) * 2)

				return
			}
			case 106:
			case 107:
			case 108: {
				const [left, top, right, bottom] = this.rect(cursor)
				const [xs, ys] = this.point(cursor)
				const [xe, ye] = this.point(cursor)

				if (this.hidden()) return

				this.pen()
				this.brush()
				gdi.setArcDirection(false)
				gdi.arc(type === 106 ? "arc" : type === 107 ? "pie" : "chord", left, top, right, bottom, xs, ys, xe, ye)

				return
			}
			case 109: {
				let points = this.polygon(cursor)
				const line = version >= 2 ? this.lineInfo(cursor) : { style: 1, width: 0 }
				let flags: Uint8Array | undefined

				if (version >= 3 && cursor.u8() !== 0) {
					const flagged = this.flaggedPolygon(cursor)

					points = flagged.points
					flags = flagged.flags
				}

				if (this.hidden()) return

				this.pen(line.width, line.style)
				this.outline(points, flags, false, false, true)

				return
			}
			case 110: {
				let points = this.polygon(cursor)
				let flags: Uint8Array | undefined

				if (version >= 2 && cursor.u8() !== 0) {
					const flagged = this.flaggedPolygon(cursor)

					points = flagged.points
					flags = flagged.flags
				}

				if (this.hidden()) return

				this.pen()
				this.brush()
				this.outline(points, flags, true, true, true)

				return
			}
			case 111: {
				const shape = this.polyPolygon(cursor, version)

				if (this.hidden()) return

				this.pen()
				this.brush()
				this.polyPolygonOutline(shape)

				return
			}
			case 112: {
				const [x, y] = this.point(cursor)
				let index = 0
				let length = 0
				const text = textOf(cursor, version, fields => {
					index = fields.u16()
					length = fields.u16()
				})

				this.text(x, y, text.slice(index, index + length), undefined)

				return
			}
			case 113: {
				const [x, y] = this.point(cursor)
				let index = 0
				let length = 0
				let positions: number[] = []
				const text = textOf(cursor, version, fields => {
					index = fields.u16()
					length = fields.u16()

					const count = fields.u32()

					positions = []

					if (count * 4 > fields.left()) {
						fields.over = true

						return
					}

					for (let k = 0; k < count; k++) positions.push(fields.i32())
				})
				const piece = text.slice(index, index + length)

				this.text(x, y, piece, positions.length >= piece.length ? positions : undefined)

				return
			}
			case 114: {
				const [x, y] = this.point(cursor)
				let index = 0
				let length = 0
				const text = textOf(cursor, version, fields => {
					fields.u32()
					index = fields.u16()
					length = fields.u16()
				})

				this.text(x, y, text.slice(index, index + length), undefined)

				return
			}
			case 115: {
				const [left, top] = this.rect(cursor)
				const text = textOf(cursor, version, fields => {
					fields.u16()
				})
				const saved = state.textAlign

				state.textAlign = 0
				this.text(left, top, text, undefined)
				state.textAlign = saved

				return
			}
			case 116:
			case 117:
			case 118: {
				const dib = this.dib(cursor)
				const [x, y] = this.point(cursor)
				let size: [number, number] = dib === undefined ? [0, 0] : [dib.width, Math.abs(dib.height)]
				let part: number[] | undefined

				if (type === 117) size = this.size(cursor)
				if (type === 118) {
					size = this.size(cursor)
					part = [cursor.i32(), cursor.i32(), cursor.i32(), cursor.i32()]
				}

				this.drawBitmap(dib, { kind: "none" }, x, y, size[0], size[1], part)

				return
			}
			case 119:
			case 120:
			case 121: {
				const bitmap = this.bitmapEx(cursor)
				const [x, y] = this.point(cursor)
				let size: [number, number] = bitmap.dib === undefined ? [0, 0] : [bitmap.dib.width, Math.abs(bitmap.dib.height)]
				let part: number[] | undefined

				if (type === 120) size = this.size(cursor)
				if (type === 121) {
					size = this.size(cursor)
					part = [cursor.i32(), cursor.i32(), cursor.i32(), cursor.i32()]
				}

				this.drawBitmap(bitmap.dib, bitmap.transparency, x, y, size[0], size[1], part)

				return
			}
			case 122:
			case 123:
			case 124: {
				// A mask: its set pixels in the action's colour.
				const dib = this.dib(cursor)
				const [x, y] = this.point(cursor)
				let size: [number, number] = dib === undefined ? [0, 0] : [dib.width, Math.abs(dib.height)]
				let part: number[] | undefined

				if (type === 123) size = this.size(cursor)
				if (type === 124) {
					size = this.size(cursor)
					part = [cursor.i32(), cursor.i32(), cursor.i32(), cursor.i32()]
				}

				const color = cursor.u32()

				if (this.color(color) !== 0) this.out.unsupported++

				this.drawBitmap(dib, { kind: "drop", color: 0xffffff }, x, y, size[0], size[1], part)

				return
			}
			case 125: {
				const [left, top, right, bottom] = this.rect(cursor)

				this.fillGradient({ points: [left, top, right, top, right, bottom, left, bottom], counts: [4] }, this.gradient(cursor))

				return
			}
			case 126: {
				const shape = this.polyPolygon(cursor, 2)

				this.hatch(cursor, shape)

				return
			}
			case 127: {
				// Wallpaper: its colour over the rectangle (bitmaps and gradients of wallpapers are not drawn).
				const [left, top, right, bottom] = this.rect(cursor)
				const compat = cursor.compat()
				const color = cursor.u32()

				cursor.at = compat.end

				if (!this.hidden()) gdi.fillRect(left, top, right, bottom, this.rgba(color))

				this.out.unsupported++

				return
			}
			case 128: {
				const region = this.region(cursor)
				const clip = cursor.u8() !== 0

				if (!clip) gdi.resetClip()
				else this.clipTo(region, RegionMode.COPY)

				return
			}
			case 129: {
				const [left, top, right, bottom] = this.rect(cursor)

				gdi.intersectClipRect(left, top, right, bottom)

				return
			}
			case 130:
				this.clipTo(this.region(cursor), RegionMode.AND)

				return
			case 131: {
				const dx = cursor.i32() * state.mapping.sx
				const dy = cursor.i32() * state.mapping.sy

				gdi.offsetClip(dx, dy)

				return
			}
			case 132: {
				const color = cursor.u32()

				state.lineColor = cursor.u8() !== 0 ? color : undefined

				return
			}
			case 133: {
				const color = cursor.u32()

				state.fillColor = cursor.u8() !== 0 ? color : undefined

				return
			}
			case 134:
				state.textColor = cursor.u32()

				return
			case 135: {
				const color = cursor.u32()

				state.textFillColor = cursor.u8() !== 0 ? color : undefined

				return
			}
			case 136:
				state.textAlign = cursor.u16()

				return
			case 137:
				this.setMapMode(this.mapMode(cursor))

				return
			case 138:
				state.font = this.readFont(cursor)

				return
			case 139: {
				if (this.stack.length >= MAX_SAVE_DEPTH) throw new MetafileLimit("saved states")

				this.stack.push({ flags: cursor.u16(), state: { ...state }, clip: gdi.dc.clip })

				return
			}
			case 140: {
				const saved = this.stack.pop()

				if (saved === undefined) return

				const flags = saved.flags
				const restored: State = { ...state }

				if (flags & PUSH_LINECOLOR) restored.lineColor = saved.state.lineColor
				if (flags & PUSH_FILLCOLOR) restored.fillColor = saved.state.fillColor
				if (flags & PUSH_FONT) restored.font = saved.state.font
				if (flags & PUSH_TEXTCOLOR) restored.textColor = saved.state.textColor
				if (flags & PUSH_MAPMODE) restored.mapping = saved.state.mapping
				if (flags & PUSH_RASTEROP) restored.rasterOp = saved.state.rasterOp
				if (flags & PUSH_TEXTFILLCOLOR) restored.textFillColor = saved.state.textFillColor
				if (flags & PUSH_TEXTALIGN) restored.textAlign = saved.state.textAlign
				if (flags & PUSH_CLIPREGION) {
					gdi.dc.clip = saved.clip
					gdi.invalidate()
				}

				this.state = restored

				return
			}
			case 141:
				state.rasterOp = cursor.u16()

				return
			case 142: {
				// A polygon set at a transparency (percent).
				const shape = this.polyPolygon(cursor, version)
				const percent = Math.min(100, cursor.u16())

				if (this.hidden()) return

				this.pen(0, 1, 1 - percent / 100)
				this.brush(1 - percent / 100)
				this.polyPolygonOutline(shape)

				return
			}
			case 143: {
				// EPS: the PostScript is not run; its substitute metafile is drawn in its place.
				const compat = cursor.compat()

				cursor.u16()

				const dataSize = cursor.u32()

				// The PostScript lies inside the action, or the action is refused.
				if (compat.end + dataSize + 16 > cursor.end) {
					this.out.unsupported++

					return
				}

				cursor.at = compat.end + dataSize

				const [x, y] = this.point(cursor)
				const [w, h] = this.size(cursor)

				this.nestedMetafile(cursor, x, y, w, h, cursor.end)

				return
			}
			case 147: {
				// A transparency group: drawn opaque (its transparency gradient is not applied).
				const start = cursor.at

				this.skipMetafile(cursor)

				const [x, y] = this.point(cursor)
				const [w, h] = this.size(cursor)
				const end = cursor.at

				cursor.at = start
				// The nested picture ends where its position and size begin.
				this.nestedMetafile(cursor, x, y, w, h, end - 16)
				cursor.at = end
				this.out.unsupported++

				return
			}
			case 148: {
				const shape = this.polyPolygon(cursor, 2)

				this.fillGradient(shape, this.gradient(cursor))

				return
			}
			default:
				// Colours of text lines, layout mode, language, reference point, comments: nothing to draw.
				return
		}
	}

	// The length of a nested metafile stream at the cursor, skipped.
	private skipMetafile(cursor: Cursor): void {
		const header = readHeader(cursor.bytes, cursor.at)

		if (header === undefined) {
			cursor.over = true

			return
		}

		let offset = header.actions

		for (let k = 0; k < header.count && offset + 8 <= cursor.end; k++) offset += 8 + cursor.bytes.u32(offset + 4)

		cursor.at = Math.min(cursor.end, offset)
	}

	// A nested metafile at the cursor, drawn into the px box (x, y, w, h).
	private nestedMetafile(cursor: Cursor, x: number, y: number, w: number, h: number, limit: number): void {
		const header = readHeader(cursor.bytes, cursor.at)

		if (header === undefined || this.nested >= MAX_NESTING || !(header.width !== 0 && header.height !== 0)) {
			this.out.unsupported++

			return
		}

		const unit = PX_PER_UNIT[header.mode.unit] ?? 1
		const frameW = header.width * unit * header.mode.scaleX
		const frameH = header.height * unit * header.mode.scaleY
		const kx = frameW === 0 ? 1 : w / frameW
		const ky = frameH === 0 ? 1 : h / frameH
		const mapping: Mapping = {
			ox: header.mode.x + x / (unit * header.mode.scaleX * kx),
			oy: header.mode.y + y / (unit * header.mode.scaleY * ky),
			sx: unit * header.mode.scaleX * kx,
			sy: unit * header.mode.scaleY * ky,
			unit
		}
		const inner = new Player(this.gdi, this.out, mapping, this.nested + 1)

		this.gdi.saveDc()
		inner.play(cursor.bytes, header.actions, header.count, limit)
		this.gdi.restoreDc(-1)
	}
}

interface Header {
	readonly mode: MapModeValue
	readonly width: number
	readonly height: number
	readonly count: number
	// Offset of the first action.
	readonly actions: number
}

function readHeader(bytes: Bytes, at: number): Header | undefined {
	if (!MAGIC.every((byte, k) => bytes.u8(at + k) === byte)) return undefined

	const cursor = new Cursor(bytes, at + 6, bytes.length)
	const compat = cursor.compat()

	// The stream's compression mode (it applies to bitmaps the actions hold, which carry their own headers).
	cursor.u32()

	cursor.at = Math.max(cursor.at, at + 16)

	const modeCompat = cursor.compat()
	const unit = cursor.u16()
	const x = cursor.i32()
	const y = cursor.i32()
	const numX = cursor.i32()
	const denX = cursor.i32()
	const numY = cursor.i32()
	const denY = cursor.i32()

	cursor.at = modeCompat.end

	const width = cursor.i32()
	const height = cursor.i32()
	const count = cursor.u32()

	if (cursor.over || compat.version < 1) return undefined

	return {
		mode: { unit, x, y, scaleX: denX === 0 ? 1 : numX / denX, scaleY: denY === 0 ? 1 : numY / denY },
		width,
		height,
		count,
		actions: cursor.at
	}
}

// A metafile conversion (core/metafile/types.ts) of this format.
export type SvmConversion =
	| {
			readonly ok: true
			readonly format: "svm"
			readonly list: Output["list"]
			readonly frame: readonly [number, number, number, number]
			readonly unsupported: number
			readonly truncated: boolean
	  }
	| { readonly ok: false; readonly reason: MetafileFailure }

export function convertSvm(bytes: Bytes): SvmConversion {
	const header = readHeader(bytes, 0)

	if (header === undefined) return { ok: false, reason: "malformed" }

	const unit = PX_PER_UNIT[header.mode.unit] ?? 1
	const sx = unit * header.mode.scaleX
	const sy = unit * header.mode.scaleY
	const width = Math.abs(header.width * sx)
	const height = Math.abs(header.height * sy)

	if (!(width > 0 && height > 0)) return { ok: false, reason: "malformed" }

	const out = new Output(width, height)
	const gdi = new Gdi(out, { kind: "wmf", frameWidth: width, frameHeight: height }, [1, 0, 0, 1, 0, 0], [0, 0], [width, height])
	const player = new Player(gdi, out, { ox: header.mode.x, oy: header.mode.y, sx, sy, unit }, 0)
	let truncated = false

	try {
		truncated = !player.play(bytes, header.actions, header.count)
	} catch (error) {
		if (!(error instanceof MetafileLimit)) throw error

		truncated = true
	}

	return { ok: true, format: "svm", list: out.list, frame: [0, 0, width, height], unsupported: out.unsupported, truncated }
}

// VCL's own DIB compression: behind the info header come the coded size, the uncoded size, the real
// compression and a zlib stream holding the bits.
const ZCODEC_COMPRESSION = 0x01004453
const INFLATE_STEP = 8 * 1024
// Where in the stream an inflated bitmap's bits came from: they sit in their own buffer, so their offset
// there would not tell bitmaps apart.
const inflatedFrom = new WeakMap<Dib, number>()

function svmDib(bytes: Bytes, bmiOffset: number, bmiSize: number, bitsOffset: number, bitsSize: number): Dib | undefined {
	if (bmiSize < 40 || bytes.u32(bmiOffset) < 40 || bytes.u32(bmiOffset + 16) !== ZCODEC_COMPRESSION) {
		return parseDib(bytes, bmiOffset, bmiSize, bitsOffset, bitsSize, 0)
	}

	const width = Math.abs(bytes.i32(bmiOffset + 4))
	const height = Math.abs(bytes.i32(bmiOffset + 8))
	const bitCount = bytes.u16(bmiOffset + 14)
	const codedSize = bytes.u32(bitsOffset)
	const uncodedSize = bytes.u32(bitsOffset + 4)
	const stride = Math.ceil((width * bitCount) / 32) * 4
	// Never more than the declared rows need, so a small stream cannot claim a large buffer.
	const size = Math.min(uncodedSize, stride * height)

	if (size <= 0 || size > MAX_DECODE_PIXELS * 4 || codedSize > bitsSize - 12) return undefined

	// The header with the real compression, then the bits inflated behind it.
	const header = bytes.sub(bmiOffset, bmiSize)
	const joined = new Uint8Array(header.length + size)
	let written = 0
	const unzlib = new Unzlib(chunk => {
		const take = Math.min(chunk.length, size - written)

		joined.set(chunk.subarray(0, take), header.length + written)
		written += take
	})
	const coded = bytes.sub(bitsOffset + 12, codedSize)

	joined.set(header)
	new DataView(joined.buffer).setUint32(16, bytes.u32(bitsOffset + 8), true)

	try {
		for (let at = 0; at < coded.length && written < size; at += INFLATE_STEP) {
			unzlib.push(coded.subarray(at, at + INFLATE_STEP), at + INFLATE_STEP >= coded.length)
		}
	} catch {
		return undefined
	}

	const dib = parseDib(new Bytes(joined), 0, header.length, header.length, size, 0)

	if (dib !== undefined) inflatedFrom.set(dib, bitsOffset)

	return dib
}
