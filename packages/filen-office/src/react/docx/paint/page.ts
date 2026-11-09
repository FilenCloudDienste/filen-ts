import { SOURCE_INTS, SOURCE_MARK_FLOATS, SourceInt, type DecorationValue } from "../../../core/docx/layout/index"
import { borderLines } from "../../../core/docx/layout/borderLines"
import { runEffectCss, type Emphasis, type RunEffect } from "../../../core/docx/layout/effects"
import { TurnInt, turnCss, turnMatrixAt, turnTransform, turnsOf, type TurnMatrix } from "../../../core/docx/layout/turns"
import {
	DECORATION_FLOATS,
	DECORATION_INTS,
	DecorationKind,
	FRAGMENT_FLOATS,
	FRAGMENT_INTS,
	FRAGMENT_KIND_MASK,
	FRAGMENT_LEVEL_SHIFT,
	FragmentFlag,
	FragmentKind,
	LINE_FLOATS,
	LINE_INTS,
	LineFlag,
	TabLeader
} from "../../../core/text/index"
import { LINK_INTS, type DocxPageData, type DocxTextStyle } from "../../../dom/docx/protocol"
import type { Paint, Stroke } from "../../../core/drawingml/index"
import type { RenderEffects } from "../../../core/presentation/output"
import type { DocxTables } from "../store"

// Paints one page's display list as DOM: real text in absolutely positioned spans (so selection, copy,
// find and screen readers work), boxes for fills, borders and decorations, and empty containers for
// objects, filled later from the session. Only numbers the layout produced and values checked here reach
// styles; document text reaches the DOM only as text nodes.

// The page's layers (Layer in the layout's output), bottom to top.
const LAYER_BEHIND = 0
const LAYER_TEXT = 1
const LAYER_FRONT = 2

const GRAPHIC_FLOATS = 4
const GRAPHIC_INTS = 3
const OBJECT_FLOATS = 4
const OBJECT_INTS = 3

const Graphic = {
	SHADING: 1,
	BORDER: 2,
	COLUMN_SEPARATOR: 3,
	NOTE_SEPARATOR: 4,
	REVISION_BAR: 5,
	DIAGONAL_DOWN: 6,
	DIAGONAL_UP: 7
} as const

const HEX = /^[0-9A-Fa-f]{6}$/
// cssFont() output: optional italic, weight, size, then an internal alias and a generic family, or a
// generic family alone.
const CSS_FONT =
	/^(?:italic )?\d{1,4} \d{1,5}(?:\.\d{1,3})? ?px (?:"[A-Za-z0-9_-]{1,128}", )?(?:serif|sans-serif|monospace|cursive|fantasy|system-ui)$/
const FALLBACK_FONT = "400 16px serif"
const MAX_PX = 1e6

export interface PaintedText {
	readonly element: HTMLElement
	readonly source: number
	readonly start: number
	readonly end: number
}

export interface PaintedObject {
	readonly element: HTMLElement
	readonly id: number
	readonly kind: number
	readonly width: number
	readonly height: number
}

// What a line looks like, wherever it is (see lineLook): numbers, the text it shows, and their hash.
export interface LineLook {
	readonly values: Float64Array
	readonly text: string
	readonly hash: number
}

// One painted line: its group in the text layer (spans and the copy separator) and the groups of its fills
// (under the text) and lines (over it), each positioned at the line's top so a line that only moved is
// moved by one style change.
export interface PaintedLine {
	readonly look: LineLook
	readonly top: number
	readonly text: HTMLElement
	readonly under: HTMLElement | undefined
	readonly over: HTMLElement | undefined
	readonly texts: readonly PaintedText[]
	// The CSS transform turning the line's groups sideways onto the page ("" for an upright line).
	turn: string
}

export interface PaintedPage {
	readonly root: HTMLElement
	// Text spans in reading order (for find highlights and selection mapping).
	readonly texts: readonly PaintedText[]
	readonly objects: readonly PaintedObject[]
	readonly lines: readonly PaintedLine[]
	readonly page: DocxPageData
	readonly parts: PageParts
}

// Containers of a painted page that patching swaps contents of.
interface PageParts {
	readonly fills: HTMLElement
	readonly textElements: HTMLElement
	readonly overLines: HTMLElement
	// Graphics per layer (behind, with the text, in front), and placed objects the same way.
	readonly graphics: readonly [HTMLElement, HTMLElement, HTMLElement]
	readonly objects: readonly [HTMLElement, HTMLElement, HTMLElement]
	readonly graphicsKey: string
	readonly objectsKey: string
}

function px(value: number | undefined): number {
	const v = value ?? 0

	return Number.isFinite(v) ? Math.max(-MAX_PX, Math.min(MAX_PX, Math.round(v * 100) / 100)) : 0
}

function hexColor(color: string | undefined): string {
	return color !== undefined && HEX.test(color) ? `#${color}` : "var(--fo-auto-text, #000)"
}

function cssFont(font: string): string {
	return CSS_FONT.test(font) ? font : FALLBACK_FONT
}

export interface StyleCss {
	// Declarations every span of the style starts with.
	readonly base: string
	readonly smallCapsFont: string
	readonly ascent: number
	readonly shift: number
	readonly color: string
}

const styleCss = new WeakMap<DocxTextStyle, StyleCss>()

export function cssOf(style: DocxTextStyle | undefined): StyleCss {
	if (style === undefined) {
		return {
			base: `font:${FALLBACK_FONT};line-height:20px;`,
			smallCapsFont: FALLBACK_FONT,
			ascent: 16,
			shift: 0,
			color: hexColor(undefined)
		}
	}

	let css = styleCss.get(style)

	if (css === undefined) {
		const ascent = Math.max(0, px(style.ascent))
		const height = Math.max(0, ascent + Math.max(0, px(style.descent)))
		const author = style.author ?? 0
		// Tracked changes in the Markup view take their author's colour (text, underline and strike alike).
		const color =
			style.revision !== 0 && author > 0 && author <= 8
				? `var(--fo-revision-${String(author)}, var(--fo-revision-mark, #000))`
				: style.color.length === 0
					? hexColor(undefined)
					: hexColor(style.color)
		let base = `font:${cssFont(style.font)};line-height:${height}px;color:${color};`

		if (!style.kerning) base += "font-kerning:none;"
		if (style.effect !== undefined || style.emphasis !== undefined) {
			base += runEffectCss((style.effect ?? 0) as RunEffect, (style.emphasis ?? 0) as Emphasis)
		}

		css = { base, smallCapsFont: cssFont(style.smallCapsFont), ascent, shift: px(style.shift), color }
		styleCss.set(style, css)
	}

	return css
}

const LEADER_STYLE: Readonly<Record<number, string>> = {
	[TabLeader.DOT]: "dotted",
	[TabLeader.MIDDLE_DOT]: "dotted",
	[TabLeader.HYPHEN]: "dashed",
	[TabLeader.UNDERSCORE]: "solid",
	[TabLeader.HEAVY]: "solid"
}

// Underline styles (ST_Underline) drawn as a box's top border; anything else is a solid bar.
function underlineBorder(style: string): string | undefined {
	if (style === "double" || style === "wavyDouble") return "double"
	if (style.startsWith("dotted") || style === "dotDotDash" || style === "dashDotDotHeavy") return "dotted"
	if (style.startsWith("dash") || style.startsWith("dotDash")) return "dashed"
	if (style.startsWith("wav")) return "solid"

	return undefined
}

