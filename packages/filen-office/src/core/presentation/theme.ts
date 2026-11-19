import { hexToRgb, hslToRgb, parseTheme, rgbToHex, rgbToHsl, type Rgb, type ThemeFontSet } from "../docx/theme/index"
import { rgba, type Rgba } from "../drawingml/index"
import { presetColor, systemColor } from "../drawingml/presetColors"
import type { XmlDocument } from "../xml/index"
import type { ClrMap, ClrMapKey, ColorMod, ColorModel, SchemeSlot, SlideNode, SlideRef } from "./model"

// Themes of a deck (a:theme parts, ECMA-376 Part 1 §20.1.6) and colour resolution: a ColorModel (as the source
// writes it, theme-relative) to a concrete colour, through the slide's colour map (p:clrMap on the master,
// p:clrMapOvr on layouts and slides, §19.3.1.6/.7) and the colour transforms of §20.1.2.3.

export interface PresentationTheme {
	readonly part: string
	readonly name: string | undefined
	// The twelve theme slots (dk1…folHlink) as six hex digits.
	readonly colors: ReadonlyMap<string, string>
	readonly major: ThemeFontSet
	readonly minor: ThemeFontSet
	// The part, for a:fmtScheme style references (the renderer reads fills, lines and effects from it).
	readonly document: XmlDocument
	readonly malformed: boolean
}

export function readTheme(part: string, document: XmlDocument): PresentationTheme {
	const theme = parseTheme(document)

	return {
		part,
		name: theme.name,
		colors: theme.colors,
		major: theme.major,
		minor: theme.minor,
		document,
		malformed: theme.malformed
	}
}

export const DEFAULT_CLR_MAP: ClrMap = {
	bg1: "lt1",
	tx1: "dk1",
	bg2: "lt2",
	tx2: "dk2",
	accent1: "accent1",
	accent2: "accent2",
	accent3: "accent3",
	accent4: "accent4",
	accent5: "accent5",
	accent6: "accent6",
	hlink: "hlink",
	folHlink: "folHlink"
}

export const CLR_MAP_KEYS: readonly ClrMapKey[] = [
	"bg1",
	"tx1",
	"bg2",
	"tx2",
	"accent1",
	"accent2",
	"accent3",
	"accent4",
	"accent5",
	"accent6",
	"hlink",
	"folHlink"
]

// The colour map in force on a node: its own override (clrMapOvr) when it has one, else up the chain to the
// master's clrMap (notes and handout masters carry their own).
export function effectiveClrMap(nodes: ReadonlyMap<SlideRef, SlideNode>, node: SlideNode): ClrMap {
	let at: SlideNode | undefined = node

	for (let guard = 0; at !== undefined && guard < 8; guard++) {
		if (at.clrMapOvr !== undefined && at.clrMapOvr !== "master") return at.clrMapOvr
		if (at.clrMap !== undefined) return at.clrMap

		at = at.parent === undefined ? undefined : nodes.get(at.parent)
	}

	return DEFAULT_CLR_MAP
}

// The theme of a node: its own (masters, notes and handout masters), else its master's.
export function themeOf(nodes: ReadonlyMap<SlideRef, SlideNode>, node: SlideNode): SlideNode["theme"] {
	let at: SlideNode | undefined = node

	for (let guard = 0; at !== undefined && guard < 8; guard++) {
		if (at.theme !== undefined) return at.theme

		at = at.parent === undefined ? undefined : nodes.get(at.parent)
	}

	return undefined
}

const MAPPED: ReadonlySet<string> = new Set(CLR_MAP_KEYS)

// A scheme slot as a theme slot: bg1/tx1/… through the colour map, the theme's own slots as they are.
export function themeSlot(slot: SchemeSlot, map: ClrMap): string | undefined {
	if (slot === "phClr") return undefined

	return MAPPED.has(slot) ? map[slot as ClrMapKey] : slot
}

export interface ColorContext {
	readonly theme: PresentationTheme | undefined
	readonly clrMap: ClrMap
	// The placeholder colour of a style-matrix reference (phClr), already resolved.
	readonly phClr?: ResolvedColor
}

export interface ResolvedColor {
	readonly hex: string
	// 0..1.
	readonly alpha: number
}

export { presetColor }

export function toRgba(color: ResolvedColor): Rgba {
	return rgba(color.hex, color.alpha)
}

