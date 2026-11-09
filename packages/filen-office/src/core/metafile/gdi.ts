import { ItemFlag, type DashPreset, type Rgba, type Stroke } from "../drawingml/displayList"
import { dibBits, dibImage, monoTile, NO_ADJUST, OPAQUE, type Dib, type DibTransparency, type PixelAdjust } from "./dib"
import { MAX_OBJECTS, MAX_REGION_RECTS, MAX_SAVE_DEPTH, MAX_TEXT_CHARS, MetafileLimit } from "./limits"
import { combineClips, intersectClips, offsetClip, pathClip, rectClip, rectsClip, type ClipNode } from "./clip"
import { combineRects, normalizeRects, translateRects } from "./region"
import { PathBuilder, finiteMatrix, mul, scaleOf, transformX, transformY, type EmbeddedImage, type Matrix, type Output } from "./output"
import { DEFAULT_FONT, displayFace, drawnCodePoint, emHeight, pieceAdvance, type MetafileFont } from "./text"

// GDI playback shared by EMF and WMF: the device context (mapping, world transform, selected objects,
// colours, modes, current position, clip region, path bracket) and the drawing calls, written to the output
// list in output space.

export const MapMode = { TEXT: 1, LOMETRIC: 2, HIMETRIC: 3, LOENGLISH: 4, HIENGLISH: 5, TWIPS: 6, ISOTROPIC: 7, ANISOTROPIC: 8 } as const

export const BkMode = { TRANSPARENT: 1, OPAQUE: 2 } as const

export const RegionMode = { AND: 1, OR: 2, XOR: 3, DIFF: 4, COPY: 5 } as const

// Millimetres per logical unit of the metric mapping modes.
const MM_PER_UNIT: Readonly<Record<number, number>> = {
	[MapMode.LOMETRIC]: 0.1,
	[MapMode.HIMETRIC]: 0.01,
	[MapMode.LOENGLISH]: 0.254,
	[MapMode.HIENGLISH]: 0.0254,
	[MapMode.TWIPS]: 25.4 / 1440
}

const PS_NULL = 5
const PS_INSIDEFRAME = 6
const PS_USERSTYLE = 7
const PS_ALTERNATE = 8

const BS_SOLID = 0
const BS_NULL = 1
const BS_HATCHED = 2
const BS_PATTERN = 3

const ALTERNATE = 1
const GM_ADVANCED = 2

const R2_BLACK = 1
const R2_NOP = 11
const R2_WHITE = 16

const ETO_OPAQUE = 0x2
const ETO_CLIPPED = 0x4

const TA_UPDATECP = 1
const TA_RIGHT = 2
const TA_CENTER = 6
const TA_BOTTOM = 8
const TA_BASELINE = 24

export const Rop = {
	SRCCOPY: 0x00cc0020,
	SRCPAINT: 0x00ee0086,
	SRCAND: 0x008800c6,
	SRCINVERT: 0x00660046,
	SRCERASE: 0x00440328,
	NOTSRCCOPY: 0x00330008,
	NOTSRCERASE: 0x001100a6,
	MERGECOPY: 0x00c000ca,
	MERGEPAINT: 0x00bb0226,
	PATCOPY: 0x00f00021,
	PATPAINT: 0x00fb0a09,
	PATINVERT: 0x005a0049,
	DSTINVERT: 0x00550009,
	BLACKNESS: 0x00000042,
	WHITENESS: 0x00ff0062
} as const

// The operation code of a ternary raster operation (the high word of its DWORD).
function ropCode(rop: number): number {
	return (rop >>> 16) & 0xff
}

export interface PenObject {
	readonly kind: "pen"
	readonly style: number
	// Logical units; 0 draws one device pixel.
	readonly width: number
	readonly color: Rgba
	// PS_USERSTYLE dash and gap lengths in logical units.
	readonly dashes: readonly number[] | null
	// One device pixel wide whatever the width (PS_COSMETIC, or a zero width).
	readonly cosmetic: boolean
}

// The bitmap of a pattern brush: a DIB in its own colours, or monochrome bits a brush draws in the text
// colour (0) and the background colour (1).
export type PatternSource =
	| { readonly kind: "dib"; readonly dib: Dib }
	| { readonly kind: "mono"; readonly bits: Uint8Array; readonly width: number; readonly height: number }

export interface BrushObject {
	readonly kind: "brush"
	// BS_SOLID, BS_NULL, BS_HATCHED or BS_PATTERN.
	readonly style: number
	readonly color: Rgba
	readonly hatch: number
	readonly pattern?: PatternSource
}

// HS_* hatches as 8x8 bit rows (bit 7 is the leftmost pixel).
const HATCH_BITS: readonly (readonly number[])[] = [
	[0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0x00],
	[0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08, 0x08],
	[0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01],
	[0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80],
	[0x08, 0x08, 0x08, 0xff, 0x08, 0x08, 0x08, 0x08],
	[0x81, 0x42, 0x24, 0x18, 0x18, 0x24, 0x42, 0x81]
]

export interface FontObject {
	readonly kind: "font"
	readonly font: MetafileFont
}

export interface PaletteObject {
	readonly kind: "palette"
	readonly colors: Rgba[]
}

// A WMF region: rectangles (left, top, right, bottom) in logical units.
export interface RegionObject {
	readonly kind: "region"
	readonly rects: readonly number[]
}

export type GdiObject = PenObject | BrushObject | FontObject | PaletteObject | RegionObject

export function rgb(r: number, g: number, b: number): Rgba {
	return (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | 255) >>> 0
}

const BLACK = rgb(0, 0, 0)
const WHITE = rgb(255, 255, 255)

const STOCK_BRUSHES: readonly Rgba[] = [WHITE, rgb(192, 192, 192), rgb(128, 128, 128), rgb(64, 64, 64), BLACK]

export function solidBrush(color: Rgba): BrushObject {
	return { kind: "brush", style: BS_SOLID, color, hatch: 0 }
}

export function solidPen(
	style: number,
	width: number,
	color: Rgba,
	dashes: readonly number[] | null = null,
	cosmetic: boolean = width <= 0
): PenObject {
	return { kind: "pen", style, width, color, dashes, cosmetic }
}

const NULL_BRUSH: BrushObject = { kind: "brush", style: BS_NULL, color: BLACK, hatch: 0 }
const NULL_PEN = solidPen(PS_NULL, 0, BLACK)
const BLACK_PEN = solidPen(0, 0, BLACK)

interface Dc {
	mapMode: number
	winOrgX: number
	winOrgY: number
	winExtX: number
	winExtY: number
	vpOrgX: number
	vpOrgY: number
	vpExtX: number
	vpExtY: number
	world: number[]
	graphicsMode: number
	pen: PenObject
	brush: BrushObject
	font: MetafileFont
	palette: readonly Rgba[] | null
	textColor: Rgba
	bkColor: Rgba
	bkMode: number
	polyFill: number
	textAlign: number
	rop2: number
	miterLimit: number
	arcClockwise: boolean
	charExtra: number
	brushOriginX: number
	brushOriginY: number
	curX: number
	curY: number
	clip: ClipNode | null
}