function borderStyle(style: string): string {
	switch (style) {
		case "dotted":
			return "dotted"
		case "dashed":
		case "dashSmallGap":
		case "dotDash":
		case "dotDotDash":
			return "dashed"
		case "double":
		case "triple":
		case "thinThickSmallGap":
		case "thickThinSmallGap":
		case "thinThickMediumGap":
		case "thickThinMediumGap":
		case "thinThickLargeGap":
		case "thickThinLargeGap":
			return "double"
		case "none":
		case "nil":
			return "none"
		default:
			return "solid"
	}
}

// The lines of a multi-line border (borderLines) across a box as hard gradient stops: top to bottom, or left to
// right when `vertical`.
function borderStripes(lines: readonly number[], color: string, vertical: boolean): string {
	const stops: string[] = []
	let at = 0

	for (let k = 0; k < lines.length; k++) {
		const end = at + (lines[k] ?? 0)

		stops.push(`${k % 2 === 0 ? color : "transparent"} ${round(at * 100)}% ${round(end * 100)}%`)
		at = end
	}

	return `linear-gradient(${vertical ? "to right" : "to bottom"},${stops.join(",")})`
}

export interface PagePaintContext {
	readonly document: Document
	readonly tables: DocxTables
	// The tables DrawingML text styles index (DocxTextStyle.paint, .outline, .effects; a presentation TextPage's);
	// absent for documents, whose styles never set those fields.
	readonly paints?: TextPaintTables
}

export interface TextPaintTables {
	readonly paints: readonly Paint[]
	readonly strokes: readonly Stroke[]
	readonly textEffects: readonly RenderEffects[]
}

// 0xRRGGBBAA as a CSS colour.
function rgbaCss(color: number): string {
	const value = color >>> 0
	const alpha = Math.round(((value & 255) / 255) * 1000) / 1000

	return `rgba(${(value >>> 24) & 255},${(value >>> 16) & 255},${(value >>> 8) & 255},${alpha})`
}

function stopsCss(offsets: Float32Array, colors: Uint32Array): string {
	const out: string[] = []

	for (let k = 0; k < Math.min(offsets.length, colors.length); k++) {
		out.push(`${rgbaCss(colors[k] ?? 0)} ${round(Math.min(1, Math.max(0, offsets[k] ?? 0)) * 100)}%`)
	}

	return out.join(",")
}

// Share of the foreground in an 8×8 preset pattern tile: the pctN presets their N, the line and shape presets
// about half. Pattern-filled text is drawn in the blend, as the PDF painter draws patterns.
function patternShare(pattern: string): number {
	const percent = /^pct(\d+)$/.exec(pattern)

	return percent === null ? 0.5 : Number.parseInt(percent[1] ?? "50", 10) / 100
}

function blend(foreground: number, background: number, share: number): number {
	let out = 0

	for (const shift of [24, 16, 8, 0]) {
		const value = Math.round(((foreground >>> shift) & 255) * share + ((background >>> shift) & 255) * (1 - share))

		out = out * 256 + value
	}

	return out >>> 0
}

// The fill of glyphs as CSS: a gradient clipped to the text (background-clip: text), a pattern's blend, or a solid.
function paintCss(paint: Paint | undefined): string {
	if (paint === undefined) return ""

	switch (paint.kind) {
		case "solid":
			return `color:${rgbaCss(paint.color)};`
		case "linear": {
			// DrawingML angles run clockwise from +x; CSS gradient angles clockwise from "to top".
			const angle = round(paint.angle + 90)

			return `background-image:linear-gradient(${angle}deg,${stopsCss(paint.stops.offsets, paint.stops.colors)});${CLIP_TEXT}`
		}
		case "path": {
			const focusX = round(((paint.focus.left + (1 - paint.focus.right)) / 2) * 100)
			const focusY = round(((paint.focus.top + (1 - paint.focus.bottom)) / 2) * 100)
			const shape = paint.shape === "circle" ? "circle farthest-corner" : "ellipse farthest-side"

			return `background-image:radial-gradient(${shape} at ${focusX}% ${focusY}%,${stopsCss(paint.stops.offsets, paint.stops.colors)});${CLIP_TEXT}`
		}
		case "gradient":
			return `background-image:linear-gradient(90deg,${stopsCss(paint.stops.offsets, paint.stops.colors)});${CLIP_TEXT}`
		case "pattern":
			return `color:${rgbaCss(blend(paint.foreground, paint.background, patternShare(paint.pattern)))};`
		default:
			return ""
	}
}

const CLIP_TEXT = "-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;"

function strokeColor(stroke: Stroke, paints: readonly Paint[]): string {
	const paint = paints[stroke.paint]

	if (paint === undefined) return "currentColor"
	if (paint.kind === "solid") return rgbaCss(paint.color)
	if (paint.kind === "pattern") return rgbaCss(blend(paint.foreground, paint.background, patternShare(paint.pattern)))
	if (paint.kind === "linear" || paint.kind === "path" || paint.kind === "gradient") return rgbaCss(paint.stops.colors[0] ?? 0x000000ff)

	return "currentColor"
}

// Effects on glyphs as CSS: shadows and glow as text-shadow, blur as a filter, reflection where the engine has
// one (-webkit-box-reflect; Firefox draws none). Inner shadows and soft edges have no CSS for text: not drawn.
// Glyphs filled by a clipped background (`clipped`) have a transparent text fill, which a text-shadow would show
// through: their shadows are drop-shadow filters of the painted glyphs instead.
function effectsCss(effects: RenderEffects | undefined, clipped: boolean): string {
	if (effects === undefined || effects.length === 0) return ""

	const shadows: string[] = []
	let blur = ""
	let out = ""

	for (const effect of effects) {
		switch (effect.kind) {
			case "outerShadow":
				shadows.push(`${px(effect.dx)}px ${px(effect.dy)}px ${px(Math.max(0, effect.blur))}px ${rgbaCss(effect.color)}`)
				break
			case "glow":
				// A glow spreads its colour around the glyphs: two blurred copies at the radius.
				shadows.push(
					`0 0 ${px(Math.max(0, effect.radius))}px ${rgbaCss(effect.color)}`,
					`0 0 ${px(Math.max(0, effect.radius / 2))}px ${rgbaCss(effect.color)}`
				)
				break
			case "blur":
				blur = `blur(${px(Math.max(0, effect.radius) / 2)}px)`
				break
			case "reflection":
				out += `-webkit-box-reflect:below ${px(effect.distance)}px linear-gradient(transparent ${round((1 - effect.endPos) * 100)}%,rgba(0,0,0,${round(effect.startAlpha)}));`
				break
			default:
				break
		}
	}

	if (clipped) {
		const filters = shadows.map(shadow => `drop-shadow(${shadow})`)

		if (blur !== "") filters.push(blur)

		return filters.length === 0 ? out : `filter:${filters.join(" ")};${out}`
	}

	if (blur !== "") out = `filter:${blur};${out}`

	return shadows.length === 0 ? out : `text-shadow:${shadows.join(",")};${out}`
}

// Engines without -webkit-box-reflect (Firefox) get a text reflection as a mirrored, masked copy of the span: the
// same box flipped about distance / 2 below its bottom, faded by the mask the reflection would have. Decorative only.
let boxReflect: boolean | undefined

function engineReflects(document: Document): boolean {
	const css: unknown = document.defaultView === null ? undefined : Reflect.get(document.defaultView, "CSS")
	const supports: unknown = typeof css === "object" && css !== null ? Reflect.get(css, "supports") : undefined

	// Without CSS.supports there is no telling: the engine's own reflection (or none) stands.
	return typeof supports === "function" ? Reflect.apply(supports, css, ["-webkit-box-reflect", "below 0px"]) === true : true
}

