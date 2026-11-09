import type { Bytes } from "./bytes"
import { parseDib, type Dib, type DibTransparency } from "./dib"
import { appendConversion } from "./embed"
import { EmfPlus } from "./emfplus"
import { Gdi, Rop, rgb, solidPen, type GdiObject } from "./gdi"
import { MAX_REGION_RECTS, MetafileLimit } from "./limits"
import { Output, mul } from "./output"
import { decodeAnsi, metafileFont } from "./text"
import type { MetafileConversion } from "./types"

// Enhanced Metafiles ([MS-EMF]): a header naming the picture frame and reference device, then 32-bit
// records. Pictures with EMF+ records ([MS-EMFPLUS]) in their comments are drawn from those when every EMF+
// record is understood, otherwise ("EMF+ Dual") from the EMF records that accompany them.

const EMF_SIGNATURE = 0x464d4520
const EMF_PLUS = 0x2b464d45
const GDI_COMMENT = 0x43494447
const MULTIFORMATS = 0x40000004
const STOCK_OBJECT = 0x80000000

export type NestedConverter = (bytes: Uint8Array) => MetafileConversion

export function isEmf(bytes: Bytes): boolean {
	return bytes.u32(0) === 1 && bytes.u32(40) === EMF_SIGNATURE
}

interface Header {
	readonly width: number
	readonly height: number
	readonly pxPerMmX: number
	readonly pxPerMmY: number
	readonly deviceToOutput: number[]
	readonly size: number
	readonly handles: number
}

function header(bytes: Bytes): Header | undefined {
	const size = bytes.u32(4)

	if (size < 88 || !bytes.has(0, size)) return undefined

	const deviceX = bytes.i32(72)
	const deviceY = bytes.i32(76)
	let mmX = bytes.i32(80)
	let mmY = bytes.i32(84)

	// Micrometres, when the header has them, are more precise.
	if (size >= 108 && bytes.i32(100) > 0 && bytes.i32(104) > 0) {
		mmX = bytes.i32(100) / 1000
		mmY = bytes.i32(104) / 1000
	}

	const fallback = 96 / 25.4
	const pxPerMmX = deviceX > 0 && mmX > 0 ? deviceX / mmX : fallback
	const pxPerMmY = deviceY > 0 && mmY > 0 ? deviceY / mmY : fallback
	const frameLeft = bytes.i32(24)
	const frameTop = bytes.i32(28)
	const frameRight = bytes.i32(32)
	const frameBottom = bytes.i32(36)
	let x0: number
	let y0: number
	let deviceWidth: number
	let deviceHeight: number

	if (frameRight > frameLeft && frameBottom > frameTop) {
		// .01 mm to device pixels.
		x0 = (frameLeft / 100) * pxPerMmX
		y0 = (frameTop / 100) * pxPerMmY
		deviceWidth = ((frameRight - frameLeft) / 100) * pxPerMmX
		deviceHeight = ((frameBottom - frameTop) / 100) * pxPerMmY
	} else {
		x0 = bytes.i32(8)
		y0 = bytes.i32(12)
		deviceWidth = bytes.i32(16) - x0 + 1
		deviceHeight = bytes.i32(20) - y0 + 1
	}

	if (!(deviceWidth > 0 && deviceHeight > 0 && Number.isFinite(deviceWidth) && Number.isFinite(deviceHeight))) return undefined

	const width = (deviceWidth / pxPerMmX) * fallback
	const height = (deviceHeight / pxPerMmY) * fallback
	const sx = width / deviceWidth
	const sy = height / deviceHeight

	return {
		width,
		height,
		pxPerMmX,
		pxPerMmY,
		deviceToOutput: [sx, 0, 0, sy, -x0 * sx, -y0 * sy],
		size,
		handles: bytes.u16(56)
	}
}

// Whether the record after the header is an EMF+ comment starting with an EMF+ header record.
function emfPlusHeader(bytes: Bytes, at: number): boolean {
	return bytes.u32(at) === 70 && bytes.u32(at + 12) === EMF_PLUS && bytes.u16(at + 16) === 0x4001
}

