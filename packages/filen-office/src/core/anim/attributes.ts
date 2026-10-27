// The attribute matrix: how each animatable attribute of ECMA-376 Part 1 §19.5 (the p:attrName values) reaches
// the screen, and the value machinery behind it (time-animate-value formulas, colour interpolation). The player
// (react/presentation/show) renders by the route; the timegraph samples values by it.
//   transform:  compositor transform on the layer bitmap (position, size, rotation, shear, scale, motion paths)
//   opacity:    compositor opacity on the bitmap
//   visibility: the layer shown or hidden
//   filter:     animEffect filters (fade, wipe…) as a clip-path or mask on the bitmap
//   fontSize:   the body laid out again at the sampled size (glyph positions are absolute in a TextPage)
//   dom:        the shape painted by its SVG/DOM layer for the effect's span (fill, stroke, text colour and style)
//   image:      CSS filters on the bitmap where exact, otherwise sampled re-renders

import type { Behavior } from "./model"

export type MediaBehavior = Extract<Behavior, { type: "audio" | "video" }>

// A media node (p:audio/p:video, anim:audio), the behaviours without a p:cBhvr.
export function isMediaBehavior(behavior: Behavior): behavior is MediaBehavior {
	return behavior.type === "audio" || behavior.type === "video"
}

export type AttributeRoute = "transform" | "opacity" | "visibility" | "filter" | "fontSize" | "dom" | "image"

// The transform channel an attribute drives.
export type TransformChannel = "x" | "y" | "w" | "h" | "rotation" | "xshear" | "yshear"

export interface AttributeEntry {
	readonly route: AttributeRoute
	readonly channel?: TransformChannel
	// The LayerState.dom field a dom attribute sets.
	readonly dom?: "fill" | "stroke" | "textColor" | "fontWeight" | "fontStyle" | "underline"
	// The attribute's name in ODF SMIL (LibreOffice's names for smil:attributeName).
	readonly odf: string
}

export const ATTRIBUTE_MATRIX: Readonly<Record<string, AttributeEntry>> = {
	ppt_x: { route: "transform", channel: "x", odf: "x" },
	ppt_y: { route: "transform", channel: "y", odf: "y" },
	ppt_w: { route: "transform", channel: "w", odf: "width" },
	ppt_h: { route: "transform", channel: "h", odf: "height" },
	r: { route: "transform", channel: "rotation", odf: "rotate" },
	"style.rotation": { route: "transform", channel: "rotation", odf: "rotate" },
	xshear: { route: "transform", channel: "xshear", odf: "skewX" },
	yshear: { route: "transform", channel: "yshear", odf: "skewY" },
	"style.opacity": { route: "opacity", odf: "opacity" },
	"fill.opacity": { route: "opacity", odf: "fill-opacity" },
	"style.visibility": { route: "visibility", odf: "visibility" },
	"style.fontSize": { route: "fontSize", odf: "font-size" },
	"fill.color": { route: "dom", dom: "fill", odf: "fill-color" },
	"fill.type": { route: "dom", odf: "fill" },
	"fill.on": { route: "dom", odf: "fill-on" },
	"stroke.color": { route: "dom", dom: "stroke", odf: "stroke-color" },
	"stroke.on": { route: "dom", odf: "stroke" },
	"style.color": { route: "dom", dom: "textColor", odf: "color" },
	"style.fontWeight": { route: "dom", dom: "fontWeight", odf: "font-weight" },
	"style.fontStyle": { route: "dom", dom: "fontStyle", odf: "font-style" },
	"style.textDecorationUnderline": { route: "dom", dom: "underline", odf: "text-underline" },
	"style.fontFamily": { route: "dom", odf: "font-family" },
	"style.textShadow": { route: "dom", odf: "text-shadow" },
	"shadow.on": { route: "dom", odf: "shadow" },
	"shadow.color": { route: "dom", odf: "shadow-color" },
	"shadow.offset": { route: "dom", odf: "shadow-offset" },
	"shadow.opacity": { route: "dom", odf: "shadow-opacity" },
	"shadow.type": { route: "dom", odf: "shadow-type" },
	"imageData.brightness": { route: "image", odf: "image-brightness" },
	"imageData.gamma": { route: "image", odf: "image-gamma" },
	"imageData.grayscale": { route: "image", odf: "image-grayscale" },
	"imageData.chromakey": { route: "image", odf: "image-chromakey" }
}

const BY_ODF = new Map<string, string>()

for (const [name, entry] of Object.entries(ATTRIBUTE_MATRIX)) if (!BY_ODF.has(entry.odf)) BY_ODF.set(entry.odf, name)

