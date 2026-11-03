import {
	ITEM_FILL_MODIFIER_MASK,
	ITEM_FLOATS,
	ITEM_INTS,
	ItemFlag,
	ItemFloat,
	ItemInt,
	ItemKind,
	PATH_COMMAND_COORDS,
	PathCommand,
	averageShade,
	shadeBounds,
	type DrawingClip,
	type DrawingImage,
	type DrawingText,
	type GradientStops,
	type ImageTile,
	type Inset,
	type Paint,
	type Rgba,
	type Shadow,
	type TextParagraph,
	type TextRun
} from "../../../core/drawingml/index"
import { pathGradientCircle } from "../../../core/drawingml/displayList"
import { lumTransfer } from "../../../core/drawingml/lum"
import { layoutBlock } from "../../../core/drawingml/textBlock"
import type { DrawingData } from "../../../dom/docx/protocol"

// Paints a drawing's display list as one SVG element. The data crossed a thread boundary, so every number is
// checked before it is formatted into an attribute and every enum is mapped through a switch onto this
// module's own strings; the only document text that reaches the DOM is run text, through textContent.

export interface DrawingPaintContext {
	readonly document: Document
	// A safe id token, unique per painted drawing on the page.
	readonly idPrefix: string
	// A blob: URL of the image's loaded media, or undefined when it cannot be shown.
	imageUrl(image: DrawingImage): string | undefined
	// Gives `image` the raster of a shaded paint for the resolution it is drawn at (`localScale`: drawing
	// units per local unit of the paint), now and when the zoom changes; the paint draws its mean colour
	// without it.
	shade?(image: SVGImageElement, paint: Extract<Paint, { kind: "shaded" }>, localScale: number): void
	// The advance width (px) of `text` in a CSS font shorthand, for text the renderer wraps; estimated
	// without it.
	measureText?(text: string, font: string): number
}

// A font family list the engine resolved for a text (an internal alias and a generic family).
const FONT_FAMILY = /^(?:"[A-Za-z0-9_-]{1,128}", )?(?:serif|sans-serif|monospace)$/

const SVG_NS = "http://www.w3.org/2000/svg"
const XML_NS = "http://www.w3.org/XML/1998/namespace"
const MAX_ITEMS = 200_000
const MAX_COORD = 2 ** 31
const MAX_STOPS = 64
const MAX_DASHES = 32
const MAX_RUNS = 50_000
const MAX_CLIPS = 100_000
const MAX_CLIP_CHAIN = 1024
const MAX_CLIP_SHAPES = 4096
// Clip groups made over one drawing (items and mask contents).
const MAX_CLIP_ELEMENTS = 200_000
const EMPTY_CHAIN: readonly number[] = []
// Characters of positioned text, and of the coordinate list positioning it.
const MAX_GLYPHS = 20_000
const PX_PER_PT = 96 / 72

type PaintSlot = "fill" | "stroke"

// Finite, clamped, three decimals: short attribute strings that can never read NaN or Infinity.
function fmt(value: number): string {
	const v = Number.isFinite(value) ? (value > MAX_COORD ? MAX_COORD : value < -MAX_COORD ? -MAX_COORD : value) : 0
	const rounded = Math.round(v * 1000) / 1000

	return rounded === 0 ? "0" : String(rounded)
}

function finite(value: number, fallback: number): number {
	return Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number, fallback: number = min): number {
	return Number.isFinite(value) ? (value < min ? min : value > max ? max : value) : fallback
}

function index(value: number | undefined): number {
	return value !== undefined && Number.isInteger(value) && value >= 0 ? value : -1
}

function rgbaOf(value: Rgba): number {
	return Number.isFinite(value) ? value >>> 0 : 0
}

function hex(color: number): string {
	return `#${((color >>> 8) & 0xffffff).toString(16).padStart(6, "0")}`
}

function alphaOf(color: number): number {
	return (color & 255) / 255
}

function rgbaFrom(r: number, g: number, b: number, a: number): number {
	const channel = (v: number): number => clamp(Math.round(v), 0, 255)

	return ((channel(r) << 24) | (channel(g) << 16) | (channel(b) << 8) | channel(a)) >>> 0
}

function mix(c1: number, c2: number, t: number): number {
	const u = 1 - t

	return rgbaFrom(
		((c1 >>> 24) & 255) * u + ((c2 >>> 24) & 255) * t,
		((c1 >>> 16) & 255) * u + ((c2 >>> 16) & 255) * t,
		((c1 >>> 8) & 255) * u + ((c2 >>> 8) & 255) * t,
		(c1 & 255) * u + (c2 & 255) * t
	)
}

// ST_PathFillMode, approximated as a blend toward white or black.
function modify(color: number, modifier: number): number {
	switch (modifier) {
		case ItemFlag.LIGHTEN:
			return mix(color, 0xffffff00 | (color & 255), 0.4)
		case ItemFlag.LIGHTEN_LESS:
			return mix(color, 0xffffff00 | (color & 255), 0.2)
		case ItemFlag.DARKEN:
			return mix(color, color & 255, 0.4)
		case ItemFlag.DARKEN_LESS:
			return mix(color, color & 255, 0.2)
		default:
			return color
	}
}

function stopCount(stops: GradientStops): number {
	return Math.min(stops.offsets.length, stops.colors.length, MAX_STOPS)
}

function averageColor(stops: GradientStops): number {
	const count = stopCount(stops)
	let r = 0
	let g = 0
	let b = 0
	let a = 0

	for (let k = 0; k < count; k++) {
		const color = rgbaOf(stops.colors[k] ?? 0)

		r += (color >>> 24) & 255
		g += (color >>> 16) & 255
		b += (color >>> 8) & 255
		a += color & 255
	}

	return count === 0 ? 0 : rgbaFrom(r / count, g / count, b / count, a / count)
}

// Dash, gap lengths in multiples of the line width (ST_PresetLineDashVal).
function presetDashes(dash: string): readonly number[] | undefined {
	switch (dash) {
		case "dot":
			return [1, 3]
		case "dash":
			return [4, 3]
		case "lgDash":
			return [8, 3]
		case "dashDot":
			return [4, 3, 1, 3]
		case "lgDashDot":
			return [8, 3, 1, 3]
		case "lgDashDotDot":
			return [8, 3, 1, 3, 1, 3]
		case "sysDash":
			return [3, 1]
		case "sysDot":
			return [1, 1]
		case "sysDashDot":
			return [3, 1, 1, 1]
		case "sysDashDotDot":
			return [3, 1, 1, 1, 1, 1]
		default:
			return undefined
	}
}

function dashArray(dashes: ArrayLike<number>, width: number): string {
	const count = Math.min(dashes.length, MAX_DASHES)
	let out = ""
	let total = 0

	for (let k = 0; k < count; k++) {
		const length = clamp(dashes[k] ?? 0, 0, 1000, 0) * width

		total += length
		out += k === 0 ? fmt(length) : ` ${fmt(length)}`
	}

	return total > 0 ? out : ""
}

const BAYER = [
	0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11,
	43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21
]

function percent(value: number): (x: number, y: number) => boolean {
	const threshold = Math.round((value / 100) * 64)

	return (x, y) => (BAYER[y * 8 + x] ?? 64) < threshold
}

const mod = (value: number, by: number): number => ((value % by) + by) % by

const SMALL_CONFETTI = [0x80, 0x10, 0x02, 0x40, 0x04, 0x20, 0x01, 0x08]
const LARGE_CONFETTI = [0xc1, 0x0c, 0x30, 0xc3, 0x18, 0x60, 0x86, 0x03]

function confetti(rows: readonly number[], x: number, y: number): boolean {
	return (((rows[y] ?? 0) >> (7 - x)) & 1) === 1
}