function toLinear(channel: number): number {
	return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function fromLinear(channel: number): number {
	return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
}

function clamp01(value: number): number {
	return value < 0 ? 0 : value > 1 ? 1 : value
}

// Applies DrawingML colour transforms in document order (§20.1.2.3.1–.33). Percent values are 1/100,000, hue
// values 60,000ths of a degree. tint and shade blend in linear light, as the docx engine does; the component
// transforms (red…blueMod) work on linear RGB, as the spec defines them on scRGB.
export function applyMods(hex: string, alpha: number, mods: readonly ColorMod[]): ResolvedColor {
	let rgb: Rgb = hexToRgb(hex)
	let a = alpha

	for (const mod of mods) {
		const v = (mod.value ?? 0) / 100000

		switch (mod.name) {
			case "tint":
				rgb = mapRgb(rgb, c => fromLinear(toLinear(c) * v + (1 - v)))
				break
			case "shade":
				rgb = mapRgb(rgb, c => fromLinear(toLinear(c) * v))
				break
			case "comp":
				rgb = hsl(rgb, h => {
					h.h += 180
				})
				break
			case "inv":
				rgb = mapRgb(rgb, c => 1 - c)
				break
			case "gray": {
				const gray = 0.3 * rgb.r + 0.59 * rgb.g + 0.11 * rgb.b

				rgb = { r: gray, g: gray, b: gray }

				break
			}
			case "alpha":
				a = clamp01(v)
				break
			case "alphaOff":
				a = clamp01(a + v)
				break
			case "alphaMod":
				a = clamp01(a * v)
				break
			case "hue":
				rgb = hsl(rgb, h => {
					h.h = (mod.value ?? 0) / 60000
				})
				break
			case "hueOff":
				rgb = hsl(rgb, h => {
					h.h += (mod.value ?? 0) / 60000
				})
				break
			case "hueMod":
				rgb = hsl(rgb, h => {
					h.h *= v
				})
				break
			case "sat":
				rgb = hsl(rgb, h => {
					h.s = v
				})
				break
			case "satOff":
				rgb = hsl(rgb, h => {
					h.s += v
				})
				break
			case "satMod":
				rgb = hsl(rgb, h => {
					h.s *= v
				})
				break
			case "lum":
				rgb = hsl(rgb, h => {
					h.l = v
				})
				break
			case "lumOff":
				rgb = hsl(rgb, h => {
					h.l += v
				})
				break
			case "lumMod":
				rgb = hsl(rgb, h => {
					h.l *= v
				})
				break
			case "red":
			case "green":
			case "blue":
			case "redOff":
			case "greenOff":
			case "blueOff":
			case "redMod":
			case "greenMod":
			case "blueMod": {
				const channel = mod.name.startsWith("red") ? "r" : mod.name.startsWith("green") ? "g" : "b"
				const linear = toLinear(rgb[channel])
				const next = mod.name.endsWith("Off") ? linear + v : mod.name.endsWith("Mod") ? linear * v : v

				rgb = { ...rgb, [channel]: fromLinear(clamp01(next)) }

				break
			}
			case "gamma":
				rgb = mapRgb(rgb, fromLinear)
				break
			case "invGamma":
				rgb = mapRgb(rgb, toLinear)
				break
		}
	}

	return { hex: rgbToHex(rgb), alpha: a }
}

function mapRgb(rgb: Rgb, f: (channel: number) => number): Rgb {
	return { r: clamp01(f(rgb.r)), g: clamp01(f(rgb.g)), b: clamp01(f(rgb.b)) }
}

function hsl(rgb: Rgb, f: (value: { h: number; s: number; l: number }) => void): Rgb {
	const value = rgbToHsl(rgb)

	f(value)
	value.s = clamp01(value.s)
	value.l = clamp01(value.l)

	return hslToRgb(value)
}

// A ColorModel as a concrete colour, or undefined when its slot has no colour (a theme without it, phClr outside
// a style reference).
export function resolveColor(color: ColorModel, context: ColorContext): ResolvedColor | undefined {
	let base: ResolvedColor | undefined

	switch (color.kind) {
		case "srgb":
			base = /^[0-9A-Fa-f]{6}$/u.test(color.rgb) ? { hex: color.rgb.toUpperCase(), alpha: 1 } : undefined
			break
		case "preset": {
			const hex = presetColor(color.name)

			base = hex === undefined ? undefined : { hex, alpha: 1 }

			break
		}
		case "system": {
			const hex =
				color.lastColor !== undefined && /^[0-9A-Fa-f]{6}$/u.test(color.lastColor)
					? color.lastColor.toUpperCase()
					: systemColor(color.name)

			base = hex === undefined ? undefined : { hex, alpha: 1 }

			break
		}
		case "scheme": {
			if (color.slot === "phClr") {
				base = context.phClr
			} else {
				const slot = themeSlot(color.slot, context.clrMap)
				const hex = slot === undefined ? undefined : context.theme?.colors.get(slot)

				base = hex === undefined ? undefined : { hex, alpha: 1 }
			}

			break
		}
	}

	if (base === undefined) return undefined

	return color.mods === undefined || color.mods.length === 0 ? base : applyMods(base.hex, base.alpha, color.mods)
}

// The typeface behind a theme font reference (+mj-lt, +mn-ea, +mj-cs…, §20.1.4.1.16–.25), or the typeface itself.
// `script`: the ISO 15924 code for a:font script overrides (Jpan, Hans…), when the run's language has one.
export function themeTypeface(theme: PresentationTheme | undefined, typeface: string, script?: string): string | undefined {
	if (!typeface.startsWith("+")) return typeface === "" ? undefined : typeface

	const match = /^\+(mj|mn)-(lt|ea|cs)$/u.exec(typeface)

	if (match === null || theme === undefined) return undefined

	const set = match[1] === "mj" ? theme.major : theme.minor
	const slot = match[2]
	const scripted = slot === "lt" || script === undefined ? undefined : set.scripts.get(script)
	const face = scripted ?? (slot === "lt" ? set.latin : slot === "ea" ? set.eastAsia : set.complex)

	return face === "" ? undefined : face
}