function copyDc(dc: Dc): Dc {
	return { ...dc, world: dc.world.slice() }
}

// How logical units reach the device: EMF through its reference device and mapping mode; WMF onto its
// picture frame through the window.
export type DeviceModel =
	| { readonly kind: "emf"; readonly pxPerMmX: number; readonly pxPerMmY: number }
	| { readonly kind: "wmf"; readonly frameWidth: number; readonly frameHeight: number }

export class Gdi {
	readonly out: Output
	readonly device: DeviceModel
	// Device space to output space.
	readonly deviceToOutput: Matrix
	// Output units per device pixel (the width of a cosmetic pen).
	readonly devicePx: number
	dc: Dc
	readonly objects = new Map<number, GdiObject>()
	// While set, drawing calls draw nothing (an EMF+ rendition of the same picture is drawn instead).
	suppress = false
	private readonly stack: Dc[] = []
	private readonly path = new PathBuilder()
	private readonly scratch = new PathBuilder()
	private inPath = false
	private widened = false
	private cached: number[] | null = null
	private readonly penStrokes = new WeakMap<PenObject, { width: number; index: number }>()
	private textChars = 0
	// No slot below this one is free.
	private freeFrom = 0
	// Encoded bitmaps by source and treatment, so a bitmap drawn repeatedly is embedded once.
	private readonly images = new Map<string, number>()
	private readonly objectIds = new WeakMap<object, number>()
	private objectCount = 0

	constructor(out: Output, device: DeviceModel, deviceToOutput: Matrix, windowOrg: readonly number[], windowExt: readonly number[]) {
		this.out = out
		this.device = device
		this.deviceToOutput = deviceToOutput
		this.devicePx = Math.max(1e-6, scaleOf(deviceToOutput))
		this.dc = {
			mapMode: MapMode.TEXT,
			winOrgX: windowOrg[0] ?? 0,
			winOrgY: windowOrg[1] ?? 0,
			winExtX: windowExt[0] ?? 1,
			winExtY: windowExt[1] ?? 1,
			vpOrgX: 0,
			vpOrgY: 0,
			vpExtX: device.kind === "wmf" ? device.frameWidth : 1,
			vpExtY: device.kind === "wmf" ? device.frameHeight : 1,
			world: [1, 0, 0, 1, 0, 0],
			graphicsMode: 1,
			pen: BLACK_PEN,
			brush: solidBrush(WHITE),
			font: DEFAULT_FONT,
			palette: null,
			textColor: BLACK,
			bkColor: WHITE,
			bkMode: BkMode.OPAQUE,
			polyFill: ALTERNATE,
			textAlign: 0,
			rop2: 13,
			miterLimit: 10,
			arcClockwise: false,
			charExtra: 0,
			brushOriginX: 0,
			brushOriginY: 0,
			curX: 0,
			curY: 0,
			clip: null
		}
	}

	// --- Mapping ---

	invalidate(): void {
		this.cached = null
	}

	// Page space to device space.
	private page(): number[] {
		const dc = this.dc
		const device = this.device
		let sx: number
		let sy: number
		const vpOrgX = dc.vpOrgX
		const vpOrgY = dc.vpOrgY
		const metric = MM_PER_UNIT[dc.mapMode]

		if (device.kind === "emf") {
			if (metric !== undefined) {
				sx = metric * device.pxPerMmX
				sy = -metric * device.pxPerMmY
			} else if (dc.mapMode === MapMode.ISOTROPIC || dc.mapMode === MapMode.ANISOTROPIC) {
				sx = dc.winExtX === 0 ? 1 : dc.vpExtX / dc.winExtX
				sy = dc.winExtY === 0 ? 1 : dc.vpExtY / dc.winExtY
			} else {
				sx = 1
				sy = 1
			}
		} else if (metric !== undefined) {
			sx = (metric * 96) / 25.4
			sy = (-metric * 96) / 25.4
		} else {
			// A WMF player maps the window onto its viewport, which starts as the picture frame (viewport
			// records replace it), whatever the mapping mode; the metric modes' units are physical.
			sx = dc.winExtX === 0 ? 1 : dc.vpExtX / dc.winExtX
			sy = dc.winExtY === 0 ? 1 : dc.vpExtY / dc.winExtY
		}

		if (dc.mapMode === MapMode.ISOTROPIC) {
			const s = Math.min(Math.abs(sx), Math.abs(sy))

			sx = Math.sign(sx) * s
			sy = Math.sign(sy) * s
		}

		return [sx, 0, 0, sy, vpOrgX - dc.winOrgX * sx, vpOrgY - dc.winOrgY * sy]
	}

	// Logical space to output space.
	matrix(): number[] {
		if (this.cached === null) {
			const m = mul(this.deviceToOutput, mul(this.page(), this.dc.world))

			this.cached = finiteMatrix(m) ? m : [0, 0, 0, 0, 0, 0]
		}

		return this.cached
	}

	setMapMode(mode: number): void {
		if (mode >= MapMode.TEXT && mode <= MapMode.ANISOTROPIC) {
			this.dc.mapMode = mode
			this.invalidate()
		}
	}

	setWindowOrg(x: number, y: number): void {
		this.dc.winOrgX = x
		this.dc.winOrgY = y
		this.invalidate()
	}

	setWindowExt(x: number, y: number): void {
		if (x === 0 || y === 0) return

		this.dc.winExtX = x
		this.dc.winExtY = y
		this.invalidate()
	}

	setViewportOrg(x: number, y: number): void {
		this.dc.vpOrgX = x
		this.dc.vpOrgY = y
		this.invalidate()
	}

	setViewportExt(x: number, y: number): void {
		if (x === 0 || y === 0) return

		this.dc.vpExtX = x
		this.dc.vpExtY = y
		this.invalidate()
	}

	offsetWindowOrg(x: number, y: number): void {
		this.setWindowOrg(this.dc.winOrgX + x, this.dc.winOrgY + y)
	}

	offsetViewportOrg(x: number, y: number): void {
		this.setViewportOrg(this.dc.vpOrgX + x, this.dc.vpOrgY + y)
	}

	scaleWindowExt(xNum: number, xDenom: number, yNum: number, yDenom: number): void {
		if (xDenom === 0 || yDenom === 0) return

		this.setWindowExt((this.dc.winExtX * xNum) / xDenom, (this.dc.winExtY * yNum) / yDenom)
	}

	scaleViewportExt(xNum: number, xDenom: number, yNum: number, yDenom: number): void {
		if (xDenom === 0 || yDenom === 0) return

		this.setViewportExt((this.dc.vpExtX * xNum) / xDenom, (this.dc.vpExtY * yNum) / yDenom)
	}

	// MWT_* modes of ModifyWorldTransform; the XFORM as [eM11, eM12, eM21, eM22, eDx, eDy].
	modifyWorld(xform: Matrix, mode: number): void {
		if (!finiteMatrix(xform)) return

		switch (mode) {
			case 1:
				this.dc.world = [1, 0, 0, 1, 0, 0]
				break
			case 2:
				this.dc.world = mul(this.dc.world, xform)
				break
			case 3:
				this.dc.world = mul(xform, this.dc.world)
				break
			case 4:
				this.dc.world = xform.slice()
				break
			default:
				return
		}

		this.invalidate()
	}

