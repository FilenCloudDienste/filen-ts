import { colorChild, readColor, readColorIn, type DrawingTheme } from "./color"
import {
	rgba,
	type DashPreset,
	type DrawingList,
	type GradientStops,
	type ImageTile,
	type Inset,
	type PatternPreset,
	type Rgba,
	type Shadow,
	type Stroke
} from "./displayList"
import { readBlip, type ImageResolver } from "./picture"
import { D, EMU_PER_PX, type DrawingReader } from "./reader"

// Everything fill, line and effect reads need.
export interface PaintContext {
	readonly list: DrawingList
	readonly theme: DrawingTheme
	readonly images: ImageResolver
	// Draw a:outerShdw effects (off by default: shadows are optional).
	readonly effects: boolean
}

// A resolved fill: a paint index, NONE, or INHERIT (a:grpFill: the enclosing group's fill).
export const NO_PAINT = -1
export const GROUP_PAINT = -2

const FILL_ELEMENTS: ReadonlySet<string> = new Set(["noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"])

const PATTERNS: ReadonlySet<string> = new Set([
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
	"horz",
	"vert",
	"ltHorz",
	"ltVert",
	"dkHorz",
	"dkVert",
	"narHorz",
	"narVert",
	"dashHorz",
	"dashVert",
	"cross",
	"dnDiag",
	"upDiag",
	"ltDnDiag",
	"ltUpDiag",
	"dkDnDiag",
	"dkUpDiag",
	"wdDnDiag",
	"wdUpDiag",
	"dashDnDiag",
	"dashUpDiag",
	"diagCross",
	"smCheck",
	"lgCheck",
	"smGrid",
	"lgGrid",
	"dotGrid",
	"smConfetti",
	"lgConfetti",
	"horzBrick",
	"diagBrick",
	"solidDmnd",
	"openDmnd",
	"dotDmnd",
	"plaid",
	"sphere",
	"weave",
	"divot",
	"shingle",
	"wave",
	"trellis",
	"zigZag"
])

const DASHES: ReadonlySet<string> = new Set([
	"solid",
	"dot",
	"dash",
	"lgDash",
	"dashDot",
	"lgDashDot",
	"lgDashDotDot",
	"sysDash",
	"sysDot",
	"sysDashDot",
	"sysDashDotDot"
])

const TILE_ALIGNS: ReadonlySet<string> = new Set(["tl", "t", "tr", "l", "ctr", "r", "bl", "b", "br"])

const BLACK = rgba("000000")
const WHITE = rgba("FFFFFF")

// The fill element among a container's children (spPr, a:ln, a:tcPr...), or -1.
export function fillChild(reader: DrawingReader, container: number): number {
	return reader.childOf(container, D.A, FILL_ELEMENTS)
}

function insetOf(reader: DrawingReader, node: number): Inset {
	return {
		left: reader.fraction(node, "l", 0),
		top: reader.fraction(node, "t", 0),
		right: reader.fraction(node, "r", 0),
		bottom: reader.fraction(node, "b", 0)
	}
}

function gradientStops(context: PaintContext, reader: DrawingReader, gradient: number, placeholder: Rgba | undefined): GradientStops {
	const stops: [number, Rgba][] = []

	for (const gs of reader.children(reader.child(gradient, D.A, "gsLst"), D.A, "gs")) {
		const color = readColorIn(reader, gs, context.theme, placeholder)

		if (color !== undefined) stops.push([Math.min(1, Math.max(0, reader.fraction(gs, "pos", 0))), color])
	}

	stops.sort((a, b) => a[0] - b[0])

	return { offsets: Float32Array.from(stops, stop => stop[0]), colors: Uint32Array.from(stops, stop => stop[1]) }
}

