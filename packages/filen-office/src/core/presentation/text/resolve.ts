import type { TextBodyProps } from "../../drawingml/index"
import { listLevel, masterTextStyle, paraPropsOver, resolveBodyPr, resolveShape, runPropsOver } from "../inherit"
import type { ColorModel, Deck, ListStyle, ParaProps, Run, RunProps, ShapeNode, SlideNode, TextBody } from "../model"
import type { TableTextStyle } from "../render/services"
import type { ColorResolver } from "./color"

// Text properties resolved along the inheritance chain (MS-OI29500 §2.1.1127; plan §1.3): level by level and
// property by property, the nearest level that writes a property wins. core/presentation/inherit.ts decides which
// list styles and body properties the chain holds for a shape and owns the merges; this module orders them for a
// body, so the renderer, the editor's layoutText and the tests resolve a body the same way.

// What a shape's text inherits, outermost (weakest) first.
export interface BodyContext {
	// The list styles of the chain, weakest first: the presentation's defaultTextStyle, the master's
	// txStyles entry, then the master and layout placeholders' lstStyles. The body's own lstStyle and its
	// paragraphs' pPr go on top.
	readonly listStyles: readonly ListStyle[]
	// a:bodyPr of the chain, weakest first (master placeholder, layout placeholder); the body's own on top.
	readonly bodyPr: readonly Partial<TextBodyProps>[]
	// The shape's p:style/a:fontRef (non-placeholder shapes): its font and colour, applied over the list styles
	// before index `above`. It belongs over the presentation's defaultTextStyle and the master's otherStyle
	// (above = their count), under the body's own lstStyle and run properties: measured on LibreOffice 7.5's
	// renders of the corpus, where all 150 text bodies whose fontRef colour differs from the colour those styles give
	// show the fontRef colour (and PowerPoint's default shapes draw white text on accent fills the same way).
	readonly fontRef?: { readonly font: "major" | "minor" | "none"; readonly color?: ColorModel; readonly above: number }
	readonly fonts: TextFonts
}

// The host's theme bindings for one shape (core/presentation/theme.ts over the slide's theme and colour map).
export interface TextFonts {
	readonly color: ColorResolver
	// A typeface with theme references (+mj-lt, +mn-ea…) resolved, for the run's language (a:font script
	// overrides); undefined when it names none.
	readonly typeface: (typeface: string, lang: string | undefined) => string | undefined
}

export interface ResolvedParagraph {
	readonly level: number
	// Every paragraph property of the chain merged (defRPr merged into each run instead).
	readonly pPr: ParaProps
	readonly runs: readonly Run[]
	// The paragraph mark's properties: the end-of-paragraph rPr over the paragraph's defaults.
	readonly endRPr: RunProps
	// The run properties the paragraph's level gives its runs (for the bullet's "follow text" choices of an empty
	// paragraph, and the first run's size for the spacing).
	readonly defRPr: RunProps
}

export interface ResolvedBody {
	readonly bodyPr: TextBodyProps
	readonly paragraphs: readonly ResolvedParagraph[]
	readonly fonts: TextFonts
}

// The paragraph properties of `level` along the chain, the body's own lstStyle included.
export function chainParaProps(context: BodyContext, own: ListStyle | undefined, level: number): ParaProps {
	let props: ParaProps = {}
	const fontRef = context.fontRef
	const fontRefProps = fontRef === undefined ? undefined : fontRefRunProps(fontRef.font, fontRef.color)

	context.listStyles.forEach((style, index) => {
		if (fontRef !== undefined && index === fontRef.above) props = paraPropsOver(props, { defRPr: fontRefProps ?? {} })

		props = paraPropsOver(props, listLevel(style, level))
	})

	if (fontRef !== undefined && fontRef.above >= context.listStyles.length) props = paraPropsOver(props, { defRPr: fontRefProps ?? {} })

	return paraPropsOver(props, listLevel(own, level))
}