	setWorld(xform: Matrix): void {
		this.modifyWorld(xform, 4)
	}

	setGraphicsMode(mode: number): void {
		this.dc.graphicsMode = mode
	}

	// --- State ---

	saveDc(): void {
		if (this.stack.length >= MAX_SAVE_DEPTH) throw new MetafileLimit("saved states")

		this.stack.push(copyDc(this.dc))
	}

	// A negative level pops that many states; a positive one returns to that saved state.
	restoreDc(level: number): void {
		const target = level < 0 ? this.stack.length + level : level - 1

		if (target < 0 || target >= this.stack.length) return

		const restored = this.stack[target]

		this.stack.length = target

		if (restored !== undefined) {
			this.dc = restored
			this.invalidate()
		}
	}

	// COLORREF to RGBA: palette indices resolve through the selected palette.
	color(colorRef: number): Rgba {
		if (colorRef >>> 24 === 1) return this.dc.palette?.[colorRef & 0xffff] ?? BLACK

		return rgb(colorRef & 255, (colorRef >>> 8) & 255, (colorRef >>> 16) & 255)
	}

	setTextColor(color: Rgba): void {
		this.dc.textColor = color
	}

	setBkColor(color: Rgba): void {
		this.dc.bkColor = color
	}

	setBkMode(mode: number): void {
		this.dc.bkMode = mode
	}

	setPolyFillMode(mode: number): void {
		this.dc.polyFill = mode
	}

	setTextAlign(align: number): void {
		this.dc.textAlign = align
	}

	setRop2(rop: number): void {
		this.dc.rop2 = rop
	}

	setMiterLimit(limit: number): void {
		if (Number.isFinite(limit) && limit >= 1) this.dc.miterLimit = limit
	}

	setArcDirection(clockwise: boolean): void {
		this.dc.arcClockwise = clockwise
	}

	setCharExtra(extra: number): void {
		this.dc.charExtra = extra
	}

	moveTo(x: number, y: number): void {
		this.dc.curX = x
		this.dc.curY = y

		if (this.inPath) {
			this.path.setMatrix(this.matrix())
			this.path.moveTo(x, y)
		}
	}

	// --- Objects ---

	setObject(index: number, object: GdiObject): void {
		if (index < 0 || index >= MAX_OBJECTS) return

		this.objects.set(index, object)
	}

	// The lowest free slot (WMF objects take the first free entry of the table).
	firstFree(): number {
		for (let index = this.freeFrom; index < MAX_OBJECTS; index++) {
			if (!this.objects.has(index)) {
				this.freeFrom = index

				return index
			}
		}

		throw new MetafileLimit("objects")
	}

	deleteObject(index: number): void {
		if (this.objects.delete(index) && index < this.freeFrom) this.freeFrom = index
	}

	selectObject(object: GdiObject | undefined): void {
		if (object === undefined) return

		switch (object.kind) {
			case "pen":
				this.dc.pen = object
				break
			case "brush":
				this.dc.brush = object
				break
			case "font":
				this.dc.font = object.font
				break
			case "palette":
				this.dc.palette = object.colors
				break
			case "region":
				this.selectLogicalRects(object.rects, RegionMode.COPY)
				break
		}
	}

	// EMF stock objects (ENHMETA_STOCK_OBJECT | index).
	selectStock(index: number): void {
		if (index <= 4) {
			this.dc.brush = solidBrush(STOCK_BRUSHES[index] ?? WHITE)
		} else if (index === 5) {
			this.dc.brush = NULL_BRUSH
		} else if (index === 6) {
			this.dc.pen = solidPen(0, 0, WHITE)
		} else if (index === 7) {
			this.dc.pen = BLACK_PEN
		} else if (index === 8) {
			this.dc.pen = NULL_PEN
		} else if (index >= 10 && index <= 17 && index !== 15) {
			this.dc.font = DEFAULT_FONT
		} else if (index === 15) {
			this.dc.palette = null
		}
	}

	// A brush from LOGBRUSH fields; pattern brushes come in as their average colour.
	brush(style: number, color: Rgba, hatch: number): BrushObject {
		if (style === BS_NULL) return NULL_BRUSH
		if (style === BS_HATCHED)
			return { kind: "brush", style: BS_HATCHED, color, hatch: hatch >= 0 && hatch < HATCH_BITS.length ? hatch : 0 }

		return solidBrush(color)
	}

	// A DIB pattern brush; `mono` for a monochrome brush (drawn in the text and background colours).
	patternBrush(dib: Dib | undefined, mono: boolean): BrushObject {
		if (dib === undefined) {
			this.out.unsupported++

			return NULL_BRUSH
		}

		const bits = mono ? dibBits(dib, this.out) : undefined

		return {
			kind: "brush",
			style: BS_PATTERN,
			color: BLACK,
			hatch: 0,
			pattern: bits !== undefined ? { kind: "mono", bits, width: dib.width, height: dib.height } : { kind: "dib", dib }
		}
	}

	// A monochrome pattern brush from top-down bits (a WMF Bitmap16).
	monoBrush(bits: Uint8Array, width: number, height: number): BrushObject {
		return { kind: "brush", style: BS_PATTERN, color: BLACK, hatch: 0, pattern: { kind: "mono", bits, width, height } }
	}

	// SetBrushOrgEx: where pattern and hatch tiles start, in device units.
	setBrushOrigin(x: number, y: number): void {
		this.dc.brushOriginX = x
		this.dc.brushOriginY = y
	}

	// --- Paint and stroke ---

	private overrideColor(color: Rgba): Rgba {
		switch (this.dc.rop2) {
			case R2_BLACK:
				return BLACK
			case R2_WHITE:
				return WHITE
			default:
				return color
		}
	}

	private fill(): number {
		const brush = this.dc.brush

		if (brush.style === BS_NULL) return -1

		const color = this.overrideColor(brush.color)

		if (this.dc.rop2 === R2_BLACK || this.dc.rop2 === R2_WHITE || brush.style === BS_SOLID) return this.out.solid(color)

		let image: number
		let width: number
		let height: number

		if (brush.style === BS_HATCHED) {
			const background = this.dc.bkMode === BkMode.OPAQUE ? this.dc.bkColor : (this.dc.bkColor & 0xffffff00) >>> 0
			const bits = new Uint8Array(64)
			const rows = HATCH_BITS[brush.hatch] ?? HATCH_BITS[0] ?? []

			for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits[y * 8 + x] = ((rows[y] ?? 0) >> (7 - x)) & 1

			image = this.tileImage(`h${brush.hatch},${color},${background}`, () => monoTile(bits, 8, 8, background, color))
			width = 8
			height = 8
		} else {
			const pattern = brush.pattern

			if (pattern === undefined) return this.out.solid(color)

			if (pattern.kind === "mono") {
				const text = this.dc.textColor
				const background = this.dc.bkColor

				image = this.tileImage(`m${this.objectId(pattern)},${text},${background}`, () =>
					monoTile(pattern.bits, pattern.width, pattern.height, text, background)
				)
				width = pattern.width
				height = pattern.height
			} else {
				image = this.tileImage(`d${this.objectId(pattern)}`, () =>
					dibImage(pattern.dib, OPAQUE, this.out, index => this.dc.palette?.[index] ?? BLACK)
				)
				width = pattern.dib.width
				height = pattern.dib.height
			}
		}

		if (image < 0) return this.out.solid(color)

		// Tiles are device pixels, anchored at the brush origin.
		const px = this.devicePx
		const ox = transformX(this.deviceToOutput, this.dc.brushOriginX, this.dc.brushOriginY)
		const oy = transformY(this.deviceToOutput, this.dc.brushOriginX, this.dc.brushOriginY)

		return this.out.paint({
			kind: "image",
			image,
			stretch: undefined,
			tile: { tx: 0, ty: 0, sx: 1, sy: 1, flip: "none", align: "tl", width, height, matrix: [px, 0, 0, px, ox, oy] }
		})
	}