// 8x8 foreground masks of the preset patterns; the rest blend foreground and background.
const PATTERNS = new Map<string, (x: number, y: number) => boolean>([
	["pct5", percent(5)],
	["pct10", percent(10)],
	["pct20", percent(20)],
	["pct25", percent(25)],
	["pct30", percent(30)],
	["pct40", percent(40)],
	["pct50", percent(50)],
	["pct60", percent(60)],
	["pct70", percent(70)],
	["pct75", percent(75)],
	["pct80", percent(80)],
	["pct90", percent(90)],
	["ltHorz", (_x, y) => y === 0],
	["horz", (_x, y) => y % 4 === 0],
	["narHorz", (_x, y) => y % 2 === 0],
	["dkHorz", (_x, y) => y % 4 < 2],
	["ltVert", x => x === 0],
	["vert", x => x % 4 === 0],
	["narVert", x => x % 2 === 0],
	["dkVert", x => x % 4 < 2],
	["dashHorz", (x, y) => (y === 0 && x < 4) || (y === 4 && x >= 4)],
	["dashVert", (x, y) => (x === 0 && y < 4) || (x === 4 && y >= 4)],
	["ltDnDiag", (x, y) => mod(x - y, 8) === 0],
	["dnDiag", (x, y) => mod(x - y, 4) === 0],
	["dkDnDiag", (x, y) => mod(x - y, 4) < 2],
	["wdDnDiag", (x, y) => mod(x - y, 8) < 3],
	["dashDnDiag", (x, y) => mod(x - y, 4) === 0 && y % 4 < 2],
	["ltUpDiag", (x, y) => mod(x + y, 8) === 7],
	["upDiag", (x, y) => mod(x + y, 4) === 3],
	["dkUpDiag", (x, y) => mod(x + y, 4) >= 2],
	["wdUpDiag", (x, y) => mod(x + y, 8) >= 5],
	["dashUpDiag", (x, y) => mod(x + y, 4) === 3 && y % 4 < 2],
	["cross", (x, y) => x === 0 || y === 0],
	["lgGrid", (x, y) => x === 0 || y === 0],
	["smGrid", (x, y) => x % 4 === 0 || y % 4 === 0],
	["dotGrid", (x, y) => (y === 0 && x % 2 === 0) || (x === 0 && y % 2 === 0)],
	["diagCross", (x, y) => mod(x - y, 4) === 0 || mod(x + y, 4) === 3],
	["smCheck", (x, y) => ((x >> 1) + (y >> 1)) % 2 === 0],
	["lgCheck", (x, y) => ((x >> 2) + (y >> 2)) % 2 === 0],
	["horzBrick", (x, y) => y % 4 === 0 || (y < 4 ? x === 0 : x === 4)],
	["diagBrick", (x, y) => mod(x + y, 8) === 7 || (y > 3 && mod(x - y, 8) === 4)],
	["solidDmnd", (x, y) => Math.abs(x - 3.5) + Math.abs(y - 3.5) <= 3],
	["openDmnd", (x, y) => Math.abs(x - 3.5) + Math.abs(y - 3.5) === 3],
	["dotDmnd", (x, y) => (x + y) % 2 === 0 && Math.abs(x - 3.5) + Math.abs(y - 3.5) === 3],
	["zigZag", (x, y) => y % 4 === Math.abs((x % 4) - 2) || y % 4 === Math.abs((x % 4) - 2) + 1],
	["trellis", (x, y) => (y % 2 === 0 ? x % 4 !== 3 : x % 4 === 1)],
	["smConfetti", (x, y) => confetti(SMALL_CONFETTI, x, y)],
	["lgConfetti", (x, y) => confetti(LARGE_CONFETTI, x, y)]
])

// The foreground of a preset as path data in an 8x8 tile, built once per preset.
const patternPaths = new Map<string, string>()

function patternPath(preset: string): string | undefined {
	const cached = patternPaths.get(preset)

	if (cached !== undefined) return cached

	const mask = PATTERNS.get(preset)

	if (mask === undefined) return undefined

	let d = ""

	for (let y = 0; y < 8; y++) {
		let x = 0

		while (x < 8) {
			if (!mask(x, y)) {
				x++
				continue
			}

			const start = x

			while (x < 8 && mask(x, y)) x++

			d += `M${start} ${y}h${x - start}v1h${start - x}z`
		}
	}

	patternPaths.set(preset, d)

	return d
}

function genericFamily(font: string): string {
	const name = typeof font === "string" ? font.toLowerCase() : ""

	if (name.includes("mono") || name.includes("courier") || name.includes("consol")) return "monospace"
	if (name.includes("sans")) return "sans-serif"
	if (
		name.includes("times") ||
		name.includes("cambria") ||
		name.includes("georgia") ||
		name.includes("garamond") ||
		name.includes("serif")
	) {
		return "serif"
	}

	return "sans-serif"
}

function textAnchor(align: string): "start" | "middle" | "end" {
	switch (align) {
		case "ctr":
			return "middle"
		case "r":
			return "end"
		default:
			return "start"
	}
}

function verticalRotation(vertical: string): number {
	switch (vertical) {
		case "vert":
		case "eaVert":
		case "wordArtVert":
		case "mongolianVert":
			return 90
		case "vert270":
		case "wordArtVertRtl":
			return 270
		default:
			return 0
	}
}

function insetOf(inset: Inset | undefined, min: number, max: number): [number, number, number, number] {
	if (inset === undefined || inset === null) return [0, 0, 0, 0]

	return [
		clamp(inset.left, min, max, 0),
		clamp(inset.top, min, max, 0),
		clamp(inset.right, min, max, 0),
		clamp(inset.bottom, min, max, 0)
	]
}

interface Line {
	readonly paragraph: TextParagraph
	readonly from: number
	readonly to: number
	readonly first: boolean
	readonly size: number
	readonly height: number
	before: number
	after: number
}

function runPx(run: TextRun, scale: number): number {
	const px = clamp(run.size, 1, 1000, 11) * PX_PER_PT * scale

	return finite(run.baseline, 0) !== 0 ? (px * 2) / 3 : px
}

class Painter {
	readonly root: SVGSVGElement
	private defsElement: SVGDefsElement | undefined = undefined
	private counter = 0
	private readonly paintIds = new Map<string, string>()
	private readonly shadowIds = new Map<string, string>()
	private readonly filterIds = new Map<number, string>()
	private readonly urls = new Map<number, string | undefined>()
	private readonly clipIds = new Map<number, string | undefined>()
	private readonly chains = new Map<number, readonly number[] | undefined>()
	private clipElementsLeft = MAX_CLIP_ELEMENTS
	private runsLeft = MAX_RUNS
	// The opacity of the last paint value resolved.
	private opacity = 1
	private readonly data: DrawingData
	private readonly context: DrawingPaintContext

	constructor(data: DrawingData, context: DrawingPaintContext) {
		this.data = data
		this.context = context
		this.root = this.el("svg")
	}

