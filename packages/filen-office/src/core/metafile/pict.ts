import { Bytes } from "./bytes"
import { encodePng, sniffImage } from "./dib"
import { Gdi, RegionMode, solidPen, type BrushObject } from "./gdi"
import { MAX_DECODE_PIXELS, MetafileLimit } from "./limits"
import { Output } from "./output"
import { metafileFont } from "./text"
import type { MetafileFailure } from "./types"

// QuickDraw pictures (Apple, Inside Macintosh: Imaging With QuickDraw, Appendix A "Picture Opcodes"): the PICT
// blips of Mac-made .ppt files. Version 1 (byte opcodes) and version 2 (word opcodes, word-aligned data, with the
// extended header), big-endian. Shapes, text, bitmaps (BitsRect, PackBitsRect, DirectBitsRect and their region
// forms) and QuickTime-compressed JPEG and PNG images are drawn through the GDI playback EMF and WMF use, with its
// device in px; patterns are drawn as their mean colour.

export type PictConversion =
	| {
			readonly ok: true
			readonly format: "pict"
			readonly list: Output["list"]
			readonly frame: readonly [number, number, number, number]
			readonly unsupported: number
			readonly truncated: boolean
	  }
	| { readonly ok: false; readonly reason: MetafileFailure }

const PX_PER_POINT = 96 / 72

// The picture's start: right after the optional 512-byte file header.
function pictStart(bytes: Bytes): number | undefined {
	for (const start of [0, 512]) {
		if (!bytes.has(start, 14)) continue

		const b = (k: number): number => bytes.u8(start + k)

		if (b(10) === 0x11 && b(11) === 0x01) return start
		if (b(10) === 0x00 && b(11) === 0x11 && b(12) === 0x02 && b(13) === 0xff) return start
	}

	return undefined
}

export function isPict(bytes: Bytes): boolean {
	return pictStart(bytes) !== undefined
}

// Classic QuickDraw colours (FgColor/BkColor) as RGB.
const OLD_COLORS: ReadonlyMap<number, number> = new Map([
	[33, 0x000000],
	[30, 0xffffff],
	[205, 0xff0000],
	[341, 0x00ff00],
	[409, 0x0000ff],
	[273, 0x00ffff],
	[137, 0xff00ff],
	[69, 0xffff00]
])

// Mac OS Roman 0x80–0xFF (Unicode's ROMAN.TXT mapping).
const MAC_ROMAN =
	"ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ"

function macRoman(bytes: Uint8Array): string {
	let out = ""

	for (const byte of bytes) out += byte < 0x80 ? String.fromCharCode(byte) : (MAC_ROMAN[byte - 0x80] ?? "?")

	return out
}

class Reader {
	readonly bytes: Bytes
	at: number
	readonly end: number

	constructor(bytes: Bytes, at: number, end: number) {
		this.bytes = bytes
		this.at = at
		this.end = end
	}

	need(count: number): boolean {
		return count >= 0 && this.at + count <= this.end
	}

	u8(): number {
		return this.at < this.end ? this.bytes.u8(this.at++) : (this.at++, 0)
	}

	u16(): number {
		return (this.u8() << 8) | this.u8()
	}

	i16(): number {
		const value = this.u16()

		return value >= 0x8000 ? value - 0x10000 : value
	}

	u32(): number {
		return this.u16() * 0x10000 + this.u16()
	}

	// Fixed 16.16.
	fixed(): number {
		const value = this.u32()

		return (value >= 0x80000000 ? value - 0x100000000 : value) / 65536
	}

	skip(count: number): void {
		this.at += Math.max(0, count)
	}

	// top, left, bottom, right.
	rect(): [number, number, number, number] {
		return [this.i16(), this.i16(), this.i16(), this.i16()]
	}

	// v, h.
	point(): [number, number] {
		const v = this.i16()

		return [this.i16(), v]
	}
}

const PATTERN_SOLID = 1
const PIXEL_SIZES: ReadonlySet<number> = new Set([1, 2, 4, 8, 16, 32])

interface Font {
	readonly id: number
	readonly size: number
	readonly face: number
}

// The mean coverage (0..1) of an 8x8 pattern's set bits.
function coverage(bits: readonly number[]): number {
	let set = 0

	for (const row of bits) for (let k = 0; k < 8; k++) set += (row >> k) & 1

	return set / 64
}

