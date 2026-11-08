import { MarkRoom } from "../../text/index"
import type { ResolvedRunProps } from "../props/types"

// Word's character effects (Font dialog, Effects) and East Asian emphasis marks as drawn, one source for the layout,
// the DOM page painter, the reflowed view and the PDF painter. Sizes are fractions of the em; not documented for
// Word, to calibrate.

// w:outline (§17.3.2.23), w:shadow (§17.3.2.31), both, w:emboss (§17.3.2.13), w:imprint (§17.3.2.18). Emboss and
// imprint exclude outline and shadow (and each other): emboss wins over imprint, either over outline and shadow.
export const RunEffect = { NONE: 0, OUTLINE: 1, SHADOW: 2, OUTLINE_SHADOW: 3, EMBOSS: 4, IMPRINT: 5 } as const

export type RunEffect = (typeof RunEffect)[keyof typeof RunEffect]

// w:em (§17.3.2.12, ST_Em): a mark over each character (dot, comma, circle) or under it (underDot).
export const Emphasis = { NONE: 0, DOT: 1, COMMA: 2, CIRCLE: 3, UNDER_DOT: 4 } as const

export type Emphasis = (typeof Emphasis)[keyof typeof Emphasis]

export function runEffect(run: ResolvedRunProps): RunEffect {
	if (run.emboss) return RunEffect.EMBOSS
	if (run.imprint) return RunEffect.IMPRINT
	if (run.outline) return run.shadow ? RunEffect.OUTLINE_SHADOW : RunEffect.OUTLINE

	return run.shadow ? RunEffect.SHADOW : RunEffect.NONE
}

export function runEmphasis(run: ResolvedRunProps): Emphasis {
	switch (run.emphasis) {
		case "dot":
			return Emphasis.DOT
		case "comma":
			return Emphasis.COMMA
		case "circle":
			return Emphasis.CIRCLE
		case "underDot":
			return Emphasis.UNDER_DOT
		default:
			return Emphasis.NONE
	}
}

// Where the line keeps room for a run's emphasis marks (core/text MARK_ROOM sizes it).
export function emphasisRoom(emphasis: Emphasis): MarkRoom {
	return emphasis === Emphasis.NONE ? MarkRoom.NONE : emphasis === Emphasis.UNDER_DOT ? MarkRoom.BELOW : MarkRoom.ABOVE
}

// Outline stroke width, shadow offset (down and right) and the emboss / imprint relief offset, em.
export const OUTLINE_WIDTH = 0.04
export const SHADOW_OFFSET = 0.06
export const RELIEF_OFFSET = 0.05

// 0xRRGGBBAA: the shadow, the relief's dark and light edges, and the fill of hollow and relief glyphs (the paper).
export const SHADOW_COLOR = 0x808080ff
export const RELIEF_DARK = 0x808080ff
export const RELIEF_LIGHT = 0xd9d9d9ff
export const PAPER = 0xffffffff

// An effect's offset copies drawn under the glyphs: em offsets (dx, dy, y down) and colour.
export interface EffectShadow {
	readonly dx: number
	readonly dy: number
	readonly color: number
}

const NO_SHADOWS: readonly EffectShadow[] = []
const SHADOW: readonly EffectShadow[] = [{ dx: SHADOW_OFFSET, dy: SHADOW_OFFSET, color: SHADOW_COLOR }]
// Raised: lit from the top left, its shadow down and to the right.
const EMBOSS: readonly EffectShadow[] = [
	{ dx: -RELIEF_OFFSET, dy: -RELIEF_OFFSET, color: RELIEF_LIGHT },
	{ dx: RELIEF_OFFSET, dy: RELIEF_OFFSET, color: RELIEF_DARK }
]
const IMPRINT: readonly EffectShadow[] = [
	{ dx: RELIEF_OFFSET, dy: RELIEF_OFFSET, color: RELIEF_LIGHT },
	{ dx: -RELIEF_OFFSET, dy: -RELIEF_OFFSET, color: RELIEF_DARK }
]

export function effectShadows(effect: RunEffect): readonly EffectShadow[] {
	switch (effect) {
		case RunEffect.SHADOW:
		case RunEffect.OUTLINE_SHADOW:
			return SHADOW
		case RunEffect.EMBOSS:
			return EMBOSS
		case RunEffect.IMPRINT:
			return IMPRINT
		default:
			return NO_SHADOWS
	}
}

// Glyphs drawn hollow (outline) or in the paper's colour (relief) rather than in the run's colour.
export function effectFillsPaper(effect: RunEffect): boolean {
	return effectStrokes(effect) || effect === RunEffect.EMBOSS || effect === RunEffect.IMPRINT
}

// Outline effects stroke the glyphs in the run's colour.
export function effectStrokes(effect: RunEffect): boolean {
	return effect === RunEffect.OUTLINE || effect === RunEffect.OUTLINE_SHADOW
}

function cssColor(rgba: number): string {
	return `#${(rgba >>> 8).toString(16).padStart(6, "0")}`
}

function em(value: number): string {
	return `${String(Math.round(value * 1000) / 1000)}em`
}

const effectCss = new Map<number, string>()

// CSS declarations of an effect and an emphasis mark (in em of the element's font, colours from currentColor), ""
// for neither. Each declaration ends with ";".
export function runEffectCss(effect: RunEffect, emphasis: Emphasis): string {
	const key = effect * 8 + emphasis
	let css = effectCss.get(key)

	if (css !== undefined) return css

	css = ""

	if (effectFillsPaper(effect)) css += `-webkit-text-fill-color:var(--fo-page-bg, ${cssColor(PAPER)});`
	if (effectStrokes(effect)) css += `-webkit-text-stroke:${em(OUTLINE_WIDTH)} currentColor;`

	const shadows = effectShadows(effect)

	if (shadows.length > 0) css += `text-shadow:${shadows.map(s => `${em(s.dx)} ${em(s.dy)} 0 ${cssColor(s.color)}`).join(",")};`

	switch (emphasis) {
		case Emphasis.DOT:
			css += "text-emphasis:filled dot;text-emphasis-position:over right;"
			break
		case Emphasis.COMMA:
			css += "text-emphasis:filled sesame;text-emphasis-position:over right;"
			break
		case Emphasis.CIRCLE:
			css += "text-emphasis:open circle;text-emphasis-position:over right;"
			break
		case Emphasis.UNDER_DOT:
			css += "text-emphasis:filled dot;text-emphasis-position:under right;"
			break
		default:
			break
	}

	effectCss.set(key, css)

	return css
}