	// An embedded tile image by key, encoded once; -1 when it cannot be.
	private tileImage(key: string, encode: () => EmbeddedImage | undefined): number {
		let image = this.images.get(key)

		if (image === undefined) {
			const encoded = encode()

			image = encoded === undefined ? -1 : this.out.embed(encoded)
			this.images.set(key, image)

			if (encoded === undefined) this.out.unsupported++
		}

		return image
	}

	// A small id per object, for cache keys.
	private objectId(object: object): number {
		const known = this.objectIds.get(object)

		if (known !== undefined) return known

		this.objectIds.set(object, ++this.objectCount)

		return this.objectCount
	}

	private stroke(): number {
		const pen = this.dc.pen
		const style = pen.style & 0xf

		if (style === PS_NULL) return -1

		const m = this.matrix()
		const cosmetic = pen.cosmetic
		const width = Math.max(this.devicePx, cosmetic ? this.devicePx : pen.width * scaleOf(m))
		const cached = this.penStrokes.get(pen)

		if (cached !== undefined && cached.width === width && this.dc.rop2 !== R2_BLACK && this.dc.rop2 !== R2_WHITE) return cached.index

		let dash: DashPreset = "solid"
		let customDash: Float32Array | null = null
		// Cosmetic patterns are fixed in device pixels; geometric ones scale with the width.
		const device = (lengths: readonly number[]): Float32Array => Float32Array.from(lengths, length => (length * this.devicePx) / width)

		switch (style) {
			case 1:
				if (cosmetic) customDash = device([18, 6])
				else dash = "sysDash"
				break
			case 2:
				if (cosmetic) customDash = device([3, 3])
				else dash = "sysDot"
				break
			case 3:
				if (cosmetic) customDash = device([9, 6, 3, 6])
				else dash = "sysDashDot"
				break
			case 4:
				if (cosmetic) customDash = device([9, 3, 3, 3, 3, 3])
				else dash = "sysDashDotDot"
				break
			case PS_ALTERNATE:
				customDash = device([1, 1])
				break
			case PS_USERSTYLE:
				if (pen.dashes !== null && pen.dashes.length > 0) {
					const scale = cosmetic ? this.devicePx : scaleOf(m)

					customDash = Float32Array.from(pen.dashes.slice(0, 32), length => Math.max(0, (length * scale) / width))
				}

				break
			default:
				break
		}

		const capBits = pen.style & 0xf00
		const joinBits = pen.style & 0xf000
		const stroke: Stroke = {
			width,
			paint: this.out.solid(this.overrideColor(pen.color)),
			dash,
			customDash,
			cap: capBits === 0x100 ? "square" : capBits === 0x200 ? "flat" : "round",
			join: joinBits === 0x1000 ? "bevel" : joinBits === 0x2000 ? "miter" : "round",
			miterLimit: this.dc.miterLimit,
			compound: "sng",
			inset: style === PS_INSIDEFRAME
		}
		const index = this.out.stroke(stroke)

		if (this.dc.rop2 !== R2_BLACK && this.dc.rop2 !== R2_WHITE) this.penStrokes.set(pen, { width, index })

		return index
	}

	// The builder a drawing call adds to: the open path bracket, or a fresh scratch path.
	private begin(): PathBuilder {
		const builder = this.inPath ? this.path : this.scratch

		if (!this.inPath) builder.clear()

		builder.setMatrix(this.matrix())

		return builder
	}

	private finish(builder: PathBuilder, filled: boolean, stroked: boolean): void {
		if (this.inPath || this.suppress || this.dc.rop2 === R2_NOP) return

		this.out.path(builder, filled ? this.fill() : -1, stroked ? this.stroke() : -1, this.dc.polyFill === ALTERNATE, this.dc.clip)
	}

	// --- Drawing (logical coordinates) ---

	// Closed polygons, filled and outlined. `points` holds x, y pairs; `counts` the points of each polygon.
	polyPolygon(points: ArrayLike<number>, counts: readonly number[]): void {
		const builder = this.begin()
		let at = 0

		for (const count of counts) {
			if (count < 1) continue

			builder.moveTo(points[at] ?? 0, points[at + 1] ?? 0)

			for (let k = 1; k < count; k++) builder.lineTo(points[at + k * 2] ?? 0, points[at + k * 2 + 1] ?? 0)

			builder.close()
			at += count * 2
		}

		this.finish(builder, true, true)
	}

	polygon(points: ArrayLike<number>, count: number): void {
		this.polyPolygon(points, [count])
	}

	// Open polylines, outlined only.
	polyPolyline(points: ArrayLike<number>, counts: readonly number[]): void {
		const builder = this.begin()
		let at = 0

		for (const count of counts) {
			if (count < 1) continue

			builder.moveTo(points[at] ?? 0, points[at + 1] ?? 0)

			for (let k = 1; k < count; k++) builder.lineTo(points[at + k * 2] ?? 0, points[at + k * 2 + 1] ?? 0)

			at += count * 2
		}

		this.finish(builder, false, true)
	}

	polyline(points: ArrayLike<number>, count: number): void {
		this.polyPolyline(points, [count])
	}

	// Continues from the current position (PolylineTo, LineTo) and moves it to the last point.
	polylineTo(points: ArrayLike<number>, count: number): void {
		if (count < 1) return

		const builder = this.begin()

		if (!this.inPath || !builder.open) builder.moveTo(this.dc.curX, this.dc.curY)

		for (let k = 0; k < count; k++) builder.lineTo(points[k * 2] ?? 0, points[k * 2 + 1] ?? 0)

		this.dc.curX = points[(count - 1) * 2] ?? 0
		this.dc.curY = points[(count - 1) * 2 + 1] ?? 0
		this.finish(builder, false, true)
	}

	lineTo(x: number, y: number): void {
		this.polylineTo([x, y], 1)
	}