export function convertEmf(bytes: Bytes, nested: NestedConverter): MetafileConversion {
	const head = header(bytes)

	if (head === undefined) return { ok: false, reason: "malformed" }

	if (emfPlusHeader(bytes, head.size)) {
		const plus = playEmf(bytes, head, nested, true)

		if (plus.plusUnsupported === 0 || !plus.dual) return plus.conversion

		// A dual picture whose EMF+ records were not all drawn is drawn from whichever rendition misses less
		// (glyph-index text, for one, draws in neither without the font's character map); EMF+ on a tie.
		const gdi = playEmf(bytes, head, nested, false)

		return gdi.conversion.ok && plus.conversion.ok && gdi.conversion.unsupported < plus.conversion.unsupported
			? gdi.conversion
			: plus.conversion
	}

	return playEmf(bytes, head, nested, false).conversion
}

interface Playback {
	readonly conversion: MetafileConversion
	readonly plusUnsupported: number
	readonly dual: boolean
}

function playEmf(bytes: Bytes, head: Header, nested: NestedConverter, usePlus: boolean): Playback {
	const out = new Output(head.width, head.height)
	const gdi = new Gdi(out, { kind: "emf", pxPerMmX: head.pxPerMmX, pxPerMmY: head.pxPerMmY }, head.deviceToOutput, [0, 0], [1, 1])
	const plus = usePlus ? new EmfPlus(gdi, bytes, nested) : undefined
	let truncated = false

	if (plus !== undefined) gdi.suppress = true

	try {
		truncated = play(bytes, head, gdi, plus, nested)
	} catch (error) {
		if (!(error instanceof MetafileLimit)) throw error

		truncated = true
	}

	return {
		conversion: {
			ok: true,
			format: plus !== undefined ? "emf+" : "emf",
			list: out.list,
			frame: [0, 0, head.width, head.height],
			unsupported: out.unsupported + (plus?.unsupported ?? 0),
			truncated
		},
		plusUnsupported: plus?.unsupported ?? 0,
		dual: plus?.dual ?? false
	}
}

function pointsL(bytes: Bytes, at: number, count: number): Float64Array {
	const out = new Float64Array(Math.max(0, count) * 2)

	for (let k = 0; k < count * 2; k++) out[k] = bytes.i32(at + k * 4)

	return out
}

function pointsS(bytes: Bytes, at: number, count: number): Float64Array {
	const out = new Float64Array(Math.max(0, count) * 2)

	for (let k = 0; k < count * 2; k++) out[k] = bytes.i16(at + k * 2)

	return out
}

// RegionData ([MS-EMF] 2.2.24): rectangles in device units, or null for an empty region.
function regionRects(bytes: Bytes, at: number, size: number): number[] | null {
	if (size < 32) return null

	const count = Math.min(bytes.u32(at + 8), Math.floor((size - 32) / 16), MAX_REGION_RECTS)
	const rects: number[] = []

	for (let k = 0; k < count; k++) {
		const r = at + 32 + k * 16

		rects.push(bytes.i32(r), bytes.i32(r + 4), bytes.i32(r + 8), bytes.i32(r + 12))
	}

	return rects
}

function xform(bytes: Bytes, at: number): number[] {
	return [bytes.f32(at), bytes.f32(at + 4), bytes.f32(at + 8), bytes.f32(at + 12), bytes.f32(at + 16), bytes.f32(at + 20)]
}

// A bitmap inside a record: header and bits at record-relative offsets.
function recordDib(
	bytes: Bytes,
	at: number,
	end: number,
	bmiOffset: number,
	bmiSize: number,
	bitsOffset: number,
	bitsSize: number,
	usage: number
): Dib | undefined {
	if (bmiSize === 0 || at + bmiOffset + bmiSize > end || at + bitsOffset > end) return undefined

	return parseDib(bytes, at + bmiOffset, bmiSize, at + bitsOffset, Math.min(bitsSize, end - at - bitsOffset), usage)
}