// One fill element -> paint index, NO_PAINT or GROUP_PAINT; undefined when it paints nothing usable.
export function readFillElement(context: PaintContext, reader: DrawingReader, fill: number, placeholder?: Rgba): number | undefined {
	if (fill < 0) return undefined

	const list = context.list

	switch (reader.local(fill)) {
		case "noFill":
			return NO_PAINT
		case "grpFill":
			return GROUP_PAINT
		case "solidFill": {
			const color = readColorIn(reader, fill, context.theme, placeholder)

			return color === undefined ? undefined : list.paint({ kind: "solid", color })
		}
		case "gradFill": {
			const stops = gradientStops(context, reader, fill, placeholder)

			if (stops.offsets.length === 0) return undefined
			if (stops.offsets.length === 1) return list.paint({ kind: "solid", color: stops.colors[0] ?? BLACK })

			const path = reader.child(fill, D.A, "path")

			if (path >= 0) {
				const shape = reader.attr(path, "path")

				return list.paint({
					kind: "path",
					shape: shape === "rect" ? "rect" : shape === "shape" ? "shape" : "circle",
					stops,
					focus: insetOf(reader, reader.child(path, D.A, "fillToRect"))
				})
			}

			const linear = reader.child(fill, D.A, "lin")

			return list.paint({
				kind: "linear",
				stops,
				angle: linear < 0 ? 90 : reader.angle(linear, "ang", 0),
				scaled: linear >= 0 && reader.bool(linear, "scaled", false)
			})
		}
		case "pattFill": {
			const preset = reader.attr(fill, "prst") ?? "pct5"

			return list.paint({
				kind: "pattern",
				pattern: (PATTERNS.has(preset) ? preset : "pct50") as PatternPreset,
				foreground: readColorIn(reader, reader.child(fill, D.A, "fgClr"), context.theme, placeholder) ?? BLACK,
				background: readColorIn(reader, reader.child(fill, D.A, "bgClr"), context.theme, placeholder) ?? WHITE
			})
		}
		case "blipFill": {
			const image = readBlip(context, reader, fill, placeholder)

			if (image < 0) return undefined

			const tile = reader.child(fill, D.A, "tile")
			const stretch = reader.child(fill, D.A, "stretch")

			if (tile >= 0) {
				const flip = reader.attr(tile, "flip")
				const align = reader.attr(tile, "algn") ?? "tl"
				const placement: ImageTile = {
					tx: reader.emu(tile, "tx", 0) / EMU_PER_PX,
					ty: reader.emu(tile, "ty", 0) / EMU_PER_PX,
					sx: reader.fraction(tile, "sx", 1),
					sy: reader.fraction(tile, "sy", 1),
					flip: flip === "x" || flip === "y" || flip === "xy" ? flip : "none",
					align: (TILE_ALIGNS.has(align) ? align : "tl") as ImageTile["align"]
				}

				return list.paint({ kind: "image", image, stretch: undefined, tile: placement })
			}

			return list.paint({ kind: "image", image, stretch: insetOf(reader, reader.child(stretch, D.A, "fillRect")), tile: undefined })
		}
		default:
			return undefined
	}
}

// A style matrix reference (a:fillRef/a:lnRef/a:effectRef @idx with its colour) resolved against the
// theme's format scheme: the node of the referenced entry and the colour phClr stands for.
export interface StyleRef {
	readonly reader: DrawingReader
	readonly node: number
	readonly color: Rgba | undefined
}

export function styleRef(
	context: PaintContext,
	reader: DrawingReader,
	ref: number,
	kind: "fill" | "line" | "effect"
): StyleRef | undefined {
	if (ref < 0) return undefined

	const formats = context.theme.formats
	const index = reader.number(ref, "idx", 0)
	const color = readColor(reader, colorChild(reader, ref), context.theme)

	if (formats === undefined || index <= 0) return { reader, node: -1, color }

	// Fill indices from 1001 address the background fill list (§20.1.4.2.10).
	const entries =
		kind === "fill" ? (index >= 1001 ? formats.backgroundFills : formats.fills) : kind === "line" ? formats.lines : formats.effects
	const node = entries[(index >= 1001 ? index - 1001 : index - 1) | 0] ?? -1

	return { reader: formats.reader, node, color }
}

// The fill of a shape: its own fill element, else the style's fill reference.
export function shapeFill(context: PaintContext, reader: DrawingReader, spPr: number, fillRef: StyleRef | undefined): number | undefined {
	const own = readFillElement(context, reader, fillChild(reader, spPr))

	if (own !== undefined) return own
	if (fillRef === undefined || fillRef.node < 0) return undefined

	return readFillElement(context, fillRef.reader, fillRef.node, fillRef.color)
}