	// Béziers: a start point and three points per curve (PolyBezier), or three per curve from the current
	// position (PolyBezierTo).
	polyBezier(points: ArrayLike<number>, count: number, fromCurrent: boolean): void {
		const builder = this.begin()
		let k = 0

		if (fromCurrent) {
			if (!this.inPath || !builder.open) builder.moveTo(this.dc.curX, this.dc.curY)
		} else {
			if (count < 1) return

			builder.moveTo(points[0] ?? 0, points[1] ?? 0)
			k = 1
		}

		for (; k + 3 <= count; k += 3) {
			builder.cubicTo(
				points[k * 2] ?? 0,
				points[k * 2 + 1] ?? 0,
				points[k * 2 + 2] ?? 0,
				points[k * 2 + 3] ?? 0,
				points[k * 2 + 4] ?? 0,
				points[k * 2 + 5] ?? 0
			)
		}

		if (fromCurrent && count >= 3) {
			const last = Math.floor(count / 3) * 3 - 1

			this.dc.curX = points[last * 2] ?? 0
			this.dc.curY = points[last * 2 + 1] ?? 0
		}

		this.finish(builder, false, true)
	}

	// PolyDraw: PT_MOVETO 6, PT_LINETO 2, PT_BEZIERTO 4, each optionally | PT_CLOSEFIGURE 1.
	polyDraw(points: ArrayLike<number>, types: ArrayLike<number>, count: number): void {
		const builder = this.begin()

		if (!this.inPath || !builder.open) builder.moveTo(this.dc.curX, this.dc.curY)

		for (let k = 0; k < count; k++) {
			const type = types[k] ?? 0
			const x = points[k * 2] ?? 0
			const y = points[k * 2 + 1] ?? 0

			switch (type & ~1) {
				case 6:
					builder.moveTo(x, y)
					break
				case 2:
					builder.lineTo(x, y)
					break
				case 4:
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
					break
			}

			if ((types[k] ?? 0) & 1) builder.close()

			this.dc.curX = points[k * 2] ?? 0
			this.dc.curY = points[k * 2 + 1] ?? 0
		}

		this.finish(builder, false, true)
	}

	rectangle(left: number, top: number, right: number, bottom: number): void {
		const builder = this.begin()

		builder.rect(left, top, right, bottom)
		this.finish(builder, true, true)
	}

	roundRect(left: number, top: number, right: number, bottom: number, width: number, height: number): void {
		const builder = this.begin()
		const x0 = Math.min(left, right)
		const x1 = Math.max(left, right)
		const y0 = Math.min(top, bottom)
		const y1 = Math.max(top, bottom)
		const rx = Math.min(Math.abs(width) / 2, (x1 - x0) / 2)
		const ry = Math.min(Math.abs(height) / 2, (y1 - y0) / 2)
		const half = Math.PI / 2

		if (rx <= 0 || ry <= 0) {
			builder.rect(x0, y0, x1, y1)
		} else {
			builder.arc(x1 - rx, y0 + ry, rx, ry, -half, half, false)
			builder.arc(x1 - rx, y1 - ry, rx, ry, 0, half, true)
			builder.arc(x0 + rx, y1 - ry, rx, ry, half, half, true)
			builder.arc(x0 + rx, y0 + ry, rx, ry, Math.PI, half, true)
			builder.close()
		}

		this.finish(builder, true, true)
	}

	ellipse(left: number, top: number, right: number, bottom: number): void {
		const builder = this.begin()

		builder.ellipse((left + right) / 2, (top + bottom) / 2, Math.abs(right - left) / 2, Math.abs(bottom - top) / 2)
		this.finish(builder, true, true)
	}

	// The sweep sign of GDI arcs in logical space: counter-clockwise as seen on the device unless the arc
	// direction is clockwise (advanced mode measures in logical space).
	private arcSign(): number {
		const m = this.matrix()
		const flipped = this.dc.graphicsMode !== GM_ADVANCED && (m[0] ?? 1) * (m[3] ?? 1) - (m[1] ?? 0) * (m[2] ?? 0) < 0
		const clockwise = this.dc.arcClockwise !== flipped

		return clockwise ? 1 : -1
	}

	// Arc, ArcTo, Chord and Pie from a bounding box and two radials.
	arc(
		kind: "arc" | "arcTo" | "chord" | "pie",
		left: number,
		top: number,
		right: number,
		bottom: number,
		xs: number,
		ys: number,
		xe: number,
		ye: number
	): void {
		const cx = (left + right) / 2
		const cy = (top + bottom) / 2
		const rx = Math.abs(right - left) / 2
		const ry = Math.abs(bottom - top) / 2

		if (rx === 0 || ry === 0) return

		const start = Math.atan2((ys - cy) / ry, (xs - cx) / rx)
		const end = Math.atan2((ye - cy) / ry, (xe - cx) / rx)
		const sign = this.arcSign()
		let sweep = sign > 0 ? end - start : start - end

		while (sweep <= 0) sweep += Math.PI * 2

		const builder = this.begin()

		if (kind === "pie") builder.moveTo(cx, cy)
		if (kind === "arcTo" && (!this.inPath || !builder.open)) builder.moveTo(this.dc.curX, this.dc.curY)

		builder.arc(cx, cy, rx, ry, start, sign * sweep, kind === "pie" || kind === "arcTo")

		if (kind === "chord" || kind === "pie") builder.close()

		if (kind === "arcTo") {
			this.dc.curX = cx + rx * Math.cos(start + sign * sweep)
			this.dc.curY = cy + ry * Math.sin(start + sign * sweep)
		}

		this.finish(builder, kind === "chord" || kind === "pie", true)
	}

	// AngleArc: a line from the current position to the arc's start, then the arc (degrees, counter-clockwise).
	angleArc(x: number, y: number, radius: number, startDegrees: number, sweepDegrees: number): void {
		const builder = this.begin()
		const start = (-startDegrees * Math.PI) / 180
		const sweep = (-sweepDegrees * Math.PI) / 180

		if (!this.inPath || !builder.open) builder.moveTo(this.dc.curX, this.dc.curY)

		builder.arc(x, y, radius, radius, start, sweep, true)
		this.dc.curX = x + radius * Math.cos(start + sweep)
		this.dc.curY = y + radius * Math.sin(start + sweep)
		this.finish(builder, false, true)
	}

	// A filled rectangle without outline (PatBlt, SetPixel), painted with `paint` or the brush.
	fillRect(left: number, top: number, right: number, bottom: number, color?: Rgba, flags: number = 0): void {
		if (this.suppress) return

		const builder = this.scratch

		builder.clear()
		builder.setMatrix(this.matrix())
		builder.rect(left, top, right, bottom)
		this.out.path(builder, color === undefined ? this.fill() : this.out.solid(color), -1, false, this.dc.clip, flags)
	}

	// A rectangle shaded from `from` to `to`, left to right or top to bottom (GRADIENT_FILL_RECT_*).
	gradientRect(left: number, top: number, right: number, bottom: number, from: Rgba, to: Rgba, vertical: boolean): void {
		if (this.suppress) return

		const builder = this.scratch
		const m = this.matrix()

		builder.clear()
		builder.setMatrix(m)
		builder.rect(left, top, right, bottom)

		// The gradient's axis (0, 0) to (1, 0) along the rectangle's width or height.
		const axis = vertical ? [0, bottom - top, right - left, 0, left, top] : [right - left, 0, 0, bottom - top, left, top]
		const paint = this.out.paint({
			kind: "gradient",
			type: "linear",
			stops: { offsets: Float32Array.of(0, 1), colors: Uint32Array.of(from, to) },
			matrix: mul(m, axis),
			spread: "pad"
		})

		this.out.path(builder, paint, -1, false, this.dc.clip)
	}