// Plays records after the header; true when the stream ended without its EOF record.
function play(bytes: Bytes, head: Header, gdi: Gdi, plus: EmfPlus | undefined, nested: NestedConverter): boolean {
	const out = gdi.out
	let at = head.size

	while (at + 8 <= bytes.length) {
		const type = bytes.u32(at)
		const size = bytes.u32(at + 4)

		if (size < 8 || size % 4 !== 0 || at + size > bytes.length) return true

		out.record()

		const end = at + size
		const i32 = (offset: number): number => bytes.i32(at + offset)
		const u32 = (offset: number): number => bytes.u32(at + offset)

		switch (type) {
			case 2:
			case 3:
			case 4:
			case 5:
			case 6:
			case 85:
			case 86:
			case 87:
			case 88:
			case 89: {
				const short = type >= 85
				const stride = short ? 4 : 8
				const count = Math.min(u32(24), Math.floor((size - 28) / stride))
				const points = short ? pointsS(bytes, at + 28, count) : pointsL(bytes, at + 28, count)

				switch (short ? type - 83 : type) {
					case 2:
						gdi.polyBezier(points, count, false)
						break
					case 3:
						gdi.polygon(points, count)
						break
					case 4:
						gdi.polyline(points, count)
						break
					case 5:
						gdi.polyBezier(points, count, true)
						break
					default:
						gdi.polylineTo(points, count)
						break
				}

				break
			}
			case 7:
			case 8:
			case 90:
			case 91: {
				const short = type >= 90
				const stride = short ? 4 : 8
				const polygons = Math.min(u32(24), Math.floor((size - 32) / 4))
				const total = u32(28)
				const counts: number[] = []
				let sum = 0

				for (let k = 0; k < polygons; k++) {
					const count = u32(32 + k * 4)

					counts.push(count)
					sum += count
				}

				const first = at + 32 + polygons * 4

				if (sum > total || first + sum * stride > end) break

				const points = short ? pointsS(bytes, first, sum) : pointsL(bytes, first, sum)

				if (type === 7 || type === 90) gdi.polyPolyline(points, counts)
				else gdi.polyPolygon(points, counts)

				break
			}
			case 56:
			case 92: {
				const short = type === 92
				const stride = short ? 4 : 8
				const count = Math.min(u32(24), Math.floor((size - 28) / (stride + 1)))
				const points = short ? pointsS(bytes, at + 28, count) : pointsL(bytes, at + 28, count)

				gdi.polyDraw(points, bytes.sub(at + 28 + count * stride, count), count)
				break
			}
			case 9:
				gdi.setWindowExt(i32(8), i32(12))
				break
			case 10:
				gdi.setWindowOrg(i32(8), i32(12))
				break
			case 11:
				gdi.setViewportExt(i32(8), i32(12))
				break
			case 12:
				gdi.setViewportOrg(i32(8), i32(12))
				break
			case 14:
				return false
			case 15: {
				const x = i32(8)
				const y = i32(12)

				gdi.fillRect(x, y, x + 1, y + 1, gdi.color(u32(16)))
				break
			}
			case 13:
				gdi.setBrushOrigin(i32(8), i32(12))
				break
			case 17:
				gdi.setMapMode(u32(8))
				break
			case 18:
				gdi.setBkMode(u32(8))
				break
			case 19:
				gdi.setPolyFillMode(u32(8))
				break
			case 20:
				gdi.setRop2(u32(8))
				break
			case 22:
				gdi.setTextAlign(u32(8))
				break
			case 24:
				gdi.setTextColor(gdi.color(u32(8)))
				break
			case 25:
				gdi.setBkColor(gdi.color(u32(8)))
				break
			case 26:
				gdi.offsetClip(i32(8), i32(12))
				break
			case 27:
				gdi.moveTo(i32(8), i32(12))
				break
			case 29:
				gdi.excludeClipRect(i32(8), i32(12), i32(16), i32(20))
				break
			case 30:
				gdi.intersectClipRect(i32(8), i32(12), i32(16), i32(20))
				break
			case 31:
				gdi.scaleViewportExt(i32(8), i32(12), i32(16), i32(20))
				break
			case 32:
				gdi.scaleWindowExt(i32(8), i32(12), i32(16), i32(20))
				break
			case 33:
				gdi.saveDc()
				break
			case 34:
				gdi.restoreDc(i32(8))
				break
			case 35:
				gdi.setWorld(xform(bytes, at + 8))
				break
			case 36:
				gdi.modifyWorld(xform(bytes, at + 8), u32(32))
				break
			case 37: {
				const index = u32(8)

				if ((index & STOCK_OBJECT) !== 0) gdi.selectStock(index & 0x7fffffff)
				else gdi.selectObject(gdi.objects.get(index))

				break
			}
			case 38:
				gdi.setObject(u32(8), solidPen(u32(12), Math.abs(i32(16)), gdi.color(u32(24))))
				break
			case 39:
				gdi.setObject(u32(8), gdi.brush(u32(12), gdi.color(u32(16)), u32(20)))
				break
			case 40:
				gdi.deleteObject(u32(8))
				break
			case 41:
				gdi.angleArc(i32(8), i32(12), u32(16), bytes.f32(at + 20), bytes.f32(at + 24))
				break
			case 42:
				gdi.ellipse(i32(8), i32(12), i32(16), i32(20))
				break
			case 43:
				gdi.rectangle(i32(8), i32(12), i32(16), i32(20))
				break
			case 44:
				gdi.roundRect(i32(8), i32(12), i32(16), i32(20), i32(24), i32(28))
				break
			case 45:
			case 46:
			case 47:
			case 55:
				gdi.arc(
					type === 45 ? "arc" : type === 46 ? "chord" : type === 47 ? "pie" : "arcTo",
					i32(8),
					i32(12),
					i32(16),
					i32(20),
					i32(24),
					i32(28),
					i32(32),
					i32(36)
				)
				break
			case 48:
				gdi.selectObject((u32(8) & STOCK_OBJECT) !== 0 ? undefined : gdi.objects.get(u32(8)))
				break
			case 49: {
				const count = Math.min(bytes.u16(at + 14), Math.floor((size - 16) / 4))
				const colors = []

				// PALETTEENTRY: red, green, blue, flags.
				for (let k = 0; k < count; k++)
					colors.push(rgb(bytes.u8(at + 16 + k * 4), bytes.u8(at + 17 + k * 4), bytes.u8(at + 18 + k * 4)))

				gdi.setObject(u32(8), { kind: "palette", colors })
				break
			}
			case 50: {
				const palette = gdi.objects.get(u32(8))

				if (palette?.kind === "palette") {
					const start = u32(12)
					const count = Math.min(u32(16), Math.floor((size - 20) / 4), 65_536 - start)

					for (let k = 0; k < count; k++)
						palette.colors[start + k] = rgb(bytes.u8(at + 20 + k * 4), bytes.u8(at + 21 + k * 4), bytes.u8(at + 22 + k * 4))
				}

				break
			}
			case 54:
				gdi.lineTo(i32(8), i32(12))
				break
			case 57:
				gdi.setArcDirection(u32(8) === 2)
				break
			case 58:
				gdi.setMiterLimit(u32(8))
				break
			case 59:
				gdi.beginPath()
				break
			case 60:
				gdi.endPath()
				break
			case 61:
				gdi.closeFigure()
				break
			case 62:
				gdi.drawPath(true, false)
				break
			case 63:
				gdi.drawPath(true, true)
				break
			case 64:
				gdi.drawPath(false, true)
				break
			case 66:
				gdi.widenPath()
				break
			case 67:
				gdi.selectClipPath(u32(8))
				break
			case 68:
				gdi.abortPath()
				break
			case 70:
				comment(bytes, at, size, gdi, plus, nested)
				break
			case 71:
			case 74: {
				const dataSize = u32(24)
				const brush = type === 71 ? gdi.objects.get(u32(28)) : gdi.dc.brush
				const rects = regionRects(bytes, at + (type === 71 ? 32 : 28), Math.min(dataSize, size - (type === 71 ? 32 : 28)))

				if (rects !== null && brush?.kind === "brush") gdi.fillRects(gdi.deviceRects(rects), brush)

				break
			}
			case 72: {
				const brush = gdi.objects.get(u32(28))
				const rects = regionRects(bytes, at + 40, Math.min(u32(24), size - 40))

				if (rects !== null && brush?.kind === "brush") gdi.frameRects(gdi.deviceRects(rects), i32(32), i32(36), brush)

				break
			}
			case 73: {
				const rects = regionRects(bytes, at + 28, Math.min(u32(24), size - 28))

				if (rects !== null) gdi.invertRects(gdi.deviceRects(rects))

				break
			}
			case 75: {
				const dataSize = u32(8)
				const mode = u32(12)

				gdi.selectDeviceRects(dataSize === 0 ? null : (regionRects(bytes, at + 16, Math.min(dataSize, size - 16)) ?? []), mode)
				break
			}
			case 76:
			case 77:
			case 114:
			case 116: {
				const rop = type === 114 || type === 116 ? Rop.SRCCOPY : u32(40)
				const dib = recordDib(bytes, at, end, u32(84), u32(88), u32(92), u32(96), u32(80))
				const xDest = i32(24)
				const yDest = i32(28)
				const cxDest = i32(32)
				const cyDest = i32(36)

				if (dib === undefined) {
					if (u32(88) === 0) gdi.patBlt(xDest, yDest, cxDest, cyDest, rop)
					else out.unsupported++

					break
				}

				// The source rectangle in source pixels through XformSrc (scale and offset).
				const source = xform(bytes, at + 52)
				const cxSrc = type === 76 ? cxDest : i32(100)
				const cySrc = type === 76 ? cyDest : i32(104)
				const sx = i32(44) * (source[0] ?? 1) + i32(48) * (source[2] ?? 0) + (source[4] ?? 0)
				const sy = i32(44) * (source[1] ?? 0) + i32(48) * (source[3] ?? 1) + (source[5] ?? 0)
				const sw = cxSrc * (source[0] || 1)
				const sh = cySrc * (source[3] || 1)
				let transparency: DibTransparency | undefined
				let alpha = 1

				if (type === 114) {
					alpha = bytes.u8(at + 42) / 255

					if (bytes.u8(at + 43) === 1) transparency = { kind: "alpha" }
				} else if (type === 116) {
					const key = u32(40)

					transparency = { kind: "key", color: ((key & 255) << 16) | (key & 0xff00) | ((key >>> 16) & 255) }
				}

				gdi.bitmap(dib, `${at}`, sx, sy, sw, sh, xDest, yDest, cxDest, cyDest, rop, transparency, alpha)
				break
			}
			case 78: {
				const dib = recordDib(bytes, at, end, u32(84), u32(88), u32(92), u32(96), u32(80))
				const mask = recordDib(bytes, at, end, u32(112), u32(116), u32(120), u32(124), u32(108))
				const xDest = i32(24)
				const yDest = i32(28)
				const cxDest = i32(32)
				const cyDest = i32(36)

				if (dib === undefined) {
					gdi.patBlt(xDest, yDest, cxDest, cyDest, u32(40))
					break
				}

				gdi.bitmap(
					dib,
					`${at}m`,
					i32(44),
					i32(48),
					cxDest,
					cyDest,
					xDest,
					yDest,
					cxDest,
					cyDest,
					Rop.SRCCOPY,
					mask === undefined ? undefined : { kind: "mask", mask }
				)
				break
			}
			case 79: {
				const dib = recordDib(bytes, at, end, u32(96), u32(100), u32(104), u32(108), u32(92))

				if (dib === undefined) {
					out.unsupported++
					break
				}

				// A parallelogram: the destination box (0..1) placed by its three corners.
				const x0 = i32(24)
				const y0 = i32(28)
				const x1 = i32(32)
				const y1 = i32(36)
				const x2 = i32(40)
				const y2 = i32(44)
				const saved = gdi.dc.world

				gdi.dc.world = mul(saved, [x1 - x0, y1 - y0, x2 - x0, y2 - y0, x0, y0])
				gdi.invalidate()
				gdi.bitmap(dib, `${at}`, i32(48), i32(52), i32(56), i32(60), 0, 0, 1, 1, Rop.SRCCOPY)
				gdi.dc.world = saved
				gdi.invalidate()
				break
			}
			case 80: {
				const dib = recordDib(bytes, at, end, u32(48), u32(52), u32(56), u32(60), u32(64))

				if (dib === undefined) out.unsupported++
				else
					gdi.bitmap(
						dib,
						`${at}`,
						i32(32),
						i32(36),
						i32(40),
						i32(44),
						i32(24),
						i32(28),
						i32(40),
						i32(44),
						Rop.SRCCOPY,
						undefined,
						1,
						true
					)

				break
			}
			case 81: {
				const dib = recordDib(bytes, at, end, u32(48), u32(52), u32(56), u32(60), u32(64))

				if (dib === undefined) {
					if (u32(52) === 0) gdi.patBlt(i32(24), i32(28), i32(72), i32(76), u32(68))
					else out.unsupported++

					break
				}

				gdi.bitmap(
					dib,
					`${at}`,
					i32(32),
					i32(36),
					i32(40),
					i32(44),
					i32(24),
					i32(28),
					i32(72),
					i32(76),
					u32(68),
					undefined,
					1,
					true
				)
				break
			}
			case 82: {
				const charset = bytes.u8(at + 35)

				gdi.setObject(u32(8), {
					kind: "font",
					font: metafileFont(
						i32(12),
						i32(16),
						i32(20),
						i32(28),
						bytes.u8(at + 32) !== 0,
						bytes.u8(at + 33) !== 0,
						bytes.u8(at + 34) !== 0,
						charset,
						bytes.utf16(at + 40, 32, true)
					)
				})
				break
			}
			case 83:
			case 84:
				text(bytes, at, at + 36, end, type === 84, gdi)
				break
			case 96:
			case 97: {
				const count = Math.min(u32(36), Math.floor((size - 40) / 40))

				for (let k = 0; k < count; k++) text(bytes, at, at + 40 + k * 40, end, type === 97, gdi)

				break
			}
			case 93:
			case 94: {
				const dib = recordDib(bytes, at, end, u32(16), u32(20), u32(24), u32(28), u32(12))

				gdi.setObject(u32(8), gdi.patternBrush(dib, type === 93))
				break
			}
			case 95: {
				const style = u32(28)
				const width = u32(32)
				const brushStyle = u32(36)
				const count = Math.min(u32(48), Math.floor((size - 52) / 4), 64)
				const dashes: number[] = []

				for (let k = 0; k < count; k++) dashes.push(u32(52 + k * 4))

				const color = brushStyle === 1 ? 0 : gdi.color(u32(40))
				// A pen with a null brush draws nothing.
				const penStyle = brushStyle === 1 ? 5 : style
				const object: GdiObject = solidPen(
					penStyle,
					width,
					color,
					dashes.length > 0 ? dashes : null,
					(style & 0x10000) === 0 || width === 0
				)

				gdi.setObject(u32(8), object)
				break
			}
			case 108: {
				// x, y, cChars, fuOptions, iGraphicsMode, exScale, eyScale, Bounds unless ETO_NO_RECT, then the string
				// (8-bit with ETO_SMALL_CHARS).
				const options = u32(20)
				const count = Math.min(u32(16), 65_536)
				const hasRect = (options & 0x100) === 0
				const textAt = at + 36 + (hasRect ? 16 : 0)
				const small = (options & 0x200) !== 0

				if (count === 0 || textAt + count * (small ? 1 : 2) > end || gdi.suppress) break

				// ETO_GLYPH_INDEX, as in EmrText.
				if ((options & 0x10) !== 0) {
					out.unsupported++
					break
				}

				const units = small ? decodeAnsi(bytes.sub(textAt, count), gdi.dc.font.charset) : bytes.utf16(textAt, count, false)

				gdi.text(i32(8), i32(12), units, null, 1, options & 0x6, hasRect ? [i32(36), i32(40), i32(44), i32(48)] : null)
				break
			}
			case 118:
				gradientFill(bytes, at, size, gdi)
				break
			// Brush origin, mapper flags, stretch mode, colour adjustment, meta region, palette realisation,
			// flattening (curves are kept), ICM and colour spaces, layout, justification, OpenGL and escapes
			// change nothing drawn here.
			case 16:
			case 21:
			case 23:
			case 28:
			case 51:
			case 52:
			case 65:
			case 98:
			case 99:
			case 100:
			case 101:
			case 102:
			case 103:
			case 104:
			case 105:
			case 106:
			case 109:
			case 110:
			case 111:
			case 112:
			case 113:
			case 115:
			case 119:
			case 120:
			case 121:
			case 122:
				break
			default:
				out.unsupported++
				break
		}

		at = end
	}

	return true
}