function mix(foreground: number, background: number, amount: number): number {
	const channel = (shift: number): number =>
		Math.round(((foreground >> shift) & 255) * amount + ((background >> shift) & 255) * (1 - amount)) << shift

	return channel(16) | channel(8) | channel(0)
}

function rgba(color: number): number {
	return (((color & 0xffffff) << 8) | 255) >>> 0
}

class Player {
	private readonly gdi: Gdi
	private readonly out: Output
	private readonly version: number
	// Picture units to px: px = (unit - ox) * sx.
	private readonly ox: number
	private readonly oy: number
	private readonly sx: number
	private readonly sy: number
	// The Origin opcode's offset.
	private dx = 0
	private dy = 0
	private penX = 0
	private penY = 0
	private textX = 0
	private textY = 0
	private penWidth = 1
	private penHeight = 1
	private foreground = 0x000000
	private background = 0xffffff
	private penCover = PATTERN_SOLID
	private fillCover = PATTERN_SOLID
	private backCover = 0
	private ovalWidth = 0
	private ovalHeight = 0
	private font: Font = { id: 0, size: 12, face: 0 }
	private readonly fontNames = new Map<number, string>()
	private lastRect: [number, number, number, number] = [0, 0, 0, 0]
	private lastPoly: number[] = []
	private lastArc: [number, number] = [0, 0]

	constructor(gdi: Gdi, out: Output, version: number, frame: readonly number[], sx: number, sy: number) {
		this.gdi = gdi
		this.out = out
		this.version = version
		this.ox = frame[1] ?? 0
		this.oy = frame[0] ?? 0
		this.sx = sx
		this.sy = sy
	}

	private x(h: number): number {
		return (h - this.dx - this.ox) * this.sx
	}

	private y(v: number): number {
		return (v - this.dy - this.oy) * this.sy
	}

	private box(rect: readonly number[]): [number, number, number, number] {
		return [this.x(rect[1] ?? 0), this.y(rect[0] ?? 0), this.x(rect[3] ?? 0), this.y(rect[2] ?? 0)]
	}

	// How a verb draws: frame strokes with the pen, paint fills with the pen pattern, erase with the background, fill
	// with the fill pattern; invert is not drawn.
	private verb(verb: number): boolean {
		const gdi = this.gdi
		const none = solidPen(5, 0, 0)

		switch (verb) {
			case 0: {
				const width = Math.max(this.penWidth * this.sx, this.penHeight * this.sy)

				if (!(width > 0)) return false

				gdi.selectObject(solidPen(0, width, rgba(mix(this.foreground, this.background, this.penCover)), null, false))
				gdi.selectObject(gdi.brush(1, 0, 0))

				return true
			}
			case 1:
			case 2:
			case 4: {
				const color =
					verb === 1
						? mix(this.foreground, this.background, this.penCover)
						: verb === 2
							? mix(this.foreground, this.background, this.backCover)
							: mix(this.foreground, this.background, this.fillCover)

				gdi.selectObject(none)
				gdi.selectObject({ kind: "brush", style: 0, color: rgba(color), hatch: 0 } as BrushObject)

				return true
			}
			default:
				this.out.unsupported++

				return false
		}
	}

	private rectangle(verb: number, rect: readonly number[]): void {
		if (!this.verb(verb)) return

		const [left, top, right, bottom] = this.box(rect)
		// A frame lies inside the rectangle: its pen hangs below and to the right of the outline.
		const inset = verb === 0 ? Math.max(this.penWidth * this.sx, this.penHeight * this.sy) / 2 : 0

		this.gdi.rectangle(left + inset, top + inset, right - inset, bottom - inset)
	}

	private oval(verb: number, rect: readonly number[]): void {
		if (!this.verb(verb)) return

		const [left, top, right, bottom] = this.box(rect)
		const inset = verb === 0 ? Math.max(this.penWidth * this.sx, this.penHeight * this.sy) / 2 : 0

		this.gdi.ellipse(left + inset, top + inset, right - inset, bottom - inset)
	}

	private roundRect(verb: number, rect: readonly number[]): void {
		if (!this.verb(verb)) return

		const [left, top, right, bottom] = this.box(rect)

		this.gdi.roundRect(left, top, right, bottom, this.ovalWidth * this.sx, this.ovalHeight * this.sy)
	}