	// A triangle with a colour per vertex (GRADIENT_FILL_TRIANGLE): a shaded paint over its outline, which the
	// renderer rasterises at the resolution it draws at.
	gradientTriangle(points: readonly number[], colors: readonly Rgba[]): void {
		if (this.suppress) return

		const m = this.matrix()
		const builder = this.scratch

		builder.clear()
		builder.setMatrix(m)
		builder.moveTo(points[0] ?? 0, points[1] ?? 0)
		builder.lineTo(points[2] ?? 0, points[3] ?? 0)
		builder.lineTo(points[4] ?? 0, points[5] ?? 0)
		builder.close()

		const local = new Float32Array(6)

		for (let k = 0; k < 3; k++) {
			local[k * 2] = transformX(m, points[k * 2] ?? 0, points[k * 2 + 1] ?? 0)
			local[k * 2 + 1] = transformY(m, points[k * 2] ?? 0, points[k * 2 + 1] ?? 0)
		}

		const paint = this.out.paint({
			kind: "shaded",
			points: local,
			colors: Uint32Array.from([0, 1, 2], k => colors[k] ?? BLACK),
			ramp: null
		})

		this.out.path(builder, paint, -1, false, this.dc.clip)
	}

	// PatBlt and the blits without a source bitmap.
	patBlt(left: number, top: number, width: number, height: number, rop: number): void {
		switch (ropCode(rop)) {
			case ropCode(Rop.PATCOPY):
				this.fillRect(left, top, left + width, top + height)
				break
			case ropCode(Rop.BLACKNESS):
				this.fillRect(left, top, left + width, top + height, BLACK)
				break
			case ropCode(Rop.WHITENESS):
				this.fillRect(left, top, left + width, top + height, WHITE)
				break
			case 0xaa:
				// D: the destination unchanged.
				break
			case ropCode(Rop.DSTINVERT):
				// ~D: white differenced with the destination.
				this.fillRect(left, top, left + width, top + height, WHITE, ItemFlag.BLEND_DIFFERENCE)
				break
			case ropCode(Rop.PATINVERT):
				this.fillRect(left, top, left + width, top + height, undefined, ItemFlag.BLEND_DIFFERENCE)
				break
			case ropCode(Rop.PATPAINT):
				// P | ~S | D without a source: P | D (the source is white-free).
				this.fillRect(left, top, left + width, top + height, undefined, ItemFlag.BLEND_LIGHTEN)
				break
			default:
				this.out.unsupported++
				break
		}
	}

	// Rectangles in output space filled with a brush (FillRgn, PaintRgn).
	fillRects(rects: ArrayLike<number>, brush: BrushObject): void {
		if (this.suppress || rects.length === 0) return

		const saved = this.dc.brush
		const builder = this.outputRectPath(rects)

		this.dc.brush = brush
		this.out.path(builder, this.fill(), -1, false, this.dc.clip)
		this.dc.brush = saved
	}

	// InvertRgn: rectangles in output space, white differenced with the destination.
	invertRects(rects: ArrayLike<number>): void {
		if (this.suppress || rects.length === 0) return

		this.out.path(this.outputRectPath(rects), this.out.solid(WHITE), -1, false, this.dc.clip, ItemFlag.BLEND_DIFFERENCE)
	}

	// FrameRgn: rectangles in output space minus their erosion by `width` across and `height` down (logical
	// units), the region shifted each way and intersected, filled with the brush.
	frameRects(rects: ArrayLike<number>, width: number, height: number, brush: BrushObject): void {
		if (this.suppress || rects.length === 0) return

		const m = this.matrix()
		const w = Math.abs(width) * Math.hypot(m[0] ?? 0, m[1] ?? 0)
		const h = Math.abs(height) * Math.hypot(m[2] ?? 0, m[3] ?? 0)
		const charge = this.out.env.charge
		const region = normalizeRects(rects, charge)
		let inner = combineRects(region, translateRects(region, -w, 0, charge), "and", charge)

		inner = combineRects(inner, translateRects(region, w, 0, charge), "and", charge)
		inner = combineRects(inner, translateRects(region, 0, -h, charge), "and", charge)
		inner = combineRects(inner, translateRects(region, 0, h, charge), "and", charge)

		this.fillRects(combineRects(region, inner, "diff", charge), brush)
	}

	private outputRectPath(rects: ArrayLike<number>): PathBuilder {
		const builder = this.scratch

		builder.clear()
		builder.setMatrix([1, 0, 0, 1, 0, 0])

		for (let k = 0; k + 3 < rects.length; k += 4) builder.rect(rects[k] ?? 0, rects[k + 1] ?? 0, rects[k + 2] ?? 0, rects[k + 3] ?? 0)

		return builder
	}

	// --- Path bracket ---

	beginPath(): void {
		this.path.clear()
		this.inPath = true
		this.widened = false
	}

	endPath(): void {
		this.inPath = false
	}

	abortPath(): void {
		this.path.clear()
		this.inPath = false
	}

	closeFigure(): void {
		if (this.inPath) this.path.close()
	}

	widenPath(): void {
		this.widened = true
	}

	// FillPath, StrokePath and StrokeAndFillPath; a widened path fills as its outline.
	drawPath(fill: boolean, stroke: boolean): void {
		this.inPath = false

		if (!this.suppress && this.dc.rop2 !== R2_NOP && !this.path.empty) {
			const outline = this.widened && fill && !stroke

			this.out.path(
				this.path,
				fill && !outline ? this.fill() : -1,
				stroke || outline ? this.stroke() : -1,
				this.dc.polyFill === ALTERNATE,
				this.dc.clip
			)
		}

		this.path.clear()
		this.widened = false
	}

	selectClipPath(mode: number): void {
		this.inPath = false

		if (!this.path.empty)
			this.combineClip(pathClip(this.path.commands, this.path.coords, this.dc.polyFill === ALTERNATE, this.out.env), mode)

		this.path.clear()
	}

	// --- Clipping ---

	private combineClip(region: ClipNode | null, mode: number): void {
		this.dc.clip = combineClips(this.dc.clip, region, mode, this.out.env)
	}

	intersectClipRect(left: number, top: number, right: number, bottom: number): void {
		this.combineClip(rectClip(left, top, right, bottom, this.matrix(), this.out.env), RegionMode.AND)
	}

	excludeClipRect(left: number, top: number, right: number, bottom: number): void {
		this.combineClip(rectClip(left, top, right, bottom, this.matrix(), this.out.env), RegionMode.DIFF)
	}

	// Device rectangles (left, top, right, bottom) combined into the clip; none clears it for COPY.
	selectDeviceRects(rects: readonly number[] | null, mode: number): void {
		if (rects === null) {
			if (mode === RegionMode.COPY) this.dc.clip = null

			return
		}

		this.combineClip(rectsClip(this.deviceRects(rects), this.out.env), mode)
	}