// An EmrText at `emr` inside the record at `at`.
function text(bytes: Bytes, at: number, emr: number, end: number, wide: boolean, gdi: Gdi): void {
	const count = Math.min(bytes.u32(emr + 8), 65_536)
	const stringAt = at + bytes.u32(emr + 12)
	const options = bytes.u32(emr + 16)
	const dxOffset = bytes.u32(emr + 36)
	const stringBytes = count * (wide ? 2 : 1)

	if (count === 0 || stringAt + stringBytes > end || gdi.suppress) return

	// ETO_GLYPH_INDEX: glyph ids of the selected font, which name no characters without its cmap.
	if ((options & 0x10) !== 0) {
		gdi.out.unsupported++

		return
	}

	const units = wide ? bytes.utf16(stringAt, count, false) : decodeAnsi(bytes.sub(stringAt, count), gdi.dc.font.charset)
	const stride = (options & 0x2000) !== 0 ? 2 : 1
	let dx: Int32Array | null = null

	if (dxOffset !== 0 && at + dxOffset + count * stride * 4 <= end) {
		dx = new Int32Array(count * stride)

		for (let k = 0; k < count * stride; k++) dx[k] = bytes.i32(at + dxOffset + k * 4)
	}

	const rect = [bytes.i32(emr + 20), bytes.i32(emr + 24), bytes.i32(emr + 28), bytes.i32(emr + 32)]

	// 8-bit text in a multi-byte code page decodes to fewer units: its advances no longer line up.
	gdi.text(bytes.i32(emr), bytes.i32(emr + 4), units, dx !== null && units.length === count ? dx : null, stride, options, rect)
}

