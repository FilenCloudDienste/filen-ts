import { rgba, type Paint, type PatternPreset, type Rgba, type Stroke } from "../../drawingml/index"
import type { RenderEffect, RenderEffects } from "../output"
import type { ColorModel, EffectList, FillProps, LineProps } from "../model"

// Theme-relative text paint (the model's FillProps, LineProps, EffectList) resolved for painting: colours through
// the host's resolver, fills to drawingml Paints, a:ln to a Stroke, effects to RenderEffects in px.

const EMU_PER_PX = 9525
const BLACK = rgba("000000")

// Resolves a theme-relative colour (the host binds the slide's theme and colour map, core/presentation/theme.ts);
// undefined when it names no colour.
export type ColorResolver = (color: ColorModel) => Rgba | undefined

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

// A text fill as drawn: a solid colour stays a colour (DocxTextStyle.color plus alpha), anything else a Paint.
// A picture fill on text draws in its mean colour, which is unknown without decoding: the run's solid fallback
// (`fallback`) stands in, as LibreOffice 7.5 draws picture-filled text.
export type TextFill =
	{ readonly kind: "color"; readonly color: Rgba } | { readonly kind: "paint"; readonly paint: Paint } | { readonly kind: "none" }

export function resolveTextFill(fill: FillProps | "none", color: ColorResolver, fallback: Rgba): TextFill {
	if (fill === "none") return { kind: "none" }

	switch (fill.kind) {
		case "solid":
			return { kind: "color", color: color(fill.color) ?? fallback }
		case "gradient": {
			const stops = fill.stops
				.map(stop => [Math.min(1, Math.max(0, stop.pos / 100000)), color(stop.color) ?? fallback] as const)
				.sort((a, b) => a[0] - b[0])

			if (stops.length === 0) return { kind: "color", color: fallback }
			if (stops.length === 1) return { kind: "color", color: stops[0]?.[1] ?? fallback }

			const gradientStops = { offsets: Float32Array.from(stops, stop => stop[0]), colors: Uint32Array.from(stops, stop => stop[1]) }

			if (fill.path !== undefined) {
				const to = fill.path.fillTo

				return {
					kind: "paint",
					paint: {
						kind: "path",
						shape: fill.path.shape,
						stops: gradientStops,
						focus: { left: to.l / 100000, top: to.t / 100000, right: to.r / 100000, bottom: to.b / 100000 }
					}
				}
			}

			return {
				kind: "paint",
				paint: {
					kind: "linear",
					stops: gradientStops,
					angle: fill.linear === undefined ? 90 : fill.linear.angle / 60000,
					scaled: fill.linear?.scaled ?? false
				}
			}
		}
		case "pattern":
			return {
				kind: "paint",
				paint: {
					kind: "pattern",
					pattern: (PATTERNS.has(fill.preset) ? fill.preset : "pct50") as PatternPreset,
					foreground: color(fill.fg) ?? BLACK,
					background: color(fill.bg) ?? rgba("FFFFFF")
				}
			}
		case "picture":
		case "group":
			return { kind: "color", color: fallback }
	}
}

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

// a:ln on text as a Stroke whose paint is added through `paint` (it returns the index); undefined when the line
// draws nothing (noFill, or no fill and no colour to fall back on).
export function resolveTextLine(line: LineProps, color: ColorResolver, paint: (paint: Paint) => number): Stroke | undefined {
	const fill = line.fill

	if (fill === undefined || fill === "none") return undefined

	const resolved = resolveTextFill(fill, color, BLACK)

	if (resolved.kind === "none") return undefined

	// PowerPoint's default text outline width is 0.75 pt (9525 EMU) when a:ln@w is absent (ECMA: default 0 means
	// the thinnest line the device draws).
	const width = Math.max(0, (line.w ?? 9525) / EMU_PER_PX)
	const dash = line.dash ?? "solid"

	return {
		width,
		paint: paint(resolved.kind === "color" ? { kind: "solid", color: resolved.color } : resolved.paint),
		dash: (DASHES.has(dash) ? dash : "solid") as Stroke["dash"],
		customDash: line.custDash === undefined ? null : Float32Array.from(line.custDash, value => value / 100000),
		cap: line.cap === "rnd" ? "round" : line.cap === "sq" ? "square" : "flat",
		join: line.join ?? "round",
		miterLimit: 8,
		compound: line.compound ?? "sng",
		inset: line.align === "in"
	}
}

// Effects on text as drawn (px), the first of each kind. Effects PowerPoint applies only to shapes (softEdge on text is ignored by it) are
// kept; reflection and blur are painted by the canvas and SVG painters as far as they can.
export function resolveTextEffects(list: EffectList, color: ColorResolver): RenderEffects {
	const out: RenderEffect[] = []
	// One effect of each kind (CT_EffectList §20.1.8.26), whatever an edit or a reader hands in: each one drawn is a
	// filter pass.
	const seen = new Set<string>()

	for (const effect of list.effects) {
		if (seen.has(effect.kind)) continue

		seen.add(effect.kind)

		switch (effect.kind) {
			case "outerShdw":
			case "innerShdw": {
				const shadow = color(effect.color) ?? BLACK
				const angle = (effect.dir / 60000) * (Math.PI / 180)
				const distance = effect.dist / EMU_PER_PX

				out.push({
					kind: effect.kind === "outerShdw" ? "outerShadow" : "innerShadow",
					color: shadow,
					blur: effect.blurRad / EMU_PER_PX,
					dx: Math.cos(angle) * distance,
					dy: Math.sin(angle) * distance,
					sx: (effect.sx ?? 100000) / 100000,
					sy: (effect.sy ?? 100000) / 100000
				})

				break
			}
			case "prstShdw": {
				const shadow = color(effect.color) ?? BLACK
				const angle = (effect.dir / 60000) * (Math.PI / 180)
				const distance = effect.dist / EMU_PER_PX

				out.push({
					kind: "outerShadow",
					color: shadow,
					blur: 0,
					dx: Math.cos(angle) * distance,
					dy: Math.sin(angle) * distance,
					sx: 1,
					sy: 1
				})

				break
			}
			case "glow":
				out.push({ kind: "glow", color: color(effect.color) ?? BLACK, radius: effect.rad / EMU_PER_PX })
				break
			case "softEdge":
				out.push({ kind: "softEdge", radius: effect.rad / EMU_PER_PX })
				break
			case "blur":
				out.push({ kind: "blur", radius: effect.rad / EMU_PER_PX })
				break
			case "reflection":
				out.push({
					kind: "reflection",
					blur: effect.blurRad / EMU_PER_PX,
					startAlpha: effect.stA / 100000,
					endAlpha: effect.endA / 100000,
					endPos: effect.endPos / 100000,
					distance: effect.dist / EMU_PER_PX,
					direction: effect.dir / 60000
				})
				break
		}
	}

	return out
}