function reflectionMirror(
	document: Document,
	span: HTMLElement,
	style: DocxTextStyle | undefined,
	tables: TextPaintTables | undefined
): HTMLElement | undefined {
	const effects = style?.effects === undefined ? undefined : tables?.textEffects[style.effects]
	const reflection = effects?.find(effect => effect.kind === "reflection")

	if (reflection === undefined || reflection.kind !== "reflection") return undefined

	boxReflect ??= engineReflects(document)

	if (boxReflect) return undefined

	const mirror = span.cloneNode(true) as HTMLElement
	const mask = `linear-gradient(transparent ${round((1 - reflection.endPos) * 100)}%,rgba(0,0,0,${round(reflection.startAlpha)}))`

	// Never focused, clicked or read: a link the span carries stays the span's.
	mirror.setAttribute("aria-hidden", "true")
	mirror.setAttribute("inert", "")
	// The flip is about y = 100% + distance / 2 of the span's own box. An upright cluster turns about its own origin:
	// the flip goes inside that turn, as -webkit-box-reflect draws it, written about the origin it keeps
	// (y -> 2 * (100% + distance / 2 - origin) - y).
	const origin = mirror.style.getPropertyValue("transform-origin")

	if (origin === "") {
		mirror.style.setProperty("transform-origin", `0 calc(100% + ${px(reflection.distance / 2)}px)`)
		mirror.style.setProperty("transform", `scaleY(-1) ${mirror.style.transform}`)
	} else {
		const originY = origin.split(" ")[1] ?? "0px"

		mirror.style.setProperty(
			"transform",
			`${mirror.style.transform} translateY(calc(200% + ${px(reflection.distance)}px - 2 * ${originY})) scaleY(-1)`
		)
	}

	mirror.style.setProperty("mask-image", mask)
	mirror.style.setProperty("pointer-events", "none")
	mirror.style.setProperty("user-select", "none")

	return mirror
}

const drawingCssCache = new WeakMap<DocxTextStyle, string>()

// The declarations a DrawingML style adds to its spans (paint, outline, effects, alpha); "" for a document's styles.
export function drawingTextCss(style: DocxTextStyle | undefined, tables: TextPaintTables | undefined): string {
	if (style === undefined || tables === undefined) return ""
	if (style.paint === undefined && style.outline === undefined && style.effects === undefined && style.alpha === undefined) return ""

	let css = drawingCssCache.get(style)

	if (css !== undefined) return css

	css = paintCss(style.paint === undefined ? undefined : tables.paints[style.paint])

	const stroke = style.outline === undefined ? undefined : tables.strokes[style.outline]

	if (stroke !== undefined && stroke.width > 0) {
		// Centred on the glyph outline and over the fill, as DrawingML a:ln draws text outlines.
		css += `-webkit-text-stroke:${px(stroke.width)}px ${strokeColor(stroke, tables.paints)};`
	}

	// Alpha of the glyph fill (a run with no fill is fully transparent, its outline still drawn).
	if (style.alpha !== undefined && style.paint === undefined) {
		const alpha = Math.min(1, Math.max(0, style.alpha))

		css += alpha === 0 ? "-webkit-text-fill-color:transparent;" : `color:${hexAlpha(style.color, alpha)};`
	}

	css += effectsCss(style.effects === undefined ? undefined : tables.textEffects[style.effects], css.includes(CLIP_TEXT))
	drawingCssCache.set(style, css)

	return css
}

function hexAlpha(color: string, alpha: number): string {
	if (!HEX.test(color)) return "var(--fo-auto-text, #000)"

	const value = Number.parseInt(color, 16)

	return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${round(alpha)})`
}

function box(document: Document, className: string, x: number, y: number, width: number, height: number, extra: string): HTMLElement {
	const element = document.createElement("div")

	element.className = className
	element.style.cssText = `left:${px(x)}px;top:${px(y)}px;width:${px(width)}px;height:${px(height)}px;${extra}`

	return element
}

function decorationColor(value: DecorationValue | undefined): string | undefined {
	if (value === undefined) return undefined

	switch (value.kind) {
		case "color":
			return HEX.test(value.color) ? `#${value.color}` : undefined
		case "underline":
		case "border":
			return value.color !== undefined && HEX.test(value.color) ? `#${value.color}` : undefined
		case "revision":
			return "var(--fo-revision-mark, #000)"
	}
}

// Paints a graphic (page fill, border line, rule) into its layer.
function paintGraphic(
	document: Document,
	layers: readonly HTMLElement[],
	page: DocxPageData,
	decorations: readonly DecorationValue[],
	index: number,
	turn?: TurnMatrix
): void {
	const f = index * GRAPHIC_FLOATS
	const i = index * GRAPHIC_INTS
	const x = page.graphicFloats[f] ?? 0
	const y = page.graphicFloats[f + 1] ?? 0
	const width = page.graphicFloats[f + 2] ?? 0
	const height = page.graphicFloats[f + 3] ?? 0
	const kind = page.graphicInts[i] ?? 0
	const value = decorations[(page.graphicInts[i + 1] ?? 0) - 1]
	const layer = layers[page.graphicInts[i + 2] ?? LAYER_TEXT] ?? layers[LAYER_TEXT]

	if (layer === undefined || !(width > 0 && height > 0)) return

	let extra: string

	switch (kind) {
		case Graphic.SHADING: {
			const color = decorationColor(value)

			if (color === undefined) return

			extra = `background:${color};`

			break
		}
		case Graphic.BORDER: {
			const color = decorationColor(value) ?? "var(--fo-auto-text, #000)"
			const style = value?.kind === "border" ? borderStyle(value.style) : "solid"
			const lines = value?.kind === "border" ? borderLines(value.style) : undefined

			if (style === "none") return

			// The box is the line itself: a thin side carries the stroke style, a multi-line border its lines as
			// hard gradient stops across the box.
			extra =
				lines !== undefined
					? `background:${borderStripes(lines, color, width < height)};`
					: style === "solid"
						? `background:${color};`
						: width >= height
							? `border-top:${px(height)}px ${style} ${color};height:0;`
							: `border-left:${px(width)}px ${style} ${color};width:0;`

			break
		}
		case Graphic.REVISION_BAR:
			extra = "background:var(--fo-revision-bar, #000);"

			break
		case Graphic.DIAGONAL_DOWN:
		case Graphic.DIAGONAL_UP: {
			// A line corner to corner of the box: the middle stop of a gradient towards the other two corners.
			const color = decorationColor(value) ?? "var(--fo-auto-text, #000)"
			const half = px(Math.max(1, value?.kind === "border" ? value.width : 1) / 2)
			const toward = kind === Graphic.DIAGONAL_DOWN ? "top" : "bottom"

			extra = `background:linear-gradient(to ${toward} right,transparent calc(50% - ${half}px),${color} calc(50% - ${half}px),${color} calc(50% + ${half}px),transparent calc(50% + ${half}px));`

			break
		}
		default:
			extra = "background:var(--fo-auto-text, #000);"
	}

	layer.appendChild(box(document, "fo-docx-box", x, y, width, height, turn === undefined ? extra : extra + turnCss(turn, x, y)))
}