// GRADIENT_FILL_RECT_H / _V as linear gradients; triangles as their mean colour.
function gradientFill(bytes: Bytes, at: number, size: number, gdi: Gdi): void {
	const vertices = Math.min(bytes.u32(at + 24), Math.floor((size - 36) / 16))
	const shapes = bytes.u32(at + 28)
	const mode = bytes.u32(at + 32)
	const vertex = (index: number): { x: number; y: number; color: number } => {
		const v = at + 36 + Math.min(index, vertices - 1) * 16

		return {
			x: bytes.i32(v),
			y: bytes.i32(v + 4),
			color: rgb(bytes.u16(v + 8) >>> 8, bytes.u16(v + 10) >>> 8, bytes.u16(v + 12) >>> 8)
		}
	}
	const shapesAt = at + 36 + vertices * 16
	const stride = mode === 2 ? 12 : 8
	const count = Math.min(shapes, Math.floor((at + size - shapesAt) / stride))

	if (vertices === 0) return

	for (let k = 0; k < count; k++) {
		const s = shapesAt + k * stride

		if (mode === 2) {
			const a = vertex(bytes.u32(s))
			const b = vertex(bytes.u32(s + 4))
			const c = vertex(bytes.u32(s + 8))

			gdi.gradientTriangle([a.x, a.y, b.x, b.y, c.x, c.y], [a.color, b.color, c.color])
		} else {
			const a = vertex(bytes.u32(s))
			const b = vertex(bytes.u32(s + 4))

			gdi.gradientRect(a.x, a.y, b.x, b.y, a.color, b.color, mode === 1)
		}
	}
}