	private el<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
		return this.context.document.createElementNS(SVG_NS, tag)
	}

	private id(kind: string): string {
		return `${this.context.idPrefix}-${kind}${this.counter++}`
	}

	private defs(): SVGDefsElement {
		if (this.defsElement === undefined) {
			this.defsElement = this.el("defs")
			this.root.insertBefore(this.defsElement, this.root.firstChild)
		}

		return this.defsElement
	}

	paint(): void {
		const data = this.data
		const root = this.root
		const width = clamp(data.width, 0, MAX_COORD, 0)
		const height = clamp(data.height, 0, MAX_COORD, 0)

		if (width > 0 && height > 0) root.setAttribute("viewBox", `0 0 ${fmt(width)} ${fmt(height)}`)

		root.setAttribute("preserveAspectRatio", "none")
		root.setAttribute("overflow", "visible")
		root.setAttribute("width", "100%")
		root.setAttribute("height", "100%")
		root.setAttribute("aria-hidden", "true")
		// Blended items (metafile raster operations) composite with the picture drawn so far, never the page.
		root.style.setProperty("isolation", "isolate")

		// The surface the drawing starts on (white under a metafile's raster operations).
		const background = typeof data.background === "number" ? rgbaOf(data.background) : undefined

		if (background !== undefined && width > 0 && height > 0) {
			const surface = this.el("rect")

			surface.setAttribute("width", fmt(width))
			surface.setAttribute("height", fmt(height))
			setColor(surface, "fill", background)
			root.appendChild(surface)
		}

		const floats = data.itemFloats
		const ints = data.itemInts
		const count = Math.min(
			index(data.itemCount) < 0 ? 0 : data.itemCount,
			MAX_ITEMS,
			Math.floor(floats.length / ITEM_FLOATS),
			Math.floor(ints.length / ITEM_INTS)
		)

		const itemClips = data.itemClips instanceof Int32Array ? data.itemClips : null
		// The open clip groups, outermost first: consecutive items share the groups of their common clips.
		const open: { clip: number; group: Element }[] = []

		for (let item = 0; item < count; item++) {
			const i = item * ITEM_INTS
			const flags = ints[i + ItemInt.FLAGS] ?? 0

			if ((flags & ItemFlag.HIDDEN) !== 0) continue

			const f = item * ITEM_FLOATS
			let element: SVGElement | undefined

			switch (ints[i + ItemInt.KIND]) {
				case ItemKind.PATH:
					element = this.pathItem(i, f, flags)
					break
				case ItemKind.IMAGE:
					element = this.imageItem(i, f)
					break
				case ItemKind.TEXT:
					element = this.textItem(i, f)
					break
				default:
					break
			}

			if (element === undefined) continue

			const chain = this.clipChain(itemClips === null ? -1 : index(itemClips[item]))

			// A malformed clip hides the item rather than showing what it would have clipped away.
			if (chain === undefined) continue

			const blend = blendMode(flags)
			const shadow = this.shadow(index(ints[i + ItemInt.SHADOW]))
			let content: SVGElement = element

			if (shadow !== undefined) {
				// Wrapped so the offset applies in drawing space, not scaled or rotated by the item's matrix.
				content = this.el("g")
				content.setAttribute("filter", `url(#${shadow})`)
				content.appendChild(element)
			}

			if (blend !== undefined) {
				// A blended item gets its own clip groups as a child of the root, blending from the outermost:
				// a blend inside a clip or mask group would composite against that group alone.
				open.length = 0

				let outer: SVGElement = content
				let wrapped = 0

				for (let k = chain.length - 1; k >= 0; k--) {
					const group = this.clipGroup(chain[k] ?? -1)

					if (group === undefined) break

					group.appendChild(outer)
					outer = group
					wrapped++
				}

				if (wrapped !== chain.length) continue

				outer.style.setProperty("mix-blend-mode", blend)
				root.appendChild(outer)
				continue
			}

			let shared = 0

			while (shared < open.length && shared < chain.length && open[shared]?.clip === chain[shared]) shared++

			open.length = shared

			for (let k = shared; k < chain.length; k++) {
				const clip = chain[k] ?? -1
				const group = this.clipGroup(clip)

				if (group === undefined) break

				;(open[k - 1]?.group ?? root).appendChild(group)
				open.push({ clip, group })
			}

			if (open.length !== chain.length) {
				open.length = 0
				continue
			}

			;(open[open.length - 1]?.group ?? root).appendChild(content)
		}
	}

	private clips(): readonly DrawingClip[] {
		return Array.isArray(this.data.clips) ? this.data.clips : []
	}

	// A clip and its parents, outermost first; [] for none, undefined when malformed.
	private clipChain(clipIndex: number): readonly number[] | undefined {
		if (clipIndex < 0) return EMPTY_CHAIN

		const cached = this.chains.get(clipIndex)

		if (cached !== undefined || this.chains.has(clipIndex)) return cached

		const clips = this.clips()
		const chain: number[] = []

		for (let at = clipIndex; at >= 0;) {
			const clip = clips[at]

			if (clip === undefined || clip === null || at >= MAX_CLIPS || chain.length >= MAX_CLIP_CHAIN) {
				this.chains.set(clipIndex, undefined)

				return undefined
			}

			chain.push(at)

			const parent = index(clip.parent)

			// Parents precede their children; anything else ends the chain.
			at = parent < at ? parent : -1
		}

		chain.reverse()
		this.chains.set(clipIndex, chain)

		return chain
	}

	// A fresh group applying one clip level: a clip path for shapes, a mask for a boolean region, with the
	// clip's group opacity. Undefined when the clip is malformed or the budget is spent.
	private clipGroup(clipIndex: number): SVGGElement | undefined {
		const clip = this.clips()[clipIndex]

		if (clip === undefined || clip === null || this.clipElementsLeft-- <= 0) return undefined

		const group = this.el("g")
		const isBoolean = Array.isArray(clip.add)
		const id = isBoolean ? this.clipMask(clipIndex) : this.clipPath(clipIndex)

		if (id === undefined) return undefined

		group.setAttribute(isBoolean ? "mask" : "clip-path", `url(#${id})`)

		const opacity = clamp(clip.opacity ?? 1, 0, 1, 1)

		if (opacity < 1) group.setAttribute("opacity", fmt(opacity))

		return group
	}

	// A <clipPath> uniting a clip's shapes, each with its own placement and fill rule (no shapes: hides all).
	private clipPath(clipIndex: number): string | undefined {
		const done = this.clipIds.get(clipIndex)

		if (done !== undefined || this.clipIds.has(clipIndex)) return done

		const clip = this.clips()[clipIndex]

		if (clip === undefined || clip === null) return undefined

		const id = this.id("k")
		const element = this.el("clipPath")
		const shapes = [clip, ...(Array.isArray(clip.shapes) ? clip.shapes.slice(0, MAX_CLIP_SHAPES) : [])]

		element.setAttribute("id", id)
		element.setAttribute("clipPathUnits", "userSpaceOnUse")

		for (const shape of shapes) {
			if (shape === undefined || shape === null) continue

			const d = this.pathRange(index(shape.firstCommand), index(shape.commandCount), index(shape.firstCoord))

			if (d === "") continue

			const path = this.el("path")
			const transform = this.matrixAttribute(Array.isArray(shape.matrix) ? shape.matrix : [])

			path.setAttribute("d", d)

			if (transform !== "") path.setAttribute("transform", transform)
			if (shape.evenOdd === true) path.setAttribute("clip-rule", "evenodd")

			element.appendChild(path)
		}

		this.defs().appendChild(element)
		this.clipIds.set(clipIndex, id)

		return id
	}

	// A <mask> showing the union of the `add` clips' areas minus the `subtract` clips' areas.
	private clipMask(clipIndex: number): string | undefined {
		const done = this.clipIds.get(clipIndex)

		if (done !== undefined || this.clipIds.has(clipIndex)) return done

		const clip = this.clips()[clipIndex]

		if (clip === undefined || clip === null || !Array.isArray(clip.add)) return undefined

		// Members are earlier clips; marking this one first keeps a malformed cycle from recursing.
		this.clipIds.set(clipIndex, undefined)

		const id = this.id("m")
		const mask = this.el("mask")
		const [x, y, width, height] = this.plane()

		mask.setAttribute("id", id)
		mask.setAttribute("maskUnits", "userSpaceOnUse")
		mask.setAttribute("maskContentUnits", "userSpaceOnUse")
		mask.setAttribute("x", fmt(x))
		mask.setAttribute("y", fmt(y))
		mask.setAttribute("width", fmt(width))
		mask.setAttribute("height", fmt(height))

		const members: [readonly unknown[], string][] = [
			[clip.add.slice(0, MAX_CLIP_SHAPES), "#fff"],
			[Array.isArray(clip.subtract) ? clip.subtract.slice(0, MAX_CLIP_SHAPES) : [], "#000"]
		]

		for (const [list, color] of members) {
			for (const member of list) {
				const memberIndex = typeof member === "number" ? index(member) : -1

				if (memberIndex < 0 || memberIndex >= clipIndex) continue

				const area = this.clipArea(memberIndex, color)

				if (area !== undefined) mask.appendChild(area)
			}
		}

		this.defs().appendChild(mask)
		this.clipIds.set(clipIndex, id)

		return id
	}

	// The area of a clip painted in `color`: a plane-sized rectangle inside the clip's groups.
	private clipArea(clipIndex: number, color: string): SVGElement | undefined {
		const chain = this.clipChain(clipIndex)

		if (chain === undefined) return undefined

		const [x, y, width, height] = this.plane()
		const rect = this.el("rect")

		rect.setAttribute("x", fmt(x))
		rect.setAttribute("y", fmt(y))
		rect.setAttribute("width", fmt(width))
		rect.setAttribute("height", fmt(height))
		rect.setAttribute("fill", color)

		let inner: SVGElement = rect

		for (let k = chain.length - 1; k >= 0; k--) {
			const group = this.clipGroup(chain[k] ?? -1)

			if (group === undefined) return undefined

			// Opacity belongs to drawing, not to the area a region covers.
			group.removeAttribute("opacity")
			group.appendChild(inner)
			inner = group
		}

		return inner
	}

	// A rectangle far beyond the drawing, standing for the whole plane in masks.
	private plane(): [number, number, number, number] {
		const size = Math.max(clamp(this.data.width, 0, MAX_COORD, 0), clamp(this.data.height, 0, MAX_COORD, 0), 1) * 64

		return [-size, -size, size * 2, size * 2]
	}

	private matrixAttribute(m: ArrayLike<number>): string {
		const a = finite(m[0] ?? 1, 1)
		const b = finite(m[1] ?? 0, 0)
		const c = finite(m[2] ?? 0, 0)
		const d = finite(m[3] ?? 1, 1)
		const e = finite(m[4] ?? 0, 0)
		const f = finite(m[5] ?? 0, 0)

		if (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0) return ""

		return `matrix(${fmt(a)} ${fmt(b)} ${fmt(c)} ${fmt(d)} ${fmt(e)} ${fmt(f)})`
	}

	private transform(f: number): string {
		return this.matrixAttribute(this.data.itemFloats.subarray(f, f + 6))
	}

	private box(f: number): [number, number, number, number] {
		const m = this.data.itemFloats

		return [
			clamp(m[f + ItemFloat.X] ?? 0, -MAX_COORD, MAX_COORD, 0),
			clamp(m[f + ItemFloat.Y] ?? 0, -MAX_COORD, MAX_COORD, 0),
			clamp(m[f + ItemFloat.WIDTH] ?? 0, 0, MAX_COORD, 0),
			clamp(m[f + ItemFloat.HEIGHT] ?? 0, 0, MAX_COORD, 0)
		]
	}

	private pathData(i: number): string {
		const ints = this.data.itemInts

		return this.pathRange(
			index(ints[i + ItemInt.FIRST_COMMAND]),
			index(ints[i + ItemInt.COMMAND_COUNT]),
			index(ints[i + ItemInt.FIRST_COORD])
		)
	}

	private pathRange(first: number, count: number, firstCoord: number): string {
		const commands = this.data.commands
		const coords = this.data.coords
		let at = firstCoord

		if (first < 0 || count <= 0 || at < 0) return ""

		const end = Math.min(commands.length, first + count)
		let d = ""

		for (let k = first; k < end; k++) {
			const command = commands[k] ?? -1
			const needed = PATH_COMMAND_COORDS[command] ?? -1

			if (needed < 0 || at + needed > coords.length) break

			switch (command) {
				case PathCommand.MOVE:
					d += `M${fmt(coords[at] ?? 0)} ${fmt(coords[at + 1] ?? 0)}`
					break
				case PathCommand.LINE:
					d += `L${fmt(coords[at] ?? 0)} ${fmt(coords[at + 1] ?? 0)}`
					break
				case PathCommand.CUBIC:
					d += `C${fmt(coords[at] ?? 0)} ${fmt(coords[at + 1] ?? 0)} ${fmt(coords[at + 2] ?? 0)} ${fmt(coords[at + 3] ?? 0)} ${fmt(coords[at + 4] ?? 0)} ${fmt(coords[at + 5] ?? 0)}`
					break
				case PathCommand.QUAD:
					d += `Q${fmt(coords[at] ?? 0)} ${fmt(coords[at + 1] ?? 0)} ${fmt(coords[at + 2] ?? 0)} ${fmt(coords[at + 3] ?? 0)}`
					break
				default:
					d += "Z"
					break
			}

			at += needed
		}

		return d
	}

	// What a clamped tile or a shaded paint draws: one image in the item's local space (placed by the tile's
	// matrix), clipped by the item's own outline: crisp at any scale, unlike a pattern cell spanning the plane.
	// A shaded paint's raster comes from the context at the resolution it is drawn at (`localScale`: drawing
	// units per local unit). Undefined when the paint is neither, or cannot be drawn so.
	private imageFill(paintIndex: number, localScale: number): { content: SVGElement; placement: string } | undefined {
		const paint: Paint | undefined = this.data.paints[paintIndex]

		if (paint === undefined || paint === null) return undefined

		if (paint.kind === "shaded") {
			const bounds =
				paint.points instanceof Float32Array && paint.colors instanceof Uint32Array ? shadeBounds(paint.points) : undefined

			if (bounds === undefined || this.context.shade === undefined) return undefined

			const image = this.el("image")

			image.setAttribute("x", fmt(bounds[0]))
			image.setAttribute("y", fmt(bounds[1]))
			image.setAttribute("width", fmt(bounds[2]))
			image.setAttribute("height", fmt(bounds[3]))
			image.setAttribute("preserveAspectRatio", "none")
			this.context.shade(image, paint, finite(localScale, 1))

			return { content: image, placement: "" }
		}

		const tile = paint.kind === "image" ? paint.tile : undefined

		if (paint.kind !== "image" || tile === undefined || tile === null || tile.clamp !== true || tile.width === undefined)
			return undefined

		const width = clamp(tile.width, 0, MAX_COORD, 0)
		const height = clamp(tile.height ?? 0, 0, MAX_COORD, 0)
		const content = width > 0 && height > 0 ? this.imageContent(index(paint.image), 0, 0, width, height) : undefined

		return content === undefined
			? undefined
			: { content, placement: this.matrixAttribute(Array.isArray(tile.matrix) ? tile.matrix : []) }
	}

	// `fill` drawn inside `shape` (a path or text, with its own transform) as its clip; `transform` is the
	// shape's local space.
	private clippedFill(shape: SVGElement, transform: string, fill: { content: SVGElement; placement: string }): SVGGElement {
		const id = this.id("c")
		const clipPath = this.el("clipPath")
		const group = this.el("g")
		const inner = this.el("g")

		clipPath.setAttribute("id", id)
		clipPath.setAttribute("clipPathUnits", "userSpaceOnUse")
		clipPath.appendChild(shape)
		this.defs().appendChild(clipPath)
		group.setAttribute("clip-path", `url(#${id})`)

		const local = [transform, fill.placement].filter(part => part !== "").join(" ")

		if (local !== "") inner.setAttribute("transform", local)

		inner.appendChild(fill.content)
		group.appendChild(inner)

		return group
	}

	// The scale of an item's matrix (drawing units per local unit).
	private localScale(f: number): number {
		const m = this.data.itemFloats

		return Math.sqrt(Math.abs((m[f] ?? 1) * (m[f + 3] ?? 1) - (m[f + 1] ?? 0) * (m[f + 2] ?? 0)))
	}

	private pathItem(i: number, f: number, flags: number): SVGElement | undefined {
		const d = this.pathData(i)

		if (d === "") return undefined

		const ints = this.data.itemInts
		const path = this.el("path")
		const transform = this.transform(f)
		const [, , width, height] = this.box(f)
		const image = this.imageFill(index(ints[i + ItemInt.FILL]), this.localScale(f))

		if (image !== undefined) {
			const shape = this.el("path")

			shape.setAttribute("d", d)

			if (transform !== "") shape.setAttribute("transform", transform)
			if ((flags & ItemFlag.EVEN_ODD) !== 0) shape.setAttribute("clip-rule", "evenodd")

			const clipped = this.clippedFill(shape, transform, image)
			const stroke = index(ints[i + ItemInt.STROKE])

			if (stroke < 0) return clipped

			// The outline stays outside the fill's clip.
			const both = this.el("g")

			path.setAttribute("d", d)

			if (transform !== "") path.setAttribute("transform", transform)

			path.setAttribute("fill", "none")
			this.applyStroke(path, stroke, width, height)
			both.appendChild(clipped)
			both.appendChild(path)

			return both
		}

		path.setAttribute("d", d)

		if (transform !== "") path.setAttribute("transform", transform)

		this.applyPaint(path, "fill", index(ints[i + ItemInt.FILL]), width, height, flags & ITEM_FILL_MODIFIER_MASK)

		if ((flags & ItemFlag.EVEN_ODD) !== 0) path.setAttribute("fill-rule", "evenodd")

		this.applyStroke(path, index(ints[i + ItemInt.STROKE]), width, height)

		return path
	}

	private applyPaint(element: SVGElement, slot: PaintSlot, paintIndex: number, width: number, height: number, modifier: number): boolean {
		const value = paintIndex < 0 ? "none" : this.paintValue(paintIndex, width, height, modifier)

		if (value === "") {
			placeholderStyle(element, slot === "fill")

			return true
		}

		// Unpainted strokes are SVG's default.
		if (value === "none" && slot === "stroke") return false

		element.setAttribute(slot, value)

		if (value !== "none" && this.opacity < 1) element.setAttribute(`${slot}-opacity`, fmt(this.opacity))

		return value !== "none"
	}

	private applyStroke(element: SVGElement, strokeIndex: number, width: number, height: number): void {
		const stroke = strokeIndex < 0 ? undefined : this.data.strokes[strokeIndex]

		if (stroke === undefined || !this.applyPaint(element, "stroke", index(stroke.paint), width, height, 0)) return

		const strokeWidth = clamp(stroke.width, 0, 10_000, 1) || 1

		if (strokeWidth !== 1) element.setAttribute("stroke-width", fmt(strokeWidth))

		switch (stroke.cap) {
			case "round":
				element.setAttribute("stroke-linecap", "round")
				break
			case "square":
				element.setAttribute("stroke-linecap", "square")
				break
			default:
				break
		}

		switch (stroke.join) {
			case "round":
				element.setAttribute("stroke-linejoin", "round")
				break
			case "bevel":
				element.setAttribute("stroke-linejoin", "bevel")
				break
			default:
				element.setAttribute("stroke-miterlimit", fmt(clamp(stroke.miterLimit, 1, 100, 8)))
				break
		}

		const custom = stroke.customDash
		const dashes = custom !== null && custom !== undefined && custom.length > 0 ? custom : presetDashes(stroke.dash)

		if (dashes !== undefined) {
			const array = dashArray(dashes, strokeWidth)

			if (array !== "") element.setAttribute("stroke-dasharray", array)
		}
	}

	// A fill or stroke value: "none", a colour (opacity in this.opacity), url(#id) of a def, or "" for an
	// image that cannot be shown.
	private paintValue(paintIndex: number, width: number, height: number, modifier: number): string {
		const paint: Paint | undefined = this.data.paints[paintIndex]

		this.opacity = 1

		if (paint === undefined || paint === null) return "none"

		// Bounding-box defs vanish on a flat box (a straight line): show their average colour instead.
		const flat = !(width > 0 && height > 0)

		switch (paint.kind) {
			case "solid":
				return this.color(modify(rgbaOf(paint.color), modifier))
			case "linear":
				if (flat || stopCount(paint.stops) === 0) return this.color(averageColor(paint.stops))

				return this.linear(paintIndex, paint, width, height)
			case "path":
				if (flat || stopCount(paint.stops) === 0) return this.color(averageColor(paint.stops))

				return this.radial(paintIndex, paint, width, height)
			case "pattern":
				if (flat) return this.color(mix(rgbaOf(paint.foreground), rgbaOf(paint.background), 0.5))

				return this.pattern(paintIndex, paint)
			case "image":
				return paint.tile !== undefined && paint.tile !== null && paint.tile.width !== undefined
					? this.tilePaint(paintIndex, paint, paint.tile)
					: this.imagePaint(paintIndex, paint)
			case "gradient":
				if (stopCount(paint.stops) === 0) return "none"

				return this.gradient(paintIndex, paint)
			case "shaded":
				// Where it cannot be drawn as an image (an outline, no rasteriser): its mean colour.
				return paint.colors instanceof Uint32Array ? this.color(averageShade(paint.colors)) : "none"
			default:
				return "none"
		}
	}

	// A gradient in user space (the item's local coordinates).
	private gradient(paintIndex: number, paint: Extract<Paint, { kind: "gradient" }>): string {
		const key = `g${paintIndex}`
		const cached = this.paintIds.get(key)

		if (cached !== undefined) return `url(#${cached})`

		const id = this.id("g")
		const radial = paint.type === "radial"
		const gradient = radial ? this.el("radialGradient") : this.el("linearGradient")
		const transform = this.matrixAttribute(Array.isArray(paint.matrix) ? paint.matrix : [])

		gradient.setAttribute("id", id)
		gradient.setAttribute("gradientUnits", "userSpaceOnUse")

		if (transform !== "") gradient.setAttribute("gradientTransform", transform)

		if (radial) {
			const focus = Array.isArray(paint.focus) ? paint.focus : [0, 0]

			gradient.setAttribute("cx", "0")
			gradient.setAttribute("cy", "0")
			gradient.setAttribute("r", "1")
			gradient.setAttribute("fx", fmt(clamp(focus[0] ?? 0, -1, 1, 0)))
			gradient.setAttribute("fy", fmt(clamp(focus[1] ?? 0, -1, 1, 0)))
		} else {
			gradient.setAttribute("x1", "0")
			gradient.setAttribute("y1", "0")
			gradient.setAttribute("x2", "1")
			gradient.setAttribute("y2", "0")
		}

		gradient.setAttribute("spreadMethod", paint.spread === "reflect" ? "reflect" : paint.spread === "repeat" ? "repeat" : "pad")
		this.stops(gradient, paint.stops, 0)
		this.defs().appendChild(gradient)
		this.paintIds.set(key, id)

		return `url(#${id})`
	}

	// An image tile of explicit size placed by its matrix, mirrored per flip, repeated unless clamped.
	private tilePaint(paintIndex: number, paint: Extract<Paint, { kind: "image" }>, tile: ImageTile): string {
		const key = `t${paintIndex}`
		const cached = this.paintIds.get(key)

		if (cached !== undefined) return `url(#${cached})`

		const width = clamp(tile.width ?? 0, 0, MAX_COORD, 0)
		const height = clamp(tile.height ?? 0, 0, MAX_COORD, 0)
		const flipX = tile.flip === "x" || tile.flip === "xy"
		const flipY = tile.flip === "y" || tile.flip === "xy"

		if (!(width > 0 && height > 0)) return ""

		const id = this.id("t")
		const pattern = this.el("pattern")
		const transform = this.matrixAttribute(Array.isArray(tile.matrix) ? tile.matrix : [])
		const clamped = tile.clamp === true
		const [planeX, , planeWidth] = this.plane()
		// A clamped tile repeats only beyond the plane, so it draws once.
		const cellWidth = clamped ? planeWidth : width * (flipX ? 2 : 1)
		const cellHeight = clamped ? planeWidth : height * (flipY ? 2 : 1)

		pattern.setAttribute("id", id)
		pattern.setAttribute("patternUnits", "userSpaceOnUse")
		pattern.setAttribute("x", clamped ? fmt(planeX) : "0")
		pattern.setAttribute("y", clamped ? fmt(planeX) : "0")
		pattern.setAttribute("width", fmt(cellWidth))
		pattern.setAttribute("height", fmt(cellHeight))

		if (transform !== "") pattern.setAttribute("patternTransform", transform)

		const copies = clamped
			? [[1, 1]]
			: [[1, 1], ...(flipX ? [[-1, 1]] : []), ...(flipY ? [[1, -1]] : []), ...(flipX && flipY ? [[-1, -1]] : [])]

		for (const [sx = 1, sy = 1] of copies) {
			const content = this.imageContent(index(paint.image), 0, 0, width, height)

			if (content === undefined) return ""

			// Mirrored copies sit in the cell's second column or row, flipped about their own edge.
			if (sx < 0 || sy < 0 || clamped) {
				const group = this.el("g")
				const ox = clamped ? -planeX : sx < 0 ? width * 2 : 0
				const oy = clamped ? -planeX : sy < 0 ? height * 2 : 0

				group.setAttribute("transform", `matrix(${sx} 0 0 ${sy} ${fmt(ox)} ${fmt(oy)})`)
				group.appendChild(content)
				pattern.appendChild(group)
			} else {
				pattern.appendChild(content)
			}
		}

		this.defs().appendChild(pattern)
		this.paintIds.set(key, id)

		return `url(#${id})`
	}

	private color(color: number): string {
		const alpha = alphaOf(color)

		if (alpha === 0) return "none"

		this.opacity = alpha

		return hex(color)
	}

	private stops(gradient: SVGElement, stops: GradientStops, inner: number): void {
		const count = stopCount(stops)
		let previous = 0

		for (let k = 0; k < count; k++) {
			const offset = Math.max(previous, clamp(stops.offsets[k] ?? 0, 0, 1, 0))
			const color = rgbaOf(stops.colors[k] ?? 0)
			const stop = this.el("stop")
			const alpha = alphaOf(color)

			previous = offset
			stop.setAttribute("offset", fmt(inner + offset * (1 - inner)))
			stop.setAttribute("stop-color", hex(color))

			if (alpha < 1) stop.setAttribute("stop-opacity", fmt(alpha))

			gradient.appendChild(stop)
		}
	}

	private linear(paintIndex: number, paint: Extract<Paint, { kind: "linear" }>, width: number, height: number): string {
		const angle = mod(finite(paint.angle, 0), 360)
		const radians = (angle * Math.PI) / 180
		let dx = Math.cos(radians)
		let dy = Math.sin(radians)
		// The gradient is drawn in the unit box: an unscaled angle is kept true by stretching its direction
		// with the box (the gradient's normal transforms with the inverse of the box scale).
		const aspect = paint.scaled === true || angle % 90 === 0 ? "" : fmt(width / height)

		if (aspect !== "") {
			dx *= width
			dy *= height

			const length = Math.hypot(dx, dy)

			dx = length > 0 ? dx / length : 1
			dy = length > 0 ? dy / length : 0
		}

		const key = `l${paintIndex}:${aspect}`
		const cached = this.paintIds.get(key)

		if (cached !== undefined) return `url(#${cached})`

		const id = this.id("l")
		const gradient = this.el("linearGradient")
		// Spans the box: the first and last stops sit on the corners' projections.
		const half = (Math.abs(dx) + Math.abs(dy)) / 2

		gradient.setAttribute("id", id)
		gradient.setAttribute("x1", fmt(0.5 - dx * half))
		gradient.setAttribute("y1", fmt(0.5 - dy * half))
		gradient.setAttribute("x2", fmt(0.5 + dx * half))
		gradient.setAttribute("y2", fmt(0.5 + dy * half))
		this.stops(gradient, paint.stops, 0)
		this.defs().appendChild(gradient)
		this.paintIds.set(key, id)

		return `url(#${id})`
	}

	// a:path gradients as a radial gradient centred on the focus rectangle, which the first stop fills.
	private radial(paintIndex: number, paint: Extract<Paint, { kind: "path" }>, width: number, height: number): string {
		const { cx, cy, rx, ry, inner } = pathGradientCircle(paint, width, height)
		// A circle's ellipse in the box's fractions depends on the box's proportions.
		const key = `p${paintIndex}|${fmt(rx)}|${fmt(ry)}`
		const cached = this.paintIds.get(key)

		if (cached !== undefined) return `url(#${cached})`

		const id = this.id("r")
		const gradient = this.el("radialGradient")

		gradient.setAttribute("id", id)
		gradient.setAttribute("cx", "0")
		gradient.setAttribute("cy", "0")
		gradient.setAttribute("r", "1")
		gradient.setAttribute("gradientTransform", `matrix(${fmt(rx)} 0 0 ${fmt(ry)} ${fmt(cx)} ${fmt(cy)})`)
		this.stops(gradient, paint.stops, inner)
		this.defs().appendChild(gradient)
		this.paintIds.set(key, id)

		return `url(#${id})`
	}

	private pattern(paintIndex: number, paint: Extract<Paint, { kind: "pattern" }>): string {
		const foreground = rgbaOf(paint.foreground)
		const background = rgbaOf(paint.background)
		const d = typeof paint.pattern === "string" ? patternPath(paint.pattern) : undefined

		if (d === undefined) return this.color(mix(foreground, background, 0.5))

		const key = `t${paintIndex}`
		const cached = this.paintIds.get(key)

		if (cached !== undefined) return `url(#${cached})`

		const id = this.id("t")
		const pattern = this.el("pattern")

		pattern.setAttribute("id", id)
		pattern.setAttribute("patternUnits", "userSpaceOnUse")
		pattern.setAttribute("width", "8")
		pattern.setAttribute("height", "8")

		if (alphaOf(background) > 0) {
			const rect = this.el("rect")

			rect.setAttribute("width", "8")
			rect.setAttribute("height", "8")
			setColor(rect, "fill", background)
			pattern.appendChild(rect)
		}

		if (d !== "" && alphaOf(foreground) > 0) {
			const path = this.el("path")

			path.setAttribute("d", d)
			setColor(path, "fill", foreground)
			pattern.appendChild(path)
		}

		this.defs().appendChild(pattern)
		this.paintIds.set(key, id)

		return `url(#${id})`
	}

	// Picture fills stretch the image over the box (minus a:fillRect); tiles are approximated the same way.
	private imagePaint(paintIndex: number, paint: Extract<Paint, { kind: "image" }>): string {
		const key = `i${paintIndex}`
		const cached = this.paintIds.get(key)

		if (cached !== undefined) return `url(#${cached})`

		const [left, top, right, bottom] = insetOf(paint.stretch, -10, 1)
		const content = this.imageContent(index(paint.image), left, top, 1 - left - right, 1 - top - bottom)

		if (content === undefined) return ""

		const id = this.id("i")
		const pattern = this.el("pattern")

		pattern.setAttribute("id", id)
		pattern.setAttribute("width", "1")
		pattern.setAttribute("height", "1")
		pattern.setAttribute("patternContentUnits", "objectBoundingBox")
		pattern.appendChild(content)
		this.defs().appendChild(pattern)
		this.paintIds.set(key, id)

		return `url(#${id})`
	}

	private url(imageIndex: number, image: DrawingImage): string | undefined {
		if (this.urls.has(imageIndex)) return this.urls.get(imageIndex)

		const url = this.context.imageUrl(image)
		// Only object URLs of media the caller loaded; anything else stays a placeholder.
		const safe = typeof url === "string" && url.startsWith("blob:") ? url : undefined

		this.urls.set(imageIndex, safe)

		return safe
	}

	// The image drawn into (x, y, width, height) with its crop and effects, or undefined when it cannot be.
	private imageContent(imageIndex: number, x: number, y: number, width: number, height: number): SVGElement | undefined {
		const image = imageIndex < 0 ? undefined : this.data.images[imageIndex]

		if (image === undefined || image === null || !(width > 0 && height > 0)) return undefined

		const url = this.url(imageIndex, image)

		if (url === undefined) return undefined

		const [left, top, right, bottom] = insetOf(image.crop, -10, 1)
		const cropWidth = 1 - left - right
		const cropHeight = 1 - top - bottom

		if (!(cropWidth > 0.0001 && cropHeight > 0.0001)) return undefined

		const element = this.el("image")
		const alpha = clamp(image.alpha, 0, 1, 1)
		const filter = this.imageFilter(imageIndex, image)

		element.setAttribute("href", url)
		element.setAttribute("preserveAspectRatio", "none")

		if (alpha < 1) element.setAttribute("opacity", fmt(alpha))
		if (filter !== undefined) element.setAttribute("filter", `url(#${filter})`)

		if (left === 0 && top === 0 && right === 0 && bottom === 0) {
			element.setAttribute("x", fmt(x))
			element.setAttribute("y", fmt(y))
			element.setAttribute("width", fmt(width))
			element.setAttribute("height", fmt(height))

			return element
		}

		// a:srcRect as a viewBox over the unit image: it clips a crop and pads a negative one.
		const viewport = this.el("svg")

		viewport.setAttribute("x", fmt(x))
		viewport.setAttribute("y", fmt(y))
		viewport.setAttribute("width", fmt(width))
		viewport.setAttribute("height", fmt(height))
		viewport.setAttribute("viewBox", `${fmt(left)} ${fmt(top)} ${fmt(cropWidth)} ${fmt(cropHeight)}`)
		viewport.setAttribute("preserveAspectRatio", "none")
		element.setAttribute("width", "1")
		element.setAttribute("height", "1")
		viewport.appendChild(element)

		return viewport
	}

	// Grayscale, brightness/contrast, bi-level and duotone as one filter per image; colour change is not drawn.
	private imageFilter(imageIndex: number, image: DrawingImage): string | undefined {
		if (this.filterIds.has(imageIndex)) return this.filterIds.get(imageIndex)

		const biLevel = clamp(image.biLevel, -1, 1, -1)
		const brightness = clamp(image.brightness, -1, 1, 0)
		const contrast = clamp(image.contrast, -0.99, 0.99, 0)
		const duotone = Array.isArray(image.duotone) && image.duotone.length === 2 ? image.duotone : undefined
		const gray = image.grayscale === true || biLevel >= 0 || duotone !== undefined

		if (!gray && brightness === 0 && contrast === 0) return undefined

		const id = this.id("f")
		const filter = this.el("filter")

		filter.setAttribute("id", id)
		filter.setAttribute("color-interpolation-filters", "sRGB")

		if (gray) {
			const matrix = this.el("feColorMatrix")

			matrix.setAttribute("type", "saturate")
			matrix.setAttribute("values", "0")
			filter.appendChild(matrix)
		}

		if (brightness !== 0 || contrast !== 0) {
			this.transfer(filter, "linear", lumTransfer(brightness, contrast), undefined)
		}

		if (biLevel >= 0) {
			const steps = 16
			const table: number[] = []

			for (let k = 0; k < steps; k++) table.push(k / steps < biLevel ? 0 : 1)

			this.transfer(filter, "discrete", table, undefined)
		}

		if (duotone !== undefined) this.transfer(filter, "table", [], [rgbaOf(duotone[0]), rgbaOf(duotone[1])])

		this.defs().appendChild(filter)
		this.filterIds.set(imageIndex, id)

		return id
	}

	// feComponentTransfer over R, G and B: linear [slope, intercept], a shared table, or a two-colour ramp.
	private transfer(
		filter: SVGFilterElement,
		type: "linear" | "discrete" | "table",
		values: readonly number[],
		ramp: readonly [number, number] | undefined
	): void {
		const transfer = this.el("feComponentTransfer")
		const funcs = [this.el("feFuncR"), this.el("feFuncG"), this.el("feFuncB")]

		for (let channel = 0; channel < 3; channel++) {
			const func = funcs[channel]

			if (func === undefined) continue

			func.setAttribute("type", type)

			if (type === "linear") {
				func.setAttribute("slope", fmt(values[0] ?? 1))
				func.setAttribute("intercept", fmt(values[1] ?? 0))
			} else if (ramp !== undefined) {
				const shift = 24 - channel * 8

				func.setAttribute("tableValues", `${fmt(((ramp[0] >>> shift) & 255) / 255)} ${fmt(((ramp[1] >>> shift) & 255) / 255)}`)
			} else {
				func.setAttribute("tableValues", values.map(fmt).join(" "))
			}

			transfer.appendChild(func)
		}

		filter.appendChild(transfer)
	}

	private imageItem(i: number, f: number): SVGElement | undefined {
		const [x, y, width, height] = this.box(f)

		if (!(width > 0 && height > 0)) return undefined

		const group = this.el("g")
		const transform = this.transform(f)
		const content = this.imageContent(index(this.data.itemInts[i + ItemInt.REF]), x, y, width, height)
		const clip = this.pathData(i)

		if (transform !== "") group.setAttribute("transform", transform)

		if (clip !== "") {
			const id = this.id("c")
			const clipPath = this.el("clipPath")
			const path = this.el("path")

			path.setAttribute("d", clip)
			clipPath.setAttribute("id", id)
			clipPath.appendChild(path)
			this.defs().appendChild(clipPath)
			group.setAttribute("clip-path", `url(#${id})`)
		}

		if (content !== undefined) {
			group.appendChild(content)
		} else {
			const rect = this.el("rect")

			rect.setAttribute("x", fmt(x))
			rect.setAttribute("y", fmt(y))
			rect.setAttribute("width", fmt(width))
			rect.setAttribute("height", fmt(height))
			placeholderStyle(rect, true)
			group.appendChild(rect)
		}

		return group
	}

	private shadow(shadowIndex: number): string | undefined {
		const shadow: Shadow | undefined = shadowIndex < 0 ? undefined : this.data.shadows[shadowIndex]

		if (shadow === undefined || shadow === null) return undefined

		const color = rgbaOf(shadow.color)
		const dx = shadow.dx
		const dy = shadow.dy
		const blur = shadow.blur

		if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(blur)) return undefined
		if (Math.abs(dx) > 4096 || Math.abs(dy) > 4096 || blur < 0 || blur > 1024 || alphaOf(color) === 0) return undefined

		const key = `${color},${fmt(dx)},${fmt(dy)},${fmt(blur)}`
		const cached = this.shadowIds.get(key)

		if (cached !== undefined) return cached

		const id = this.id("s")
		const filter = this.el("filter")
		const drop = this.el("feDropShadow")
		const width = clamp(this.data.width, 0, MAX_COORD, 0)
		const height = clamp(this.data.height, 0, MAX_COORD, 0)
		// A user-space region: a bounding-box region is empty for straight lines and would hide them.
		const margin = Math.abs(dx) + Math.abs(dy) + blur * 3 + 16

		filter.setAttribute("id", id)
		filter.setAttribute("filterUnits", "userSpaceOnUse")
		filter.setAttribute("x", fmt(-width - margin))
		filter.setAttribute("y", fmt(-height - margin))
		filter.setAttribute("width", fmt(width * 3 + margin * 2))
		filter.setAttribute("height", fmt(height * 3 + margin * 2))
		drop.setAttribute("dx", fmt(dx))
		drop.setAttribute("dy", fmt(dy))
		drop.setAttribute("stdDeviation", fmt(blur / 2))
		drop.setAttribute("flood-color", hex(color))
		drop.setAttribute("flood-opacity", fmt(alphaOf(color)))
		filter.appendChild(drop)
		this.defs().appendChild(filter)
		this.shadowIds.set(key, id)

		return id
	}

	// Positioned text: one run on the item's baseline, each character anchored at its offset when positions
	// are given.
	private glyphItem(text: Extract<DrawingText, { kind: "glyphs" }>, textIndex: number, f: number): SVGElement | undefined {
		const run = text.run

		if (typeof run !== "object" || run === null || typeof run.text !== "string" || run.text === "" || this.runsLeft <= 0)
			return undefined

		this.runsLeft--

		const element = this.el("text")
		const transform = this.transform(f)
		const characters = Array.from(run.text.slice(0, MAX_GLYPHS * 2)).slice(0, MAX_GLYPHS)
		const positions = text.positions instanceof Float32Array ? text.positions : null

		if (positions !== null && positions.length > 0) {
			let x = ""

			for (let k = 0; k < Math.min(characters.length, positions.length); k++)
				x += k === 0 ? fmt(positions[k] ?? 0) : ` ${fmt(positions[k] ?? 0)}`

			element.setAttribute("x", x)
		} else {
			element.setAttribute("x", "0")
		}

		// Absolutely positioned characters each start a text chunk, so the anchor applies to each of them.
		if (text.anchor === "middle" || text.anchor === "end") element.setAttribute("text-anchor", text.anchor)

		element.setAttribute("y", "0")
		element.setAttributeNS(XML_NS, "xml:space", "preserve")

		if (transform !== "") element.setAttribute("transform", transform)

		element.textContent = characters.join("")
		this.runStyle(element, run, 1, this.family(textIndex, run.font))

		return this.textFill(element, text.fill, f)
	}

	// A text's paint instead of its colour, laid over the item's box; a clamped tile or shaded paint is drawn
	// as an image clipped by the text's own outline. The element to place.
	private textFill(element: SVGElement, fill: number | undefined, f: number): SVGElement {
		const paintIndex = index(fill)

		if (paintIndex < 0) return element

		const image = this.imageFill(paintIndex, this.localScale(f))

		if (image !== undefined) {
			element.removeAttribute("fill-opacity")

			return this.clippedFill(element, element.getAttribute("transform") ?? "", image)
		}

		const [, , width, height] = this.box(f)

		element.removeAttribute("fill-opacity")
		this.applyPaint(element, "fill", paintIndex, width, height, 0)

		return element
	}

	// The family list to draw a text in: the alias the engine registered for it, else a generic family.
	private family(textIndex: number, font: string): string {
		const resolved = Array.isArray(this.data.textFonts) ? this.data.textFonts[textIndex] : undefined

		return typeof resolved === "string" && FONT_FAMILY.test(resolved) ? resolved : genericFamily(font)
	}

	// Text the renderer lays out in its rectangle: measured greedy wrapping, cut to the height, trimmed,
	// aligned and clipped.
	private blockItem(text: Extract<DrawingText, { kind: "block" }>, textIndex: number, f: number): SVGElement | undefined {
		const run = text.run

		if (typeof run !== "object" || run === null || typeof run.text !== "string" || run.text === "" || this.runsLeft <= 0)
			return undefined

		this.runsLeft--

		const size = runPx(run, 1)
		const family = this.family(textIndex, run.font)
		const font = `${run.italic === true ? "italic " : ""}${run.bold === true ? 700 : 400} ${fmt(size)}px ${family}`
		const measure = (value: string): number => {
			const measured = this.context.measureText?.(value, font)

			return typeof measured === "number" && Number.isFinite(measured) && measured >= 0 ? measured : value.length * size * 0.55
		}
		const width = clamp(text.width, 0, MAX_COORD, 0)
		const height = clamp(text.height, 0, MAX_COORD, 0)
		const lineHeight = clamp(text.lineHeight, 0.01, MAX_COORD, size * 1.2)
		const trimming = typeof text.trimming === "string" ? text.trimming : "none"
		const lines = layoutBlock(
			run.text.slice(0, MAX_GLYPHS),
			width,
			height,
			lineHeight,
			text.wrap === true,
			text.lineLimit === true,
			trimming,
			measure
		)

		if (lines.length === 0) return undefined

		const total = lines.length * lineHeight
		const top =
			height <= 0
				? text.lineAlign === "middle"
					? -total / 2
					: text.lineAlign === "end"
						? -total
						: 0
				: text.lineAlign === "middle"
					? (height - total) / 2
					: text.lineAlign === "end"
						? height - total
						: 0
		const anchor = text.align === "middle" ? "middle" : text.align === "end" ? "end" : "start"
		const x = anchor === "middle" ? width / 2 : anchor === "end" ? width : 0
		const ascent = clamp(text.ascent, 0, 3, 0.9) * size
		const group = this.el("g")
		const transform = this.transform(f)

		if (transform !== "") group.setAttribute("transform", transform)

		if (text.clip === true && width > 0 && height > 0) {
			const id = this.id("b")
			const clipPath = this.el("clipPath")
			const rect = this.el("rect")

			rect.setAttribute("width", fmt(width))
			rect.setAttribute("height", fmt(height))
			clipPath.setAttribute("id", id)
			clipPath.appendChild(rect)
			this.defs().appendChild(clipPath)
			group.setAttribute("clip-path", `url(#${id})`)
		}

		for (let k = 0; k < lines.length; k++) {
			const line = this.el("text")

			line.setAttribute("x", fmt(x))
			line.setAttribute("y", fmt(top + k * lineHeight + ascent))
			line.setAttributeNS(XML_NS, "xml:space", "preserve")

			if (anchor !== "start") line.setAttribute("text-anchor", anchor)
			if (text.rtl === true) line.setAttribute("direction", "rtl")

			line.textContent = lines[k] ?? ""
			this.runStyle(line, run, 1, family)
			group.appendChild(this.textFill(line, text.fill, f))
		}

		return group
	}

	// Rich text laid out simply: a line per paragraph or line break, no wrapping, anchored in the box.
	private textItem(i: number, f: number): SVGElement | undefined {
		const text: DrawingText | undefined = this.data.texts[index(this.data.itemInts[i + ItemInt.REF])]

		const textIndex = index(this.data.itemInts[i + ItemInt.REF])

		if (text !== undefined && text !== null && text.kind === "glyphs") return this.glyphItem(text, textIndex, f)
		if (text !== undefined && text !== null && text.kind === "block") return this.blockItem(text, textIndex, f)

		// A story is a text box the page layout draws itself.
		if (text === undefined || text === null || text.kind !== "body" || !Array.isArray(text.paragraphs)) return undefined

		const body = text.body

		if (typeof body !== "object" || body === null) return undefined

		const [x, y, width, height] = this.box(f)
		const turn = verticalRotation(body.vertical)
		const rotation = mod(finite(body.rotation, 0) + turn, 360)
		const swap = turn !== 0
		const cx = x + width / 2
		const cy = y + height / 2
		const boxWidth = swap ? height : width
		const boxHeight = swap ? width : height
		const [insetLeft, insetTop, insetRight, insetBottom] = insetOf(body.insets, 0, 10_000)
		const left = cx - boxWidth / 2 + insetLeft
		const right = cx + boxWidth / 2 - insetRight
		const top = cy - boxHeight / 2 + insetTop
		const bottom = cy + boxHeight / 2 - insetBottom
		const normal = body.autofit === "normal"
		const scale = normal ? clamp(body.fontScale, 0.01, 1, 1) : 1
		const reduction = normal ? clamp(body.lineSpacingReduction, 0, 0.9, 0) : 0
		const lines = this.lines(text.paragraphs, scale, reduction)

		if (lines.length === 0) return undefined

		let total = 0

		for (const line of lines) total += line.before + line.height + line.after

		let cursor = body.anchor === "ctr" ? top + (bottom - top - total) / 2 : body.anchor === "b" ? bottom - total : top
		const group = this.el("g")
		let transform = this.transform(f)

		if (rotation !== 0) transform += `${transform === "" ? "" : " "}rotate(${fmt(rotation)} ${fmt(cx)} ${fmt(cy)})`
		if (transform !== "") group.setAttribute("transform", transform)

		for (const line of lines) {
			cursor += line.before

			const baseline = cursor + (line.height - line.size * 1.2) / 2 + line.size * 0.95
			const element = this.line(line, left, right, baseline, scale)

			if (element !== undefined) group.appendChild(element)

			cursor += line.height + line.after
		}

		return group.firstChild === null ? undefined : group
	}

	private lines(paragraphs: readonly TextParagraph[], scale: number, reduction: number): Line[] {
		const lines: Line[] = []

		for (let p = 0; p < paragraphs.length && this.runsLeft > 0; p++) {
			const paragraph = paragraphs[p]

			if (paragraph === undefined || paragraph === null || !Array.isArray(paragraph.runs)) continue

			const runs = paragraph.runs
			const count = Math.min(runs.length, this.runsLeft)
			const spacing = finite(paragraph.lineSpacing, 0)
			const before = p === 0 ? 0 : clamp(paragraph.spaceBefore, 0, 1000, 0) * PX_PER_PT
			const after = clamp(paragraph.spaceAfter, 0, 1000, 0) * PX_PER_PT
			const firstLine = lines.length
			let from = 0

			this.runsLeft -= count

			for (let k = 0; k <= count; k++) {
				const run = runs[k]

				if (k < count && run?.lineBreak !== true) continue

				let size = 0

				for (let r = from; r < k; r++) {
					const sized = runs[r]

					if (sized !== undefined) size = Math.max(size, runPx(sized, scale))
				}

				if (size === 0) size = clamp(paragraph.endSize, 1, 1000, 11) * PX_PER_PT * scale

				const single = size * 1.2
				const height =
					(spacing > 0 ? single * Math.min(spacing, 10) : spacing < 0 ? Math.min(-spacing, 1000) * PX_PER_PT : single) *
					(1 - reduction)

				lines.push({ paragraph, from, to: k, first: lines.length === firstLine, size, height, before: 0, after: 0 })
				from = k + 1
			}

			const first = lines[firstLine]
			const last = lines[lines.length - 1]

			if (first !== undefined) first.before = before
			if (last !== undefined) last.after = after
		}

		return lines
	}

	private line(line: Line, left: number, right: number, baseline: number, scale: number): SVGElement | undefined {
		const paragraph = line.paragraph
		const runs = paragraph.runs
		const anchor = textAnchor(paragraph.align)
		const marginLeft = clamp(paragraph.marginLeft, -10_000, 10_000, 0) + (line.first ? clamp(paragraph.indent, -10_000, 10_000, 0) : 0)
		const x = anchor === "middle" ? (left + right) / 2 : anchor === "end" ? right : left + marginLeft
		const element = this.el("text")
		const bullet = line.first && typeof paragraph.bullet === "string" && paragraph.bullet !== "" ? paragraph.bullet : ""
		let parts = bullet === "" ? 0 : 1

		for (let r = line.from; r < line.to; r++) if (runs[r] !== undefined) parts++

		if (parts === 0) return undefined

		element.setAttribute("x", fmt(x))
		element.setAttribute("y", fmt(baseline))
		element.setAttributeNS(XML_NS, "xml:space", "preserve")

		if (anchor !== "start") element.setAttribute("text-anchor", anchor)

		const firstRun = runs[line.from]

		if (bullet !== "") {
			const span = parts === 1 ? element : this.el("tspan")

			span.textContent = `${symbolBullet(paragraph.bulletFont) ? "•" : bullet} `

			if (firstRun !== undefined) this.runStyle(span, firstRun, scale)
			if (span !== element) element.appendChild(span)
		}

		// A raised or lowered run shifts the following text too, so the next run shifts back.
		let shift = 0

		for (let r = line.from; r < line.to; r++) {
			const run = runs[r]

			if (run === undefined) continue

			const span = parts === 1 ? element : this.el("tspan")
			const raw = typeof run.text === "string" ? run.text : ""
			const baselineShift = clamp(run.baseline, -1, 1, 0) * clamp(run.size, 1, 1000, 11) * PX_PER_PT * scale

			span.textContent = run.caps === "all" ? raw.toUpperCase() : raw
			this.runStyle(span, run, scale)

			if (baselineShift !== 0 || shift !== 0) span.setAttribute("dy", fmt(shift - baselineShift))

			shift = baselineShift

			if (span !== element) element.appendChild(span)
		}

		return element
	}

	private runStyle(element: SVGElement, run: TextRun, scale: number, family: string = genericFamily(run.font)): void {
		const color = rgbaOf(run.color)
		const alpha = alphaOf(color)
		const spacing = clamp(run.spacing, -100, 100, 0) * PX_PER_PT
		const underline = typeof run.underline === "string" && run.underline !== "none"
		const strike = run.strike === "sngStrike" || run.strike === "dblStrike"

		element.setAttribute("font-size", fmt(runPx(run, scale)))
		element.setAttribute("font-family", family)
		element.setAttribute("fill", hex(color))

		if (alpha < 1) element.setAttribute("fill-opacity", fmt(alpha))
		if (run.bold === true) element.setAttribute("font-weight", "bold")
		if (run.italic === true) element.setAttribute("font-style", "italic")
		if (run.caps === "small") element.setAttribute("font-variant", "small-caps")
		if (spacing !== 0) element.setAttribute("letter-spacing", fmt(spacing))
		if (underline || strike)
			element.setAttribute(
				"text-decoration",
				underline && strike ? "underline line-through" : underline ? "underline" : "line-through"
			)
	}
}

