import { runEffect, runEffectCss, runEmphasis } from "../layout/effects"
import { borderWidth } from "../layout/styles"
import { twips } from "../layout/units"
import type { ResolvedBorder, ResolvedRunProps, ResolvedShading } from "../props/index"
import type { ParagraphFormat } from "../styles/index"
import { shadingColor } from "../theme/color"

// Resolved paragraph and run properties as CSS for the reflowed view: the text's own look (fonts through their
// aliases, sizes, colours, emphasis, alignment, spacing, indents) without the page's geometry (no page widths,
// frames or exact line positions), so the text wraps to any width. Declarations only ("name: value; ..."), the
// same string for equal properties so a view can reuse it.

// The CSS font family list that draws Word's font `family` (the faces the document registered for it), or
// undefined when none is known (the family is then named as it is, with a generic fallback).
export type CssFaces = (family: string) => string | undefined

// Word's "single" line spacing as a multiple of the font size, close to what common faces draw.
const SINGLE_LINE = 1.15
// Indents never take more than this share of a narrow view's width.
const MAX_INDENT = "30%"
// Space before and after a paragraph with auto spacing (HTML's 14 pt).
const AUTO_SPACING_PX = (14 * 4) / 3
const FALLBACK = "var(--fo-reflow-font, sans-serif)"

const paragraphs = new WeakMap<ParagraphFormat, string>()
const runs = new WeakMap<ResolvedRunProps, Map<CssFaces | undefined, string>>()

function px(value: number): string {
	return `${String(Math.round(value * 100) / 100)}px`
}

function pt(value: number): string {
	return `${String(Math.round(value * 100) / 100)}pt`
}

function color(hex: string | undefined): string | undefined {
	return hex !== undefined && /^[0-9A-Fa-f]{6}$/.test(hex) ? `#${hex}` : undefined
}

const BORDER_STYLES: Readonly<Record<string, string>> = {
	single: "solid",
	thick: "solid",
	double: "double",
	triple: "double",
	dotted: "dotted",
	dashed: "dashed",
	dashSmallGap: "dashed",
	dotDash: "dashed",
	dotDotDash: "dotted",
	inset: "inset",
	outset: "outset",
	threeDEmboss: "ridge",
	threeDEngrave: "groove"
}

// A border as the pages draw it (its drawn width, its line style), or undefined for none.
export function borderCss(value: ResolvedBorder | undefined): string | undefined {
	if (value === undefined || value.style === "none" || value.style === "nil") return undefined

	return `${px(Math.max(1, borderWidth(value)))} ${BORDER_STYLES[value.style] ?? "solid"} ${color(value.color) ?? "currentColor"}`
}

// The flat colour a shading paints, or undefined for none.
export function shadingCss(shading: ResolvedShading | undefined): string | undefined {
	return shading === undefined ? undefined : color(shadingColor(shading.pattern, shading.color, shading.fill))
}

// A paragraph's declarations.
export function paragraphCss(format: ParagraphFormat): string {
	const cached = paragraphs.get(format)

	if (cached !== undefined) return cached

	const props = format.props
	const out: string[] = []
	const align = props.physicalAlignment === "distribute" ? "justify" : props.physicalAlignment

	if (props.bidi) out.push("direction: rtl")
	if (align !== "left") out.push(`text-align: ${align}`)

	const start = twips(props.indent.start)
	const end = twips(props.indent.end)
	const first = twips(props.indent.firstLine)

	// Each indent is capped (in a narrow table cell no indent pushes the text out of its box). A hanging first line
	// takes its room from the start indent, as Word draws it: never more than the start indent, so a capped first
	// line still starts in the box (the padding's share is of the cell, the hang's of the paragraph inside its
	// padding, never more), and a marker's room is the hang's share of the same box.
	const hang = first < 0 ? Math.min(-first, Math.max(0, start)) : 0
	const lead = start - hang
	const hangCss = `min(${px(hang)}, ${MAX_INDENT})`

	if (hang > 0) out.push(`padding-inline-start: ${lead > 0 ? `calc(min(${px(lead)}, ${MAX_INDENT}) + ${hangCss})` : hangCss}`)
	else if (start > 0) out.push(`padding-inline-start: min(${px(start)}, ${MAX_INDENT})`)

	if (end > 0) out.push(`padding-inline-end: min(${px(end)}, ${MAX_INDENT})`)

	if (first > 0) out.push(`text-indent: min(${px(first)}, ${MAX_INDENT})`)
	else if (hang > 0) out.push(`text-indent: calc(-1 * ${hangCss})`, `--fo-reflow-hang: ${hangCss}`)

	const spacing = props.spacing
	// Word adds the space after a paragraph to the space before the next (no collapsing): padding, not margins.
	const before = spacing.beforeAutospacing ? AUTO_SPACING_PX : twips(spacing.before)
	const after = spacing.afterAutospacing ? AUTO_SPACING_PX : twips(spacing.after)

	if (before > 0) out.push(`padding-top: ${px(before)}`)
	if (after > 0) out.push(`padding-bottom: ${px(after)}`)

	if (spacing.lineRule === "exact") out.push(`line-height: ${px(twips(spacing.line))}`)
	else if (spacing.lineRule === "atLeast") out.push(`line-height: max(${String(SINGLE_LINE)}em, ${px(twips(spacing.line))})`)
	else if (spacing.line > 0) out.push(`line-height: ${String(Math.round((spacing.line / 240) * SINGLE_LINE * 1000) / 1000)}`)

	const fill = shadingCss(props.shading)

	if (fill !== undefined) out.push(`background-color: ${fill}`)

	const borders = props.borders

	if (borders !== undefined) {
		for (const [side, value] of [
			["top", borders.top],
			["bottom", borders.bottom],
			["inline-start", borders.start],
			["inline-end", borders.end]
		] as const) {
			const css = borderCss(value)

			if (css !== undefined) out.push(`border-${side}: ${css}`)
		}
	}

	const css = out.join("; ")

	paragraphs.set(format, css)

	return css
}