// EMR_COMMENT: EMF+ records, and the EMF alternative of a multi-format comment.
function comment(bytes: Bytes, at: number, size: number, gdi: Gdi, plus: EmfPlus | undefined, nested: NestedConverter): void {
	const dataSize = Math.min(bytes.u32(at + 8), size - 12)
	const identifier = bytes.u32(at + 12)

	if (identifier === EMF_PLUS) {
		if (plus !== undefined) {
			plus.play(at + 16, at + 12 + dataSize)
			gdi.suppress = !plus.getDc
		}

		return
	}

	if (identifier !== GDI_COMMENT || bytes.u32(at + 16) !== MULTIFORMATS || gdi.suppress) return

	// EMR_COMMENT_MULTIFORMATS: the first EMF format, drawn into rclOutput (logical units).
	const formats = Math.min(bytes.u32(at + 36), 16)

	for (let k = 0; k < formats; k++) {
		const format = at + 40 + k * 16

		if (bytes.u32(format) !== EMF_SIGNATURE) continue

		const dataLength = bytes.u32(format + 8)
		const offset = at + 12 + bytes.u32(format + 12)

		if (offset + dataLength > at + size) return

		const conversion = nested(bytes.sub(offset, dataLength))

		if (!conversion.ok) return

		const left = bytes.i32(at + 20)
		const top = bytes.i32(at + 24)
		const right = bytes.i32(at + 28)
		const bottom = bytes.i32(at + 32)
		const [fx, fy, fw, fh] = conversion.frame

		if (fw <= 0 || fh <= 0) return

		const placement = mul(gdi.matrix(), [
			(right - left) / fw,
			0,
			0,
			(bottom - top) / fh,
			left - (fx * (right - left)) / fw,
			top - (fy * (bottom - top)) / fh
		])

		appendConversion(gdi.out, conversion, placement, gdi.dc.clip)

		return
	}
}
