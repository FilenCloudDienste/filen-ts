import type { Background, FillProps, SlideRef } from "../../model"
import type { DesignOp, InsertedImage } from "../ops"

// The Design tab's commands, as the ops they send. Pure and page-safe: they read the deck as the page holds it
// (OpenInfo, its design info), so the page builds an op without a round trip.

// A master of the deck as the Design tab shows it: one of "the file's own themes".
export interface DesignThemeInfo {
	readonly master: SlideRef
	// What a ThemeChoice of kind "deck" names it by (apply/design.ts deckThemeKey).
	readonly key: string
	readonly name?: string
	// Our gallery theme and variant, when the master is one of ours.
	readonly gallery?: { readonly id: string; readonly variant: number }
	// Six hex digits each: the background and text as the master maps them, then accent1–6.
	readonly colors?: { readonly background: string; readonly text: string; readonly accents: readonly string[] }
	readonly fonts?: { readonly major: string; readonly minor: string }
}

export interface PresentationDesignInfo {
	readonly themes: readonly DesignThemeInfo[]
}

// Slide sizes the Slide Size menu offers (EMU; ST_SlideSizeType where one names it, §19.7.17).
export const SLIDE_SIZES = {
	widescreen: { cx: 12_192_000, cy: 6_858_000 },
	standard: { cx: 9_144_000, cy: 6_858_000, type: "screen4x3" },
	widescreen16x10: { cx: 9_144_000, cy: 5_715_000, type: "screen16x10" },
	a4: { cx: 9_906_000, cy: 6_858_000, type: "A4" },
	letter: { cx: 9_144_000, cy: 6_858_000, type: "letter" }
} as const

export type SlideSizeName = keyof typeof SLIDE_SIZES

export const EMU_PER_CM = 360_000
export const EMU_PER_INCH = 914_400
// ST_SlideSizeCoordinate (§19.7.16).
export const MIN_SLIDE_EMU = 914_400
export const MAX_SLIDE_EMU = 51_206_400

// The named size `cx` × `cy` is, if any (ignoring the type a file may not write).
export function slideSizeName(size: { readonly cx: number; readonly cy: number; readonly type?: string }): SlideSizeName | undefined {
	for (const [name, entry] of Object.entries(SLIDE_SIZES) as [SlideSizeName, (typeof SLIDE_SIZES)[SlideSizeName]][]) {
		if (entry.cx !== size.cx || entry.cy !== size.cy) continue
		if ("type" in entry ? entry.type === size.type || (name === "standard" && size.type === undefined) : size.type === undefined)
			return name
	}

	return undefined
}

// The size change as PowerPoint's dialog makes it: scaling content only when the aspect or size changes.
export function slideSizeOp(
	size: { readonly cx: number; readonly cy: number; readonly type?: string },
	scale: "maximize" | "ensureFit" | "none"
): DesignOp | undefined {
	const cx = Math.round(size.cx)
	const cy = Math.round(size.cy)

	if (![cx, cy].every(value => value >= MIN_SLIDE_EMU && value <= MAX_SLIDE_EMU)) return undefined

	return { family: "design", kind: "setSize", cx, cy, ...(size.type === undefined ? {} : { type: size.type }), scale }
}

export function galleryThemeOp(id: string, variant: number, slides: readonly SlideRef[]): DesignOp {
	return { family: "design", kind: "setTheme", theme: { kind: "gallery", id, variant }, slides: [...slides] }
}

export function deckThemeOp(theme: DesignThemeInfo, slides: readonly SlideRef[]): DesignOp {
	return { family: "design", kind: "setTheme", theme: { kind: "deck", part: theme.key }, slides: [...slides] }
}

export function variantOp(master: SlideRef, variant: number): DesignOp {
	return { family: "design", kind: "setVariant", master, variant }
}

// The master a slide is on, from its layout (SlideRender.layout) and the deck's layouts.
export function masterOfLayout(
	layouts: readonly { readonly ref: SlideRef; readonly master: SlideRef }[],
	layout: SlideRef | undefined
): SlideRef | undefined {
	return layout === undefined ? undefined : layouts.find(each => each.ref === layout)?.master
}

export type BackgroundFillKind = "solid" | "gradient" | "picture" | "pattern"

// A slide background (Format Background): a fill over the slides, or none (Reset: back to the layout's).
export function backgroundOp(
	slides: readonly SlideRef[],
	fill: FillProps | undefined,
	options: { readonly hideGraphics?: boolean; readonly image?: InsertedImage } = {}
): DesignOp {
	const background: Background | undefined = fill === undefined ? undefined : { kind: "fill", fill }

	return {
		family: "design",
		kind: "setBackground",
		slides: [...slides],
		background,
		...(options.hideGraphics === undefined ? {} : { hideGraphics: options.hideGraphics }),
		...(options.image === undefined ? {} : { image: options.image })
	} as DesignOp
}

// The presets the Pattern fill offers (ST_PresetPatternVal, §20.1.10.51): a readable subset.
export const BACKGROUND_PATTERNS = [
	"pct10",
	"pct25",
	"pct50",
	"ltHorz",
	"ltVert",
	"ltDnDiag",
	"ltUpDiag",
	"smGrid",
	"dotGrid",
	"horzBrick",
	"weave",
	"plaid"
] as const