// The style colour of the fragment under x on a line (for decorations drawn in the text's colour).
function colorAt(page: DocxPageData, styles: readonly DocxTextStyle[], line: number, x: number): string {
	const first = page.lineInts[line * LINE_INTS] ?? 0
	const count = page.lineInts[line * LINE_INTS + 1] ?? 0
	let style = -1

	for (let k = first; k < first + count; k++) {
		const fx = page.fragmentFloats[k * FRAGMENT_FLOATS] ?? 0

		if (fx > x + 0.5) break

		style = page.fragmentInts[k * FRAGMENT_INTS + 2] ?? -1
	}

	return cssOf(styles[style]).color
}

function paintDecoration(
	document: Document,
	layer: HTMLElement,
	page: DocxPageData,
	tables: DocxTables,
	index: number,
	under: boolean,
	// The y the layer is placed at (decorations are drawn relative to their line's group).
	originY: number
): void {
	const f = index * DECORATION_FLOATS
	const i = index * DECORATION_INTS
	const kind = page.decorationInts[i] ?? 0
	const isFill = kind === DecorationKind.SHADING || kind === DecorationKind.HIGHLIGHT

	// Fills go under the text, lines over it.
	if (isFill !== under) return

	const x = page.decorationFloats[f] ?? 0
	const y = (page.decorationFloats[f + 1] ?? 0) - originY
	let width = page.decorationFloats[f + 2] ?? 0
	const height = page.decorationFloats[f + 3] ?? 0
	const key = page.decorationInts[i + 1] ?? 0
	const line = page.decorationInts[i + 2] ?? 0
	const value = tables.decorations[key - 1]
	let extra: string

	switch (kind) {
		case DecorationKind.SHADING:
		case DecorationKind.HIGHLIGHT: {
			const color = decorationColor(value)

			if (color === undefined) return

			extra = `background:${color};`

			break
		}
		case DecorationKind.BORDER: {
			if (value?.kind !== "border") return

			const style = borderStyle(value.style)

			if (style === "none") return

			const color = decorationColor(value) ?? colorAt(page, tables.styles, line, x)
			const thickness = px(Math.max(1, value.width))
			const lines = borderLines(value.style)

			if (lines === undefined) {
				extra = `border:${thickness}px ${style} ${color};box-sizing:border-box;`

				break
			}

			// A multi-line border: each side's lines as a background layer along that side (top, bottom, left, right).
			const across = borderStripes(lines, color, false)
			const down = borderStripes(lines, color, true)

			extra =
				`background-image:${across},${across},${down},${down};background-position:top,bottom,left,right;` +
				`background-size:100% ${thickness}px,100% ${thickness}px,${thickness}px 100%,${thickness}px 100%;background-repeat:no-repeat;`

			break
		}
		case DecorationKind.UNDERLINE: {
			const color = decorationColor(value) ?? colorAt(page, tables.styles, line, x)
			const style = value?.kind === "underline" ? underlineBorder(value.style) : undefined

			extra =
				style === undefined
					? `background:${color};`
					: style === "double"
						? `border-top:${px(Math.max(1, height))}px solid ${color};border-bottom:${px(Math.max(1, height))}px solid ${color};height:${px(height)}px;box-sizing:content-box;`
						: `border-top:${px(Math.max(1, height))}px ${style} ${color};height:0;`

			break
		}
		case DecorationKind.STRIKE:
			extra = `background:${colorAt(page, tables.styles, line, x)};`

			break
		case DecorationKind.DOUBLE_STRIKE: {
			const color = colorAt(page, tables.styles, line, x)

			extra = `border-top:${px(height)}px solid ${color};border-bottom:${px(height)}px solid ${color};height:${px(height)}px;box-sizing:content-box;`

			break
		}
		case DecorationKind.BAR:
			width = Math.max(width, 1)
			extra = "background:var(--fo-auto-text, #000);"

			break
		default:
			return
	}

	layer.appendChild(box(document, "fo-docx-box", x, y, width, height, extra))
}

function isLowerCase(char: string): boolean {
	return char !== char.toUpperCase()
}

// Small caps: lower-case letters as capitals in the smaller face, the rest as is.
function appendSmallCaps(document: Document, span: HTMLElement, text: string, smallFont: string): void {
	let at = 0

	while (at < text.length) {
		const lower = isLowerCase(text.charAt(at))
		let end = at + 1

		while (end < text.length && isLowerCase(text.charAt(end)) === lower) end++

		const piece = text.slice(at, end)

		if (lower) {
			const small = document.createElement("span")

			small.style.font = smallFont
			small.style.textTransform = "uppercase"
			small.textContent = piece
			span.appendChild(small)
		} else {
			span.appendChild(document.createTextNode(piece))
		}

		at = end
	}
}

// Link ranges of the page by source, for marking fragments.
function linksBySource(page: DocxPageData): Map<number, number[]> {
	const out = new Map<number, number[]>()

	for (let k = 0; k < page.linkCount; k++) {
		const source = page.linkInts[k * LINK_INTS] ?? -1
		const list = out.get(source)

		if (list === undefined) out.set(source, [k])
		else list.push(k)
	}

	return out
}

// The fragment's text split at link boundaries: [start, end, link index or -1] pieces in order.
function linkPieces(page: DocxPageData, ranges: readonly number[] | undefined, start: number, end: number): [number, number, number][] {
	if (ranges === undefined) return [[start, end, -1]]

	const pieces: [number, number, number][] = []
	let at = start

	for (const k of ranges) {
		const from = Math.max(start, page.linkInts[k * LINK_INTS + 1] ?? 0)
		const to = Math.min(end, page.linkInts[k * LINK_INTS + 2] ?? 0)

		if (to <= from || from < at) continue
		if (from > at) pieces.push([at, from, -1])

		pieces.push([from, to, page.linkInts[k * LINK_INTS + 3] ?? -1])
		at = to
	}

	if (at < end) pieces.push([at, end, -1])

	return pieces
}

function markLink(element: HTMLElement, link: number, tables: DocxTables): void {
	const target = tables.links[link]

	if (target === undefined) return

	element.dataset["foLink"] = String(link)
	element.setAttribute("role", "link")
	element.tabIndex = 0

	if (target.tooltip !== undefined) element.title = target.tooltip
}

const SPACES = /^\s+$/

// What copying puts after a line: a newline at a paragraph end or break, nothing after a hyphenated line,
// else the spaces between this line's last character and the next line's first (a space at least).
function lineSeparator(page: DocxPageData, line: number, flags: number, text: string, end: number): string {
	if ((flags & (LineFlag.LAST | LineFlag.LINE_BREAK | LineFlag.PAGE_BREAK | LineFlag.COLUMN_BREAK)) !== 0) return "\n"
	if ((flags & LineFlag.HYPHENATED) !== 0) return ""

	const source = page.lineInts[line * LINE_INTS + 5]
	let next = page.lineInts[line * LINE_INTS + 3] ?? end

	for (let other = line + 1; other < page.lineCount; other++) {
		if (page.lineInts[other * LINE_INTS + 5] === source) {
			next = page.lineInts[other * LINE_INTS + 2] ?? next

			break
		}
	}

	const gap = text.slice(end, next)

	return SPACES.test(gap) ? gap : " "
}

// lineLook()'s output, reused line after line: its numbers, and the text it shows as [start, end) ranges of
// the line's source text.
let lookValues = new Float64Array(128)
let lookRanges = new Int32Array(32)
let lookRangeCount = 0
const HASH_BITS = new Float64Array(1)
const HASH_WORDS = new Uint32Array(HASH_BITS.buffer)

function lookValue(at: number, value: number): void {
	if (at >= lookValues.length) {
		const grown = new Float64Array(lookValues.length * 2)

		grown.set(lookValues)
		lookValues = grown
	}

	lookValues[at] = value
}