	// Arcs: angles in degrees clockwise from 12 o'clock; paint and fill draw the wedge.
	private arc(verb: number, rect: readonly number[], start: number, sweep: number): void {
		if (!this.verb(verb)) return

		const [left, top, right, bottom] = this.box(rect)
		const cx = (left + right) / 2
		const cy = (top + bottom) / 2
		const rx = Math.abs(right - left) / 2
		const ry = Math.abs(bottom - top) / 2
		const at = (degrees: number): [number, number] => {
			const radians = (degrees * Math.PI) / 180

			return [cx + rx * Math.sin(radians), cy - ry * Math.cos(radians)]
		}
		const [xs, ys] = at(sweep >= 0 ? start : start + sweep)
		const [xe, ye] = at(sweep >= 0 ? start + sweep : start)

		this.gdi.setArcDirection(true)
		this.gdi.arc(verb === 0 ? "arc" : "pie", left, top, right, bottom, xs, ys, xe, ye)
	}

	private polygon(verb: number, points: readonly number[]): void {
		if (points.length < 4 || !this.verb(verb)) return

		const xs: number[] = []

		for (let k = 0; k + 1 < points.length; k += 2) xs.push(this.x(points[k] ?? 0), this.y(points[k + 1] ?? 0))

		if (verb === 0) this.gdi.polyline(xs, xs.length / 2)
		else this.gdi.polygon(xs, xs.length / 2)
	}

	private readPolygon(reader: Reader): number[] {
		const size = reader.u16()

		reader.rect()

		const count = Math.max(0, Math.floor((size - 10) / 4))
		const points: number[] = []

		if (!reader.need(count * 4)) return points

		for (let k = 0; k < count; k++) {
			const [h, v] = reader.point()

			points.push(h, v)
		}

		return points
	}

	// A region: its bounds (the rows of a complex region are skipped; it is drawn as its bounds).
	private readRegion(reader: Reader): [number, number, number, number] {
		const size = reader.u16()
		const rect = reader.rect()

		if (size > 10) {
			reader.skip(size - 10)
			this.out.unsupported++
		}

		return rect
	}

	private line(x1: number, y1: number, x2: number, y2: number): void {
		const width = Math.max(this.penWidth * this.sx, this.penHeight * this.sy)

		this.penX = x2
		this.penY = y2

		if (!(width > 0)) return

		// The pen hangs below and to the right of the line.
		const ox = (this.penWidth * this.sx) / 2
		const oy = (this.penHeight * this.sy) / 2

		this.gdi.selectObject(solidPen(0, width, rgba(mix(this.foreground, this.background, this.penCover)), null, false))
		this.gdi.polyline([this.x(x1) + ox, this.y(y1) + oy, this.x(x2) + ox, this.y(y2) + oy], 2)
	}

	private text(text: string): void {
		if (text === "") return

		const gdi = this.gdi
		const name = this.fontNames.get(this.font.id) ?? (this.font.id === 0 ? "Chicago" : "Geneva")
		const size = (this.font.size > 0 ? this.font.size : 12) * this.sy

		gdi.selectObject({
			kind: "font",
			font: metafileFont(
				-size,
				0,
				0,
				(this.font.face & 1) !== 0 ? 700 : 400,
				(this.font.face & 2) !== 0,
				(this.font.face & 4) !== 0,
				false,
				0,
				name
			)
		})
		gdi.setTextColor(rgba(this.foreground))
		gdi.setBkMode(1)
		gdi.setTextAlign(24)
		gdi.text(this.x(this.textX), this.y(this.textY), text, null, 1, 0, null)
	}

	private readText(reader: Reader): string {
		const count = reader.u8()

		if (!reader.need(count)) return ""

		const text = macRoman(reader.bytes.sub(reader.at, count))

		reader.skip(count)

		return text
	}

	private color(reader: Reader): number {
		return ((reader.u16() >> 8) << 16) | ((reader.u16() >> 8) << 8) | (reader.u16() >> 8)
	}

	private pattern(reader: Reader): number {
		const bits: number[] = []

		for (let k = 0; k < 8; k++) bits.push(reader.u8())

		return coverage(bits)
	}

	// A pixel pattern (PixPat): type 1 holds a colour pixmap, type 2 a dithered RGB colour; drawn as the colour
	// (or the old pattern's coverage).
	private pixPattern(reader: Reader): { cover: number; color: number | undefined } {
		const type = reader.u16()
		const cover = this.pattern(reader)

		if (type === 2) return { cover: 1, color: this.color(reader) }

		if (type === 1) {
			const pixmap = this.pixmapHeader(reader, false)

			if (pixmap === undefined) throw new MetafileLimit("pattern")

			this.colorTable(reader, pixmap)
			this.skipPixels(reader, pixmap)
		}

		return { cover, color: undefined }
	}