const ARROW_SIZES: Readonly<Record<string, number>> = { sm: 2, med: 3, lg: 5 }

export type ArrowType = "triangle" | "stealth" | "diamond" | "oval" | "arrow"

export interface LineEnd {
	readonly type: ArrowType
	// Multiples of the line width.
	readonly width: number
	readonly length: number
}

export interface LineStyle {
	readonly stroke: number
	readonly head: LineEnd | undefined
	readonly tail: LineEnd | undefined
}

function lineEnd(reader: DrawingReader, node: number): LineEnd | undefined {
	const type = reader.attr(node, "type")

	if (node < 0 || type === undefined || type === "none") return undefined
	if (type !== "triangle" && type !== "stealth" && type !== "diamond" && type !== "oval" && type !== "arrow") return undefined

	return { type, width: ARROW_SIZES[reader.attr(node, "w") ?? "med"] ?? 3, length: ARROW_SIZES[reader.attr(node, "len") ?? "med"] ?? 3 }
}

// a:ln properties, each falling back to the referenced theme line (and its phClr colour).
export function shapeLine(context: PaintContext, reader: DrawingReader, ln: number, lnRef: StyleRef | undefined): LineStyle | undefined {
	const base = lnRef !== undefined && lnRef.node >= 0 ? lnRef : undefined
	const pick = <T>(read: (r: DrawingReader, node: number) => T | undefined): T | undefined =>
		(ln >= 0 ? read(reader, ln) : undefined) ?? (base === undefined ? undefined : read(base.reader, base.node))
	let paint = ln >= 0 ? readFillElement(context, reader, fillChild(reader, ln)) : undefined

	if (paint === undefined && base !== undefined)
		paint = readFillElement(context, base.reader, fillChild(base.reader, base.node), base.color)
	// An a:ln with nothing but a width still strokes with the reference colour.
	if (paint === undefined && lnRef?.color !== undefined && (ln >= 0 || base !== undefined))
		paint = context.list.paint({ kind: "solid", color: lnRef.color })
	if (paint === undefined || paint === NO_PAINT || paint === GROUP_PAINT) return undefined

	const width = (pick((r, node) => (r.attr(node, "w") === undefined ? undefined : r.emu(node, "w", 0))) ?? 9525) / EMU_PER_PX
	const dash = pick((r, node) => r.attr(r.child(node, D.A, "prstDash"), "val"))
	const customNode = pick((r, node) => {
		const custom = r.child(node, D.A, "custDash")

		return custom < 0 ? undefined : { r, custom }
	})
	let customDash: Float32Array | null = null

	if (customNode !== undefined) {
		const values: number[] = []

		for (const ds of customNode.r.children(customNode.custom, D.A, "ds")) {
			values.push(customNode.r.fraction(ds, "d", 1), customNode.r.fraction(ds, "sp", 1))
		}

		if (values.length > 0) customDash = Float32Array.from(values)
	}

	const cap = pick((r, node) => r.attr(node, "cap"))
	const join = pick((r, node) =>
		r.child(node, D.A, "round") >= 0
			? "round"
			: r.child(node, D.A, "bevel") >= 0
				? "bevel"
				: r.child(node, D.A, "miter") >= 0
					? "miter"
					: undefined
	)
	const miterLimit = pick((r, node) => {
		const miter = r.child(node, D.A, "miter")

		return miter < 0 ? undefined : r.fraction(miter, "lim", 8)
	})
	const compound = pick((r, node) => r.attr(node, "cmpd"))
	const stroke: Stroke = {
		// A zero width is the thinnest line the device draws.
		width: width > 0 ? width : 1,
		paint,
		dash: (dash !== undefined && DASHES.has(dash) ? dash : "solid") as DashPreset,
		customDash,
		cap: cap === "rnd" ? "round" : cap === "sq" ? "square" : "flat",
		join: join ?? "round",
		miterLimit: miterLimit ?? 8,
		compound: compound === "dbl" || compound === "thickThin" || compound === "thinThick" || compound === "tri" ? compound : "sng",
		inset: pick((r, node) => r.attr(node, "algn")) === "in"
	}

	return {
		stroke: context.list.stroke(stroke),
		head: pick((r, node) => lineEnd(r, r.child(node, D.A, "headEnd"))),
		tail: pick((r, node) => lineEnd(r, r.child(node, D.A, "tailEnd")))
	}
}

