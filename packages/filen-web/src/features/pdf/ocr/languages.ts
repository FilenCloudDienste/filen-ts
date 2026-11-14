import type { SupportedLanguage } from "@filen/shared/languages"

// The text recognition languages the app serves: every UI language's, plus the scripts most scanned documents
// outside them are written in. Each is a Tesseract model name (tessdata_fast); `tag` is its BCP 47 tag, for the
// language's display name. vite/ocr-tessdata.json pins one model file per entry (scripts/ocr-tessdata.ts writes it).
export const OCR_LANGUAGE_TAGS = {
	eng: "en",
	deu: "de",
	spa: "es",
	fra: "fr",
	ita: "it",
	por: "pt",
	rus: "ru",
	jpn: "ja",
	chi_sim: "zh-Hans",
	chi_tra: "zh-Hant",
	ben: "bn",
	ces: "cs",
	dan: "da",
	fin: "fi",
	hin: "hi",
	hun: "hu",
	ind: "id",
	kor: "ko",
	nld: "nl",
	nor: "no",
	pol: "pl",
	ron: "ro",
	swe: "sv",
	tha: "th",
	tur: "tr",
	ukr: "uk",
	vie: "vi",
	ara: "ar",
	heb: "he"
} as const

export type OcrLanguage = keyof typeof OCR_LANGUAGE_TAGS

export const OCR_LANGUAGES = Object.keys(OCR_LANGUAGE_TAGS) as readonly OcrLanguage[]

// The model for each UI language.
export const OCR_LANGUAGE_OF_UI: Readonly<Record<SupportedLanguage, OcrLanguage>> = {
	en: "eng",
	de: "deu",
	es: "spa",
	fr: "fra",
	it: "ita",
	"pt-BR": "por",
	"pt-PT": "por",
	ru: "rus",
	ja: "jpn",
	zh: "chi_sim",
	"zh-TW": "chi_tra",
	bn: "ben",
	cs: "ces",
	da: "dan",
	fi: "fin",
	hi: "hin",
	hu: "hun",
	id: "ind",
	ko: "kor",
	nl: "nld",
	no: "nor",
	pl: "pol",
	ro: "ron",
	sv: "swe",
	th: "tha",
	tr: "tur",
	uk: "ukr",
	vi: "vie"
}

export function isOcrLanguage(value: string): value is OcrLanguage {
	return Object.hasOwn(OCR_LANGUAGE_TAGS, value)
}

// Recognition languages with nothing picked yet: the UI language's, then English.
export function defaultOcrLanguages(ui: SupportedLanguage): OcrLanguage[] {
	const own = OCR_LANGUAGE_OF_UI[ui]

	return own === "eng" ? ["eng"] : [own, "eng"]
}