	private pixmapHeader(reader: Reader, direct: boolean): Pixmap | undefined {
		if (direct) reader.u32()

		const rowWord = reader.u16()
		const bounds = reader.rect()
		const isPixmap = (rowWord & 0x8000) !== 0
		const rowBytes = rowWord & 0x3fff
		let packType = 0
		let pixelSize = 1
		let cmpCount = 1

		if (isPixmap) {
			reader.u16()
			packType = reader.u16()
			reader.u32()
			reader.u32()
			reader.u32()
			reader.u16()
			pixelSize = reader.u16()
			cmpCount = reader.u16()
			reader.u16()
			reader.u32()
			reader.u32()
			reader.u32()
		}

		const width = (bounds[3] ?? 0) - (bounds[1] ?? 0)
		const height = (bounds[2] ?? 0) - (bounds[0] ?? 0)

		if (width <= 0 || height <= 0 || width * height > MAX_DECODE_PIXELS || rowBytes > 0x3fff) return undefined
		// Pixel sizes QuickDraw has, at most four components, and no more bytes a row than the pixels need (rows are
		// padded, so a little slack, and narrow rows up to 16 bytes): anything else would size the rows from hostile
		// numbers.
		if (!PIXEL_SIZES.has(pixelSize) || cmpCount < 1 || cmpCount > 4) return undefined
		if (rowBytes > Math.max(16, Math.ceil((width * pixelSize) / 8) + 3)) return undefined

		return { rowBytes, width, height, bounds, pixmap: isPixmap, packType, pixelSize, cmpCount, palette: undefined }
	}

	private colorTable(reader: Reader, pixmap: Pixmap): void {
		if (!pixmap.pixmap || pixmap.pixelSize > 8) return

		reader.u32()

		const flags = reader.u16()
		const count = reader.u16() + 1
		const palette = new Uint32Array(256)

		if (!reader.need(count * 8)) throw new MetafileLimit("colour table")

		for (let k = 0; k < count; k++) {
			const index = reader.u16()
			const color = this.color(reader)

			// A device colour table lists its colours in order, whatever their values.
			palette[(flags & 0x8000) !== 0 ? k & 255 : index & 255] = color
		}

		pixmap.palette = palette
	}

	// The pixel rows, unpacked: PackBits per row when rowBytes is 8 or more (word-wise for 16-bit pixels).
	private rows(reader: Reader, pixmap: Pixmap): Uint8Array | undefined {
		const { rowBytes, height } = pixmap
		const direct32 = pixmap.pixmap && pixmap.pixelSize === 32
		// Packed 32-bit rows hold their components one after the other (packType 4); packType 2 drops the pad byte.
		const unpacked =
			direct32 && pixmap.packType === 4
				? pixmap.width * pixmap.cmpCount
				: direct32 && pixmap.packType === 2
					? pixmap.width * 3
					: rowBytes
		// Packed rows take at least one byte each: a picture too short for its rows is refused before they are allocated.
		if (rowBytes >= 8 && !reader.need(height)) return undefined
		if (unpacked * height > MAX_DECODE_PIXELS * 4) return undefined

		const out = new Uint8Array(unpacked * height)

		if (rowBytes < 8 || (direct32 && pixmap.packType === 1) || (direct32 && pixmap.packType === 2)) {
			const size = (direct32 && pixmap.packType === 2 ? pixmap.width * 3 : rowBytes) * height

			if (!reader.need(size)) return undefined

			out.set(reader.bytes.sub(reader.at, size))
			reader.skip(size)

			return out
		}

		for (let row = 0; row < height; row++) {
			const count = rowBytes > 250 ? reader.u16() : reader.u8()

			if (!reader.need(count)) return undefined

			const end = reader.at + count
			let at = row * unpacked
			const rowEnd = at + unpacked
			const wordWise = pixmap.pixmap && pixmap.pixelSize === 16

			while (reader.at < end && at < rowEnd) {
				const flag = reader.u8()

				if (flag < 128) {
					const length = (flag + 1) * (wordWise ? 2 : 1)

					for (let k = 0; k < length && at < rowEnd; k++) out[at++] = reader.u8()
				} else if (flag > 128) {
					const repeat = 257 - flag

					if (wordWise) {
						const high = reader.u8()
						const low = reader.u8()

						for (let k = 0; k < repeat && at + 1 < rowEnd; k++) {
							out[at++] = high
							out[at++] = low
						}
					} else {
						const value = reader.u8()

						for (let k = 0; k < repeat && at < rowEnd; k++) out[at++] = value
					}
				}
			}

			reader.at = end
		}

		return out
	}