// The first a:outerShdw of an a:effectLst (own, else the referenced theme effect), when effects are on.
export function shapeShadow(context: PaintContext, reader: DrawingReader, spPr: number, effectRef: StyleRef | undefined): number {
	if (!context.effects) return -1

	const own = reader.child(spPr, D.A, "effectLst")
	let source: DrawingReader = reader
	let list = own
	let placeholder: Rgba | undefined

	if (own < 0 && effectRef !== undefined && effectRef.node >= 0) {
		source = effectRef.reader
		list = source.child(effectRef.node, D.A, "effectLst")
		placeholder = effectRef.color
	}

	const shadow = source.child(list, D.A, "outerShdw")

	if (shadow < 0) return -1

	const color = readColorIn(source, shadow, context.theme, placeholder)

	if (color === undefined) return -1

	const distance = source.emu(shadow, "dist", 0) / EMU_PER_PX
	const direction = (source.angle(shadow, "dir", 0) * Math.PI) / 180
	const value: Shadow = {
		color,
		blur: source.emu(shadow, "blurRad", 0) / EMU_PER_PX,
		dx: distance * Math.cos(direction),
		dy: distance * Math.sin(direction),
		sx: source.fraction(shadow, "sx", 1),
		sy: source.fraction(shadow, "sy", 1)
	}

	return context.list.shadow(value)
}

// An effect of an a:effectLst as drawn around a shape (§20.1.8): colours resolved, sizes in px, directions in
// degrees clockwise. A prstShdw is its offset at the preset's colour (the preset's shape is not drawn).
export type ShapeEffect =
	| {
			readonly kind: "outerShadow" | "innerShadow"
			readonly color: Rgba
			readonly blur: number
			readonly dx: number
			readonly dy: number
			readonly sx: number
			readonly sy: number
	  }
	| { readonly kind: "glow"; readonly color: Rgba; readonly radius: number }
	| { readonly kind: "softEdge"; readonly radius: number }
	| { readonly kind: "blur"; readonly radius: number }
	| {
			readonly kind: "reflection"
			readonly blur: number
			readonly startAlpha: number
			readonly endAlpha: number
			readonly endPos: number
			readonly distance: number
			readonly direction: number
	  }

export interface ShapeEffects {
	readonly effects: readonly ShapeEffect[]
	// Per effect, the element it was read from (outerShdw, prstShdw…).
	readonly sources: readonly string[]
	// Effect elements read but not drawn as written (a preset shadow's shape, a shadow's skew or alignment, an
	// effect DAG, 3D), by local name.
	readonly approximated: readonly string[]
	// Effect elements after the first of their kind: CT_EffectList (§20.1.8.26) holds each kind at most once, so
	// only the first is read and the rest are counted, not drawn.
	readonly repeated: number
}

const NO_EFFECTS: ShapeEffects = { effects: [], sources: [], approximated: [], repeated: 0 }