function lookRange(start: number, end: number): void {
	if (2 * lookRangeCount + 2 > lookRanges.length) {
		const grown = new Int32Array(lookRanges.length * 2)

		grown.set(lookRanges)
		lookRanges = grown
	}

	lookRanges[2 * lookRangeCount] = start
	lookRanges[2 * lookRangeCount + 1] = end
	lookRangeCount++
}

// What a line looks like, independent of where it is and of its text offsets: geometry relative to its top,
// fragments with their text, styles and links, decorations, and the separator copying adds after it. Written
// to lookValues (the count is returned) and lookRanges, so comparing a laid-out line with a painted one
// allocates nothing.
function lineLook(page: DocxPageData, line: number, links: Map<number, number[]>): number {
	const lf = line * LINE_FLOATS
	const li = line * LINE_INTS
	const top = page.lineFloats[lf] ?? 0
	const first = page.lineInts[li] ?? 0
	const count = page.lineInts[li + 1] ?? 0
	const flags = page.lineInts[li + 4] ?? 0
	const source = page.lineInts[li + 5] ?? -1
	const text = page.sourceTexts[source] ?? ""
	const sourceLinks = links.get(source)
	let n = 0
	let lastEnd = 0

	lookRangeCount = 0
	lookValue(n++, round(page.lineFloats[lf + 1]))
	lookValue(n++, round((page.lineFloats[lf + 2] ?? 0) - top))
	lookValue(n++, round(page.lineFloats[lf + 3]))
	lookValue(n++, round(page.lineFloats[lf + 4]))
	lookValue(n++, flags)
	lookValue(n++, count)
	// What formatting marks draw of the line besides its fragments: its paragraph's flags and edges.
	lookValue(n++, page.sourceInts[source * SOURCE_INTS + SourceInt.FLAGS] ?? 0)

	for (let m = 0; m < SOURCE_MARK_FLOATS; m++) {
		const value = page.sourceMarks?.[source * SOURCE_MARK_FLOATS + m] ?? Number.NaN

		lookValue(n++, Number.isNaN(value) ? -1e9 : round(value))
	}

	for (let k = first; k < first + count; k++) {
		const ff = k * FRAGMENT_FLOATS
		const fi = k * FRAGMENT_INTS
		const start = page.fragmentInts[fi] ?? 0
		const end = page.fragmentInts[fi + 1] ?? 0

		lastEnd = Math.max(lastEnd, end)

		for (let f = 0; f < 4; f++) lookValue(n++, round(page.fragmentFloats[ff + f]))
		for (let f = 2; f < 5; f++) lookValue(n++, page.fragmentInts[fi + f] ?? 0)

		lookValue(n++, Math.max(0, end - start))
		lookRange(start, end)

		// The linked pieces of the fragment (as linkPieces() splits it), as offsets in it.
		const counted = n++
		let pieces = 0
		let at = start

		for (const range of sourceLinks ?? NO_LINKS) {
			const from = Math.max(start, page.linkInts[range * LINK_INTS + 1] ?? 0)
			const to = Math.min(end, page.linkInts[range * LINK_INTS + 2] ?? 0)
			const link = page.linkInts[range * LINK_INTS + 3] ?? -1

			if (to <= from || from < at) continue

			at = to

			if (link < 0) continue

			lookValue(n++, link)
			lookValue(n++, from - start)
			lookValue(n++, to - start)
			pieces++
		}

		lookValue(counted, pieces)
	}

	const firstDecoration = page.lineInts[li + 6] ?? 0
	const lastDecoration = line + 1 < page.lineCount ? (page.lineInts[(line + 1) * LINE_INTS + 6] ?? 0) : page.decorationCount

	lookValue(n++, Math.max(0, lastDecoration - firstDecoration))

	for (let d = firstDecoration; d < lastDecoration; d++) {
		const df = d * DECORATION_FLOATS
		const di = d * DECORATION_INTS

		lookValue(n++, page.decorationInts[di] ?? 0)
		lookValue(n++, page.decorationInts[di + 1] ?? 0)
		lookValue(n++, round(page.decorationFloats[df]))
		lookValue(n++, round((page.decorationFloats[df + 1] ?? 0) - top))
		lookValue(n++, round(page.decorationFloats[df + 2]))
		lookValue(n++, round(page.decorationFloats[df + 3]))
	}

	// The separator (lineSeparator): a newline, nothing, the spaces after the line, or a space.
	const separator = separatorOf(page, line, flags, text, lastEnd)

	lookValue(n++, separator.kind)

	if (separator.kind === SEPARATOR_SPACES) lookRange(separator.start, separator.end)

	return n
}

const NO_LINKS: readonly number[] = []
const SEPARATOR_NEWLINE = 0
const SEPARATOR_NONE = 1
const SEPARATOR_SPACES = 2
const SEPARATOR_SPACE = 3
const SEPARATOR_SCRATCH = { kind: SEPARATOR_SPACE, start: 0, end: 0 }

// lineSeparator() as a kind and, for the spaces after the line, their range in the source text (one reused
// object: no string per line).
function separatorOf(page: DocxPageData, line: number, flags: number, text: string, end: number): typeof SEPARATOR_SCRATCH {
	const out = SEPARATOR_SCRATCH

	if ((flags & (LineFlag.LAST | LineFlag.LINE_BREAK | LineFlag.PAGE_BREAK | LineFlag.COLUMN_BREAK)) !== 0) {
		out.kind = SEPARATOR_NEWLINE
	} else if ((flags & LineFlag.HYPHENATED) !== 0) {
		out.kind = SEPARATOR_NONE
	} else {
		const source = page.lineInts[line * LINE_INTS + 5]
		let next = page.lineInts[line * LINE_INTS + 3] ?? end

		for (let other = line + 1; other < page.lineCount; other++) {
			if (page.lineInts[other * LINE_INTS + 5] === source) {
				next = page.lineInts[other * LINE_INTS + 2] ?? next

				break
			}
		}

		let spaces = next > end

		for (let k = end; k < next && spaces; k++) spaces = isSpace(text.charCodeAt(k))

		out.kind = spaces ? SEPARATOR_SPACES : SEPARATOR_SPACE
		out.start = end
		out.end = next
	}

	return out
}

// What SPACES matches (\s, as JavaScript defines it).
function isSpace(code: number): boolean {
	return (
		(code >= 0x09 && code <= 0x0d) ||
		code === 0x20 ||
		code === 0xa0 ||
		code === 0x1680 ||
		(code >= 0x2000 && code <= 0x200a) ||
		code === 0x2028 ||
		code === 0x2029 ||
		code === 0x202f ||
		code === 0x205f ||
		code === 0x3000 ||
		code === 0xfeff
	)
}

// The hash of lineLook()'s output for `line`, whose source text is `text` (FNV-1a over the numbers' bits and
// the text; a small integer).
function lookHash(count: number, text: string): number {
	let hash = 2166136261

	for (let k = 0; k < count; k++) {
		HASH_BITS[0] = lookValues[k] ?? 0
		hash = Math.imul(Math.imul(hash ^ (HASH_WORDS[0] ?? 0), 16777619) ^ (HASH_WORDS[1] ?? 0), 16777619)
	}

	for (let r = 0; r < lookRangeCount; r++) {
		const end = lookRanges[2 * r + 1] ?? 0

		for (let k = lookRanges[2 * r] ?? 0; k < end; k++) hash = Math.imul(hash ^ text.charCodeAt(k), 16777619)
	}

	return hash & 0x3fffffff
}