	private skipPixels(reader: Reader, pixmap: Pixmap): void {
		this.rows(reader, pixmap)
	}

	// The rows as top-down RGBA.
	private pixels(rows: Uint8Array, pixmap: Pixmap): Uint8Array {
		const { width, height, rowBytes } = pixmap
		const rgbaOut = new Uint8Array(width * height * 4)
		const size = pixmap.pixmap ? pixmap.pixelSize : 1
		const direct32 = pixmap.pixmap && size === 32
		const stride =
			direct32 && pixmap.packType === 4 ? width * pixmap.cmpCount : direct32 && pixmap.packType === 2 ? width * 3 : rowBytes

		for (let y = 0; y < height; y++) {
			const row = y * stride

			for (let x = 0; x < width; x++) {
				let color: number

				if (size === 32) {
					if (pixmap.packType === 4) {
						// Component planes: alpha first when there are four.
						const skip = pixmap.cmpCount >= 4 ? width : 0

						color =
							((rows[row + skip + x] ?? 0) << 16) |
							((rows[row + skip + width + x] ?? 0) << 8) |
							(rows[row + skip + 2 * width + x] ?? 0)
					} else if (pixmap.packType === 2) {
						color = ((rows[row + x * 3] ?? 0) << 16) | ((rows[row + x * 3 + 1] ?? 0) << 8) | (rows[row + x * 3 + 2] ?? 0)
					} else {
						color = ((rows[row + x * 4 + 1] ?? 0) << 16) | ((rows[row + x * 4 + 2] ?? 0) << 8) | (rows[row + x * 4 + 3] ?? 0)
					}
				} else if (size === 16) {
					const value = ((rows[row + x * 2] ?? 0) << 8) | (rows[row + x * 2 + 1] ?? 0)
					const five = (shift: number): number => {
						const c = (value >> shift) & 31

						return (c << 3) | (c >> 2)
					}

					color = (five(10) << 16) | (five(5) << 8) | five(0)
				} else {
					const perByte = 8 / size
					const byte = rows[row + Math.floor(x / perByte)] ?? 0
					const index = (byte >> ((perByte - 1 - (x % perByte)) * size)) & ((1 << size) - 1)

					color =
						pixmap.palette !== undefined
							? (pixmap.palette[index] ?? 0)
							: size === 1
								? index === 1
									? this.foreground
									: this.background
								: index * 0x010101
				}

				const at = (y * width + x) * 4

				rgbaOut[at] = (color >> 16) & 255
				rgbaOut[at + 1] = (color >> 8) & 255
				rgbaOut[at + 2] = color & 255
				rgbaOut[at + 3] = 255
			}
		}

		return rgbaOut
	}

	// BitsRect, BitsRgn, PackBitsRect, PackBitsRgn, DirectBitsRect, DirectBitsRgn.
	private bits(reader: Reader, direct: boolean, region: boolean): void {
		const pixmap = this.pixmapHeader(reader, direct)

		if (pixmap === undefined) throw new MetafileLimit("bitmap")

		this.colorTable(reader, pixmap)

		const source = reader.rect()
		const target = reader.rect()

		reader.u16()

		if (region) this.readRegion(reader)

		// The decode budget is spent before the rows are unpacked; past it playback ends with what was drawn.
		if (!this.out.spend(pixmap.width * pixmap.height)) throw new MetafileLimit("bitmap pixels")

		const rows = this.rows(reader, pixmap)

		if (rows === undefined) throw new MetafileLimit("bitmap rows")

		const image = this.out.embed({ format: "png", bytes: encodePng(this.pixels(rows, pixmap), pixmap.width, pixmap.height) })

		this.placeImage(image, pixmap, source, target)
	}

