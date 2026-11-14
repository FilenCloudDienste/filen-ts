import { NO_HINTS, SUBSTITUTIONS, fallbackFor, type BundledFamily, type FontHints } from "../fonts/substitutes"

// The bundled family that stands in for a PDF font when text is edited. A PDF's own fonts are almost always subsets
// (only the glyphs the page used), so new text is set in a bundled family: the document's substitute table first
// (by family name, as PostScript names spell it), then serif / sans / monospace from the font's flags and name.
// `substitute` is false only when the bundled family is the original or draws with the original's advance widths,
// so the result looks and spaces as before; otherwise the editor says the text is shown in another font.

// What MuPDF reports for a font (Font.getName/isBold/isItalic/isSerif/isMono).
export interface PdfFontTraits {
	readonly name: string
	readonly bold: boolean
	readonly italic: boolean
	readonly serif: boolean
	readonly mono: boolean
}

export interface PdfFontMatch {
	readonly family: BundledFamily
	// The family's name as people read it ("Arimo").
	readonly label: string
	readonly bold: boolean
	readonly italic: boolean
	readonly substitute: boolean
	// The original family without subset tag and style ("Times New Roman"); empty when the name says nothing.
	readonly original: string
}

export const BUNDLED_FAMILY_LABELS: Readonly<Record<BundledFamily, string>> = {
	carlito: "Carlito",
	caladea: "Caladea",
	arimo: "Arimo",
	tinos: "Tinos",
	cousine: "Cousine",
	gelasio: "Gelasio",
	selawik: "Selawik"
}

// Originals whose bundled substitute has the same advance widths (substitutes.ts), and the bundled families
// themselves. Keys are compact (lower case, no spaces).
const SAME_METRICS = new Set([
	"arial",
	"helvetica",
	"timesnewroman",
	"times",
	"couriernew",
	"courier",
	"georgia",
	"liberationsans",
	"liberationserif",
	"liberationmono",
	"arimo",
	"tinos",
	"cousine",
	"gelasio",
	"carlito",
	"caladea",
	"selawik"
])

// PostScript names of the standard 14 fonts and common variants not spelled as their family.
const ALIASES: ReadonlyMap<string, string> = new Map([
	["times", "times new roman"],
	["courier", "courier new"],
	["arialmt", "arial"],
	["timesnewromanps", "times new roman"],
	["couriernewps", "courier new"]
])

const COMPACT_SUBSTITUTIONS: ReadonlyMap<string, string> = new Map([...SUBSTITUTIONS.keys()].map(key => [compact(key), key]))

const SUBSET_TAG = /^[A-Z]{6}\+/u
const BOLD_WORD = /bold|black|heavy|demi|semibold|extrabold|ultrabold/iu
const ITALIC_WORD = /italic|oblique|kursiv|inclined/iu
const SERIF_WORD =
	/serif|times|roman|garamond|georgia|cambria|minion|palatino|book ?antiqua|baskerville|bodoni|caslon|didot|century|mincho|song|ming/iu
const MONO_WORD = /\b(?:mono(?:spaced?)?|courier|consolas|menlo|inconsolata)\b/iu
const SANS_WORD = /sans|gothic|grotesk|helvetica|arial|verdana|tahoma|calibri|segoe|roboto|futura/iu
// Style words a PostScript or family name ends with.
const STYLE_SUFFIX =
	/(?:[\s,_-]*(?:regular|normal|medium|bold|black|heavy|demi(?:bold)?|semibold|extrabold|ultrabold|light|thin|italic|oblique|kursiv|inclined))+$/iu
const VENDOR_SUFFIX = /(?:PSMT|PS|MT|Std|Pro|LT)$/u

function compact(name: string): string {
	return name.toLowerCase().replace(/[\s_-]+/gu, "")
}

// "ABCDEF+TimesNewRomanPS-BoldItalicMT" -> "Times New Roman"; "Calibri,Bold" -> "Calibri".
export function pdfFontFamily(name: string): string {
	let base = name.replace(SUBSET_TAG, "")
	const cut = base.search(/[,-]/u)

	if (cut > 0) base = base.slice(0, cut)

	base = base.replace(VENDOR_SUFFIX, "").replace(STYLE_SUFFIX, "")

	// CamelCase PostScript names: split before an upper-case letter that follows a lower-case one.
	return base
		.replace(/([a-z])([A-Z])/gu, "$1 $2")
		.replace(/[_]+/gu, " ")
		.trim()
}

export function matchPdfFont(traits: PdfFontTraits): PdfFontMatch {
	const original = pdfFontFamily(traits.name)
	const key = compact(original)
	const alias = ALIASES.get(key)
	const substitutionKey = alias ?? COMPACT_SUBSTITUTIONS.get(key)
	const substitution = substitutionKey === undefined ? undefined : SUBSTITUTIONS.get(substitutionKey)
	const unprefixed = traits.name.replace(SUBSET_TAG, "")
	const bold = traits.bold || BOLD_WORD.test(unprefixed) || (substitution?.weight ?? 400) >= 600
	const italic = traits.italic || ITALIC_WORD.test(unprefixed)
	let family: BundledFamily

	if (substitution !== undefined) {
		family = substitution.family
	} else {
		const serif = traits.serif || (SERIF_WORD.test(original) && !SANS_WORD.test(original))
		const mono = traits.mono || MONO_WORD.test(original)
		const hints: FontHints = {
			...NO_HINTS,
			pitch: mono ? "fixed" : undefined,
			fontClass: mono ? undefined : serif ? "roman" : "swiss"
		}

		family = fallbackFor(original, hints, true).family ?? (serif ? "tinos" : "arimo")
	}

	return {
		family,
		label: BUNDLED_FAMILY_LABELS[family],
		bold,
		italic,
		substitute: !SAME_METRICS.has(alias === undefined ? key : compact(alias)),
		original
	}
}