function fontRefRunProps(font: "major" | "minor" | "none", color: ColorModel | undefined): RunProps {
	const typeface = font === "major" ? "+mj-lt" : font === "minor" ? "+mn-lt" : undefined
	const eastAsia = font === "major" ? "+mj-ea" : font === "minor" ? "+mn-ea" : undefined
	const complex = font === "major" ? "+mj-cs" : font === "minor" ? "+mn-cs" : undefined

	return {
		...(typeface === undefined ? {} : { latin: { typeface } }),
		...(eastAsia === undefined ? {} : { ea: { typeface: eastAsia } }),
		...(complex === undefined ? {} : { cs: { typeface: complex } }),
		...(color === undefined ? {} : { fill: { kind: "solid" as const, color } })
	}
}

// A body with every paragraph's and run's properties resolved along the chain.
export function resolveBody(body: TextBody, context: BodyContext): ResolvedBody {
	const byLevel = new Map<number, ParaProps>()
	const paragraphs: ResolvedParagraph[] = []

	for (const paragraph of body.paragraphs) {
		const level = Math.max(0, Math.min(8, paragraph.pPr.lvl ?? 0))
		let chain = byLevel.get(level)

		if (chain === undefined) {
			chain = chainParaProps(context, body.lstStyle, level)
			byLevel.set(level, chain)
		}

		const pPr = paraPropsOver(chain, paragraph.pPr)
		const defRPr = pPr.defRPr ?? {}
		const runs = paragraph.runs.map(run => (run.kind === "opaque" ? run : { ...run, rPr: runPropsOver(defRPr, run.rPr) }))

		paragraphs.push({ level, pPr, runs, endRPr: runPropsOver(defRPr, paragraph.endRPr), defRPr })
	}

	return { bodyPr: resolveBodyPr([body.bodyPr, ...[...context.bodyPr].reverse()]), paragraphs, fonts: context.fonts }
}

// The context of a shape's body (or of a table cell's text in the frame `shape`), built from the one resolver
// (inherit.ts resolveShape): its inherited list styles weakest first, the p:style fontRef of a non-placeholder shape
// over the master's levels, and `bodyPr` (the renderer's resolved bodyPr; the body's own goes on top).
export function shapeBodyContext(
	deck: Deck,
	owner: SlideNode,
	shape: ShapeNode,
	fonts: TextFonts,
	bodyPr: TextBodyProps,
	cell?: { readonly style: TableTextStyle | undefined }
): BodyContext {
	if (cell !== undefined) {
		// Table text is no placeholder text: the master's otherStyle (notesStyle on notes, §19.3.1.28 and
		// §19.3.1.35) over the presentation defaults, then the table style's a:tcTxStyle.
		const listStyles: ListStyle[] = [deck.defaultTextStyle]
		const master = masterTextStyle(deck, owner, "other")

		if (master !== undefined) listStyles.push(master)
		if (cell.style !== undefined) listStyles.push(cellListStyle(cell.style))

		return { listStyles, bodyPr: [bodyPr], fonts }
	}

	const resolved = resolveShape(deck, owner.ref, shape)
	const listStyles = resolved.listStyles.slice(resolved.ownListStyles).reverse()
	const fontRef = shape.ph === undefined ? shape.style?.font : undefined

	return {
		listStyles,
		bodyPr: [bodyPr],
		fonts,
		...(fontRef === undefined
			? {}
			: {
					fontRef: {
						font: fontRef.idx,
						...(fontRef.color === undefined ? {} : { color: fontRef.color }),
						above: resolved.masterListStyles
					}
				})
	}
}

// a:tcTxStyle as a list style of every level (defPPr would be ignored, inherit.ts listLevel).
function cellListStyle(style: TableTextStyle): ListStyle {
	const level: ParaProps = {
		defRPr: {
			...(style.bold === undefined ? {} : { b: style.bold }),
			...(style.italic === undefined ? {} : { i: style.italic }),
			...(style.color === undefined ? {} : { fill: { kind: "solid", color: { kind: "srgb", rgb: style.color } } }),
			...(style.font === undefined ? {} : { latin: { typeface: style.font === "major" ? "+mj-lt" : "+mn-lt" } })
		}
	}

	return { levels: Array.from({ length: 9 }, () => level) }
}