	private placeImage(
		image: number,
		size: { width: number; height: number; bounds?: readonly number[] },
		source: readonly number[],
		target: readonly number[]
	): void {
		if (image < 0) {
			this.out.unsupported++

			return
		}

		const [left, top, right, bottom] = this.box(target)
		const sw = (source[3] ?? 0) - (source[1] ?? 0)
		const sh = (source[2] ?? 0) - (source[0] ?? 0)

		if (!(sw > 0 && sh > 0)) return

		// The source rectangle in the pixmap's bounds, cropped.
		const bounds = size.bounds ?? [0, 0, size.height, size.width]
		const cropLeft = ((source[1] ?? 0) - (bounds[1] ?? 0)) / size.width
		const cropTop = ((source[0] ?? 0) - (bounds[0] ?? 0)) / size.height
		const cropped =
			cropLeft !== 0 || cropTop !== 0 || sw !== size.width || sh !== size.height
				? this.out.recrop(
						image,
						{ left: cropLeft, top: cropTop, right: 1 - cropLeft - sw / size.width, bottom: 1 - cropTop - sh / size.height },
						1
					)
				: image

		this.out.image(cropped, [1, 0, 0, 1, left, top], right - left, bottom - top, this.gdi.dc.clip)
	}

	// CompressedQuickTime: an image description and its data; JPEG and PNG images are drawn.
	private quickTime(reader: Reader, end: number): void {
		reader.u16()

		// The 3x3 matrix (Fixed, Fixed, Fract per row).
		const a = reader.fixed()
		const b = reader.fixed()

		reader.u32()

		const c = reader.fixed()
		const d = reader.fixed()

		reader.u32()

		const tx = reader.fixed()
		const ty = reader.fixed()

		reader.u32()

		const matteSize = reader.u32()

		reader.rect()
		reader.u16()

		const source = reader.rect()

		reader.u32()

		const maskSize = reader.u32()

		reader.skip(matteSize + maskSize)

		const descriptionStart = reader.at
		const descriptionSize = reader.u32()

		reader.at = descriptionStart + descriptionSize

		const dataSize = Math.max(0, end - reader.at)
		const data = reader.bytes.sub(reader.at, dataSize)
		const kind = sniffImage(data)

		reader.at = end

		if (kind !== "jpeg" && kind !== "png") {
			this.out.unsupported++

			return
		}

		const image = this.out.embed({ format: kind, bytes: data.slice() })
		const sw = (source[3] ?? 0) - (source[1] ?? 0)
		const sh = (source[2] ?? 0) - (source[0] ?? 0)

		if (image < 0 || !(sw > 0 && sh > 0)) {
			this.out.unsupported++

			return
		}

		// Source units through the matrix into picture units, then to px.
		const matrix = [
			a * this.sx,
			b * this.sy,
			c * this.sx,
			d * this.sy,
			(tx - this.dx - this.ox) * this.sx,
			(ty - this.dy - this.oy) * this.sy
		]
		const placed = [
			matrix[0] ?? 1,
			matrix[1] ?? 0,
			matrix[2] ?? 0,
			matrix[3] ?? 1,
			(matrix[4] ?? 0) + (source[1] ?? 0) * (matrix[0] ?? 1) + (source[0] ?? 0) * (matrix[2] ?? 0),
			(matrix[5] ?? 0) + (source[1] ?? 0) * (matrix[1] ?? 0) + (source[0] ?? 0) * (matrix[3] ?? 1)
		]

		this.out.image(image, placed, sw, sh, this.gdi.dc.clip)
	}

	// Plays the opcodes; false when they ended early.
	play(reader: Reader): boolean {
		const v2 = this.version === 2

		for (let guard = 0; guard < 2_000_000; guard++) {
			if (v2 && (reader.at & 1) !== 0) reader.at++
			if (!reader.need(v2 ? 2 : 1)) return false

			this.out.record()

			const op = v2 ? reader.u16() : reader.u8()

			if (op === 0x00ff) return true
			if (!this.opcode(reader, op)) return false
			if (reader.at > reader.end) return false
		}

		return false
	}