// "style.rotation" and "r" share ODF's "rotate"; reading takes the style form.
BY_ODF.set("rotate", "style.rotation")
// LibreOffice's own spellings of the same attributes (its UNO names, written by older versions).
for (const [lo, name] of [
	["X", "ppt_x"],
	["Y", "ppt_y"],
	["Width", "ppt_w"],
	["Height", "ppt_h"],
	["Rotate", "style.rotation"],
	["SkewX", "xshear"],
	["SkewY", "yshear"],
	["Opacity", "style.opacity"],
	["Visibility", "style.visibility"],
	["FillColor", "fill.color"],
	["FillStyle", "fill.type"],
	["LineColor", "stroke.color"],
	["LineStyle", "stroke.on"],
	["CharColor", "style.color"],
	["CharHeight", "style.fontSize"],
	["CharWeight", "style.fontWeight"],
	["CharPosture", "style.fontStyle"],
	["CharUnderline", "style.textDecorationUnderline"],
	["CharFontName", "style.fontFamily"]
] as const) {
	BY_ODF.set(lo, name)
}

export function attributeEntry(name: string): AttributeEntry | undefined {
	return ATTRIBUTE_MATRIX[name]
}

// The ECMA attribute an ODF smil:attributeName names, or undefined.
export function attributeFromOdf(name: string): string | undefined {
	return BY_ODF.get(name)
}

export function attributeToOdf(name: string): string | undefined {
	return ATTRIBUTE_MATRIX[name]?.odf
}

// --- Formulas (p:tav fmla and the formula syntax of time-animate values, §19.5) ---

// Variable slots of a compiled formula: $ (the interpolated value), then the shape's centre and size as fractions of
// the slide (ppt_x, ppt_y, ppt_w, ppt_h).
export const VAR_VALUE = 0
export const VAR_X = 1
export const VAR_Y = 2
export const VAR_W = 3
export const VAR_H = 4

export type Formula = (vars: Float64Array) => number

const VARIABLES: Readonly<Record<string, number>> = { $: VAR_VALUE, ppt_x: VAR_X, ppt_y: VAR_Y, ppt_w: VAR_W, ppt_h: VAR_H }

const FUNCTIONS1: Readonly<Record<string, (x: number) => number>> = {
	abs: Math.abs,
	acos: Math.acos,
	asin: Math.asin,
	atan: Math.atan,
	ceil: Math.ceil,
	cos: Math.cos,
	deg: x => (x * 180) / Math.PI,
	exp: Math.exp,
	floor: Math.floor,
	ln: Math.log,
	rad: x => (x * Math.PI) / 180,
	sin: Math.sin,
	sqrt: Math.sqrt,
	tan: Math.tan,
	// rand(x): a deterministic stand-in, so a sample is a function of time only.
	rand: x => x / 2
}

const FUNCTIONS2: Readonly<Record<string, (a: number, b: number) => number>> = { max: Math.max, min: Math.min }

