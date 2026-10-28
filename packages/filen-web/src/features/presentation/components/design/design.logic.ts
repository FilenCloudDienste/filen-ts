import {
	EMU_PER_CM,
	EMU_PER_INCH,
	MAX_SLIDE_EMU,
	MIN_SLIDE_EMU,
	SLIDE_SIZES,
	slideSizeName,
	type ColorModel,
	type DesignThemeInfo,
	type SchemeSlot,
	type SlideRender,
	type SlideSizeName
} from "@filen/office/core/presentation"
import { SUBSTITUTIONS } from "@filen/office/core/fonts"
import type { FilenTheme } from "@filen/office/core/templates"
import { STANDARD_SWATCHES, type DocxSwatch, type DocxSwatchLabel } from "@/features/office/lib/officeControls"
import type { PreviewKey } from "@/lib/i18n"

// What the Design tab shows of a theme and a size, without the editor: theme previews (colours, heading font,
// decoration), the slide size presets and lengths in the user's unit.

export type ThemeDecoration = FilenTheme["decoration"]

export interface ThemePreview {
	// "RRGGBB".
	readonly background: string
	// A gradient background's end colour.
	readonly backgroundTo?: string
	readonly text: string
	readonly accents: readonly string[]
	// The heading font as CSS (the bundled substitute the editor draws it with first).
	readonly headingFont: string
	readonly decoration: ThemeDecoration
}

export function previewFont(family: string | undefined): string {
	if (family === undefined || family === "") return "sans-serif"

	const substitute = SUBSTITUTIONS.get(family.toLowerCase())
	const quoted = `"${family.replace(/"/gu, "")}"`

	return substitute === undefined ? `${quoted}, sans-serif` : `"${substitute.family}", ${quoted}, ${substitute.generic}`
}

export function galleryPreview(theme: FilenTheme, variant: number): ThemePreview {
	const chosen = theme.variants[variant] ?? theme.variants[0]
	const colors = chosen.colors
	const background = chosen.dark ? colors.dk1 : colors.lt1
	const backgroundTo = chosen.dark ? colors.dk2 : colors.lt2

	return {
		background,
		...(chosen.background === "gradient" ? { backgroundTo } : {}),
		text: chosen.dark ? colors.lt1 : colors.dk1,
		accents: [colors.accent1, colors.accent2, colors.accent3, colors.accent4, colors.accent5, colors.accent6],
		headingFont: previewFont(theme.major),
		decoration: theme.decoration
	}
}

export function deckThemePreview(info: DesignThemeInfo, gallery: (id: string) => FilenTheme | undefined): ThemePreview {
	const ours = info.gallery === undefined ? undefined : gallery(info.gallery.id)

	if (ours !== undefined && info.gallery !== undefined) return galleryPreview(ours, info.gallery.variant)

	return {
		background: info.colors?.background ?? "FFFFFF",
		text: info.colors?.text ?? "000000",
		accents: info.colors?.accents ?? [],
		headingFont: previewFont(info.fonts?.major),
		decoration: "none"
	}
}

export const THEME_NAME_KEYS: Readonly<Record<string, PreviewKey>> = {
	filen: "previewPptxDesignTheme_filen",
	slate: "previewPptxDesignTheme_slate",
	harbor: "previewPptxDesignTheme_harbor",
	ember: "previewPptxDesignTheme_ember",
	meadow: "previewPptxDesignTheme_meadow",
	ledger: "previewPptxDesignTheme_ledger",
	studio: "previewPptxDesignTheme_studio",
	typewriter: "previewPptxDesignTheme_typewriter"
}

export const SIZE_LABELS: Readonly<Record<SlideSizeName, PreviewKey>> = {
	widescreen: "previewPptxDesignSizeWidescreen",
	standard: "previewPptxDesignSizeStandard",
	widescreen16x10: "previewPptxDesignSizeWidescreen16x10",
	a4: "previewPptxDesignSizeA4",
	letter: "previewPptxDesignSizeLetter"
}

export const SIZE_NAMES = Object.keys(SLIDE_SIZES) as SlideSizeName[]

export type LengthUnit = "cm" | "in"

const EMU_PER_UNIT: Readonly<Record<LengthUnit, number>> = { cm: EMU_PER_CM, in: EMU_PER_INCH }
// Every length a preset has.
const PRESET_LENGTHS = [...new Set(Object.values(SLIDE_SIZES).flatMap(size => [size.cx, size.cy]))]

