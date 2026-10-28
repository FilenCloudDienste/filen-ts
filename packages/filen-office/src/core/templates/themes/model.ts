// Filen's own presentation themes, as data: a theme is a pair of fonts, a master decoration and four colour variants.
// Written by us: no Microsoft theme or template file is copied. Fonts are the Office family names of metric-compatible
// pairs (Calibri, Calibri Light, Cambria, Arial, Times New Roman, Courier New, Georgia, Segoe UI), which decks keep
// portable and our renderer draws with the bundled OFL substitutes (core/fonts/substitutes.ts).

// The twelve theme colour slots of ECMA-376 Part 1 §20.1.6.2 (a:clrScheme), in schema order.
export const THEME_COLOR_SLOTS = [
	"dk1",
	"lt1",
	"dk2",
	"lt2",
	"accent1",
	"accent2",
	"accent3",
	"accent4",
	"accent5",
	"accent6",
	"hlink",
	"folHlink"
] as const

export type ThemeColorSlot = (typeof THEME_COLOR_SLOTS)[number]

// Six hex digits per slot.
export type ThemeColors = Readonly<Record<ThemeColorSlot, string>>

export type ThemeFontName = "Calibri" | "Calibri Light" | "Cambria" | "Arial" | "Times New Roman" | "Courier New" | "Georgia" | "Segoe UI"

// Shapes every slide shows from the master (drawn in accent1), placed in fractions of the slide.
export type ThemeDecoration = "none" | "leftBar" | "bottomBand" | "topRule" | "sideBand" | "frame" | "titleRule" | "corner"

export interface ThemeVariant {
	readonly colors: ThemeColors
	// Dark variants map the background to dk1 and text to lt1 (p:clrMap bg1="dk1" tx1="lt1", §19.3.1.6).
	readonly dark: boolean
	// The master background: the background colour, or a linear gradient from it to bg2 (top to bottom).
	readonly background: "solid" | "gradient"
}

export interface FilenTheme {
	// Stable: decks name a gallery theme by it (a:theme@name is "Filen <id>").
	readonly id: string
	readonly major: ThemeFontName
	readonly minor: ThemeFontName
	readonly decoration: ThemeDecoration
	readonly variants: readonly [ThemeVariant, ThemeVariant, ThemeVariant, ThemeVariant]
}

// The theme name written into a:theme@name and the master's cSld@name, from which a deck's gallery theme is known
// again on open.
export function themeName(theme: FilenTheme, variant: number): string {
	return `Filen ${theme.id} ${String(variant + 1)}`
}

// The gallery theme and variant a written theme name names, if it is one of ours.
export function parseThemeName(name: string | undefined): { readonly id: string; readonly variant: number } | undefined {
	const match = name === undefined ? null : /^Filen ([a-z]+) ([1-4])$/u.exec(name)

	return match === null ? undefined : { id: match[1] ?? "", variant: Number(match[2]) - 1 }
}

function scheme(
	dk1: string,
	lt1: string,
	dk2: string,
	lt2: string,
	accents: readonly string[],
	hlink: string,
	folHlink: string
): ThemeColors {
	return {
		dk1,
		lt1,
		dk2,
		lt2,
		accent1: accents[0] ?? "000000",
		accent2: accents[1] ?? "000000",
		accent3: accents[2] ?? "000000",
		accent4: accents[3] ?? "000000",
		accent5: accents[4] ?? "000000",
		accent6: accents[5] ?? "000000",
		hlink,
		folHlink
	}
}

export function variant(
	colors: ThemeColors,
	options: { readonly dark?: boolean; readonly background?: "solid" | "gradient" } = {}
): ThemeVariant {
	return { colors, dark: options.dark ?? false, background: options.background ?? "solid" }
}

export { scheme as themeColors }

// The template's theme: plain white, Calibri Light headings over Calibri body text, no decoration.
export const FILEN_THEME: FilenTheme = {
	id: "filen",
	major: "Calibri Light",
	minor: "Calibri",
	decoration: "none",
	variants: [
		variant(
			scheme("000000", "FFFFFF", "1F2937", "F3F4F6", ["2563EB", "F97316", "6B7280", "EAB308", "0EA5E9", "16A34A"], "1D4ED8", "7C3AED")
		),
		variant(
			scheme("000000", "FFFFFF", "134E4A", "F0FDFA", ["0D9488", "F59E0B", "64748B", "84CC16", "06B6D4", "E11D48"], "0F766E", "7C3AED")
		),
		variant(
			scheme("000000", "FFFFFF", "3B0764", "FAF5FF", ["7C3AED", "DB2777", "6B7280", "F59E0B", "2563EB", "10B981"], "6D28D9", "9333EA")
		),
		variant(
			scheme(
				"111827",
				"F9FAFB",
				"1F2937",
				"374151",
				["60A5FA", "FB923C", "9CA3AF", "FACC15", "38BDF8", "4ADE80"],
				"93C5FD",
				"C4B5FD"
			),
			{
				dark: true
			}
		)
	]
}