// Whether a painted line looks like lineLook()'s output (count numbers, text from `text`).
function sameLook(look: LineLook, hash: number, count: number, text: string): boolean {
	if (look.hash !== hash || look.values.length !== count) return false

	for (let k = 0; k < count; k++) if (look.values[k] !== lookValues[k]) return false

	let at = 0

	for (let r = 0; r < lookRangeCount; r++) {
		const end = lookRanges[2 * r + 1] ?? 0

		for (let k = lookRanges[2 * r] ?? 0; k < end; k++) if (look.text.charCodeAt(at++) !== text.charCodeAt(k)) return false
	}

	return at === look.text.length
}

// lineLook()'s output kept with a painted line.
function keptLook(hash: number, count: number, text: string): LineLook {
	let shown = ""

	for (let r = 0; r < lookRangeCount; r++) shown += text.slice(lookRanges[2 * r] ?? 0, lookRanges[2 * r + 1] ?? 0)

	return { values: lookValues.slice(0, count), text: shown, hash }
}

function round(value: number | undefined): number {
	return Math.round((value ?? 0) * 100) / 100
}

function arraysKey(...arrays: ArrayLike<number>[]): string {
	const out: string[] = []

	for (const array of arrays) out.push(Array.prototype.join.call(array, ","))

	return out.join("|")
}

function group(document: Document, top: number): HTMLElement {
	const element = document.createElement("div")

	element.className = "fo-docx-line"
	element.style.top = `${px(top)}px`

	return element
}

// Paints one line into new groups (positioned at its top).
function paintLine(
	document: Document,
	page: DocxPageData,
	tables: DocxTables,
	line: number,
	links: Map<number, number[]>,
	look: LineLook,
	paints?: TextPaintTables
): PaintedLine {
	const lf = line * LINE_FLOATS
	const li = line * LINE_INTS
	const lineTop = page.lineFloats[lf] ?? 0
	const baseline = (page.lineFloats[lf + 2] ?? 0) - lineTop
	const firstFragment = page.lineInts[li] ?? 0
	const fragmentCount = page.lineInts[li + 1] ?? 0
	const flags = page.lineInts[li + 4] ?? 0
	const source = page.lineInts[li + 5] ?? -1
	const text = page.sourceTexts[source] ?? ""
	const sourceLinks = links.get(source)
	const textGroup = group(document, lineTop)
	// The line's spans in logical (text) order: right-to-left runs are laid out visually, but copying and
	// screen readers follow the DOM.
	const lineTexts: PaintedText[] = []
	// Reflections drawn as copies (reflectionMirror), after the line's own spans.
	const mirrors: HTMLElement[] = []

	for (let k = firstFragment; k < firstFragment + fragmentCount; k++) {
		const ff = k * FRAGMENT_FLOATS
		const fi = k * FRAGMENT_INTS
		const start = page.fragmentInts[fi] ?? 0
		const end = page.fragmentInts[fi + 1] ?? 0
		const info = page.fragmentInts[fi + 3] ?? 0
		const kind = info & FRAGMENT_KIND_MASK

		if (kind === FragmentKind.OBJECT || end <= start) continue

		const x = page.fragmentFloats[ff] ?? 0
		const width = page.fragmentFloats[ff + 1] ?? 0
		const style = tables.styles[page.fragmentInts[fi + 2] ?? -1]
		const css = cssOf(style)
		const top = baseline - css.shift - css.ascent
		const span = document.createElement("span")

		if (kind === FragmentKind.TAB) {
			const leader = LEADER_STYLE[page.fragmentInts[fi + 4] ?? 0]

			span.className = "fo-docx-tab"
			span.style.cssText = `${css.base}left:${px(x)}px;top:${px(top)}px;width:${px(width)}px;`

			if (leader !== undefined) {
				const rule = document.createElement("span")

				rule.className = "fo-docx-leader"
				rule.style.cssText = `top:${px(css.ascent - 1)}px;border-bottom:1px ${leader} currentColor;`
				span.appendChild(rule)
			}

			span.appendChild(document.createTextNode("\t"))
		} else {
			let extra = `left:${px(x)}px;top:${px(top)}px;`
			const wordSpacing = page.fragmentFloats[ff + 2] ?? 0
			const letterSpacing = (style?.letterSpacing ?? 0) + (page.fragmentFloats[ff + 3] ?? 0)
			const scaleX = style?.scaleX ?? 1

			if (wordSpacing !== 0) extra += `word-spacing:${px(wordSpacing)}px;`
			if (letterSpacing !== 0) extra += `letter-spacing:${px(letterSpacing)}px;`
			const scaled = scaleX !== 1 && Number.isFinite(scaleX) && scaleX > 0 ? `scaleX(${Math.min(scaleX, 10)})` : ""

			// An upright cluster of sideways text: turned back about the centre of its box (the span's top is the
			// ascent above the baseline).
			if ((info & FragmentFlag.UPRIGHT) !== 0) {
				extra += `transform:rotate(-90deg) ${scaled};transform-origin:${px(width / 2)}px ${px((css.ascent + Math.max(0, px(style?.descent))) / 2)}px;`
			} else if (scaled.length > 0) {
				extra += `transform:${scaled};`
			}
			if ((info >> FRAGMENT_LEVEL_SHIFT) % 2 === 1) extra += "direction:rtl;unicode-bidi:bidi-override;"
			if ((info & FragmentFlag.CAPS) !== 0) extra += "text-transform:uppercase;"

			span.className = "fo-docx-run"
			span.style.cssText = css.base + extra + drawingTextCss(style, paints)

			const pieces = linkPieces(page, sourceLinks, start, end)
			const smallCaps = (info & FragmentFlag.SMALL_CAPS) !== 0

			// A link covering the whole fragment marks the span itself; a partial one becomes an inline child,
			// so the browser places it exactly where its text runs.
			for (const [from, to, link] of pieces) {
				const content = text.slice(from, to)
				const target = link >= 0 && pieces.length > 1 ? document.createElement("span") : span

				if (smallCaps) appendSmallCaps(document, target, content, css.smallCapsFont)
				else target.appendChild(document.createTextNode(content))

				if (link >= 0) markLink(target, link, tables)
				if (target !== span) span.appendChild(target)
			}

			if ((info & FragmentFlag.HYPHEN) !== 0) span.dataset["foHyphen"] = ""

			const mirror = reflectionMirror(document, span, style, paints)

			if (mirror !== undefined) mirrors.push(mirror)
		}

		lineTexts.push({ element: span, source, start, end })
	}

	lineTexts.sort((a, b) => a.start - b.start)

	for (const painted of lineTexts) textGroup.appendChild(painted.element)
	for (const mirror of mirrors) textGroup.appendChild(mirror)

	if (lineTexts.length > 0) {
		const separator = lineSeparator(page, line, flags, text, lineTexts[lineTexts.length - 1]?.end ?? 0)

		// Copying a selection keeps paragraph breaks, line breaks and the space a soft wrap swallowed.
		if (separator.length > 0) {
			const element = document.createElement("span")

			element.className = "fo-docx-eol"
			element.textContent = separator
			textGroup.appendChild(element)
		}
	}

	const firstDecoration = page.lineInts[li + 6] ?? 0
	const lastDecoration = line + 1 < page.lineCount ? (page.lineInts[(line + 1) * LINE_INTS + 6] ?? 0) : page.decorationCount
	let under: HTMLElement | undefined
	let over: HTMLElement | undefined

	for (let d = firstDecoration; d < lastDecoration; d++) {
		const fill = isFill(page, d)
		const target = fill ? (under ??= group(document, lineTop)) : (over ??= group(document, lineTop))

		paintDecoration(document, target, page, tables, d, fill, lineTop)
	}

	return { look, top: lineTop, text: textGroup, under, over, texts: lineTexts, turn: "" }
}