// Compiles a formula ("#ppt_x+(cos(-2*pi*(1-$))*-#ppt_x)*(1-$)") into a function of the variables; undefined when it
// does not parse. Grammar: sum := product (('+'|'-') product)*; product := power (('*'|'/') power)*;
// power := unary ('^' power)?; unary := '-' unary | primary; primary := number | name | name '(' args ')' | '(' sum ')'.
export function compileFormula(text: string): Formula | undefined {
	const tokens = text.match(/\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?|#?[A-Za-z_$][A-Za-z_0-9.]*|\$|[-+*/^(),]/gu)

	if (tokens === null || tokens.join("") !== text.replace(/\s+/gu, "")) return undefined

	let at = 0
	const peek = (): string | undefined => tokens[at]
	const sum = (): Formula | undefined => {
		let left = product()

		while (left !== undefined && (peek() === "+" || peek() === "-")) {
			const op = tokens[at++]
			const right = product()

			if (right === undefined) return undefined

			const l: Formula = left

			left = op === "+" ? vars => l(vars) + right(vars) : vars => l(vars) - right(vars)
		}

		return left
	}
	const product = (): Formula | undefined => {
		let left = power()

		while (left !== undefined && (peek() === "*" || peek() === "/")) {
			const op = tokens[at++]
			const right = power()

			if (right === undefined) return undefined

			const l: Formula = left

			left = op === "*" ? vars => l(vars) * right(vars) : vars => l(vars) / right(vars)
		}

		return left
	}
	const power = (): Formula | undefined => {
		const base = unary()

		if (base === undefined || peek() !== "^") return base

		at++

		const exponent = power()

		return exponent === undefined ? undefined : vars => Math.pow(base(vars), exponent(vars))
	}
	const unary = (): Formula | undefined => {
		if (peek() === "-") {
			at++

			const inner = unary()

			return inner === undefined ? undefined : vars => -inner(vars)
		}

		if (peek() === "+") at++

		return primary()
	}
	const primary = (): Formula | undefined => {
		const token = tokens[at++]

		if (token === undefined) return undefined

		if (token === "(") {
			const inner = sum()

			if (tokens[at++] !== ")") return undefined

			return inner
		}

		if (/^[\d.]/u.test(token)) {
			const value = Number(token)

			return Number.isFinite(value) ? () => value : undefined
		}

		const name = token.startsWith("#") ? token.slice(1) : token
		const slot = VARIABLES[name]

		if (slot !== undefined) return vars => vars[slot] ?? 0
		if (name === "pi") return () => Math.PI
		if (name === "e") return () => Math.E

		if (peek() !== "(") return undefined

		at++

		const first = sum()

		if (first === undefined) return undefined

		const one = FUNCTIONS1[name]

		if (one !== undefined) {
			if (tokens[at++] !== ")") return undefined

			return vars => one(first(vars))
		}

		const two = FUNCTIONS2[name]

		if (two === undefined || tokens[at++] !== ",") return undefined

		const second = sum()

		if (second === undefined || tokens[at++] !== ")") return undefined

		return vars => two(first(vars), second(vars))
	}
	const formula = sum()

	return formula !== undefined && at === tokens.length ? formula : undefined
}

// --- Colours ---

export interface Hsl {
	// Degrees 0..360, saturation and lightness 0..1.
	h: number
	s: number
	l: number
}

export function rgbToHsl(rgba: number): Hsl {
	const r = ((rgba >>> 24) & 255) / 255
	const g = ((rgba >>> 16) & 255) / 255
	const b = ((rgba >>> 8) & 255) / 255
	const max = Math.max(r, g, b)
	const min = Math.min(r, g, b)
	const l = (max + min) / 2
	const d = max - min

	if (d === 0) return { h: 0, s: 0, l }

	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
	const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : max === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60

	return { h, s, l }
}

export function hslToRgba(hsl: Hsl, alpha: number = 255): number {
	const h = (((hsl.h % 360) + 360) % 360) / 360
	const s = Math.min(1, Math.max(0, hsl.s))
	const l = Math.min(1, Math.max(0, hsl.l))
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s
	const p = 2 * l - q
	const channel = (t: number): number => {
		const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t

		if (u < 1 / 6) return p + (q - p) * 6 * u
		if (u < 1 / 2) return q
		if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6

		return p
	}
	const r = s === 0 ? l : channel(h + 1 / 3)
	const g = s === 0 ? l : channel(h)
	const b = s === 0 ? l : channel(h - 1 / 3)

	return ((Math.round(r * 255) << 24) | (Math.round(g * 255) << 16) | (Math.round(b * 255) << 8) | (alpha & 255)) >>> 0
}

// RGB interpolation, channel by channel (clrSpc "rgb").
export function lerpRgb(from: number, to: number, t: number): number {
	let out = 0

	for (let shift = 24; shift >= 0; shift -= 8) {
		const a = (from >>> shift) & 255
		const b = (to >>> shift) & 255

		out = out * 256 + Math.round(a + (b - a) * t)
	}

	return out >>> 0
}

// HSL interpolation (p:animClr clrSpc "hsl" and dir): the hue turns clockwise (increasing) or counter-clockwise
// (decreasing) the way round `dir` names; saturation and lightness move linearly.
export function lerpHsl(from: number, to: number, t: number, dir: "cw" | "ccw"): number {
	const a = rgbToHsl(from)
	const b = rgbToHsl(to)
	let delta = b.h - a.h

	if (dir === "cw" && delta < 0) delta += 360
	if (dir === "ccw" && delta > 0) delta -= 360

	const alpha = Math.round((from & 255) + ((to & 255) - (from & 255)) * t)

	return hslToRgba({ h: a.h + delta * t, s: a.s + (b.s - a.s) * t, l: a.l + (b.l - a.l) * t }, alpha)
}

// A colour moved by an HSL offset (p:animClr p:by p:hsl: h in 1/60,000 degree, s and l in 1/1,000 percent) at `t`.
export function byHsl(from: number, by: { readonly h: number; readonly s: number; readonly l: number }, t: number): number {
	const a = rgbToHsl(from)

	return hslToRgba({ h: a.h + (by.h / 60000) * t, s: a.s + (by.s / 100000) * t, l: a.l + (by.l / 100000) * t }, from & 255)
}

// SMIL acceleration and deceleration (p:cTn accel/decel as fractions 0..1): the eased progress of `p`.
export function ease(p: number, accel: number, decel: number): number {
	if (accel <= 0 && decel <= 0) return p

	const total = accel + decel
	const a = total > 1 ? accel / total : accel
	const d = total > 1 ? decel / total : decel
	const rate = 1 / (1 - a / 2 - d / 2)

	if (p < a) return (rate * p * p) / (2 * a)
	if (p <= 1 - d) return rate * (p - a / 2)

	const rest = 1 - p

	return 1 - (rate * rest * rest) / (2 * d)
}