// The effects of a shape's properties: its own a:effectLst (or a:effectDag, counted as approximated), else the
// one its style's effect reference names in the theme. Read whether or not `context.effects` is on.
export function shapeEffects(context: PaintContext, reader: DrawingReader, spPr: number, effectRef: StyleRef | undefined): ShapeEffects {
	let source: DrawingReader = reader
	let list = reader.child(spPr, D.A, "effectLst")
	let placeholder: Rgba | undefined
	const approximated: string[] = []

	if (list < 0 && reader.child(spPr, D.A, "effectDag") >= 0) return { effects: [], sources: [], approximated: ["effectDag"], repeated: 0 }

	if (list < 0 && effectRef !== undefined && effectRef.node >= 0) {
		source = effectRef.reader
		list = source.child(effectRef.node, D.A, "effectLst")
		placeholder = effectRef.color

		if (list < 0 && source.child(effectRef.node, D.A, "effectDag") >= 0) approximated.push("effectDag")
	}

	if (list < 0) return approximated.length === 0 ? NO_EFFECTS : { effects: [], sources: [], approximated, repeated: 0 }

	const document = source.document
	const effects: ShapeEffect[] = []
	const sources: string[] = []
	const color = (node: number): Rgba | undefined => readColorIn(source, node, context.theme, placeholder)
	const offset = (node: number): { dx: number; dy: number } => {
		const distance = source.emu(node, "dist", 0) / EMU_PER_PX
		const direction = (source.angle(node, "dir", 0) * Math.PI) / 180

		return { dx: distance * Math.cos(direction), dy: distance * Math.sin(direction) }
	}

	const seen = new Set<string>()
	let repeated = 0

	for (let effect = document.firstChildElement(list); effect >= 0; effect = document.nextSiblingElement(effect)) {
		if (source.group(effect) !== D.A) continue

		const local = document.localName(effect)

		if (seen.has(local)) {
			repeated++

			continue
		}

		seen.add(local)

		switch (local) {
			case "outerShdw":
			case "innerShdw": {
				const shadowColor = color(effect)

				if (shadowColor === undefined) break

				const sx = source.fraction(effect, "sx", 1)
				const sy = source.fraction(effect, "sy", 1)

				// The painters draw the shadow at the shape's size, unskewed: a scaled or skewed shadow is not as written.
				if (
					local === "outerShdw" &&
					(sx !== 1 ||
						sy !== 1 ||
						source.attr(effect, "kx") !== undefined ||
						source.attr(effect, "ky") !== undefined ||
						source.attr(effect, "algn") !== undefined)
				)
					approximated.push(local)

				effects.push({
					kind: local === "outerShdw" ? "outerShadow" : "innerShadow",
					color: shadowColor,
					blur: source.emu(effect, "blurRad", 0) / EMU_PER_PX,
					...offset(effect),
					sx,
					sy
				})
				sources.push(local)

				break
			}
			case "prstShdw": {
				const shadowColor = color(effect)

				if (shadowColor === undefined) break

				approximated.push(local)
				effects.push({ kind: "outerShadow", color: shadowColor, blur: 0, ...offset(effect), sx: 1, sy: 1 })
				sources.push(local)

				break
			}
			case "glow": {
				const glowColor = color(effect)
				const radius = source.emu(effect, "rad", 0) / EMU_PER_PX

				if (glowColor !== undefined && radius > 0) {
					effects.push({ kind: "glow", color: glowColor, radius })
					sources.push(local)
				}

				break
			}
			case "softEdge": {
				const radius = source.emu(effect, "rad", 0) / EMU_PER_PX

				if (radius > 0) {
					effects.push({ kind: "softEdge", radius })
					sources.push(local)
				}

				break
			}
			case "blur": {
				const radius = source.emu(effect, "rad", 0) / EMU_PER_PX

				if (radius > 0) {
					effects.push({ kind: "blur", radius })
					sources.push(local)
				}
				if (source.bool(effect, "grow", true) === false) approximated.push("blur")

				break
			}
			case "reflection": {
				// §20.1.8.50 defaults: stA 100%, endA 0%, endPos 100%; skew, scale other than a mirror and the fade
				// direction are not drawn.
				if (
					source.attr(effect, "kx") !== undefined ||
					source.attr(effect, "ky") !== undefined ||
					source.fraction(effect, "sy", -1) !== -1 ||
					source.attr(effect, "fadeDir") !== undefined
				)
					approximated.push(local)

				effects.push({
					kind: "reflection",
					blur: source.emu(effect, "blurRad", 0) / EMU_PER_PX,
					startAlpha: source.fraction(effect, "stA", 1),
					endAlpha: source.fraction(effect, "endA", 0),
					endPos: source.fraction(effect, "endPos", 1),
					distance: source.emu(effect, "dist", 0) / EMU_PER_PX,
					direction: source.angle(effect, "dir", 0)
				})
				sources.push(local)

				break
			}
			default:
				// fillOverlay and the effect-container forms are not drawn.
				approximated.push(local)
		}
	}

	return { effects, sources, approximated, repeated }
}