// The page's sideways text (layout/turns.ts): the turn each line and graphic is drawn through (-1 for none) and
// each turn's matrix; undefined for a page without, which then pays nothing for them.
interface PageTurns {
	readonly lines: Int32Array
	readonly graphics: Int32Array
	readonly matrices: readonly TurnMatrix[]
}

function pageTurns(page: DocxPageData): PageTurns | undefined {
	const count = page.turnCount ?? 0
	const floats = page.turnFloats
	const ints = page.turnInts

	if (count <= 0 || floats === undefined || ints === undefined) return undefined

	const lines = turnsOf(count, ints, page.lineCount, TurnInt.LINE_FROM)
	const graphics = turnsOf(count, ints, page.graphicCount, TurnInt.GRAPHIC_FROM)
	const matrices: TurnMatrix[] = []

	for (let t = 0; t < count; t++) matrices.push(turnMatrixAt(floats, ints, t))

	return lines === undefined || graphics === undefined ? undefined : { lines, graphics, matrices }
}

// Turns a line's groups (positioned at the page's left edge, at the line's top) through its turn, or back upright.
function turnLine(painted: PaintedLine, turns: PageTurns | undefined, line: number): void {
	const turn = turns?.lines[line] ?? -1
	const matrix = turn < 0 ? undefined : turns?.matrices[turn]
	const transform = matrix === undefined ? "" : turnTransform(matrix, 0, painted.top)

	if (painted.turn === transform) return

	painted.turn = transform

	for (const element of [painted.text, painted.under, painted.over]) {
		if (element === undefined) continue

		element.style.transform = transform
		element.style.transformOrigin = transform === "" ? "" : "0 0"
	}
}

function isFill(page: DocxPageData, decoration: number): boolean {
	const kind = page.decorationInts[decoration * DECORATION_INTS] ?? 0

	return kind === DecorationKind.SHADING || kind === DecorationKind.HIGHLIGHT
}

function paintGraphics(
	document: Document,
	page: DocxPageData,
	tables: DocxTables,
	into: readonly HTMLElement[],
	turns: PageTurns | undefined
): void {
	for (let g = 0; g < page.graphicCount; g++) {
		const turn = turns?.graphics[g] ?? -1

		paintGraphic(document, into, page, tables.decorations, g, turn < 0 ? undefined : turns?.matrices[turn])
	}
}

const NO_NUMBERS = new Int32Array(0)

// What the graphics and the placed objects are drawn from, to repaint them only when it changed.
function graphicsKeyOf(page: DocxPageData): string {
	return arraysKey(page.graphicFloats, page.graphicInts, page.turnFloats ?? NO_NUMBERS, page.turnInts ?? NO_NUMBERS)
}

function objectsKeyOf(page: DocxPageData): string {
	return arraysKey(
		page.objectFloats,
		page.objectInts,
		page.objectKinds,
		page.objectTurns ?? NO_NUMBERS,
		page.objectTurns === undefined ? NO_NUMBERS : (page.turnFloats ?? NO_NUMBERS)
	)
}

// How the page's objects and text box lines stack (CSS z-index in the page content's own stacking context): the
// behind layer's objects below the text, the front layer's above it, each in page order (the layout's stacking
// order), and a text box's lines right above their box. Inline objects and the rest of the page stay in document
// order at level 0; the behind layer's graphics go below its objects, as before.
interface Stacking {
	readonly objects: readonly string[]
	// Per source, "" when not text box text drawn with a box on this page.
	readonly sources: readonly string[]
	readonly behindGraphics: string
}

function stacking(page: DocxPageData): Stacking {
	const objects: string[] = []
	let behind = 0
	let front = 0

	for (let o = 0; o < page.objectCount; o++) {
		const layer = page.objectInts[o * OBJECT_INTS + 1] ?? LAYER_TEXT

		if (layer === LAYER_BEHIND) behind++
	}

	const boxes = new Map<number, string>()
	let seenBehind = 0

	for (let o = 0; o < page.objectCount; o++) {
		const layer = page.objectInts[o * OBJECT_INTS + 1] ?? LAYER_TEXT
		const id = page.objectInts[o * OBJECT_INTS] ?? -1
		const z = layer === LAYER_BEHIND ? -2 * (behind - seenBehind++) : layer === LAYER_FRONT ? 2 * front++ + 2 : 0

		objects.push(layer === LAYER_TEXT ? "" : String(z))

		if (!boxes.has(id)) boxes.set(id, String(z + 1))
	}

	const sources: string[] = []
	const owners = page.sourceOwners

	if (owners !== undefined) {
		for (let source = 0; source < page.sourceCount; source++) sources.push(boxes.get(owners[source] ?? -1) ?? "")
	}

	return { objects, sources, behindGraphics: behind > 0 ? String(-2 * behind - 1) : "" }
}

function stackLine(line: PaintedLine, z: string): void {
	if (line.text.style.zIndex !== z) line.text.style.zIndex = z
	if (line.under !== undefined && line.under.style.zIndex !== z) line.under.style.zIndex = z
	if (line.over !== undefined && line.over.style.zIndex !== z) line.over.style.zIndex = z
}

function paintPlaced(
	document: Document,
	page: DocxPageData,
	into: readonly [HTMLElement, HTMLElement, HTMLElement],
	stack: Stacking
): PaintedObject[] {
	const objects: PaintedObject[] = []
	const turns = page.objectTurns
	const turnFloats = page.turnFloats
	const turnInts = page.turnInts

	for (let o = 0; o < page.objectCount; o++) {
		const f = o * OBJECT_FLOATS
		const i = o * OBJECT_INTS
		const x = page.objectFloats[f] ?? 0
		const y = page.objectFloats[f + 1] ?? 0
		const width = page.objectFloats[f + 2] ?? 0
		const height = page.objectFloats[f + 3] ?? 0
		const turn = turns?.[o] ?? -1
		const extra =
			turn < 0 || turnFloats === undefined || turnInts === undefined ? "" : turnCss(turnMatrixAt(turnFloats, turnInts, turn), x, y)
		const element = box(document, "fo-docx-object", x, y, width, height, extra)
		const layer = page.objectInts[i + 1] ?? LAYER_TEXT
		const id = page.objectInts[i] ?? -1

		element.dataset["foObject"] = String(id)

		if ((stack.objects[o] ?? "") !== "") element.style.zIndex = stack.objects[o] ?? ""
		;(layer === LAYER_BEHIND ? into[0] : layer === LAYER_FRONT ? into[2] : into[1]).appendChild(element)
		objects.push({ element, id, kind: page.objectKinds[o] ?? 0, width, height })
	}

	return objects
}

function container(document: Document, className: string): HTMLElement {
	const element = document.createElement("div")

	element.className = className

	return element
}

