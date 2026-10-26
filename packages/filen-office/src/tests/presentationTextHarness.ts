import { existsSync, readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { FontManager, readSfnt } from "../core/fonts/index"
import { bytesSource } from "../core/opc/index"
import { openPptx } from "../core/pptx/package"
import { resolveShape } from "../core/presentation/inherit"
import type { Deck, ShapeNode, SlideNode, SlideRef, TextBody, Xfrm } from "../core/presentation/model"
import { effectiveClrMap, resolveColor, themeOf, themeTypeface, toRgba, type PresentationTheme } from "../core/presentation/theme"
import { forEachDrawingSlotRun } from "../core/fonts/drawingSlots"
import { fontRequests, layoutBody, type BodyLayout, type TextEnvironment } from "../core/presentation/text/body"
import { resolveBody, shapeBodyContext, type BodyContext, type ResolvedBody, type TextFonts } from "../core/presentation/text/resolve"
import { MeasureCache, type FontExtents, type TextMeasurer } from "../core/text/index"
import { scriptForLanguage } from "../core/docx/theme/index"
import { evaluateGuides, presetProgram, textRect } from "../core/drawingml/geometry/evaluate"
import type { XmlDocument } from "../core/xml/index"
import { ASSETS } from "../scripts/fontTables"
import { ShapingFace } from "../core/pdfwrite/fonts/shape"
import { SCRIPT_CODES } from "../core/pdfwrite/fonts/shaping.generated"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"

// HmtxMeasurer reads a variable face's default instance, so bold and italic of Arimo and Gelasio would measure as
// regular: this one reads the static instances shipped for PDF export (<Family>-Bold.ttf.gz…) when they exist.
const STATIC = /^(italic )?(\d+) ([\d.]+)px "fotest-([a-z]+)", [a-z-]+$/
const staticFaces = new Map<string, ShapingFace | null>()
const LATIN = (SCRIPT_CODES as readonly string[]).indexOf("Latn")

function staticFace(family: string, bold: boolean, italic: boolean): ShapingFace | null {
	const name = `${family[0]?.toUpperCase() ?? ""}${family.slice(1)}-${bold ? (italic ? "BoldItalic" : "Bold") : italic ? "Italic" : "Regular"}.ttf.gz`
	const file = `${ASSETS}${family}/${name}`
	let face = staticFaces.get(file)

	if (face === undefined) {
		face = existsSync(file) ? new ShapingFace(readSfnt(new Uint8Array(gunzipSync(readFileSync(file))))) : null
		staticFaces.set(file, face)
	}

	return face
}

class StaticMeasurer implements TextMeasurer {
	readonly kerningControl = true
	private readonly fallback = new HmtxMeasurer()

	measure(font: string, kerning: boolean, texts: readonly string[], count: number, widths: Float64Array): void {
		const match = STATIC.exec(font)
		const face = match === null ? null : staticFace(match[4] ?? "", Number(match[2]) >= 600, match[1] !== undefined)

		if (match === null || face === null) {
			this.fallback.measure(font, kerning, texts, count, widths)

			return
		}

		const scale = Number(match[3]) / face.font.unitsPerEm

		// Shaped with the face's GPOS kerning when kerning is on, as the browser measures.
		for (let i = 0; i < count; i++) {
			const cps = Uint32Array.from(
				Array.from(texts[i] ?? "", char => {
					const code = char.codePointAt(0) ?? 0

					return code === 0xa0 ? 0x20 : code
				})
			)
			const clusters = Uint32Array.from(cps, (_, k) => k)

			widths[i] = kerning
				? face.shape({ cps, clusters, count: cps.length, before: [], after: [], script: LATIN, rtl: false, language: undefined })
						.width * scale
				: cps.reduce((sum, code) => sum + face.font.advanceOf(code), 0) * scale
		}
	}

	fontExtents(font: string): FontExtents {
		return this.fallback.fontExtents(font)
	}
}

// Text bodies of a pptx laid out without a browser (bundled OFL faces' hmtx advances), each with its inheritance
// chain and box from the renderer's own resolver (core/presentation/inherit.ts resolveShape and text/resolve.ts
// shapeBodyContext). For the LibreOffice oracle and the performance tests; groups, rotated and flipped shapes are
// left out (their boxes are the renderer's to place).

const EMU_PX = 9525

export interface LaidBody {
	readonly slide: number
	readonly shape: ShapeNode
	// The text box's top left on the slide (px) and its size.
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
	readonly resolved: ResolvedBody
	readonly result: BodyLayout
	// Every font the body's text draws with is a metric-compatible substitute of the one it names (or that font):
	// LibreOffice then lays out with the same advances.
	readonly compatibleFonts: boolean
}

export interface OpenedDeck {
	readonly deck: Deck
	readonly themes: Map<string, PresentationTheme | undefined>
	readonly environment: TextEnvironment
	readonly fonts: FontManager
	readonly theme: (part: string) => PresentationTheme | undefined
	readonly document: (part: string) => XmlDocument | undefined
}

export async function openDeck(file: string): Promise<OpenedDeck> {
	const opened = await openPptx(bytesSource(new Uint8Array(readFileSync(file))))

	if (opened.kind !== "opened") throw new Error(`${file}: ${opened.reason} ${opened.detail ?? ""}`)

	await opened.parts.parseAll()

	const fonts = new FontManager(nodeFontHost, nodeFontAssets, undefined, "fotest")
	const themes = new Map<string, PresentationTheme | undefined>()

	return {
		deck: opened.deck,
		themes,
		fonts,
		environment: { fonts, cache: new MeasureCache(new StaticMeasurer()) },
		document: part => opened.parts.document(part),
		theme: part => {
			if (!themes.has(part)) themes.set(part, opened.parts.theme(part))

			return themes.get(part)
		}
	}
}

export function fontsFor(deck: Deck, node: SlideNode, theme: PresentationTheme | undefined): TextFonts {
	const clrMap = effectiveClrMap(deck.nodes, node)

	return {
		color: color => {
			const resolved = resolveColor(color, { theme, clrMap })

			return resolved === undefined ? undefined : toRgba(resolved)
		},
		typeface: (typeface, lang) => themeTypeface(theme, typeface, scriptForLanguage(lang))
	}
}

function child(document: XmlDocument, node: number, local: string): number {
	for (let at = node < 0 ? -1 : document.firstChildElement(node); at >= 0; at = document.nextSiblingElement(at)) {
		if (document.localName(at) === local) return at
	}

	return -1
}

// The text rectangle of the shape's own preset geometry (a:prstGeom with its a:avLst), as [l, t, r, b] px inside
// the shape; the whole box for a rectangle or a shape without one.
function geometryRect(opened: OpenedDeck, shape: ShapeNode, xfrm: Xfrm): [number, number, number, number] {
	const whole: [number, number, number, number] = [0, 0, xfrm.cx / EMU_PX, xfrm.cy / EMU_PX]
	const src = shape.src

	if (src === undefined || src.format !== "pptx") return whole

	const document = opened.document(src.part)

	if (document === undefined) return whole

	const geometry = child(document, child(document, src.node, "spPr"), "prstGeom")
	const program = geometry < 0 ? undefined : presetProgram(document.attribute(geometry, "prst") ?? "rect")

	if (program === undefined) return whole

	const adjust = new Map<string, number>()

	for (let gd = document.firstChildElement(child(document, geometry, "avLst")); gd >= 0; gd = document.nextSiblingElement(gd)) {
		const value = /^val\s+(-?\d+)$/.exec(document.attribute(gd, "fmla") ?? "")

		if (value !== null) adjust.set(document.attribute(gd, "name") ?? "", Number(value[1]))
	}

	return textRect(
		program,
		evaluateGuides(program, xfrm.cx, xfrm.cy, name => adjust.get(name)),
		xfrm.cx,
		xfrm.cy
	)
}

// Every body of a slide with its context and box.
export function slideBodies(opened: OpenedDeck, ref: SlideRef): { context: BodyContext; shape: ShapeNode; xfrm: Xfrm; text: TextBody }[] {
	const deck = opened.deck
	const slide = deck.nodes.get(ref)

	if (slide === undefined) return []

	const themeRef = themeOf(deck.nodes, slide)
	const theme = themeRef === undefined ? undefined : opened.theme(themeRef.part)
	const fonts = fontsFor(deck, slide, theme)
	const out: { context: BodyContext; shape: ShapeNode; xfrm: Xfrm; text: TextBody }[] = []

	for (const shape of slide.shapes) {
		if (shape.hidden || shape.text === undefined || shape.text.paragraphs.length === 0) continue

		// The renderer's chain: inherit.ts resolveShape, and the text adapter's context built from it.
		const resolved = resolveShape(deck, ref, shape)
		const xfrm = resolved.xfrm

		if (xfrm === undefined || xfrm.rot !== 0 || xfrm.flipH || xfrm.flipV) continue

		out.push({ context: shapeBodyContext(deck, slide, shape, fonts, resolved.bodyPr), shape, xfrm, text: shape.text })
	}

	return out
}

export async function layoutSlide(opened: OpenedDeck, ref: SlideRef, slideNumber: number, now = new Date(2026, 0, 1)): Promise<LaidBody[]> {
	const out: LaidBody[] = []

	for (const { context, shape, xfrm, text } of slideBodies(opened, ref)) {
		const resolved = resolveBody(text, context)

		await opened.fonts.prepare(fontRequests(resolved))

		const insets = resolved.bodyPr.insets
		const [l, t, r, b] = geometryRect(opened, shape, xfrm)
		const width = Math.max(0, r - l - insets.left - insets.right)
		const height = Math.max(0, b - t - insets.top - insets.bottom)
		const result = layoutBody(resolved, { width, height }, opened.environment, { fields: { slideNumber, now } })

		const shown = result.page.page.sourceTexts.join("")
		const slots = new Set<string>(["ascii"])

		forEachDrawingSlotRun(shown, false, "latin", (_start, _end, slot) =>
			slots.add(slot === "ea" ? "eastAsia" : slot === "cs" ? "cs" : "ascii")
		)

		const compatibleFonts = fontRequests(resolved)
			.filter(request => slots.has(request.slot))
			.every(request => {
				const metrics = opened.fonts.resolve(request).metricsBasis

				return metrics === "original" || metrics === "font"
			})

		out.push({
			slide: slideNumber,
			shape,
			x: xfrm.x / EMU_PX + l + insets.left,
			y: xfrm.y / EMU_PX + t + insets.top,
			width,
			height,
			resolved,
			result,
			compatibleFonts
		})
	}

	return out
}