	// One opcode; false for one whose data cannot be skipped.
	private opcode(reader: Reader, op: number): boolean {
		const gdi = this.gdi

		switch (op) {
			case 0x0000:
			case 0x0017:
			case 0x0018:
			case 0x0019:
			case 0x001c:
			case 0x001e:
				return true
			case 0x0001: {
				const rect = this.readRegion(reader)
				const [left, top, right, bottom] = this.box(rect)

				gdi.resetClip()
				gdi.selectLogicalRects([left, top, right, bottom], RegionMode.COPY)

				return true
			}
			case 0x0002:
				this.backCover = this.pattern(reader)

				return true
			case 0x0003:
				this.font = { ...this.font, id: reader.u16() }

				return true
			case 0x0004:
				this.font = { ...this.font, face: reader.u8() }

				return true
			case 0x0005:
			case 0x0008:
			case 0x0015:
			case 0x0016:
				reader.skip(2)

				return true
			case 0x0006:
				reader.skip(4)

				return true
			case 0x0007:
				this.penHeight = reader.i16()
				this.penWidth = reader.i16()

				return true
			case 0x0009:
				this.penCover = this.pattern(reader)

				return true
			case 0x000a:
				this.fillCover = this.pattern(reader)

				return true
			case 0x000b:
				this.ovalHeight = reader.i16()
				this.ovalWidth = reader.i16()

				return true
			case 0x000c:
				this.dy += reader.i16()
				this.dx += reader.i16()

				return true
			case 0x000d:
				this.font = { ...this.font, size: reader.u16() }

				return true
			case 0x000e:
				this.foreground = OLD_COLORS.get(reader.u32()) ?? this.foreground

				return true
			case 0x000f:
				this.background = OLD_COLORS.get(reader.u32()) ?? this.background

				return true
			case 0x0010:
				reader.skip(8)

				return true
			case 0x0011:
				reader.skip(this.version === 2 ? 2 : 1)

				return true
			case 0x0012:
			case 0x0013:
			case 0x0014: {
				const pattern = this.pixPattern(reader)

				if (op === 0x0013) {
					this.penCover = pattern.cover
					if (pattern.color !== undefined) this.foreground = pattern.color
				} else if (op === 0x0014) this.fillCover = pattern.cover
				else this.backCover = pattern.cover

				return true
			}
			case 0x001a:
				this.foreground = this.color(reader)

				return true
			case 0x001b:
				this.background = this.color(reader)

				return true
			case 0x001d:
			case 0x001f:
				reader.skip(6)

				return true
			case 0x0020: {
				const [x1, y1] = reader.point()
				const [x2, y2] = reader.point()

				this.line(x1, y1, x2, y2)

				return true
			}
			case 0x0021: {
				const [x2, y2] = reader.point()

				this.line(this.penX, this.penY, x2, y2)

				return true
			}
			case 0x0022: {
				const [x1, y1] = reader.point()
				const dh = (reader.u8() << 24) >> 24
				const dv = (reader.u8() << 24) >> 24

				this.line(x1, y1, x1 + dh, y1 + dv)

				return true
			}
			case 0x0023: {
				const dh = (reader.u8() << 24) >> 24
				const dv = (reader.u8() << 24) >> 24

				this.line(this.penX, this.penY, this.penX + dh, this.penY + dv)

				return true
			}
			case 0x0028: {
				const [h, v] = reader.point()

				this.textX = h
				this.textY = v
				this.text(this.readText(reader))

				return true
			}
			case 0x0029:
				this.textX += reader.u8()
				this.text(this.readText(reader))

				return true
			case 0x002a:
				this.textY += reader.u8()
				this.text(this.readText(reader))

				return true
			case 0x002b:
				this.textX += reader.u8()
				this.textY += reader.u8()
				this.text(this.readText(reader))

				return true
			case 0x002c: {
				const length = reader.u16()
				const end = reader.at + length
				const id = reader.u16()
				const name = this.readText(reader)

				this.fontNames.set(id, name)
				reader.at = end

				return true
			}
			case 0x00a0:
				reader.skip(2)

				return true
			case 0x00a1: {
				reader.u16()
				reader.skip(reader.u16())

				return true
			}
			case 0x0c00:
				reader.skip(24)

				return true
			case 0x0090:
			case 0x0091:
			case 0x0098:
			case 0x0099:
				this.bits(reader, false, op === 0x0091 || op === 0x0099)

				return true
			case 0x009a:
			case 0x009b:
				this.bits(reader, true, op === 0x009b)

				return true
			case 0x8200:
			case 0x8201: {
				const length = reader.u32()
				const end = reader.at + length

				if (op === 0x8200) this.quickTime(reader, end)
				else this.out.unsupported++

				reader.at = end

				return true
			}
			default:
				return this.shapeOpcode(reader, op)
		}
	}