export function paintPage(page: DocxPageData, context: PagePaintContext): PaintedPage {
	const { document, tables } = context
	const root = document.createElement("div")

	root.className = "fo-docx-page-content"
	root.style.cssText = `width:${px(page.width)}px;height:${px(page.height)}px;`

	const layers = [LAYER_BEHIND, LAYER_TEXT, LAYER_FRONT].map(layer => {
		const element = document.createElement("div")

		element.className = "fo-docx-layer"
		element.dataset["foLayer"] = String(layer)

		return element
	})
	const behind = layers[LAYER_BEHIND] ?? root
	const textLayer = layers[LAYER_TEXT] ?? root
	const front = layers[LAYER_FRONT] ?? root
	const fills = container(document, "fo-docx-layer")
	const textElements = container(document, "fo-docx-layer fo-docx-text")
	const overLines = container(document, "fo-docx-layer")
	const objectsLayer = container(document, "fo-docx-layer")
	const graphics: [HTMLElement, HTMLElement, HTMLElement] = [
		container(document, "fo-docx-layer"),
		container(document, "fo-docx-layer"),
		container(document, "fo-docx-layer")
	]
	const placed: [HTMLElement, HTMLElement, HTMLElement] = [
		container(document, "fo-docx-layer"),
		objectsLayer,
		container(document, "fo-docx-layer")
	]

	const turns = pageTurns(page)

	paintGraphics(document, page, tables, graphics, turns)

	const stack = stacking(page)
	const links = linksBySource(page)
	const lines: PaintedLine[] = []
	const texts: PaintedText[] = []

	graphics[0].style.zIndex = stack.behindGraphics

	for (let line = 0; line < page.lineCount; line++) {
		const count = lineLook(page, line, links)
		const source = page.lineInts[line * LINE_INTS + 5] ?? -1
		const text = page.sourceTexts[source] ?? ""
		const painted = paintLine(document, page, tables, line, links, keptLook(lookHash(count, text), count, text), context.paints)

		if (turns !== undefined) turnLine(painted, turns, line)

		stackLine(painted, stack.sources[source] ?? "")
		lines.push(painted)
		textElements.appendChild(painted.text)

		if (painted.under !== undefined) fills.appendChild(painted.under)
		if (painted.over !== undefined) overLines.appendChild(painted.over)

		for (const text of painted.texts) texts.push(text)
	}

	const objects = paintPlaced(document, page, placed, stack)

	fills.prepend(graphics[1])
	behind.append(graphics[0], placed[0])
	front.append(graphics[2], placed[2])
	textLayer.append(fills, textElements, overLines, objectsLayer)
	root.append(behind, textLayer, front)

	return {
		root,
		texts,
		objects,
		lines,
		page,
		parts: {
			fills,
			textElements,
			overLines,
			graphics,
			objects: placed,
			graphicsKey: graphicsKeyOf(page),
			objectsKey: objectsKeyOf(page)
		}
	}
}

// Brings a painted page to `page` (the same page laid out again) by repainting only the lines that look
// different and moving those that only moved; graphics and placed objects are repainted when they changed
// (`objectsChanged`: their boxes are new and need filling). Line-for-line it equals a fresh paintPage.
export function patchPage(
	painted: PaintedPage,
	page: DocxPageData,
	context: PagePaintContext
): { painted: PaintedPage; objectsChanged: boolean } {
	const { document, tables } = context
	const parts = painted.parts
	const links = linksBySource(page)
	const stack = stacking(page)
	const turns = pageTurns(page)
	const old = painted.lines
	// Painted lines by how they look (the hash of it): the first of each, and the next with the same hash.
	const firstByHash = new Map<number, number>()
	const nextSame = new Int32Array(old.length)
	const used = new Uint8Array(old.length)

	for (let index = old.length - 1; index >= 0; index--) {
		const hash = old[index]?.look.hash ?? 0

		nextSame[index] = firstByHash.get(hash) ?? -1
		firstByHash.set(hash, index)
	}

	// Of lines that look alike (repeated text, empty lines), the first after the last line kept: kept lines then
	// keep their order and stay where they are.
	let lastKept = -1
	const reuse = (hash: number, count: number, text: string): PaintedLine | undefined => {
		let first = -1

		for (let index = firstByHash.get(hash) ?? -1; index >= 0; index = nextSame[index] ?? -1) {
			const line = old[index]

			if (used[index] === 1 || line === undefined || !sameLook(line.look, hash, count, text)) continue

			if (first < 0) first = index

			if (index > lastKept) {
				first = index

				break
			}
		}

		if (first < 0) return undefined

		used[first] = 1
		lastKept = Math.max(lastKept, first)

		return old[first]
	}

	const lines: PaintedLine[] = []
	const texts: PaintedText[] = []

	for (let line = 0; line < page.lineCount; line++) {
		const count = lineLook(page, line, links)
		const source = page.lineInts[line * LINE_INTS + 5] ?? -1
		const text = page.sourceTexts[source] ?? ""
		const hash = lookHash(count, text)
		const kept = reuse(hash, count, text)
		const top = page.lineFloats[line * LINE_FLOATS] ?? 0
		let next: PaintedLine

		if (kept === undefined) {
			next = paintLine(document, page, tables, line, links, keptLook(hash, count, text), context.paints)
		} else {
			const start = page.lineInts[line * LINE_INTS + 2] ?? 0
			const shift = start - (kept.texts[0]?.start ?? start)

			if (kept.top !== top) {
				const value = `${px(top)}px`

				kept.text.style.top = value

				if (kept.under !== undefined) kept.under.style.top = value
				if (kept.over !== undefined) kept.over.style.top = value
			}

			// Where it was, showing the same offsets of the same source: as it was painted.
			next =
				kept.top === top && shift === 0 && kept.texts.every(painted => painted.source === source)
					? kept
					: {
							look: kept.look,
							top,
							text: kept.text,
							under: kept.under,
							over: kept.over,
							texts: kept.texts.map(text => ({
								element: text.element,
								source,
								start: text.start + shift,
								end: text.end + shift
							})),
							turn: kept.turn
						}
		}

		if (turns !== undefined || next.turn !== "") turnLine(next, turns, line)

		if (next.under !== undefined && next.under.parentNode !== parts.fills) parts.fills.appendChild(next.under)
		if (next.over !== undefined && next.over.parentNode !== parts.overLines) parts.overLines.appendChild(next.over)

		stackLine(next, stack.sources[source] ?? "")
		lines.push(next)

		for (const text of next.texts) texts.push(text)
	}

	// Lines that are gone, before the rest is put in order: kept lines then stay where they are (a line moved in
	// the DOM is styled and laid out again as if new).
	for (let index = 0; index < old.length; index++) {
		const line = old[index]

		if (used[index] === 1 || line === undefined) continue

		line.text.remove()
		line.under?.remove()
		line.over?.remove()
	}

	// Keep the text layer in reading order: new lines go where they belong.
	let previous: HTMLElement | null = null

	for (const line of lines) {
		const after: ChildNode | null = previous === null ? parts.textElements.firstChild : previous.nextSibling

		if (line.text !== after) parts.textElements.insertBefore(line.text, after)

		previous = line.text
	}

	const graphicsKey = graphicsKeyOf(page)

	if (graphicsKey !== parts.graphicsKey) {
		for (const element of parts.graphics) element.replaceChildren()

		paintGraphics(document, page, tables, parts.graphics, turns)
	}

	parts.graphics[0].style.zIndex = stack.behindGraphics

	const objectsKey = objectsKeyOf(page)
	const objectsChanged = objectsKey !== parts.objectsKey
	let objects = painted.objects

	if (objectsChanged) {
		for (const element of parts.objects) element.replaceChildren()

		objects = paintPlaced(document, page, parts.objects, stack)
	}

	painted.root.style.width = `${px(page.width)}px`
	painted.root.style.height = `${px(page.height)}px`

	return {
		painted: { root: painted.root, texts, objects, lines, page, parts: { ...parts, graphicsKey, objectsKey } },
		objectsChanged
	}
}
