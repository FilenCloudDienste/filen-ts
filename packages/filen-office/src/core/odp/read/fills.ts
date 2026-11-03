import type { TextBodyProps } from "../../drawingml/index"
import { parseLength, parsePercent, type OdfElement, type OdfProperties } from "../../odf/index"
import type { ColorModel, Effect, EffectList, FillProps, LineEnd, LineProps } from "../../presentation/model"

// Graphic properties (ODF 1.3 Part 3 §17.21 style:graphic-properties, §17.25 style:drawing-page-properties) as the
// model's fills, lines, effects and text body properties. Colours are kept as sRGB (ODF has no theme slots); the
// drawing resources a style names (draw:gradient, draw:hatch, draw:fill-image, draw:stroke-dash, draw:marker,
// draw:opacity; §16.40–§16.47) come from the style sheet's tables. Where DrawingML has no equivalent (hatches,
// square gradients, gradient transparency, untiled bitmaps) the nearest drawable form is used; the source keeps the
// original, so a save never loses it.

export const EMU_PER_PT = 12_700
const PX_PER_PT = 96 / 72

export type Attributes = ReadonlyMap<string, string>
export type DrawResources = ReadonlyMap<string, ReadonlyMap<string, OdfElement>>

// How a stream names its pictures ("Pictures/a.png", "./Object 1") as a part ("/Pictures/a.png"); undefined for an
// external link (never fetched) or a malformed one.
export function packagePart(href: string | undefined): string | undefined {
	if (href === undefined) return undefined

	const trimmed = href.trim()

	if (trimmed === "" || /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("..")) return undefined

	let path = trimmed.replace(/^\.\//u, "")

	try {
		path = decodeURIComponent(path)
	} catch {
		// A malformed escape is a literal name.
	}

	return `/${path.replace(/\/$/u, "")}`
}

export function srgb(value: string | undefined, alpha?: number): ColorModel | undefined {
	if (value === undefined) return undefined

	const match = /^#([0-9a-fA-F]{6})$/u.exec(value.trim())

	if (match === null) return undefined

	const rgb = (match[1] ?? "000000").toUpperCase()

	return alpha === undefined || alpha >= 100_000
		? { kind: "srgb", rgb }
		: { kind: "srgb", rgb, mods: [{ name: "alpha", value: Math.max(0, Math.round(alpha)) }] }
}

// An ODF percent (opacity) as 1/100,000; undefined when absent or malformed.
function fraction(value: string | undefined): number | undefined {
	const percent = parsePercent(value)

	return percent === undefined ? undefined : Math.min(100, Math.max(0, percent)) * 1000
}

function scaled(color: string | undefined, intensity: string | undefined): string | undefined {
	const percent = parsePercent(intensity)

	if (color === undefined || percent === undefined || percent >= 100) return color

	const match = /^#([0-9a-fA-F]{6})$/u.exec(color.trim())

	if (match === null) return color

	const value = parseInt(match[1] ?? "0", 16)
	const channel = (shift: number): string =>
		Math.round((((value >> shift) & 0xff) * Math.max(0, percent)) / 100)
			.toString(16)
			.padStart(2, "0")

	return `#${channel(16)}${channel(8)}${channel(0)}`
}

// draw:angle of a gradient or hatch in degrees: ODF 1.2 wrote tenths of a degree without a unit, ODF 1.3 an angle
// whose unit is optional; LibreOffice reads a bare number as tenths (as ODF 1.2 defined it).
function gradientAngle(value: string | undefined): number {
	if (value === undefined) return 0

	const match = /^\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*(deg|grad|rad)?\s*$/u.exec(value)

	if (match === null) return 0

	const number = Number(match[1])

	switch (match[2]) {
		case undefined:
			return number / 10
		case "grad":
			return (number * 360) / 400
		case "rad":
			return (number * 180) / Math.PI
		default:
			return number
	}
}

function normalizeDegrees(degrees: number): number {
	const out = degrees % 360

	return out < 0 ? out + 360 : out
}

// A gradient (§16.40 draw:gradient): linear and axial as a:lin (ODF's 0° runs top to bottom and turns
// counter-clockwise; DrawingML's runs left to right and turns clockwise), radial and ellipsoid as a circle path
// from the centre (the end colour) outwards (the start colour), square and rectangular as a rect path. draw:border
// is the share of the start colour before the blend begins.
function gradientFill(element: OdfElement, alpha: number | undefined): FillProps | undefined {
	const attributes = element.attributes
	const start = srgb(scaled(attributes.get("draw:start-color") ?? "#000000", attributes.get("draw:start-intensity")), alpha)
	const end = srgb(scaled(attributes.get("draw:end-color") ?? "#ffffff", attributes.get("draw:end-intensity")), alpha)

	if (start === undefined || end === undefined) return undefined

	const border = Math.min(100, Math.max(0, parsePercent(attributes.get("draw:border")) ?? 0)) * 1000
	const angle = gradientAngle(attributes.get("draw:angle"))
	const style = attributes.get("draw:style") ?? "linear"

	switch (style) {
		case "axial": {
			const half = border / 2

			return {
				kind: "gradient",
				stops: [
					{ pos: 0, color: start },
					...(half > 0 ? [{ pos: half, color: start }] : []),
					{ pos: 50_000, color: end },
					...(half > 0 ? [{ pos: 100_000 - half, color: start }] : []),
					{ pos: 100_000, color: start }
				],
				linear: { angle: Math.round(normalizeDegrees(90 - angle) * 60_000), scaled: false },
				rotWithShape: true
			}
		}
		case "radial":
		case "ellipsoid":
		case "square":
		case "rectangular": {
			const cx = Math.min(100, Math.max(0, parsePercent(attributes.get("draw:cx")) ?? 50)) * 1000
			const cy = Math.min(100, Math.max(0, parsePercent(attributes.get("draw:cy")) ?? 50)) * 1000

			return {
				kind: "gradient",
				stops: [
					{ pos: 0, color: end },
					...(border > 0 ? [{ pos: 100_000 - border, color: start }] : []),
					{ pos: 100_000, color: start }
				],
				path: {
					shape: style === "square" || style === "rectangular" ? "rect" : "circle",
					fillTo: { l: cx, t: cy, r: 100_000 - cx, b: 100_000 - cy }
				},
				rotWithShape: true
			}
		}
		default:
			return {
				kind: "gradient",
				stops: [{ pos: 0, color: start }, ...(border > 0 ? [{ pos: border, color: start }] : []), { pos: 100_000, color: end }],
				linear: { angle: Math.round(normalizeDegrees(90 - angle) * 60_000), scaled: false },
				rotWithShape: true
			}
	}
}

// A hatch (§16.41 draw:hatch) as the nearest DrawingML pattern: single lines by their angle, crossed ones as a
// cross; the background is the fill colour when draw:fill-hatch-solid says so, else transparent.
function hatchFill(element: OdfElement, background: ColorModel | undefined): FillProps | undefined {
	const color = srgb(element.attributes.get("draw:color") ?? "#000000")

	if (color === undefined) return undefined

	const rotation = normalizeDegrees(gradientAngle(element.attributes.get("draw:rotation"))) % 180
	const style = element.attributes.get("draw:style") ?? "single"
	const diagonal = Math.abs(rotation - 45) < 22.5 || Math.abs(rotation - 135) < 22.5
	let preset: string

	if (style === "double" || style === "triple") preset = diagonal ? "diagCross" : "cross"
	else if (!diagonal) preset = Math.abs(rotation - 90) < 22.5 ? "vert" : "horz"
	else preset = Math.abs(rotation - 45) < 22.5 ? "upDiag" : "dnDiag"

	return { kind: "pattern", preset, fg: color, bg: background ?? { kind: "srgb", rgb: "FFFFFF", mods: [{ name: "alpha", value: 0 }] } }
}

// A bitmap fill (§16.42 draw:fill-image, §20.236 style:repeat): stretched, tiled at its own size, or (no-repeat)
// stretched, the nearest DrawingML form.
function bitmapFill(element: OdfElement, attributes: Attributes): FillProps | undefined {
	const part = packagePart(element.attributes.get("xlink:href"))

	if (part === undefined) return undefined

	const repeat = attributes.get("style:repeat") ?? "repeat"

	if (repeat === "repeat") {
		const sx = parsePercent(attributes.get("draw:fill-image-width"))
		const sy = parsePercent(attributes.get("draw:fill-image-height"))

		return {
			kind: "picture",
			part,
			tile: {
				tx: 0,
				ty: 0,
				sx: (sx !== undefined && sx > 0 ? sx : 100) * 1000,
				sy: (sy !== undefined && sy > 0 ? sy : 100) * 1000,
				flip: "none",
				algn: "tl"
			}
		}
	}

	return { kind: "picture", part }
}

// The fill a graphic or drawing-page property set describes; undefined when it names none (draw:fill absent),
// "none" for draw:fill="none".
export function fillOf(properties: OdfProperties, resources: DrawResources): FillProps | "none" | undefined {
	const attributes = properties.attributes
	const fill = attributes.get("draw:fill")

	if (fill === undefined) return undefined

	const opacity = fraction(attributes.get("draw:opacity"))
	const alpha =
		opacity ??
		(fraction(attributes.get("draw:transparency")) === undefined
			? undefined
			: 100_000 - (fraction(attributes.get("draw:transparency")) ?? 0))

	switch (fill) {
		case "none":
			return "none"
		case "solid": {
			const color = srgb(attributes.get("draw:fill-color") ?? "#99ccff", alpha)

			return color === undefined ? "none" : { kind: "solid", color }
		}
		case "gradient": {
			const element = resources.get("draw:gradient")?.get(attributes.get("draw:fill-gradient-name") ?? "")

			return element === undefined ? "none" : (gradientFill(element, alpha) ?? "none")
		}
		case "hatch": {
			const element = resources.get("draw:hatch")?.get(attributes.get("draw:fill-hatch-name") ?? "")
			const background =
				attributes.get("draw:fill-hatch-solid") === "true" ? srgb(attributes.get("draw:fill-color") ?? "#99ccff", alpha) : undefined

			return element === undefined ? "none" : (hatchFill(element, background) ?? "none")
		}
		case "bitmap": {
			const element = resources.get("draw:fill-image")?.get(attributes.get("draw:fill-image-name") ?? "")

			return element === undefined ? "none" : (bitmapFill(element, attributes) ?? "none")
		}
		default:
			return undefined
	}
}

function endOf(name: string | undefined, width: string | undefined, lineWidth: number, resources: DrawResources): LineEnd | undefined {
	if (name === undefined || name === "") return undefined

	const marker = resources.get("draw:marker")?.get(name)
	const label = (marker?.attributes.get("draw:display-name") ?? name).toLowerCase()
	const type: LineEnd["type"] = /circle|oval|dot/u.test(label)
		? "oval"
		: /square|diamond/u.test(label)
			? "diamond"
			: /line|open/u.test(label)
				? "arrow"
				: /stealth|concave/u.test(label)
					? "stealth"
					: "triangle"
	const size = parseLength(width)
	const ratio = size === undefined ? 3 : size / Math.max(lineWidth, 0.75)
	const w: LineEnd["w"] = ratio < 2.5 ? "sm" : ratio < 4.5 ? "med" : "lg"

	return { type, w, len: w }
}

// A stroke dash (§16.43 draw:stroke-dash) as a:custDash (dash and space in 1/1,000 % of the line width).
function dashOf(element: OdfElement, lineWidth: number): Float64Array | undefined {
	const attributes = element.attributes
	const width = Math.max(lineWidth, 0.75)
	const length = (value: string | undefined): number => {
		const percent = parsePercent(value)

		if (percent !== undefined) return percent * 1000

		const points = parseLength(value)

		return points === undefined ? 100_000 : (points / width) * 100_000
	}
	const distance = length(attributes.get("draw:distance") ?? "100%")
	const out: number[] = []

	for (const [count, size] of [
		[attributes.get("draw:dots1"), attributes.get("draw:dots1-length")],
		[attributes.get("draw:dots2"), attributes.get("draw:dots2-length")]
	] as const) {
		const n = Math.min(64, Math.max(0, Number(count ?? "0") || 0))
		const dash = size === undefined ? 100_000 : length(size)

		for (let k = 0; k < n; k++) out.push(dash, distance)
	}

	return out.length === 0 ? undefined : Float64Array.from(out)
}

// The line a graphic property set describes; undefined when it names none.
export function lineOf(properties: OdfProperties, resources: DrawResources): LineProps | "none" | undefined {
	const attributes = properties.attributes
	const stroke = attributes.get("draw:stroke")
	const widthPoints = parseLength(attributes.get("svg:stroke-width"))

	if (stroke === undefined && widthPoints === undefined && !attributes.has("svg:stroke-color")) return undefined
	if (stroke === "none") return "none"

	const opacity = fraction(attributes.get("svg:stroke-opacity"))
	const color = srgb(attributes.get("svg:stroke-color") ?? "#3465a4", opacity)
	const width = widthPoints ?? 0
	const dash = stroke === "dash" ? resources.get("draw:stroke-dash")?.get(attributes.get("draw:stroke-dash") ?? "") : undefined
	const custDash = dash === undefined ? undefined : dashOf(dash, width)
	const join = attributes.get("draw:stroke-linejoin")
	const cap = attributes.get("svg:stroke-linecap")
	const head = endOf(attributes.get("draw:marker-start"), attributes.get("draw:marker-start-width"), width, resources)
	const tail = endOf(attributes.get("draw:marker-end"), attributes.get("draw:marker-end-width"), width, resources)

	return {
		// A hairline (width 0) is the thinnest line a renderer draws: 1 px.
		w: Math.round((width > 0 ? width : 0.75) * EMU_PER_PT),
		...(color === undefined ? {} : { fill: { kind: "solid" as const, color } }),
		...(custDash === undefined ? {} : { custDash }),
		...(join === "round"
			? { join: "round" as const }
			: join === "bevel"
				? { join: "bevel" as const }
				: join === "miter"
					? { join: "miter" as const }
					: {}),
		...(cap === "round"
			? { cap: "rnd" as const }
			: cap === "square"
				? { cap: "sq" as const }
				: cap === "butt"
					? { cap: "flat" as const }
					: {}),
		...(head === undefined ? {} : { head }),
		...(tail === undefined ? {} : { tail })
	}
}

// A shadow (§20.299 draw:shadow and its offsets, colour, opacity and blur) as a:outerShdw.
export function effectsOf(properties: OdfProperties): EffectList | undefined {
	const attributes = properties.attributes

	if (attributes.get("draw:shadow") !== "visible") return undefined

	const dx = parseLength(attributes.get("draw:shadow-offset-x")) ?? 0
	const dy = parseLength(attributes.get("draw:shadow-offset-y")) ?? 0
	const color = srgb(attributes.get("draw:shadow-color") ?? "#808080", fraction(attributes.get("draw:shadow-opacity")))
	const blur = parseLength(attributes.get("loext:shadow-blur") ?? attributes.get("draw:shadow-blur")) ?? 0

	if (color === undefined) return undefined

	const effect: Effect = {
		kind: "outerShdw",
		color,
		blurRad: Math.round(blur * EMU_PER_PT),
		dist: Math.round(Math.hypot(dx, dy) * EMU_PER_PT),
		dir: Math.round(normalizeDegrees((Math.atan2(dy, dx) * 180) / Math.PI) * 60_000),
		algn: "tl",
		rotWithShape: false
	}

	return { effects: [effect] }
}

const ANCHORS: Readonly<Record<string, TextBodyProps["anchor"]>> = { top: "t", middle: "ctr", bottom: "b", justify: "just" }

// The text area of a shape (§20.130 draw:textarea-vertical-align, §20.129 horizontal, §20.218 fo:padding,
// §20.119 draw:auto-grow-height, §20.143 draw:fit-to-size, §20.393 style:shrink-to-fit, §20.394 style:writing-mode)
// as a:bodyPr; insets in px as the text reader keeps them.
// `wrap`: what the shape's kind makes of fo:wrap-option (shapes.ts wrapOf); absent: the option as the chain says.
export function bodyPrOf(properties: OdfProperties, paragraph: OdfProperties | undefined, wrap?: boolean): Partial<TextBodyProps> {
	const attributes = properties.attributes
	const inset = (side: string): number => (parseLength(attributes.get(`fo:padding-${side}`)) ?? 0) * PX_PER_PT
	const anchor = ANCHORS[attributes.get("draw:textarea-vertical-align") ?? "top"] ?? "t"
	const fit = attributes.get("draw:fit-to-size")
	const shrink = attributes.get("style:shrink-to-fit") === "true" || fit === "shrink-to-fit"
	const writing = paragraph?.attributes.get("style:writing-mode") ?? attributes.get("style:writing-mode")
	const columns = properties.children.find(child => child.name === "style:columns")
	const count = Number(columns?.attributes.get("fo:column-count") ?? "1")

	return {
		insets: { left: inset("left"), top: inset("top"), right: inset("right"), bottom: inset("bottom") },
		anchor,
		anchorCenter: attributes.get("draw:textarea-horizontal-align") === "center",
		wrap: wrap ?? attributes.get("fo:wrap-option") !== "no-wrap",
		vertical: writing === "tb-rl" || writing === "tb" ? "vert" : writing === "tb-lr" ? "vert270" : "horz",
		autofit: shrink ? "normal" : attributes.get("draw:auto-grow-height") === "true" ? "shape" : "none",
		...(Number.isInteger(count) && count > 1
			? { columns: Math.min(16, count), columnSpacing: (parseLength(columns?.attributes.get("fo:column-gap")) ?? 0) * PX_PER_PT }
			: {})
	}
}