// The compositing of an item drawn with a raster operation (metafile blits).
function blendMode(flags: number): "multiply" | "lighten" | "difference" | undefined {
	switch (flags & ItemFlag.BLEND_MASK) {
		case ItemFlag.BLEND_MULTIPLY:
			return "multiply"
		case ItemFlag.BLEND_LIGHTEN:
			return "lighten"
		case ItemFlag.BLEND_DIFFERENCE:
			return "difference"
		default:
			return undefined
	}
}

// Symbol-font bullets (Wingdings, Symbol) map their glyphs onto letters; a plain bullet reads better.
function symbolBullet(font: string): boolean {
	const name = typeof font === "string" ? font.toLowerCase() : ""

	return name.includes("wingdings") || name.includes("symbol") || name.includes("webdings")
}

function setColor(element: SVGElement, slot: PaintSlot, color: number): void {
	const alpha = alphaOf(color)

	element.setAttribute(slot, hex(color))

	if (alpha < 1) element.setAttribute(`${slot}-opacity`, fmt(alpha))
}

// Themeable through CSS custom properties on the page.
function placeholderStyle(element: SVGElement, filled: boolean): void {
	if (filled) element.style.setProperty("fill", "var(--fo-placeholder-fill, #f1f1f1)")

	element.style.setProperty("stroke", "var(--fo-placeholder-stroke, #c8c8c8)")
	element.setAttribute("stroke-width", "1")
	element.setAttribute("vector-effect", "non-scaling-stroke")
}