// EMU as the unit shows it (two decimals) and back; NaN for text that is no number.
export function emuToUnit(emu: number, unit: LengthUnit): string {
	return String(Math.round((emu / EMU_PER_UNIT[unit]) * 100) / 100)
}

export function unitToEmu(text: string, unit: LengthUnit): number {
	const value = Number(text.trim().replace(",", "."))

	return text.trim() === "" || !Number.isFinite(value) ? Number.NaN : Math.round(value * EMU_PER_UNIT[unit])
}

// A typed length: within half the last shown digit of a preset's length it is that length exactly (what the dialog
// showed for the preset reads back as the preset).
export function typedLength(text: string, unit: LengthUnit): number {
	const emu = unitToEmu(text, unit)
	const half = EMU_PER_UNIT[unit] * 0.005

	return PRESET_LENGTHS.find(length => Math.abs(length - emu) <= half) ?? emu
}

export function validSlideLength(emu: number): boolean {
	return Number.isFinite(emu) && emu >= MIN_SLIDE_EMU && emu <= MAX_SLIDE_EMU
}

export function slideLengthBounds(unit: LengthUnit): { readonly min: string; readonly max: string } {
	return { min: `${emuToUnit(MIN_SLIDE_EMU, unit)} ${unit}`, max: `${emuToUnit(MAX_SLIDE_EMU, unit)} ${unit}` }
}

// The scale PowerPoint picks by default: Ensure fit, which shrinks content onto a smaller slide and centres it on a
// larger one; none for an unchanged size.
export function defaultScale(
	from: { readonly cx: number; readonly cy: number },
	to: { readonly cx: number; readonly cy: number }
): "ensureFit" | "none" {
	return to.cx === from.cx && to.cy === from.cy ? "none" : "ensureFit"
}

// A colour swatch of Format Background: the picker's swatch with the colour it writes.
export interface PresentationSwatch extends DocxSwatch {
	readonly model: ColorModel
}

// The theme's colours as DesignThemeInfo.colors lists them (the master's background and text, accent 1-6).
const THEME_SLOTS: readonly { readonly slot: SchemeSlot; readonly name: PreviewKey }[] = [
	{ slot: "bg1", name: "previewOfficeColorBackground1" },
	{ slot: "tx1", name: "previewOfficeColorText1" },
	{ slot: "accent1", name: "previewOfficeColorAccent1" },
	{ slot: "accent2", name: "previewOfficeColorAccent2" },
	{ slot: "accent3", name: "previewOfficeColorAccent3" },
	{ slot: "accent4", name: "previewOfficeColorAccent4" },
	{ slot: "accent5", name: "previewOfficeColorAccent5" },
	{ slot: "accent6", name: "previewOfficeColorAccent6" }
]

// A colour Format Background holds: a swatch (named), or one from the system picker (shown by its hex).
export interface PickedColor {
	readonly key: string
	readonly rgb: string
	readonly model: ColorModel
	readonly label?: DocxSwatchLabel
}

export function customColor(rgb: string): PickedColor {
	const value = rgb.toUpperCase()

	return { key: value, rgb: value, model: { kind: "srgb", rgb: value } }
}

export const STANDARD_PRESENTATION_SWATCHES: readonly PresentationSwatch[] = STANDARD_SWATCHES.map(swatch => ({
	...swatch,
	model: { kind: "srgb", rgb: swatch.rgb }
}))

// The theme's swatches, each writing its scheme colour (a:schemeClr, so a later theme recolours it), as PowerPoint
// does; sRGB in ODP, whose fills take no theme colours.
export function themeSwatches(colors: DesignThemeInfo["colors"], odp: boolean): readonly PresentationSwatch[] {
	if (colors === undefined) return []

	const rgbs = [colors.background, colors.text, ...colors.accents]

	return THEME_SLOTS.flatMap(({ slot, name }, index) => {
		const rgb = rgbs[index]?.toUpperCase()

		return rgb === undefined
			? []
			: [
					{
						key: `theme:${slot}`,
						rgb,
						label: { name },
						color: { kind: "rgb", value: rgb },
						model: odp ? { kind: "srgb", rgb } : { kind: "scheme", slot }
					}
				]
	})
}

// Whether a slide hides its layout's and master's graphics (p:cSld/@showMasterSp="0").
export function hidesGraphics(render: SlideRender | undefined): boolean {
	return render?.hidesMasterShapes === true
}

export { slideSizeName }