const UNDERLINES: Readonly<Record<string, string>> = {
	double: "double",
	dotted: "dotted",
	dottedHeavy: "dotted",
	dash: "dashed",
	dashedHeavy: "dashed",
	dashLong: "dashed",
	dashLongHeavy: "dashed",
	dotDash: "dashed",
	dotDotDash: "dotted",
	wave: "wavy",
	wavyHeavy: "wavy",
	wavyDouble: "wavy"
}

// The name comes from the document: a quote or backslash would end or escape the string, and a line break or
// other control character would end it as a bad string, after which the rest reads as declarations.
function family(name: string, faces: CssFaces | undefined): string {
	const known = faces?.(name)

	if (known !== undefined) return known

	let quoted = ""

	for (const char of name) {
		const code = char.charCodeAt(0)

		if (code >= 0x20 && code !== 0x7f && char !== '"' && char !== "\\") quoted += char
	}

	return `"${quoted}"`
}

// A run's declarations within its paragraph; `faces` names the faces the document registered for its fonts.
export function runCss(run: ResolvedRunProps, faces?: CssFaces): string {
	let byFaces = runs.get(run)
	const cached = byFaces?.get(faces)

	if (cached !== undefined) return cached

	const out: string[] = []
	const complex = run.rtl || run.cs
	const fonts = run.fonts
	// Characters the main font lacks (East Asian, complex script) fall back to the run's fonts for them.
	const names = complex ? [fonts.cs, fonts.ascii, fonts.eastAsia] : [fonts.ascii, fonts.eastAsia, fonts.cs]
	const families = names.filter((name, k) => name.length > 0 && names.indexOf(name) === k)

	if (families.length > 0) out.push(`font-family: ${families.map(name => family(name, faces)).join(", ")}, ${FALLBACK}`)

	// Half-points.
	const size = (complex ? run.sizeCs : run.size) / 2
	const script = run.vertAlign !== "baseline"

	// Superscript and subscript at two thirds of the size, as Word draws them.
	if (size > 0) out.push(`font-size: ${pt(script ? (size * 2) / 3 : size)}`)
	if (script) out.push(`vertical-align: ${run.vertAlign === "superscript" ? "super" : "sub"}`)
	else if (run.position !== 0) out.push(`vertical-align: ${pt(run.position / 2)}`)

	if (complex ? run.boldCs : run.bold) out.push("font-weight: 700")
	if (complex ? run.italicCs : run.italic) out.push("font-style: italic")

	const lines: string[] = []
	let lineStyle: string | undefined

	if (run.underline !== undefined && run.underline.style !== "none") {
		lines.push("underline")
		lineStyle = UNDERLINES[run.underline.style]

		const underline = color(run.underline.color)

		if (underline !== undefined) out.push(`text-decoration-color: ${underline}`)
	}

	if (run.strike || run.doubleStrike) {
		lines.push("line-through")

		if (run.doubleStrike) lineStyle = "double"
	}

	if (lines.length > 0) out.push(`text-decoration-line: ${lines.join(" ")}`)
	if (lineStyle !== undefined) out.push(`text-decoration-style: ${lineStyle}`)

	if (run.caps) out.push("text-transform: uppercase")
	else if (run.smallCaps) out.push("font-variant-caps: small-caps")

	const text = color(run.color)

	if (text !== undefined) out.push(`color: ${text}`)

	const effects = runEffectCss(runEffect(run), runEmphasis(run))

	if (effects.length > 0) out.push(effects.slice(0, -1))

	const shading = run.shading
	const background =
		color(run.highlight) ?? (shading === undefined ? undefined : color(shadingColor(shading.pattern, shading.color, shading.fill)))

	if (background !== undefined) out.push(`background-color: ${background}`)
	if (run.spacing !== 0) out.push(`letter-spacing: ${px(twips(run.spacing))}`)

	const frame = borderCss(run.border)

	if (frame !== undefined) out.push(`border: ${frame}`)
	// Hidden text (w:vanish) is not shown, as Word shows it without formatting marks.
	if (run.vanish && !run.specVanish) out.push("display: none")

	const css = out.join("; ")

	if (byFaces === undefined) {
		byFaces = new Map()
		runs.set(run, byFaces)
	}

	byFaces.set(faces, css)

	return css
}