export function paintDrawing(data: DrawingData, context: DrawingPaintContext): SVGSVGElement {
	const painter = new Painter(data, context)

	painter.paint()

	return painter.root
}

// Every image the drawing shows (picture fills and image items, hidden items skipped), once per part, so the
// caller can load media before painting.
export function drawingImages(data: DrawingData): DrawingImage[] {
	const ints = data.itemInts
	const count = Math.min(index(data.itemCount) < 0 ? 0 : data.itemCount, MAX_ITEMS, Math.floor(ints.length / ITEM_INTS))
	const seen = new Set<string>()
	const out: DrawingImage[] = []
	const add = (imageIndex: number): void => {
		const image = imageIndex < 0 ? undefined : data.images[imageIndex]

		if (image === undefined || image === null) return

		const key = image.svgPartName ?? image.partName

		if (typeof key !== "string" || seen.has(key)) return

		seen.add(key)
		out.push(image)
	}
	const addPaint = (paintIndex: number): void => {
		const paint = paintIndex < 0 ? undefined : data.paints[paintIndex]

		if (paint !== undefined && paint !== null && paint.kind === "image") add(index(paint.image))
	}

	for (let item = 0; item < count; item++) {
		const i = item * ITEM_INTS

		if (((ints[i + ItemInt.FLAGS] ?? 0) & ItemFlag.HIDDEN) !== 0) continue

		switch (ints[i + ItemInt.KIND]) {
			case ItemKind.PATH: {
				addPaint(index(ints[i + ItemInt.FILL]))

				const stroke = data.strokes[index(ints[i + ItemInt.STROKE])]

				if (stroke !== undefined && stroke !== null) addPaint(index(stroke.paint))

				break
			}
			case ItemKind.IMAGE:
				add(index(ints[i + ItemInt.REF]))
				break
			default:
				break
		}
	}

	return out
}