	private shapeOpcode(reader: Reader, op: number): boolean {
		if (op >= 0x0030 && op <= 0x003f) {
			if (op < 0x0038) this.lastRect = reader.rect()
			if ((op & 7) < 5) this.rectangle(op & 7, this.lastRect)

			return true
		}

		if (op >= 0x0040 && op <= 0x004f) {
			if (op < 0x0048) this.lastRect = reader.rect()
			if ((op & 7) < 5) this.roundRect(op & 7, this.lastRect)

			return true
		}

		if (op >= 0x0050 && op <= 0x005f) {
			if (op < 0x0058) this.lastRect = reader.rect()
			if ((op & 7) < 5) this.oval(op & 7, this.lastRect)

			return true
		}

		if (op >= 0x0060 && op <= 0x006f) {
			if (op < 0x0068) this.lastRect = reader.rect()

			this.lastArc = [reader.i16(), reader.i16()]

			if ((op & 7) < 5) this.arc(op & 7, this.lastRect, this.lastArc[0], this.lastArc[1])

			return true
		}

		if (op >= 0x0070 && op <= 0x007f) {
			if (op < 0x0078) this.lastPoly = this.readPolygon(reader)
			if ((op & 7) < 5) this.polygon(op & 7, this.lastPoly)

			return true
		}

		if (op >= 0x0080 && op <= 0x008f) {
			if (op < 0x0088) this.lastRect = this.readRegion(reader)
			if ((op & 7) < 5) this.rectangle(op & 7, this.lastRect)

			return true
		}

		// Reserved opcodes, by the lengths Appendix A gives them.
		if (op >= 0x0024 && op <= 0x002f) reader.skip(reader.u16())
		else if ((op >= 0x0092 && op <= 0x0097) || (op >= 0x009c && op <= 0x009f) || (op >= 0x00a2 && op <= 0x00af))
			reader.skip(reader.u16())
		else if (op >= 0x00b0 && op <= 0x00cf) return true
		else if (op >= 0x00d0 && op <= 0x00fe) reader.skip(reader.u32())
		else if (op >= 0x0100 && op <= 0x7fff) reader.skip((op >> 8) * 2)
		else if (op >= 0x8000 && op <= 0x80ff) return true
		else if (op >= 0x8100) reader.skip(reader.u32())
		else return false

		this.out.unsupported++

		return true
	}
}

interface Pixmap {
	readonly rowBytes: number
	readonly width: number
	readonly height: number
	// top, left, bottom, right.
	readonly bounds: readonly number[]
	readonly pixmap: boolean
	readonly packType: number
	readonly pixelSize: number
	readonly cmpCount: number
	palette: Uint32Array | undefined
}

export function convertPict(bytes: Bytes): PictConversion {
	const start = pictStart(bytes)

	if (start === undefined) return { ok: false, reason: "malformed" }

	const reader = new Reader(bytes, start + 2, bytes.length)
	let frame = reader.rect()
	const version = bytes.u8(start + 10) === 0x11 ? 1 : 2

	reader.at = start + (version === 1 ? 12 : 14)

	let sx = PX_PER_POINT
	let sy = PX_PER_POINT
	let width = ((frame[3] ?? 0) - (frame[1] ?? 0)) * PX_PER_POINT
	let height = ((frame[2] ?? 0) - (frame[0] ?? 0)) * PX_PER_POINT

	// Version 2's header: an extended one (-2) gives the source rectangle the opcodes use at its own resolution.
	if (version === 2 && bytes.u8(reader.at) === 0x0c && bytes.u8(reader.at + 1) === 0x00) {
		const header = new Reader(bytes, reader.at + 2, bytes.length)
		const kind = header.i16()

		if (kind === -2) {
			header.u16()

			const hRes = header.fixed()
			const vRes = header.fixed()
			const source = header.rect()
			const sw = (source[3] ?? 0) - (source[1] ?? 0)
			const sh = (source[2] ?? 0) - (source[0] ?? 0)

			// The opcodes draw in the source rectangle at the stated resolution.
			if (sw > 0 && sh > 0 && hRes > 0 && vRes > 0) {
				sx = (72 / hRes) * PX_PER_POINT
				sy = (72 / vRes) * PX_PER_POINT
				width = sw * sx
				height = sh * sy
				frame = source
			}
		}
	}

	if (!(width > 0 && height > 0)) return { ok: false, reason: "malformed" }

	width = Math.min(width, 1e6)
	height = Math.min(height, 1e6)

	const out = new Output(width, height)
	const gdi = new Gdi(out, { kind: "wmf", frameWidth: width, frameHeight: height }, [1, 0, 0, 1, 0, 0], [0, 0], [width, height])
	const player = new Player(gdi, out, version, frame, sx, sy)
	let truncated = false

	try {
		truncated = !player.play(reader)
	} catch (error) {
		if (!(error instanceof MetafileLimit)) throw error

		truncated = true
	}

	return { ok: true, format: "pict", list: out.list, frame: [0, 0, width, height], unsupported: out.unsupported, truncated }
}