	// Logical rectangles (a WMF region) combined into the clip: exact rectangles under an axis-aligned
	// mapping, their transformed outlines otherwise.
	selectLogicalRects(rects: readonly number[], mode: number): void {
		const m = this.matrix()

		if ((m[1] ?? 0) === 0 && (m[2] ?? 0) === 0) {
			this.combineClip(rectsClip(this.logicalRects(rects), this.out.env), mode)

			return
		}

		const builder = this.logicalRectPath(rects)

		this.combineClip(pathClip(builder.commands, builder.coords, false, this.out.env), mode)
	}

	resetClip(): void {
		this.dc.clip = null
	}

	// OffsetClipRgn: the clip moved by a logical offset.
	offsetClip(dx: number, dy: number): void {
		const m = this.matrix()

		this.dc.clip = offsetClip(this.dc.clip, (m[0] ?? 1) * dx + (m[2] ?? 0) * dy, (m[1] ?? 0) * dx + (m[3] ?? 1) * dy, this.out.env)
	}

	// Logical rectangles as a path through the mapping, in the scratch builder.
	private logicalRectPath(rects: readonly number[]): PathBuilder {
		const builder = this.scratch

		builder.clear()
		builder.setMatrix(this.matrix())

		for (let k = 0; k + 3 < rects.length && k < MAX_REGION_RECTS * 4; k += 4)
			builder.rect(rects[k] ?? 0, rects[k + 1] ?? 0, rects[k + 2] ?? 0, rects[k + 3] ?? 0)

		return builder
	}

	// A WMF region filled with a brush.
	fillLogicalRects(rects: readonly number[], brush: BrushObject): void {
		if (this.suppress || rects.length === 0) return

		const saved = this.dc.brush
		const builder = this.logicalRectPath(rects)

		this.dc.brush = brush
		this.out.path(builder, this.fill(), -1, false, this.dc.clip)
		this.dc.brush = saved
	}

	// Logical rectangles to output space (their corners; rotation is ignored for regions).
	logicalRects(rects: readonly number[]): number[] {
		const m = this.matrix()
		const out: number[] = []

		for (let k = 0; k + 3 < rects.length && out.length < MAX_REGION_RECTS * 4; k += 4) {
			const l = rects[k] ?? 0
			const t = rects[k + 1] ?? 0
			const r = rects[k + 2] ?? 0
			const b = rects[k + 3] ?? 0

			out.push(transformX(m, l, t), transformY(m, l, t), transformX(m, r, b), transformY(m, r, b))
		}

		return out
	}

	// Device rectangles to output space.
	deviceRects(rects: readonly number[]): number[] {
		const m = this.deviceToOutput
		const out: number[] = []

		for (let k = 0; k + 3 < rects.length; k += 4) {
			const l = rects[k] ?? 0
			const t = rects[k + 1] ?? 0
			const r = rects[k + 2] ?? 0
			const b = rects[k + 3] ?? 0

			out.push(transformX(m, l, t), transformY(m, l, t), transformX(m, r, b), transformY(m, r, b))
		}

		return out
	}

	// --- Text ---

	// ExtTextOut: `units` decoded, one `dx` advance (logical) per UTF-16 unit at stride `dxStride` (2 with
	// ETO_PDY), `rect` (left, top, right, bottom) for ETO_OPAQUE / ETO_CLIPPED.
	text(
		x: number,
		y: number,
		units: string,
		dx: ArrayLike<number> | null,
		dxStride: number,
		options: number,
		rect: readonly number[] | null
	): void {
		const dc = this.dc
		const font = dc.font
		const align = dc.textAlign

		if ((align & TA_UPDATECP) !== 0) {
			x = dc.curX
			y = dc.curY
		}

		if (this.suppress) return

		if ((options & ETO_OPAQUE) !== 0 && rect !== null) this.fillRect(rect[0] ?? 0, rect[1] ?? 0, rect[2] ?? 0, rect[3] ?? 0, dc.bkColor)

		const codes: number[] = []
		const offsets: number[] = []
		let advance = 0
		const extra = dc.charExtra

		for (let i = 0; i < units.length; i++) {
			let code = units.charCodeAt(i)
			let step = dx === null ? 0 : (dx[i * dxStride] ?? 0)

			if (code >= 0xd800 && code < 0xdc00 && i + 1 < units.length) {
				const low = units.charCodeAt(i + 1)

				if (low >= 0xdc00 && low < 0xe000) {
					code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
					step += dx === null ? 0 : (dx[(i + 1) * dxStride] ?? 0)
					i++
				}
			}

			const drawn = drawnCodePoint(font, code)

			// Spaces only advance when positions are known. With advances, each glyph is centred in its cell,
			// so a substitute face of other widths stays where the original drew.
			if (drawn !== 0 && !(drawn === 0x20 && dx !== null)) {
				codes.push(drawn)
				offsets.push(dx === null ? advance : advance + step / 2)
			}

			advance += step + extra
		}

		const known = dx !== null || extra !== 0
		const horizontal = align & TA_CENTER

		if ((align & TA_UPDATECP) !== 0 && known) {
			if (horizontal === TA_RIGHT) dc.curX = x - advance
			else if (horizontal !== TA_CENTER) dc.curX = x + advance
		}

		if (codes.length === 0) return

		this.textChars += codes.length

		if (this.textChars > MAX_TEXT_CHARS) throw new MetafileLimit("text")

		const m = this.matrix()
		const advanced = dc.graphicsMode === GM_ADVANCED
		// Advanced mode draws in logical units through the whole transform; compatible mode keeps glyphs
		// upright in output space, sized by the transform's vertical scale.
		const unitX = advanced ? 1 : Math.hypot(m[0] ?? 1, m[1] ?? 0)
		const unitY = advanced ? 1 : Math.hypot(m[2] ?? 0, m[3] ?? 1)
		const em = emHeight(font, 12 / Math.max(1e-6, unitY)) * unitY

		if (!(em > 0) || !Number.isFinite(em)) return

		const total = advance * unitX
		const shiftX = !known ? 0 : horizontal === TA_CENTER ? -total / 2 : horizontal === TA_RIGHT ? -total : 0
		const vertical = align & TA_BASELINE
		const shiftY = vertical === TA_BASELINE ? 0 : vertical === TA_BOTTOM ? -font.descent * em : font.ascent * em
		const angle = (font.escapement / 10) * (Math.PI / 180)
		const cos = Math.cos(angle)
		const sin = Math.sin(angle)
		let placement: number[]

		if (advanced) {
			const flip = (m[0] ?? 1) * (m[3] ?? 1) - (m[1] ?? 0) * (m[2] ?? 0) < 0 ? -1 : 1

			placement = mul(m, [cos, -sin * flip, sin, cos * flip, x, y])
		} else {
			placement = [cos, -sin, sin, cos, transformX(m, x, y), transformY(m, x, y)]
		}

		placement = mul(placement, [1, 0, 0, 1, shiftX, shiftY])

		const piece = !known && horizontal === 0 && codes.length === 1 ? pieceAdvance(codes[0] ?? 0) : 0
		const positions = known
			? Float32Array.from(offsets, offset => offset * unitX)
			: piece > 0
				? Float32Array.of((piece * em) / 2)
				: null
		const anchor =
			piece > 0
				? "middle"
				: dx !== null
					? "middle"
					: known
						? "start"
						: horizontal === TA_CENTER
							? "middle"
							: horizontal === TA_RIGHT
								? "end"
								: "start"
		const width = known ? Math.abs(total) : piece > 0 ? piece * em : codes.length * em * 0.55
		const boxX = known ? Math.min(0, total) : piece > 0 ? 0 : anchor === "middle" ? -width / 2 : anchor === "end" ? -width : 0
		const top = -font.ascent * em
		const height = (font.ascent + font.descent) * em
		let clip = dc.clip

		if ((options & ETO_CLIPPED) !== 0 && rect !== null) {
			clip = intersectClips(clip, rectClip(rect[0] ?? 0, rect[1] ?? 0, rect[2] ?? 0, rect[3] ?? 0, m, this.out.env), this.out.env)
		}

		if (dc.bkMode === BkMode.OPAQUE && (options & ETO_OPAQUE) === 0) {
			const background = this.scratch

			background.clear()
			background.setMatrix([1, 0, 0, 1, 0, 0])
			background.rect(boxX, top, boxX + width, top + height)
			this.out.placedPath(background, placement, this.out.solid(dc.bkColor), clip)
		}

		let text = ""

		for (let start = 0; start < codes.length; start += 4096) text += String.fromCodePoint(...codes.slice(start, start + 4096))

		this.out.text(
			{
				kind: "glyphs",
				run: {
					text,
					size: em * 0.75,
					bold: font.weight >= 600,
					italic: font.italic,
					underline: font.underline ? "sng" : "none",
					strike: font.strike ? "sngStrike" : "noStrike",
					color: dc.textColor,
					font: displayFace(font),
					baseline: 0,
					caps: "none",
					spacing: 0,
					lineBreak: false
				},
				positions,
				anchor
			},
			placement,
			boxX,
			top,
			width,
			height,
			clip
		)
	}