// The MIME type an image is shown as through <image>/<img> (an SVG there runs no script), or "" when it
// cannot be shown natively. An SVG rendition, when there is one, is what the caller loads.
// Raster formats a drawing may carry inline (bitmaps of a metafile); anything else is not shown.
export function inlineImageMime(image: DrawingImage): string | undefined {
	if (!(image.bytes instanceof Uint8Array) || image.partName !== undefined) return undefined

	switch (image.format) {
		case "png":
		case "jpeg":
		case "gif":
		case "bmp":
			return imageMime(image)
		default:
			return undefined
	}
}

// Object URLs for the bitmaps a drawing carries inline (a metafile's), by image: one per encoded bitmap, so entries
// that differ only in crop or effects share their bytes. `create` makes one (undefined: that bitmap shows nothing).
export function inlineImageUrls(
	data: DrawingData,
	create: (bytes: Uint8Array, type: string) => string | undefined
): Map<DrawingImage, string> {
	const inline = new Map<DrawingImage, string>()
	const byBytes = new Map<Uint8Array, string>()

	for (const image of Array.isArray(data.images) ? data.images : []) {
		const type = image === null || typeof image !== "object" ? undefined : inlineImageMime(image)

		if (type === undefined || image.bytes === undefined || inline.has(image)) continue

		let url = byBytes.get(image.bytes)

		if (url === undefined) {
			url = create(image.bytes, type)

			if (url === undefined) continue

			byBytes.set(image.bytes, url)
		}

		inline.set(image, url)
	}

	return inline
}

export function imageMime(image: DrawingImage): string {
	if (typeof image.svgPartName === "string") return "image/svg+xml"

	switch (image.format) {
		case "png":
			return "image/png"
		case "jpeg":
			return "image/jpeg"
		case "gif":
			return "image/gif"
		case "bmp":
			return "image/bmp"
		case "webp":
			return "image/webp"
		case "svg":
			return "image/svg+xml"
		default:
			return ""
	}
}
