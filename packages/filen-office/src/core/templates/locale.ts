// What a blank document takes from the user's locale: its language tag (BCP 47, as w:lang carries it) and
// its paper. US Letter is the paper of the regions CLDR supplementalData paperSize lists as US-Letter; every
// other region uses ISO 216 A4.

const LETTER_REGIONS: ReadonlySet<string> = new Set("BZ CA CL CO CR GT MX NI PA PE PH PR SV US VE".split(" "))
const FALLBACK_TAG = "en-US"

export type TemplatePaper = "letter" | "a4"

export interface TemplateLocale {
	// language[-Script][-REGION]: the script only where the locale names one, the region where it is known.
	readonly tag: string
	readonly paper: TemplatePaper
}

function canonical(tag: string): Intl.Locale | undefined {
	try {
		return new Intl.Locale(tag)
	} catch {
		return undefined
	}
}

// The likely region of a tag without one ("de" -> DE), where the platform knows it.
function likelyRegion(locale: Intl.Locale): string | undefined {
	try {
		return locale.maximize().region
	} catch {
		return undefined
	}
}

// The scripts Word proofs through w:eastAsia and through w:bidi (ECMA-376 Part 1 §17.3.2.20), as the spelling
// scan's scriptSlot splits them by code point; every other script uses the Latin slot.
const EAST_ASIAN_SCRIPTS: ReadonlySet<string> = new Set(["Hans", "Hant", "Hani", "Jpan", "Hira", "Kana", "Kore", "Hang", "Bopo"])
const COMPLEX_SCRIPTS: ReadonlySet<string> = new Set([
	"Hebr",
	"Arab",
	"Syrc",
	"Thaa",
	"Nkoo",
	"Samr",
	"Mand",
	"Deva",
	"Beng",
	"Guru",
	"Gujr",
	"Orya",
	"Taml",
	"Telu",
	"Knda",
	"Mlym",
	"Sinh",
	"Thai",
	"Laoo",
	"Tibt",
	"Khmr"
])

// A language tag in the w:lang / ODF language slots: an East Asian or complex-script locale goes in its own slot
// and the Latin slot keeps en-US, as Word's localized Normal templates do (ja-JP: w:val="en-US" w:eastAsia="ja-JP").
export interface LanguageSlots {
	readonly latin: string
	readonly eastAsia: string | undefined
	readonly complex: string | undefined
}

export function languageSlots(tag: string): LanguageSlots {
	let script: string | undefined

	try {
		script = new Intl.Locale(tag).maximize().script
	} catch {
		script = undefined
	}

	if (script !== undefined && EAST_ASIAN_SCRIPTS.has(script)) return { latin: FALLBACK_TAG, eastAsia: tag, complex: undefined }
	if (script !== undefined && COMPLEX_SCRIPTS.has(script)) return { latin: FALLBACK_TAG, eastAsia: undefined, complex: tag }

	return { latin: tag, eastAsia: undefined, complex: undefined }
}

// A tag's language, script and region subtags as written (no likely subtags added), for the ODF attributes
// fo:language, fo:script and fo:country.
export interface TagParts {
	readonly language: string
	readonly script: string | undefined
	readonly region: string | undefined
}

export function tagParts(tag: string): TagParts {
	const locale = canonical(tag)

	return locale === undefined
		? { language: "en", script: undefined, region: undefined }
		: { language: locale.language, script: locale.script, region: locale.region }
}

export function templateLocale(tag: string): TemplateLocale {
	const locale = canonical(tag) ?? canonical(FALLBACK_TAG)
	const language = locale?.language ?? "en"
	// The script only from the tag itself: maximize() fills one in for every language.
	const script = locale?.script
	const region = locale === undefined ? "US" : (locale.region ?? likelyRegion(locale))
	const shown = [language, script, region].filter(part => part !== undefined).join("-")

	return {
		tag: /^[A-Za-z0-9-]+$/.test(shown) ? shown : FALLBACK_TAG,
		paper: region !== undefined && LETTER_REGIONS.has(region) ? "letter" : "a4"
	}
}