	// --- Bitmaps ---

	// A bitmap's source rectangle drawn into a logical destination rectangle; negative sizes mirror. The
	// source is in pixels from the bitmap's top-left, except with `dibOrigin` (StretchDIBits,
	// SetDIBitsToDevice), where a bottom-up bitmap counts rows from its bottom. `rop` picks the treatment.
	bitmap(
		dib: Dib,
		key: string,
		sx: number,
		sy: number,
		sw: number,
		sh: number,
		dx: number,
		dy: number,
		dw: number,
		dh: number,
		rop: number,
		transparency: DibTransparency = OPAQUE,
		alpha: number = 1,
		dibOrigin: boolean = false
	): void {
		if (this.suppress) return

		// Raster operations as compositing: AND multiplies, OR lightens, XOR differences (exact for black and
		// white, the cases masks and sprites use); inversions and the brush tint change the pixels.
		let adjust: PixelAdjust = NO_ADJUST
		let flags = 0
		let invertDestination = false

		switch (ropCode(rop)) {
			case ropCode(Rop.SRCCOPY):
				break
			case ropCode(Rop.NOTSRCCOPY):
				adjust = { invert: true, tint: undefined }
				break
			case ropCode(Rop.SRCAND):
				flags = ItemFlag.BLEND_MULTIPLY
				break
			case ropCode(Rop.SRCPAINT):
				flags = ItemFlag.BLEND_LIGHTEN
				break
			case ropCode(Rop.SRCINVERT):
				flags = ItemFlag.BLEND_DIFFERENCE
				break
			case ropCode(Rop.MERGEPAINT):
				adjust = { invert: true, tint: undefined }
				flags = ItemFlag.BLEND_LIGHTEN
				break
			case ropCode(Rop.NOTSRCERASE):
				// ~(S | D) = ~S & ~D: the destination inverted, then the inverted source multiplied in.
				adjust = { invert: true, tint: undefined }
				flags = ItemFlag.BLEND_MULTIPLY
				invertDestination = true
				break
			case ropCode(Rop.SRCERASE):
				// S & ~D: the destination inverted, then the source multiplied in.
				flags = ItemFlag.BLEND_MULTIPLY
				invertDestination = true
				break
			case ropCode(Rop.MERGECOPY):
				adjust = { invert: false, tint: this.dc.brush.style === BS_NULL ? undefined : this.dc.brush.color }
				break
			case ropCode(Rop.PATCOPY):
			case ropCode(Rop.PATINVERT):
			case ropCode(Rop.PATPAINT):
			case ropCode(Rop.DSTINVERT):
			case ropCode(Rop.BLACKNESS):
			case ropCode(Rop.WHITENESS):
			case 0xaa:
				this.patBlt(dx, dy, dw, dh, rop)

				return
			default:
				this.out.unsupported++

				return
		}

		const treatmentKey =
			transparency.kind === "key" || transparency.kind === "drop" ? `${transparency.kind}${transparency.color}` : transparency.kind
		const cacheKey = `${key}|${treatmentKey}|${adjust.invert ? 1 : 0}|${adjust.tint ?? ""}`
		let image = this.images.get(cacheKey)

		if (image === undefined) {
			const encoded = dibImage(dib, transparency, this.out, index => this.dc.palette?.[index] ?? BLACK, adjust)

			image = encoded === undefined ? -1 : this.out.embed(encoded)
			this.images.set(cacheKey, image)

			if (encoded === undefined) this.out.unsupported++
		}

		if (image < 0) return

		const width = dib.width
		const height = dib.height
		const sx0 = Math.min(sx, sx + sw)
		const sy0 = Math.min(sy, sy + sh)
		const sx1 = Math.max(sx, sx + sw)
		const sy1 = Math.max(sy, sy + sh)
		const fromBottom = dibOrigin && !dib.topDown
		// A degenerate source rectangle draws the whole bitmap.
		const crop =
			sx1 > sx0 && sy1 > sy0
				? {
						left: sx0 / width,
						top: (fromBottom ? height - sy1 : sy0) / height,
						right: (width - sx1) / width,
						bottom: (fromBottom ? sy0 : height - sy1) / height
					}
				: { left: 0, top: 0, right: 0, bottom: 0 }
		const entry = this.out.recrop(image, crop, Math.min(1, Math.max(0, alpha)))
		const flipX = dw < 0 !== sw < 0 ? -1 : 1
		const flipY = dh < 0 !== sh < 0 ? -1 : 1
		const w = Math.abs(dw)
		const h = Math.abs(dh)
		// The destination's top-left corner after mirroring.
		const ox = dw < 0 ? dx + dw : dx
		const oy = dh < 0 ? dy + dh : dy
		const matrix = mul(this.matrix(), [flipX, 0, 0, flipY, flipX < 0 ? ox + w : ox, flipY < 0 ? oy + h : oy])

		if (invertDestination) this.fillRect(dx, dy, dx + dw, dy + dh, WHITE, ItemFlag.BLEND_DIFFERENCE)

		this.out.image(entry, matrix, w, h, this.dc.clip, flags)
	}
}
